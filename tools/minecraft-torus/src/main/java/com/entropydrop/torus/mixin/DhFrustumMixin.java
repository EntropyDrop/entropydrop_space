package com.entropydrop.torus.mixin;
import com.entropydrop.torus.TorusShaders;
import org.joml.*;
import org.spongepowered.asm.mixin.*;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;
@Mixin(targets="com.seibel.distanthorizons.core.render.renderer.cullingFrustum.DhFrustumBounds",remap=false)
public class DhFrustumMixin {
 @Shadow @Final private FrustumIntersection frustum;
 @Shadow public float worldMinY;@Shadow public float worldMaxY;
 @Inject(method="intersects",at=@At("HEAD"),cancellable=true)
 private void spaceTorusCull(int x,int z,int width,int detail,CallbackInfoReturnable<Boolean> cir){if(!TorusShaders.enabled)return;var m=TorusShaders.MATH;var p=new Vector3d();double radius=m.sphere(x,worldMinY,z,x+(double)width,worldMaxY,z+(double)width,p);p.add(m.camera);cir.setReturnValue(frustum.testSphere((float)p.x,(float)p.y,(float)p.z,(float)radius));}
}
