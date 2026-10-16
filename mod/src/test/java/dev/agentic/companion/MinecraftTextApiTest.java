package dev.agentic.companion;

/** Check the real game's private text access without starting Minecraft or a model. */
public final class MinecraftTextApiTest {
    public static void main(String[] args) throws Exception {
        var loader = MinecraftTextApiTest.class.getClassLoader();
        var widget = Class.forName("net.minecraft.client.gui.components.MultiLineEditBox", false, loader);
        var field = widget.getDeclaredField("textField");
        if (!field.trySetAccessible()) throw new AssertionError("Cannot access journal text field");
        var text = field.getType();
        var selection = text.getMethod("getSelected").getReturnType();
        for (String name : new String[]{"beginIndex", "endIndex"}) {
            if (!selection.getMethod(name).trySetAccessible()) throw new AssertionError("Cannot access selection boundary");
        }
        text.getMethod("getLineView", int.class); text.getMethod("cursor"); text.getMethod("setSelecting", boolean.class);
        System.out.println("Actual Minecraft 26.3 composer access verified.");
    }
}
