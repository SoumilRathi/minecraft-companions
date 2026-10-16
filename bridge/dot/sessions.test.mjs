import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DotSessions} from './sessions.mjs';
const DEFAULT_DOT='11111111-1111-4111-8111-111111111111';
import {makeServer} from '../server.mjs';
import {frame,decoder,exchange} from './native-host.mjs';
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dot-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let now=100000;const dot=new DotSessions({threadId:DEFAULT_DOT,configDir:dir,now:()=>now});const clientId=randomUUID();
  const snapshot={threadId:DEFAULT_DOT,url:`https://chatgpt.com/dots/${DEFAULT_DOT}`,ready:true,canSend:true,busy:false,messages:[]};
  const update=(patch={},receipt)=>dot.exchange({clientId,snapshot:{...snapshot,...patch},receipt});
  return {dir,dot,clientId,snapshot,update,advance:ms=>now+=ms};
}
test('Dot claims one browser, disconnects stale tabs, and keeps the correct room',t=>{
  const f=fixture(t);assert.equal(f.dot.view().canSend,false);f.update();assert.equal(f.dot.view().canSend,true);
  assert.match(f.dot.exchange({clientId:randomUUID(),snapshot:f.snapshot}).status,/Another/);
  assert.throws(()=>f.update({threadId:randomUUID()}),/Wrong Dot/);
  f.advance(11000);assert.equal(f.dot.view().connected,false);
});
test('commands dispatch once and only a new matching user message proves delivery',async t=>{
  const f=fixture(t),id=randomUUID();f.update({messages:[{id:'old',role:'user',text:'hello'}]});
  await f.dot.send('hello',id);assert.equal(f.update().command.id,id);assert.equal(f.update().command,undefined);
  assert.throws(()=>f.update({messages:[{id:'bad',role:'assistant',text:'hello'}]},{id,state:'delivered',messageId:'bad'}),/matching/);
  f.update({messages:[{id:'new',role:'user',text:'hello'}]},{id,state:'delivered',messageId:'new'});
  assert.equal(f.dot.hasMessage(id),true);
  const restarted=new DotSessions({threadId:DEFAULT_DOT,configDir:f.dir});assert.equal(restarted.hasMessage(id),true);
  assert.equal(restarted.exchange({clientId:randomUUID(),snapshot:f.snapshot}).command,undefined);
});
test('browser restart can acknowledge delivery without replaying an uncertain command',async t=>{
  const f=fixture(t),id=randomUUID();f.update();await f.dot.send('a',id);f.update();
  f.advance(11000);
  f.dot.exchange({clientId:randomUUID(),snapshot:{...f.snapshot,messages:[{id:'new',role:'user',text:'a'}]},receipt:{id,state:'delivered',messageId:'new'}});
  assert.equal(f.dot.hasMessage(id),true);
});
test('queued messages expire unsent and restarting never replays them',async t=>{
  const f=fixture(t),id=randomUUID();f.update();await f.dot.send('a',id);f.advance(11000);f.dot.refresh();assert.equal(f.dot.receipts[id].state,'notSent');
  f.update();await f.dot.send('a',randomUUID());
  const restarted=new DotSessions({threadId:DEFAULT_DOT,configDir:f.dir});assert.equal(restarted.exchange({clientId:randomUUID(),snapshot:f.snapshot}).command,undefined);
});
test('old identical user text cannot confirm a new delivery; busy browser drafts cannot send',async t=>{
  const f=fixture(t),id=randomUUID();f.update({messages:[{id:'old',role:'user',text:'same'}]});await f.dot.send('same',id);
  f.update({messages:[{id:'old',role:'user',text:'same'}]});
  assert.throws(()=>f.update({messages:[{id:'old',role:'user',text:'same'}]},{id,state:'delivered',messageId:'old'}),/matching/);
  f.update({canSend:false});await assert.rejects(f.dot.send('draft',randomUUID()),e=>e.delivery==='notSent');
});
test('native framing handles fragmented Unicode messages and rejects oversized input',()=>{
  const result=[],accept=decoder(x=>result.push(x));const data=Buffer.concat([frame({text:'🌲 नमस्ते'}),frame({ok:true})]);
  for(const byte of data)accept(Buffer.from([byte]));assert.deepEqual(result,[{text:'🌲 नमस्ते'},{ok:true}]);
  const bad=Buffer.alloc(4);bad.writeUInt32LE(4*1024*1024+1);assert.throws(()=>decoder(()=>{})(bad),/too large/);
});
test('HTTP/native exchange routes Dot separately and preserves idempotency and authentication',async t=>{
  const f=fixture(t),token='test-secret',codex={threadId:randomUUID(),view:()=>({connected:true}),hasMessage:()=>false};
  const server=makeServer(codex,{token,journalPath:path.join(f.dir,'journal.json'),providers:{dot:f.dot}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const url=`http://127.0.0.1:${server.address().port}`,headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  const configFile=path.join(f.dir,'connection.json');fs.writeFileSync(configFile,JSON.stringify({url,token}));
  await exchange(configFile,f.clientId,{snapshot:f.snapshot});
  const input={threadId:DEFAULT_DOT,id:randomUUID(),text:'hello'};
  const send=()=>fetch(url+'/dot/message',{method:'POST',headers,body:JSON.stringify(input)}).then(r=>r.json());
  assert.equal((await send()).state,'submitted');
  const command=(await exchange(configFile,f.clientId,{snapshot:f.snapshot})).command;assert.equal(command.text,'hello');
  assert.equal((await send()).state,'submitted');
  assert.equal((await exchange(configFile,f.clientId,{snapshot:f.snapshot})).command,undefined);
  await exchange(configFile,f.clientId,{snapshot:{...f.snapshot,messages:[{id:'new',role:'user',text:'hello'}]},receipt:{id:input.id,state:'delivered',messageId:'new'}});
  assert.equal((await send()).state,'delivered');
  assert.equal((await fetch(url+'/dot/browser',{method:'POST',headers:{...headers,Origin:'https://chatgpt.com'},body:'{}'})).status,403);
  assert.equal((await fetch(url+'/dot/browser',{method:'POST',body:'{}'})).status,401);
  assert.equal((await (await fetch(url+'/state',{headers})).json()).threadId,codex.threadId);
});

test('native helper runs independently, frames replies and polls the browser without page timers',async t=>{
  const {spawn}=await import('node:child_process');const {createHash}=await import('node:crypto');
  const f=fixture(t),token='native-fixture',server=makeServer({threadId:randomUUID(),view:()=>({connected:true})},
    {token,journalPath:path.join(f.dir,'journal.json'),providers:{dot:f.dot}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const config=path.join(f.dir,'game/config');fs.mkdirSync(config,{recursive:true});
  fs.writeFileSync(path.join(config,'agentic-companion-bridge.json'),JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,token}));
  const manifest=JSON.parse(fs.readFileSync(new URL('../../browser/dot-extension/manifest.json',import.meta.url)));
  const id=createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
  const process=spawn(globalThis.process.execPath,[new URL('./native-host.mjs',import.meta.url).pathname,`chrome-extension://${id}/`],
    {env:{...globalThis.process.env,AGENTIC_DOT_CONFIG:path.join(config,'agentic-companion-bridge.json')},stdio:['pipe','pipe','pipe']});
  t.after(()=>process.kill());
  t.after(()=>server.closeAllConnections());let stderr='';process.stderr.on('data',b=>stderr+=b);
  const received=[];process.stdout.on('data',decoder(m=>received.push(m)));
  const wait=async predicate=>{const end=Date.now()+4000;while(!predicate()){if(Date.now()>end)throw Error(stderr||'Native host timeout');await new Promise(r=>setTimeout(r,15));}};
  process.stdin.write(frame({type:'exchange',requestId:'fixture',snapshot:f.snapshot}));
  await wait(()=>received.some(m=>m.requestId==='fixture'));assert.equal(received.find(m=>m.requestId==='fixture').threadId,DEFAULT_DOT);
  assert.equal(f.dot.view().connected,true);await wait(()=>received.some(m=>m.type==='poll'));
});

test('journal uses the shared author names and preserves completed replies while thinking',t=>{
  const f=fixture(t);f.update({busy:true,messages:[{id:'a',role:'assistant',text:'hello'}]});
  assert.equal(f.dot.view().latestCompletedReplyId,undefined);
  f.update({messages:[{id:'a',role:'assistant',text:'hello'},{id:'b',role:'user',text:'hi'}]});
  assert.deepEqual(f.dot.view().messages.map(m=>m.role),['Dot','You']);
  f.update({busy:true,messages:[{id:'c',role:'assistant',text:'partial'}]});
  assert.equal(f.dot.view().latestCompletedReplyId,'a');
});

test('broker follows message identity even when the page trims the submitted text',async t=>{
  const f=fixture(t),id=randomUUID();f.update();await f.dot.send('A message.  ',id);f.update();
  f.update({messages:[{id:'temporary',role:'user',text:'A message.'}]},{id,state:'observed',messageId:'temporary'});
  assert.equal(f.dot.view().messages[0].deliveryId,id);assert.equal(f.dot.hasMessage(id),false);
  f.update({messages:[{id:'saved',role:'user',text:'A message.'}]},{id,state:'delivered',messageId:'saved'});
  assert.equal(f.dot.hasMessage(id),true);assert.equal(f.dot.view().messages[0].deliveryId,id);
});
