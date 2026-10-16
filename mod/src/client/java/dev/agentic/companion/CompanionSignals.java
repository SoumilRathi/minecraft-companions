package dev.agentic.companion;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import net.fabricmc.loader.api.FabricLoader;

final class CompanionSignals {
    final ReplyTracker tracker = new ReplyTracker();
    private static final Path FILE = FabricLoader.getInstance().getConfigDir().resolve("agentic-read-replies.json");
    private final BridgeClient bridge;
    CompanionSignals(BridgeClient bridge) { this.bridge=bridge; }
    private String key(String thread) { return bridge.kind==CompanionKind.CODEX ? thread : bridge.kind.key+":"+thread; }
    private static JsonObject read = new JsonObject();
    static { try { read = JsonParser.parseString(Files.readString(FILE)).getAsJsonObject(); } catch (Exception ignored) { } }
    void observe() {
        var state = bridge.state;
        String thread = BridgeClient.string(state, "threadId", "");
        // Older bridges can still chat; they cannot safely identify completed replies.
        String completed = state.has("latestCompletedReplyId") ? BridgeClient.string(state, "latestCompletedReplyId", "") : null;
        tracker.update(thread, bridge.connected, bridge.flag("busy") || bridge.sending || (bridge.outgoing!=null && bridge.outgoing.status().equals("pending")), bridge.flag("needsAttention"), completed,
            read.has(key(thread)) ? read.get(key(thread)).getAsString() : null);
        if (bridge.connected && state.has("latestCompletedReplyId") && !read.has(key(thread))) saveRead();
    }
    void markRead(String id) { if (tracker.markRead(id)) saveRead(); }
    boolean unread(String thread,String latest) {
        return !latest.isEmpty() && read.has(key(thread)) && !latest.equals(read.get(key(thread)).getAsString());
    }
    private void saveRead() {
        if (tracker.threadId().isEmpty()) return;
        read.addProperty(key(tracker.threadId()), tracker.readId());
        try {
            Files.createDirectories(FILE.getParent()); Path temp = FILE.resolveSibling(FILE.getFileName() + ".tmp");
            Files.writeString(temp, read.toString()); Files.move(temp, FILE, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (Exception ignored) { }
    }
    int color() {
        return switch (tracker.state()) {
            case OFFLINE -> 0x9D9A90; case ATTENTION -> 0xE9B654;
            case WORKING -> 0xCDBB92; case READY -> 0x84CAB0; case IDLE -> 0xDCD4BC;
        };
    }
}
