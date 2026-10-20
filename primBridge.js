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
 const secret=process.env.MASTER_SECRET;
 if(!secret)return false;
 const source=await fetch(RAW+'prim.json?ts='+Date.now(),{signal:AbortSignal.timeout(10000),cache:'no-store'});
 if(!source.ok)return false;
 const prim=await source.json();
 const u=new URL(String(prim.url||''));
 if(u.protocol!=='https:'||u.username||u.password||u.port||!u.hostname.endsWith('.secondlife.com')||!u.pathname.startsWith('/cap/'))return false;
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);
 try{const r=await fetch(u.toString(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret,action:'wake',agent_id:String(id)}),signal:controller.signal,redirect:'error'});return r.status===202}catch{return false}finally{clearTimeout(timer)}
}
module.exports={scheduleSync,wakeAgent};
