package dev.agentic.companion;

/** State transitions kept independent of Minecraft so reconnect/read behavior is testable. */
final class ReplyTracker {
    enum State { OFFLINE, ATTENTION, WORKING, READY, IDLE }
    private String thread = "", latest = "", read = "";
    private boolean online, busy, attention, initialized;
    void update(String thread, boolean online, boolean busy, boolean attention, String latest, String savedRead) {
        this.online = online; this.busy = busy; this.attention = attention;
        if (!online || latest == null) return; // Unknown/older snapshots must not erase or initialize unread history.
        if (!initialized || !this.thread.equals(thread)) {
            this.thread = thread; read = savedRead == null ? latest : savedRead; initialized = true;
        }
        this.latest = latest;
    }
    State state() {
        if (!online) return State.OFFLINE;
        if (attention) return State.ATTENTION;
        if (busy) return State.WORKING;
        return !latest.isEmpty() && !latest.equals(read) ? State.READY : State.IDLE;
    }
    boolean markRead(String displayedReply) {
        if (!online || displayedReply.isEmpty() || !displayedReply.equals(latest) || read.equals(latest)) return false;
        read = latest; return true;
    }
    String readId() { return read; }
    String threadId() { return thread; }
    String latestId() { return latest; }
}
