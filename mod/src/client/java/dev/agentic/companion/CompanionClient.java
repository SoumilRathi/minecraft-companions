package dev.agentic.companion;

import com.mojang.authlib.GameProfile;
import com.mojang.blaze3d.platform.InputConstants;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.loader.api.FabricLoader;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keymapping.v1.KeyMappingHelper;
import net.fabricmc.fabric.api.event.player.AttackEntityCallback;
import net.fabricmc.fabric.api.event.player.UseEntityCallback;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.level.storage.LevelResource;

public final class CompanionClient implements ClientModInitializer {
    private static KeyMapping menu;
    private static final java.util.Map<CompanionKind,Presence> PRESENCES=new java.util.EnumMap<>(CompanionKind.class);
    static { for(var kind:CompanionKind.values()) PRESENCES.put(kind,new Presence(kind)); }
    @Override
    public void onInitializeClient() {
        var category = KeyMapping.Category.register(Identifier.fromNamespaceAndPath("agentic_companion", "companions"));
        menu = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.agentic_companion.menu", InputConstants.KEY_O, category));
        ClientTickEvents.END_CLIENT_TICK.register(mc -> {
            if (mc.level != null && mc.player != null) for(var kind:CompanionKind.enabledValues()) kind.bridge().tick();
            for(var kind:CompanionKind.enabledValues()) PRESENCES.get(kind).restore(mc);
            while (menu.consumeClick()) {
                if (mc.player != null && mc.gui.screen() == null) mc.gui.setScreen(new CompanionRosterScreen());
            }
        });
        UseEntityCallback.EVENT.register((player, level, hand, entity, hit) -> {
            if (entity instanceof CompanionEntity companion) {
                if (hand == InteractionHand.MAIN_HAND) Minecraft.getInstance().gui.setScreen(new CompanionScreen(companion.kind));
                // FAIL consumes the click without sending a use-entity packet to the server.
                return InteractionResult.FAIL;
            }
            return InteractionResult.PASS;
        });
        AttackEntityCallback.EVENT.register((player, level, hand, entity, hit) ->
            entity instanceof CompanionEntity ? InteractionResult.FAIL : InteractionResult.PASS);
    }


    public record Invitation(boolean success,String message) {}
    static boolean present(CompanionKind kind) { return PRESENCES.get(kind).companion!=null; }
    static Invitation invite(CompanionKind kind) { return PRESENCES.get(kind).invite(); }
    static Invitation dismiss(CompanionKind kind) { return PRESENCES.get(kind).dismiss(); }
    private static final class Presence {
        private final CompanionKind kind;
        private final PlacementStore PLACEMENTS;
        private CompanionEntity companion;
        private Object worldOwner;
        private String worldKey;
        private PlacementStore.Placement placement;
        private String placementNotice="";
        private long nextRestore;
        Presence(CompanionKind kind) {
            this.kind=kind;
            var base=FabricLoader.getInstance().getConfigDir().resolve("agentic-companions");
            PLACEMENTS=new PlacementStore(kind==CompanionKind.CODEX ? base : base.resolve(kind.key));
        }
    private void restore(Minecraft mc) {
        var server = mc.getSingleplayerServer();
        // The server reference can appear before its overworld/player is ready.
        if (server != null && (mc.level == null || mc.player == null || server.overworld() == null)) {
            if (companion != null && mc.level != companion.level()) removeVisual();
            return;
        }
        var connection = mc.getConnection();
        Object owner = server != null ? server : connection == null ? null : connection.getConnection();
        if (owner != worldOwner) {
            removeVisual(); worldOwner = owner; worldKey = null; placement = null;
            placementNotice = ""; nextRestore = 0;
            if (owner != null) try {
                if (server != null) {
                    worldKey = PlacementStore.worldKey(server.getWorldPath(LevelResource.ROOT), server.overworld().getSeed());
                } else {
                    var remote = connection.getServerData();
                    if (remote == null) remote = mc.getCurrentServer();
                    if (remote != null) worldKey = PlacementStore.serverKey(remote.ip);
                }
                if (worldKey != null) placement = PLACEMENTS.load(worldKey);
            } catch (Exception error) {
                placementNotice = "Could not read placement. Invite to set a new spot.";
                System.err.println("[Agentic] Could not read companion placement: " + error.getClass().getSimpleName());
            }
        }
        if (companion != null && (mc.level != companion.level() || companion.isRemoved())) removeVisual();
        if (owner == null || mc.level == null || mc.player == null || placement == null) return;
        if (!placement.inDimension(mc.level.dimension().identifier().toString())) {
            removeVisual(); placementNotice = "Waiting in another dimension. Invite to bring them here."; return;
        }
        if (System.currentTimeMillis() < nextRestore) return;
        nextRestore = System.currentTimeMillis() + 1000;
        var feet = BlockPos.containing(placement.x(), placement.y(), placement.z());
        if (!mc.level.hasChunk(feet.getX() >> 4, feet.getZ() >> 4)) {
            removeVisual(); placementNotice = "Waiting where you left them. Invite to bring them here."; return;
        }
        if (!standingSpot(mc, feet)) {
            removeVisual(); placementNotice = "Their spot is blocked. Invite to choose a new one."; return;
        }
        if (companion == null) spawn(mc, new Vec3(placement.x(), placement.y(), placement.z()), placement.yaw());
        placementNotice = "";
    }


    public Invitation invite() {
        Minecraft mc = Minecraft.getInstance();
        if (mc.level == null || mc.player == null) return new Invitation(false, "Enter a world first.");
        restore(mc);
        if (worldKey == null) return new Invitation(false, "Could not identify this world. Reopen it and try again.");
        Vec3 target = findStandingSpot(mc);
        if (target == null) return new Invitation(false, "Find a clear, flat area nearby and try again.");
        var next = new PlacementStore.Placement(mc.level.dimension().identifier().toString(), target.x, target.y, target.z, mc.player.getYRot() + 180);
        try { PLACEMENTS.save(worldKey, next); }
        catch (Exception error) { return new Invitation(false, "Could not save placement. "+kind.label+" has not been moved."); }
        placement = next; placementNotice = "";
        if (companion != null && companion.level() == mc.level && !companion.isRemoved()) {
            companion.snapTo(target.x, target.y, target.z, next.yaw(), 0);
            companion.setOldPosAndRot();
            return new Invitation(true, kind.characterName()+" is nearby.");
        }
        removeVisual();
        spawn(mc, target, next.yaw());
        return new Invitation(true, kind.characterName()+" is nearby.");
    }

    private void spawn(Minecraft mc, Vec3 target, float yaw) {
        companion = new CompanionEntity(mc.level, new GameProfile(
            kind.uuid, kind.characterName()), kind);
        int entityId = -2000000;
        while (mc.level.getEntity(entityId) != null) entityId--;
        companion.setId(entityId);
        companion.setUUID(kind.uuid);
        companion.snapTo(target.x, target.y, target.z, yaw, 0);
        companion.setOldPosAndRot();
        companion.setCustomName(Component.literal(kind.characterName()));
        companion.setCustomNameVisible(true);
        mc.level.addEntity(companion);
    }

    private boolean standingSpot(Minecraft mc, BlockPos feet) {
        return mc.level.hasChunk(feet.getX() >> 4, feet.getZ() >> 4)
            && mc.level.isInsideBuildHeight(feet.below()) && mc.level.isInsideBuildHeight(feet.above())
            && mc.level.getWorldBorder().isWithinBounds(feet)
            && mc.level.getBlockState(feet).isAir() && mc.level.getBlockState(feet.above()).isAir()
            && mc.level.getBlockState(feet.below()).isCollisionShapeFullBlock(mc.level, feet.below());
    }

    private Vec3 findStandingSpot(Minecraft mc) {
        BlockPos origin = mc.player.blockPosition();
        Vec3 forward = mc.player.getLookAngle();
        Vec3 best = null;
        double bestScore = Double.MAX_VALUE;
        for (int dx = -3; dx <= 3; dx++) for (int dz = -3; dz <= 3; dz++) {
            if (dx * dx + dz * dz < 4) continue;
            for (int dy = -1; dy <= 1; dy++) {
                BlockPos feet = origin.offset(dx, dy, dz);
                if (!standingSpot(mc, feet)) continue;
                boolean occupied=false;
                for(var other:PRESENCES.values()) if(other!=this&&other.companion!=null&&other.companion.level()==mc.level
                    &&other.companion.position().distanceToSqr(new Vec3(feet.getX()+.5,feet.getY(),feet.getZ()+.5))<1) occupied=true;
                if(occupied) continue;
                double score = Math.pow(dx - forward.x * 2.5, 2) + Math.pow(dz - forward.z * 2.5, 2) + Math.abs(dy) * 4;
                if (score < bestScore) { bestScore = score; best = new Vec3(feet.getX() + .5, feet.getY(), feet.getZ() + .5); }
            }
        }
        return best;
    }

    public Invitation dismiss() {
        if (worldKey == null) return new Invitation(false, "Enter a world first.");
        try { PLACEMENTS.dismiss(worldKey); }
        catch (Exception error) { return new Invitation(false, "Could not save dismissal. "+kind.label+" is staying here for now."); }
        placement = null; placementNotice = ""; removeVisual();
        return new Invitation(true, kind.label+" dismissed. Invite them back whenever you like.");
    }

    private void removeVisual() {
        if (companion != null) {
            if (!companion.isRemoved()) ((net.minecraft.client.multiplayer.ClientLevel) companion.level()).removeEntity(companion.getId(), Entity.RemovalReason.DISCARDED);
            companion = null;
        }
    }
    }
}
