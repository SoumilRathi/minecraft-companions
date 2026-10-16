import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';

function privateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(temp, 0o600); fs.renameSync(temp, file);
}

export function makeServer(codex, { token, journalPath, providers = {}, onActivity = () => {}, onShutdown }) {
  // Runtime acquires the listening port and migrates old receipts before
  // publishing credentials. Read lazily so concurrent starters cannot cache
  // independent copies of a journal before one wins the port.
  let journal;
  let sending = false, selecting = false;
  const key = Buffer.from(token);
  const server = http.createServer(async (req, res) => {
    const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      // No browser origins or DNS names. The game also needs the per-launch token.
      if (req.headers.host !== `127.0.0.1:${server.address().port}` || req.headers.origin) return reply(403, { error: 'Local game connections only' });
      const supplied = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (supplied.length !== key.length || !timingSafeEqual(supplied, key)) return reply(401, { error: 'Connection token required' });
      if(req.url==='/shutdown'&&req.method==='POST'&&onShutdown) {
        if(sending||selecting)return reply(409,{error:'A message is still being sent. Try setup again when it finishes.'});
        reply(200,{stopped:true});setImmediate(()=>void onShutdown());return;
      }
      if(req.url!=='/dot/browser'&&!req.url.startsWith('/dot/wake'))onActivity();
      const provider = req.url.startsWith('/dot/') ? 'dot' : req.url.startsWith('/claude/') ? 'claude' : 'codex';
      const desktop = provider === 'codex' ? codex : providers[provider];
      if (!desktop) return reply(404, {error:'Provider unavailable'});
      if (provider !== 'codex') req.url = req.url.slice(provider.length + 1);
      if(provider==='dot'&&req.url==='/browser'&&req.method==='POST') {
        const parts=[];let size=0;
        for await(const part of req) {size+=part.length;if(size>4*1024*1024)return reply(413,{error:'Browser snapshot too large'});parts.push(part);}
        try {return reply(200,desktop.exchange(JSON.parse(Buffer.concat(parts).toString('utf8'))));}
        catch {return reply(400,{error:'Invalid Dot browser update'});}
      }
      const route = new URL(req.url, 'http://127.0.0.1');
      const waitForChange=async changes=>{
        const controller=new AbortController();
        const cancel=()=>controller.abort();res.once('close',cancel);
        try {await changes.wait(route.searchParams.get('after'),{signal:controller.signal});}
        finally {res.removeListener('close',cancel);}
      };
      if(provider==='dot'&&req.method==='GET'&&route.pathname==='/wake'&&desktop.commands) {
        await waitForChange(desktop.commands);
        if(!res.destroyed)return reply(200,{revision:desktop.commands.revision});
        return;
      }
      await desktop.refresh?.();
      if (req.method === 'GET' && route.pathname === '/state') {
        if(desktop.changes&&route.searchParams.has('after'))await waitForChange(desktop.changes);
        if(!res.destroyed)return reply(200, { ...desktop.view(), threadId: desktop.threadId,
          ...(desktop.changes?{revision:desktop.changes.revision}: {}) });
        return;
      }
      if (req.method === 'GET' && route.pathname === '/sessions' && desktop.list) {
        const search = route.searchParams.get('search') ?? '', cursor = route.searchParams.get('cursor') ?? '';
        if (search.length > 200 || cursor.length > 64) return reply(400,{error:'Invalid search'});
        try { return reply(200,await desktop.list(search,cursor,route.searchParams.get('refresh')==='1',provider==='codex'&&route.searchParams.get('all')==='1')); }
        catch(error) { return reply(503,{error:error.message}); }
      }
      if (req.method !== 'POST' || !['/message','/session'].includes(req.url)) return reply(404, { error: 'Unknown route' });
      const parts = []; let size = 0;
      for await (const part of req) { size += part.length; if (size > 24000) return reply(413, { error: 'Message too long' }); parts.push(part); }
      const body = Buffer.concat(parts).toString('utf8');
      let input;
      try { input = JSON.parse(body); } catch { return reply(400, { error: 'Invalid message' }); }
      if (req.url === '/session' && desktop.select) {
        if (!/^[a-f0-9-]{36}$/i.test(input.threadId ?? '') || input.expectedThreadId !== desktop.threadId)
          return reply(409,{error:'The selected conversation changed. Refresh before switching.'});
        if (sending || selecting) return reply(409,{error:'Wait for the current message or chat switch to finish.'});
        selecting=true;
        try { return reply(200,await desktop.select(input.threadId)); }
        catch(error) { return reply(409,{error:error.message}); }
        finally { selecting=false; }
      }
      const { id, text, threadId } = input;
      if (threadId !== desktop.threadId || typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id) ||
          typeof text !== 'string' || !text.trim() || text.length > 4000) return reply(400, { error: 'Invalid message or chat' });
      const hash = createHash('sha256').update(text).digest('hex');
      journal ??= fs.existsSync(journalPath) ? JSON.parse(fs.readFileSync(journalPath, 'utf8')) : {};
      const receiptKey = (provider === 'codex' ? '' : provider + ':') + `${threadId}:${id}`;
      let receipt = journal[receiptKey];
      if (receipt && receipt.hash !== hash) return reply(409, { error: 'Message ID already used for different text' });
      if (desktop.hasMessage(id)) {
        journal[receiptKey] = { hash, state: 'delivered' }; privateJson(journalPath, journal);
        return reply(200, { state: 'delivered', message: 'Message appears in the desktop chat.' });
      }
      if(provider==='dot'&&receipt&&desktop.receipts[id]?.state==='notSent') {
        journal[receiptKey].state='notSent';privateJson(journalPath,journal);
        return reply(200,{state:'notSent',message:'Not sent. Check the draft in your Dot browser tab before trying again.'});
      }
      if (receipt && receipt.state !== 'notSent') return reply(200, { state: receipt.state, message: 'Delivery is not yet confirmed. Check the desktop chat before clearing this draft. It has not been resent.' });
      if (sending || selecting || !desktop.view().canSend) return reply(409, { error: 'The companion is busy or disconnected. Wait for the current reply.' });
      // Save before dispatch. A timeout/restart must never silently send twice.
      journal[receiptKey] = { hash, state: 'unknown' }; privateJson(journalPath, journal);
      sending = true;
      try {
        await desktop.send(text, id);
        journal[receiptKey].state = desktop.hasMessage(id) ? 'delivered' : 'submitted';
        privateJson(journalPath, journal);
        return reply(200, { state: journal[receiptKey].state, message: 'Sent. Waiting for a reply.' });
      } catch (error) {
        if (provider !== 'codex' && error.delivery === 'notSent') {
          journal[receiptKey].state='notSent';privateJson(journalPath,journal);
          return reply(200,{state:'notSent',message:error.message});
        }
        return reply(200, { state: 'unknown', message: 'Delivery is uncertain. Check the desktop chat before clearing this draft. It will not be sent twice automatically.' });
      } finally { sending = false; }
    } catch { if (!res.headersSent) reply(500, { error: 'Bridge error. Check the desktop chat before trying again.' }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.agenticSending = () => sending || selecting;
  return server;
}
