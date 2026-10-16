package dev.agentic.companion;

import java.io.IOException;
import java.io.StringReader;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Properties;

/** Companion settings live in the instance config, never inside a saved world. */
final class PlacementStore {
    record Placement(String dimension, double x, double y, double z, float yaw) {
        Placement {
            if (dimension == null || !dimension.matches("[a-z0-9_.-]+:[a-z0-9_./-]+")
                    || !Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(z)
                    || Math.abs(x) > 30_000_000 || Math.abs(z) > 30_000_000 || Math.abs(y) > 30_000_000
                    || !Float.isFinite(yaw)) throw new IllegalArgumentException("Invalid companion placement");
        }
        boolean inDimension(String current) { return dimension.equals(current); }
    }
    private final Path directory;
    PlacementStore(Path directory) { this.directory = directory; }

    static String worldKey(Path world, long seed) throws IOException {
        // Canonical folder distinguishes same-named worlds; seed distinguishes
        // a newly generated world reusing a deleted world's folder.
        try {
            String identity = world.toRealPath().toString() + "\n" + seed;
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(identity.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException error) { throw new AssertionError(error); }
    }
    static String serverKey(String address) {
        // Use the saved address, not a resolved IP: DNS changes must not lose placements.
        var uri = java.net.URI.create("minecraft://" + address.strip());
        String host = uri.getHost();
        int port = uri.getPort() == -1 ? 25565 : uri.getPort();
        if (host == null || host.isBlank() || port < 1 || port > 65535
                || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                || (uri.getRawPath() != null && !uri.getRawPath().isEmpty()))
            throw new IllegalArgumentException("Invalid server address");
        host = host.toLowerCase(java.util.Locale.ROOT);
        if (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(
                ("multiplayer\n" + host + "\n" + port).getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException error) { throw new AssertionError(error); }
    }
    private Path file(String key) {
        if (key == null || !key.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid world key");
        return directory.resolve(key + ".properties");
    }
    Placement load(String key) throws IOException {
        Path file = file(key);
        if (!Files.exists(file)) return null;
        if (Files.size(file) > 8192) throw new IOException("Placement file too large");
        try {
            var p = new Properties(); p.load(new StringReader(Files.readString(file)));
            if (!"1".equals(p.getProperty("version"))) throw new IOException("Unsupported placement format");
            return new Placement(p.getProperty("dimension"), Double.parseDouble(p.getProperty("x")),
                Double.parseDouble(p.getProperty("y")), Double.parseDouble(p.getProperty("z")), Float.parseFloat(p.getProperty("yaw")));
        } catch (IllegalArgumentException | NullPointerException error) { throw new IOException("Invalid placement file", error); }
    }
    void save(String key, Placement placement) throws IOException {
        Files.createDirectories(directory);
        Path file = file(key), temp = Files.createTempFile(directory, key, ".tmp");
        try {
            var p = new Properties(); p.setProperty("version", "1"); p.setProperty("dimension", placement.dimension());
            p.setProperty("x", Double.toString(placement.x())); p.setProperty("y", Double.toString(placement.y()));
            p.setProperty("z", Double.toString(placement.z())); p.setProperty("yaw", Float.toString(placement.yaw()));
            var text = new StringWriter(); p.store(text, "Agentic companion placement; independent of the world save");
            Files.writeString(temp, text.toString());
            // Preserve the previous setting, including unreadable data, for recovery.
            if (Files.exists(file)) Files.copy(file, file.resolveSibling(file.getFileName() + ".bak"), StandardCopyOption.REPLACE_EXISTING);
            Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally { Files.deleteIfExists(temp); }
    }
    void dismiss(String key) throws IOException {
        // Deletion is intentional absence; backups are never automatically loaded.
        Files.deleteIfExists(file(key));
    }
}
