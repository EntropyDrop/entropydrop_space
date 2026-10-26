import { interceptMethod } from './FrameDiagnostics.ts';
import { createGaussianFarTrial } from './GaussianFarTrial.ts';
import { runGaussianFarFrames } from './GaussianFarFrames.ts';
import { captureGaussianFarPixels } from './GaussianFarPixels.ts';
if(import.meta.hot)import.meta.hot.accept();

/** Preload the real moving path before constructing immutable far proxies. */
export async function warmGaussianPath(game:any) {
  const saved={position:game.playerPhysics.position.clone(),yaw:game.controller.yaw,pitch:game.controller.pitch};
  let undo=()=>{},start=0;
  try {
    (window as any).gaussianProgress={state:'warming-original-path'};
    await new Promise<void>(resolve=>{undo=interceptMethod(game,'animate',(original,args)=>{
      const now=performance.now();start||=now;const elapsed=now-start,t=elapsed/3000;
      game.controller.yaw=Math.PI/2+.6*Math.sin(t*Math.PI*2);game.controller.pitch=-.85;
      game.playerPhysics.position.copy(saved.position);game.playerPhysics.position.x+=16*Math.sin(t*Math.PI*2);game.playerPhysics.position.z+=8*(1-Math.cos(t*Math.PI*2));
      game.playerPhysics.velocity.set(0,0,0);game.playerPhysics.resetRenderInterpolation();original(...args);if(elapsed>=9000)resolve();
    });});
  }finally{undo();game.playerPhysics.position.copy(saved.position);game.playerPhysics.velocity.set(0,0,0);game.playerPhysics.resetRenderInterpolation();game.controller.yaw=saved.yaw;game.controller.pitch=saved.pitch;}
  let stable=0;for(let i=0;stable<90&&i<3600;i++){
    await new Promise<void>(r=>requestAnimationFrame(()=>r()));const layer=game.world.distantSurface.voxels;
    stable=!layer.hasPendingWork&&!layer.hasPendingTransitions?stable+1:0;
  }
  if(stable<90)throw new Error('Original path did not settle.');
}

export async function runGaussianFarExperiment(game:any) {
  await warmGaussianPath(game);
  const trial=await createGaussianFarTrial(game);(window as any).gaussianTrial=trial;
  try {
    const pixels=await captureGaussianFarPixels(game,trial);
    const warmup=await runGaussianFarFrames(game,trial,{motions:['sweep'],order:['original','fine','coarse'],warmMs:1000,sampleMs:1500,tag:'excluded-warmup'});
    const comparison=await runGaussianFarFrames(game,trial);
    (window as any).gaussianProgress={state:'complete',world:comparison.world,blocks:comparison.rows.length};
    return {comparison,pixels,warmup};
  }finally{trial.dispose();}
}

export async function runGaussianAcrossExperiment(game:any) {
  await warmGaussianPath(game);
  const trial=await createGaussianFarTrial(game);(window as any).gaussianTrial=trial;
  try {
    const pixels=await captureGaussianFarPixels(game,trial);
    const comparison=await runGaussianFarFrames(game,trial,{motions:['across'],tag:'visible-far-across'});
    (window as any).gaussianProgress={state:'complete',world:comparison.world,blocks:comparison.rows.length,tag:'visible-far-across'};
    return {comparison,pixels};
  }finally{trial.dispose();}
}
