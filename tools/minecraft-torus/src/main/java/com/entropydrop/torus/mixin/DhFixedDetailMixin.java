package com.entropydrop.torus.mixin;
import com.entropydrop.torus.TorusBenchmark;
import com.seibel.distanthorizons.core.pos.DhSectionPos;
import com.seibel.distanthorizons.core.pos.blockPos.DhBlockPos2D;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;
/** Refine only the eight nonempty fixture zones, never an entire 576-chunk disk. */
@Mixin(targets="com.seibel.distanthorizons.core.render.QuadTree.LodQuadTree",remap=false)
public class DhFixedDetailMixin {
 private long lastAudit;
 @Inject(method="populateListWithEnabledRenderSections",at=@At("RETURN"))
 private void audit(java.util.ArrayList<com.seibel.distanthorizons.core.render.QuadTree.LodRenderSection> sections,org.spongepowered.asm.mixin.injection.callback.CallbackInfo ci){
  if(!TorusBenchmark.fixedDetailActive || System.nanoTime()-lastAudit<1_000_000_000L)return;
  lastAudit=System.nanoTime();int count=0,pending=0;java.util.ArrayList<Long> positions=new java.util.ArrayList<>();
  for(var section:sections){long pos=section.pos;int x=DhSectionPos.getMinCornerBlockX(pos),z=DhSectionPos.getMinCornerBlockZ(pos);
   if(DhSectionPos.getDetailLevel(pos)!=6 || z<512 || z>=1536)continue;
   int zone=Math.floorDiv(x,512);if(zone!=0 && zone!=15 && zone!=16 && zone!=31)continue;
   count++;positions.add(pos);if(section.gpuUploadInProgress() || !section.gpuUploadComplete())pending++;
  }
  TorusBenchmark.fixedSections=count;TorusBenchmark.fixedPending=pending;TorusBenchmark.fixedPositions=positions;
 }

 @Inject(method="calcExpectedDetailLevel(Lcom/seibel/distanthorizons/core/pos/blockPos/DhBlockPos2D;JIID)B",at=@At("HEAD"),cancellable=true)
 private void fixed(DhBlockPos2D camera,long pos,int x,int z,double radius,CallbackInfoReturnable<Byte> result){
  if(!TorusBenchmark.fixedDetailActive)return;
  int left=DhSectionPos.getMinCornerBlockX(pos),top=DhSectionPos.getMinCornerBlockZ(pos),width=DhSectionPos.getBlockWidth(pos);
  // A graded halo keeps neighboring quadtree levels compatible. An abrupt
  // return to the default distance policy violates DH's parent/child invariant.
  double distance=Double.POSITIVE_INFINITY;
  for(int zone:new int[]{0,15,16,31}){
   double dx=Math.max(0,Math.max(zone*512-(left+width),left-(zone+1)*512));
   double dz=Math.max(0,Math.max(512-(top+width),top-1536));
   distance=Math.min(distance,Math.max(dx,dz));
  }
  int level=distance<=64?0:Math.max(0,(int)Math.floor(Math.log(distance/64)/Math.log(2)));
  result.setReturnValue((byte)level);
 }
}
