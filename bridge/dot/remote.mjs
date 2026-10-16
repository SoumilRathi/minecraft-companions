import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {Changes} from './changes.mjs';

// Preserve the server's Host header across a tunnel with a different local port.
// Node fetch rewrites that header; http.request sends the supplied value.
export function loopbackRequest(url,options) {
  return new Promise((resolve,reject)=>{
    const request=http.request(url,options,response=>{
      const chunks=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>4*1024*1024){response.destroy(Error('Dot response too large'));return;}chunks.push(chunk);});
      response.on('error',reject);
      response.on('end',()=>resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode,
        json:async()=>JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
    });
    request.on('error',reject);request.end(options.body);
  });
}

export class RemoteDotSessions {
  constructor({config,request=loopbackRequest}) {
    if(!/^[a-z0-9.-]+$/i.test(config.host)||config.host.startsWith('-')||
      !/^[a-z_][a-z0-9_-]*$/i.test(config.user)||!config.identityFile?.startsWith('/')||
      !Number.isInteger(config.port)||config.port<1||config.port>65535||
      !/^[a-f0-9]{64}$/i.test(config.token))throw Error('Invalid hosted Dot connection');
    if(!/^[a-f0-9-]{36}$/i.test(config.threadId??''))throw Error('Configure a Dot conversation ID.');
    this.config=config;this.request=request;this.threadId=config.threadId;
    this.receipts={};this.state=null;this.lastSeen=0;this.retryAt=0;this.closed=false;
    this.changes=new Changes();this.closing=new AbortController();
  }
  connect() {this.watchTask??=this.watch();}
  close() {this.closed=true;this.closing.abort();this.lastSeen=0;this.tunnel?.kill();this.changes.notify();}
  publish() {
    const key=JSON.stringify(this.view());
    if(key!==this.published){this.published=key;this.changes.notify();}
  }
  accept(state) {
    if(state.threadId!==this.threadId||state.provider!=='dot'||!Array.isArray(state.messages))throw Error('Wrong Dot conversation');
    this.state=state;this.lastSeen=Date.now();
    for(const id of state.deliveredIds??[])this.receipts[id]={state:'delivered'};
    for(const id of state.notSentIds??[])this.receipts[id]={state:'notSent'};
    this.publish();
  }
  async watch() {
    let revision='';
    while(!this.closed) {
      try {
        const state=await this.call('state?after='+encodeURIComponent(revision),undefined,{timeoutMs:25000});
        if(typeof state.revision!=='string')throw Error('Dot broker needs notification support');
        revision=state.revision;this.accept(state);
      } catch {
        this.lastSeen=0;this.publish();revision='';
        if(!this.closed)await new Promise(resolve=>{
          const finish=()=>{clearTimeout(timer);this.closing.signal.removeEventListener('abort',finish);resolve();};
          const timer=setTimeout(finish,250);this.closing.signal.addEventListener('abort',finish,{once:true});
        });
      }
    }
  }
  async ensureTunnel() {
    if(this.closed)throw Error('Dot connection closed');
    if(this.tunnel)return;
    if(Date.now()<this.retryAt)throw Error('Reconnecting');
    fs.accessSync(this.config.identityFile,fs.constants.R_OK);
    const listener=net.createServer();
    await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
    this.localPort=listener.address().port;
    await new Promise(resolve=>listener.close(resolve));
    if(this.closed)throw Error('Dot connection closed');
    const c=this.config;
    const child=spawn('/usr/bin/ssh',['-N','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
      '-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2',
      '-i',c.identityFile,'-L',`127.0.0.1:${this.localPort}:127.0.0.1:${c.port}`,`${c.user}@${c.host}`],{stdio:'ignore'});
    this.tunnel=child;
    const lost=()=>{if(this.tunnel===child){this.tunnel=null;this.lastSeen=0;this.retryAt=Date.now()+2000;}};
    child.once('error',lost);child.once('exit',lost);
  }
  async call(route,body,{timeoutMs=body?6000:2500}={}) {
    await this.ensureTunnel();
    const response=await this.request(`http://127.0.0.1:${this.localPort}/dot/${route}`,{
      method:body?'POST':'GET',headers:{Host:`127.0.0.1:${this.config.port}`,Authorization:`Bearer ${this.config.token}`,'Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.any([this.closing.signal,AbortSignal.timeout(timeoutMs)])});
    const result=await response.json();
    if(!response.ok)throw Object.assign(Error(result.error??'Dot server unavailable'),{delivery:response.status===409?'notSent':undefined});
    return result;
  }
  async refresh() {
    // Runtime uses an outstanding change request. POST never waits for a
    // redundant remote GET. Direct refresh remains useful for diagnostics.
    if(this.watchTask)return;
    if(this.refreshing)return this.refreshing;
    this.refreshing=(async()=>{
      try {
        const state=await this.call('state');
        this.accept(state);
      } catch {this.lastSeen=0;this.publish();}
    })();
    try {await this.refreshing;}finally{this.refreshing=null;}
  }
  view() {
    const fresh=!this.closed&&this.lastSeen>0&&Date.now()-this.lastSeen<(this.watchTask?30000:6000);
    const state=this.state??{provider:'dot',threadId:this.threadId,title:'Dot',project:'Your Dot · ChatGPT',sessionPicker:false,messages:[],deliveredIds:[]};
    if(!fresh)return {...state,connected:false,canSend:false,busy:false,connectionPhase:'connecting',status:'Connecting to Dot on your server…'};
    return {...state,status:state.connected?state.status:'Open the private server browser to reconnect Dot.'};
  }
  hasMessage(id) {return this.receipts[id]?.state==='delivered';}
  async send(text,id) {
    if(!this.view().canSend)throw Object.assign(Error('Dot is disconnected or busy.'),{delivery:'notSent'});
    const result=await this.call('message',{threadId:this.threadId,id,text});
    // A pushed confirmation may beat the POST response back over the tunnel.
    if(!this.hasMessage(id))this.receipts[id]={state:result.state};
    if(result.state==='notSent')throw Object.assign(Error(result.message),{delivery:'notSent'});
    if(!['delivered','submitted'].includes(result.state))throw Error('Dot delivery is uncertain. It will not be resent.');
  }
}
