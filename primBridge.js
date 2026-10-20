'use strict';
// Public GitHub repository; write with fine-grained token only in Render env.
const OWNER='gerentesecond01-debug', REPO='prim', BRANCH='main';
const BASE=`https://api.github.com/repos/${OWNER}/${REPO}/contents/`;
const RAW=`https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/`;
const HEADERS={'Accept':'application/vnd.github+json','User-Agent':'NEXUS-Master','X-GitHub-Api-Version':'2022-11-28'};
let pending=false, busy=false;
const safeUrl=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/^[a-z0-9-]+\.onrender\.com$/i.test(u.hostname)&&['','/'].includes(u.pathname)&&!u.search&&!u.hash?u.origin:null}catch{return null}};
async function githubPut(filename,content){
 const token=process.env.GITHUB_TOKEN;
 if(!token){console.warn('[Prim] GITHUB_TOKEN ausente: agents.json nao sincronizado');return false}
 const headers={...HEADERS,Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
 const get=await fetch(BASE+filename,{headers,signal:AbortSignal.timeout(12000)});
 if(!get.ok&&get.status!==404)throw Error(`GitHub GET ${get.status}`);
 const old=get.ok?await get.json():null;
 const data=JSON.stringify(content,null,2)+'\n';
 const payload={message:'NEXUS: sincronizar agents.json',branch:BRANCH,content:Buffer.from(data).toString('base64')};
 if(old?.sha)payload.sha=old.sha;
 const put=await fetch(BASE+filename,{method:'PUT',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});
 if(!put.ok)throw Error(`GitHub PUT ${put.status}: ${(await put.text()).slice(0,160)}`);
 return true;
}
async function sync(db){const rows=await db.listAgents();const agents=rows.filter(a=>a.approved&&safeUrl(a.agentUrl)).map(a=>({id:String(a.id),url:safeUrl(a.agentUrl),enabled:true}));return githubPut('agents.json',{agents})}
function scheduleSync(db){pending=true;if(busy)return;busy=true;setImmediate(async()=>{try{while(pending){pending=false;await sync(db)}}catch(e){console.warn('[Prim] sync:',e.message)}finally{busy=false}})}
async function wakeAgent(id,expectedUrl){
 const prefix=`[Prim][Agent ${id}]`;
 const secret=process.env.MASTER_SECRET;
 if(!secret || secret.length<20){console.warn(`${prefix} MASTER_SECRET ausente ou com menos de 20 caracteres`);return false;}
 const expected=safeUrl(expectedUrl);
 if(!expected){console.warn(`${prefix} URL do Agent inválida`);return false;}
 try {
  console.log(`${prefix} Consultando prim.json no GitHub`);
  const source=await fetch(BASE+'prim.json?ref='+BRANCH,{headers:HEADERS,signal:AbortSignal.timeout(12000),cache:'no-store'});
  if(!source.ok)throw Error(`GitHub prim.json HTTP ${source.status}`);
  const file=await source.json();
  const prim=JSON.parse(Buffer.from(file.content.replace(/\s/g,''),'base64').toString('utf8'));
  const u=new URL(String(prim.url||''));
  if(u.protocol!=='https:'||u.username||u.password||u.port||!u.hostname.endsWith('.secondlife.com')||!u.pathname.startsWith('/cap/'))throw Error('URL do prim inválida ou não registrada');
  if(prim.status!=='online')throw Error('Prim não está marcado como online');
  console.log(`${prefix} Enviando POST ao prim`);
  const r=await fetch(u.toString(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret,action:'wake',agent_id:String(id)}),signal:AbortSignal.timeout(20000),redirect:'error'});
  const body=(await r.text()).slice(0,140);
  console.log(`${prefix} Resposta do prim: HTTP ${r.status} ${body}`);
  return r.status===202 && body.includes('LOOKUP_STARTED');
 } catch(e){console.warn(`${prefix} Falha no despertar: ${e.message}`);return false;}
}

module.exports={scheduleSync,wakeAgent};
