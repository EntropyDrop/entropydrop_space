package com.entropydrop.torus.mixin;
import com.entropydrop.torus.TorusShaders;
import org.joml.*;
import org.spongepowered.asm.mixin.*;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;
@Mixin(targets="net.caffeinemc.mods.sodium.client.render.viewport.frustum.SimpleFrustum",remap=false)
public class SodiumFrustumMixin {
 @Shadow @Final private FrustumIntersection frustum;
 @Inject(method="testAab",at=@At("HEAD"),cancellable=true)
 private void spaceTorusCull(float x0,float y0,float z0,float x1,float y1,float z1,CallbackInfoReturnable<Boolean> cir){if(!TorusShaders.enabled)return;var m=TorusShaders.MATH;var p=new Vector3d();double radius=m.sphere(x0+m.camera.x,y0+m.camera.y,z0+m.camera.z,x1+m.camera.x,y1+m.camera.y,z1+m.camera.z,p);cir.setReturnValue(frustum.testSphere((float)p.x,(float)p.y,(float)p.z,(float)radius));}
}
