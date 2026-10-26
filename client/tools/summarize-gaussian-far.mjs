import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
const root=new URL('../src/dev/results/gaussian-2026-10-26/',import.meta.url);
const stats=values=>{if(!values.length||values.some(v=>!Number.isFinite(v)))throw Error('Invalid Gaussian samples.');
  const sorted=[...values].sort((a,b)=>a-b);return {count:values.length,mean:values.reduce((a,b)=>a+b,0)/values.length,
    p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],min:sorted[0],max:sorted.at(-1)};};
const summary={blocks:0,frames:0,gpuSamples:0,worlds:[]};
for(const world of ['aether-archipelago','nature','copper-metropolis']){
  const read=name=>JSON.parse(gunzipSync(readFileSync(new URL(`${world}/${name}.json.gz`,root))));
  const main=read('raw'),across=read('across'),run=main.comparison;
  for(const [capture,expected] of [[main,24],[across,12]]){
    const r=capture.comparison;
    if(r.rows.length!==expected||r.errors.length||capture.pixels.errors.length)throw Error('Incomplete or invalid run: '+world);
    if(r.width!==2560||r.height!==1440||r.quality!=='medium'||r.shadows||r.samples!==4)throw Error('Changed environment: '+world);
    if(Object.values(r.trial.modes).some(m=>!m.budgetMet))throw Error('Gaussian budget exceeded: '+world);
    for(const v of capture.pixels.views){if(v.rows[5].max!==0||v.rows[4].versusRepeat.max>1||!v.identicalPicking||!v.rows[3].changedOver2)throw Error('Image control failed: '+world);}
  }
  const pixels={...main.pixels,views:[main.pixels.views.find(v=>v.name==='near'),across.pixels.views.find(v=>v.name==='across')]};
  const entries=['sweep','move','across'].flatMap(motion=>['original','fine','coarse'].map(mode=>{
    const source=motion==='across'?across.comparison:run;
    const blocks=source.rows.filter(r=>r.motion===motion&&r.role===mode),raw=blocks.flatMap(r=>r.raw),gpu=blocks.flatMap(r=>r.gpu);
    if(blocks.length!==4||blocks.some(b=>b.materialsCreated))throw Error('Unwarmed candidate.');
    const metrics=Object.fromEntries(['frame','cpu','calls','triangles','farCalls','farTriangles','splats','sortMs','cullMs','uploadBytes','fallbackSources'].map(k=>[k,stats(raw.map(r=>r[k]))]));
    metrics.gpu=stats(gpu.map(r=>r.spanMs));summary.blocks+=blocks.length;summary.frames+=raw.length;summary.gpuSamples+=gpu.length;
    return {motion,mode,fps:1000/metrics.frame.mean,metrics,perBlockFps:blocks.map(b=>b.fps),perBlockGpuMean:blocks.map(b=>b.metrics.gpu.mean),
      pendingFrames:blocks.reduce((s,b)=>s+b.pendingFrames,0),maxFallbackDraws:Math.max(...raw.map(r=>r.fallbackDraws)),
      residents:blocks.map(b=>[b.residentStart,b.residentEnd])};
  }));
  const {rows,...environment}=run,{rows:acrossRows,...acrossEnvironment}=across.comparison;
  summary.worlds.push({world,environment,acrossEnvironment,entries,pixels});
  console.log(world,JSON.stringify(entries.map(e=>({motion:e.motion,mode:e.mode,fps:e.fps,gpu:e.metrics.gpu.mean,cpu:e.metrics.cpu.mean,
    sort:e.metrics.sortMs.mean,cull:e.metrics.cullMs.mean,splats:e.metrics.splats.mean,fallback:e.metrics.fallbackSources.max,blocks:e.perBlockFps}))));
}
writeFileSync(new URL('summary.json',root),JSON.stringify(summary,null,2)+'\n');
console.log({blocks:summary.blocks,frames:summary.frames,gpuSamples:summary.gpuSamples});
