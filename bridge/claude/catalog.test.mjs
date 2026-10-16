import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {listDesktopSessions,liveSessions,readTranscript} from './catalog.mjs';
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agentic-claude-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}

test('desktop catalogue respects archive state and conversation activity rather than focus time',async t=>{
  const dir=await temp(t);const add=async(activity,focused,isArchived=false)=>{
    const id='local_'+randomUUID();await fs.writeFile(path.join(dir,id+'.json'),JSON.stringify({sessionId:id,cliSessionId:randomUUID(),cwd:'/project',title:String(activity),lastActivityAt:activity,lastFocusedAt:focused,isArchived}));return id;
  };
  const a=await add(10,100),b=await add(20,20);await add(30,30,true);
  assert.deepEqual((await listDesktopSessions(dir)).map(s=>s.id),[b,a]);
});

test('transcript follows the current branch through attachments and excludes tools, reasoning and metadata',async t=>{
  const dir=await temp(t),file=path.join(dir,'transcript.jsonl');
  const row=(uuid,parentUuid,type,content,extra={})=>({uuid,parentUuid,type,message:{content},...extra});
  const rows=[row('u',null,'user','Question'),row('discarded','u','assistant',[{type:'text',text:'Old branch'}]),
    row('meta','u','user','Hidden context',{isMeta:true}),row('attachment','meta','attachment',[]),
    row('a','attachment','assistant',[{type:'thinking',thinking:'Private reasoning'},{type:'tool_use',name:'Bash'},{type:'text',text:'Answer'}]),
    row('stop','a','system',[]),row('side','a','assistant',[{type:'text',text:'Side chain'}],{isSidechain:true})];
  await fs.writeFile(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n{"partial":');
  const result=await readTranscript(file);
  assert.deepEqual(result.messages.map(m=>m.text),['Question','Answer']);
});

test('live discovery checks the runtime and private socket without reading inbox credentials',async t=>{
  const root=await temp(t),dir=path.join(root,'sessions'),socketPath=path.join(root,'inbox.sock'),cliSessionId=randomUUID();
  await fs.mkdir(dir,{mode:0o700});
  const server=net.createServer(socket=>socket.end());
  server.listen(socketPath);await once(server,'listening');await fs.chmod(socketPath,0o600);t.after(()=>server.close());
  await fs.writeFile(path.join(dir,process.pid+'.json'),JSON.stringify({pid:process.pid,sessionId:cliSessionId,messagingSocketPath:socketPath}));
  assert.equal((await liveSessions(root))[0].cliSessionId,cliSessionId);
  await fs.chmod(socketPath,0o666);assert.deepEqual(await liveSessions(root),[]);
});

test('catalogue follows the newest remote ID and retains explicit enablement state',async t=>{
  const dir=await temp(t),id='local_'+randomUUID();
  await fs.writeFile(path.join(dir,id+'.json'),JSON.stringify({sessionId:id,cliSessionId:randomUUID(),cwd:'/test',
    bridgeSessionIds:['session_old','session_latest'],remoteControlUserEnabled:true,remoteControlAutoEligible:false}));
  const [session]=await listDesktopSessions(dir);
  assert.equal(session.remoteSessionId,'cse_latest');assert.equal(session.remoteControlUserEnabled,true);
});
