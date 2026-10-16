import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Catalog, readCatalog } from './catalog.mjs';
import { Sessions } from './sessions.mjs';
import { makeServer } from './server.mjs';

test('catalog searches across titles and folders, deduplicates IDs and pages the full list',async()=>{
  let reads=0;
  const rows=Array.from({length:65},(_,i)=>({id:randomUUID(),name:`Chat ${i}`,cwd:i%2?'/work/degree':'/work/minecraft',updatedAt:i}));
  const catalog=new Catalog(async()=>{reads++;return{rows:[...rows,rows[0]],truncated:false};});
  const [a,b]=await Promise.all([catalog.list(),catalog.list('degree')]);
  assert.equal(reads,1);assert.equal(a.sessions.length,30);assert.equal(a.total,65);assert.equal(b.total,32);
  const next=await catalog.list('',a.nextCursor);assert.equal(next.sessions.length,30);
  assert.equal(next.sessions.some(t=>a.sessions.some(s=>s.id===t.id)),false);
  assert.equal((await catalog.list('degree chat 1')).sessions.every(t=>t.cwd.includes('degree')&&t.title.includes('1')),true);
});

test('discovery subprocess uses only initialize and thread/list, including pagination',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agentic-catalog-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const executable=path.join(dir,'fixture');
  fs.writeFileSync(executable,`#!${process.execPath}\nconst rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line);if(!['initialize','initialized','thread/list'].includes(m.method))process.exit(2);
if(m.method==='initialized')return;
if(m.method==='thread/list'&&(m.params.cwd||m.params.sortKey!=='recency_at'||!m.params.sourceKinds.includes('appServer')))process.exit(3);
const result=m.method==='initialize'?{}:m.params.cursor?{data:[{id:'second',cwd:'/other'}],nextCursor:null}:{data:[{id:'first',cwd:'/one'}],nextCursor:'page2'};
process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});\n`,{mode:0o700});
  const result=await readCatalog({executable});assert.deepEqual(result.rows.map(r=>r.id),['first','second']);
});

test('viewing and metadata updates leave order unchanged; conversation activity reorders it',async()=>{
  const a={id:'a',name:'Older chat',recencyAt:100,updatedAt:100}, b={id:'b',name:'Recent chat',recencyAt:200,updatedAt:200};
  const catalog=new Catalog(async()=>({rows:[a,b,{...a,name:'Old duplicate',updatedAt:50}],truncated:false}));
  const order=async()=>{await catalog.refresh(true);return (await catalog.list()).sessions.map(r=>r.id);};
  assert.deepEqual(await order(),['b','a']);
  a.updatedAt=300;await catalog.get('a');
  assert.deepEqual(await order(),['b','a']);
  assert.equal((await catalog.get('a')).title,'Older chat');
  a.recencyAt=301;assert.deepEqual(await order(),['a','b']);
});

async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agentic-session-'));
  const ids=[randomUUID(),randomUUID(),randomUUID()], sends=[], clients=new Map();let persisted=ids[0], rejectPersist=false;
  let release;
  const catalog=new Catalog(async()=>({rows:ids.map((id,i)=>({id,name:`Session ${i}`,cwd:`/work/project${i}`,updatedAt:i})),truncated:false}));
  const hub=new Sessions(ids[0],{catalog,persist:id=>{if(rejectPersist)throw Error('Disk full');persisted=id;},create:id=>{
    const desktop={ready:true,closed:false,delivered:new Set(),busy:false,
      connect(){},close(){this.closed=true;},
      view(){return{connected:this.ready,canSend:this.ready&&!this.busy,title:`Session ${ids.indexOf(id)}`,messages:[{id,role:'Codex',text:id}],busy:this.busy,latestCompletedReplyId:`reply-${id}`};},
      hasMessage(mid){return this.delivered.has(mid);},
      async send(text,mid){sends.push({id,mid,text});if(release===true)await new Promise(resolve=>release=resolve);},
    };clients.set(id,desktop);return desktop;
  }});
  hub.connect();
  const server=makeServer(hub,{token:'fixture',journalPath:path.join(dir,'receipts.json')});server.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`http://127.0.0.1:${server.address().port}`;
  const post=(route,body)=>fetch(url+route,{method:'POST',headers:{Authorization:'Bearer fixture','Content-Type':'application/json'},body:JSON.stringify(body)});
  t.after(()=>{hub.close();server.closeAllConnections();server.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {hub,ids,clients,sends,post,persisted:()=>persisted,reject:()=>{rejectPersist=true;},hold:()=>{release=true;},release:()=>release()};
}
test('switching follows the same desktop clients, keeps running work, and never merges transcripts',async t=>{
  const f=await fixture(t),[a,b]=f.ids;f.clients.get(a).busy=true;
  const result=await f.post('/session',{threadId:b,expectedThreadId:a});assert.equal(result.status,200);
  assert.equal(f.persisted(),b);assert.equal(f.clients.get(a).closed,false);assert.equal(f.clients.get(a).busy,true);
  assert.deepEqual((await result.json()).messages.map(m=>m.id),[b]);
  assert.equal((await f.post('/message',{threadId:a,id:randomUUID(),text:'Stale window'})).status,400);
  assert.equal(f.sends.length,0);
  await f.post('/message',{threadId:b,id:randomUUID(),text:'For B'});assert.equal(f.sends[0].id,b);
  await f.post('/session',{threadId:a,expectedThreadId:b});assert.equal(f.clients.size,2);assert.equal(f.hub.view().busy,true);
});
test('failed or stale selection preserves the current chat; unloaded chat cannot send',async t=>{
  const f=await fixture(t),[a,b,c]=f.ids;
  assert.equal((await f.post('/session',{threadId:b,expectedThreadId:c})).status,409);assert.equal(f.hub.threadId,a);
  f.reject();assert.equal((await f.post('/session',{threadId:b,expectedThreadId:a})).status,409);assert.equal(f.hub.threadId,a);
  f.clients.get(a).ready=false;
  assert.equal((await f.post('/message',{threadId:a,id:randomUUID(),text:'Offline'})).status,409);assert.equal(f.sends.length,0);
});
test('selection waits for dispatch; an uncertain receipt remains attached to its original conversation',async t=>{
  const f=await fixture(t),[a,b]=f.ids;f.hold();const mid=randomUUID();
  const pending=f.post('/message',{threadId:a,id:mid,text:'For A'});
  while(f.sends.length===0)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal((await f.post('/session',{threadId:b,expectedThreadId:a})).status,409);
  f.release();await pending;
  await f.post('/session',{threadId:b,expectedThreadId:a});await f.post('/session',{threadId:a,expectedThreadId:b});
  assert.equal((await (await f.post('/message',{threadId:a,id:mid,text:'For A'})).json()).state,'submitted');
  assert.equal(f.sends.length,1);
});

test('a fresh Codex setup lists chats before selecting or connecting one',async()=>{
  let created=0,refreshed=0;const id='11111111-1111-4111-8111-111111111111';
  const hub=new Sessions('',{catalog:{refresh:async()=>{refreshed++;},get:async()=>({id,title:'Example'}),list:async()=>({sessions:[{id,title:'Example'}]})},
    create:()=>{created++;return {connect(){},close(){},view:()=>({connected:true,messages:[]})};}});
  hub.connect();assert.equal(created,0);assert.equal(refreshed,1);assert.equal(hub.view().canSend,false);
  assert.equal((await hub.list()).sessions[0].id,id);await hub.select(id);assert.equal(created,1);hub.close();
});
