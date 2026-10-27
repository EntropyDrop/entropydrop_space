package com.entropydrop.spacebench.mixin;
import com.entropydrop.spacebench.MatchedBenchmark;
import net.minecraft.client.MinecraftClient;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
@Mixin(MinecraftClient.class)
public class MinecraftClientMixin {
    @Inject(method="render",at=@At("HEAD"))
    private void spacebenchFrame(boolean tick, CallbackInfo ci){MatchedBenchmark.beforeFrame();}
}
