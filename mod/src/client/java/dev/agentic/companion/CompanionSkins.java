package dev.agentic.companion;

import net.minecraft.core.ClientAsset;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.player.PlayerModelType;
import net.minecraft.world.entity.player.PlayerSkin;

/** Bundled identities shared by the world character and both journal portraits. */
final class CompanionSkins {
    static final PlayerSkin CODEX = new PlayerSkin(
        new ClientAsset.ResourceTexture(Identifier.fromNamespaceAndPath(
            "agentic_companion", "entity/companion/codex")),
        null, null, PlayerModelType.WIDE, true);
    static final PlayerSkin CLAUDE = new PlayerSkin(
        new ClientAsset.ResourceTexture(Identifier.fromNamespaceAndPath(
            "agentic_companion", "entity/companion/claude")),
        null, null, PlayerModelType.SLIM, true);
    static final PlayerSkin ATLAS = new PlayerSkin(
        new ClientAsset.ResourceTexture(Identifier.fromNamespaceAndPath(
            "agentic_companion", "entity/companion/atlas")),
        null, null, PlayerModelType.SLIM, true);
    static PlayerSkin forKind(CompanionKind kind) { return switch(kind) {
        case CODEX -> CODEX;
        case CLAUDE -> CLAUDE;
        case DOT -> ATLAS;
    }; }

    private CompanionSkins() {}
}
