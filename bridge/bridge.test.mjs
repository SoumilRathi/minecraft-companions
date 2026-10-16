import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Desktop, applyPatches, summarize } from './desktop.mjs';
import { makeServer } from './server.mjs';

test('reply marker advances only for completed final answers, not progress, failures or partial streams', () => {
  const final = (id, phase = 'final_answer') => ({type:'agentMessage',id,text:'answer',phase});
  const turns = [{status:'completed',items:[final('old')]}];
  const state = {turns};
  assert.equal(summarize(state).latestCompletedReplyId, 'old');
  turns.push({status:'inProgress',items:[final('progress','commentary'),final('streaming-final')]});
  assert.equal(summarize(state).latestCompletedReplyId, 'old');
  turns.at(-1).status = 'interrupted';
  assert.equal(summarize(state).latestCompletedReplyId, 'old');
  turns.at(-1).status = 'failed';
  assert.equal(summarize(state).latestCompletedReplyId, 'old');
  turns.at(-1).status = 'completed';
  assert.equal(summarize(state).latestCompletedReplyId, 'streaming-final');
  turns.push({status:'completed',items:[final('only-progress','commentary')]});
  assert.equal(summarize(state).latestCompletedReplyId, 'streaming-final');
  assert.equal(summarize({turns:[]}).latestCompletedReplyId, null);
});

test('canonical history exposes text and live status, excluding tool output and reasoning', () => {
  const turn = { params: { clientUserMessageId: 'message-id' }, status: 'inProgress', items: [
    { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Hello' }] },
    { type: 'reasoning', text: 'Hidden' }, { type: 'commandExecution', text: 'Secret output' },
    { type: 'agentMessage', id: 'a', text: 'Hi' },
  ] };
  const state = { title: 'Test', turns: [], turnHistory: { kind: 'canonical', history: {
    entitiesByKey: { a: turn }, islands: [{ entries: [{ value: 'a' }] }, { entries: [{ value: 'a' }] }],
  } } };
  const view = summarize(state);
  assert.deepEqual(view.messages.map(m => m.text), ['Hello', 'Hi']);
  assert.equal(view.busy, true); assert.deepEqual(view.deliveredIds, ['message-id']);
});

test('patches handle array insertion/deletion and reject prototype paths', () => {
  let state = { a: ['x', 'z'], busy: false };
  state = applyPatches(state, [
    { op: 'add', path: ['a', 1], value: 'y' },
    { op: 'remove', path: ['a', 0] },
    { op: 'replace', path: ['busy'], value: true },
  ]);
  assert.deepEqual(state, { a: ['y', 'z'], busy: true });
  assert.throws(() => applyPatches(state, [{ op: 'add', path: ['__proto__', 'polluted'], value: 1 }]));
  assert.equal({}.polluted, undefined);
});

test('desktop adapter follows the existing owner, handles split frames and gaps, forwards one user turn', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-ipc-'));
  const socketPath = path.join(dir, 'ipc.sock'), threadId = randomUUID();
  let requests = [], snapshots = 0;
  const fixture = { id: threadId, title: 'Fixture', turns: [], threadRuntimeStatus: { type: 'idle' } };
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    function send(message) {
      let body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      const frame = Buffer.concat([header, body]); socket.write(frame.subarray(0, 2)); socket.write(frame.subarray(2));
    }
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const n = buffer.readUInt32LE(), m = JSON.parse(buffer.subarray(4, n + 4)); buffer = buffer.subarray(n + 4);
        if (m.type === 'request') {
          requests.push(m);
          send({ type: 'response', requestId: m.requestId, method: m.method, resultType: 'success',
            handledByClientId: 'owner', result: m.method === 'initialize' ? { clientId: 'game' } : {} });
        } else if (m.method === 'thread-stream-following-changed' && m.params.following) {
          snapshots++;
          send({ type: 'broadcast', sourceClientId: 'owner', targetClientIds: ['game'], version: 11,
            method: 'thread-stream-state-changed', params: { conversationId: threadId, hostId: 'local',
              change: { type: 'snapshot', revision: snapshots, conversationState: fixture } } });
        }
      }
    });
  });
  server.listen(socketPath); await once(server, 'listening'); fs.chmodSync(socketPath, 0o600);
  const desktop = new Desktop(threadId, socketPath);
  t.after(() => { desktop.close(); for (const s of sockets) s.destroy(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await desktop.connect(); while(!desktop.ready)await once(desktop,'change');
  assert.equal(desktop.view().canSend, true);
  const id = randomUUID(); await desktop.send('From Minecraft', id);
  const sent = requests.at(-1);
  assert.equal(sent.method, 'thread-follower-start-turn'); assert.equal(sent.targetClientId, 'owner'); assert.equal(sent.version, 2);
  assert.equal(sent.params.turnStart.request.clientUserMessageId, id);
  assert.equal(sent.params.turnStart.context.inheritThreadSettings, true);
  assert.equal(requests.some(r => r.method.includes('resume')), false);
  const next = once(desktop, 'change');
  desktop.receive({ type: 'broadcast', sourceClientId: 'owner', version: 11, method: 'thread-stream-state-changed',
    params: { conversationId: threadId, hostId: 'local', change: { type: 'patches', baseRevision: 999, revision: 1000, patches: [] } } });
  assert.equal(desktop.ready, false); await next; assert.equal(snapshots, 2); assert.equal(desktop.ready, true);
});

async function httpFixture(t, send) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-http-'));
  const threadId = randomUUID(), token = 'test-token';
  const desktop = { threadId, view: () => ({ connected: true, canSend: true }), hasMessage: () => false, send };
  const options = { token, journalPath: path.join(dir, 'receipts.json') };
  const servers = [];
  async function start() {
    const server = makeServer(desktop, options); servers.push(server);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
  }
  t.after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } fs.rmSync(dir, { recursive: true, force: true }); });
  const url = await start();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const post = (body, target = url) => fetch(target + '/message', { method: 'POST', headers, body: JSON.stringify(body) });
  return { url, headers, post, start, threadId, options, desktop };
}

test('HTTP rejects unauthenticated/browser traffic and other chat IDs', async t => {
  let calls = 0; const f = await httpFixture(t, async () => calls++);
  assert.equal((await fetch(f.url + '/state')).status, 401);
  assert.equal((await fetch(f.url + '/state', { headers: { ...f.headers, Origin: 'https://example.com' } })).status, 403);
  const wrongHostStatus = await new Promise(resolve => {
    http.get(f.url + '/state', { headers: { ...f.headers, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(wrongHostStatus, 403);
  assert.equal((await f.post({ id: randomUUID(), threadId: randomUUID(), text: 'No' })).status, 400);
  assert.equal(calls, 0);
});

test('duplicate submissions and bridge restart do not send twice, even after an ambiguous failure', async t => {
  let calls = 0; const f = await httpFixture(t, async () => { calls++; throw Error('Connection lost after dispatch'); });
  const message = { id: randomUUID(), threadId: f.threadId, text: 'Hello' };
  const [a, b] = await Promise.all([f.post(message), f.post(message)]);
  assert.equal((await a.json()).state, 'unknown'); assert.equal((await b.json()).state, 'unknown'); assert.equal(calls, 1);
  const restarted = await f.start(); await f.post(message, restarted); assert.equal(calls, 1);
  assert.equal((await f.post({ ...message, text: 'Changed' })).status, 409);
  f.desktop.hasMessage = () => true;
  assert.equal((await (await f.post(message)).json()).state, 'delivered');
  assert.equal(fs.statSync(f.options.journalPath).mode & 0o777, 0o600);
});
