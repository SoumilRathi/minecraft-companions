import fs from 'node:fs';
import path from 'node:path';
import {listProfiles,listDesktopSessions,liveSessions,transcriptFile,readTranscript} from './catalog.mjs';
import {ClaudeDesktopConnection} from './desktop.mjs';

function save(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600});
  fs.chmodSync(temp,0o600);fs.renameSync(temp,file);
}

/** Attach to desktop-owned Claude runtimes. Never start or resume a second CLI. */
export class ClaudeSessions {
  constructor({configDir,profile='',threadId='',persist=()=>{},catalog=listDesktopSessions,
      profiles=listProfiles,live=liveSessions,transcript=transcriptFile,read=readTranscript,
      connection=new ClaudeDesktopConnection(),send=input=>connection.send(input)}={}) {
    Object.assign(this,{profile,threadId,persist,catalog,profiles,live,transcript,read,connection,transport:send});
    this.receiptFile=path.join(configDir,'agentic-claude-messages.json');
    this.receipts=fs.existsSync(this.receiptFile)?JSON.parse(fs.readFileSync(this.receiptFile,'utf8')):{};
    this.metadata=[];this.snapshots=new Map();this.watched=new Set();this.pending=new Set();this.nextRefresh=0;
    this.error='Connecting to Claude desktop...';
  }
  connect() {
    if(this.maintenance)return;
    void this.refresh(true);
    // Starts with Minecraft's bridge, independently of opening a character.
    // Prepare chats while the player is elsewhere in the world.
    this.maintenance=setInterval(()=>void this.refresh(),5000);this.maintenance.unref();
  }
  async refresh(force=false) {
    if(this.closed)return;
    if(this.refreshing)return this.refreshing;
    if(!force&&Date.now()<this.nextRefresh)return;
    this.refreshing=this.load().catch(error=>{this.error=error.message;this.snapshots.clear();})
      .finally(()=>{this.refreshing=null;this.nextRefresh=Date.now()+750;});
    return this.refreshing;
  }
  async load() {
    const running=await this.live();
    if(this.closed)return;
    if(!this.profile) {
      const candidates=[];
      for(const profile of await this.profiles()) {
        const sessions=await this.catalog(profile);
        const matches=sessions.filter(s=>running.some(l=>l.cliSessionId===s.cliSessionId)).length;
        candidates.push({profile,matches});
      }
      candidates.sort((a,b)=>b.matches-a.matches);
      if(this.closed)return;
      if(!candidates.length)throw Error('Create a Code conversation in Claude, then refresh.');
      if(candidates.length>1&&candidates[0].matches===candidates[1].matches)throw Error('Choose a Claude profile in the setup command.');
      this.profile=candidates[0].profile;
    }
    this.metadata=(await this.catalog(this.profile)).map(s=>({...s,id:s.id.replace(/^local_/, '')}));
    if(this.closed)return;
    if(!this.threadId&&this.metadata.length) {
      this.threadId=this.metadata.find(s=>running.some(l=>l.cliSessionId===s.cliSessionId))?.id??this.metadata[0].id;
      await this.persist(this.threadId,this.profile);
    }
    if(this.threadId)this.watched.add(this.threadId);
    for(const id of this.watched) {
      const meta=this.metadata.find(s=>s.id===id);
      if(!meta) {this.snapshots.delete(id);continue;}
      try {
        const receipts=Object.fromEntries(Object.entries(this.receipts).filter(([,r])=>r.threadId===id&&r.cliSessionId===meta.cliSessionId));
        const snapshot=await this.read(await this.transcript(meta),{receipts});
        const connection=this.connection.state(meta);
        const connected=connection.connected;
        const pending=Object.entries(receipts).some(([messageId,r])=>!snapshot.deliveredIds.includes(messageId)&&
          (this.pending.has(messageId)||(['submitted','unknown'].includes(r.state)&&Date.now()-r.submittedAt<30000)));
        for(const messageId of snapshot.deliveredIds)this.pending.delete(messageId);
        const busy=connected&&(snapshot.busy||connection.busy||pending);
        this.snapshots.set(id,{...snapshot,...connection,busy,
          needsAttention:connection.needsAttention??false,canSend:connected&&!busy&&!connection.needsAttention});
      } catch(error) {this.snapshots.set(id,{connected:false,canSend:false,messages:[],status:error.message,connectionPhase:'needsDesktop'});}
    }
    this.error='';
  }
  view() {
    const meta=this.metadata.find(s=>s.id===this.threadId);
    const state=this.snapshots.get(this.threadId);
    return {connected:false,canSend:false,busy:false,needsAttention:false,messages:[],deliveredIds:[],
      latestCompletedReplyId:'',connectionPhase:'needsDesktop',status:this.error||'Choose a Claude conversation.',
      ...state,threadId:this.threadId,title:meta?.title??'Choose a conversation',project:meta?.project??'',
      sessionPicker:true,provider:'claude',watched:[...this.snapshots].map(([id,s])=>({id,connected:s.connected,busy:s.busy,
        needsAttention:s.needsAttention,latestCompletedReplyId:s.latestCompletedReplyId}))};
  }
  hasMessage(id) {return this.snapshots.get(this.threadId)?.deliveredIds?.includes(id)??false;}
  async list(search='',cursor='',refresh=false) {
    await this.refresh(refresh);
    if(this.error)throw Error(this.error);
    const words=search.toLowerCase().split(/\s+/).filter(Boolean);
    const matches=this.metadata.filter(s=>words.every(w=>(s.title+' '+s.cwd).toLowerCase().includes(w)));
    const offset=Number(cursor||0);
    if(!Number.isSafeInteger(offset)||offset<0)throw Error('Invalid conversation cursor');
    return {sessions:matches.slice(offset,offset+60).map(s=>({...s,selected:s.id===this.threadId})),
      total:matches.length,nextCursor:offset+60<matches.length?String(offset+60):'',truncated:false};
  }
  async select(id) {
    await this.refresh(true);
    if(this.closed)throw Error('Bridge is restarting.');
    if(!this.metadata.some(s=>s.id===id))throw Error('That conversation is no longer available. Refresh the list.');
    await this.persist(id,this.profile);this.threadId=id;this.watched.delete(id);this.watched.add(id);
    while(this.watched.size>6) {const oldest=this.watched.values().next().value;this.watched.delete(oldest);this.snapshots.delete(oldest);}
    await this.refresh(true);return this.view();
  }
  async send(text,id) {
    await this.refresh(true);
    const meta=this.metadata.find(s=>s.id===this.threadId);
    if(this.receipts[id]&&this.receipts[id].state!=='notSent')throw Error('This message was already submitted. Check desktop for delivery.');
    if(!meta||!this.view().canSend)throw Object.assign(Error(this.view().status),{delivery:'notSent'});
    this.receipts[id]={threadId:this.threadId,cliSessionId:meta.cliSessionId,text,state:'unknown',submittedAt:Date.now()};
    save(this.receiptFile,this.receipts);this.pending.add(id);
    try {
      await this.transport({session:meta,cliSessionId:meta.cliSessionId,text,id});
      this.receipts[id].state='submitted';
    } catch(error) {
      this.receipts[id].state=error.delivery==='notSent'?'notSent':'unknown';throw error;
    } finally {
      this.pending.delete(id);save(this.receiptFile,this.receipts);await this.refresh(true);
    }
  }
  close() {this.closed=true;clearInterval(this.maintenance);this.connection.close?.();}
}
