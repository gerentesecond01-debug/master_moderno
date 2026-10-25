'use strict';
const crypto=require('crypto');
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const fixed=(v)=>String(v||'').trim().toLowerCase();
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const limits=new Map();
function mount(app,auth,db,agent){
  app.post('/api/prim-invites/enroll',async(req,res)=>{
    try{
      const prim=fixed(req.body.primId), owner=fixed(req.body.ownerId), token=String(req.body.token||'');
      if(!UUID.test(prim)||!UUID.test(owner)||token.length<32||token.length>200)return res.status(400).json({ok:false,error:'Identificação inválida'});
      // Enrollment is pending until approved by an authenticated administrator.
      await db.q(`INSERT INTO nexus_invite_prims(prim_id,owner_id,token_hash,approved) VALUES($1,$2,$3,false)
        ON CONFLICT(prim_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,token_hash=EXCLUDED.token_hash,
        approved=CASE WHEN nexus_invite_prims.owner_id=EXCLUDED.owner_id AND nexus_invite_prims.token_hash=EXCLUDED.token_hash THEN nexus_invite_prims.approved ELSE false END`,[prim,owner,sha(token)]);
      res.json({ok:true,message:'Prim registrado. Aguarde aprovação no Master.'});
    }catch(e){res.status(500).json({ok:false,error:e.message})}
  });
  app.get('/api/prim-invites',auth,async(req,res)=>{
    try{const x=await db.q('SELECT prim_id,owner_id,approved,bot_id,group_id,updated_at FROM nexus_invite_prims ORDER BY updated_at DESC');res.json({ok:true,prims:x.rows})}catch(e){res.status(500).json({ok:false,error:e.message})}
  });
  app.put('/api/prim-invites/:id',auth,async(req,res)=>{
    try{
      const prim=fixed(req.params.id), group=fixed(req.body.groupId),bot=Number(req.body.botId);
      if(!UUID.test(prim)||!UUID.test(group)||!Number.isSafeInteger(bot)||bot<1)return res.status(400).json({ok:false,error:'Bot ou grupo inválido'});
      const b=await db.get(bot,true);if(!b)return res.status(404).json({ok:false,error:'Bot não encontrado'});
      const x=await db.q('UPDATE nexus_invite_prims SET approved=true,bot_id=$2,group_id=$3,updated_at=NOW() WHERE prim_id=$1 RETURNING prim_id',[prim,bot,group]);
      if(!x.rowCount)return res.status(404).json({ok:false,error:'Prim não cadastrado'});
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:e.message})}
  });
  app.delete('/api/prim-invites/:id',auth,async(req,res)=>{
    try{await db.q('DELETE FROM nexus_invite_prims WHERE prim_id=$1',[fixed(req.params.id)]);res.json({ok:true})}catch(e){res.status(500).json({ok:false,error:e.message})}
  });
  app.post('/api/prim-invites/click',async(req,res)=>{
    try{
      const prim=fixed(req.body.primId), visitor=fixed(req.body.avatarId),token=String(req.get('X-Nexus-Prim-Key')||'');
      if(!UUID.test(prim)||!UUID.test(visitor)||token.length<32)return res.status(403).json({ok:false,error:'Prim não autorizado'});
      const x=await db.q('SELECT * FROM nexus_invite_prims WHERE prim_id=$1 AND approved=true',[prim]);const row=x.rows[0];
      if(!row||sha(token)!==row.token_hash)return res.status(403).json({ok:false,error:'Prim não aprovado ou chave incorreta'});
      const key=prim+':'+visitor, now=Date.now();if(now-(limits.get(key)||0)<60000)return res.status(429).json({ok:false,error:'Aguarde 60 segundos para outro convite'});
      limits.set(key,now);if(limits.size>5000){for(const [k,t] of limits)if(now-t>120000)limits.delete(k)}
      const bot=await db.get(row.bot_id,true);if(!bot||!bot.desiredOnline)return res.status(503).json({ok:false,error:'Bot não está habilitado'});
      const result=await agent.call(bot,'/nexus-pro','POST',{action:'invite',groupID:row.group_id,avatarID:visitor});
      if(result.ok!==true)return res.status(502).json({ok:false,error:result.error||result.message||'Agent não confirmou a solicitação'});
      res.json({ok:true,message:'Solicitação de convite aceita pelo Agent'});
    }catch(e){res.status(502).json({ok:false,error:e.message||String(e)})}
  });
}
async function init(db){await db.q(`CREATE TABLE IF NOT EXISTS nexus_invite_prims (
 prim_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,token_hash TEXT NOT NULL,approved BOOLEAN NOT NULL DEFAULT false,
 bot_id INTEGER,group_id TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)}
module.exports={mount,init};
