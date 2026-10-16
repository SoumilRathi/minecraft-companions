import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const DEFAULT_DOT='11111111-1111-4111-8111-111111111111';

test('broker shutdown closes held notification connections without waiting for timeout',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dot-shutdown-'));
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));
  const port=socket.address().port;await new Promise(r=>socket.close(r));
  const url=`http://127.0.0.1:${port}`,token='b'.repeat(64),file=path.join(dir,'config.json');
  fs.writeFileSync(file,JSON.stringify({url,token,threadId:DEFAULT_DOT}));
  const child=spawn(process.execPath,[new URL('./cloud.mjs',import.meta.url).pathname],{env:{...process.env,AGENTIC_DOT_CONFIG:file},stdio:['ignore','pipe','pipe']});
  t.after(()=>{child.kill('SIGKILL');fs.rmSync(dir,{recursive:true,force:true});});
  await once(child.stdout,'data');
  const headers={Authorization:`Bearer ${token}`},state=await (await fetch(url+'/dot/state',{headers})).json();
  const waiting=fetch(url+'/dot/state?after='+state.revision,{headers}).catch(()=>null);
  await new Promise(r=>setTimeout(r,20));
  const exited=once(child,'exit'),start=performance.now();child.kill('SIGTERM');
  const result=await Promise.race([exited,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Shutdown hung')),2000);timer.unref();})]);
  assert.equal(result[0],0);assert.ok(performance.now()-start<1000);await waiting;
});
