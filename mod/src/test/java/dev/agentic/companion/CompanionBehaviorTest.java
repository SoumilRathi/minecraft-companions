package dev.agentic.companion;

public final class CompanionBehaviorTest {
    public static void main(String[] args) {
        var tracker = new ReplyTracker();
        tracker.update("a", true, false, false, null, null);
        check(tracker.state() == ReplyTracker.State.IDLE, "older bridge has no reply marker");
        tracker.update("a", true, false, false, "old", null);
        check(tracker.state() == ReplyTracker.State.IDLE, "first connect baselines old history");
        tracker.update("a", true, true, false, "old", "old");
        check(tracker.state() == ReplyTracker.State.WORKING, "working");
        tracker.update("a", true, true, true, "old", "old");
        check(tracker.state() == ReplyTracker.State.ATTENTION, "approval takes priority");
        tracker.update("a", true, false, false, "new", "old");
        check(tracker.state() == ReplyTracker.State.READY, "completed answer unread");
        check(!tracker.markRead("old"), "reading older history must not clear new reply");
        tracker.update("a", false, false, false, "", "old");
        check(tracker.state() == ReplyTracker.State.OFFLINE, "disconnect");
        check(!tracker.markRead("new"), "offline cannot mark stale view read");
        tracker.update("a", true, false, false, "new", "old");
        check(tracker.state() == ReplyTracker.State.READY, "reconnect retains unread");
        check(tracker.markRead("new"), "visible completed answer clears badge");
        check(tracker.state() == ReplyTracker.State.IDLE, "idle after reading");
        check(!tracker.markRead("new"), "repeat frames do not repeat receipt writes");
        var restarted = new ReplyTracker();
        restarted.update("a", true, false, false, "new", tracker.readId());
        check(restarted.state() == ReplyTracker.State.IDLE, "persisted read marker prevents repeat notification");
        restarted.update("b", true, false, false, "b-final", null);
        check(restarted.state() == ReplyTracker.State.IDLE, "chat switch baselines separately");
        var offlineReply = new ReplyTracker();
        offlineReply.update("a", true, false, false, "newer", "new");
        check(offlineReply.state() == ReplyTracker.State.READY, "answer completed while game was closed");

        check(MacTextNavigation.previousWord("hello world", 11) == 6, "previous word");
        check(MacTextNavigation.previousWord("hello world  ", 13) == 6, "skip trailing spaces");
        check(MacTextNavigation.nextWord("hello world", 0) == 5, "next word end");
        check(MacTextNavigation.nextWord("hello world", 5) == 11, "skip separator before next word");
        check(MacTextNavigation.previousWord("hello, world", 6) == 5, "punctuation boundary");
        check(MacTextNavigation.previousWord("a 😀", 4) == 2, "emoji surrogate pair intact");
        check(MacTextNavigation.previousWord("cafe\u0301", 5) == 0, "combining accent stays with word");
        check(MacTextNavigation.nextWord("", 0) == 0, "empty text");
        check(MacTextNavigation.previousWord("one\ntwo", 7) == 4, "word after newline");

        var history = new DraftHistory();
        var empty = new DraftHistory.Snapshot("", 0, 0);
        var h = new DraftHistory.Snapshot("h", 1, 1);
        var hi = new DraftHistory.Snapshot("hi", 2, 2);
        history.record(empty, h, true, 0); history.record(h, hi, true, 100);
        check(history.undo(hi).equals(empty), "typing groups into one undo");
        check(history.redo(empty).equals(hi), "redo restores text and caret");
        var selected = new DraftHistory.Snapshot("hi", 2, 0);
        history.record(selected, empty, false, 200);
        check(history.undo(empty).equals(selected), "undo deletion restores selection");
        history.record(selected, h, false, 300);
        check(history.redo(h).equals(h), "new edit clears redo branch");
        history.reset(); check(history.undo(h).equals(h), "sent draft cannot reappear through undo");
        System.out.println("Companion behavior checks passed: unread lifecycle, reconnect, word movement and undo/redo.");
    }
    private static void check(boolean value, String label) { if (!value) throw new AssertionError(label); }
}
