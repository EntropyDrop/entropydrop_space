package com.entropydrop.torus.mixin;
import com.entropydrop.torus.TorusShaders;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
@Mixin(targets="com.seibel.distanthorizons.common.render.openGl.glObject.shader.GlShaderProgram",remap=false)
public class DhProgramMixin {
 @Inject(method="bind",at=@At("TAIL")) private void spaceTorusBind(CallbackInfo ci){TorusShaders.upload();}
}
