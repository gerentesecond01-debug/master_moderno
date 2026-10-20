'use strict';
// Recuperação individual por URL; o Master detecta falha pelo registro periódico
// que o Agent já envia. Nenhum GET é enviado a Agents com heartbeat recente.
const db = require('./database');
const primBridge=require('./primBridge');
const MAX_ATTEMPTS = 3;
const GAP_MS = 60000;
const TIMEOUT_MS = 55000;
const STALE_MS = 135000;
const active = new Set();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function safeUrl(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw Error('URL HTTPS inválida');
  if (!/^[a-z0-9-]+\.onrender\.com$/i.test(url.hostname)) throw Error('Somente URLs de Agents no Render são permitidas');
  return url.origin + '/health';
}
async function ping(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(safeUrl(url), {method:'GET',signal:controller.signal,redirect:'error',cache:'no-store'});
    return response.ok;
  } finally { clearTimeout(timer); }
}
async function setState(agent, state, attempt, error='') {
  await db.setAgentCheck(agent.id, state, {
    watchdogAttempts: attempt,
    watchdogError: error,
    watchdogExhausted: state === 'offline' || state === 'http_online',
    watchdogUpdatedAt: new Date().toISOString()
  });
}
async function recover(agent, manual=false) {
  const id = Number(agent.id);
  if (!agent.approved || !agent.agentUrl || active.has(id)) return;
  if (!manual && !(await db.list()).some(b=>b.desiredOnline && Number(b.agentId)===id)) return;
  const previous = agent.status || {};
  if (!manual && previous.watchdogExhausted) return;
  active.add(id);
  try {
    const url = safeUrl(agent.agentUrl);
    for (let attempt=1;attempt<=MAX_ATTEMPTS;attempt++) {
      // Um registro recente do próprio Agent cancela o ciclo.
      const current = await db.getAgent(id);
      if (!current || !current.approved || current.agent_url !== agent.agentUrl) return;
      if (!manual && !(await db.list()).some(b=>b.desiredOnline && Number(b.agentId)===id)) return;
      if (Date.now()-new Date(current.last_seen).getTime() < STALE_MS) {
        await setState(agent,'online',0);return;
      }
      await setState(agent,'waking',attempt);
      console.log(`[Watchdog] ${agent.name}: despertar ${attempt}/${MAX_ATTEMPTS}`);
      let ok=false, error='';
      try { const accepted=await primBridge.wakeAgent(id,agent.agentUrl); console.log(`[Watchdog] ${agent.name}: prim ${accepted?'aceitou':'não confirmou'} o comando; verificando /health`);ok=await ping(url); } catch(e) { error=e.message; }
      if (ok) {
        await setState(agent,'http_online',attempt,'HTTP respondeu; aguardando registro do Agent');
        console.log(`[Watchdog] ${agent.name} respondeu ao HTTP; aguardando heartbeat`);
        return;
      }
      if (attempt < MAX_ATTEMPTS) {
        await setState(agent,'waking',attempt,error);
        await wait(GAP_MS);
      } else {
        await setState(agent,'offline',attempt,error || 'Sem resposta HTTP após 3 tentativas');
        console.warn(`[Watchdog] ${agent.name}: recuperação esgotada`);
      }
    }
  } catch(e) {
    console.warn(`[Watchdog] ${agent.name}: ${e.message}`);
    await setState(agent,'offline',0,e.message).catch(()=>{});
  } finally { active.delete(id); }
}
async function observe() {
  // Só recuperar automaticamente Agents de avatares que DEVEM estar online.
  // Avatares desligados voluntariamente ficam livres para o Render suspender.
  const desiredIds=new Set((await db.list()).filter(b=>b.desiredOnline && b.agentId).map(b=>Number(b.agentId)));
  const agents=(await db.listAgents()).filter(a=>a.approved && a.agentUrl && desiredIds.has(Number(a.id)));
  for (const a of agents) {
    const age=Date.now()-new Date(a.lastSeen).getTime();
    if (!Number.isFinite(age)) continue;
    if (age < STALE_MS) {
      // A confirmação de vida libera novas tentativas numa futura queda.
      if (a.checkStatus !== 'online' || a.status?.watchdogExhausted)
        await setState(a,'online',0);
    } else if (!a.status?.watchdogExhausted && !active.has(a.id)) {
      recover(a).catch(e=>console.error('Watchdog:',e.message));
    }
  }
}
module.exports={observe,recover,active};
