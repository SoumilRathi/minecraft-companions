import test from 'node:test';
import assert from 'node:assert/strict';
import {RemoteDotSessions} from './remote.mjs';
const DEFAULT_DOT='11111111-1111-4111-8111-111111111111';
const config={threadId:DEFAULT_DOT,host:'server.example.com',user:'ubuntu',identityFile:'/tmp/example-key',port:16180,token:'a'.repeat(64)};
test('cloud adapter retains history but disables sends after a connection loss',async()=>{
  let down=false;const calls=[];
  const remote=new RemoteDotSessions({config,request:async(url,options)=>{
    calls.push({url,options});if(down)throw Error('offline');
    return {ok:true,json:async()=>({provider:'dot',threadId:DEFAULT_DOT,connected:true,canSend:true,messages:[{id:'a',role:'Dot',text:'Hello'}],deliveredIds:['confirmed'],notSentIds:['expired']})};
  }});
  remote.ensureTunnel=async()=>{remote.localPort=45678;};
  await remote.refresh();assert.equal(remote.view().canSend,true);assert.equal(remote.hasMessage('confirmed'),true);
  assert.equal(remote.receipts.expired.state,'notSent');assert.equal(calls[0].options.headers.Host,'127.0.0.1:16180');
  down=true;remote.lastPoll=0;await remote.refresh();assert.equal(remote.view().canSend,false);assert.equal(remote.view().messages[0].text,'Hello');
  await assert.rejects(remote.send('hi','id'),e=>e.delivery==='notSent');remote.close();
});
test('cloud message timeouts are not retried; same delivery ID reaches the authoritative broker',async()=>{
  const calls=[];const remote=new RemoteDotSessions({config,request:async(url,options)=>{calls.push(JSON.parse(options.body));throw Error('timeout');}});
  remote.ensureTunnel=async()=>{remote.localPort=45678;};remote.state={connected:true,canSend:true,messages:[]};remote.lastSeen=Date.now();
  await assert.rejects(remote.send('message','stable-id'),/timeout/);
  assert.deepEqual(calls,[{threadId:DEFAULT_DOT,id:'stable-id',text:'message'}]);remote.close();
});
test('wrong remote conversations and malformed SSH configuration fail closed',async()=>{
  assert.throws(()=>new RemoteDotSessions({config:{...config,host:'-oProxyCommand=bad'}}),/Invalid/);
  const remote=new RemoteDotSessions({config,request:async()=>({ok:true,json:async()=>({provider:'dot',threadId:'wrong',messages:[],canSend:true})})});
  remote.ensureTunnel=async()=>{remote.localPort=45678;};await remote.refresh();assert.equal(remote.view().canSend,false);remote.close();
});

test('real HTTP transport keeps the destination Host through a forwarded port',async t=>{
  const http=await import('node:http');const {loopbackRequest}=await import('./remote.mjs');
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({host:req.headers.host}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await loopbackRequest(`http://127.0.0.1:${server.address().port}/dot/state`,{method:'GET',headers:{Host:'127.0.0.1:16180'},signal:AbortSignal.timeout(1000)});
  assert.equal((await response.json()).host,'127.0.0.1:16180');
});

test('a pushed delivery cannot be downgraded by a later submitted POST response',async()=>{
  const remote=new RemoteDotSessions({config});remote.state={connected:true,canSend:true,messages:[]};remote.lastSeen=Date.now();
  remote.call=async()=>{remote.receipts.id={state:'delivered'};return {state:'submitted'};};
  await remote.send('hello','id');assert.equal(remote.hasMessage('id'),true);remote.close();
});
