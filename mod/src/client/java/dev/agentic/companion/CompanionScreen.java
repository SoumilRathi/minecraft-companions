package dev.agentic.companion;

import java.util.ArrayList;
import java.util.List;
import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.network.chat.Style;
import net.minecraft.util.FormattedCharSequence;

/** Right-click journal: the conversation occupies the page, actions stay contextual. */
public final class CompanionScreen extends JournalScreen {
    private static final int LEFT = 98, RIGHT = 886, TOP = 139, BOTTOM = 474, PAGE_WIDTH = RIGHT - LEFT;
    private JournalInput input;
    private MacComposer editing;
    private final java.util.Map<String, Float> messageEnds = new java.util.HashMap<>();
    private final java.util.Map<String, Float> messageStarts = new java.util.LinkedHashMap<>();
    private JournalButton send, latest, conversations;
    private String viewThread="";
    private boolean bookmarkPending=true;
    private final List<Ink> ink = new ArrayList<>();
    private final List<Box> boxes = new ArrayList<>();
    private final List<Copy> copies = new ArrayList<>();
    private String cachedMessages = "", flash = "";
    private com.google.gson.JsonObject cachedState;
    private long flashUntil;
    private float cursor, contentHeight, scroll;
    private boolean draggingScrollbar;
    private OutgoingMessage cachedOutgoing;
    private final List<Float> sendingMarks=new ArrayList<>();
    private final List<Float> failedActions=new ArrayList<>();
    private record Ink(FormattedCharSequence text, float x, float y, float size, int color) { }
    private record Box(float x, float y, float w, float h, int color) { }
    private record Copy(float y, String text) { }
    private final CompanionKind kind;
    private final BridgeClient bridge;
    public CompanionScreen(CompanionKind kind) { super(kind.label+" journal"); this.kind=kind;this.bridge=kind.bridge(); }

    @Override protected void arrange() {
        input = addRenderableWidget(new JournalInput(99,526,683,48,"Write to "+kind.label+"..."));
        input.setCharacterLimit(4000); input.setValue(bridge.draft);
        input.setValueListener(value -> { if (viewThread.equals(bridge.activeThread) && !bridge.switching) bridge.draft = value; });
        editing = new MacComposer(input.editor);
        send = button("Send", 799, 535, 88, 30, true, this::sendCurrent);
        conversations=button("Choose a conversation",148,99,537,20,false,()->{
            rememberReading();
            if(bridge.saveDraft()) minecraft.gui.setScreen(new SessionPickerScreen(kind));
            else {bridge.problem=true;bridge.notice="Could not save your draft. The conversation has not changed.";}
        });
        conversations.leftAligned=true; conversations.dropdown=true;
        button(JournalPreferences.label(), 757, 62, 116, 22, false, () -> {
            JournalPreferences.cycle(); cachedMessages = ""; rebuildWidgets();
        });
        button("x", 892, 62, 22, 22, false, this::onClose);
        button("Dismiss companion", 625, 585, 174, 20, false, () -> {
            var result = CompanionClient.dismiss(kind);
            if (result.success()) onClose();
            else { bridge.problem = true; bridge.notice = result.message(); }
        });
        latest = button("Return to latest", 742, 446, 134, 21, false, () -> scroll = maxScroll());
        cachedMessages = ""; cachedState = null; setInitialFocus(input); tick();
    }
    @Override public void tick() {
        bridge.tick();
        if(!viewThread.equals(bridge.activeThread)) {
            viewThread=bridge.activeThread;bookmarkPending=true;cachedState=null;cachedMessages="";
            ink.clear();boxes.clear();copies.clear();messageEnds.clear();messageStarts.clear();contentHeight=0;scroll=0;
            editing.reset();
        }
        boolean locked = bridge.switching || bridge.activeThread.isEmpty();
        if (!input.getValue().equals(bridge.draft)) { input.setValue(bridge.draft); editing.reset(); }
        input.active = !locked;
        if (locked && input.isFocused()) { input.setFocused(false); setFocused(null); }
        send.setMessage(Component.literal("Send"));
        send.active = bridge.canSend() && !bridge.draft.isBlank();
        conversations.visible=kind!=CompanionKind.DOT;
        conversations.active=conversations.visible&&!bridge.sending&&!bridge.switching;
        conversations.setMessage(Component.literal(font.plainSubstrByWidth(
            BridgeClient.string(bridge.state,"title","Choose a conversation"),conversations.getWidth()-38)));
        latest.visible = scroll < maxScroll() - 25;
    }
    @Override public boolean keyPressed(KeyEvent event) {
        if ((event.keycode() == InputConstants.KEYCODE_RETURN || event.keycode() == InputConstants.KEYCODE_NUMPADENTER)
                && input.isFocused() && !event.hasShiftDown()) { sendCurrent(); return true; }
        if (input.isFocused() && input.active) {
            if (editing.keyPressed(event)) return true;
            var before = editing.snapshot(); boolean handled = super.keyPressed(event); editing.record(before, false); return handled;
        }
        return super.keyPressed(event);
    }
    private void sendCurrent() {
        if(viewThread.equals(bridge.activeThread)) {
            var previous=bridge.outgoing;bridge.send();
            if(previous!=bridge.outgoing)scroll=maxScroll();
            input.setValue(bridge.draft);editing.reset();setInitialFocus(input);
        }
    }
    @Override public boolean charTyped(CharacterEvent event) {
        var before = input.isFocused() && input.active ? editing.snapshot() : null;
        boolean handled = super.charTyped(event); editing.record(before, true); return handled;
    }
    private void rememberReading() {
        if(bookmarkPending||!viewThread.equals(bridge.activeThread))return;
        bridge.savedScroll=scroll;bridge.followLatest=scroll>=maxScroll()-8;
        bridge.savedAnchor="";bridge.savedOffset=0;
        for(var entry:messageStarts.entrySet())if(entry.getValue()<=scroll) {
            bridge.savedAnchor=entry.getKey();bridge.savedOffset=scroll-entry.getValue();
        }
    }
    @Override public void removed() { rememberReading(); bridge.saveDraft(); super.removed(); }
    private float maxScroll() { return Math.max(0, contentHeight - (BOTTOM - TOP)); }
    @Override protected boolean scrollLocal(double x, double y, double horizontal, double vertical) {
        if (x >= LEFT && x <= RIGHT + 25 && y >= TOP && y <= BOTTOM) {
            scroll = Math.clamp(scroll - (float)vertical * 32, 0, maxScroll()); return true;
        }
        return super.scrollLocal(x, y, horizontal, vertical);
    }
    @Override protected boolean clickLocal(MouseButtonEvent event, boolean twice) {
        if (event.button() == InputConstants.MOUSE_BUTTON_LEFT && event.x() >= RIGHT + 10 && event.x() <= RIGHT + 22 && event.y() >= TOP && event.y() <= BOTTOM) {
            draggingScrollbar = true; setScrollFromPointer(event.y()); return true;
        }
        if (event.button()==InputConstants.MOUSE_BUTTON_LEFT && event.y()>=TOP && event.y()<BOTTOM) {
            float y=(float)event.y()-TOP+scroll;
            for(float action:failedActions) if(y>=action-3&&y<=action+13) {
                if(event.x()>=LEFT+90&&event.x()<=LEFT+135){bridge.retryOutgoing();return true;}
                if(event.x()>=LEFT+150&&event.x()<=LEFT+200){bridge.removeFailed();return true;}
            }
        }
        if (super.clickLocal(event, twice)) return true;
        if (event.button() == InputConstants.MOUSE_BUTTON_LEFT && event.x() >= RIGHT - 53 && event.x() <= RIGHT && event.y() >= TOP && event.y() < BOTTOM) {
            float y = (float)event.y() - TOP + scroll;
            for (Copy c : copies) if (y >= c.y - 3 && y <= c.y + 12) {
                minecraft.keyboardHandler.setClipboard(c.text); flash = "Copied to clipboard"; flashUntil = System.currentTimeMillis() + 2200; return true;
            }
        }
        if (event.button() == InputConstants.MOUSE_BUTTON_LEFT && event.x() >= LEFT && event.x() <= RIGHT && event.y() >= TOP && event.y() < BOTTOM) {
            float pageY = (float)event.y() - TOP + scroll;
            for (Ink t : ink) {
                float target = ((float)event.x() - LEFT - t.x) / t.size;
                if (pageY < t.y || pageY >= t.y + 10 * t.size || target < 0 || target >= font.width(t.text)) continue;
                float[] advance = {0}; Style[] found = {null};
                t.text.accept((index, style, codepoint) -> {
                    advance[0] += font.width(Component.literal(new String(Character.toChars(codepoint))).setStyle(style));
                    if (advance[0] > target) { found[0] = style; return false; } return true;
                });
                if (found[0] != null && found[0].getClickEvent() instanceof ClickEvent.OpenUrl url) {
                    defaultHandleClickEvent(url, minecraft, this); return true;
                }
            }
        }
        return false;
    }
    private void setScrollFromPointer(double y) { scroll = Math.clamp((float)((y - TOP) / (BOTTOM - TOP)) * maxScroll(), 0, maxScroll()); }
    @Override public boolean mouseDragged(MouseButtonEvent event, double dx, double dy) {
        if (draggingScrollbar) { setScrollFromPointer(local(event).y()); return true; }
        return super.mouseDragged(event, dx, dy);
    }
    @Override public boolean mouseReleased(MouseButtonEvent event) {
        if (draggingScrollbar) { draggingScrollbar = false; return true; }
        return super.mouseReleased(event);
    }

    private MutableComponent styled(String text, boolean heading) {
        MutableComponent result = Component.empty();
        for (var span : JournalMarkdown.inline(text)) {
            var style = Style.EMPTY.withBold(heading || span.bold()).withItalic(span.italic()).withStrikethrough(span.strike());
            if (span.code()) style = style.withColor(0x755431);
            if (span.link() != null) {
                style = style.withColor(0x356359).withUnderlined(true);
                try {
                    var uri = java.net.URI.create(span.link());
                    if ("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme()))
                        style = style.withClickEvent(new ClickEvent.OpenUrl(uri));
                } catch (IllegalArgumentException ignored) { }
            }
            result.append(Component.literal(span.text()).setStyle(style));
        }
        return result;
    }
    private void text(Component text, float x, float y, float size, int color) { ink.add(new Ink(text.getVisualOrderText(), x, y, size, color)); }
    private float wrap(Component text, float x, float y, float width, float size, int color) {
        size = snapTextScale(size);
        float start = y;
        for (var line : font.split(text, Math.max(8, (int)(width / size)))) {
            ink.add(new Ink(line, x, y, size, color)); y += 13 * size;
        }
        return Math.max(13 * size, y - start);
    }
    private void layout() {
        if (cachedState == bridge.state && cachedOutgoing==bridge.outgoing) return;
        cachedState = bridge.state;cachedOutgoing=bridge.outgoing;
        var displayed=bridge.displayMessages();
        String signature = displayed.toString();
        if (signature.equals(cachedMessages)) return;
        boolean follow = scroll >= maxScroll() - 8;
        cachedMessages = signature; ink.clear(); boxes.clear(); copies.clear(); messageEnds.clear(); messageStarts.clear();sendingMarks.clear();failedActions.clear(); cursor = 4;
        float size = bodyTextScale();
        for (var value : displayed) {
            var message = value.getAsJsonObject(); String role = message.get("role").getAsString(), raw = message.get("text").getAsString();
            messageStarts.put(BridgeClient.string(message,"id",""),cursor);
            boolean mine = role.equals("You");
            boxes.add(new Box(0, cursor, 3, 10, mine ? 0xFF9C793F : GREEN));
            text(Component.literal(mine ? "YOU" : kind.label.toUpperCase(java.util.Locale.ROOT)).withStyle(Style.EMPTY.withBold(true)), 13, cursor + 1, textScale(.9f), mine ? MUTED : GREEN);
            String delivery=BridgeClient.string(message,"outgoingStatus","");
            if(delivery.equals("pending")||delivery.equals("unknown"))sendingMarks.add(cursor+5);
            copies.add(new Copy(cursor, raw)); cursor += 25;
            for (var block : JournalMarkdown.blocks(raw)) {
                switch (block.kind()) {
                    case "space" -> cursor += 5 * size;
                    case "rule" -> { boxes.add(new Box(0, cursor + 4, PAGE_WIDTH, 1, 0x407E684A)); cursor += 15; }
                    case "heading" -> {
                        cursor += 6; float factor = block.level() == 1 ? 1.45f : block.level() == 2 ? 1.25f : 1.1f;
                        cursor += wrap(styled(block.text(), true), 0, cursor, PAGE_WIDTH, size * factor, INK) + 6;
                    }
                    case "list" -> {
                        float indent = block.level() * 15 * size;
                        text(Component.literal(block.detail()), indent, cursor, size, GREEN);
                        cursor += wrap(styled(block.text(), false), indent + 19 * size, cursor, PAGE_WIDTH - indent - 19 * size, size, INK) + 3;
                    }
                    case "quote" -> {
                        float h = wrap(styled(block.text(), false), 15, cursor + 5, PAGE_WIDTH - 30, size, MUTED) + 10;
                        boxes.add(new Box(0, cursor, PAGE_WIDTH, h, 0x107B6342)); boxes.add(new Box(0, cursor, 2, h, GOLD)); cursor += h + 3;
                    }
                    case "code" -> {
                        float start = cursor;
                        text(Component.literal(block.detail().isEmpty() ? "CODE" : block.detail()), 13, cursor + 10, textScale(.85f), 0xFFD6C19C);
                        copies.add(new Copy(cursor + 10, block.text())); cursor += 31;
                        for (String line : block.text().split("\n", -1)) cursor += wrap(Component.literal(line.replace("\t", "    ")), 13, cursor, PAGE_WIDTH - 26, size, 0xFFECE3CF);
                        cursor += 12; boxes.add(new Box(0, start, PAGE_WIDTH, cursor - start, 0xFF343B35));
                        boxes.add(new Box(0, start, PAGE_WIDTH, 25, 0xFF29312B)); cursor += 9;
                    }
                    case "table" -> {
                        String[] rows = block.text().split("\n"); int columns = Math.max(1, JournalMarkdown.cells(rows[0]).length);
                        float columnWidth = (float)PAGE_WIDTH / columns;
                        for (int r = 0; r < rows.length; r++) {
                            float h = 0; String[] cells = JournalMarkdown.cells(rows[r]);
                            for (int c = 0; c < Math.min(columns, cells.length); c++) h = Math.max(h,
                                wrap(styled(cells[c].strip(), r == 0), c * columnWidth + 8, cursor + 8, columnWidth - 16, size, INK));
                            boxes.add(new Box(0, cursor, PAGE_WIDTH, h + 16, r == 0 ? 0x20755A32 : r % 2 == 0 ? 0x08755A32 : 0x12755A32));
                            boxes.add(new Box(0, cursor + h + 15, PAGE_WIDTH, 1, 0x35755A32));
                            for (int c = 1; c < columns; c++) boxes.add(new Box(c * columnWidth, cursor, 1, h + 16, 0x25755A32));
                            cursor += h + 16;
                        }
                        cursor += 9;
                    }
                    default -> cursor += wrap(styled(block.text(), false), 0, cursor, PAGE_WIDTH, size, INK) + 2;
                }
            }
            if(delivery.equals("failed")) {
                cursor+=8;failedActions.add(cursor);
                text(Component.literal("Not sent"),0,cursor,textScale(.9f),0xFF985D48);
                text(Component.literal("Retry").withStyle(Style.EMPTY.withUnderlined(true)),90,cursor,textScale(.9f),bridge.canRetry()?GREEN:MUTED);
                text(Component.literal("Remove").withStyle(Style.EMPTY.withUnderlined(true)),150,cursor,textScale(.9f),MUTED);
                cursor+=16;
            } else if(delivery.equals("unknown")) {
                cursor+=8;text(Component.literal("Sending interrupted. Reconnecting…"),0,cursor,textScale(.9f),MUTED);cursor+=16;
            }
            messageEnds.put(BridgeClient.string(message, "id", ""), cursor);
            cursor += 20; boxes.add(new Box(0, cursor, PAGE_WIDTH, 1, 0x30816C4D)); cursor += 24;
        }
        contentHeight = cursor; scroll = follow ? maxScroll() : Math.min(scroll, maxScroll());
    }
    private void restoreReading() {
        if(bookmarkPending&&bridge.connected&&bridge.state.has("messages")) {
            scroll=bridge.followLatest ? maxScroll() : Math.clamp(
                messageStarts.containsKey(bridge.savedAnchor) ? messageStarts.get(bridge.savedAnchor)+bridge.savedOffset : bridge.savedScroll,0,maxScroll());
            bookmarkPending=false;
        }
    }

    private String connectionMessage() {
        if (kind == CompanionKind.CODEX && bridge.connectionPhase().equals("needsDesktop")) {
            String title = BridgeClient.string(bridge.state, "title", "");
            return title.isBlank() ? "Open this chat in the Codex app to connect."
                : "Open ‘" + title + "’ in the Codex app to connect.";
        }
        return bridge.connection;
    }

    @Override protected void drawJournal(GuiGraphicsExtractor g, int mx, int my, float delta) {
        layout(); restoreReading(); conversationFrame(g,kind);
        conversationHeading(g,kind,kind.label,kind==CompanionKind.DOT?"":BridgeClient.string(bridge.state,"project",""));
        if(kind==CompanionKind.DOT)label(g,"Your Dot conversation",148,104,MUTED);
        String status = !bridge.connected ? switch(bridge.connectionPhase()) {
            case "loading" -> "Loading history...";
            case "needsBrowser" -> "Open Dot in your browser";
            case "needsDesktop" -> "Open chat in "+kind.label;
            case "needsRemoteControl" -> "Enable Remote Control";
            case "needsLogin" -> "Claude sign-in needed";
            case "error" -> "Connection issue";
            case "reconnecting", "ready" -> "Reconnecting...";
            default -> "Connecting...";
        } : bridge.flag("needsAttention") ? "Needs your attention" : bridge.flag("busy") ? "Working..." : "Connected";
        int statusX = 886 - (int)Math.ceil(font.width(status)*textScale(1));
        diamond(g, statusX - 11, 108, 2, bridge.connected ? GREEN : GOLD); label(g, status, statusX, 104, MUTED);
        g.fill(88, 124, 904, 125, 0x609C8155);
        g.enableScissor(LEFT - 3, TOP, RIGHT + 2, BOTTOM);
        for (Box b : boxes) if (b.y + b.h >= scroll && b.y < scroll + BOTTOM - TOP) {
            g.fill(LEFT + (int)b.x, TOP + (int)(b.y - scroll), LEFT + (int)(b.x + b.w), TOP + (int)(b.y + b.h - scroll), b.color);
        }
        for (Ink t : ink) if (t.y + 12 * t.size >= scroll && t.y < scroll + BOTTOM - TOP) {
            textAt(g,t.text,LEFT+t.x,TOP+t.y-scroll,t.size,t.color);
        }
        for(float mark:sendingMarks) {
            int y=TOP+(int)(mark-scroll);
            if(y>=TOP&&y<BOTTOM)for(int i=0;i<3;i++) {
                int color=(System.currentTimeMillis()/180)%3==i?GREEN:0x607E684A;
                g.fill(LEFT+51+i*6,y,LEFT+54+i*6,y+3,color);
            }
        }
        for (Copy c : copies) {
            float y = TOP + c.y - scroll;
            if (y >= TOP && y + 12 < BOTTOM && my >= y - 4 && my <= y + 13) {
                g.fill(RIGHT - 51, (int)y - 3, RIGHT, (int)y + 12, 0xFFE0D1B3);
                label(g, "Copy", RIGHT - 40, (int)y, GREEN);
            }
        }
        if (ink.isEmpty()) {
            float size = textScale(1), y = TOP + 28;
            String message = bridge.connected ? "No messages yet." : connectionMessage();
            for (var line : font.split(Component.literal(message), Math.max(1, (int)(PAGE_WIDTH / size)))) {
                textAt(g, line, LEFT, y, size, MUTED);
                y += 13 * size;
            }
        }
        g.disableScissor();
        String reply = bridge.signals.tracker.latestId();
        Float end = messageEnds.get(reply);
        if (end != null && end >= scroll && end <= scroll + BOTTOM - TOP) bridge.signals.markRead(reply);
        if (maxScroll() > 0) {
            g.fill(RIGHT + 14, TOP, RIGHT + 16, BOTTOM, 0x287C6341);
            int thumb = Math.max(22, (int)((BOTTOM - TOP) * (BOTTOM - TOP) / contentHeight));
            int y = TOP + (int)(scroll / maxScroll() * (BOTTOM - TOP - thumb));
            g.fill(RIGHT + 13, y, RIGHT + 17, y + thumb, 0xAA8B7855);
        }
        latest.visible = scroll < maxScroll() - 25;
        String notice = "";
        if (System.currentTimeMillis() < flashUntil) notice = flash;
        else if (bridge.problem) notice = bridge.notice;
        else if (!bridge.connected) { if (!ink.isEmpty()) notice = connectionMessage(); }
        else if (bridge.flag("needsAttention")) notice = "Continue the requested action in the "+kind.label+" app.";
        label(g, font.plainSubstrByWidth(notice, (int)(PAGE_WIDTH/textScale(1))), LEFT, 496, MUTED);
        g.fill(88, 518, 903, 580, 0x50FFF8E7); g.outline(88, 518, 815, 62, 0x60907A55);
        label(g, "Enter to send   /   Shift + Enter for a new line", 99, 591, MUTED);
        label(g, "Esc to close", 823, 591, MUTED);
        rememberReading();
    }
}
