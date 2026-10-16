import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;
if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('Package this release on an Apple silicon Mac.');
const name=`minecraft-companions-${version}-macos-arm64`,dist=path.join(root,'dist'),stage=path.join(dist,name);
execFileSync('./gradlew',['--no-daemon','build'],{cwd:path.join(root,'mod'),stdio:'inherit'});
fs.rmSync(stage,{recursive:true,force:true});fs.mkdirSync(stage,{recursive:true});
for(const name of ['bridge','browser','assets'])fs.cpSync(path.join(root,name),path.join(stage,name),{recursive:true,
  filter:p=>!p.endsWith('.test.mjs')&&!p.endsWith('probe.mjs')&&!p.endsWith('native')});
fs.mkdirSync(path.join(stage,'scripts'));
for(const name of ['setup.mjs','build-claude-helper.mjs','claude-signing.mjs'])fs.copyFileSync(path.join(root,'scripts',name),path.join(stage,'scripts',name));
for(const name of ['README.md','LICENSE','package.json','package-lock.json'])fs.copyFileSync(path.join(root,name),path.join(stage,name));
const jar=path.join(root,`mod/build/libs/minecraft-companions-${version}.jar`);
fs.copyFileSync(jar,path.join(stage,path.basename(jar)));
execFileSync(process.execPath,[path.join(root,'scripts/build-claude-helper.mjs'),'--output',path.join(stage,'native')],{stdio:'inherit'});
// The installer uses the source digest to keep an already installed app intact.
fs.mkdirSync(path.join(stage,'bridge/claude/native'),{recursive:true});
fs.copyFileSync(path.join(root,'bridge/claude/native/desktop-access.swift'),path.join(stage,'bridge/claude/native/desktop-access.swift'));
execFileSync('npm',['ci','--omit=dev','--ignore-scripts'],{cwd:stage,stdio:'inherit'});
// Wrapper code in the source retains its Apache header; bundled dependencies
// retain their LICENSE files in node_modules.
const archive=path.join(dist,name+'.zip');fs.rmSync(archive,{force:true});
execFileSync('/usr/bin/ditto',['-c','-k','--keepParent','--norsrc',stage,archive],{stdio:'inherit'});
const checksum=createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
fs.writeFileSync(path.join(dist,'SHA256SUMS'),`${checksum}  ${path.basename(archive)}\n`);
console.log(`Created ${archive}`);
