import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import lockfile from 'proper-lockfile';

const exec=promisify(execFile);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const directory=path.join(os.homedir(),'Library/Application Support/Agentic Companion');
const socketPath=path.join(directory,'claude-chat.sock');
const helperApp=path.join(directory,'Claude Reconnect.app');
const helper=path.join(helperApp,'Contents/MacOS/claude-desktop-access');
const appRoot='/Applications/Claude.app/Contents/Resources/app.asar/.vite/build';
const failure=reason=>Object.assign(Error(reason),{reason});

// LaunchServices gives this helper its own lasting Accessibility permission.
// It must not depend on permissions inherited from the app that launched Minecraft.
export async function nativeAccess(args=[]) {
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const resultFile=path.join(directory,`claude-access-${randomUUID()}.json`);
  try {
    await exec('/usr/bin/open',['-g','-n','-W',helperApp,'--args','--result',resultFile,...args],{timeout:45000});
    return JSON.parse(await fs.readFile(resultFile,'utf8'));
  } finally {await fs.rm(resultFile,{force:true});}
}

export async function desktopRequest(input,{socket=socketPath,timeout=65000}={}) {
  const stat=await fs.lstat(socket);
  if(!stat.isSocket()||stat.uid!==process.getuid()||(stat.mode&0o077))throw failure('invalid_socket');
  return new Promise((resolve,reject)=>{
    const client=net.createConnection(socket);client.setEncoding('utf8');let data='',settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;client.destroy();error?reject(error):resolve(value);};
    client.setTimeout(timeout,()=>finish(failure('desktop_timeout')));
    client.on('connect',()=>client.write(JSON.stringify(input)+'\n'));
    client.on('error',error=>finish(error));
    client.on('data',chunk=>{
      data+=chunk.toString('utf8');
      if(data.length>16384){finish(failure('invalid_response'));return;}
      if(!data.includes('\n'))return;
      try{finish(null,JSON.parse(data.slice(0,data.indexOf('\n'))));}catch{finish(failure('invalid_response'));}
    });
    client.on('end',()=>{if(!data.includes('\n'))finish(failure('desktop_closed'));});
  });
}

async function targetFor(pid) {
  try {
    const response=await fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(800),redirect:'error'});
    const targets=await response.json();
    return targets.find(t=>t.type==='node'&&t.title?.endsWith(`[${pid}]`)&&
      /^ws:\/\/127\.0\.0\.1:9229\/[a-f0-9-]+$/i.test(t.webSocketDebuggerUrl??''));
  }catch{return null;}
}
async function evaluate(target,expression) {
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(target.webSocketDebuggerUrl);
    let settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);ws.close();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(failure('desktop_timeout')),20000);
    ws.onerror=()=>finish(failure('desktop_debugger_unavailable'));
    ws.onopen=()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
    ws.onmessage=event=>{
      let message;try{message=JSON.parse(event.data);}catch{return;}
      if(message.id!==1)return;
      if(message.error||message.result?.exceptionDetails)finish(failure('desktop_control_unavailable'));
      else finish(null,message.result?.result?.value);
    };
  });
}
export async function installHost() {
  await fs.mkdir(directory,{recursive:true,mode:0o700});await fs.chmod(directory,0o700);
  const release=await lockfile.lock(directory,{realpath:false,stale:90000,update:5000,
    retries:{retries:30,minTimeout:200,maxTimeout:500}});
  try {
    try {const ready=await desktopRequest({action:'hello'},{timeout:1000});if(ready.protocol===3)return;}catch{}
    const source=await fs.readFile(path.join(root,'bridge/claude/desktop-host.cjs'),'utf8');
    const info=JSON.parse((await exec(helper,['--info'],{timeout:5000})).stdout);
    if(!info.running)throw failure('desktop_closed');
    let target=await targetFor(info.pid);
    const opened=!target;
    let native=info;
    if(!target) {
      native=await nativeAccess();
      if(!native.ok)throw failure(native.reason);
      target=await targetFor(native.pid);
    }
    if(!target)throw failure('desktop_debugger_unavailable');
    const expression=`(async()=>{
      if(process.pid!==${Number(native.pid)})return {ok:false,reason:'wrong_desktop'};
      try {
      const req=process.getBuiltinModule('module').createRequire(${JSON.stringify(appRoot+'/index.js')});
      const fs=req('node:fs'),net=req('node:net'),path=req('node:path');
      const file=fs.readdirSync(${JSON.stringify(appRoot)}).find(name=>name.startsWith('index.chunk-')&&name.endsWith('.js')&&
        fs.readFileSync(path.join(${JSON.stringify(appRoot)},name),'utf8').includes('exports.claudeCodeSessionManager='));
      if(!file)return {ok:false,reason:'desktop_version_unsupported'};
      const manager=req('./'+file).claudeCodeSessionManager;
      if(!manager?.waitForSessionsLoaded||!manager?.warmSession||!manager?.sendMessage||!manager?.rearmCrashLoopGuard||!manager?.sessions||!manager?.permissionBroker?.hasPendingFor||!manager?.userDialogBroker?.hasPendingFor)return {ok:false,reason:'desktop_version_unsupported'};
      const module={exports:{}};((module)=>{${source}\n})(module);
      const result=await module.exports({manager,socketPath:${JSON.stringify(socketPath)},fs,net,
        onQuit:fn=>req('electron').app.once('before-quit',fn)});
      return result;
      } finally {
        if(${opened})setTimeout(()=>process.getBuiltinModule('inspector').close(),500);
      }
    })()`;
    let result;
    try {result=await evaluate(target,expression);}
    catch(error) {
      if(opened)await evaluate(target,`process.pid===${Number(native.pid)}&&setTimeout(()=>process.getBuiltinModule('inspector').close(),100)`).catch(()=>{});
      throw error;
    }
    if(!result?.ok)throw failure(result?.reason??'desktop_control_unavailable');
  } finally {await release();}
}

const statuses = {
  desktop_closed: 'Open Claude to connect.',
  desktop_closing: 'Open Claude to connect.',
  accessibility_required: 'Allow Claude Reconnect in System Settings → Privacy & Security → Accessibility.',
  desktop_version_unsupported: 'This Claude version is not supported. Check for a Minecraft Companions update.',
  chat_unavailable: 'This conversation is no longer available in Claude.',
  not_local: 'Choose a local Code conversation in Claude.',
  chat_busy: 'Wait for Claude to finish, or answer its question in the desktop app.',
};
export class ClaudeDesktopConnection {
  constructor({request=desktopRequest,install=installHost,now=Date.now}={}) {
    Object.assign(this,{request,install,now});this.cache=new Map();
  }
  state(meta) {
    const entry=this.cache.get(meta.id);
    if(!entry?.pending&&(!entry||entry.retryAt<=this.now()))void this.refresh(meta);
    return this.cache.get(meta.id)?.value??{connected:false,connectionPhase:'connecting',status:'Connecting to Claude…'};
  }
  async refresh(meta) {
    if(this.closed)return;
    let entry=this.cache.get(meta.id);
    if(entry?.pending)return entry.pending;
    if(entry&&entry.retryAt>this.now())return entry.value;
    entry??={};this.cache.set(meta.id,entry);
    entry.pending=(async()=>{
      const id='local_'+meta.id.replace(/^local_/,'');
      let result;
      try {result=await this.request({action:'prepare',id});}
      catch {
        this.installing??=this.install().finally(()=>{this.installing=null;});
        await this.installing;if(this.closed)return;
        result=await this.request({action:'prepare',id});
      }
      if(!result?.ok)throw failure(result?.reason??'desktop_unavailable');
      return {connected:true,busy:result.running,needsAttention:result.needsAttention,
        connectionPhase:'ready',status:'Connected to Claude.'};
    })().catch(error=>({connected:false,connectionPhase:error.reason==='desktop_closed'?'needsDesktop':'error',
      status:statuses[error.reason]??'Could not connect to Claude. Check the desktop app.'}))
      .then(value=>{entry.value=value;entry.retryAt=this.now()+(value?.connected?500:5000);return value;})
      .finally(()=>{entry.pending=null;});
    return entry.pending;
  }
  async send({session,text,id}) {
    // A lost socket response must not trigger a second submission.
    let result;
    try {result=await this.request({action:'send',id:'local_'+session.id.replace(/^local_/,''),messageId:id,text});}
    catch {throw Object.assign(Error('Connection interrupted. Check this chat in Claude before sending again.'),{delivery:'unknown'});}
    if(!result?.ok)throw Object.assign(Error(result?.message??statuses[result?.reason]??'Claude could not accept this message. Check the desktop app.'),{delivery:result?.delivery??'unknown'});
    this.cache.delete(session.id);
    return result;
  }
  close(){this.closed=true;}
}
