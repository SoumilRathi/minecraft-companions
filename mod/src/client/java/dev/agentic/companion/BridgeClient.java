package dev.agentic.companion;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/** HTTP never runs on the render thread; all UI state changes do. */
final class BridgeClient {
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
    private static final Path CONFIG = FabricLoader.getInstance().getConfigDir().resolve("agentic-companion-bridge.json");
    private static final java.util.Map<CompanionKind,BridgeClient> CLIENTS = new java.util.EnumMap<>(CompanionKind.class);
    static BridgeClient forKind(CompanionKind kind) { return CLIENTS.computeIfAbsent(kind,BridgeClient::new); }
    final CompanionKind kind;
    final CompanionSignals signals;
    private final ChatStateStore CHATS;
    BridgeClient(CompanionKind kind) {
        this.kind=kind;
        CHATS=new ChatStateStore(kind==CompanionKind.CODEX ? FabricLoader.getInstance().getConfigDir()
            : FabricLoader.getInstance().getConfigDir().resolve("agentic-"+kind.key));
        signals=new CompanionSignals(this);
    }
    private final java.util.Map<String,JsonObject> sessionCache=new java.util.concurrent.ConcurrentHashMap<>();
    String activeThread = "";
    float savedScroll, savedOffset;
    boolean followLatest = true;
    String savedAnchor = "";
    private final String LEGACY_THREAD = configuredThread();
    JsonObject state = new JsonObject();
    String connection = "Connecting to the local bridge...";
    String notice = "";
    boolean problem;
    String draft = "";
    OutgoingMessage outgoing;
    boolean polling, sending, connected, switching, bridgeAvailable;
    private long selectionGeneration;
    private long nextPoll;
    private long deliveryStarted;
    private String savedThread="";
    private ChatStateStore.Snapshot savedSnapshot;
    private String configuredThread() {
        try { return JsonParser.parseString(Files.readString(CONFIG)).getAsJsonObject().get("threadId").getAsString(); }
        catch (Exception ignored) { return ""; }
    }
    private boolean acceptState(JsonObject response) {
        String thread=string(response,"threadId","");
        if (!thread.equals(activeThread)) {
            if (!saveDraft()) { connected=false; problem=true; notice="Could not save the current draft. Chat switch paused."; return false; }
            try {
                var saved=CHATS.load(thread,kind==CompanionKind.CODEX?LEGACY_THREAD:"");
                activeThread=thread; draft=saved.text(); outgoing=saved.outgoing();
                savedScroll=saved.scroll(); followLatest=saved.followLatest(); savedAnchor=saved.anchor(); savedOffset=saved.offset();
                notice=""; problem=false;
            } catch (Exception error) {
                connected=false; problem=true; notice="Could not read that chat's saved draft. Its files have been preserved."; return false;
            }
        }
        state=response; bridgeAvailable=true; connected=flag("connected"); connection=string(state,"status","Connecting...");
        signals.observe(); return true;
    }
    static String string(JsonObject object, String key, String fallback) {
        return object.has(key) && !object.get(key).isJsonNull() ? object.get(key).getAsString() : fallback;
    }
    boolean flag(String key) { return state.has(key) && state.get(key).getAsBoolean(); }
    String connectionPhase() { return bridgeAvailable ? string(state,"connectionPhase","connecting") : "connecting"; }
    void tick() {
        if (polling || switching || System.currentTimeMillis() < nextPoll) return;
        long generation=selectionGeneration;
        boolean notifications=kind==CompanionKind.DOT || kind==CompanionKind.CODEX;
        polling = true; nextPoll = notifications ? 0 : System.currentTimeMillis() + 1000;
        String route=notifications ? "/state?after="+java.net.URLEncoder.encode(string(state,"revision",""),StandardCharsets.UTF_8) : "/state";
        request(route, null).whenComplete((response, error) -> Minecraft.getInstance().execute(() -> {
            polling = false;
            if (generation != selectionGeneration) { nextPoll=0; tick(); return; }
            if (error != null) {
                bridgeAvailable = false;
                connected = false;
                connection = BridgeLauncher.ensureStarted();
                signals.observe();
                nextPoll = System.currentTimeMillis() + (kind==CompanionKind.CODEX?250:2500);
                return;
            }
            if (!acceptState(response)) return;
            reconcileOutgoing();
            if (notifications) {
                // Keep a change request open; the server responds as soon as state changes.
                if (!response.has("revision")) nextPoll=System.currentTimeMillis()+1000;
                if (Minecraft.getInstance().level!=null && Minecraft.getInstance().player!=null) tick();
            }
        }));
    }
    private boolean containsId(String field,String id) {
        if (!state.has(field)) return false;
        for (var value:state.getAsJsonArray(field)) if (id.equals(value.getAsString())) return true;
        return false;
    }
    private void logDelivery(String stage) {
        if (kind==CompanionKind.DOT && deliveryStarted>0)
            System.getLogger("Agentic delivery").log(System.Logger.Level.INFO,
                "Dot {0}: {1} ms (delivery {2})",stage,(System.nanoTime()-deliveryStarted)/1_000_000,outgoing==null?"":outgoing.id());
    }
    boolean canSend() {
        return connected && !sending && !switching && !activeThread.isEmpty() && outgoing==null && flag("canSend");
    }
    JsonObject cachedSessions(String search) {
        JsonObject all=sessionCache.get("");
        if(kind!=CompanionKind.CODEX || all==null)return sessionCache.get(search);
        var result=all.deepCopy();var matches=new com.google.gson.JsonArray();
        String[] terms=search.toLowerCase(java.util.Locale.ROOT).trim().split("\\s+");
        for(var item:all.getAsJsonArray("sessions")) {
            var row=item.getAsJsonObject();String value=(string(row,"title","")+" "+string(row,"cwd","")).toLowerCase(java.util.Locale.ROOT);
            boolean match=true;for(String term:terms)if(!value.contains(term)){match=false;break;}
            if(match)matches.add(row);
        }
        result.add("sessions",matches);result.addProperty("total",matches.size());return result;
    }
    CompletableFuture<JsonObject> sessions(String search, String cursor, boolean refresh) {
        return request("/sessions?search="+java.net.URLEncoder.encode(search,StandardCharsets.UTF_8)
            +"&cursor="+java.net.URLEncoder.encode(cursor,StandardCharsets.UTF_8)+(refresh?"&refresh=1":"")
            +(kind==CompanionKind.CODEX?"&all=1":""),null).thenApply(result->{
                if(cursor.isEmpty()&&result.has("sessions")) {
                    if(sessionCache.size()>32)sessionCache.clear();sessionCache.put(search,result.deepCopy());
                }
                return result;
            });
    }
    void select(String thread, Runnable success, java.util.function.Consumer<String> failure) {
        if (sending || switching) { failure.accept("Wait for the current message to finish sending."); return; }
        if (!saveDraft()) { failure.accept("Could not save the current draft. Your chat has not changed."); return; }
        try { CHATS.load(thread,LEGACY_THREAD); }
        catch (Exception error) { failure.accept("Could not read that chat's saved draft. Its files have been preserved."); return; }
        var body=new JsonObject(); body.addProperty("threadId",thread); body.addProperty("expectedThreadId",activeThread);
        switching=true; selectionGeneration++;
        request("/session",body).whenComplete((response,error)->Minecraft.getInstance().execute(()->{
            switching=false; nextPoll=0;
            if(error!=null) { connected=false; connection="Checking which conversation was selected..."; failure.accept("Connection interrupted. Checking the selected chat..."); return; }
            if(response.has("error")) { failure.accept(string(response,"error","Could not switch conversations.")); return; }
            if(acceptState(response)) success.run(); else failure.accept(notice);
        }));
    }
    com.google.gson.JsonArray displayMessages() {
        var messages=state.has("messages")?state.getAsJsonArray("messages"):new com.google.gson.JsonArray();
        return outgoing==null?messages:outgoing.display(messages);
    }
    private void reconcileOutgoing() {
        if(outgoing==null)return;
        if(containsId("deliveredIds",outgoing.id())) {
            logDelivery("confirmed");outgoing=outgoing.withStatus("sent");
            // Keep the local row until history contains its actual identity.
            for(var value:state.has("messages")?state.getAsJsonArray("messages"):new com.google.gson.JsonArray())if(outgoing.matches(value.getAsJsonObject())) {
                outgoing=null;break;
            }
            saveDraft();
        } else if(containsId("notSentIds",outgoing.id())) {
            outgoing=outgoing.withStatus("failed");saveDraft();
        }
        signals.observe();
    }
    void send() {
        if (!canSend() || draft.isBlank()) return;
        submit(draft,true);
    }
    boolean canRetry() {return outgoing!=null&&outgoing.failed()&&connected&&!sending&&!switching&&flag("canSend");}
    void retryOutgoing() {if(canRetry())submit(outgoing.text(),false);}
    void removeFailed() {if(outgoing!=null&&outgoing.failed()){outgoing=null;saveDraft();}}
    private void submit(String text,boolean clearInput) {
        String thread=activeThread,previousDraft=draft;
        OutgoingMessage previous=outgoing;
        outgoing=new OutgoingMessage(UUID.randomUUID().toString(),text,"pending");
        if(clearInput)draft="";
        if(!saveDraft()) {
            outgoing=previous;draft=previousDraft;problem=true;notice="Could not save your message. Nothing was sent.";return;
        }
        String sentId=outgoing.id();deliveryStarted=System.nanoTime();
        var body=new JsonObject();body.addProperty("id",sentId);body.addProperty("text",text);body.addProperty("threadId",thread);
        sending=true;problem=false;notice="";signals.observe();
        request("/message",body).whenComplete((response,error)->Minecraft.getInstance().execute(()->{
            sending=false;signals.observe();
            // A delivered notification can arrive first. Never touch the next draft.
            if(!thread.equals(activeThread)||outgoing==null||!sentId.equals(outgoing.id()))return;
            logDelivery("submission response");
            if(error!=null)outgoing=outgoing.withStatus("unknown");
            else if(response.has("error")) {
                int code=response.has("httpStatus")?response.get("httpStatus").getAsInt():500;
                outgoing=outgoing.withStatus(code>=400&&code<500?"failed":"unknown");
            } else switch(string(response,"state","unknown")) {
                case "delivered" -> outgoing=outgoing.withStatus("sent");
                case "notSent" -> outgoing=outgoing.withStatus("failed");
                case "unknown" -> outgoing=outgoing.withStatus("unknown");
                default -> { }
            }
            reconcileOutgoing();saveDraft();signals.observe();nextPoll=0;
        }));
    }
    boolean saveDraft() {
        if (activeThread.isEmpty()) return true;
        try {
            var snapshot=new ChatStateStore.Snapshot(draft,outgoing==null?null:outgoing.id(),savedScroll,followLatest,savedAnchor,savedOffset,
                outgoing==null?"":outgoing.text(),outgoing==null?"pending":outgoing.status());
            if(activeThread.equals(savedThread)&&snapshot.equals(savedSnapshot))return true;
            CHATS.save(activeThread,snapshot);savedThread=activeThread;savedSnapshot=snapshot;
            return true;
        } catch (Exception error) { return false; }
    }
    private CompletableFuture<JsonObject> request(String route, JsonObject body) {
        String prefix = kind==CompanionKind.CODEX ? "" : "/"+kind.key;
        return CompletableFuture.supplyAsync(() -> {
            try {
                var config = JsonParser.parseString(Files.readString(CONFIG)).getAsJsonObject();
                String url = config.get("url").getAsString();
                if (!url.matches("http://127\\.0\\.0\\.1:[0-9]{1,5}")) throw new IllegalStateException("Bridge must be local");
                if (body != null && route.equals("/message") && !string(config,kind==CompanionKind.CODEX?"threadId":kind.key+"ThreadId","").equals(body.get("threadId").getAsString()))
                    throw new IllegalStateException("Chat selection changed");
                var builder = HttpRequest.newBuilder(URI.create(url + prefix + route)).timeout(Duration.ofSeconds(route.startsWith("/sessions") || route.startsWith("/state?") ? 25 : body == null ? 5 : 25))
                    .header("Authorization", "Bearer " + config.get("token").getAsString());
                if (body != null) builder.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body.toString()));
                var response = HTTP.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream());
                try (var stream = response.body()) {
                    byte[] bytes = stream.readNBytes(4 * 1024 * 1024 + 1);
                    if (bytes.length > 4 * 1024 * 1024) throw new IllegalStateException("Bridge response too large");
                    var result = JsonParser.parseString(new String(bytes, StandardCharsets.UTF_8)).getAsJsonObject();
                    if (body == null && route.startsWith("/state") && response.statusCode() != 200) throw new IllegalStateException("Bridge authentication failed");
                    if (response.statusCode() != 200) result.addProperty("httpStatus", response.statusCode());
                    return result;
                }
            } catch (Exception error) { throw new RuntimeException(error); }
        });
    }
}
