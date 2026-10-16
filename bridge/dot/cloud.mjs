// Dot-only broker. Both the native browser helper and SSH clients use loopback.
import fs from 'node:fs';
import path from 'node:path';
import {DotSessions} from './sessions.mjs';
import {makeServer} from '../server.mjs';
const file=process.env.AGENTIC_DOT_CONFIG;
if(!file)throw Error('AGENTIC_DOT_CONFIG required');
const config=JSON.parse(fs.readFileSync(file,'utf8'));
const match=/^http:\/\/127\.0\.0\.1:(\d+)$/.exec(config.url);
if(!match||typeof config.token!=='string'||config.token.length<32)throw Error('Invalid cloud connection');
const dot=new DotSessions({configDir:path.dirname(file),threadId:config.threadId});
dot.connect();
const server=makeServer(null,{token:config.token,journalPath:path.join(path.dirname(file),'cloud-deliveries.json'),providers:{dot}});
server.listen(Number(match[1]),'127.0.0.1',()=>console.log('Dot broker listening on loopback.'));
let closing=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  if(closing)return;closing=true;dot.close();
  server.close(()=>process.exit(0));
  // Close held notification requests too. Every dispatched command already has
  // a durable receipt; reconnect observes it and never replays an uncertain send.
  server.closeAllConnections();
});
