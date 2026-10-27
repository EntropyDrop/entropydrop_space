"""Summarize accepted raw samples; reject incomplete or interrupted captures."""
from pathlib import Path
import json,statistics,gzip
root=Path(__file__).resolve().parents[2]/'client/src/dev/results/torus-minecraft-2026-10-27'
def read(p):
 if p.exists():return json.loads(p.read_text())
 return json.loads(gzip.decompress(Path(str(p)+'.gz').read_bytes()))
def stats(values):
 ordered=sorted(values)
 return {'mean':statistics.mean(values),'p95':ordered[min(len(ordered)-1,int(len(ordered)*.95))],'count':len(values)}
summary={'schema':1,'worlds':[],'nativeFrames':0,'spaceFrames':0,'gpuSamples':0}
for terrain in ['nature','copper-metropolis','aether-archipelago']:
 native=read(root/'minecraft'/terrain/'torus-minecraft.json');space=read(root/'space'/terrain/'result.json')
 assert len(native['rows'])==len(space['rows'])==6
 assert native['width']==space['width']==1280 and native['height']==space['height']==720
 assert not space['errors'] and native['sodiumPatches']>0 and native['dhPatches']>0
 validation=read(root/'minecraft'/terrain/'torus-validation.json');assert validation['allCellsVerified'] and validation['chunks']==8192 and validation['sourceSha256']==native['source']
 world={'terrain':terrain,'sha256':native['source'],'modes':{}}
 for mode in ['flat','torus','across']:
  nr=[r for r in native['rows'] if r['mode']==mode];sr=[r for r in space['rows'] if r['mode']==mode]
  nf=[f for r in nr for f in r['framesMs']];sf=[f for r in sr for f in r['raw']];gpu=[f['spanMs'] for r in sr for f in r['gpu']]
  assert len(nr)==len(sr)==2 and min(len(r['framesMs']) for r in nr)>0 and gpu
  frame=stats([f['frame']for f in sf]);cpu=stats([f['cpu']for f in sf]);ng=stats(nf)
  world['modes'][mode]={'native':{'frame':ng,'fps':1000/ng['mean'],'blockFps':[1000/statistics.mean(r['framesMs'])for r in nr]},'space':{'frame':frame,'fps':1000/frame['mean'],'cpu':cpu,'gpuSpan':stats(gpu),'faces':statistics.mean(f['visibleFaces']for f in sf),'triangles':statistics.mean(f['triangles']for f in sf),'drawCalls':statistics.mean(f['calls']for f in sf),'pendingFraction':sum(bool(f['pending'])for f in sf)/len(sf),'blockGpuSpan':[statistics.mean(f['spanMs']for f in r['gpu'])for r in sr]}}
  summary['nativeFrames']+=len(nf);summary['spaceFrames']+=len(sf);summary['gpuSamples']+=len(gpu)
 summary['worlds'].append(world)
(root/'summary.json').write_text(json.dumps(summary,indent=2))
for world in summary['worlds']:
 print(world['terrain'])
 for mode,d in world['modes'].items():print(mode, 'native FPS',round(d['native']['fps'],1),'space FPS',round(d['space']['fps'],1),'CPU',round(d['space']['cpu']['mean'],3),'GPU',round(d['space']['gpuSpan']['mean'],3),'faces',round(d['space']['faces']),'pending',d['space']['pendingFraction'])
