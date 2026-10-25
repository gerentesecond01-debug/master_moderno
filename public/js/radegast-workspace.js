/* Interface em duas colunas: usa as funções e APIs originais do Master. */
let workspaceSelectedId=null,workspaceTab='status',workspaceRouteCache={};
function workspaceItem(b){const l=live(b),on=!!l.online,region=on?(l.region||b.runtime?.lastRegion||''):'';return `<div class="avatar-item ${Number(workspaceSelectedId)===Number(b.id)?'selected':''}" data-search="${esc((b.name+' '+b.firstName+' '+b.lastName+' '+region).toLowerCase())}" onclick="workspaceSelect(${Number(b.id)})"><span class="avatar-dot ${on?'on':''}"></span><span class="avatar-info"><strong>${esc(b.name)}</strong><small class="avatar-region">${esc(on?(region||'Região ainda não recebida'):(b.desiredOnline?'Sem conexão SL':'Desligado manualmente'))}</small></span><span class="avatar-state">${on?'Online':b.desiredOnline?'Offline':'Parado'}</span></div>`}
function workspaceList(){const el=document.querySelector('#workspaceList');if(!el)return;el.innerHTML=bots.map(workspaceItem).join('');workspaceFilter();const count=document.querySelector('#workspaceCount');if(count)count.textContent=`${bots.filter(b=>live(b).online).length} online · ${bots.length} cadastrados`}
function workspaceFilter(){const q=(document.querySelector('#workspaceSearch')?.value||'').trim().toLowerCase();document.querySelectorAll('#workspaceList .avatar-item').forEach(el=>el.hidden=!el.dataset.search.includes(q))}
async function botsPage(){await loadBots();$('#title').textContent='Monitor de avatares';$('#sub').textContent='Selecione um avatar à esquerda para acessar os comandos e informações';if(workspaceSelectedId!==null&&!bots.some(b=>Number(b.id)===Number(workspaceSelectedId)))workspaceSelectedId=null;if(workspaceSelectedId===null&&bots.length)workspaceSelectedId=bots[0].id;content.innerHTML=`<div class="workspace"><section class="workspace-left"><div class="workspace-heading">▣ Avatares <span id="workspaceCount" class="muted" style="float:right;font-weight:400"></span></div><div class="workspace-search"><input id="workspaceSearch" placeholder="Buscar avatar..." oninput="workspaceFilter()"></div><div id="workspaceList" class="workspace-list"></div><div class="workspace-left-bottom"><button onclick="openBotForm()">+ Cadastrar avatar</button></div></section><section class="workspace-right"><div id="workspaceDetail"></div></section></div>`;workspaceList();workspaceRender()}
function workspaceSelect(id){workspaceSelectedId=Number(id);workspaceTab='status';workspaceList();workspaceRender()}
async function workspaceSetTab(tab){
 workspaceTab=tab;
 workspaceRender();
 if(tab==='routes' && workspaceSelectedId!==null){
  const id=Number(workspaceSelectedId);
  try{
   const data=await api('/api/bots/'+id+'/routes');
   workspaceRouteCache[id]=data;
   if(workspaceTab==='routes' && Number(workspaceSelectedId)===id)workspaceRender();
  }catch(e){workspaceRouteCache[id]={error:e.message};if(workspaceTab==='routes'&&Number(workspaceSelectedId)===id)workspaceRender()}
 }
}
function workspaceRender(){
 const host=document.querySelector('#workspaceDetail');if(!host)return;
 const b=bots.find(b=>Number(b.id)===Number(workspaceSelectedId));
 if(!b){host.innerHTML='<div class="workspace-empty">Nenhum avatar selecionado.<br>Cadastre um avatar para começar.</div>';return;}
 const l=live(b),on=!!l.online,srv=b.server||{},region=on?(l.region||b.runtime?.lastRegion||''):'';
 const statusText=on?'CONECTADO':!b.desiredOnline?'DESLIGADO':l.reachable===false?'SEM COMUNICAÇÃO':({starting:'INICIANDO',connecting:'CONECTANDO',waiting_region:'RECONECTANDO'}[l.phase]||'OFFLINE');
 const regionText=on?(region||'Aguardando localização do Agent'):'Localização indisponível';
 const pos=l.position||l.coords||l.coordinates;const xyz=Array.isArray(pos)?pos:(pos&&typeof pos==='object'?[pos.x,pos.y,pos.z]:null);const coords=on&&xyz&&xyz.length===3&&xyz.every(v=>Number.isFinite(Number(v)))?xyz.map(v=>Math.round(Number(v))).join(', '):'Coordenadas ainda não recebidas';
 let inner='';
 if(workspaceTab==='status')inner=`<div class="workspace-facts"><span>Nome do avatar</span><b>${esc(b.firstName+' '+b.lastName)}</b><span>Estado desejado</span><b>${b.desiredOnline?'Manter ligado':'Desligado manualmente'}</b><span>Servidor Agent</span><b>${esc(srv.name||'Não atribuído')}</b><span>Status Agent</span><b>${esc(srv.checkStatus||'Não verificado')}</b><span>Último motivo</span><b>${esc(l.lastReason||'—')}</b><span>Última comunicação</span><b>${ago(b.runtime?.lastAgentSeen)}</b></div>`;
 else if(workspaceTab==='routes'){
  const data=workspaceRouteCache[b.id];
  const routes=Array.isArray(data)?data:(data?.routes||[]);
  const rows=routes.map(r=>`<div class="workspace-route-row"><span>${esc(r.time_hhmm||r.time||r.at||r.hour||'Horário não informado')}</span><strong>${esc(r.destination||r.slurl||r.region||r.url||'Destino não informado')}</strong><span>${r.enabled===false?'Pausada':'Ativa'}</span></div>`).join('');
  inner=`<div class="workspace-section-heading"><strong>Teleportes agendados</strong><button onclick="routeModal(${b.id})">+ Gerenciar programações</button></div>${data?.error?`<p class="muted">Não foi possível carregar as programações: ${esc(data.error)}</p>`:!data?'<p class="muted">Carregando programações...</p>':rows||'<p class="muted">Nenhuma programação cadastrada para este avatar.</p>'}`;
 }
 else inner=`<p class="muted">Registros e diagnósticos de conexão do avatar.</p><button onclick="botDetail(${b.id})">Ver detalhes e eventos</button><button class="secondary" onclick="route('logs')">Abrir histórico</button>`;
 host.innerHTML=`<div class="workspace-topline"><div><strong>${esc(b.name)}</strong><div class="muted">Avatar #${b.id} · ${esc(srv.name||'Sem Agent')}</div></div>${badge(b)}</div>
 <div class="workspace-live-cards"><div class="workspace-live-card"><span class="live-label">📍 REGIÃO ATUAL</span><strong class="live-region">${esc(regionText)}</strong><span class="live-hint">${esc(coords)}</span></div><div class="workspace-live-card ${on?'is-online':!b.desiredOnline?'is-stopped':'is-offline'}"><span class="live-label">● STATUS DO AVATAR</span><strong class="live-status">${esc(statusText)}</strong><span class="live-hint">Última comunicação: ${ago(b.runtime?.lastAgentSeen)}</span></div></div>
 <div class="workspace-actions"><button class="ok" ${on?'disabled':''} onclick="act(${b.id},'start')">▶ Ligar</button><button class="danger" ${!b.desiredOnline?'disabled':''} onclick="act(${b.id},'stop')">■ Desligar</button><button class="secondary" ${l.reachable===false?'disabled':''} onclick="act(${b.id},'restart')">↻ Reiniciar</button><button class="secondary" ${!on?'disabled':''} onclick="act(${b.id},'home')">⌂ Home</button><span class="workspace-action-divider"></span><button class="secondary" onclick="openBotForm(${b.id})">✎ Editar</button><button class="danger" onclick="removeBot(${b.id})">✕ Excluir</button></div>
 <div class="workspace-tabs">${[['status','Informações'],['routes','Programações'],['logs','Histórico']].map(([key,label])=>`<button class="${workspaceTab===key?'active':''}" onclick="workspaceSetTab('${key}')">${label}</button>`).join('')}</div><div class="workspace-body"><div class="workspace-tabcontent">${inner}</div></div><div class="workspace-footer"><span>Watchdog: ${Number(l.watchdogRestarts||0)} reinícios</span><span>Recuperações: ${Number(l.recoveryCount||0)}</span><span>Atualização: ${ago(b.runtime?.lastAgentSeen)}</span></div>`;
}
// Uma única atualização de dados, sem substituir campos que o usuário esteja editando.
let workspaceRefreshing=false;
setInterval(async()=>{if(workspaceRefreshing||document.hidden||currentPage!=='bots'||!document.querySelector('#workspaceList')||document.querySelector('#modalOverlay'))return;workspaceRefreshing=true;try{await loadBots();if(!document.querySelector('#workspaceList'))return;workspaceList();workspaceRender()}catch(e){console.warn('Workspace:',e.message)}finally{workspaceRefreshing=false}},30000);
