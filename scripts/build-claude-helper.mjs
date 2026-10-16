import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {signingIdentity} from './claude-signing.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(root,'bridge/claude/native/desktop-access.swift');
const outputIndex=process.argv.indexOf('--output');
const compileOnly=outputIndex>=0;
const directory=compileOnly?path.resolve(process.argv[outputIndex+1]):path.join(os.homedir(),'Library/Application Support/Agentic Companion');
const app=path.join(directory,'Claude Reconnect.app');
const binary=path.join(app,'Contents/MacOS/claude-desktop-access');
const manifest=path.join(directory,'claude-helper-build.json');
const plist=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.agentic.claude-reconnect</string>
<key>CFBundleName</key><string>Claude Reconnect</string>
<key>CFBundleExecutable</key><string>claude-desktop-access</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
</dict></plist>`;
const digest=data=>createHash('sha256').update(data).digest('hex');
const sourceHash=digest(fs.readFileSync(source)+'\n'+plist+'\n-O');
fs.mkdirSync(directory,{recursive:true,mode:0o700});
const prebuilt=path.join(root,'native/Claude Reconnect.app');
if(compileOnly) {
  fs.mkdirSync(path.dirname(binary),{recursive:true});
  fs.writeFileSync(path.join(app,'Contents/Info.plist'),plist);
  execFileSync('/usr/bin/xcrun',['swiftc','-O',source,'-o',binary],{stdio:'inherit'});
  console.log('Built the distributable Mac app.');
  process.exit(0);
}
const signing=signingIdentity(directory);
let saved;try{saved=JSON.parse(fs.readFileSync(manifest,'utf8'));}catch{}
if(saved?.sourceHash===sourceHash&&saved.signingIdentity===signing.identity&&fs.existsSync(binary)&&saved.binaryHash===digest(fs.readFileSync(binary))) {
  console.log('Claude reconnect helper is current.');
} else {
  const temporary=fs.mkdtempSync(path.join(directory,'.claude-build-'));
  const next=path.join(temporary,'Claude Reconnect.app'),previous=path.join(temporary,'previous.app');
  try {
    const executable=path.join(next,'Contents/MacOS/claude-desktop-access');
    fs.mkdirSync(path.dirname(executable),{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(next,'Contents/Info.plist'),plist);
    if(fs.existsSync(prebuilt))fs.copyFileSync(path.join(prebuilt,'Contents/MacOS/claude-desktop-access'),executable);
    else execFileSync('/usr/bin/xcrun',['swiftc','-O',source,'-o',executable],{stdio:'inherit'});
    fs.chmodSync(executable,0o755);
    execFileSync('/usr/bin/codesign',['--force','--sign',signing.identity,'--keychain',signing.keychain,
      '--identifier','dev.agentic.claude-reconnect','--requirements','=designated => '+signing.requirement,next],{stdio:'inherit'});
    execFileSync('/usr/bin/codesign',['--verify','--strict','--test-requirement','='+signing.requirement,next],{stdio:'inherit'});
    if(fs.existsSync(app))fs.renameSync(app,previous);
    try{fs.renameSync(next,app);}catch(error){if(fs.existsSync(previous))fs.renameSync(previous,app);throw error;}
    fs.writeFileSync(manifest,JSON.stringify({sourceHash,binaryHash:digest(fs.readFileSync(binary)),signingIdentity:signing.identity}),{mode:0o600});
    console.log('Claude Reconnect installed with its persistent signing identity.');
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
}
