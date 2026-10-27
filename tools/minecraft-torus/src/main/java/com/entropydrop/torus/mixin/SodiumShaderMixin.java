package com.entropydrop.torus.mixin;
import com.entropydrop.torus.TorusShaders;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
@Mixin(targets="net.caffeinemc.mods.sodium.client.gl.shader.GlShader",remap=false)
public class SodiumShaderMixin {
 @ModifyVariable(method="<init>",at=@At("HEAD"),argsOnly=true,ordinal=0)
 private static String spaceTorusSource(String source){return TorusShaders.patch(source);}
}
