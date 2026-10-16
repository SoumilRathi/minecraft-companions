import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {FrameReader} from './frame-reader.mjs';
import {Catalog} from './catalog.mjs';
import {Sessions} from './sessions.mjs';

const frame=value=>{const body=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(4);header.writeUInt32LE(body.length);return Buffer.concat([header,body]);};
test('large histories survive split headers, multibyte text, coalesced frames, and byte-sized chunks',()=>{
  const values=[{text:'Hello 🌻'},{text:'x'.repeat(2*1024*1024)},[1,2,3]],out=[];
  const wire=Buffer.concat(values.map(frame)),reader=new FrameReader(value=>out.push(value));
  let at=0;for(const n of [1,1,1,1,3,2,19]){reader.read(wire.subarray(at,at+n));at+=n;}
  for(;at<wire.length;at+=8191)reader.read(wire.subarray(at,at+8191));
  assert.deepEqual(out,values);
  for(const size of [0,65*1024*1024]){const h=Buffer.alloc(4);h.writeUInt32LE(size);assert.throws(()=>new FrameReader(()=>{}).read(h));}
});

test('cached list and known selection return while slow refresh is pending, and survive restart and failure',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agentic-cache-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const cacheFile=path.join(dir,'catalog.json'),a={id:randomUUID(),name:'First',cwd:'/work',updatedAt:1};
  const original=new Catalog(async()=>({rows:[a],truncated:false}),{cacheFile});await original.refresh();
  let finish;const restored=new Catalog(()=>new Promise(resolve=>finish=resolve),{cacheFile});restored.updated=1;
  assert.equal((await restored.list()).sessions[0].title,'First');
  assert.equal((await restored.get(a.id)).id,a.id);assert.ok(restored.pending);
  finish({rows:[a,{id:randomUUID(),name:'New',cwd:'/other',updatedAt:2}],truncated:false});await restored.pending;
  assert.equal((await restored.list()).total,2);
  restored.read=async()=>{throw Error('App closed');};await restored.refresh(true).catch(()=>{});
  assert.equal((await restored.list()).total,2);assert.equal(fs.statSync(cacheFile).mode&0o777,0o600);
});

test('saved messages appear offline without allowing sends; prior chats reconnect before opening their windows',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agentic-history-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=randomUUID(),b=randomUUID(),ids=[a,b],clients=[];
  const catalog=()=>new Catalog(async()=>({rows:ids.map(id=>({id,name:id,updatedAt:1})),truncated:false}));
  const create=connected=>id=>{
    const d=new EventEmitter();clients.push(d);d.id=id;d.connect=()=>{};d.close=()=>{};
    d.view=()=>({connected,canSend:connected,title:id,messages:connected?[{id,role:'Codex',text:'Saved '+id}]:[]});return d;
  };
  const first=new Sessions(a,{configDir:dir,catalog:catalog(),create:create(true)});first.connect();await first.select(b);first.close();
  clients.length=0;
  const second=new Sessions(b,{configDir:dir,catalog:catalog(),create:create(false)});second.connect();t.after(()=>second.close());
  assert.equal(second.view().messages[0].text,'Saved '+b);assert.equal(second.view().canSend,false);
  assert.deepEqual(new Set(clients.map(c=>c.id)),new Set(ids));
  const revision=second.changes.revision;const changed=second.changes.wait(revision);clients[0].emit('change');
  assert.notEqual(await changed,revision);
});
