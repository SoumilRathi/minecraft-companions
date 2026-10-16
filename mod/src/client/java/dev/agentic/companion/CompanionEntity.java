package dev.agentic.companion;

import com.mojang.authlib.GameProfile;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.RemotePlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.PlayerSkin;
import net.minecraft.world.entity.player.PlayerModelPart;
import net.minecraft.network.chat.Component;
import net.minecraft.core.particles.DustParticleOptions;

/** A visual player on the client only. No entity is ever created on the server. */
public final class CompanionEntity extends RemotePlayer {
    final CompanionKind kind;
    private int effectTick;
    public CompanionEntity(ClientLevel level, GameProfile profile, CompanionKind kind) {
        super(level, profile);
        this.kind=kind;
        setNoGravity(true);
    }

    @Override public PlayerSkin getSkin() { return CompanionSkins.forKind(kind); }
    @Override public boolean isModelPartShown(PlayerModelPart part) {
        // This companion's hair and clothing layers are part of his fixed design,
        // independent of the local player's skin customization settings.
        return part != PlayerModelPart.CAPE;
    }

    @Override public void tick() {
        effectTick++;
        // Deliberately omit player physics, inventory, effects, and network behavior.
        var player = Minecraft.getInstance().player;
        if (player != null) {
            double dx = player.getX() - getX();
            double dz = player.getZ() - getZ();
            yHeadRotO = yHeadRot;
            yHeadRot = (float) Math.toDegrees(Math.atan2(-dx, dz));
            yBodyRotO = yBodyRot;
            yBodyRot = yHeadRot;
            setYRot(yHeadRot);
        }
        var state = kind.bridge().signals.tracker.state();
        if (state != ReplyTracker.State.IDLE && state != ReplyTracker.State.OFFLINE && effectTick % 4 == 0) {
            double angle = effectTick * .09;
            double radius = state == ReplyTracker.State.WORKING ? .23 : .13;
            // Keep the orbit clearly above the vanilla nameplate, rather than
            // sharing its height. The character's name remains a quiet label.
            double y = getY() + getBbHeight() + 1.0 + .045 * Math.sin(angle * 2);
            var dust = new DustParticleOptions(kind.bridge().signals.color(), .55f);
            for (int side : new int[]{-1, 1}) ((ClientLevel)level()).addParticle(dust,
                getX() + side * Math.cos(angle) * radius, y, getZ() + side * Math.sin(angle) * radius, 0, .005, 0);
        }
    }

    @Override public Component getDisplayName() { return Component.literal(kind.characterName()).withColor(0xDCD4BC); }
    @Override public boolean isCurrentlyGlowing() { return kind.bridge().signals.tracker.state() == ReplyTracker.State.READY; }
    @Override public int getTeamColor() { return kind.bridge().signals.color(); }

    @Override public boolean isPushable() { return false; }
    @Override protected void doPush(Entity entity) {}
    @Override public boolean canBeCollidedWith(Entity other) { return false; }
    @Override public boolean isAttackable() { return false; }
}
