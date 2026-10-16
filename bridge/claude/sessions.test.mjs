import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ClaudeSessions} from './sessions.mjs';
import {makeServer} from '../server.mjs';
import {readTranscript} from './catalog.mjs';

test('Claude uses the shared HTTP interface without changing Codex, persists receipts and detects completed replies',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agentic-providers-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const id=randomUUID(),cliSessionId=randomUUID(),other=randomUUID(),file=path.join(dir,'chat.jsonl');
  const rows=[{type:'user',uuid:'initial',parentUuid:null,message:{content:'Hello'}},
    {type:'assistant',uuid:'first',parentUuid:'initial',message:{content:[{type:'text',text:'Hi'}]}},
    {type:'system',subtype:'stop_hook_summary',uuid:'stop',parentUuid:'first'}];
  const write=()=>fs.writeFile(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');await write();
  let sends=0,running=true;
  const options={configDir:dir,profile:'fixture',threadId:id,
    catalog:async()=>[{id:'local_'+id,cliSessionId,title:'Test',cwd:'/test',activityAt:2},
      {id:'local_'+other,cliSessionId:other,title:'Other',cwd:'/other',activityAt:1}],
    live:async()=>running?[{cliSessionId}]:[],transcript:async()=>file,
    connection:{state:()=>({connected:running,connectionPhase:'ready',status:'Connected'})},
    send:async input=>{sends++;assert.equal(input.cliSessionId,cliSessionId);
      // A crash after submission must still preserve the exact user draft.
      const receipts=JSON.parse(await fs.readFile(path.join(dir,'agentic-claude-messages.json'),'utf8'));
      assert.equal(receipts[input.id].text,input.text);
      rows.push({type:'user',uuid:input.id,parentUuid:'stop',origin:{kind:'human'},message:{content:[{type:'text',text:input.text}]} });await write();}};
  const claude=new ClaudeSessions(options);await claude.refresh(true);
  assert.equal(claude.view().latestCompletedReplyId,'first');assert.equal(claude.view().busy,false);
  const codex={threadId:randomUUID(),view:()=>({connected:true,canSend:true,messages:[]}),hasMessage:()=>false,
    send:()=>{throw Error('Claude message routed to Codex');}};
  const server=makeServer(codex,{token:'fixture',journalPath:path.join(dir,'receipts.json'),providers:{claude}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const request=async(route,body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{
    method:body?'POST':'GET',headers:{Authorization:'Bearer fixture','Content-Type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{})});return response.json();};
  assert.equal((await request('/state')).threadId,codex.threadId);
  assert.equal((await request('/claude/state')).threadId,id);
  const message={threadId:id,id:randomUUID(),text:'From Minecraft'};
  await request('/claude/message',message);await request('/claude/message',message);assert.equal(sends,1);
  assert.equal(claude.view().busy,true);assert.equal(claude.view().canSend,false);
  assert.equal(claude.view().messages.at(-1).text,'From Minecraft');
  rows.push({type:'assistant',uuid:'reply',parentUuid:message.id,message:{content:[{type:'thinking',thinking:'hidden'},{type:'text',text:'Response'}]}},
    {type:'system',uuid:'end',parentUuid:'reply',subtype:'stop_hook_summary'});await write();await claude.refresh(true);
  assert.equal(claude.view().latestCompletedReplyId,'reply');assert.equal(claude.view().busy,false);
  const restarted=new ClaudeSessions(options);await restarted.refresh(true);
  assert.equal(restarted.hasMessage(message.id),true);assert.equal(restarted.view().messages.at(-2).text,message.text);
  await assert.rejects(restarted.send(message.text,message.id),/already submitted/);assert.equal(sends,1);
  const switched=await request('/claude/session',{threadId:other,expectedThreadId:id});assert.equal(switched.threadId,other);
  assert.equal((await request('/state')).threadId,codex.threadId);
  running=false;await restarted.refresh(true);assert.equal(restarted.view().canSend,false);
  claude.close();restarted.close();
});

test('only matching recorded peer messages become user bubbles, partial replies do not mark completion',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agentic-claude-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'chat.jsonl');
  const rows=[{uuid:'u',parentUuid:null,type:'user',isMeta:true,message:{content:'Peer wrapper'}},
    {uuid:'internal',parentUuid:'u',type:'user',isMeta:true,message:{content:'Hidden context'}},
    {uuid:'a',parentUuid:'internal',type:'assistant',message:{content:[{type:'text',text:'Partial'}]}}];
  await fs.writeFile(file,rows.map(JSON.stringify).join('\n'));
  const state=await readTranscript(file,{receipts:{u:{text:'Actual draft'}}});
  assert.deepEqual(state.messages.map(m=>m.text),['Actual draft','Partial']);
  assert.equal(state.busy,true);assert.equal(state.latestCompletedReplyId,'');
});

test('Desktop connection state preserves readable history and disables sending',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agentic-claude-state-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const id=randomUUID();let enabled=false;
  const claude=new ClaudeSessions({configDir:dir,profile:'test',threadId:id,
    catalog:async()=>[{id:'local_'+id,cliSessionId:id,title:'Test'}],live:async()=>[{cliSessionId:id}],
    transcript:async()=>'',read:async()=>({messages:[{text:'Existing reply'}],busy:false,deliveredIds:[]}),
    connection:{state:()=>({connected:enabled,connectionPhase:enabled?'ready':'needsDesktop',status:'Open Claude to connect.'})}});
  await claude.refresh(true);
  assert.equal(claude.view().connectionPhase,'needsDesktop');assert.equal(claude.view().canSend,false);
  assert.equal(claude.view().messages[0].text,'Existing reply');
  enabled=true;await claude.refresh(true);assert.equal(claude.view().canSend,true);claude.close();
});

for(const delivery of ['notSent','unknown'])test(`HTTP delivery ${delivery} remains safe across a bridge restart`,async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agentic-claude-delivery-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const id=randomUUID();let sends=0,instance;
  const options={configDir:dir,profile:'test',threadId:id,
    catalog:async()=>[{id:'local_'+id,cliSessionId:id,title:'Test'}],live:async()=>[{cliSessionId:id}],
    transcript:async()=>'',read:async()=>({messages:[],busy:false,deliveredIds:[]}),
    connection:{state:()=>({connected:true,connectionPhase:'ready'})},
    send:async()=>{sends++;throw Object.assign(Error('Test rejection'),{delivery});}};
  const proxy={get threadId(){return instance.threadId;},refresh:()=>instance.refresh(),view:()=>instance.view(),
    hasMessage:id=>instance.hasMessage(id),send:(text,id)=>instance.send(text,id)};
  instance=new ClaudeSessions(options);await instance.refresh(true);
  const server=makeServer({}, {token:'test',journalPath:path.join(dir,'journal.json'),providers:{claude:proxy}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const message={threadId:id,id:randomUUID(),text:'Keep my draft'};
  const send=async()=>{
    const r=await fetch(`http://127.0.0.1:${server.address().port}/claude/message`,{method:'POST',
      headers:{Authorization:'Bearer test','Content-Type':'application/json'},body:JSON.stringify(message)});
    return r.json();
  };
  assert.equal((await send()).state,delivery);assert.equal(sends,1);
  instance.close();instance=new ClaudeSessions(options);await instance.refresh(true);
  assert.equal((await send()).state,delivery);
  assert.equal(sends,delivery==='notSent'?2:1);
  assert.equal(instance.receipts[message.id].text,message.text);instance.close();
});
