package dev.agentic.companion;

import java.util.ArrayDeque;
import java.util.Deque;

/** Local undo only. Cleared whenever the draft is sent, discarded, or replaced. */
final class DraftHistory {
    record Snapshot(String text, int cursor, int anchor) { }
    private final Deque<Snapshot> undo = new ArrayDeque<>(), redo = new ArrayDeque<>();
    private Snapshot last;
    private long lastTime;
    private boolean typing;
    void record(Snapshot before, Snapshot after, boolean typed, long time) {
        if (before.text.equals(after.text)) { if (!before.equals(after)) typing = false; return; }
        if (!(typed && typing && before.equals(last) && time - lastTime < 750)) {
            undo.addLast(before); if (undo.size() > 100) undo.removeFirst();
        }
        redo.clear(); last = after; lastTime = time; typing = typed;
    }
    Snapshot undo(Snapshot current) {
        typing = false;
        if (undo.isEmpty()) return current;
        redo.addLast(current); return undo.removeLast();
    }
    Snapshot redo(Snapshot current) {
        typing = false;
        if (redo.isEmpty()) return current;
        undo.addLast(current); return redo.removeLast();
    }
    void reset() { undo.clear(); redo.clear(); last = null; typing = false; }
}
