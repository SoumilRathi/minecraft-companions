chrome.storage.session.get('status',value=>{if(value.status)document.querySelector('#status').textContent=value.status;});

const id=globalThis.minecraftCompanionsDot?.id;
if(/^[a-f0-9-]{36}$/i.test(id??'')){const link=document.querySelector('#open');link.href='https://chatgpt.com/dots/'+id;link.hidden=false;}
