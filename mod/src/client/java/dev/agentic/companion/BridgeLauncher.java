package dev.agentic.companion;

import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;

/** Starts only our configured local bridge, with argument arrays and no shell. */
final class BridgeLauncher {
    private static long nextAttempt;
    private static boolean starting;
    private static String status = "Starting the local connection...";
    static String ensureStarted() {
        if (Minecraft.getInstance().level == null) return "Enter a world to connect.";
        if (starting || System.currentTimeMillis() < nextAttempt) return status;
        starting = true; nextAttempt = System.currentTimeMillis() + 15000;
        CompletableFuture.supplyAsync(() -> {
            try {
                var dir = FabricLoader.getInstance().getConfigDir();
                var file = dir.resolve("agentic-companion-launch.json");
                if (!Files.exists(file)) return "Automatic connection is not configured. Run setup to connect Minecraft.";
                var config = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
                if (!config.get("enabled").getAsBoolean()) return "Automatic connection is disabled in the launch settings.";
                var node = Path.of(config.get("node").getAsString());
                var script = Path.of(config.get("script").getAsString());
                var thread = config.has("threadId") ? config.get("threadId").getAsString() : "";
                if (!node.isAbsolute() || !script.isAbsolute() || !Files.isExecutable(node) || !Files.isRegularFile(script)
                        || (!thread.isEmpty() && !thread.matches("[a-fA-F0-9-]{36}"))) return "Local bridge files are unavailable. Run setup again to connect Minecraft.";
                var log = dir.resolve("agentic-bridge.log");
                if (Files.exists(log) && Files.size(log) > 1024 * 1024)
                    Files.move(log, log.resolveSibling("agentic-bridge.log.old"), StandardCopyOption.REPLACE_EXISTING);
                var arguments = new java.util.ArrayList<String>(java.util.List.of(node.toString(), script.toString(),
                    "--minecraft", FabricLoader.getInstance().getGameDir().toAbsolutePath().toString()));
                if (!thread.isEmpty()) { arguments.add("--thread"); arguments.add(thread); }
                var child = new ProcessBuilder(arguments)
                    .directory(script.getParent().getParent().toFile())
                    .redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(log.toFile())).start();
                child.getOutputStream().close();
                if (child.waitFor(2500, java.util.concurrent.TimeUnit.MILLISECONDS) && child.exitValue() != 0)
                    return "Bridge startup failed. Check config/agentic-bridge.log.";
                return "Starting the local connection. Keep your desktop app open.";
            } catch (Exception error) { return "Could not start the local bridge. Check config/agentic-bridge.log."; }
        }).whenComplete((message, error) -> Minecraft.getInstance().execute(() -> {
            starting = false; status = error == null ? message : "Could not start the local connection.";
        }));
        return status;
    }
}
