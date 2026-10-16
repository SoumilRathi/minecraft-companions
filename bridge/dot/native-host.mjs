// Chrome launches this local helper over stdin/stdout. No shell commands or web credentials.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export function frame(value) {const data=Buffer.from(JSON.stringify(value));const size=Buffer.alloc(4);size.writeUInt32LE(data.length);return Buffer.concat([size,data]);}
export function decoder(onMessage) {
  let buffer=Buffer.alloc(0);
  return data=>{
    buffer=Buffer.concat([buffer,data]);
    while(buffer.length>=4) {
      const n=buffer.readUInt32LE();if(n>4*1024*1024)throw Error('Native message too large');
      if(buffer.length<n+4)return;
      const message=JSON.parse(buffer.subarray(4,4+n).toString());buffer=buffer.subarray(4+n);onMessage(message);
    }
  };
}
export async function exchange(configFile,clientId,input,request=fetch) {
  const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
  if(!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(config.url))throw Error('Bridge must be local');
  const response=await request(config.url+'/dot/browser',{method:'POST',
    headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'},
    body:JSON.stringify({clientId,snapshot:input.snapshot,receipt:input.receipt}),signal:AbortSignal.timeout(4000)});
  if(!response.ok)throw Error('Bridge unavailable');return response.json();
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
  const manifest=JSON.parse(fs.readFileSync(new URL('../../browser/dot-extension/manifest.json',import.meta.url),'utf8'));
  const {createHash}=await import('node:crypto');
  const extensionId=createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
  if(process.argv[2]!==`chrome-extension://${extensionId}/`)process.exit(1);
  const registration=path.join(os.homedir(),'Library/Application Support/Minecraft Companions/dot-browser.json');
  const config=process.env.AGENTIC_DOT_CONFIG??JSON.parse(fs.readFileSync(registration,'utf8')).configFile;
  const clientId=randomUUID();let chain=Promise.resolve();
  const write=message=>process.stdout.write(frame(message));
  // Broker notifications wake the page immediately. This slower heartbeat only
  // renews its lease and recovers a tab that missed an extension lifecycle event.
  const heartbeat=setInterval(()=>write({type:'poll'}),5000);
  const closing=new AbortController();
  async function watchCommands() {
    let revision='';
    while(!closing.signal.aborted) {
      try {
        const c=JSON.parse(fs.readFileSync(config,'utf8'));
        if(!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(c.url))throw Error('Bridge must be local');
        const response=await fetch(c.url+'/dot/wake?after='+encodeURIComponent(revision),{
          headers:{Authorization:`Bearer ${c.token}`},signal:AbortSignal.any([closing.signal,AbortSignal.timeout(25000)])});
        if(!response.ok)throw Error('Broker unavailable');
        const next=await response.json();
        if(typeof next.revision!=='string')throw Error('Invalid wake notification');
        if(next.revision!==revision){revision=next.revision;write({type:'poll'});}
      } catch {
        revision='';
        if(!closing.signal.aborted)await new Promise(resolve=>setTimeout(resolve,1000));
      }
    }
  }
  void watchCommands();
  const accept=decoder(input=>{
    chain=chain.then(async()=>{
      if(input.type!=='exchange')return;
      try {write({type:'exchange',requestId:input.requestId,...await exchange(config,clientId,input)});}
      catch {write({type:'exchange',requestId:input.requestId,status:'Open your configured Minecraft game to connect.'});}
    });
  });
  process.stdin.on('data',data=>{try{accept(data);}catch{process.exit(1);}});
  process.stdin.on('end',()=>{closing.abort();clearInterval(heartbeat);process.exit(0);});
}
