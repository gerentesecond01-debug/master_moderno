'use strict';
const $=id=>document.getElementById(id);
let prims=[],bots=[];
const groupCache=new Map();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function el(tag,cls,content){const x=document.createElement(tag);if(cls)x.className=cls;if(content!==undefined)x.textContent=content;return x}
function notify(message,error=false){$('msg').textContent=message;$('msg').classList.toggle('error',error)}
async function api(path,opts){const response=await fetch(path,{credentials:'same-origin',...opts});let data;try{data=await response.json()}catch{throw Error('Resposta inesperada do servidor (HTTP '+response.status+')')}if(!response.ok||data.ok===false)throw Error(data.error||'HTTP '+response.status);return data}
function field(title,control){const label=el('label','field',title);label.append(control);return label}
function idRow(title,value){const row=el('div','id-row');row.append(el('span','',title),el('code','',value||'—'));return row}
async function fetchGroups(botId,groupSelect,previous){
 groupSelect.replaceChildren(new Option('Consultando grupos do Second Life…',''));
 groupSelect.disabled=true;
 try{
  let groups=groupCache.get(String(botId));
  if(!groups){
   const result=await api('/api/bots/'+encodeURIComponent(botId)+'/nexus-pro',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'groups'})
   });
   if(!Array.isArray(result.groups))throw Error(result.message||'O Agent não retornou uma lista de grupos.');
   groups=result.groups.filter(g=>uuid.test(String(g.id||'')));
   groupCache.set(String(botId),groups);
  }
  groupSelect.replaceChildren(new Option('Selecione um grupo…',''));
  for(const g of groups){const o=new Option(String(g.name||'Grupo sem nome'),String(g.id));o.title=g.id;groupSelect.append(o)}
  if(previous&&groups.some(g=>g.id.toLowerCase()===previous.toLowerCase()))groupSelect.value=previous;
  if(!groups.length)notify('Este avatar não retornou grupos. Verifique se está online.',true);
  groupSelect.disabled=false;
 }catch(e){groupSelect.replaceChildren(new Option('Não foi possível consultar os grupos',''));notify('Erro na lista de grupos: '+e.message,true)}
}
function render(){
 const term=$('search').value.toLowerCase().trim(),filter=$('filter').value;
 $('total').textContent=prims.length;
 $('active').textContent=prims.filter(p=>p.approved).length;
 $('pending').textContent=prims.filter(p=>!p.approved).length;
 const list=$('list');list.replaceChildren();
 const selected=prims.filter(p=>(filter==='all'||(filter==='approved'&&p.approved)||(filter==='pending'&&!p.approved))&&[p.prim_id,p.owner_id,p.group_id].some(x=>String(x||'').toLowerCase().includes(term)));
 if(!selected.length){list.append(el('div','empty',prims.length?'Nenhum prim corresponde aos filtros.':'Nenhum prim cadastrado. Adicione o script LSL em um prim para começar.'));return}
 for(const prim of selected){
  const card=el('article','prim-card'),head=el('div','card-head');
  head.append(el('h3','','Prim de convite'),el('span','status '+(prim.approved?'approved':'pending'),prim.approved?'● Aprovado':'◷ Pendente'));card.append(head);
  const ids=el('div','ids');ids.append(idRow('UUID do prim',prim.prim_id),idRow('Proprietário',prim.owner_id));card.append(ids);
  const select=el('select');select.setAttribute('aria-label','Bot responsável');select.append(new Option('Selecione um bot',''));
  for(const bot of bots){const option=new Option(String(bot.name||bot.avatarName||bot.firstName||'Bot')+' · ID '+bot.id,String(bot.id));if(String(prim.bot_id)===String(bot.id))option.selected=true;select.append(option)}
  card.append(field('1. Escolha o avatar que enviará o convite',select));
  const group=el('select');group.setAttribute('aria-label','Grupo para convidar');group.append(new Option('Escolha primeiro um avatar',''));card.append(field('2. Escolha o grupo do avatar',group));
  const groupTools=el('div','group-tools');const reload=el('button','secondary','↻ Atualizar grupos');reload.type='button';
  const help=el('span','group-help','A lista vem diretamente do Agent conectado ao avatar.');groupTools.append(reload,help);card.append(groupTools);
  const updateGroups=()=>{if(select.value)fetchGroups(select.value,group,select.value===String(prim.bot_id)?String(prim.group_id||''):'');else{group.replaceChildren(new Option('Escolha primeiro um avatar',''));group.disabled=true}};
  select.onchange=updateGroups;reload.onclick=()=>{groupCache.delete(select.value);updateGroups()};updateGroups();
  const actions=el('div','actions'),save=el('button','primary',prim.approved?'Salvar alterações':'Salvar e aprovar'),remove=el('button','danger','Revogar prim');
  save.onclick=async()=>{if(!select.value){notify('Selecione um bot para continuar.',true);select.focus();return}if(!uuid.test(group.value)){notify('Selecione um grupo da lista.',true);group.focus();return}
   save.disabled=true;try{await api('/api/prim-invites/'+encodeURIComponent(prim.prim_id),{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({botId:Number(select.value),groupId:group.value})});await load('Configuração salva com sucesso.')}catch(e){notify('Não foi possível salvar: '+e.message,true)}finally{save.disabled=false}};
  remove.onclick=async()=>{if(!confirm('Revogar o acesso deste prim?'))return;remove.disabled=true;try{await api('/api/prim-invites/'+encodeURIComponent(prim.prim_id),{method:'DELETE'});await load('Prim revogado com sucesso.')}catch(e){notify('Erro ao revogar: '+e.message,true)}finally{remove.disabled=false}};
  actions.append(save,remove);card.append(actions);list.append(card);
 }
}

async function load(message){$('refresh').disabled=true;try{const [p,b]=await Promise.all([api('/api/prim-invites'),api('/api/bots')]);prims=Array.isArray(p.prims)?p.prims:[];bots=Array.isArray(b.bots)?b.bots:[];render();notify(message||'Lista atualizada.')}catch(e){notify('Erro ao carregar: '+e.message+'. Confira se você está conectado ao Master.',true)}finally{$('refresh').disabled=false}}
$('refresh').onclick=()=>load();$('search').oninput=render;$('filter').onchange=render;load();
