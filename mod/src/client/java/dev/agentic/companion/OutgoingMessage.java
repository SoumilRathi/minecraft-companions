package dev.agentic.companion;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/** A submitted message is independent of the editable draft. */
record OutgoingMessage(String id, String text, String status) {
    OutgoingMessage {
        if (id==null || !id.matches("[a-fA-F0-9-]{36}") || text==null || text.length()>4000
            || !java.util.Set.of("pending","sent","failed","unknown").contains(status))
            throw new IllegalArgumentException("Invalid outgoing message");
    }
    OutgoingMessage withStatus(String value) { return new OutgoingMessage(id,text,value); }
    boolean failed() { return status.equals("failed"); }
    boolean matches(JsonObject message) {
        return id.equals(field(message,"deliveryId")) || id.equals(field(message,"id"));
    }
    private static String field(JsonObject value,String key) {
        return value.has(key)&&!value.get(key).isJsonNull()?value.get(key).getAsString():"";
    }
    JsonArray display(JsonArray history) {
        var result=new JsonArray();boolean found=false;
        for (var value:history) {
            var message=value.getAsJsonObject().deepCopy();
            if (matches(message)) { found=true;message.addProperty("outgoingStatus",status); }
            result.add(message);
        }
        if (!found) {
            var message=new JsonObject();message.addProperty("id",id);message.addProperty("deliveryId",id);
            message.addProperty("role","You");message.addProperty("text",text);message.addProperty("outgoingStatus",status);
            result.add(message);
        }
        return result;
    }
}
