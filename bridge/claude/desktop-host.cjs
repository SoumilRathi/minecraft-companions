// Loaded into Claude Desktop through its Developer menu. Only existing local
// Code chats can be inspected, warmed, or sent a user message through this socket.
module.exports = function install({manager, socketPath, fs, net, onQuit = () => {}}) {
  const protocol = 3;
  const previous = globalThis.__minecraftCompanionsClaude;
  if (previous?.socketPath === socketPath && previous.protocol === protocol && previous.server.listening)
    return {ok:true, protocol, pid:process.pid, reused:true};
  previous?.close();
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const warming = new Map(), sends = new Map(), sending = new Set();
  let closing = false;
  const describe = s => ({
    exists:true, query:!!s.query, running:!!s.isRunning,
    needsAttention:!!(manager.permissionBroker.hasPendingFor(s.sessionId) || manager.userDialogBroker.hasPendingFor(s.sessionId)),
    cliSessionId:s.cliSessionId ?? '', protocol,
  });
  async function handle(input) {
    if (closing) return {ok:false, reason:'desktop_closing', delivery:'notSent'};
    if (input?.action === 'hello') return {ok:true, protocol};
    if (!input || !['status','prepare','send'].includes(input.action) ||
        typeof input.id !== 'string' || !input.id.startsWith('local_') || !uuid.test(input.id.slice(6)))
      return {ok:false, reason:'invalid_request', delivery:'notSent'};
    await manager.waitForSessionsLoaded(20000);
    if (closing) return {ok:false, reason:'desktop_closing', delivery:'notSent'};
    const s = manager.sessions.get(input.id);
    if (!s || s.isArchived || s.prewarmHidden) return {ok:false, reason:'chat_unavailable', delivery:'notSent'};
    if (s.backend?.kind !== 'local' || s.backend?.remoteTarget) return {ok:false, reason:'not_local', delivery:'notSent'};
    if (input.action === 'status') return {ok:true, ...describe(s)};
    if (input.action === 'prepare') {
      if (s.query || s.stoppedUntilPersonSends) return {ok:true, ...describe(s)};
      if (warming.has(input.id)) return warming.get(input.id);
      const work = (async () => {
        await manager.warmSession(input.id);
        if (closing) return {ok:false, reason:'desktop_closing', delivery:'notSent'};
        if (manager.sessions.get(input.id) !== s) return {ok:false, reason:'chat_unavailable', delivery:'notSent'};
        return {ok:true, ...describe(s)};
      })().finally(() => warming.delete(input.id));
      warming.set(input.id, work);
      return work;
    }
    if (!uuid.test(input.messageId ?? '') || typeof input.text !== 'string' ||
        !input.text.trim() || input.text.length > 4000)
      return {ok:false, reason:'invalid_message', delivery:'notSent'};
    const key = input.messageId, signature = JSON.stringify([input.id,input.text]);
    const earlier = sends.get(key);
    if (earlier) return earlier.signature === signature ? earlier.work :
      {ok:false, reason:'message_id_conflict', delivery:'notSent'};
    // Desktop replaces a reused message UUID. Check its buffer first and keep
    // every attempted send here; the bridge keeps durable delivery records.
    const existing = s.messageBuffer?.find(m => m.type === 'user' && m.uuid === key);
    if (existing) {
      const content = existing.message?.content;
      const text = typeof content === 'string' ? content : content?.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return text === input.text
        ? {ok:true, delivery:'submitted', repeated:true, ...describe(s)}
        : {ok:false, reason:'message_id_conflict', delivery:'notSent'};
    }
    if (sending.has(input.id) || s.isRunning || describe(s).needsAttention)
      return {ok:false, reason:'chat_busy', delivery:'notSent'};
    sending.add(input.id);
    const work = (async () => {
      try {
        if (closing) return {ok:false, reason:'desktop_closing', delivery:'notSent'};
        manager.rearmCrashLoopGuard(input.id);
        const result = await manager.sendMessage(input.id, input.text, undefined,
          {initiator:'user', messageUuid:key});
        return result?.delivered
          ? {ok:true, delivery:'submitted', queued:!!result.queued, ...describe(s)}
          : {ok:false, reason:'send_rejected', message:String(result?.reason??'Claude did not accept this message.').slice(0,500), delivery:'notSent'};
      } catch (error) { return {ok:false, reason:'send_interrupted', message:String(error.message??'Claude could not send this message.').slice(0,500), delivery:'unknown'}; }
      finally { sending.delete(input.id); }
    })();
    sends.set(key, {signature,work});
    return work;
  }
  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  const server = net.createServer(client => {
    client.setEncoding('utf8');
    let data = '', done = false;
    client.setTimeout(65000, () => client.destroy());
    client.on('error', () => {});
    client.on('data', chunk => {
      if (done) return;
      data += chunk.toString('utf8');
      if (Buffer.byteLength(data) > 32768) { client.destroy(); return; }
      if (!data.includes('\n')) return;
      done = true;
      let input;
      try { input = JSON.parse(data.slice(0,data.indexOf('\n'))); }
      catch { client.end('{"ok":false,"reason":"invalid_request"}\n'); return; }
      void handle(input).catch(() => ({ok:false,reason:'desktop_unavailable'}))
        .then(result => client.end(JSON.stringify(result)+'\n'));
    });
  });
  server.on('error', () => {});
  return new Promise(resolve => {
    server.once('error', () => resolve({ok:false,reason:'socket_unavailable'}));
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath,0o600);
      globalThis.__minecraftCompanionsClaude = {socketPath,server,protocol,close:() => {
        closing = true; server.close();
        if (globalThis.__minecraftCompanionsClaude?.server === server)
          delete globalThis.__minecraftCompanionsClaude;
      }};
      onQuit(globalThis.__minecraftCompanionsClaude.close);
      resolve({ok:true,protocol,pid:process.pid});
    });
  });
};
