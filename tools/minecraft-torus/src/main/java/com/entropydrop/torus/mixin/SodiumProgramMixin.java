package com.entropydrop.torus.mixin;
import com.entropydrop.torus.TorusShaders;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
@Mixin(targets="net.caffeinemc.mods.sodium.client.gl.shader.GlProgram",remap=false)
public class SodiumProgramMixin {
 @Inject(method="bind",at=@At("TAIL")) private void spaceTorusBind(CallbackInfo ci){TorusShaders.upload();}
}
