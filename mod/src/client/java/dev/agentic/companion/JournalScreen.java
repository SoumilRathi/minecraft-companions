package dev.agentic.companion;

import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.MultiLineEditBox;
import net.minecraft.client.gui.components.PlayerFaceExtractor;
import net.minecraft.client.gui.narration.NarrationElementOutput;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.PreeditEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.util.FormattedCharSequence;

/** A fixed design canvas, independent of the user's Minecraft GUI scale. */
abstract class JournalScreen extends Screen {
    static final int INK = 0xFF382E25, MUTED = 0xFF807059, GOLD = 0xFFBDA16B;
    static final int GREEN = 0xFF356359, PAPER = 0xFFF0E5CB;
    protected float scale, originX, originY;
    private float guiPixels, pixelsPerUnit;
    JournalScreen(String title) { super(Component.literal(title)); }
    @Override protected final void init() {
        scale = Math.min(width / 1000f, height / 650f) * .96f;
        originX = (width - 1000 * scale) / 2;
        originY = (height - 650 * scale) / 2;
        guiPixels = minecraft.getWindow().getGuiScale();
        pixelsPerUnit = scale * guiPixels;
        arrange();
    }
    protected abstract void arrange();
    protected abstract void drawJournal(GuiGraphicsExtractor g, int mx, int my, float delta);
    protected void conversationFrame(GuiGraphicsExtractor g, CompanionKind kind) {
        frame(g,54,34,883,580);
        g.fill(35,102,53,184,kind.accent()); diamond(g,44,187,9,kind.accent()); diamond(g,44,117,4,GOLD);
    }
    protected void conversationHeading(GuiGraphicsExtractor g, CompanionKind kind, String title, String folder) {
        portrait(g,kind,93,68,37);
        heading(g,title,148,65,1.8f);
        String project=displayFolder(kind,folder);
        if(!project.isBlank()) {
            int x=148+(int)Math.ceil(font.width(title)*textScale(1.8f))+20;
            g.fill(x-10,66,x-9,79,0x509C8155);
            label(g,font.plainSubstrByWidth(project,Math.max(0,(int)((750-x)/textScale(1)))),x,69,MUTED);
        }
    }
    protected static String displayFolder(CompanionKind kind, String value) {
        String folder=value.trim();
        if(kind==CompanionKind.CLAUDE) {
            String path=folder.replace('\\','/');
            if(path.contains("/Claude/scratch-workspaces/") ||
                path.matches("(?:.*/)?scratch-\\d{4}-\\d{2}-\\d{2}-[a-fA-F0-9]+/?"))return "";
        }
        return folder;
    }
    @Override public final void extractRenderState(GuiGraphicsExtractor g, int mx, int my, float delta) {
        g.fill(0, 0, width, height, 0x66100D0A);
        int x = (int)((mx - originX) / scale), y = (int)((my - originY) / scale);
        g.pose().pushMatrix();
        g.pose().translate(originX, originY); g.pose().scale(scale, scale);
        drawJournal(g, x, y, delta);
        super.extractRenderState(g, x, y, delta);
        g.pose().popMatrix();
    }
    protected MouseButtonEvent local(MouseButtonEvent e) {
        return new MouseButtonEvent((e.x() - originX) / scale, (e.y() - originY) / scale, e.buttonInfo());
    }
    @Override public final boolean mouseClicked(MouseButtonEvent e, boolean twice) { return clickLocal(local(e), twice); }
    protected boolean clickLocal(MouseButtonEvent e, boolean twice) { return super.mouseClicked(e, twice); }
    @Override public boolean mouseReleased(MouseButtonEvent e) { return super.mouseReleased(local(e)); }
    @Override public boolean mouseDragged(MouseButtonEvent e, double dx, double dy) { return super.mouseDragged(local(e), dx / scale, dy / scale); }
    @Override public void mouseMoved(double x, double y) { super.mouseMoved((x - originX) / scale, (y - originY) / scale); }
    @Override public final boolean mouseScrolled(double x, double y, double horizontal, double vertical) {
        return scrollLocal((x - originX) / scale, (y - originY) / scale, horizontal, vertical);
    }
    protected boolean scrollLocal(double x, double y, double horizontal, double vertical) { return super.mouseScrolled(x, y, horizontal, vertical); }
    @Override public boolean isPauseScreen() { return true; }

    protected float textScale(float requested) { return Math.max(1, (float)Math.ceil(pixelsPerUnit * requested - .0001f)) / pixelsPerUnit; }
    protected float bodyTextScale() { return Math.max(1, (float)Math.ceil(pixelsPerUnit - .0001f) + JournalPreferences.index - 1) / pixelsPerUnit; }
    private float pixelX(float x) { return (Math.round((originX + x * scale) * guiPixels) / guiPixels - originX) / scale; }
    private float pixelY(float y) { return (Math.round((originY + y * scale) * guiPixels) / guiPixels - originY) / scale; }
    protected void textAt(GuiGraphicsExtractor g, FormattedCharSequence text, float x, float y, float size, int color) {
        g.pose().pushMatrix(); g.pose().translate(pixelX(x), pixelY(y)); g.pose().scale(size, size);
        g.text(font, text, 0, 0, color, false); g.pose().popMatrix();
    }
    protected void label(GuiGraphicsExtractor g, String text, int x, int y, int color) { textAt(g, Component.literal(text).getVisualOrderText(), x, y, textScale(1), color); }
    protected void heading(GuiGraphicsExtractor g, String text, int x, int y, float size) {
        textAt(g, Component.literal(text).getVisualOrderText(), x, y, textScale(size), INK);
    }
    protected void portrait(GuiGraphicsExtractor g, CompanionKind kind, int x, int y, int size) {
        g.fill(x - 4, y - 4, x + size + 4, y + size + 4, 0xFF4A493B);
        g.outline(x - 5, y - 5, size + 10, size + 10, GOLD);
        PlayerFaceExtractor.extractRenderState(g, CompanionSkins.forKind(kind), x, y, size);
    }
    static void diamond(GuiGraphicsExtractor g, int x, int y, int radius, int color) {
        for (int i = -radius; i <= radius; i++) {
            int half = radius - Math.abs(i); g.fill(x - half, y + i, x + half + 1, y + i + 1, color);
        }
    }
    protected void frame(GuiGraphicsExtractor g, int x, int y, int w, int h) {
        g.fill(x + 8, y + 10, x + w + 8, y + h + 10, 0x55000000);
        g.fill(x - 8, y - 8, x + w + 8, y + h + 8, 0xFF29201C);
        g.fill(x - 5, y - 5, x + w + 5, y + h + 5, 0xFF4D382A);
        g.outline(x - 3, y - 3, w + 6, h + 6, 0xFF785738);
        g.fillGradient(x, y, x + w, y + h, 0xFFF4EAD3, 0xFFE9DABC);
        // Quiet paper grain; generated by primitives, with no external assets.
        for (int i = 0; i < w * h / 600; i++) {
            int px = x + 3 + Math.floorMod(i * 173 + 23, w - 6);
            int py = y + 3 + Math.floorMod(i * 97 + 71, h - 6);
            g.fill(px, py, px + 1, py + 1, 0x127B6142);
        }
        g.outline(x + 5, y + 5, w - 10, h - 10, 0x668E7045);
        for (int cx : new int[]{x + 12, x + w - 13}) for (int cy : new int[]{y + 12, y + h - 13}) diamond(g, cx, cy, 3, GOLD);
        g.fill(x + 17, y + 22, x + 20, y + h - 22, 0x20795436);
    }
    protected JournalButton button(String text, int x, int y, int w, int h, boolean primary, Runnable action) {
        return addRenderableWidget(new JournalButton(text, x, y, w, h, primary, action));
    }
    protected final class JournalButton extends Button {
        private final boolean primary;
        boolean leftAligned, dropdown;
        JournalButton(String text, int x, int y, int w, int h, boolean primary, Runnable action) {
            super(x, y, w, h, Component.literal(text), b -> action.run(), DEFAULT_NARRATION);
            this.primary = primary;
        }
        @Override protected void extractContents(GuiGraphicsExtractor g, int mx, int my, float delta) {
            boolean hover = isHoveredOrFocused() && active;
            int bg = !active ? 0x22756750 : primary ? (hover ? 0xFF427568 : GREEN) : hover ? 0x308D744F : 0x087A6243;
            g.fill(getX(), getY(), getRight(), getBottom(), bg);
            g.outline(getX(), getY(), getWidth(), getHeight(), hover ? GOLD : primary && active ? 0xFF264B44 : 0x507E694A);
            int color = !active ? MUTED : primary ? PAPER : INK;
            float size = textScale(1);
            var message = Component.literal(font.plainSubstrByWidth(getMessage().getString(), Math.max(1,(int)((getWidth()-(dropdown?38:12))/size))));
            textAt(g, message.getVisualOrderText(), leftAligned ? getX()+8 : getX() + (getWidth() - font.width(message)*size) / 2,
                getY() + (getHeight() - 8*size) / 2, size, color);
            if(dropdown) {
                int x=getRight()-17,y=getY()+(getHeight()-6)/2;
                // Join both strokes in a two-pixel tip that survives GUI scaling.
                for(int i=0;i<5;i++) {
                    g.fill(x-4+i,y+i,x-2+i,y+i+2,color);
                    g.fill(x+4-i,y+i,x+6-i,y+i+2,color);
                }
            }
        }
    }

    /** Keep native editing, selection and wrapping in the same pixel-aligned coordinates as its text. */
    protected final class JournalInput extends AbstractWidget {
        final MultiLineEditBox editor;
        private final float textSize;
        JournalInput(int x, int y, int w, int h, String placeholder) {
            super(x,y,w,h,Component.literal(placeholder));
            textSize=textScale(1);
            editor=MultiLineEditBox.builder().setShowBackground(false).setShowDecorations(false)
                .setTextColor(INK).setCursorColor(GREEN).setTextShadow(false).setPlaceholder(Component.literal(placeholder))
                .build(font,(int)(w/textSize),(int)(h/textSize),Component.literal(placeholder));
        }
        private MouseButtonEvent inner(MouseButtonEvent e) {
            return new MouseButtonEvent((e.x()-pixelX(getX()))/textSize,(e.y()-pixelY(getY()))/textSize,e.buttonInfo());
        }
        @Override protected void extractWidgetRenderState(GuiGraphicsExtractor g,int mx,int my,float delta) {
            editor.active=active;
            g.pose().pushMatrix(); g.pose().translate(pixelX(getX()),pixelY(getY())); g.pose().scale(textSize,textSize);
            editor.extractRenderState(g,(int)((mx-pixelX(getX()))/textSize),(int)((my-pixelY(getY()))/textSize),delta);
            g.pose().popMatrix();
        }
        @Override public void onClick(MouseButtonEvent e,boolean twice) { editor.mouseClicked(inner(e),twice); }
        @Override protected void onDrag(MouseButtonEvent e,double dx,double dy) { editor.mouseDragged(inner(e),dx/textSize,dy/textSize); }
        @Override public void onRelease(MouseButtonEvent e) { editor.mouseReleased(inner(e)); }
        @Override public boolean mouseScrolled(double x,double y,double h,double v) { return editor.mouseScrolled((x-pixelX(getX()))/textSize,(y-pixelY(getY()))/textSize,h,v); }
        @Override public void setFocused(boolean focused) { super.setFocused(focused); editor.setFocused(focused); }
        @Override public boolean keyPressed(KeyEvent e) { return active && editor.keyPressed(e); }
        @Override public boolean charTyped(CharacterEvent e) { return active && editor.charTyped(e); }
        @Override public boolean preeditUpdated(PreeditEvent e) { return active && editor.preeditUpdated(e); }
        @Override public boolean capturesInput() { return editor.capturesInput(); }
        @Override public void playDownSound(net.minecraft.client.sounds.SoundManager sounds) { }
        @Override protected void updateWidgetNarration(NarrationElementOutput output) { editor.updateNarration(output); }
        void setCharacterLimit(int limit) { editor.setCharacterLimit(limit); }
        void setValue(String value) { editor.setValue(value); }
        String getValue() { return editor.getValue(); }
        void setValueListener(java.util.function.Consumer<String> listener) { editor.setValueListener(listener); }
    }
}
