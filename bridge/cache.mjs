import fs from 'node:fs';
import path from 'node:path';

// Disposable display data only. Never used to authorize a send or confirm one.
export function readCache(file) {
  if(!file)return null;
  try {return JSON.parse(fs.readFileSync(file,'utf8'));} catch {return null;}
}
export function writeCache(file,value) {
  if(!file)return;
  const temp=`${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600});fs.chmodSync(temp,0o600);
    fs.renameSync(temp,file);
  } catch {try{fs.unlinkSync(temp);}catch{}}
}
