import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge } from './runtime.mjs';

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) =>
  index % 2 ? pairs : [...pairs, [value, args[index + 1]]], []));
const threadId = options['--thread']??'', minecraft = options['--minecraft'];
if ((threadId&&!/^[a-f0-9-]{36}$/i.test(threadId)) || !minecraft)
  throw Error('Usage: node bridge/run.mjs --minecraft GAME_FOLDER [--thread THREAD_ID]');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = await startBridge({ threadId, minecraft, root });
console.log(runtime.reused ? 'Minecraft Companions connection already running; reusing it.' : 'Minecraft Companions connection started; waiting for the local game.');
if (!runtime.reused) {
  process.on('SIGINT', () => void runtime.close()); process.on('SIGTERM', () => void runtime.close());
}
