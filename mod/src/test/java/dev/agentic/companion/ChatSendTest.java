package dev.agentic.companion;
import com.google.gson.*;
import com.sun.net.httpserver.HttpServer;
import net.minecraft.client.Minecraft;
import java.net.InetSocketAddress;
import java.nio.file.*;
import java.util.UUID;
import java.util.concurrent.*;

public class ChatSendTest {
    static volatile JsonObject state;static volatile String id;static volatile int sends;
    static volatile CountDownLatch release;static volatile boolean reject;
    static final Minecraft mc=Minecraft.getInstance();
    static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
    static void until(java.util.function.BooleanSupplier condition)throws Exception {
        long end=System.currentTimeMillis()+4000;
        while(true){boolean[] done={false};mc.run(()->done[0]=condition.getAsBoolean());if(done[0])return;
            if(System.currentTimeMillis()>end)throw new AssertionError("Timed out");Thread.sleep(5);}
    }
    public static void main(String[] args)throws Exception {
        String thread=UUID.randomUUID().toString();state=JsonParser.parseString("{\"connected\":true,\"canSend\":true,\"messages\":[],\"deliveredIds\":[],\"revision\":\"one\"}").getAsJsonObject();state.addProperty("threadId",thread);
        var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);var workers=Executors.newCachedThreadPool();server.setExecutor(workers);
        server.createContext("/dot/",exchange->{
            String response=state.toString();
            if(exchange.getRequestURI().getPath().equals("/dot/message")) {
                var body=JsonParser.parseString(new String(exchange.getRequestBody().readAllBytes())).getAsJsonObject();
                id=body.get("id").getAsString();sends++;
                try{release.await(3,TimeUnit.SECONDS);}catch(InterruptedException e){Thread.currentThread().interrupt();}
                response=reject?"{\"state\":\"notSent\"}":"{\"state\":\"submitted\"}";
            }
            byte[] data=response.getBytes();exchange.sendResponseHeaders(200,data.length);exchange.getResponseBody().write(data);exchange.close();
        });server.start();
        var config=Path.of(System.getProperty("fixture.config"));
        Files.writeString(config.resolve("agentic-companion-bridge.json"),"{\"url\":\"http://127.0.0.1:"+server.getAddress().getPort()+"\",\"token\":\"fixture\",\"threadId\":\""+thread+"\",\"dotThreadId\":\""+thread+"\"}");
        try {
            var client=new BridgeClient(CompanionKind.DOT);mc.run(client::tick);until(()->client.connected);
            release=new CountDownLatch(1);
            mc.run(()->{client.draft="First message.  ";client.send();check(client.draft.isEmpty(),"Send clears input immediately");check(client.displayMessages().size()==1,"Outgoing message appears immediately");check(client.signals.tracker.state()==ReplyTracker.State.WORKING,"Send immediately starts working particles");client.draft="Already typing the next message";});
            until(()->sends==1);
            JsonObject confirmed=state.deepCopy();var row=new JsonObject();row.addProperty("id","server-message");row.addProperty("deliveryId",id);row.addProperty("role","You");row.addProperty("text","First message.");confirmed.getAsJsonArray("messages").add(row);confirmed.getAsJsonArray("deliveredIds").add(id);confirmed.addProperty("revision","two");state=confirmed;
            mc.run(client::tick);until(()->client.outgoing==null);
            release.countDown();until(()->!client.sending);
            mc.run(()->{check(client.draft.equals("Already typing the next message"),"Late POST and confirmation must preserve new draft");check(client.displayMessages().size()==1,"Confirmed message is not duplicated");});
            reject=true;release=new CountDownLatch(0);mc.run(client::send);until(()->!client.sending&&client.outgoing!=null&&client.outgoing.failed());
            mc.run(()->{client.draft="Draft while failed message remains";client.saveDraft();});
            var restored=new BridgeClient(CompanionKind.DOT);mc.run(restored::tick);until(()->restored.connected);
            mc.run(()->{check(restored.draft.equals("Draft while failed message remains"),"Next draft persists independently");check(restored.outgoing.failed(),"Failed outgoing message survives restart");check(restored.displayMessages().size()==2,"Failure stays beside its own message");});
            System.out.println("Actual chat send flow passed: immediate display, editable next draft, trimmed confirmation, late POST, no duplicate row, failed-message persistence.");
        }finally{server.stop(0);workers.shutdownNow();mc.close();}
    }
}
