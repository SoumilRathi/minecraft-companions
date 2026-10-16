package dev.agentic.companion;

import java.util.UUID;

/** Stable identity; UI and transport share these provider keys. */
enum CompanionKind {
    CODEX("codex", "Codex", "e865a2fa-26f8-4bfc-904a-27f73841e9cd"),
    CLAUDE("claude", "Claude", "ba35aa6e-c290-409a-a151-cf64052f634b"),
    DOT("dot", "Dot", "a6038582-29f2-4678-8f18-cd11f187b633");
    final String key, label;
    final UUID uuid;
    CompanionKind(String key, String label, String uuid) {
        this.key=key;this.label=label;this.uuid=UUID.fromString(uuid);
    }
    private static CompanionKind[] enabled;
    private static long nextRead;
    static CompanionKind[] enabledValues() {
        if (enabled != null && System.currentTimeMillis() < nextRead) return enabled;
        nextRead = System.currentTimeMillis() + 10000;
        enabled = values();
        var file = net.fabricmc.loader.api.FabricLoader.getInstance().getConfigDir().resolve("agentic-companion-launch.json");
        try {
            var config = com.google.gson.JsonParser.parseString(java.nio.file.Files.readString(file)).getAsJsonObject();
            if (config.has("providers")) {
                var keys = new java.util.HashSet<String>();
                for (var value : config.getAsJsonArray("providers")) keys.add(value.getAsString());
                enabled = java.util.Arrays.stream(values()).filter(kind -> keys.contains(kind.key)).toArray(CompanionKind[]::new);
            }
        } catch (Exception ignored) { }
        return enabled;
    }
    int accent() { return switch(this) {
        case CODEX -> 0xFF2C5758;
        case CLAUDE -> 0xFF96504B;
        case DOT -> 0xFF392E6B;
    }; }
    BridgeClient bridge() { return BridgeClient.forKind(this); }
    String characterName() { return this == DOT ? "Dot" : label; }
}
