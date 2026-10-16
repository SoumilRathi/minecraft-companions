import { Desktop } from './desktop.mjs';
import { Catalog } from './catalog.mjs';
import path from 'node:path';
import { Changes } from './dot/changes.mjs';
import { readCache, writeCache } from './cache.mjs';

/** Follows existing desktop owners. Switching never stops or resumes their work. */
export class Sessions {
  constructor(threadId='', { configDir, catalog = new Catalog(undefined,{cacheFile:configDir&&path.join(configDir,'agentic-codex-catalog.json')}), create, persist = () => {} } = {}) {
    this.threadId=threadId; this.catalog=catalog; this.create=create??(id=>new Desktop(id,undefined,{getOwners:()=>[...this.followers.values()].map(d=>d.owner).filter(Boolean)})); this.persist=persist;
    this.followers=new Map(); this.metadata=new Map();this.changes=new Changes();
    this.cacheFile=configDir&&path.join(configDir,'agentic-codex-history.json');
    const saved=readCache(this.cacheFile);
    this.cached=new Map(saved?.version===1&&Array.isArray(saved.chats)?saved.chats.filter(pair=>Array.isArray(pair)&&/^[a-f0-9-]{36}$/i.test(pair[0])&&Array.isArray(pair[1]?.messages)).slice(-6):[]);
    this.catalog.on?.('change',()=>this.changes.notify());
  }
  follow(id) {
    let desktop=this.followers.get(id);
    if (!desktop) {
      desktop=this.create(id); this.followers.set(id,desktop);
      desktop.on?.('change',()=>{
        if(this.closed)return;
        this.changes.notify();
        if(!this.saveTimer)this.saveTimer=setTimeout(()=>{this.saveTimer=null;this.saveHistory();},750);
      });
      desktop.connect();
    }
    else { this.followers.delete(id); this.followers.set(id,desktop); }
    while(this.followers.size>6) { const oldest=this.followers.keys().next().value; this.remember(oldest,this.followers.get(oldest)); this.followers.get(oldest).close(); this.followers.delete(oldest); }
    return desktop;
  }
  remember(id,desktop) {
    const live=desktop.view();
    if(live.connected&&live.messages?.length) {
      this.cached.delete(id);this.cached.set(id,{title:live.title,messages:live.messages.slice(-60)});
      while(this.cached.size>6)this.cached.delete(this.cached.keys().next().value);
    }
  }
  saveHistory() {
    for(const [id,desktop] of this.followers)this.remember(id,desktop);
    writeCache(this.cacheFile,{version:1,chats:[...this.cached]});
  }
  connect() {
    for(const id of this.cached.keys())if(id!==this.threadId)this.follow(id);
    if(this.threadId)this.follow(this.threadId);
    this.refreshTimer=setInterval(()=>{void this.catalog.refresh().catch(()=>{});},15000);
    this.refreshTimer.unref?.();
    const id=this.threadId;
    if(!id){void this.catalog.refresh().catch(()=>{});return;}
    void this.catalog.get(id).then(meta=>{if(meta)this.metadata.set(id,meta);}).catch(()=>{});
  }
  view() {
    const live=this.followers.get(this.threadId)?.view() ?? {connected:false,canSend:false,messages:[]};
    const meta=this.metadata.get(this.threadId)??this.catalog.rows?.find(t=>t.id===this.threadId);
    const cached=this.cached.get(this.threadId);
    return {...live,messages:live.messages?.length?live.messages:cached?.messages??[],threadId:this.threadId,sessionPicker:true,
      catalogVersion:this.catalog.version??0,
      watched:[...this.followers].map(([id,desktop])=>{
        const state=desktop.view();
        return {id,connected:state.connected,busy:state.busy,needsAttention:state.needsAttention,latestCompletedReplyId:state.latestCompletedReplyId};
      }),
      title:live.connected ? live.title : meta?.title ?? cached?.title ?? live.title ?? 'Codex',
      project:meta?.project ?? '',cwd:meta?.cwd ?? '',
      status:live.status ?? (this.threadId ? 'Connecting to Codex desktop...' : 'Choose a Codex conversation.')};
  }
  hasMessage(id) { return this.followers.get(this.threadId)?.hasMessage(id) ?? false; }
  send(text,id) { return this.followers.get(this.threadId).send(text,id); }
  async list(search,cursor,refresh,all) {
    const result=await this.catalog.list(search,cursor,refresh,all);
    for(const meta of result.sessions) this.metadata.set(meta.id,meta);
    return {...result,sessions:result.sessions.map(meta=>{
      const live=this.followers.get(meta.id)?.view();
      return {...meta, selected:meta.id===this.threadId,
        ...(live?.connected ? {connected:true,busy:live.busy,needsAttention:live.needsAttention,latestCompletedReplyId:live.latestCompletedReplyId} : {})};
    })};
  }
  async select(id) {
    if(this.closed)throw Error('The bridge is restarting. Reconnect before switching.');
    if(id===this.threadId) return this.view();
    const meta=await this.catalog.get(id);
    if(this.closed)throw Error('The bridge is restarting. Reconnect before switching.');
    if(!meta) throw Error('That conversation is no longer in the chat list. Refresh and try again.');
    // Persist first: disk failure must leave the old selection intact.
    await this.persist(id);
    if(this.closed)throw Error('The bridge is restarting. Reconnect before switching.');
    this.metadata.set(id,meta); this.threadId=id; this.follow(id);this.changes.notify();this.saveHistory();
    return this.view();
  }
  close() { this.closed=true;clearInterval(this.refreshTimer);clearTimeout(this.saveTimer);this.saveHistory();this.catalog.close?.();this.changes.notify(); for(const desktop of this.followers.values()) desktop.close(); this.followers.clear(); }
}
