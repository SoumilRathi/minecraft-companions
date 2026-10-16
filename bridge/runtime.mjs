// Own one bridge per Minecraft instance. The OS releases the listening port on
// crashes, so no stale PID lock can strand startup or launch two receipt writers.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Sessions } from './sessions.mjs';
import { makeServer } from './server.mjs';
import { ClaudeSessions } from './claude/sessions.mjs';
import { DotSessions } from './dot/sessions.mjs';
import { RemoteDotSessions } from './dot/remote.mjs';

export function privateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(temp, 0o600); fs.renameSync(temp, file);
}
export function bridgePort(minecraft) {
  return 30000 + createHash('sha256').update(fs.realpathSync(minecraft)).digest().readUInt32BE() % 19000;
}
export async function existingBridge(configFile, threadId) {
  try {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(config.url)) return false;
    const response = await fetch(config.url + '/state', {
      headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(700),
    });
    if (!response.ok) return false;
    const state = await response.json();
    // Older running bridges also expose the selected thread and connection state.
    if (state.threadId !== config.threadId || typeof state.connected !== 'boolean') return false;
    if (config.threadId !== threadId && !state.sessionPicker) throw new Error('This Minecraft instance is connected to another chat. Update its launch settings first.');
    return true;
  } catch (error) {
    if (error.message.startsWith('This Minecraft instance')) throw error;
    return false;
  }
}

export async function startBridge({ threadId='', minecraft, root, enabledProviders, dotConfig, port = bridgePort(minecraft),
    idleTimeoutMs = 120000, desktop, sessionOptions = {} }) {
  const configDir = path.join(minecraft, 'config');
  const configFile = path.join(configDir, 'agentic-companion-bridge.json');
  const launchFile = path.join(configDir, 'agentic-companion-launch.json');
  const launch = fs.existsSync(launchFile) ? JSON.parse(fs.readFileSync(launchFile,'utf8')) : {};
  enabledProviders ??= launch.providers ?? ['codex'];
  if(!Array.isArray(enabledProviders)||!enabledProviders.length||enabledProviders.some(p=>!['codex','claude','dot'].includes(p)))throw Error('Choose at least one companion in setup.');
  dotConfig ??= launch.dot;
  let previous = {};
  if (!desktop && fs.existsSync(configFile)) {
    previous = JSON.parse(fs.readFileSync(configFile,'utf8'));
    if (previous.sessionPicker && /^[a-f0-9-]{36}$/i.test(previous.threadId)) threadId = previous.threadId;
  }
  if (await existingBridge(configFile, threadId)) return { reused: true };
  fs.mkdirSync(configDir, { recursive: true });
  const journalPath = path.join(configDir, 'agentic-bridge-receipts.json');
  const token = randomBytes(32).toString('hex');
  let connection;
  const disabled = {threadId,connect(){},close(){},view:()=>({connected:false,canSend:false,messages:[],status:'Codex is disabled in setup.'})};
  desktop ??= enabledProviders.includes('codex') ? new Sessions(threadId, { configDir, ...sessionOptions, persist: id => {
    if (closed) throw Error('The bridge is restarting. Reconnect before switching.');
    privateJson(configFile, {...connection, threadId:id}); connection.threadId=id;
  }}) : disabled;
  let lastActivity = Date.now(), timer, closed = false;
  const claude = enabledProviders.includes('claude') ? new ClaudeSessions({configDir,profile:launch.claudeProfile??previous.claudeProfile??'',threadId:previous.claudeThreadId??'',
    persist: (id,profile) => {
      if(closed)throw Error('Bridge is restarting.');
      privateJson(configFile,{...connection,claudeThreadId:id,claudeProfile:profile});
      connection.claudeThreadId=id;connection.claudeProfile=profile;
    }}) : null;
  const cloudFile = path.join(configDir, 'agentic-dot-cloud.json');
  const dot = !enabledProviders.includes('dot') ? null : !dotConfig?.id&&fs.existsSync(cloudFile)
    ? new RemoteDotSessions({config:JSON.parse(fs.readFileSync(cloudFile,'utf8'))})
    : new DotSessions({configDir,threadId:dotConfig?.id??previous.dotThreadId,name:dotConfig?.name??'Dot'});
  // Bind before loading or migrating the receipts. Concurrent starters cannot
  // both become writers even when neither has published its connection file yet.
  const listener = makeServer(desktop, { token, journalPath, providers:{claude,dot}, onShutdown:()=>close(), onActivity: () => { lastActivity = Date.now(); } });
  try {
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(port, '127.0.0.1', resolve); });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    // The winning process may still be publishing its authenticated config.
    for (let i = 0; i < 10; i++) {
      if (await existingBridge(configFile, threadId)) return { reused: true };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error(`Bridge port ${port} is occupied. Close the other bridge or inspect the local bridge log.`);
  }
  async function close() {
    if (closed) return; closed = true;
    clearInterval(timer); desktop.close(); claude?.close(); dot?.close();
    await new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); });
  }
  try {
    const legacy = path.join(root, '.local/receipts.json');
    if (!fs.existsSync(journalPath) && fs.existsSync(legacy)) {
      privateJson(journalPath, JSON.parse(fs.readFileSync(legacy, 'utf8')));
    }
    // Reject damaged receipt files rather than forgetting uncertain deliveries.
    if (fs.existsSync(journalPath)) {
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      if (!journal || Array.isArray(journal) || typeof journal !== 'object') throw Error('Invalid receipt journal');
    }
    connection = { url: `http://127.0.0.1:${listener.address().port}`, token, threadId,
      claudeThreadId:previous.claudeThreadId??'',claudeProfile:previous.claudeProfile??'',dotThreadId:dot?.threadId??'',providers:enabledProviders,
      ...(desktop instanceof Sessions ? {sessionPicker:true} : {}) };
    privateJson(configFile, connection);
    desktop.connect();
    claude?.connect();
    dot?.connect();
    if (idleTimeoutMs > 0) timer = setInterval(() => {
      if (!listener.agenticSending() && Date.now() - lastActivity >= idleTimeoutMs) void close();
    }, Math.min(5000, Math.max(20, idleTimeoutMs / 4)));
    timer?.unref();
    return { reused: false, server: listener, close, configFile, journalPath };
  } catch (error) { await close(); throw error; }
}
