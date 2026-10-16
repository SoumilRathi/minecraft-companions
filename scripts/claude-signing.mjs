import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {X509Certificate,createPrivateKey} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const name='Agentic Claude Reconnect';
const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const fingerprint=pem=>new X509Certificate(pem).fingerprint.replaceAll(':','');

// Keep one signing key in the user's Keychain. App updates retain this identity
// instead of making Accessibility permission depend on each executable's hash.
export function signingIdentity(directory) {
  const file=path.join(directory,'claude-helper-signing.json');
  const keychain=path.join(os.homedir(),'Library/Keychains/login.keychain-db');
  let saved;try{saved=JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  let certificate;
  try{certificate=run('/usr/bin/security',['find-certificate','-c',name,'-p',keychain]);}
  catch(error){if(error.status!==44)throw error;}
  if(saved&&!certificate)throw Error('The Claude Reconnect signing key is missing from Keychain. Restore that key before rebuilding.');
  if(!certificate) {
    const temporary=fs.mkdtempSync(path.join(directory,'.claude-signing-'));
    const oldMask=process.umask(0o077);
    try {
      const config=path.join(temporary,'certificate.cnf'),key=path.join(temporary,'key.pem');
      const cert=path.join(temporary,'certificate.pem');
      fs.writeFileSync(config,`[req]\nprompt=no\ndistinguished_name=subject\nx509_extensions=signing\n[subject]\nCN=${name}\n[signing]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n`);
      run('/usr/bin/openssl',['req','-new','-newkey','rsa:2048','-nodes','-x509','-sha256','-days','3650',
        '-config',config,'-keyout',key,'-out',cert]);
      fs.writeFileSync(key,createPrivateKey(fs.readFileSync(key)).export({format:'pem',type:'pkcs1'}));
      // Temporary key material is private and removed immediately after import.
      // Only Apple's codesign tool receives access to the imported private key.
      run('/usr/bin/security',['import',key,'-k',keychain,'-f','openssl','-t','priv','-P','','-x','-T','/usr/bin/codesign']);
      run('/usr/bin/security',['add-certificates','-k',keychain,cert]);
      certificate=fs.readFileSync(cert,'utf8');
    } finally {process.umask(oldMask);fs.rmSync(temporary,{recursive:true,force:true});}
  }
  const identity=fingerprint(certificate);
  if(saved&&saved.identity!==identity)throw Error('The Claude Reconnect signing identity changed. Restore the original certificate before rebuilding.');
  if(!saved)fs.writeFileSync(file,JSON.stringify({identity,keychain}),{mode:0o600});
  return {identity,keychain,requirement:`identifier "dev.agentic.claude-reconnect" and certificate leaf = H"${identity}"`};
}
