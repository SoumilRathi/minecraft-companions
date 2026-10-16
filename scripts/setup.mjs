import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
const jarName=`minecraft-companions-${version}.jar`;
const base=path.join(os.homedir(),'Library/Application Support/Minecraft Companions');
const json=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});};
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const node=(process.env.PATH??'').split(path.delimiter).map(dir=>path.join(dir,'node')).find(file=>{
 try{return fs.statSync(file).isFile()&&fs.realpathSync(file)===fs.realpathSync(process.execPath);}catch{return false;}
})??process.execPath;
const expand=value=>path.resolve(value.trim().replace(/^['"]|['"]$/g,'').replace(/^~(?=\/|$)/,os.homedir()));
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i++){if(args[i]==='--remove')options[args[i]]=true;else options[args[i]]=args[++i];}
async function stopConnection(game) {
 const file=path.join(game,'config/agentic-companion-bridge.json');
 if(!fs.existsSync(file))return;
 const c=JSON.parse(fs.readFileSync(file,'utf8'));
 if(!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(c.url))throw Error('Invalid local connection address.');
 let response;
 try {response=await fetch(c.url+'/shutdown',{method:'POST',headers:{Authorization:`Bearer ${c.token}`},signal:AbortSignal.timeout(3000)});}
 catch(error){if(error.cause?.code==='ECONNREFUSED')return;throw Error('Could not stop the current connection. Quit Minecraft and try again.');}
 if(!response.ok)throw Error(response.status===409?'A message is still being sent. Run setup again when it finishes.':'The older connection is still open. Quit Minecraft, wait two minutes, then run setup again.');
 for(let i=0;i<50;i++) {
   await new Promise(r=>setTimeout(r,100));
   try{await fetch(c.url+'/state',{headers:{Authorization:`Bearer ${c.token}`},signal:AbortSignal.timeout(500)});}catch{return;}
 }
 throw Error('The connection is still closing. Run setup again.');
}
if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('This release supports Apple silicon Macs.');
if(Number(process.versions.node.split('.')[0])<24)throw Error('Install Node.js 24 or newer, then run setup again.');
const rl=createInterface({input:process.stdin,output:process.stdout});
try {
 console.log('Minecraft Companions\nQuit Minecraft before installing.\n');
 const game=expand(options['--minecraft']??await rl.question('Minecraft game folder. In Finder, select it and press Option-Command-C, then paste here: '));
 if(!fs.existsSync(game)||!fs.statSync(game).isDirectory()||!fs.existsSync(path.join(game,'mods')))throw Error('Choose an existing Minecraft game folder with a mods folder. Start Fabric once if needed.');
 const folder=path.join(base,'instances',createHash('sha256').update(fs.realpathSync(game)).digest('hex').slice(0,16));
 await stopConnection(game);
 if(options['--remove']) {
   for(const name of fs.readdirSync(path.join(game,'mods')))if(/^(?:agentic-companion|minecraft-companions)-.*\.jar$/.test(name))fs.unlinkSync(path.join(game,'mods',name));
   const launch=path.join(game,'config/agentic-companion-launch.json');
   if(fs.existsSync(launch)){const c=JSON.parse(fs.readFileSync(launch,'utf8'));json(launch,{...c,enabled:false});}
   fs.rmSync(folder,{recursive:true,force:true});
   const registration=path.join(base,'dot-browser.json');
   if(fs.existsSync(registration)&&JSON.parse(fs.readFileSync(registration,'utf8')).configFile===path.join(game,'config/agentic-companion-bridge.json')) {
     for(const file of [registration,path.join(base,'dot-browser'),path.join(os.homedir(),'Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.agentic.dot.json')])fs.rmSync(file,{force:true});
   }
   console.log(`Removed from this game. Saved chat settings and placements remain in config.
Remove the Dot extension in Chrome if you use it. Quit Claude once to unload its connection code.
Claude Reconnect and its signing key are shared with other installations; keep them if you still use Claude elsewhere.`);
   process.exitCode=0;
 } else {
 const selected=options['--providers']??await rl.question('Companions to enable, separated by commas (codex, claude, dot): ');
 const providers=[...new Set(selected.toLowerCase().split(',').map(s=>s.trim()).filter(Boolean))];
 if(!providers.length||providers.some(p=>!['codex','claude','dot'].includes(p)))throw Error('Choose codex, claude, dot, or a comma-separated combination.');
 let dot,claudeProfile;
 if(providers.includes('dot')) {
   const url=options['--dot-url']??await rl.question('Your Dot conversation URL: ');
   const match=/^https:\/\/chatgpt\.com\/dots\/([a-f0-9-]{36})\/?$/i.exec(url.trim());
   if(!match)throw Error('Use the https://chatgpt.com/dots/... URL for your Dot.');
   dot={id:match[1],name:(options['--dot-name']??await rl.question('Dot name shown inside the chat [Dot]: ')).trim()||'Dot'};
   if(dot.name.length>60)throw Error('Use a Dot name 60 characters or fewer.');
 }
 if(providers.includes('claude')) {
   if(!fs.existsSync('/Applications/Claude.app'))throw Error('Install Claude in Applications before enabling it.');
   const {listProfiles,listDesktopSessions}=await import('../bridge/claude/catalog.mjs');
   const profiles=await listProfiles();
   if(profiles.length>1) {
     console.log('Claude profiles:');for(const [i,p] of profiles.entries()){const chats=await listDesktopSessions(p);console.log(`${i+1}. ${chats.slice(0,3).map(c=>c.title).join(' / ')}`);}
     const choice=Number(options['--claude-profile']??await rl.question('Which profile contains the chats you want to use? '));
     if(!profiles[choice-1])throw Error('Choose a profile number from the list.');
     claudeProfile=profiles[choice-1];
   }
   console.log('Claude support installs Claude Reconnect and signs it with a key in your Mac’s Keychain.\nGive Claude Reconnect Accessibility access so it can select Claude’s Developer menu.');
 }
 const jar=[path.join(root,jarName),path.join(root,'mod/build/libs',jarName)].find(file=>fs.existsSync(file));
 if(!jar)throw Error('Download the release ZIP, or run ./gradlew build in mod before setup.');
 if(!fs.existsSync(path.join(root,'node_modules/proper-lockfile')))throw Error('Run npm ci in this folder, then run setup again.');

 const staging=folder+'.installing';
 fs.rmSync(staging,{recursive:true,force:true});fs.mkdirSync(staging,{recursive:true,mode:0o700});
 try {
   for(const name of ['bridge','browser','scripts','node_modules','native'])if(fs.existsSync(path.join(root,name))) {
     fs.cpSync(path.join(root,name),path.join(staging,name),{recursive:true,filter:p=>!p.endsWith('.test.mjs')&&!p.endsWith('probe.mjs')});
   }
   if(providers.includes('claude'))execFileSync(process.execPath,[path.join(staging,'scripts/build-claude-helper.mjs')],{stdio:'inherit'});
   if(dot) {
     const extension=path.join(staging,'browser/dot-extension');
     fs.writeFileSync(path.join(extension,'config.js'),'globalThis.minecraftCompanionsDot = '+JSON.stringify(dot)+';\n');
     const manifest=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json'),'utf8'));
     manifest.content_scripts[0].matches=[`https://chatgpt.com/dots/${dot.id}*`];json(path.join(extension,'manifest.json'),manifest);
   }
   // A complete copy is ready before replacing an existing installation.
   const previous=folder+'.previous';fs.rmSync(previous,{recursive:true,force:true});
   if(fs.existsSync(folder))fs.renameSync(folder,previous);
   try {fs.renameSync(staging,folder);}catch(error){if(fs.existsSync(previous))fs.renameSync(previous,folder);throw error;}
   fs.rmSync(previous,{recursive:true,force:true});
 }finally{fs.rmSync(staging,{recursive:true,force:true});}
 const configDir=path.join(game,'config'),launchFile=path.join(configDir,'agentic-companion-launch.json');
 let previous={};if(fs.existsSync(launchFile))previous=JSON.parse(fs.readFileSync(launchFile,'utf8'));
 json(launchFile,{...previous,enabled:true,node,script:path.join(folder,'bridge/run.mjs'),providers,...(dot?{dot}:{}),...(claudeProfile?{claudeProfile}:{})});
 const installedJar=path.join(game,'mods',jarName);
 fs.copyFileSync(jar,installedJar+'.tmp');fs.renameSync(installedJar+'.tmp',installedJar);
 for(const name of fs.readdirSync(path.join(game,'mods')))if(/^(?:agentic-companion|minecraft-companions)-.*\.jar$/.test(name)&&name!==path.basename(installedJar))fs.unlinkSync(path.join(game,'mods',name));
 if(dot) {
   const extension=path.join(folder,'browser/dot-extension');
   const manifest=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json'),'utf8'));
   const extensionId=createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
   const host=path.join(base,'dot-browser');fs.mkdirSync(base,{recursive:true,mode:0o700});
   fs.writeFileSync(host,`#!/bin/sh\nexec ${quote(node)} ${quote(path.join(folder,'bridge/dot/native-host.mjs'))} "$@"\n`,{mode:0o700});fs.chmodSync(host,0o700);
   json(path.join(base,'dot-browser.json'),{configFile:path.join(configDir,'agentic-companion-bridge.json')});
   json(path.join(os.homedir(),'Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.agentic.dot.json'),
     {name:'dev.agentic.dot',description:'Minecraft Companions Dot connection',path:host,type:'stdio',allowed_origins:[`chrome-extension://${extensionId}/`]});
   console.log(`\nIn Chrome, open chrome://extensions, enable Developer mode, and choose Load unpacked.\nChoose this folder:\n${extension}\nThen open https://chatgpt.com/dots/${dot.id}`);
 }
 if(providers.includes('claude')){
   const {nativeAccess}=await import('../bridge/claude/desktop.mjs');
   const access=await nativeAccess(['--request-access']);
   if(!access.accessibility)console.log('\nIn System Settings → Privacy & Security → Accessibility, enable Claude Reconnect.\nIf it is missing, use + and select ~/Library/Application Support/Agentic Companion/Claude Reconnect.app.');
 }
 const optionsFile=path.join(game,'options.txt');
 if(fs.existsSync(optionsFile)&&/^key_key\.friends:key\.keyboard\.o$/m.test(fs.readFileSync(optionsFile,'utf8')))
   console.log('\nMinecraft also uses O for Friends List. In Options → Controls → Key Binds, assign Friends List to another key.');
 console.log(`\nInstalled in ${game}\nStart Minecraft, enter a world, and press O.`);
 }
}finally{rl.close();}
