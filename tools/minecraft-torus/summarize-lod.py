"""Summarize accepted matched-detail and production-LOD A/B blocks."""
from pathlib import Path
import gzip, json, statistics, math
from PIL import Image, ImageChops, ImageStat
root=Path(__file__).resolve().parents[2]/'client/src/dev/results/torus-lod-alignment-2026-10-28'
terrains=['nature','copper-metropolis','aether-archipelago']
def read(path):
 return json.loads(path.read_text()) if path.exists() else json.loads(gzip.decompress(Path(str(path)+'.gz').read_bytes()))
def stats(values):
 values=sorted(values);assert values
 return dict(mean=statistics.mean(values),p95=values[min(len(values)-1,int(len(values)*.95))],count=len(values))
def difference(a,b):
 a=Image.open(a).convert('RGB');b=Image.open(b).convert('RGB');assert a.size==b.size==(1280,720)
 diff=ImageChops.difference(a,b);changed=sum(1 for p in diff.getdata() if max(p)>0)
 return dict(changedPixels=changed,changedFraction=changed/(1280*720),meanAbsoluteChannelError=statistics.mean(ImageStat.Stat(diff).mean),maxChannelError=max(v[1] for v in diff.getextrema()))
summary=dict(schema=1,worlds=[])
for terrain in terrains:
 native=read(root/'minecraft'/terrain/'torus-minecraft.json')
 assert native['fixedSections']==512 and native['fixedPending']==0 and len(set(native['fixedPositions']))==512
 assert abs(native['effectiveFov']-70)<.001
 assert native['fixedCellSize']==1 and native['verticalQuality']=='PIXEL_ART' and len(native['rows'])==4
 world=dict(terrain=terrain,native={},space={})
 for mode in ['torus','across']:
  rows=[r for r in native['rows'] if r['mode']==mode];assert len(rows)==2
  frame=stats([f for r in rows for f in r['framesMs']]);world['native'][mode]=dict(frame=frame,fps=1000/frame['mean'],blockFps=[1000/statistics.mean(r['framesMs'])for r in rows])
 for profile in ['fixed','adaptive','maintenance']:
  path=root/'space'/profile/terrain;data=read(path/'result.json');assert not data['errors']
  assert data['width']==1280 and data['height']==720 and data['samples']==0
  assert len(data['rows'])==(12 if profile=='adaptive' else 8)
  if profile=='maintenance':assert abs(math.degrees(2*math.atan(1/data['projectionY']))-70)<.00001
  result={}
  for mode in (['torus','across'] if profile=='fixed' else ['torus','turn'] if profile=='maintenance' else ['torus','across','turn']):
   item={}
   candidate='cpu' if profile=='maintenance' else 'tight'
   for variant in ['reference',candidate]:
    rows=[r for r in data['rows'] if r['mode']==mode and r['variant']==variant];assert len(rows)==2
    raw=[f for r in rows for f in r['raw']];gpu=[f['spanMs']for r in rows for f in r['gpu']]
    assert raw and gpu and not any(f['pending']for f in raw)
    if profile=='fixed':
     assert all(len(r['sourceMips'])==8 and all(1 in s['sizes']for s in r['sourceMips'])for r in rows)
    frame=stats([f['frame']for f in raw]);item[variant]=dict(frame=frame,fps=1000/frame['mean'],cpu=stats([f['cpu']for f in raw]),terrainCpu=stats([f.get('terrainCpu',0)for f in raw]),gpu=stats(gpu),faces=statistics.mean(f['visibleFaces']for f in raw),drawnFaces=statistics.mean(f['drawnFaces']for f in raw),residentFaces=statistics.mean(f['residentFaces']for f in raw),tightFraction=statistics.mean(f['tightIdle']for f in raw),blockGpu=[statistics.mean(f['spanMs']for f in r['gpu'])for r in rows],blockCpu=[statistics.mean(f['cpu']for f in r['raw'])for r in rows],blockTerrainCpu=[statistics.mean(f.get('terrainCpu',0)for f in r['raw'])for r in rows])
   item['gpuChangePercent']=(item[candidate]['gpu']['mean']/item['reference']['gpu']['mean']-1)*100
   item['cpuChangePercent']=(item[candidate]['cpu']['mean']/item['reference']['cpu']['mean']-1)*100
   if profile=='maintenance':item['terrainCpuChangePercent']=(item[candidate]['terrainCpu']['mean']/item['reference']['terrainCpu']['mean']-1)*100
   item['faceChangePercent']=(item[candidate]['faces']/item['reference']['faces']-1)*100
   if mode!='turn':item['imageDifference']=difference(path/f'reference-{mode}.png',path/f'{candidate}-{mode}.png')
   result[mode]=item
  world['space'][profile]=result
 summary['worlds'].append(world)
(root/'summary.json').write_text(json.dumps(summary,indent=2))
for w in summary['worlds']:
 print(w['terrain'], 'native', {m:round(v['fps'],1)for m,v in w['native'].items()})
 for profile,modes in w['space'].items():
  for mode,m in modes.items():
   candidate='cpu' if profile=='maintenance' else 'tight'
   print(profile,mode,'GPU',round(m['reference']['gpu']['mean'],3),'->',round(m[candidate]['gpu']['mean'],3),'delta',round(m['gpuChangePercent'],1),'faces',round(m['faceChangePercent'],1),'tight fraction',m[candidate]['tightFraction'],'image',m.get('imageDifference'))
