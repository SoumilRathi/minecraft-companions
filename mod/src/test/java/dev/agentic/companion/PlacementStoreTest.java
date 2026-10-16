package dev.agentic.companion;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;

public final class PlacementStoreTest {
    private static void check(boolean ok, String description) {
        if (!ok) throw new AssertionError(description);
    }
    public static void main(String[] args) throws Exception {
        Path temp = Files.createTempDirectory("agentic-placement-");
        try {
            Path worldA = Files.createDirectories(temp.resolve("saves/A"));
            Path worldB = Files.createDirectories(temp.resolve("saves/B"));
            byte[] worldBytes = {1, 3, 5, 7};
            Files.write(worldA.resolve("level.dat"), worldBytes);
            Path config = temp.resolve("config/agentic-companions");
            var store = new PlacementStore(config);
            String a = PlacementStore.worldKey(worldA, 123), b = PlacementStore.worldKey(worldB, 123);
            check(!a.equals(b), "Different world folders must not share companions");
            check(!a.equals(PlacementStore.worldKey(worldA, 456)), "New world at an old path must not inherit placement");
            Files.createSymbolicLink(temp.resolve("alias"), worldA);
            check(a.equals(PlacementStore.worldKey(temp.resolve("alias"), 123)), "Canonical path identity");
            String remote = PlacementStore.serverKey("192.0.2.10");
            check(remote.equals(PlacementStore.serverKey("192.0.2.10:25565")), "Default server port shares placement");
            check(PlacementStore.serverKey(" MC.Example.COM. ").equals(PlacementStore.serverKey("mc.example.com:25565")), "Address spelling does not lose placement");
            check(PlacementStore.serverKey("[::1]").equals(PlacementStore.serverKey("[::1]:25565")), "IPv6 default port");
            check(!remote.equals(PlacementStore.serverKey("192.0.2.10:25566")), "Ports identify separate servers");
            check(!remote.equals(PlacementStore.serverKey("192.0.2.11")), "Different servers keep separate companions");
            check(!remote.equals(a), "Singleplayer and multiplayer storage are separate");
            var home = new PlacementStore.Placement("minecraft:overworld", -32.5, 64, 16.5, 135);
            var nether = new PlacementStore.Placement("minecraft:the_nether", 10.5, 70, -20.5, 90);
            check(store.load(a) == null, "Fresh world starts uninvited");
            store.save(remote, home);
            check(new PlacementStore(config).load(PlacementStore.serverKey("192.0.2.10:25565")).equals(home), "Reconnect restores multiplayer placement");
            store.dismiss(remote);
            check(store.load(remote) == null, "Multiplayer dismissal survives reconnect");
            store.save(a, home);
            check(new PlacementStore(config).load(a).equals(home), "Restart restores exact placement");
            check(store.load(b) == null, "Other world's setting stays empty");
            check(home.inDimension("minecraft:overworld") && !home.inDimension("minecraft:the_nether"), "Dimension isolation");
            store.save(b, nether); store.save(a, nether);
            check(store.load(a).equals(nether), "Invite updates the existing world's dimension and location");
            check(Files.exists(config.resolve(a + ".properties.bak")), "Previous setting retained for recovery");
            store.dismiss(a);
            check(new PlacementStore(config).load(a) == null, "Dismissal survives restart despite backup");
            check(store.load(b).equals(nether), "Dismissal cannot affect another world");
            store.save(a, home);
            Path file = config.resolve(a + ".properties");
            String corrupt = "version=1\ndimension=minecraft:overworld\nx=NaN\ny=64\nz=0\nyaw=0\n";
            Files.writeString(file, corrupt);
            try { store.load(a); throw new AssertionError("Corrupt placement was accepted"); }
            catch (java.io.IOException expected) { }
            check(Files.readString(file).equals(corrupt), "Loading invalid settings must preserve evidence");
            store.save(a, home);
            check(Files.readString(config.resolve(a + ".properties.bak")).equals(corrupt), "Explicit invite preserves invalid old data");
            try { store.load("../../saves/A/level.dat"); throw new AssertionError("Path traversal accepted"); }
            catch (IllegalArgumentException expected) { }
            check(Arrays.equals(Files.readAllBytes(worldA.resolve("level.dat")), worldBytes), "Placement lifecycle must not touch the world save");
            try (var paths = Files.walk(worldA)) { check(paths.count() == 2, "No mod files created in the world"); }
            System.out.println("Placement persistence, world/dimension isolation, dismissal, corruption recovery, and save independence passed.");
        } finally {
            try (var paths = Files.walk(temp)) {
                for (var path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
            }
        }
    }
}
