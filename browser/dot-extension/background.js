// Only this extension can invoke the named native host. Page scripts have no API here.
let nativePort, pending=new Map(), owner=null, seen=0;
function host() {
  if(nativePort)return nativePort;
  const port=chrome.runtime.connectNative('dev.agentic.dot');nativePort=port;
  port.onMessage.addListener(message=>{
    if(message.type==='poll') {
      if(owner!==null)void chrome.tabs.sendMessage(owner,{type:'poll'}).catch(()=>{owner=null;port.disconnect();});
      return;
    }
    const wait=pending.get(message.requestId);if(!wait)return;
    pending.delete(message.requestId);clearTimeout(wait.timer);void chrome.storage.session.set({status:message.status});wait.resolve(message);
  });
  port.onDisconnect.addListener(()=>{
    void chrome.runtime.lastError;nativePort=null;
    for(const wait of pending.values()){clearTimeout(wait.timer);wait.resolve({status:'Run Minecraft Companions setup to connect your browser.'});}
    pending.clear();
  });
  return port;
}
chrome.runtime.onMessage.addListener((input,sender,reply)=>{
  if(sender.id!==chrome.runtime.id||sender.frameId!==0||!sender.tab||
    !/^https:\/\/chatgpt\.com\/dots\/[a-f0-9-]{36}$/.test(sender.url??'')||input?.type!=='exchange')return;
  if(owner!==null&&owner!==sender.tab.id&&Date.now()-seen<10000){reply({status:'Another Dot tab is connected.'});return;}
  owner=sender.tab.id;seen=Date.now();
  const requestId=crypto.randomUUID();
  const timer=setTimeout(()=>{pending.delete(requestId);reply({status:'Browser helper is not responding.'});},6000);
  pending.set(requestId,{resolve:reply,timer});
  try {host().postMessage({type:'exchange',requestId,snapshot:input.snapshot,receipt:input.receipt});}
  catch {clearTimeout(timer);pending.delete(requestId);reply({status:'Browser helper unavailable.'});}
  return true;
});
