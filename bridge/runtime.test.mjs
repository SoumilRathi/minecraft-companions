import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { startBridge, bridgePort } from './runtime.mjs';
import { Desktop } from './desktop.mjs';

const waitFor = async (predicate, timeout = 6000) => {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw Error('Timed out waiting for test state');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-runtime-'));
  const minecraft = path.join(root, 'minecraft'); fs.mkdirSync(minecraft);
  const threadId = randomUUID(); let connects = 0, closes = 0, sends = 0;
  const desktop = () => ({ threadId, connect() { connects++; }, close() { closes++; },
    view: () => ({ connected: true, canSend: true, messages: [] }), hasMessage: () => false,
    async send() { sends++; throw Error('Connection lost after dispatch'); } });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, minecraft, threadId, desktop, counts: () => ({connects,closes,sends}) };
}
async function state(configFile) {
  const config = JSON.parse(fs.readFileSync(configFile));
  return { config, response: await fetch(config.url + '/state', {headers:{Authorization:`Bearer ${config.token}`}}) };
}

test('simultaneous starters share one bridge; restart keeps receipts and rotates authentication', async t => {
  const f = fixture(t), options = {...f, idleTimeoutMs:0};
  const runs = await Promise.all([startBridge({...options,desktop:f.desktop()}), startBridge({...options,desktop:f.desktop()})]);
  const running = runs.find(r => !r.reused);
  t.after(() => running.close());
  assert.equal(runs.filter(r => r.reused).length, 1);
  assert.equal(f.counts().connects, 1);
  const {config:old,response} = await state(running.configFile);
  assert.equal(response.status,200); assert.equal((await response.json()).threadId,f.threadId);
  const message = {id:randomUUID(),text:'A message with uncertain delivery',threadId:f.threadId};
  const post = config => fetch(config.url+'/message',{method:'POST',headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'},body:JSON.stringify(message)});
  assert.equal((await (await post(old)).json()).state,'unknown');
  await running.close();
  const restarted = await startBridge({...options,desktop:f.desktop()}); t.after(() => restarted.close());
  const {config:fresh} = await state(restarted.configFile);
  assert.notEqual(fresh.token,old.token);
  assert.equal((await fetch(fresh.url+'/state',{headers:{Authorization:`Bearer ${old.token}`}})).status,401);
  assert.equal((await (await post(fresh)).json()).state,'unknown');
  assert.equal(f.counts().sends,1);
  assert.equal(fs.statSync(restarted.journalPath).mode & 0o777,0o600);
});

test('old receipts migrate once and an existing bridge for another chat is not replaced', async t => {
  const f=fixture(t); fs.mkdirSync(path.join(f.root,'.local'));
  const legacy={ old: {hash:'fixture',state:'unknown'} };
  fs.writeFileSync(path.join(f.root,'.local/receipts.json'),JSON.stringify(legacy));
  const running=await startBridge({...f,desktop:f.desktop(),idleTimeoutMs:0}); t.after(()=>running.close());
  assert.deepEqual(JSON.parse(fs.readFileSync(running.journalPath)),legacy);
  const before=fs.readFileSync(running.configFile,'utf8');
  await assert.rejects(startBridge({...f,threadId:randomUUID(),desktop:f.desktop()}),/another chat/);
  assert.equal(fs.readFileSync(running.configFile,'utf8'),before);
});

test('bridge stops after the game stops polling, releases its port, and starts again', async t => {
  const f=fixture(t);
  const running=await startBridge({...f,desktop:f.desktop(),idleTimeoutMs:180}); t.after(()=>running.close());
  await state(running.configFile);
  await waitFor(()=>!running.server.listening);
  const restarted=await startBridge({...f,desktop:f.desktop(),idleTimeoutMs:0}); t.after(()=>restarted.close());
  assert.equal(restarted.reused,false);
  assert.equal((await state(restarted.configFile)).response.status,200);
});

test('an unrelated port owner does not get killed or have its configuration overwritten', async t => {
  const f=fixture(t), occupied=net.createServer(socket=>socket.end());
  occupied.listen(bridgePort(f.minecraft),'127.0.0.1'); await once(occupied,'listening');
  t.after(()=>occupied.close());
  await assert.rejects(startBridge({...f,desktop:f.desktop()}),/occupied/);
  assert.equal(occupied.listening,true);
  assert.equal(fs.existsSync(path.join(f.minecraft,'config/agentic-companion-bridge.json')),false);
});

test('selected chat survives a runtime restart and the old launcher default reuses it',async t=>{
  const f=fixture(t),second=randomUUID();
  const sessionOptions={catalog:{get:async id=>({id,title:id,project:'Fixture',cwd:'/fixture'})},create:id=>({
    connect(){},close(){},view:()=>({connected:true,canSend:true,title:id,messages:[]}),hasMessage:()=>false,
  })};
  const options={root:f.root,minecraft:f.minecraft,threadId:f.threadId,sessionOptions,idleTimeoutMs:0};
  const first=await startBridge(options);t.after(()=>first.close());
  const {config}=await state(first.configFile);
  const response=await fetch(config.url+'/session',{method:'POST',headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'},
    body:JSON.stringify({threadId:second,expectedThreadId:f.threadId})});
  assert.equal(response.status,200);assert.equal((await response.json()).threadId,second);
  assert.equal((await startBridge(options)).reused,true);
  await first.close();
  const next=await startBridge(options);t.after(()=>next.close());
  assert.equal((await (await state(next.configFile)).response.json()).threadId,second);
});

test('desktop app restart discovers its new owner and restores the same history without sending a turn', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agentic-reconnect-')), socketPath=path.join(dir,'ipc.sock'), threadId=randomUUID();
  const sockets=new Set(), requests=[];
  let generation=0;
  const fixture={id:threadId,title:'Same conversation',turns:[{status:'completed',params:{clientUserMessageId:'delivered'},items:[
    {type:'userMessage',id:'u',content:[{type:'text',text:'Earlier question'}]},
    {type:'agentMessage',id:'a',text:'Earlier answer',phase:'final_answer'},
  ]}]};
  async function host() {
    const owner=`owner-${++generation}`;
    const server=net.createServer(socket=>{
      sockets.add(socket); socket.on('close',()=>sockets.delete(socket)); let buffer=Buffer.alloc(0);
      const send=message=>{const data=Buffer.from(JSON.stringify(message)),header=Buffer.alloc(4);header.writeUInt32LE(data.length);socket.write(Buffer.concat([header,data]));};
      socket.on('data',data=>{
        buffer=Buffer.concat([buffer,data]);
        while(buffer.length>=4 && buffer.length>=buffer.readUInt32LE()+4) {
          const n=buffer.readUInt32LE(),m=JSON.parse(buffer.subarray(4,n+4));buffer=buffer.subarray(n+4);
          if(m.type==='request') {requests.push(m.method);send({type:'response',requestId:m.requestId,resultType:'success',handledByClientId:owner,result:m.method==='initialize'?{clientId:'game'}:{}});}
          if(m.method==='thread-stream-following-changed'&&m.params.following) send({type:'broadcast',sourceClientId:owner,targetClientIds:['game'],version:11,
            method:'thread-stream-state-changed',params:{conversationId:threadId,hostId:'local',change:{type:'snapshot',revision:generation,conversationState:fixture}}});
        }
      });
    });
    server.listen(socketPath); await once(server,'listening');fs.chmodSync(socketPath,0o600);return server;
  }
  let server=await host();const desktop=new Desktop(threadId,socketPath);
  t.after(()=>{desktop.close();for(const s of sockets)s.destroy();server.close();fs.rmSync(dir,{recursive:true,force:true});});
  await desktop.connect();await waitFor(()=>desktop.ready);
  const original=desktop.view().messages;assert.equal(desktop.owner,'owner-1');
  for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));
  await waitFor(()=>!desktop.ready);
  server=await host();await waitFor(()=>desktop.ready);
  assert.equal(desktop.owner,'owner-2');assert.deepEqual(desktop.view().messages,original);
  assert.equal(desktop.hasMessage('delivered'),true);
  assert.equal(requests.filter(r=>r==='thread-owner-discovery').length,2);
  assert.equal(requests.some(r=>r.includes('start-turn')||r.includes('resume')),false);
});

async function loadingHost(t,onFollow,{ownerAvailable=()=>true,...options}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agentic-loading-')),socketPath=path.join(dir,'ipc.sock'),threadId=randomUUID();
  const sockets=new Set(),requests=[],events=[];let follows=0;
  const snapshot=(send,resumeState='resumed',revision=1)=>send({type:'broadcast',sourceClientId:'owner',version:11,
    method:'thread-stream-state-changed',params:{conversationId:threadId,hostId:'local',change:{type:'snapshot',revision,
      conversationState:{id:threadId,title:'Older conversation',resumeState,turns:resumeState==='resumed'?[{status:'completed',items:[
        {id:'old-answer',type:'agentMessage',text:'Historical answer',phase:'final_answer'},
      ]}]:[]}}}});
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer=Buffer.alloc(0);
    const send=m=>{if(socket.destroyed)return;const body=Buffer.from(JSON.stringify(m)),header=Buffer.alloc(4);header.writeUInt32LE(body.length);socket.write(Buffer.concat([header,body]));};
    socket.on('data',data=>{
      buffer=Buffer.concat([buffer,data]);
      while(buffer.length>=4&&buffer.length>=buffer.readUInt32LE()+4) {
        const n=buffer.readUInt32LE(),m=JSON.parse(buffer.subarray(4,n+4));buffer=buffer.subarray(n+4);
        if(m.type==='request') {
          requests.push(m.method);
          if(m.method==='thread-owner-discovery'&&!ownerAvailable())send({type:'response',requestId:m.requestId,resultType:'error',error:'no-client-found'});
          else send({type:'response',requestId:m.requestId,resultType:'success',handledByClientId:'owner',result:m.method==='initialize'?{clientId:'game'}:{}});
        }
        if(m.method==='thread-stream-following-changed'&&m.params.following)onFollow({send,snapshot:(state,revision)=>snapshot(send,state,revision),number:++follows,threadId});
      }
    });
  });
  server.listen(socketPath);await once(server,'listening');fs.chmodSync(socketPath,0o600);
  const desktop=new Desktop(threadId,socketPath,{diagnostic:e=>events.push(e),...options});
  t.after(()=>{desktop.close();for(const s of sockets)s.destroy();server.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {desktop,requests,events,follows:()=>follows};
}

test('history arriving after the old eight-second cutoff loads without switching or reopening',async t=>{
  const f=await loadingHost(t,({snapshot})=>{setTimeout(()=>snapshot(),8250).unref();});
  await f.desktop.connect();assert.equal(f.desktop.view().connectionPhase,'loading');assert.equal(f.desktop.view().canSend,false);
  await waitFor(()=>f.desktop.ready,10000);
  assert.equal(f.desktop.view().messages[0].text,'Historical answer');assert.equal(f.follows(),1);
  assert.equal(f.events.some(e=>e.event==='disconnected'),false);
  assert.deepEqual(f.requests,['initialize','thread-owner-discovery']);
  assert.equal(JSON.stringify(f.events).includes('Historical answer'),false);
});

test('metadata during history loading stays non-sendable and updates automatically when ready',async t=>{
  let finish;
  const f=await loadingHost(t,({snapshot,send,threadId})=>{
    snapshot('resuming');
    finish=()=>send({type:'broadcast',sourceClientId:'owner',version:11,method:'thread-stream-state-changed',
      params:{conversationId:threadId,hostId:'local',change:{type:'patches',baseRevision:1,revision:2,patches:[
        {op:'replace',path:['resumeState'],value:'resumed'},
        {op:'replace',path:['turns'],value:[{status:'completed',items:[{type:'agentMessage',id:'a',text:'Loaded history'}]}]},
      ]}}});
  });
  await f.desktop.connect();await waitFor(()=>!!finish&&f.desktop.revision===1);
  assert.equal(f.desktop.view().connectionPhase,'loading');assert.equal(f.desktop.view().canSend,false);
  finish();await waitFor(()=>f.desktop.ready);
  assert.equal(f.desktop.view().messages[0].text,'Loaded history');assert.equal(f.follows(),1);
});

test('a stalled history retries automatically and an unavailable owner has a distinct state',async t=>{
  let available=false;
  const f=await loadingHost(t,({number,snapshot})=>{if(number>1)snapshot();},
    {ownerAvailable:()=>available,snapshotTimeoutMs:60,reconnectDelayMs:20});
  await f.desktop.connect();await waitFor(()=>f.desktop.view().connectionPhase==='needsDesktop');
  assert.match(f.desktop.view().status,/Open this chat in Codex desktop/);
  available=true;await waitFor(()=>f.desktop.ready);
  assert.equal(f.follows(),2);assert.equal(f.events.some(e=>e.reason==='history-timeout'),true);
  assert.equal(f.requests.some(m=>m.includes('start-turn')||m.includes('resume')),false);
});

test('Dot-only startup needs no Codex chat and setup can stop its connection',async t=>{
  const f=fixture(t),dotId=randomUUID();
  const runtime=await startBridge({root:f.root,minecraft:f.minecraft,enabledProviders:['dot'],dotConfig:{id:dotId,name:'Example'},idleTimeoutMs:0});
  t.after(()=>runtime.close());
  const {config}=await state(runtime.configFile),headers={Authorization:`Bearer ${config.token}`};
  const dot=await(await fetch(config.url+'/dot/state',{headers})).json();
  assert.equal(dot.threadId,dotId);assert.equal(dot.title,'Example');
  assert.equal((await fetch(config.url+'/claude/state',{headers})).status,404);
  assert.equal((await startBridge({root:f.root,minecraft:f.minecraft,enabledProviders:['dot'],dotConfig:{id:dotId}})).reused,true);
  assert.equal((await fetch(config.url+'/shutdown',{method:'POST',headers})).status,200);
  await waitFor(()=>!runtime.server.listening);
});
