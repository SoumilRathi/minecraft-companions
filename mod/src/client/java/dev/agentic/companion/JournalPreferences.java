package dev.agentic.companion;

import java.nio.file.Files;
import java.nio.file.Path;
import net.fabricmc.loader.api.FabricLoader;

final class JournalPreferences {
    private static final Path FILE = FabricLoader.getInstance().getConfigDir().resolve("agentic-journal-text-size.txt");
    private static final float[] SIZES = {.75f, 1f, 1.3f};
    static int index = 1;
    static { try { index = Math.clamp(Integer.parseInt(Files.readString(FILE).trim()), 0, 2); } catch (Exception ignored) { } }
    static float size() { return SIZES[index]; }
    static String label() { return new String[]{"Aa: Fine", "Aa: Regular", "Aa: Large"}[index]; }
    static void cycle() {
        index = (index + 1) % SIZES.length;
        try { Files.createDirectories(FILE.getParent()); Files.writeString(FILE, Integer.toString(index)); } catch (Exception ignored) { }
    }
}
