package dev.agentic.companion;

import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.network.chat.Component;

/** A journal page for existing desktop chats, reached only from the conversation. */
final class SessionPickerScreen extends JournalScreen {
    private final List<JsonObject> sessions=new ArrayList<>();
    private final List<SessionRow> rows=new ArrayList<>();
    private EditBox search;
    private JournalButton more;
    private String query="", next="", error="";
    private long searchAt;
    private int offset, generation, total;
    private boolean loading, truncated;
    private String loadedQuery="";
    private int catalogVersion=-1;
    private final CompanionKind kind;
    private final BridgeClient bridge;
    SessionPickerScreen(CompanionKind kind) { super(kind.label+" journal"); this.kind=kind;this.bridge=kind.bridge(); var cached=bridge.cachedSessions("");if(cached!=null)applyList(cached,false); }
    @Override protected void arrange() {
        rows.clear();
        search=addRenderableWidget(new EditBox(font,103,153,666,23,Component.literal("Search conversations and folders")));
        search.setBordered(false); search.setTextColor(INK); search.setTextShadow(false); search.setMaxLength(200);
        // Vanilla's unfocused hint always renders with a shadow, ignoring setTextShadow.
        // Draw our placeholder on the journal page so focus cannot change its weight.
        search.setValue(query);
        search.setResponder(value->{query=value; generation++; searchAt=System.currentTimeMillis()+300;});
        button("Refresh",799,148,88,27,false,()->load(false,true));
        button("x",892,62,22,22,false,this::onClose);
        for(int i=0;i<7;i++) rows.add(addRenderableWidget(new SessionRow(i)));
        more=button("Load more",762,578,125,24,false,()->load(true,false));
        setInitialFocus(search);
        if(!loading) load(false,false);
    }
    private void load(boolean append, boolean refresh) {
        if(append&&loading) return;
        searchAt=0; int request=++generation; loading=true; error="";
        String cursor=append?next:"";
        if(!append) {var cached=bridge.cachedSessions(query);if(cached!=null)applyList(cached,false);}
        bridge.sessions(query,cursor,refresh).whenComplete((response,failure)->minecraft.execute(()->{
            if(request!=generation) return;
            loading=false;
            if(failure!=null) { error="Could not load conversations. Check the connection and refresh."; return; }
            if(response.has("error")) { error=BridgeClient.string(response,"error","Could not load conversations."); return; }
            if(!response.has("sessions")) { error="The local bridge needs an update for chat selection."; return; }
            applyList(response,append);
        }));
    }
    private void applyList(JsonObject response,boolean append) {
        int oldSize=sessions.size();
        if(!append) {sessions.clear();if(!loadedQuery.equals(query))offset=0;}
        var known=new java.util.HashSet<String>();for(var session:sessions)known.add(session.get("id").getAsString());
        for(var item:response.getAsJsonArray("sessions")) {
            var session=item.getAsJsonObject();String id=session.get("id").getAsString();
            if(known.add(id))sessions.add(session);
        }
        if(append)offset=oldSize;
        offset=Math.min(offset,Math.max(0,sessions.size()-7));loadedQuery=query;
        next=BridgeClient.string(response,"nextCursor","");total=response.get("total").getAsInt();
        truncated=response.has("truncated")&&response.get("truncated").getAsBoolean();
        if(response.has("catalogVersion"))catalogVersion=response.get("catalogVersion").getAsInt();
    }
    @Override public void tick() {
        bridge.tick();
        if(kind==CompanionKind.CODEX&&!loading&&searchAt==0&&bridge.state.has("catalogVersion")
            &&bridge.state.get("catalogVersion").getAsInt()!=catalogVersion)load(false,false);
        if(searchAt>0&&System.currentTimeMillis()>=searchAt) load(false,false);
        for(int i=0;i<rows.size();i++) {
            var row=rows.get(i); row.visible=offset+i<sessions.size(); row.active=row.visible&&!bridge.switching&&!bridge.sending;
            if(row.visible) row.setMessage(Component.literal(BridgeClient.string(sessions.get(offset+i),"title","Conversation")));
        }
        more.visible=!next.isEmpty(); more.active=!loading&&!bridge.switching;
    }
    private void choose(int row) {
        if(offset+row>=sessions.size()) return;
        String thread=sessions.get(offset+row).get("id").getAsString();
        bridge.select(thread,()->{if(minecraft.gui.screen()==this) minecraft.gui.setScreen(new CompanionScreen(kind));},message->error=message);
    }
    @Override public void onClose() { minecraft.gui.setScreen(new CompanionScreen(kind)); }
    @Override protected boolean scrollLocal(double x,double y,double horizontal,double vertical) {
        if(x>=93&&x<=893&&y>=195&&y<=548) {
            offset=Math.clamp(offset-(int)Math.signum(vertical)*3,0,Math.max(0,sessions.size()-7)); return true;
        }
        return false;
    }
    @Override protected void drawJournal(GuiGraphicsExtractor g,int mx,int my,float delta) {
        conversationFrame(g,kind);
        conversationHeading(g,kind,"Your conversations","");
        label(g,kind.label+"  /  All projects",148,104,MUTED);
        g.fill(88,124,904,125,0x609C8155);
        g.fill(99,149,782,178,0x60FFF8E7);g.outline(99,149,683,29,0x607E694A);
        if(search.getValue().isEmpty()) label(g,"Search conversations or folders...",103,153,MUTED);
        label(g,"RECENT CONVERSATIONS",102,190,MUTED);
        if(sessions.isEmpty()) label(g,loading?"Gathering your desktop conversations...":error.isEmpty()?"No matching conversations.":"",105,226,MUTED);
        String footer=bridge.switching?"Opening the selected conversation...":loading&&sessions.isEmpty()?"Loading...":error.isEmpty()
            ? (sessions.isEmpty()?"":(offset+1)+"-"+Math.min(offset+7,sessions.size())+" of "+total+" conversations"+(truncated?" (list limited)":"")) : error;
        for(var line:font.split(Component.literal(footer),640)) {g.text(font,line,102,585,MUTED,false);break;}
    }
    private final class SessionRow extends Button {
        private final int row;
        SessionRow(int row) {super(93,207+row*49,800,44,Component.empty(),b->choose(row),DEFAULT_NARRATION);this.row=row;}
        @Override protected void extractContents(GuiGraphicsExtractor g,int mx,int my,float delta) {
            if(offset+row>=sessions.size()) return;
            var session=sessions.get(offset+row);String id=session.get("id").getAsString();
            var live=new JsonObject();
            if(bridge.state.has("watched"))for(var item:bridge.state.getAsJsonArray("watched")) {
                var candidate=item.getAsJsonObject();if(id.equals(BridgeClient.string(candidate,"id",""))){live=candidate;break;}
            }
            boolean selected=id.equals(bridge.activeThread);
            g.fill(getX(),getY(),getRight(),getBottom(),isHoveredOrFocused()?0x307C724A:selected?0x20356359:0x08745336);
            if(selected)g.fill(getX(),getY()+3,getX()+3,getBottom()-3,GREEN);
            String status=selected?"Selected":"";
            if(live.has("connected")&&live.get("connected").getAsBoolean()) {
                if(live.has("busy")&&live.get("busy").getAsBoolean())status="Working";
                else if(live.has("needsAttention")&&live.get("needsAttention").getAsBoolean())status="Attention";
                else if(bridge.signals.unread(id,BridgeClient.string(live,"latestCompletedReplyId","")))status="New reply";
            }
            String cwd=displayFolder(kind,BridgeClient.string(session,"cwd","")), home=System.getProperty("user.home");
            if(cwd.startsWith(home+"/"))cwd="~"+cwd.substring(home.length());
            int titleWidth=getWidth()-36-font.width(status);
            int titleY=getY()+(cwd.isBlank()?(getHeight()-8)/2:8);
            label(g,font.plainSubstrByWidth(BridgeClient.string(session,"title","Conversation"),titleWidth),getX()+12,titleY,INK);
            label(g,status,getRight()-font.width(status)-12,titleY,GREEN);
            if(!cwd.isBlank())label(g,font.plainSubstrByWidth(cwd,getWidth()-24),getX()+12,getY()+26,MUTED);
        }
    }
}
