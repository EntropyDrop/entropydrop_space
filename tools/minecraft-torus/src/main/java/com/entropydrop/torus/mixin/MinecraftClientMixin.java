package com.entropydrop.torus.mixin;
import com.entropydrop.torus.TorusBenchmark;
import net.minecraft.client.MinecraftClient;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
@Mixin(MinecraftClient.class)
public class MinecraftClientMixin {
 @Inject(method="render",at=@At("HEAD"))private void spaceTorusFrame(boolean tick,CallbackInfo ci){TorusBenchmark.beforeFrame();}
}
