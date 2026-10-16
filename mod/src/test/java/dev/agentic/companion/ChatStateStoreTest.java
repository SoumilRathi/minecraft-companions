package dev.agentic.companion;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

public final class ChatStateStoreTest {
    private static void check(boolean condition,String message) {if(!condition)throw new AssertionError(message);}
    public static void main(String[] args) throws Exception {
        Path config=Files.createTempDirectory("agentic-chat-state-");
        try {
            var store=new ChatStateStore(config);
            String a=UUID.randomUUID().toString(),b=UUID.randomUUID().toString(),delivery=UUID.randomUUID().toString();
            var first=new ChatStateStore.Snapshot("Uncertain message for A",delivery,240,false,"reply-A",17);
            var second=new ChatStateStore.Snapshot("Unsent draft for B",null,0,true,"",0);
            store.save(a,first);store.save(b,second);
            var restarted=new ChatStateStore(config);
            check(restarted.load(a,a).equals(first),"A retains its delivery ID and reading anchor");
            check(restarted.load(b,a).equals(second),"B has an independent draft and latest-reading preference");
            var typing=new ChatStateStore.Snapshot("My next draft",delivery,240,false,"reply-A",17,"Already sent.  ","pending");
            store.save(a,typing);
            check(restarted.load(a,a).equals(typing),"Next draft and outgoing message survive restart independently");
            var history=new com.google.gson.JsonArray();var message=new com.google.gson.JsonObject();
            message.addProperty("id","server-id");message.addProperty("deliveryId",delivery);message.addProperty("role","You");message.addProperty("text","Already sent.");history.add(message);
            check(typing.outgoing().display(history).size()==1,"Temporary message merges by identity despite trimmed text");
            check(typing.outgoing().display(new com.google.gson.JsonArray()).size()==1,"Outgoing message is visible before server history");
            store.save(a,new ChatStateStore.Snapshot(typing.text(),null,240,false,"reply-A",17,"","pending"));
            check(restarted.load(a,a).text().equals("My next draft"),"Acknowledgement preserves the next draft");
            Path v1=config.resolve("agentic-chats/"+a+".json");
            Files.writeString(v1,"{\"version\":1,\"threadId\":\""+a+"\",\"text\":\"Old pending. \",\"id\":\""+delivery+"\",\"scroll\":0,\"followLatest\":true,\"offset\":0}");
            var migrated=restarted.load(a,a);
            check(migrated.text().isEmpty()&&migrated.outgoing().text().equals("Old pending. "),"Version one pending draft moves to outgoing without losing text");
            store.save(a,ChatStateStore.Snapshot.empty());
            check(store.load(b,a).equals(second),"Clearing A cannot discard B");
            String c=UUID.randomUUID().toString();
            Files.writeString(config.resolve("agentic-companion-draft.json"),"{\"text\":\"Legacy pending\",\"id\":\""+delivery+"\",\"threadId\":\""+c+"\"}");
            check(store.load(UUID.randomUUID().toString(),a).text().isEmpty(),"Legacy draft cannot migrate into another conversation");
            check(store.load(c,a).deliveryId().equals(delivery),"Migration preserves uncertain delivery identity");
            check(Files.exists(config.resolve("agentic-companion-draft.json.migrated")),"Original legacy file preserved");
            Path broken=config.resolve("agentic-chats/"+b+".json");Files.writeString(broken,"{broken");
            try {store.load(b,a);throw new AssertionError("Invalid saved draft accepted");}catch(java.io.IOException expected){}
            check(Files.readString(broken).equals("{broken"),"Corrupt data cannot be silently replaced");
            try {store.load("../../other",a);throw new AssertionError("Unsafe filename accepted");}catch(IllegalArgumentException expected){}
            var permissions=Files.getPosixFilePermissions(config.resolve("agentic-chats/"+a+".json"));
            check(permissions.equals(java.nio.file.attribute.PosixFilePermissions.fromString("rw-------")),"Draft files are private");
            System.out.println("Per-chat drafts, delivery IDs, reading bookmarks, migration, and corruption preservation passed.");
        } finally {try(var paths=Files.walk(config)){for(var p:paths.sorted(java.util.Comparator.reverseOrder()).toList())Files.deleteIfExists(p);}}
    }
}
