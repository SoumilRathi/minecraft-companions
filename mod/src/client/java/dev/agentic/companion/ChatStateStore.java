package dev.agentic.companion;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;

/** Each conversation owns its draft, delivery ID, and reading bookmark. */
final class ChatStateStore {
    record Snapshot(String text, String deliveryId, float scroll, boolean followLatest, String anchor, float offset,
                    String outgoingText, String outgoingStatus) {
        Snapshot(String text,String deliveryId,float scroll,boolean followLatest,String anchor,float offset) {
            this(deliveryId==null?text:"",deliveryId,scroll,followLatest,anchor,offset,deliveryId==null?"":text,"pending");
        }
        OutgoingMessage outgoing() { return deliveryId==null?null:new OutgoingMessage(deliveryId,outgoingText,outgoingStatus); }
        Snapshot {
            if (text == null || text.length() > 4000 || !Float.isFinite(scroll) || scroll < 0 || !Float.isFinite(offset)
                || deliveryId != null && !deliveryId.matches("[a-fA-F0-9-]{36}")) throw new IllegalArgumentException("Invalid saved chat state");
            if(deliveryId!=null)new OutgoingMessage(deliveryId,outgoingText,outgoingStatus);
        }
        static Snapshot empty() { return new Snapshot("", null, 0, true, "", 0); }
    }
    private final Path directory, legacy;
    ChatStateStore(Path config) { directory=config.resolve("agentic-chats"); legacy=config.resolve("agentic-companion-draft.json"); }
    private Path file(String thread) {
        if (thread == null || !thread.matches("[a-fA-F0-9-]{36}")) throw new IllegalArgumentException("Invalid chat ID");
        return directory.resolve(thread + ".json");
    }
    private static String string(JsonObject data, String key, String fallback) {
        return !data.has(key) || data.get(key).isJsonNull() ? fallback : data.get(key).getAsString();
    }
    Snapshot load(String thread, String legacyThread) throws IOException {
        Path file=file(thread);
        try {
            if (!Files.exists(file)) {
                if (Files.exists(legacy)) {
                    var old=JsonParser.parseString(Files.readString(legacy)).getAsJsonObject();
                    if (thread.equals(string(old,"threadId",legacyThread))) {
                        var migrated=new Snapshot(string(old,"text",""),string(old,"id",null),0,true,"",0);
                        save(thread,migrated);
                        Files.move(legacy,legacy.resolveSibling(legacy.getFileName()+".migrated"),StandardCopyOption.REPLACE_EXISTING);
                        return migrated;
                    }
                }
                return Snapshot.empty();
            }
            if (Files.size(file)>65536) throw new IOException("Saved draft too large");
            var data=JsonParser.parseString(Files.readString(file)).getAsJsonObject();
            if (!thread.equals(string(data,"threadId","")) || (data.get("version").getAsInt()!=1 && data.get("version").getAsInt()!=2))
                throw new IOException("Saved draft belongs to a different chat or version");
            String id=string(data,"id",null),text=string(data,"text","");
            boolean old=data.get("version").getAsInt()==1;
            return new Snapshot(old&&id!=null?"":text,id,data.get("scroll").getAsFloat(),
                data.get("followLatest").getAsBoolean(),string(data,"anchor",""),data.get("offset").getAsFloat(),
                old&&id!=null?text:string(data,"outgoingText",""),string(data,"outgoingStatus","pending"));
        } catch (RuntimeException error) { throw new IOException("Could not read saved chat state",error); }
    }
    void save(String thread, Snapshot state) throws IOException {
        Path file=file(thread); Files.createDirectories(directory);
        var data=new JsonObject(); data.addProperty("version",2); data.addProperty("threadId",thread);
        data.addProperty("text",state.text()); data.addProperty("id",state.deliveryId());
        data.addProperty("outgoingText",state.outgoingText());data.addProperty("outgoingStatus",state.outgoingStatus());
        data.addProperty("scroll",state.scroll()); data.addProperty("followLatest",state.followLatest());
        data.addProperty("anchor",state.anchor()); data.addProperty("offset",state.offset());
        Path temp=Files.createTempFile(directory,"chat-",".tmp",PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        try { Files.writeString(temp,data.toString()); Files.move(temp,file,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING); }
        finally { Files.deleteIfExists(temp); }
    }
}
