// Discovery only: this subprocess never starts, resumes, or writes a chat.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { readCache, writeCache } from './cache.mjs';

export function readCatalog({ executable = process.env.AGENTIC_CODEX ??
    (fs.existsSync('/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex')
      ? '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex' : 'codex'), timeoutMs = 20000, onPage = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe','pipe','pipe'] });
    let buffer = '', finished = false, pages = 0;
    const rows = [];
    const end = (error) => {
      if (finished) return; finished = true; clearTimeout(timer); child.kill();
      if (error) reject(error); else resolve({ rows, truncated: pages >= 100 });
    };
    const timer = setTimeout(() => end(Error('Chat discovery timed out. Try refreshing the list.')), timeoutMs);
    const send = (id, method, params) => child.stdin.write(JSON.stringify({...(id === null ? {} : {id}),method,params})+'\n');
    const page = cursor => send(2, 'thread/list', {
      limit:100, sortKey:'recency_at', sourceKinds:['cli','vscode','appServer'], archived:false, ...(cursor ? {cursor} : {}),
    });
    child.on('error', () => end(Error('Codex chat discovery is unavailable. Check the Codex installation.')));
    child.on('exit', () => { if (!finished) end(Error('Chat discovery stopped before the list was ready.')); });
    child.stdin.on('error', () => end(Error('Chat discovery connection closed.')));
    child.stderr.on('data', () => {}); // Account/runtime logs are not conversation UI.
    child.stdout.on('data', data => {
      buffer += data;
      if (buffer.length > 16 * 1024 * 1024) return end(Error('Chat discovery response too large.'));
      let split;
      while ((split = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, split); buffer = buffer.slice(split+1);
        try {
          const message = JSON.parse(line);
          if (message.error) return end(Error('Codex could not list chats. Try refreshing.'));
          if (message.id === 1) { send(null,'initialized',{}); page(); }
          if (message.id === 2) {
            rows.push(...message.result.data); pages++; onPage(rows);
            if (message.result.nextCursor && pages < 100) page(message.result.nextCursor); else end();
          }
        } catch { return end(Error('Unsupported chat discovery response.')); }
      }
    });
    send(1,'initialize',{clientInfo:{name:'agentic_chat_catalog',version:'0.7.0'}});
  });
}

export class Catalog extends EventEmitter {
  constructor(read, {cacheFile} = {}) {
    super();this.cacheFile=cacheFile;this.rows=[];this.updated=0;this.version=0;
    const saved=readCache(cacheFile);
    if(saved?.version===1&&Array.isArray(saved.rows)&&saved.rows.every(r=>typeof r.id==='string'&&typeof r.title==='string'&&typeof r.cwd==='string')) {
      this.rows=saved.rows;this.truncated=!!saved.truncated;this.updated=saved.updated||1;
    }
    this.read=read??(()=>readCatalog({onPage:rows=>{
      if(this.refreshingEmpty) {this.setRows(rows);this.emit('change');this.releasePage?.();}
    }}));
  }
  setRows(rows) {
    const unique=new Map();
    for(const row of rows)if(typeof row.id==='string'&&(!unique.has(row.id)||row.updatedAt>unique.get(row.id).updatedAt))unique.set(row.id,row);
    this.rows=[...unique.values()].map(t=>{
      const cwd=typeof t.cwd==='string'?t.cwd:'';
      return {id:t.id,title:(t.name||t.preview||'Untitled conversation').replace(/\s+/g,' ').slice(0,200),
        cwd,project:cwd?path.basename(cwd):'No project',updatedAt:t.updatedAt??0,
        recencyAt:Number.isFinite(t.recencyAt)?t.recencyAt:t.updatedAt??t.createdAt??0};
    }).sort((a,b)=>b.recencyAt-a.recencyAt||a.id.localeCompare(b.id));
    this.version++;
  }
  async refresh(force=false) {
    if(this.closed)return;
    if(!force&&this.updated&&Date.now()-this.updated<30000)return;
    if(!this.pending) {
      this.refreshingEmpty=!this.rows.length;
      this.firstPage=new Promise(resolve=>{this.releasePage=resolve;});
      this.pending=Promise.resolve().then(()=>this.read()).then(result=>{
        if(this.closed)return;
        this.setRows(result.rows);this.truncated=result.truncated;this.updated=Date.now();
        writeCache(this.cacheFile,{version:1,rows:this.rows,truncated:this.truncated,updated:this.updated});
      }).finally(()=>{this.pending=null;if(this.rows.length)this.releasePage?.();this.emit('change');});
    }
    await this.pending;
  }
  async list(search='',cursor='',refresh=false,all=false) {
    const update=this.refresh(refresh);
    if(!this.rows.length)await Promise.race([update,this.firstPage??update]);
    // A failed refresh never removes a previously loaded list.
    update.catch(()=>{});
    const terms=search.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const rows=this.rows.filter(t=>terms.every(term=>`${t.title} ${t.cwd}`.toLocaleLowerCase().includes(term)));
    const offset=/^\d{1,6}$/.test(cursor)?Number(cursor):0;
    return {sessions:all?rows:rows.slice(offset,offset+30),nextCursor:!all&&offset+30<rows.length?String(offset+30):null,
      total:rows.length,truncated:this.truncated,refreshing:!!this.pending,catalogVersion:this.version};
  }
  async get(id) {
    const known=this.rows.find(t=>t.id===id);
    if(known){void this.refresh().catch(()=>{});return known;}
    await this.refresh(true);return this.rows.find(t=>t.id===id);
  }
  close(){this.closed=true;}
}
