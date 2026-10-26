import { warmGaussianPath } from './GaussianFarExperiment.ts';
import { createPointCloudTrial,POINT_MODES } from './PointCloudTrial.ts';
import { capturePointCloudPixels } from './PointCloudPixels.ts';
import { runPointCloudFrames } from './PointCloudFrames.ts';
if(import.meta.hot)import.meta.hot.accept();
export async function runPointCloudExperiment(game:any,options:{movingRepeat?:boolean}={}){
  await warmGaussianPath(game);const trial=await createPointCloudTrial(game);(window as any).pointTrial=trial;
  try{
    (window as any).pointProgress={state:'pixels'};const pixels=await capturePointCloudPixels(game,trial);
    const warmup=await runPointCloudFrames(game,trial,{motions:['across'],order:[...POINT_MODES],warmMs:600,sampleMs:800,tag:'excluded-warmup'});
    const comparison=await runPointCloudFrames(game,trial,options.movingRepeat?{motions:['acrossMove'],tag:'moving-replication'}:{});
    (window as any).pointProgress={state:'complete',world:comparison.world,blocks:comparison.rows.length};return{pixels,warmup,comparison};
  }finally{trial.dispose();}
}
