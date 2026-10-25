require('dotenv').config();
const express=require('express');const session=require('express-session');const PgSession=require('connect-pg-simple')(session);const {Pool}=require('pg');const path=require('path');const db=require('./database');const agent=require('./agentClient');const watchdog=require('./agentWatchdog');
const {encryptBackup,decryptBackup}=require('./backupCrypto');
const primBridge=require('./primBridge');
const app=express();const PORT=Number(process.env.PORT||10000);
// Render termina o HTTPS no proxy. Sem trust proxy, cookies 'secure' podem não ser gravados.
app.set('trust proxy',1);
app.use(express.json({limit:'10mb'}));app.use(express.urlencoded({extended:true}));

function sessionDatabaseUrl(raw){
  if(!raw)return '';
  try{
    const u=new URL(raw);
    u.searchParams.delete('sslmode');
    u.searchParams.delete('uselibpqcompat');
    return u.toString();
  }catch{
    return raw;
  }
}
const SESSION_DATABASE_URL=sessionDatabaseUrl(process.env.DATABASE_URL);
const sessionIsLocal=/localhost|127\.0\.0\.1/.test(SESSION_DATABASE_URL);
const sessionPool=new Pool({
  connectionString:SESSION_DATABASE_URL,
  ssl:sessionIsLocal?false:{rejectUnauthorized:false},
  max:2,
  idleTimeoutMillis:30000,
  connectionTimeoutMillis:10000
});

app.use(session({
  store:new PgSession({
    pool:sessionPool,
    createTableIfMissing:true,
    tableName:'user_sessions'
  }),
  secret:process.env.SESSION_SECRET||'troque-essa-chave',
  resave:false,
  saveUninitialized:false,
  proxy:true,
  cookie:{
    httpOnly:true,
    sameSite:'lax',
    secure:process.env.NODE_ENV==='production',
    maxAge:1000*60*60*24*7
  }
}));
// Despertar agora é controlado pelo Watchdog, apenas para Agents sem heartbeat.
app.use(express.static(path.join(__dirname,'public')));
function auth(req,res,next){if(req.session.ok)return next();res.status(401).json({ok:false,error:'Não autenticado'});}function fail(res,e,code=500){res.status(code).json({ok:false,error:e.message||String(e)})}
app.get('/',(_q,r)=>r.sendFile(path.join(__dirname,'public/index.html')));
app.post('/api/login',(req,res)=>{if(String(req.body.password||'')===String(process.env.ADMIN_PASSWORD||'admin123')){req.session.ok=true;return res.json({ok:true})}res.status(403).json({ok:false,error:'Senha incorreta'})});
app.post('/api/logout',(q,r)=>q.session.destroy(()=>r.json({ok:true})));
app.get('/api/me',auth,(q,r)=>r.json({ok:true}));
app.get('/api/bots',auth,async(q,r)=>{try{const bots=await db.list();const servers=await db.listAgents();const byId=new Map(servers.map(a=>[Number(a.id),a]));for(const b of bots){const srv=byId.get(Number(b.agentId));b.server=srv?{id:srv.id,name:srv.name,agentUrl:srv.agentUrl,checkStatus:srv.checkStatus,approved:srv.approved}:null;}for(const b of bots){
 if(!b.desiredOnline){b.live={reachable:false,online:false,running:false,phase:'stopped',lastReason:'Desligado pelo usuário'};continue;}
 const seen=Date.parse(b.runtime?.lastAgentSeen||'');
 const fresh=Number.isFinite(seen)&&Date.now()-seen<135000;
 b.live={reachable:fresh,online:fresh&&!!b.runtime?.lastOnline,running:fresh&&!!b.runtime?.lastOnline,
   phase:fresh?(b.runtime?.lastPhase||'unknown'):'unreachable',lastReason:fresh?(b.runtime?.lastReason||''):'Sem heartbeat recente',
   lastChangeAt:b.runtime?.lastAgentSeen||null,region:fresh&&b.runtime?.lastOnline?(b.runtime?.lastRegion||''):''};
 }r.json({ok:true,bots})}catch(e){fail(r,e)}});
app.post('/api/bots',auth,async(req,res)=>{try{const b=await db.create(req.body);await db.desired(b.id,true);res.json({ok:true,bot:b,message:'Bot cadastrado; conexão automática na fila.'});setImmediate(()=>autoConnect(b.id).catch(console.error))}catch(e){fail(res,e,400)}});
app.get('/api/bots/:id',auth,async(req,res)=>{try{const b=await db.get(req.params.id);if(!b)return fail(res,new Error('Bot não encontrado'),404);res.json({ok:true,bot:b})}catch(e){fail(res,e)}});
app.put('/api/bots/:id',auth,async(req,res)=>{try{res.json({ok:true,bot:await db.update(req.params.id,req.body)})}catch(e){fail(res,e,400)}});
app.delete('/api/bots/:id',auth,async(req,res)=>{try{const b=await db.get(req.params.id,true);if(b){try{await agent.call(b,'/stop','POST')}catch{}}await db.del(req.params.id);res.json({ok:true})}catch(e){fail(res,e)}});

async function probeUrl(url,timeoutMs=9000){
  if(!url)return false;
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{const r=await fetch(String(url).replace(/\/$/,'')+'/health',{signal:controller.signal,cache:'no-store'});return r.ok}catch{return false}finally{clearTimeout(timer)}
}
let refreshInFlight=null;
async function refreshAgents(){
  if(refreshInFlight)return refreshInFlight;
  refreshInFlight=(async()=>{
    await watchdog.observe();
    return db.listAgents();
  })();
  try{return await refreshInFlight}finally{refreshInFlight=null}
}
// Acionamento sob demanda: bot desligado não desperta o Agent por monitoramento.
// O Agent permanece reservado ao avatar, inclusive durante o repouso do Render.
const startInFlight=new Set();
const autoConnectCooldown=new Map();
const AUTO_CONNECT_COOLDOWN_MS=15*60*1000;
async function wakeForStart(agentRow){
  if(!agentRow?.approved || !(agentRow.agent_url||agentRow.agentUrl))throw Error('Agent não aprovado ou sem URL cadastrada.');
  const url=new URL(agentRow.agent_url||agentRow.agentUrl);
  if(url.protocol!=='https:' || !/^[a-z0-9-]+\.onrender\.com$/i.test(url.hostname) || url.username || url.password || url.port)
    throw Error('URL do Agent inválida; utilize o endereço HTTPS do Render.');
  const origin=url.origin;
  // O primeiro GET acorda o Render diretamente; prim é fallback, nunca a primeira opção.
  for(let attempt=1;attempt<=3;attempt++){
    await db.setAgentCheck(agentRow.id,'waking',{watchdogAttempts:attempt,watchdogExhausted:false});
    console.log(`[Master][Agent ${agentRow.id}] Tentativa ${attempt}/3: HTTP direto ${origin}/health`);
    if(await probeUrl(origin,12000)){
      await db.setAgentCheck(agentRow.id,'online',{watchdogAttempts:attempt,watchdogExhausted:false});
      console.log(`[Master][Agent ${agentRow.id}] Agent respondeu diretamente ao /health`);
      return;
    }
    console.log(`[Master][Agent ${agentRow.id}] Sem resposta direta; acionando prim`);
    const accepted=await primBridge.wakeAgent(agentRow.id,origin);
    console.log(`[Master][Agent ${agentRow.id}] Prim ${accepted?'aceitou consulta ao agents.json':'não confirmou'}; aguardando /health`);
    // O prim confirma somente que iniciou a busca, não que já acordou o Agent.
    if(await probeUrl(origin,35000)){
      await db.setAgentCheck(agentRow.id,'online',{watchdogAttempts:attempt,watchdogExhausted:false});
      console.log(`[Master][Agent ${agentRow.id}] Agent respondeu ao /health após tentativa de despertar`);
      return;
    }
    if(attempt<3)await new Promise(resolve=>setTimeout(resolve,10000));
  }
  await db.setAgentCheck(agentRow.id,'offline',{watchdogAttempts:3,watchdogExhausted:true});
  throw Error('O Agent não respondeu após 3 tentativas (HTTP direto e prim). Confira logs [Prim].');
}
async function ensureAgentForBot(botId){
  let b=await db.get(botId,true);if(!b)throw Error('Bot não encontrado');
  // Prioridade absoluta ao Agent já vinculado; nunca troca por outro só porque dormiu.
  if(b.agentId){
    const a=await db.getAgent(b.agentId);
    if(a?.approved){await wakeForStart(a);return db.get(botId,true)}
    throw Error('O Agent vinculado não está aprovado. Verifique em Servidores.');
  }
  // Novo avatar: seleciona um Agent livre sem acordar todos os demais.
  const all=await db.listAgents();
  const free=all.filter(a=>a.approved&&!a.botId&&a.agentUrl);
  if(!free.length)throw Error('Nenhum Agent livre e aprovado. Cadastre ou libere um servidor.');
  const preferred=free.find(a=>a.checkStatus==='online')||free[0];
  await db.assignAgent(botId,preferred.id);
  try{await wakeForStart(await db.getAgent(preferred.id))}
  catch(e){await db.freeAgentForBot(botId);throw e}
  return db.get(botId,true);
}
async function autoConnect(id){
  if(startInFlight.has(Number(id)))return;
  if(Date.now()<(autoConnectCooldown.get(Number(id))||0))return;
  startInFlight.add(Number(id));
  try{const b=await ensureAgentForBot(id);await db.desired(id,true);await agent.call(b,'/start','POST',{config:b});await db.log(id,'Conexão automática iniciada');autoConnectCooldown.delete(Number(id))}catch(e){autoConnectCooldown.set(Number(id),Date.now()+AUTO_CONNECT_COOLDOWN_MS);await db.log(id,'Aguardando Agent disponível: '+e.message).catch(()=>{})}finally{startInFlight.delete(Number(id))}}
async function botAction(req,res,act){
  try{
    let b=await db.get(req.params.id,true);
    if(!b)return fail(res,new Error('Bot não encontrado'),404);
    if(act==='start'){
      if(startInFlight.has(Number(b.id)))return res.status(409).json({ok:false,error:'Já existe uma tentativa de conexão automática em andamento para este avatar. Aguarde o término; o bloqueio é liberado mesmo em caso de falha.'});
      startInFlight.add(Number(b.id));
      try{
        // Intenção explícita primeiro: caso a requisição do navegador caia, a fila pode retomar.
        await db.desired(b.id,true);
        b=await ensureAgentForBot(b.id);
        const x=await agent.call(b,'/start','POST',{config:b});
        return res.json({...x,agentName:b.agentName||''});
      }finally{startInFlight.delete(Number(b.id))}
    }
    if(act==='stop'){
      await db.desired(b.id,false);
      let x={ok:true,message:'Bot já estava desligado.'};
      if(b.agentId){
        try{x=await agent.call(b,'/stop','POST')}
        catch(e){x={ok:true,message:'Bot marcado como desligado; servidor não respondeu.'}}
      }
      // Não desatribuir: o próximo Ligar deve acordar ESTE Agent, mesmo após repouso.
      return res.json({...x,message:(x.message||'Bot desligado.')+' Agent reservado; poderá adormecer naturalmente.'});
    }
    if(act==='restart'){
      await db.desired(b.id,true);
      b=await ensureAgentForBot(b.id);
      return res.json(await agent.call(b,'/restart','POST',{config:b}));
    }
    if(act==='teleport'){const destination=String(req.body?.destination||'');if(!/^https:\/\/maps\.secondlife\.com\/secondlife\/[^/]+\/\d+\/\d+\/\d+\/?$/i.test(destination))throw Error('SLURL inválida');return res.json(await agent.call(b,'/teleport','POST',{destination}));}
    if(act==='home')return res.json(await agent.call(b,'/home','POST'));
    if(act==='invite')return res.json(await agent.call(b,'/invite','POST',req.body||{}));
  }catch(e){fail(res,e,503)}
}
for(const a of ['start','stop','restart','home','invite','teleport'])app.post(`/api/bots/:id/${a}`,auth,(q,r)=>botAction(q,r,a));
app.post('/api/bots/:id/nexus-pro',auth,async(q,r)=>{try{const b=await db.get(q.params.id,true);if(!b)return fail(r,new Error('Bot não encontrado'),404);r.json(await agent.call(b,'/nexus-pro','POST',q.body||{}))}catch(e){fail(r,e)}});
// NEXUS Group Publisher: PostgreSQL persistent, authenticated, per-avatar.
const groupUUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
async function initGroupPublisher(){
 await db.q(`CREATE TABLE IF NOT EXISTS nexus_group_targets (bot_id INTEGER NOT NULL, group_id UUID NOT NULL, label TEXT NOT NULL DEFAULT '', PRIMARY KEY(bot_id,group_id))`);
 await db.q(`CREATE TABLE IF NOT EXISTS nexus_group_jobs (id BIGSERIAL PRIMARY KEY, bot_id INTEGER NOT NULL, group_id UUID NOT NULL, mode TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', message TEXT NOT NULL, frequency TEXT NOT NULL, time_hhmm TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE, last_run_key TEXT, last_result TEXT, last_attempt_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}
app.get('/api/bots/:id/group-targets',auth,async(q,r)=>{try{const bot=await db.get(q.params.id,true);if(!bot)return fail(r,Error('Avatar inexistente'),404);const x=await db.q('SELECT group_id,label FROM nexus_group_targets WHERE bot_id=$1 ORDER BY label,group_id',[bot.id]);r.json({ok:true,groups:x.rows,source:'Grupos cadastrados manualmente; participação não verificada'})}catch(e){fail(r,e)}});
app.post('/api/bots/:id/group-targets',auth,async(q,r)=>{try{const bot=await db.get(q.params.id,true);if(!bot)return fail(r,Error('Avatar inexistente'),404);const id=String(q.body.groupID||'');if(!groupUUID.test(id))return fail(r,Error('UUID inválido'),400);const label=String(q.body.label||'').trim().slice(0,100);await db.q('INSERT INTO nexus_group_targets(bot_id,group_id,label) VALUES($1,$2,$3) ON CONFLICT(bot_id,group_id) DO UPDATE SET label=EXCLUDED.label',[bot.id,id,label]);r.json({ok:true})}catch(e){fail(r,e)}});
app.delete('/api/bots/:id/group-targets/:group',auth,async(q,r)=>{try{const bot=await db.get(q.params.id,true);if(!bot)return fail(r,Error('Avatar inexistente'),404);await db.q('DELETE FROM nexus_group_targets WHERE bot_id=$1 AND group_id=$2',[bot.id,q.params.group]);r.json({ok:true})}catch(e){fail(r,e)}});
app.get('/api/bots/:id/group-jobs',auth,async(q,r)=>{try{const bot=await db.get(q.params.id,true);if(!bot)return fail(r,Error('Avatar inexistente'),404);const x=await db.q('SELECT * FROM nexus_group_jobs WHERE bot_id=$1 ORDER BY id DESC LIMIT 100',[bot.id]);r.json({ok:true,jobs:x.rows})}catch(e){fail(r,e)}});
app.post('/api/bots/:id/group-jobs',auth,async(q,r)=>{try{const bot=await db.get(q.params.id,true);if(!bot)return fail(r,Error('Avatar inexistente'),404);const {groupID,mode,subject,message,frequency,time}=q.body||{};if(!groupUUID.test(String(groupID||'')))return fail(r,Error('UUID inválido'),400);if(!['chat','notice','both'].includes(mode))return fail(r,Error('Modo inválido'),400);if(mode!=='chat')return fail(r,Error('Notices ainda não suportados pelo Agent. Programação não criada.'),422);if(!['daily','weekly'].includes(frequency))return fail(r,Error('Recorrência inválida'),400);if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time||'')))return fail(r,Error('Horário inválido'),400);const msg=String(message||'').trim();if(!msg||msg.length>900)return fail(r,Error('Mensagem deve ter entre 1 e 900 caracteres'),400);const registered=await db.q('SELECT 1 FROM nexus_group_targets WHERE bot_id=$1 AND group_id=$2',[bot.id,groupID]);if(!registered.rowCount)return fail(r,Error('Cadastre o grupo antes de agendar'),400);const x=await db.q('INSERT INTO nexus_group_jobs(bot_id,group_id,mode,subject,message,frequency,time_hhmm) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[bot.id,groupID,mode,String(subject||'').slice(0,120),msg,frequency,time]);r.json({ok:true,id:x.rows[0].id,message:'Agendamento salvo no banco de dados'})}catch(e){fail(r,e)}});
app.delete('/api/bots/:id/group-jobs/:job',auth,async(q,r)=>{try{const bot=await db.get(q.params.id,true);if(!bot)return fail(r,Error('Avatar inexistente'),404);await db.q('UPDATE nexus_group_jobs SET enabled=FALSE WHERE bot_id=$1 AND id=$2',[bot.id,q.params.job]);r.json({ok:true})}catch(e){fail(r,e)}});
let groupSchedulerBusy=false;
async function groupSchedulerTick(){if(groupSchedulerBusy)return;groupSchedulerBusy=true;try{
 const now=new Date();const zone=process.env.BOT_TIMEZONE||'America/Sao_Paulo';const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',weekday:'short',hourCycle:'h23'}).formatToParts(now).map(x=>[x.type,x.value]));const day=`${parts.year}-${parts.month}-${parts.day}`;const time=`${parts.hour}:${parts.minute}`;
 const jobs=(await db.q('SELECT * FROM nexus_group_jobs WHERE enabled AND time_hhmm=$1 AND (last_run_key IS DISTINCT FROM $2) ORDER BY id LIMIT 30',[time,day])).rows;
 for(const job of jobs){if(job.frequency==='weekly' && !['Mon'].includes(parts.weekday))continue;const claim=await db.q('UPDATE nexus_group_jobs SET last_run_key=$2,last_attempt_at=NOW() WHERE id=$1 AND last_run_key IS DISTINCT FROM $2 RETURNING id',[job.id,day]);if(!claim.rowCount)continue;let outcome='';try{const bot=await db.get(job.bot_id,true);if(!bot||!bot.desiredOnline)throw Error('Avatar desligado');const result=await agent.call(bot,'/nexus-pro','POST',{action:'groupmessage',groupID:job.group_id,text:job.message});if(result.ok!==true)throw Error(result.error||result.message||'Envio não confirmado');outcome='Solicitação aceita pelo Agent: '+String(result.message||'').slice(0,300)}catch(e){outcome='Falha: '+String(e.message||e).slice(0,350)}await db.q('UPDATE nexus_group_jobs SET last_result=$2 WHERE id=$1',[job.id,outcome]);}
 }catch(e){console.error('[Group Scheduler]',e.message)}finally{groupSchedulerBusy=false}}
app.get('/api/bots/:id/routes',auth,async(q,r)=>{try{r.json({ok:true,routes:await db.routes(q.params.id)})}catch(e){fail(r,e)}});
app.post('/api/bots/:id/routes',auth,async(q,r)=>{try{await db.addRoute(q.params.id,String(q.body.time||''),String(q.body.destination||''),!!q.body.autoSit,String(q.body.objectUUID||''));r.json({ok:true})}catch(e){fail(r,e,400)}});
app.delete('/api/bots/:id/routes/:routeId',auth,async(q,r)=>{try{await db.deleteRoute(q.params.id,q.params.routeId);r.json({ok:true})}catch(e){fail(r,e)}});
let schedulerBusy=false;
async function schedulerTick(){if(schedulerBusy)return;schedulerBusy=true;try{const zone=process.env.BOT_TIMEZONE||'America/Sao_Paulo';const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());const v=Object.fromEntries(parts.map(x=>[x.type,x.value]));const day=`${v.year}-${v.month}-${v.day}`,time=`${v.hour}:${v.minute}`;const due=(await db.q(`SELECT r.* FROM bot_routes r JOIN bots b ON b.id=r.bot_id WHERE r.enabled AND b.desired_online AND r.time_hhmm=$1 AND r.last_run_day IS DISTINCT FROM $2`,[time,day])).rows;for(const route of due){const claimed=await db.q('UPDATE bot_routes SET last_run_day=$2 WHERE id=$1 AND last_run_day IS DISTINCT FROM $2 RETURNING id',[route.id,day]);if(!claimed.rowCount)continue;try{const b=await db.get(route.bot_id,true);const result=await agent.call(b,'/teleport','POST',{destination:route.destination,autoSit:route.auto_sit,objectUUID:route.object_uuid});if(!result.ok)throw Error(result.error||'Teleporte não aceito');await db.log(b.id,'Rota agendada: '+route.destination)}catch(e){await db.log(route.bot_id,'Falha na rota: '+e.message)}}}catch(e){console.error('Agendador:',e.message)}finally{schedulerBusy=false}}
async function pendingConnections(){try{const all=await db.list();for(const b of all.filter(x=>x.desiredOnline&&!x.agentId).slice(0,5))await autoConnect(b.id)}catch(e){console.error('Fila:',e.message)}}
app.get('/api/bots/:id/logs',auth,async(req,res)=>{try{const b=await db.get(req.params.id,true);let live=[];if(b.desiredOnline)try{const x=await agent.call(b,'/logs');live=x.logs||[]}catch{}const stored=await db.logs(b.id);res.json({ok:true,logs:live.length?live:stored})}catch(e){fail(res,e)}});
// Pool de Agents: o Agent se apresenta sozinho; o dono aprova e atribui um bot no painel.
app.post('/api/agents/register',async(req,res)=>{try{const a=await db.registerAgent(req.body||{});primBridge.scheduleSync(db);const runtime=await db.agentRuntime(a.agent_key);res.json({ok:true,approved:!!a.approved,agentId:Number(a.id),agentSecret:runtime?.agentSecret||'',botId:runtime?.botId||0,desiredOnline:!!runtime?.desiredOnline,config:runtime?.config||null})}catch(e){fail(res,e,400)}});
app.get('/api/agents',auth,async(req,res)=>{try{res.json({ok:true,agents:await db.listAgents()})}catch(e){fail(res,e)}});
app.post('/api/agents/refresh',auth,async(req,res)=>{try{res.json({ok:true,agents:await refreshAgents()})}catch(e){fail(res,e,500)}});
app.post('/api/agents/:id/wake',auth,async(req,res)=>{try{const a=(await db.listAgents()).find(x=>x.id===Number(req.params.id));if(!a||!a.approved)return fail(res,new Error('Agent não aprovado'),404);watchdog.recover(a,true).catch(e=>console.error('Despertar manual:',e));res.json({ok:true,message:'Tentativa de recuperação iniciada'})}catch(e){fail(res,e)}});
app.put('/api/agents/:id',auth,async(req,res)=>{try{res.json({ok:true,agent:await db.updateAgent(req.params.id,req.body||{})});primBridge.scheduleSync(db)}catch(e){fail(res,e,400)}});
app.post('/api/agents/:id/approve',auth,async(req,res)=>{try{res.json({ok:true,agent:await db.approveAgent(req.params.id,req.body?.name||'')});primBridge.scheduleSync(db)}catch(e){fail(res,e,400)}});
app.delete('/api/agents/:id',auth,async(req,res)=>{try{await db.deleteAgent(req.params.id);res.json({ok:true});primBridge.scheduleSync(db)}catch(e){fail(res,e,400)}});
app.post('/api/bots/:id/assign',auth,async(req,res)=>{try{await db.assignAgent(req.params.id,req.body?.agentId||null);res.json({ok:true,bot:await db.get(req.params.id)})}catch(e){fail(res,e,400)}});

// Agent usa esta rota para recuperar a configuração após restart do Render.
app.post('/api/agent/bootstrap',async(req,res)=>{try{const requestedId=Number(req.body.botId||0),secret=String(req.body.agentSecret||'');if(!secret)return fail(res,new Error('agentSecret ausente'),400);const b=requestedId?await db.get(requestedId,true):await db.findByAgentSecret(secret);if(!b||b.agentSecret!==secret)return fail(res,new Error('Agent não autorizado'),403);await db.heartbeat(b.id,req.body.status||{});res.json({ok:true,botId:b.id,desiredOnline:b.desiredOnline,config:b})}catch(e){fail(res,e)}});
app.post('/api/agent/heartbeat',async(req,res)=>{try{const requestedId=Number(req.body.botId||0),secret=String(req.body.agentSecret||''),agentKey=String(req.body.agentKey||'');let b=null;if(agentKey){const ar=await db.agentRuntime(agentKey);if(!ar||!ar.approved||ar.agentSecret!==secret||Number(ar.botId||0)!==requestedId)return fail(res,new Error('Agent não autorizado'),403);b=ar.config;}else{b=requestedId?await db.get(requestedId,true):await db.findByAgentSecret(secret);if(!b||b.agentSecret!==secret)return fail(res,new Error('Agent não autorizado'),403);}await db.heartbeat(b.id,req.body.status||{});if(req.body.log)await db.log(b.id,req.body.log);res.json({ok:true,botId:b.id,desiredOnline:b.desiredOnline})}catch(e){fail(res,e)}});

app.get('/api/system/stats',auth,async(req,res)=>{try{res.json({ok:true,stats:await db.stats()})}catch(e){fail(res,e)}});
app.post('/api/system/cleanup',auth,async(req,res)=>{try{res.json({ok:true,...await db.cleanupLogs(req.body?.days||30)})}catch(e){fail(res,e)}});
app.post('/api/system/backup',auth,async(req,res)=>{try{const data=await db.exportBackup();const pkg=encryptBackup(data,req.body?.password);const name=`sl-bot-backup-${new Date().toISOString().slice(0,10)}.slbackup`;res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Disposition',`attachment; filename="${name}"`);res.send(JSON.stringify(pkg))}catch(e){fail(res,e,400)}});
app.post('/api/system/restore',auth,async(req,res)=>{try{const data=decryptBackup(req.body?.backup,req.body?.password);const out=await db.restoreBackup(data);res.json({ok:true,...out})}catch(e){fail(res,new Error('Não foi possível restaurar: '+(e.message||e)),400)}});
app.get('/health',(_q,r)=>r.send('ok'));
db.init().then(async()=>{await initGroupPublisher();primBridge.scheduleSync(db);setInterval(()=>db.cleanupLogs(Number(process.env.LOG_RETENTION_DAYS||30)).catch(e=>console.warn('Limpeza de logs:',e.message)),6*60*60*1000);return app.listen(PORT,'0.0.0.0',()=>console.log('Master Panel ativo na porta',PORT))}).catch(e=>{console.error(e);process.exit(1)});

new Promise(resolve=>setTimeout(resolve,5000)).then(()=>db.initRoutes()).then(()=>{setInterval(schedulerTick,20000);setInterval(groupSchedulerTick,20000);setInterval(pendingConnections,60000);setInterval(()=>watchdog.observe().catch(e=>console.error('Watchdog:',e.message)),90000);watchdog.observe().catch(console.error);pendingConnections()}).catch(e=>console.error('Rotas:',e.message));
