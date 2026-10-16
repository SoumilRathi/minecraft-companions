import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {ClaudeDesktopConnection,desktopRequest} from './desktop.mjs';
const install=createRequire(import.meta.url)('./desktop-host.cjs');
const id='local_11111111-1111-4111-8111-111111111111',meta={id:id.slice(6)};
async function fixture(t) {
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'companions-desktop-'));
  const socketPath=path.join(dir,'chat.sock');let warms=0,sends=0,rearms=0,quit,attention=false,dialog=false;
  const s={sessionId:id,backend:{kind:'local'},cliSessionId:randomUUID(),isRunning:false,query:null,messageBuffer:[]};
  const manager={sessions:new Map([[id,s]]),waitForSessionsLoaded:async()=>{},
    permissionBroker:{hasPendingFor:()=>attention},userDialogBroker:{hasPendingFor:()=>dialog},
    rearmCrashLoopGuard:target=>{assert.equal(target,id);rearms++;},
    warmSession:async()=>{warms++;await new Promise(r=>setImmediate(r));s.query={};},
    sendMessage:async(target,text,images,options)=>{
      sends++;assert.equal(target,id);assert.equal(images,undefined);assert.equal(options.initiator,'user');
      assert.equal(Object.hasOwn(options,'origin'),false);
      s.messageBuffer.push({type:'user',uuid:options.messageUuid,message:{content:text}});
      return {delivered:true};
    }};
  await install({manager,socketPath,fs,net,onQuit:fn=>quit=fn});
  const host=globalThis.__minecraftCompanionsClaude;
  t.after(async()=>{host.close();await fsp.rm(dir,{recursive:true,force:true});});
  return {s,manager,request:input=>desktopRequest(input,{socket:socketPath,timeout:2000}),
    calls:()=>({warms,sends,rearms}),quit:()=>quit(),socketPath,attention:value=>attention=value,dialog:value=>dialog=value};
}
test('prepare restores the same chat once without sending, and quit stops it',async t=>{
  const f=await fixture(t);
  const results=await Promise.all(Array.from({length:4},()=>f.request({action:'prepare',id})));
  assert.ok(results.every(r=>r.ok&&r.cliSessionId===f.s.cliSessionId));
  assert.deepEqual(f.calls(),{warms:1,sends:0,rearms:0});
  assert.equal(fs.statSync(f.socketPath).mode&0o777,0o600);
  f.s.query=null;f.manager.warmSession=async()=>f.quit();
  assert.equal((await f.request({action:'prepare',id})).reason,'desktop_closing');
});
test('direct sends use human input and repeat IDs never submit twice',async t=>{
  const f=await fixture(t),messageId=randomUUID();
  const input={action:'send',id,messageId,text:'Hello 🌸'};
  const results=await Promise.all([f.request(input),f.request(input)]);
  assert.ok(results.every(r=>r.ok&&r.delivery==='submitted'));
  assert.deepEqual(f.calls(),{warms:0,sends:1,rearms:1});
  assert.equal((await f.request({...input,text:'Different'})).reason,'message_id_conflict');
  assert.equal(f.s.messageBuffer[0].message.content,'Hello 🌸');
});
test('split UTF-8 socket input preserves the user text',async t=>{
  const f=await fixture(t),text='Hello 🌸';
  const data=Buffer.from(JSON.stringify({action:'send',id,messageId:randomUUID(),text})+'\n');
  const split=data.indexOf(Buffer.from('🌸'))+1;
  const result=await new Promise((resolve,reject)=>{
    const client=net.createConnection(f.socketPath);let response='';client.setEncoding('utf8');client.on('error',reject);
    client.on('connect',()=>{client.write(data.subarray(0,split));setImmediate(()=>client.write(data.subarray(split)));});
    client.on('data',chunk=>response+=chunk);client.on('end',()=>resolve(JSON.parse(response)));
  });
  assert.equal(result.ok,true);assert.equal(f.s.messageBuffer[0].message.content,text);
});
test('busy chats, approvals and user questions reject sends; errors retain their explanation',async t=>{
  const f=await fixture(t),send=()=>f.request({action:'send',id,messageId:randomUUID(),text:'Hello'});
  f.s.isRunning=true;assert.equal((await send()).delivery,'notSent');f.s.isRunning=false;
  f.attention(true);assert.equal((await send()).reason,'chat_busy');f.attention(false);
  f.dialog(true);assert.equal((await f.request({action:'status',id})).needsAttention,true);assert.equal((await send()).reason,'chat_busy');f.dialog(false);
  f.manager.sendMessage=async()=>{throw Error('Project folder is missing');};
  const result=await send();assert.equal(result.delivery,'unknown');assert.equal(result.message,'Project folder is missing');
});
test('concurrent different messages cannot both enter a chat',async t=>{
  const f=await fixture(t);let finish;
  f.manager.sendMessage=()=>new Promise(resolve=>finish=resolve);
  const first=f.request({action:'send',id,messageId:randomUUID(),text:'First'});
  while(!finish)await new Promise(r=>setImmediate(r));
  assert.equal((await f.request({action:'send',id,messageId:randomUUID(),text:'Second'})).reason,'chat_busy');
  finish({delivered:true});assert.equal((await first).ok,true);
});
test('background connection reinstalls once and never starts a closed app',async()=>{
  let ready=false,installs=0,now=0;
  const c=new ClaudeDesktopConnection({now:()=>now,request:async input=>{assert.equal(input.action,'prepare');if(!ready)throw Error('Old socket');return {ok:true,running:false};},
    install:async()=>{installs++;await new Promise(r=>setImmediate(r));ready=true;}});
  const result=await Promise.all([c.refresh(meta),c.refresh(meta),c.refresh({id:randomUUID()})]);
  assert.ok(result.every(r=>r.connected));assert.equal(installs,1);
  ready=false;now=10000;c.install=async()=>{installs++;throw Object.assign(Error('Closed'),{reason:'desktop_closed'});};
  assert.equal((await c.refresh(meta)).status,'Open Claude to connect.');
  assert.equal(installs,2);await c.refresh(meta);assert.equal(installs,2);c.close();
});
