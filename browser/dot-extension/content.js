// Operates on the rendered chat only, in Chrome's isolated content-script world.
// No cookies, tokens, application internals, private APIs or page-injected code.
(() => {
  const TARGET=globalThis.minecraftCompanionsDot?.id;
  if(!/^[a-f0-9-]{36}$/i.test(TARGET??''))return;
  const storageKey=name=>TARGET+':'+name;
  const URL=`https://chatgpt.com/dots/${TARGET}`;
  const editorSelector='[role="textbox"][aria-label="Message"]:is([contenteditable="true"],[contenteditable="plaintext-only"])';
  let disposed=false, running=false, inserting=false, activeReceipt=null, pending=null, pendingRow=null, inputVersion=0;
  let status='Connecting to your Dot.', dirty=false, forced=false, initialized=false, lastSnapshot='';
  document.addEventListener('input',e=>{if(e.isTrusted&&!inserting){inputVersion++;schedule();}},true);
  const normalize=text=>text.replace(/\r\n/g,'\n').replace(/\u00a0/g,' ');
  const visible=el=>!!el&&el.getClientRects().length>0;
  function markdown(node) {
    if(node.nodeType===3)return node.textContent;
    if(node.nodeType!==1)return '';
    if(node.matches('[data-markdown-copy="exclude"],button,svg'))return '';
    const body=()=>[...node.childNodes].map(markdown).join('');
    switch(node.tagName) {
      case 'BR':return '\n';
      case 'PRE':return '\n```\n'+(node.querySelector('code')??node).textContent+'\n```\n';
      case 'CODE':return '`'+node.textContent+'`';
      case 'STRONG':case 'B':return '**'+body()+'**';
      case 'EM':case 'I':return '*'+body()+'*';
      case 'A':{const href=node.getAttribute('href')??'';return /^https?:\/\//.test(href)?'['+body()+']('+href+')':body();}
      case 'LI':return '- '+body().trim()+'\n';
      case 'P':case 'UL':case 'OL':case 'BLOCKQUOTE':return body()+'\n\n';
      case 'H1':case 'H2':case 'H3':return '#'.repeat(Number(node.tagName[1]))+' '+body()+'\n\n';
      default:return body();
    }
  }
  function messages() {
    return [...document.querySelectorAll('article.message-row[data-message-id]')].slice(-60).map(article=>{
      const text=article.querySelector('.message-text');
      const mine=article.classList.contains('self');
      return {id:article.dataset.messageId,role:mine?'user':'assistant',
        text:normalize(text?(mine?text.innerText:markdown(text).trim()):'[Attachment]').slice(0,12000)};
    });
  }
  function composer() {
    const editors=[...document.querySelectorAll(editorSelector)].filter(visible);
    if(editors.length!==1)return null;
    const editor=editors[0],body=editor.closest('[data-composer-body]');
    const root=editor.closest('[data-composer-surface-variant]');
    const send=body?.querySelector('button[aria-label="Send"]');
    if(!body||!root||!send)return null;
    // Extra text/chips in the composer could be an attachment, reply, or another mode.
    // Fail closed rather than attaching it to a Minecraft message.
    const extra=[...body.children,...root.children].filter(el=>!el.contains(editor));
    const context=extra.some(el=>el.innerText?.trim()||el.querySelector('img,video,audio'))||
      [...body.querySelectorAll('button[aria-label]')].some(b=>!['Add files and more','Dictate','Send'].includes(b.getAttribute('aria-label')));
    return {editor,send,context};
  }
  function snapshot() {
    if(location.href!==URL)return null;
    const c=composer();
    const ready=!!c&&!!document.querySelector('button[aria-label="Your dot actions"],button[aria-label^="Open "][aria-label$="’s profile"]');
    // Dot's thinking row is a typing indicator/shimmer, not consistently role=status.
    // A delivered user message also means we are waiting, even before it appears.
    const history=messages(),last=history.at(-1);
    const thinking=[...document.querySelectorAll('.typing-indicator, [role="status"], [class*="shimmer" i]')]
      .some(e=>visible(e)&&!e.closest('article.message-row, [data-visible="false"]')&&
        (e.matches('.typing-indicator[data-visible="true"]')||/^Thinking(?:\.{3}|…)?$/i.test(e.textContent.trim())));
    const lastRow=[...document.querySelectorAll('article.message-row[data-message-id]')].at(-1);
    const streaming=last?.role==='assistant'&&!!lastRow?.matches('.pending, [aria-busy="true"]');
    const working=thinking||streaming||last?.role==='user';
    const occupied=!!c&&(!!c.editor.innerText.trim()||c.context);
    return {url:URL,threadId:TARGET,ready,busy:working||!!pending,messages:history,
      canSend:ready&&!working&&!pending&&!occupied,
      status:!ready?'Open your Dot and sign in to ChatGPT.':pending?'Confirming delivery…':occupied?'Finish or clear the draft in the your Dot browser tab.':working?'your Dot is thinking...':'Connected to your Dot.'};
  }
  async function persistReceipt(id,value) {
    activeReceipt={id,...value};
    await chrome.storage.local.set({[storageKey('receipt:'+id)]:value,[storageKey('lastReceipt')]:activeReceipt});
  }
  async function clearPending() {
    pending=null;pendingRow=null;await chrome.storage.local.remove(storageKey('pendingDelivery'));
  }
  // Rendering is the notification. A timeout is only a failure deadline, never
  // the normal path to enabling Send or recognizing an acknowledged message.
  function waitForComposer(version) {
    return new Promise(resolve=>{
      let timer;
      const finish=value=>{clearTimeout(timer);observer.disconnect();document.removeEventListener('input',check,true);resolve(value);};
      const check=()=>{
        const c=composer();
        if(location.href!==URL||version!==inputVersion||!c||!c.editor.innerText.trim()||c.context)return finish(null);
        if(!c.send.disabled)finish(c);
      };
      const observer=new MutationObserver(check);
      observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true});
      document.addEventListener('input',check,true);
      timer=setTimeout(()=>finish(null),3000);check();
    });
  }
  async function reconcile() {
    if(!pending||location.href!==URL)return;
    // Follow the newly created user row and its temporary -> saved identity.
    // Text is presentation: the site may trim spaces or render line breaks.
    const rows=[...document.querySelectorAll('article.message-row.self[data-message-id]')];
    let row=pendingRow?.isConnected?pendingRow:rows.find(r=>r.dataset.messageId===pending.observedId);
    if(!row) {
      const added=rows.filter(r=>!pending.baseline.includes(r.dataset.messageId));
      if(added.length!==1)return;
      row=added[0];
    }
    pendingRow=row;
    const m={id:row.dataset.messageId};
    if(pending.observedId!==m.id) {
      pending.observedId=m.id;
      await chrome.storage.local.set({[storageKey('pendingDelivery')]:pending});
      activeReceipt={id:pending.id,state:'observed',messageId:m.id};
    }
    pending.timing.browserBubbleAt??=Date.now();
    if(m.id.includes('~CalpicoMessage~'))pending.timing.browserServerIdAt??=Date.now();
    if(row?.querySelector('[aria-label="Message actions"]'))pending.timing.browserActionsAt??=Date.now();
    if(!m.id.includes('~CalpicoMessage~')||!row?.querySelector('[aria-label="Message actions"]'))return;
    pending.timing.browserConfirmedAt=Date.now();
    await persistReceipt(pending.id,{state:'delivered',messageId:m.id,timing:pending.timing});
    await clearPending();
  }
  async function execute(command) {
    if(command.threadId!==TARGET||!/^[a-f0-9-]{36}$/i.test(command.id)||typeof command.text!=='string'||!command.text.trim()||command.text.length>4000)return;
    const timing={browserReceivedAt:Date.now()};
    const previous=(await chrome.storage.local.get(storageKey('receipt:'+command.id)))[storageKey('receipt:'+command.id)];
    if(previous){activeReceipt={id:command.id,...previous};return;}
    const before=snapshot(),version=inputVersion;
    if(!before?.canSend){await persistReceipt(command.id,{state:'notSent'});return;}
    const delivery={id:command.id,text:command.text,baseline:before.messages.map(m=>m.id),timing};
    // Persist BEFORE any edit/click. Restart recovery only observes this ID;
    // it never re-enters text or clicks Send again.
    await chrome.storage.local.set({[storageKey('receipt:'+command.id)]:{state:'unknown'},[storageKey('pendingDelivery')]:delivery});
    pending=delivery;
    let c=composer();
    const reject=async()=>{await persistReceipt(command.id,{state:'notSent'});await clearPending();};
    if(location.href!==URL||version!==inputVersion||!c||c.editor.innerText.trim()||c.context){await reject();return;}
    c.editor.focus();
    const selection=getSelection(),range=document.createRange();range.selectNodeContents(c.editor);
    selection.removeAllRanges();selection.addRange(range);
    let inserted=false;
    try {inserting=true;inserted=document.execCommand('insertText',false,command.text);}
    finally {inserting=false;}
    timing.browserInsertedAt=Date.now();
    if(!inserted){await reject();return;}
    c=await waitForComposer(version);
    if(!c){await reject();return;}
    // Refresh the baseline immediately before our own click.
    pending.baseline=messages().map(m=>m.id);
    await chrome.storage.local.set({[storageKey('pendingDelivery')]:pending});
    c=composer();
    if(version!==inputVersion||!c||c.context||c.send.disabled||!c.editor.innerText.trim()){await reject();return;}
    timing.browserClickedAt=Date.now();c.send.click();
    // Do not hold the transport while waiting for acknowledgement. Future DOM
    // mutations reconcile the saved delivery, including after reload or >8 s.
    schedule();
  }
  function schedule(force=false) {
    if(disposed)return;
    dirty=true;forced ||= force;
    if(initialized&&!running)queueMicrotask(()=>void tick());
  }
  async function tick() {
    if(disposed||running||!initialized||location.href!==URL)return;
    running=true;
    try {
      while(!disposed&&dirty&&location.href===URL) {
        dirty=false;const force=forced;forced=false;
        await reconcile();
        const state=snapshot(),key=JSON.stringify(state);
        if(!force&&key===lastSnapshot&&!activeReceipt)continue;
        const receipt=activeReceipt;
        const response=await chrome.runtime.sendMessage({type:'exchange',snapshot:state,receipt});
        lastSnapshot=key;status=response?.status??'Browser helper disconnected.';
        if(receipt&&response?.receiptAccepted===receipt.id&&activeReceipt===receipt) {
          activeReceipt=null;await chrome.storage.local.remove(storageKey('lastReceipt'));
        }
        if(response?.command){await execute(response.command);dirty=true;}
      }
    } catch {lastSnapshot='';status='Your Dot connection interrupted; reconnecting.';}
    finally {running=false;}
  }
  const observer=new MutationObserver(()=>schedule());
  observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,
    attributeFilter:['disabled','aria-label','aria-busy','class','data-message-id','contenteditable','data-visible','data-active']});
  chrome.runtime.onMessage.addListener((input,_sender,reply)=>{
    if(input?.type==='status')reply({status});
    if(input?.type==='poll'){schedule(true);reply({ok:true});}
  });
  document.addEventListener('visibilitychange',()=>schedule(true));
  addEventListener('pagehide',()=>{disposed=true;observer.disconnect();});
  addEventListener('pageshow',()=>{if(disposed){disposed=false;observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true});schedule(true);}});
  chrome.storage.local.get([storageKey('lastReceipt'),storageKey('pendingDelivery')]).then(saved=>{
    activeReceipt=saved[storageKey('lastReceipt')]??null;pending=saved[storageKey('pendingDelivery')]??null;
    initialized=true;schedule(true);
  });
})();
