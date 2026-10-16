// Read-only discovery for Claude desktop Code sessions. No CLI resume or model run.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const DEFAULT_DESKTOP_ROOT=path.join(os.homedir(),'Library/Application Support/Claude/claude-code-sessions');
export const DEFAULT_CLAUDE_ROOT=path.join(os.homedir(),'.claude');
async function entries(dir) {try{return await fs.readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return[];throw e;}}
async function json(file) {const stat=await fs.lstat(file);if(!stat.isFile()||stat.size>8*1024*1024)throw Error('Unsupported Claude metadata file');return JSON.parse(await fs.readFile(file,'utf8'));}

export async function listProfiles(root=DEFAULT_DESKTOP_ROOT) {
  const profiles=[];
  for(const account of await entries(root)) if(account.isDirectory()&&UUID.test(account.name)) {
    for(const org of await entries(path.join(root,account.name))) if(org.isDirectory()&&UUID.test(org.name)) {
      const dir=path.join(root,account.name,org.name);
      if((await entries(dir)).some(e=>e.isFile()&&/^local_.*\.json$/.test(e.name)))profiles.push(dir);
    }
  }
  return profiles;
}

export async function listDesktopSessions(profileDir) {
  const result=[];
  for(const entry of await entries(profileDir)) {
    if(!entry.isFile()||!/^local_[a-f0-9-]+\.json$/i.test(entry.name))continue;
    const data=await json(path.join(profileDir,entry.name));
    if(!data.sessionId?.startsWith('local_')||!UUID.test(data.sessionId.slice(6))||
        entry.name!==data.sessionId+'.json'||data.isArchived)continue;
    if(!UUID.test(data.cliSessionId??'')||typeof data.cwd!=='string'||!path.isAbsolute(data.cwd))continue;
    result.push({provider:'claude',id:data.sessionId,cliSessionId:data.cliSessionId,
      title:typeof data.title==='string'?data.title:'Untitled conversation',cwd:data.cwd,
      project:path.basename(data.cwd),activityAt:data.lastActivityAt??data.createdAt??0,
      remoteSessionId:Array.isArray(data.bridgeSessionIds)&&typeof data.bridgeSessionIds.at(-1)==='string'
        ?data.bridgeSessionIds.at(-1).replace(/^session_/,'cse_'):'',
      remoteControlUserEnabled:data.remoteControlUserEnabled,
      remoteControlAutoEligible:data.remoteControlAutoEligible});
  }
  return result.sort((a,b)=>b.activityAt-a.activityAt||a.id.localeCompare(b.id));
}

export async function liveSessions(root=DEFAULT_CLAUDE_ROOT) {
  const result=[];
  for(const entry of await entries(path.join(root,'sessions'))) {
    if(!entry.isFile()||!/^\d+\.json$/.test(entry.name))continue;
    const file=path.join(root,'sessions',entry.name),stat=await fs.lstat(file);
    if(stat.uid!==process.getuid())continue;
    const data=await json(file);
    if(!UUID.test(data.sessionId??'')||!Number.isSafeInteger(data.pid)||data.pid<=1||entry.name!==data.pid+'.json')continue;
    try{process.kill(data.pid,0);}catch{continue;}
    const socket=data.messagingSocketPath;
    if(typeof socket!=='string'||!path.isAbsolute(socket)||socket.includes('\0'))continue;
    const info=await fs.lstat(socket).catch(()=>null),parent=await fs.lstat(path.dirname(socket)).catch(()=>null);
    if(!info?.isSocket()||info.uid!==process.getuid()||(info.mode&0o077)||
        !parent?.isDirectory()||parent.uid!==process.getuid()||(parent.mode&0o077))continue;
    result.push({cliSessionId:data.sessionId,pid:data.pid,socketPath:socket});
  }
  return result;
}

export async function transcriptFile(session,root=DEFAULT_CLAUDE_ROOT) {
  if(!UUID.test(session.cliSessionId??''))throw Error('Invalid Claude session ID');
  const projectRoot=path.join(root,'projects'),matches=[];
  for(const dir of await entries(projectRoot)) if(dir.isDirectory()) {
    const file=path.join(projectRoot,dir.name,session.cliSessionId+'.jsonl');
    if((await fs.lstat(file).catch(()=>null))?.isFile())matches.push(file);
  }
  if(matches.length===1)return matches[0];
  if(matches.length===0)throw Error('No local transcript found for this desktop session');
  throw Error('Multiple transcripts found; resolve the desktop session mapping before connecting');
}

export async function readTranscript(file,{limit=60,receipts={}}={}) {
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.size>128*1024*1024)throw Error('Unsupported transcript size');
  const text=await fs.readFile(file,'utf8'),lines=text.split('\n'),records=new Map();let leaf;
  for(let i=0;i<lines.length;i++) {
    if(!lines[i].trim())continue;
    let row;try{row=JSON.parse(lines[i]);}catch(error){if(i===lines.length-1)break;throw Error('Malformed Claude transcript');}
    if(!row.uuid||row.isSidechain)continue;
    records.set(row.uuid,row);
    if(['user','assistant','system'].includes(row.type))leaf=row.uuid;
  }
  const branch=[],seen=new Set();
  while(leaf&&records.has(leaf)&&!seen.has(leaf)) {
    seen.add(leaf);const row=records.get(leaf);branch.push(row);leaf=row.parentUuid;
  }
  const messages=[];
  const deliveredIds=[];
  let latestCompletedReplyId='',lastAssistantId='',busy=false;
  for(const row of branch.reverse()) {
    if(row.type==='system'&&row.subtype==='stop_hook_summary') {busy=false;latestCompletedReplyId=lastAssistantId;}
    if(!['user','assistant'].includes(row.type))continue;
    const receipt=receipts[row.uuid];
    if(row.isMeta&&!receipt)continue;
    if(row.type==='user') {busy=true;deliveredIds.push(row.uuid);}
    if(row.type==='assistant') {
      busy=true;
      if(row.message?.stop_reason==='end_turn') {busy=false;latestCompletedReplyId=row.uuid;}
    }
    const content=row.message?.content;
    const body=receipt?.text??(typeof content==='string'?content:Array.isArray(content)?content.filter(b=>b.type==='text'&&typeof b.text==='string').map(b=>b.text).join('\n'):'');
    if(body.trim())messages.push({id:row.uuid,role:row.type==='user'?'You':'Claude',text:body.slice(-12000)});
    if(row.type==='assistant'&&body.trim())lastAssistantId=row.uuid;
  }
  return {messages:messages.slice(-limit),recordCount:records.size,deliveredIds,busy,latestCompletedReplyId};
}
