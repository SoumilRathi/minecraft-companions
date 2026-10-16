import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {randomUUID} from 'node:crypto';
const DEFAULT_DOT='11111111-1111-4111-8111-111111111111';
const source=fs.readFileSync(new URL('../../browser/dot-extension/content.js',import.meta.url),'utf8');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t,{draft='',attachment=false,profileLabel=false,plainText=false,autoConfirm=true,trimMessage=false,transformInput=false,enableDelay=0,url=`https://chatgpt.com/dots/${DEFAULT_DOT}`,storage={}}={}) {
  const dom=new JSDOM('<button aria-label="Your dot actions"></button><main><article class="message-row" data-message-id="old"><div class="message-text"><p>Hello <strong>Dot</strong></p></div></article></main><div data-composer-surface-variant="default"><div data-composer-body><div><div contenteditable="true" role="textbox" aria-label="Message"></div><button aria-label="Send" disabled></button></div></div></div>',{url,runScripts:'outside-only'});
  t.after(async()=>{dom.window.dispatchEvent(new dom.window.Event("pagehide"));await pause(5);dom.window.close();});const w=dom.window;w.minecraftCompanionsDot={id:DEFAULT_DOT,name:'Dot'};
  if(profileLabel)w.document.querySelector('button').setAttribute('aria-label','Open Dot’s profile');
  if(plainText)w.document.querySelector('[contenteditable]').setAttribute('contenteditable','plaintext-only');let tick,command,sent=0,snapshots=[],receipts=[];
  Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
  w.HTMLElement.prototype.getClientRects=()=>[{x:0,y:0,width:10,height:10}];
  const editor=w.document.querySelector('[role=textbox]'),button=w.document.querySelector('[aria-label=Send]');
  editor.textContent=draft;
  if(attachment){const extra=w.document.createElement('div');extra.textContent='attached.pdf';editor.closest('[data-composer-body]').append(extra);}
  w.document.execCommand=(_op,_flag,text)=>{editor.textContent=transformInput?text.trim().replaceAll('\n','\n\n'):text;if(enableDelay)setTimeout(()=>button.disabled=false,enableDelay);else button.disabled=false;return true;};
  const confirm=()=>{const a=w.document.createElement('article');a.className='message-row self';a.dataset.messageId='room~room~CalpicoMessage~Sentinel_new';
    const text=w.document.createElement('div');text.className='message-text';text.textContent=trimMessage?editor.textContent.trim():editor.textContent;a.append(text);
    const actions=w.document.createElement('div');actions.setAttribute('aria-label','Message actions');a.append(actions);w.document.querySelector('main').append(a);editor.textContent='';button.disabled=true;};
  button.onclick=()=>{sent++;if(autoConfirm)confirm();};
  w.chrome={storage:{local:{get:async key=>Object.fromEntries((Array.isArray(key)?key:[key]).map(k=>[k,storage[k]])),set:async entries=>Object.assign(storage,structuredClone(entries)),remove:async key=>{delete storage[key];}}},runtime:{onMessage:{addListener(fn){tick=fn;}},sendMessage:async input=>{snapshots.push(input.snapshot);receipts.push(input.receipt);const result={command};command=null;return result;}}};
  w.eval(source);await pause(5);
  return {w,editor,confirm,storage,snapshots,receipts,tick:async()=>{tick({type:'poll'},null,()=>{});await pause(20);},command:value=>command=value,sends:()=>sent};
}
test('DOM reader preserves roles/formatting; actual command uses empty composer once',async t=>{
  const f=await fixture(t);await f.tick();assert.equal(f.snapshots.at(-1).canSend,true);
  assert.equal(f.snapshots.at(-1).messages[0].text,'Hello **Dot**');
  const command={id:randomUUID(),threadId:DEFAULT_DOT,text:'a normal message'};
  f.command(command);await f.tick();assert.equal(f.sends(),1);
  assert.equal(f.receipts.at(-1).state,'delivered','delivery is published without waiting for another timer tick');
  f.command(command);await f.tick();assert.equal(f.sends(),1);
  const restarted=await fixture(t,{storage:f.storage});assert.equal(restarted.receipts.at(-1).state,'delivered');
});
test('browser drafts, attachments, wrong URLs, and reloads cannot cause another send',async t=>{
  for(const options of [{draft:'my unfinished draft'},{attachment:true},{url:'https://chatgpt.com/c/other'}]) {
    const f=await fixture(t,options);f.command({id:randomUUID(),threadId:DEFAULT_DOT,text:'Minecraft'});await f.tick();
    assert.equal(f.sends(),0);if(options.draft)assert.equal(f.editor.textContent,options.draft);
  }
  const id=randomUUID(),storage={[DEFAULT_DOT+':receipt:'+id]:{state:'unknown'}};
  const f=await fixture(t,{storage});f.command({id,threadId:DEFAULT_DOT,text:'retry'});await f.tick();assert.equal(f.sends(),0);
});

test('Dot profile control and plain-text editor variants are recognized',async t=>{const f=await fixture(t,{profileLabel:true,plainText:true});await f.tick();assert.equal(f.snapshots.at(-1).ready,true);assert.equal(f.snapshots.at(-1).canSend,true);});

async function until(predicate) {
  const deadline=Date.now()+1500;
  while(!predicate()){if(Date.now()>deadline)throw Error('Expected DOM notification');await pause(5);}
}
test('button readiness and message confirmation use DOM notifications without a polling tick',async t=>{
  const f=await fixture(t,{enableDelay:35,autoConfirm:false});
  f.command({id:randomUUID(),threadId:DEFAULT_DOT,text:'notify immediately'});
  await f.tick();await until(()=>f.sends()===1);
  assert.equal(f.receipts.some(r=>r?.state==='delivered'),false);
  // Advance beyond the former eight-second deadline without sleeping through it.
  f.w.Date.now=()=>Date.now()+20000;
  f.confirm();await until(()=>f.receipts.some(r=>r?.state==='delivered'));
  assert.equal(f.sends(),1);
});
test('reload observes a pending delivery and confirms it without another click',async t=>{
  const id=randomUUID(),storage={[DEFAULT_DOT+':receipt:'+id]:{state:'unknown'},[DEFAULT_DOT+':pendingDelivery']:{id,text:'late acknowledgement',baseline:['old'],timing:{browserReceivedAt:1}}};
  const f=await fixture(t,{storage});
  f.editor.textContent='late acknowledgement';f.confirm();
  await until(()=>f.receipts.some(r=>r?.id===id&&r.state==='delivered'));
  assert.equal(f.sends(),0);assert.equal(storage[DEFAULT_DOT+':pendingDelivery'],undefined);
});

test('trailing spaces and multiline rendering do not gate delivery',async t=>{
  const f=await fixture(t,{trimMessage:true});
  const id=randomUUID();f.command({id,threadId:DEFAULT_DOT,text:'First line\nSecond line.   '});await f.tick();
  assert.equal(f.receipts.at(-1).state,'delivered');assert.equal(f.receipts.at(-1).id,id);
  assert.equal(f.snapshots.at(-1).messages.at(-1).text,'First line\nSecond line.');
});
test('one bubble changing from temporary to saved identity confirms once without text comparison',async t=>{
  const f=await fixture(t,{autoConfirm:false});const id=randomUUID();
  f.command({id,threadId:DEFAULT_DOT,text:'display formatting may change'});await f.tick();
  const row=f.w.document.createElement('article');row.className='message-row self';row.dataset.messageId='temporary-id';
  row.innerHTML='<div class="message-text">Rendered presentation</div>';f.w.document.querySelector('main').append(row);
  await until(()=>f.receipts.some(r=>r?.state==='observed'&&r.messageId==='temporary-id'));
  assert.equal(f.receipts.some(r=>r?.state==='delivered'),false);
  row.dataset.messageId='room~room~CalpicoMessage~Saved';row.innerHTML+='<div aria-label="Message actions"></div>';
  await until(()=>f.receipts.some(r=>r?.state==='delivered'));
  assert.equal(f.receipts.at(-1).messageId,row.dataset.messageId);assert.equal(f.sends(),1);
});

test('browser editor formatting does not prevent clicking its enabled Send button',async t=>{
 const f=await fixture(t,{transformInput:true});const id=randomUUID();
 f.command({id,threadId:DEFAULT_DOT,text:'Line one\nLine two.  '});await f.tick();
 assert.equal(f.sends(),1);assert.equal(f.receipts.at(-1).state,'delivered');
});

test('delivered message keeps Dot working until a reply, including a thinking row without role=status',async t=>{
  const f=await fixture(t);f.command({id:randomUUID(),threadId:DEFAULT_DOT,text:'Keep working'});await f.tick();
  assert.equal(f.receipts.at(-1).state,'delivered');
  assert.equal(f.snapshots.at(-1).busy,true);assert.equal(f.snapshots.at(-1).canSend,false);
  const d=f.w.document,thinking=d.createElement('div');thinking.className='typing-indicator';thinking.dataset.visible='true';thinking.textContent='Thinking…';d.querySelector('main').append(thinking);
  const answer=d.createElement('article');answer.className='message-row assistant';answer.dataset.messageId='answer';
  answer.innerHTML='<div class="message-text">A reply</div>';d.querySelector('main').append(answer);
  await f.tick();assert.equal(f.snapshots.at(-1).busy,true);
  thinking.remove();await until(()=>f.snapshots.at(-1).busy===false);
  assert.equal(f.snapshots.at(-1).canSend,true);
  answer.classList.add('pending');await until(()=>f.snapshots.at(-1).busy===true);
  answer.classList.remove('pending');await until(()=>f.snapshots.at(-1).busy===false);
});

 test('the permanent but hidden typing row does not leave Dot stuck working',async t=>{
   const f=await fixture(t),row=f.w.document.createElement('div');
   row.className='typing-indicator';row.setAttribute('role','status');row.dataset.visible='false';row.textContent='Thinking';
   f.w.document.querySelector('main').append(row);await f.tick();assert.equal(f.snapshots.at(-1).busy,false);
   row.dataset.visible='true';await until(()=>f.snapshots.at(-1).busy===true);
   row.dataset.visible='false';await until(()=>f.snapshots.at(-1).busy===false);
 });

test('a different Dot retains its own pending delivery without blocking this one',async t=>{
 const key='22222222-2222-4222-8222-222222222222:pendingDelivery';
 const storage={[key]:{id:randomUUID(),baseline:[],text:'Other conversation'}};
 const f=await fixture(t,{storage});await f.tick();
 assert.equal(f.snapshots.at(-1).canSend,true);assert.equal(f.sends(),0);assert.equal(storage[key].text,'Other conversation');
});
