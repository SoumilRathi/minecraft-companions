import fs from 'node:fs';
import path from 'node:path';
import {Changes} from './changes.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
function save(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o700});
  fs.writeFileSync(file+'.tmp',JSON.stringify(value),{mode:0o600});
  fs.chmodSync(file+'.tmp',0o600);fs.renameSync(file+'.tmp',file);
}
export class DotSessions {
  constructor({configDir,threadId,name='Dot',now=Date.now}={}) {
    if(!uuid(threadId))throw Error('Invalid Dot conversation');
    this.threadId=threadId;this.name=name;this.now=now;
    this.file=path.join(configDir,'agentic-dot-messages.json');
    this.receipts=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{};
    if(!this.receipts||Array.isArray(this.receipts)||typeof this.receipts!=='object')throw Error('Invalid Dot receipts');
    this.lastSeen=0;this.owner='';this.snapshot=null;this.completed=null;
    // Never replay work across restarts, even if its last recorded phase was queued.
    for(const r of Object.values(this.receipts))if(r.state==='queued')r.state='unknown';
    this.queue=null;this.changes=new Changes();this.commands=new Changes();
  }
  connect() {
    if(this.maintenance)return;
    // Liveness only. Message and receipt changes publish synchronously.
    this.maintenance=setInterval(()=>this.publish(),1000);this.maintenance.unref();
  }
  close() {this.closed=true;this.lastSeen=0;clearInterval(this.maintenance);this.changes.notify();this.commands.notify();}
  publish() {
    const key=JSON.stringify(this.view());
    if(key!==this.published){this.published=key;this.changes.notify();}
  }
  refresh() {
    if(this.queue&&this.now()-this.queue.at>10000) {
      this.receipts[this.queue.id].state='notSent';this.queue=null;save(this.file,this.receipts);
    }
  }
  hasMessage(id) {return this.receipts[id]?.threadId===this.threadId&&this.receipts[id].state==='delivered';}
  view() {
    this.refresh();
    const fresh=!this.closed&&!!this.snapshot&&this.now()-this.lastSeen<10000;
    const s=this.snapshot;
    const identities=new Map(Object.entries(this.receipts).filter(([,r])=>r.threadId===this.threadId).flatMap(([id,r])=>[r.messageId,r.renderedId].filter(Boolean).map(m=>[m,id])));
    const pending=!!this.queue||Object.values(this.receipts).some(r=>r.threadId===this.threadId&&r.state==='dispatched'&&this.now()-r.at<30000);
    return {provider:'dot',threadId:this.threadId,title:this.name,project:'Your Dot · ChatGPT',sessionPicker:false,
      connected:fresh&&s.ready,canSend:!!(fresh&&s.ready&&s.canSend&&!pending),busy:!!(fresh&&(s.busy||pending)),
      needsAttention:!!(fresh&&s.ready&&!s.canSend&&!s.busy&&!pending),
      connectionPhase:fresh&&s.ready?'ready':'needsBrowser',
      status:!fresh?'Keep your Dot open in your paired browser.':s.status||'Connected to your Dot.',
      messages:(s?.messages??[]).map(m=>({...m,role:m.role==='user'?'You':this.name,...(identities.has(m.id)?{deliveryId:identities.get(m.id)}:{})})),deliveredIds:Object.keys(this.receipts).filter(id=>this.hasMessage(id)),
      notSentIds:Object.keys(this.receipts).filter(id=>this.receipts[id].threadId===this.threadId&&this.receipts[id].state==='notSent'),
      deliveryTimings:Object.entries(this.receipts).slice(-20).map(([id,r])=>({id,queuedAt:r.at,dispatchedAt:r.dispatchedAt,confirmedAt:r.confirmedAt,...r.timing})),
      ...(this.completed===null?{}:{latestCompletedReplyId:this.completed})};
  }
  async send(text,id) {
    if(!this.view().canSend)throw Object.assign(Error(this.view().status),{delivery:'notSent'});
    if(this.receipts[id]&&this.receipts[id].state!=='notSent')throw Error('Dot message already submitted');
    const at=this.now();
    this.receipts[id]={threadId:this.threadId,text,state:'queued',at};
    save(this.file,this.receipts);this.queue={id,text,at};this.publish();this.commands.notify();
  }
  exchange({clientId,snapshot,receipt}={}) {
    try {
    if(this.closed)throw Error('Bridge is closing');
    if(!uuid(clientId))throw Error('Invalid browser connection');
    const base={threadId:this.threadId};
    if(this.owner&&this.owner!==clientId&&this.now()-this.lastSeen<10000)return {...base,status:'Another browser is connected.'};
    if(snapshot) {
      if(snapshot.threadId!==this.threadId||snapshot.url!==`https://chatgpt.com/dots/${this.threadId}`)throw Error('Wrong Dot page');
      if(!Array.isArray(snapshot.messages)||snapshot.messages.length>60)throw Error('Invalid Dot history');
      const messages=snapshot.messages.map(m=>{
        if(!m||typeof m.id!=='string'||m.id.length>512||!['user','assistant'].includes(m.role)||typeof m.text!=='string'||m.text.length>12000)throw Error('Invalid Dot message');
        return {id:m.id,role:m.role,text:m.text};
      });
      if(new Set(messages.map(m=>m.id)).size!==messages.length)throw Error('Duplicate Dot message identities');
      this.owner=clientId;this.lastSeen=this.now();
      this.snapshot={ready:snapshot.ready===true,canSend:snapshot.canSend===true,busy:snapshot.busy===true,
        status:typeof snapshot.status==='string'?snapshot.status.slice(0,250):'',messages};
      if(this.snapshot.ready&&!this.snapshot.busy)this.completed=messages.filter(m=>m.role==='assistant').at(-1)?.id??'';
    }
    if(receipt&&this.owner===clientId) {
      const r=this.receipts[receipt.id];
      if(r?.threadId===this.threadId&&r.state==='delivered')base.receiptAccepted=receipt.id;
      if(r?.threadId===this.threadId&&(['dispatched','unknown'].includes(r.state))&&(r.clientId===clientId||receipt.state==='delivered')) {
        if(['observed','delivered'].includes(receipt.state)) {
          const m=this.snapshot?.messages.find(m=>m.id===receipt.messageId);
          if(!m||m.role!=='user'||r.baseline.includes(m.id))throw Error('Delivery has no matching new user message');
          if(Object.entries(this.receipts).some(([other,v])=>other!==receipt.id&&(v.messageId===m.id||v.renderedId===m.id)))throw Error('Message already belongs to another delivery');
          r.renderedId=m.id;
          if(receipt.state==='delivered') {
            r.state='delivered';r.messageId=m.id;
            r.confirmedAt=this.now();
            r.timing=Object.fromEntries(['browserReceivedAt','browserInsertedAt','browserClickedAt','browserBubbleAt','browserServerIdAt','browserActionsAt','browserConfirmedAt'].filter(k=>Number.isFinite(receipt.timing?.[k])).map(k=>[k,receipt.timing[k]]));
          }
        } else if(receipt.state==='notSent'&&r.state==='dispatched')r.state='notSent';
        else if(receipt.state==='unknown')r.state='unknown';
        save(this.file,this.receipts);
        base.receiptAccepted=receipt.id;
      }
    }
    this.refresh();
    if(this.queue&&this.owner===clientId&&this.snapshot?.ready&&this.snapshot.canSend) {
      const command={...this.queue,threadId:this.threadId};
      const r=this.receipts[command.id];
      r.state='dispatched';r.dispatchedAt=this.now();r.clientId=clientId;r.baseline=this.snapshot.messages.map(m=>m.id);
      save(this.file,this.receipts);this.queue=null;
      return {...base,command,status:'Connected to your Dot.'};
    }
    return {...base,status:'Connected to your Dot.'};
    } finally {this.publish();}
  }
}
