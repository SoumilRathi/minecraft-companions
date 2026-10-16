// Experimental adapter for the installed desktop app's owner/follower IPC.
// This is not a public API. Never create another app-server or take ownership.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { FrameReader } from './frame-reader.mjs';

const versions = { initialize: 0, 'thread-owner-discovery': 1, 'thread-follower-start-turn': 2 };
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
export function applyPatches(state, patches) {
  for (const { op, path: keys, value } of patches) {
    if (!Array.isArray(keys) || keys.some(k => forbidden.has(k))) throw Error('Invalid patch path');
    if (!['add', 'remove', 'replace'].includes(op)) throw Error('Unknown patch operation');
    if (!keys.length) { if (op !== 'replace') throw Error('Invalid root patch'); state = value; continue; }
    let target = state;
    for (const key of keys.slice(0, -1)) {
      if (!Object.hasOwn(target, key)) throw Error('Missing patch path');
      target = target[key];
    }
    const key = keys.at(-1);
    if (Array.isArray(target) && key !== 'length') {
      const i = Number(key);
      if (!Number.isInteger(i) || i < 0 || i > target.length) throw Error('Invalid array index');
      if (op === 'add') target.splice(i, 0, value);
      else if (op === 'remove') target.splice(i, 1);
      else target[i] = value;
    } else if (op === 'remove') delete target[key];
    else target[key] = value;
  }
  return state;
}

export function turnsOf(state) {
  const h = state?.turnHistory;
  if (h?.kind !== 'canonical') return state?.turns ?? [];
  const seen = new Set();
  return h.history.islands.flatMap(island => island.entries.flatMap(({ value }) => {
    if (seen.has(value)) return [];
    seen.add(value);
    return h.history.entitiesByKey[value] ? [h.history.entitiesByKey[value]] : [];
  }));
}

export function summarize(state) {
  const turns = turnsOf(state);
  const messages = [];
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      if (item.type === 'userMessage') {
        const text = (item.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
        if (text) messages.push({ id: item.id, role: 'You', text, ...(turn.params?.clientUserMessageId?{deliveryId:turn.params.clientUserMessageId}:{}) });
      } else if (item.type === 'agentMessage' && item.text) {
        messages.push({ id: item.id, role: 'Codex', text: item.text });
      }
    }
  }
  const busy = state?.threadRuntimeStatus?.type === 'active' || turns.at(-1)?.status === 'inProgress';
  const needsAttention = (state?.requests?.length ?? 0) > 0;
  // A streamed paragraph is not a completed reply. Only successful completed
  // turns with an actual final answer advance the companion's unread marker.
  const completed = turns.flatMap(turn => turn.status === 'completed'
    ? (turn.items ?? []).filter(item => item.type === 'agentMessage' && item.text && item.phase === 'final_answer') : []);
  return {
    title: state?.title ?? 'Codex', busy, needsAttention,
    latestCompletedReplyId: completed.at(-1)?.id ?? null,
    messages: messages.slice(-60).map(m => ({ ...m, text: m.text.slice(-12000) })),
    deliveredIds: turns.map(t => t.params?.clientUserMessageId).filter(Boolean).slice(-100),
  };
}

export class Desktop extends EventEmitter {
  constructor(threadId, socketPath = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'ipc/ipc.sock'),
      { discoveryTimeoutMs = 12000, snapshotTimeoutMs = 45000, reconnectDelayMs = 500, getOwners = () => [],
        diagnostic = event => console.log('[Agentic connection] '+JSON.stringify(event)) } = {}) {
    super();
    this.threadId = threadId; this.socketPath = socketPath;
    this.pending = new Map(); this.state = null; this.ready = false;
    this.discoveryTimeoutMs=discoveryTimeoutMs; this.snapshotTimeoutMs=snapshotTimeoutMs;
    this.reconnectDelayMs=reconnectDelayMs; this.getOwners=getOwners; this.diagnostic=diagnostic; this.phase='connecting';
    this.status = 'Connecting to Codex desktop...';
  }
  report(event, reason) {
    // Never log transcripts, prompts, socket payloads, or credentials.
    this.diagnostic({at:new Date().toISOString(),threadId:this.threadId,event,
      elapsedMs:Date.now()-(this.startedAt??Date.now()),...(reason?{reason}: {})});
  }
  waitForSnapshot() {
    clearTimeout(this.snapshotTimer);
    const socket=this.socket;
    this.snapshotTimer=setTimeout(()=>{
      this.snapshotTimer=null;
      if (!this.ready && this.socket===socket) {this.report('retry','history-timeout');socket.destroy();}
    },this.snapshotTimeoutMs);
  }
  async connect() {
    if (this.closed) return;
    this.ready = false; this.owner = null; this.clientId = 'initializing-client';
    this.startedAt=Date.now(); this.phase=this.everConnected?'reconnecting':'connecting';
    this.status=this.everConnected?'Reconnecting to Codex desktop...':'Connecting to Codex desktop...';
    this.report('connecting');
    this.reader = new FrameReader(message=>this.receive(message));
    try {
      const stat = fs.statSync(this.socketPath);
      if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('Unsafe desktop socket permissions');
      this.socket = net.connect(this.socketPath);
      this.socket.on('data', data => this.read(data));
      this.socket.on('error', () => {});
      this.socket.once('close', () => this.disconnected());
      await new Promise((resolve, reject) => {
        this.socket.once('connect', resolve); this.socket.once('error', reject);
      });
      const init = await this.request('initialize', { clientType: 'agentic-minecraft' });
      this.clientId = init.result.clientId;
      await this.discover();
    } catch {
      if(this.closed)return;
      this.phase='reconnecting';this.status='Waiting for Codex desktop...';
      this.report('retry','connection-failed');this.emit('change');
      if(this.socket&&!this.socket.destroyed)this.socket.destroy();else this.scheduleReconnect();
    }
  }
  async discover() {
    if(this.closed||!this.socket||this.socket.destroyed||this.clientId==='initializing-client')return;
    if(this.discovering){this.discoveryRequested=true;return;}
    clearTimeout(this.discoveryTimer);this.discoveryTimer=null;this.discovering=true;
    try {
      let owner, unavailable=false;
      const targets=[...new Set([this.discoveredOwner,...this.getOwners()].filter(Boolean))];
      for(const target of targets) {
        try {owner=await this.request('thread-owner-discovery',{conversationId:this.threadId,hostId:'local'},target,Math.min(2000,this.discoveryTimeoutMs));break;}
        catch(error) {if(!['no-client-found','no-handler-for-request'].includes(error.message))throw error;unavailable=true;}
      }
      if(!owner) {try {owner=await this.request('thread-owner-discovery',{conversationId:this.threadId,hostId:'local'},undefined,this.discoveryTimeoutMs);}catch(error){throw unavailable?Error('no-client-found'):error;}}

      if(this.closed)return;
      this.owner=owner.handledByClientId;this.retryDelay=this.reconnectDelayMs;
      this.phase='loading';this.status='Loading conversation history...';this.report('loading-history');
      this.follow();this.waitForSnapshot();this.emit('change');
    } catch(error) {
      if(this.closed||this.socket?.destroyed)return;
      const noOwner=['no-client-found','no-handler-for-request'].includes(error.message);
      this.phase=noOwner?'needsDesktop':'connecting';
      this.status=noOwner?'Open this chat in Codex desktop to connect.':'Connecting to Codex desktop...';
      this.emit('change');
      this.discoveryTimer=setTimeout(()=>this.discover(),this.retryDelay??this.reconnectDelayMs);
      this.retryDelay=Math.min(5000,(this.retryDelay??this.reconnectDelayMs)*2);
    } finally {
      this.discovering=false;
      if(this.discoveryRequested&&!this.owner&&!this.closed) {
        this.discoveryRequested=false;clearTimeout(this.discoveryTimer);
        this.discoveryTimer=setTimeout(()=>this.discover(),0);
      } else this.discoveryRequested=false;
    }
  }
  scheduleReconnect() {
    if (!this.closed && !this.reconnectTimer) this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null; this.connect();
    }, this.reconnectDelayMs);
  }
  disconnected() {
    this.ready = false; this.owner = null;
    if (!this.closed && this.phase!=='needsDesktop') {
      this.phase='reconnecting'; this.status='Reconnecting to Codex desktop...'; this.report('disconnected');
    }
    clearTimeout(this.snapshotTimer);clearTimeout(this.discoveryTimer);
    this.snapshotTimer=null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('Desktop connection lost')); }
    this.pending.clear(); this.emit('change'); this.scheduleReconnect();
  }
  write(message) {
    if (!this.socket || this.socket.destroyed) throw Error('Desktop disconnected');
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }
  request(method, params, targetClientId, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(Error('Desktop response timed out')); }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, method });
      try { this.write({ type: 'request', requestId, sourceClientId: this.clientId,
        version: versions[method], method, params, targetClientId, timeoutMs: Math.max(1,timeoutMs-1000) }); }
      catch (e) { clearTimeout(timer); this.pending.delete(requestId); reject(e); }
    });
  }
  follow(following = true) {
    this.write({ type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: this.clientId,
      version: 1, targetClientIds: [this.owner], params: { conversationId: this.threadId, hostId: 'local', following } });
  }
  read(data) {
    try {
      this.reader.read(data);
    } catch { this.socket.destroy(); }
  }
  receive(m) {
    if (m.type === 'response') {
      const p = this.pending.get(m.requestId); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(m.requestId);
      if (m.resultType === 'success') p.resolve(m); else p.reject(Error(m.error ?? 'Desktop rejected request'));
    } else if (m.type === 'client-discovery-request') {
      this.write({ type: 'client-discovery-response', requestId: m.requestId, response: { canHandle: false } });
    } else if (m.type === 'request') {
      this.write({ type: 'response', requestId: m.requestId, resultType: 'error', error: 'no-handler-for-request' });
    } else if (m.type === 'broadcast') {
      if (m.targetClientIds && !m.targetClientIds.includes(this.clientId)) return;
      if(!this.owner&&m.method==='client-status-changed'&&m.params?.status==='connected'&&m.params.clientId!==this.clientId)void this.discover();
      if (m.method === 'client-status-changed' && m.params?.clientId === this.owner && m.params.status === 'disconnected') {
        this.socket.destroy(); return;
      }
      if (m.params?.conversationId !== this.threadId || m.params.hostId !== 'local') return;
      if (m.method === 'thread-stream-following-status-requested') {
        if(m.sourceClientId===this.owner)this.follow();else if(!this.owner) {
          this.discoveredOwner=m.sourceClientId;
          // The app announces that this chat has loaded. Stop waiting for an
          // older discovery attempt; attach directly to its new owner now.
          for(const [id,p] of this.pending)if(p.method==='thread-owner-discovery') {
            clearTimeout(p.timer);this.pending.delete(id);p.reject(Error('Chat owner became available'));
          }
          void this.discover();
        }
      }
      if (m.method !== 'thread-stream-state-changed' || m.sourceClientId !== this.owner) return;
      if (m.version !== 11) { this.phase='error'; this.status = 'This Codex version needs a newer Minecraft Companions release.'; this.report('protocol-error'); this.close(); return; }
      const c = m.params.change;
      if (c.type === 'snapshot') {
        if (c.conversationState?.id !== this.threadId) throw Error('Wrong thread snapshot');
        this.state = c.conversationState;
      } else if (c.type === 'patches') {
        if (!this.state || this.revision !== c.baseRevision) { this.resync(); return; }
        try { this.state = applyPatches(this.state, c.patches); }
        catch { this.state = null;this.summary=null; this.resync(); return; }
      } else throw Error('Unknown state change');
      this.revision = c.revision;
      this.summary=null;
      const wasReady=this.ready;
      // A desktop owner can publish metadata before loading its history.
      this.ready=!['needs_resume','resuming'].includes(this.state?.resumeState);
      if(this.ready) {
        clearTimeout(this.snapshotTimer); this.snapshotTimer=null; this.phase='ready'; this.status='Connected to the same desktop chat';
        this.everConnected=true; if(!wasReady)this.report('ready');
      } else if(this.state?.resumeState==='needs_resume') {
        clearTimeout(this.snapshotTimer); this.snapshotTimer=null; this.phase='needsDesktop';
        this.status='Open this chat in Codex desktop to connect.';
      } else {
        this.phase='loading'; this.status='Loading conversation history...';
        if(!this.snapshotTimer)this.waitForSnapshot();
      }
      this.emit('change');
    }
  }
  resync() {
    this.ready=false; this.phase='loading'; this.status='Refreshing conversation history...';
    this.report('resync'); this.follow(); this.waitForSnapshot();
  }
  hasMessage(id) {
    return turnsOf(this.state).some(t => t.params?.clientUserMessageId === id ||
      t.items?.some(i => i.type === 'userMessage' && (i.clientId === id || i.id === id)));
  }
  view() {
    const summary = this.summary ??= summarize(this.state);
    return { ...summary, revision: this.revision ?? -1, threadId: this.threadId, connected: this.ready, connectionPhase:this.phase,
      canSend: this.ready && !summary.busy && !summary.needsAttention,
      status: !this.ready ? this.status : summary.needsAttention ? 'Action needed in Codex desktop' : summary.busy ? 'Codex is working...' : this.status };
  }
  async send(text, id) {
    if (!this.view().canSend) throw Error('Wait for Codex to finish, or check the desktop app.');
    return this.request('thread-follower-start-turn', {
      conversationId: this.threadId,
      turnStart: { request: { threadId: this.threadId, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: id },
        context: { inheritThreadSettings: true } },
    }, this.owner);
  }
  close() {
    this.closed = true; this.ready = false;
    clearTimeout(this.reconnectTimer); clearTimeout(this.snapshotTimer);clearTimeout(this.discoveryTimer);
    if (this.owner && this.socket && !this.socket.destroyed) { try { this.follow(false); } catch {} }
    this.socket?.destroy();
  }
}
