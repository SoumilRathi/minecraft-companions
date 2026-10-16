import test from 'node:test';
import assert from 'node:assert/strict';
import {Changes} from './changes.mjs';
import {DotSessions} from './sessions.mjs';
const DEFAULT_DOT='11111111-1111-4111-8111-111111111111';
import {RemoteDotSessions} from './remote.mjs';
import {makeServer} from '../server.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

test('versioned notifications preserve changes between requests, restart epochs, and cancellation',async()=>{
  const c=new Changes(),before=c.revision;
  const waiting=c.wait(before,{timeoutMs:20000});c.notify();assert.equal(await waiting,c.revision);
  assert.equal(await c.wait(before),c.revision);
  assert.notEqual(new Changes().revision,c.revision);
  const abort=new AbortController(),cancelled=c.wait(c.revision,{signal:abort.signal});
  assert.equal(c.listeners.size,1);abort.abort();await cancelled;assert.equal(c.listeners.size,0);
});

test('held HTTP requests propagate commands and receipts across both brokers immediately',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dot-notifications-'));
  const token='a'.repeat(64),dot=new DotSessions({threadId:DEFAULT_DOT,configDir:dir});
  const cloud=makeServer(null,{token,journalPath:path.join(dir,'cloud.json'),providers:{dot}});
  await new Promise(r=>cloud.listen(0,'127.0.0.1',r));
  const remote=new RemoteDotSessions({config:{threadId:DEFAULT_DOT,host:'fixture',user:'ubuntu',identityFile:'/tmp/fixture',port:cloud.address().port,token}});
  remote.ensureTunnel=async()=>{remote.localPort=cloud.address().port;};
  const local=makeServer(null,{token,journalPath:path.join(dir,'local.json'),providers:{dot:remote}});
  await new Promise(r=>local.listen(0,'127.0.0.1',r));
  t.after(async()=>{remote.close();dot.close();for(const server of [local,cloud]){server.closeAllConnections();await new Promise(r=>server.close(r));}fs.rmSync(dir,{recursive:true,force:true});});
  const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  const get=async(server,route)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/dot/${route}`,{headers,signal:AbortSignal.timeout(2000)});assert.equal(r.status,200);return r.json();};
  const clientId=randomUUID(),snapshot={threadId:DEFAULT_DOT,url:`https://chatgpt.com/dots/${DEFAULT_DOT}`,ready:true,canSend:true,busy:false,messages:[]};
  dot.exchange({clientId,snapshot});remote.connect();
  let state=await get(local,'state');while(!state.connected)state=await get(local,'state?after='+state.revision);
  const wake=await get(cloud,'wake');
  const waitingCommand=get(cloud,'wake?after='+wake.revision);
  const stateChange=get(local,'state?after='+state.revision);
  const id=randomUUID(),start=performance.now();
  const response=await fetch(`http://127.0.0.1:${local.address().port}/dot/message`,{method:'POST',headers,body:JSON.stringify({threadId:DEFAULT_DOT,id,text:'notification test'})});
  assert.equal((await response.json()).state,'submitted');
  assert.notEqual((await waitingCommand).revision,wake.revision);
  assert.equal((await stateChange).canSend,false);
  const dispatch=dot.exchange({clientId,snapshot});assert.equal(dispatch.command.id,id);
  assert.equal(dot.exchange({clientId,snapshot}).command,undefined);
  state=await get(local,'state');
  const confirmation=get(local,'state?after='+state.revision);
  dot.exchange({clientId,snapshot:{...snapshot,messages:[{id:'new',role:'user',text:'notification test'}]},receipt:{id,state:'delivered',messageId:'new'}});
  state=await confirmation;while(!state.deliveredIds.includes(id))state=await get(local,'state?after='+state.revision);
  assert.ok(performance.now()-start<1000,'receipt should arrive before the former one-second poll');
  // A broker restart has a new epoch, so an old revision never hangs until timeout.
  assert.ok(state.revision);assert.equal(remote.hasMessage(id),true);
});
