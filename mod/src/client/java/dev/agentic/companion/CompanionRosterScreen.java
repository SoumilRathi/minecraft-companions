package dev.agentic.companion;

import net.minecraft.client.gui.GuiGraphicsExtractor;

/** O only invites characters. Conversations open by interacting in-world. */
public final class CompanionRosterScreen extends JournalScreen {
    private static final int ROW_TOP=234, ROW_STEP=68, ROW_HEIGHT=60;
    private String message="";
    public CompanionRosterScreen() { super("Companions"); }
    @Override protected void arrange() {
        int row=0;
        for(var kind:CompanionKind.enabledValues()) {
            button("Invite",626,ROW_TOP+row*ROW_STEP+18,70,24,false,()->{
                var result=CompanionClient.invite(kind);message=result.message();
                if(result.success())onClose();
            });row++;
        }
        button("x",696,179,20,20,false,this::onClose);
    }
    @Override protected void drawJournal(GuiGraphicsExtractor g,int mx,int my,float delta) {
        int extra=(CompanionKind.enabledValues().length-3)*ROW_STEP;
        frame(g,270,156,460,338+extra);
        heading(g,"Companions",304,191,1.85f);
        g.fill(303,220,697,221,0x409A825C);
        int row=0;
        for(var kind:CompanionKind.enabledValues()) {
            int y=ROW_TOP+row++*ROW_STEP;
            portrait(g,kind,310,y+(ROW_HEIGHT-28)/2,28);
            heading(g,kind.characterName(),358,y+(ROW_HEIGHT-10)/2,1.25f);
            if(row<CompanionKind.enabledValues().length)g.fill(303,y+ROW_HEIGHT+4,697,y+ROW_HEIGHT+5,0x209A825C);
        }
        if(message.isEmpty())label(g,"Esc to close",304,465+extra,MUTED);
        else {
            int y=446+extra;
            for(var line:font.split(net.minecraft.network.chat.Component.literal(message),392)) {
                g.text(font,line,304,y,0xFF914B37,false);y+=11;
            }
        }
    }
}
