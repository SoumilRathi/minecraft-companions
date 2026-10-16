// Exercise the actual BridgeClient against HTTP, with only game scheduling stubbed.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'agentic-send-'));
const java=path.join(process.env.JAVA_HOME,'bin');
const gson=process.env.GSON_JAR;
if(!gson)throw Error('Run this test through Gradle.');
const sources={
'net/fabricmc/loader/api/FabricLoader.java':`package net.fabricmc.loader.api; public class FabricLoader {public static FabricLoader getInstance(){return new FabricLoader();} public java.nio.file.Path getConfigDir(){return java.nio.file.Path.of(System.getProperty("fixture.config"));}}`,
'net/minecraft/client/Minecraft.java':`package net.minecraft.client; public class Minecraft {static final Minecraft M=new Minecraft(); public Object level,player; private final java.util.concurrent.ExecutorService queue=java.util.concurrent.Executors.newSingleThreadExecutor(); public static Minecraft getInstance(){return M;} public void execute(Runnable r){queue.execute(r);} public void run(Runnable r)throws Exception{queue.submit(r).get();} public void close(){queue.shutdownNow();}}`,
'dev/agentic/companion/CompanionKind.java':`package dev.agentic.companion; enum CompanionKind {CODEX("codex"),CLAUDE("claude"),DOT("dot"); final String key;CompanionKind(String k){key=k;}}`,
'dev/agentic/companion/BridgeLauncher.java':`package dev.agentic.companion; class BridgeLauncher {static String ensureStarted(){return "Reconnecting";}}`,
};
try {
 const files=[];for(const [name,body]of Object.entries(sources)){const file=path.join(dir,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);files.push(file);}
 const main=path.join(root,'mod/src/client/java/dev/agentic/companion/');
 execFileSync(path.join(java,'javac'),['-cp',gson,'-d',dir,...files,...['BridgeClient','ChatStateStore','OutgoingMessage','CompanionSignals','ReplyTracker'].map(n=>main+n+'.java'),path.join(root,'mod/src/test/java/dev/agentic/companion/ChatSendTest.java')],{stdio:'inherit'});
 execFileSync(path.join(java,'java'),['-Dfixture.config='+dir,'-cp',dir+path.delimiter+gson,'dev.agentic.companion.ChatSendTest'],{stdio:'inherit'});
}finally{fs.rmSync(dir,{recursive:true,force:true});}
