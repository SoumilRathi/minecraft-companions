package dev.agentic.companion;

import com.mojang.blaze3d.platform.InputConstants;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import net.minecraft.client.gui.components.MultiLineEditBox;
import net.minecraft.client.gui.components.MultilineTextField;
import net.minecraft.client.gui.components.Whence;
import net.minecraft.client.input.KeyEvent;

/** Adapts only this journal's widget; no global key mappings or vanilla patches. */
final class MacComposer {
    private static final boolean MAC = System.getProperty("os.name", "").startsWith("Mac");
    private static final Field TEXT_FIELD = findField();
    private static final Method BEGIN = findBound("beginIndex"), END = findBound("endIndex");
    private final MultilineTextField field;
    private final DraftHistory history = new DraftHistory();
    MacComposer(MultiLineEditBox widget) {
        MultilineTextField found = null;
        if (TEXT_FIELD != null && BEGIN != null && END != null) try { found = (MultilineTextField)TEXT_FIELD.get(widget); } catch (ReflectiveOperationException ignored) { }
        field = found;
        if (MAC && field == null) System.err.println("[Agentic] Composer shortcuts unavailable for this Minecraft version; using native editing.");
    }
    private static Field findField() {
        try { Field f = MultiLineEditBox.class.getDeclaredField("textField"); f.setAccessible(true); return f; }
        catch (ReflectiveOperationException | RuntimeException e) { return null; }
    }
    private static Method findBound(String name) {
        try {
            Method method = MultilineTextField.class.getMethod("getSelected").getReturnType().getMethod(name);
            method.setAccessible(true); return method;
        } catch (ReflectiveOperationException | RuntimeException e) { return null; }
    }
    private static int bound(Object view, boolean end) {
        try { return (int)(end ? END : BEGIN).invoke(view); }
        catch (ReflectiveOperationException e) { throw new IllegalStateException("Minecraft text selection API changed", e); }
    }
    DraftHistory.Snapshot snapshot() {
        if (!MAC || field == null) return null;
        var selected = field.getSelected();
        int anchor = field.cursor() == bound(selected, false) ? bound(selected, true) : bound(selected, false);
        return new DraftHistory.Snapshot(field.value(), field.cursor(), anchor);
    }
    void record(DraftHistory.Snapshot before, boolean typed) {
        if (before != null) history.record(before, snapshot(), typed, System.currentTimeMillis());
    }
    void reset() { history.reset(); }
    private void restore(DraftHistory.Snapshot state) {
        field.setValue(state.text());
        field.setSelecting(false); field.seekCursor(Whence.ABSOLUTE, state.anchor());
        field.setSelecting(true); field.seekCursor(Whence.ABSOLUTE, state.cursor()); field.setSelecting(false);
    }
    boolean keyPressed(KeyEvent event) {
        if (!MAC || field == null) return false;
        boolean command = (event.modifiers() & InputConstants.MOD_SUPER) != 0;
        boolean option = event.hasAltDown();
        if (command && !option && event.shortcutKey() == InputConstants.KEYCODE_Z) {
            restore(event.hasShiftDown() ? history.redo(snapshot()) : history.undo(snapshot())); return true;
        }
        if (!command && !option) return false;
        int key = event.keycode();
        boolean back = key == InputConstants.KEYCODE_BACKSPACE, delete = key == InputConstants.KEYCODE_DELETE;
        boolean left = key == InputConstants.KEYCODE_LEFT, right = key == InputConstants.KEYCODE_RIGHT;
        boolean up = key == InputConstants.KEYCODE_UP, down = key == InputConstants.KEYCODE_DOWN;
        if (!(back || delete || left || right || command && (up || down))) return false;
        var before = snapshot();
        if ((back || delete) && field.hasSelection()) field.insertText("");
        else {
            int target;
            if (command) {
                var line = field.getLineView(field.getLineAtCursor());
                target = up ? 0 : down ? field.value().length() : bound(line, !(back || left));
            } else target = back || left ? MacTextNavigation.previousWord(field.value(), field.cursor()) : MacTextNavigation.nextWord(field.value(), field.cursor());
            if (back || delete) {
                field.setSelecting(false); field.seekCursor(Whence.ABSOLUTE, field.cursor());
                field.setSelecting(true); field.seekCursor(Whence.ABSOLUTE, target); field.insertText(""); field.setSelecting(false);
            } else {
                field.setSelecting(event.hasShiftDown()); field.seekCursor(Whence.ABSOLUTE, target); field.setSelecting(false);
            }
        }
        record(before, false); return true;
    }
}
