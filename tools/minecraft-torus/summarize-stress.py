"""Validate and summarize native Firefox / native Minecraft stress captures."""
from pathlib import Path
import gzip,json,math,statistics
from PIL import Image
root=Path(__file__).resolve().parents[2]/'client/src/dev/results/torus-firefox-stress-2026-10-28'
worlds=['nature','copper-metropolis','aether-archipelago']
order=['control','dense','turn','move','move','turn','dense','control']
zones={(15,1),(15,2),(16,1),(16,2),(0,1),(0,2),(31,1),(31,2)}
def read(p):return json.loads(gzip.decompress(p.read_bytes()))
def stats(values):
 values=sorted(values);assert values and all(math.isfinite(v) and v>=0 for v in values)
 return {'mean':statistics.mean(values),'p50':values[len(values)//2],'p95':values[min(len(values)-1,int(.95*len(values)))],'p99':values[min(len(values)-1,int(.99*len(values)))],'count':len(values)}
def frames(values):
 s=stats(values);assert min(values)>0
 s.update(fps=1000/s['mean'],onePercentLow=1000/statistics.mean(sorted(values,reverse=True)[:max(1,math.ceil(len(values)*.01))]),over16msPercent=sum(v>1000/60 for v in values)/len(values)*100,over33msPercent=sum(v>1000/30 for v in values)/len(values)*100)
 return s
result={'schema':1,'worlds':[],'nativeFrames':0,'firefoxFrames':0,'gpuSamples':0}
for world in worlds:
 n=read(root/'minecraft'/world/'torus-stress-minecraft.json.gz');f=read(root/'firefox'/world/'result.json.gz')
 validation=json.loads((root/'minecraft'/world/'torus-validation.json').read_text())
 assert validation['allCellsVerified'] and validation['sourceSha256']==n['source']
 assert (n['width'],n['height'],f['width'],f['height'])==(2560,1440,2560,1440)
 assert n['glSamples']==f['samples']==0 and n['fixedCellSize']==f['fixedCellSize']==1
 assert n['fixedSections']==512 and n['fixedPending']==0 and len(set(n['fixedPositions']))==512
 assert n['verticalQuality']=='PIXEL_ART' and 'Firefox/' in f['userAgent'] and not f['errors']
 assert [r['mode']for r in n['rows']]==[r['mode']for r in f['rows']]==order
 for data in [n,f]:
  for row in data['rows']:assert abs(row['effectiveFov']-(70 if row['mode']=='control' else 100))<.001
 for row in f['rows']:
  assert len(row['sourceMips'])==8 and all(1 in s['sizes']for s in row['sourceMips'])
  assert {(s['x'],s['z'])for s in row['sourceMips']}==zones
  assert row['raw'] and row['gpu'] and min(v['phaseSeconds']for v in row['raw'])>=6
  assert max(v['phaseSeconds']for v in row['raw'])>=18
 item={'terrain':world,'source':n['source'],'modes':{}}
 for mode in dict.fromkeys(order):
  nr=[r for r in n['rows']if r['mode']==mode];fr=[r for r in f['rows']if r['mode']==mode]
  nv=[v for r in nr for v in r['framesMs']];raw=[v for r in fr for v in r['raw']];gpu=[v['spanMs']for r in fr for v in r['gpu']]
  result['nativeFrames']+=len(nv);result['firefoxFrames']+=len(raw);result['gpuSamples']+=len(gpu)
  native=frames(nv);native['blockFps']=[1000/statistics.mean(r['framesMs'])for r in nr]
  ff=frames([v['frame']for v in raw]);ff['blockFps']=[1000/statistics.mean(v['frame']for v in r['raw'])for r in fr]
  for key in ['cpu','renderCpu','terrainCpu','calls','visibleFaces','residentFaces']:ff[key]=stats([v[key]for v in raw])
  ff['gpu']=stats(gpu);ff['blockGpu']=[statistics.mean(v['spanMs']for v in r['gpu'])for r in fr]
  ff['nearNotReadyPercent']=sum(not v['nearReady']for v in raw)/len(raw)*100
  ff['farPendingPercent']=sum(v['farPending']for v in raw)/len(raw)*100
  for browser,prefix in [('minecraft','stress'),('firefox','stress')]:
   for i,m in enumerate(order):
    if m!=mode:continue
    with Image.open(root/browser/world/f'{prefix}-{i}-{mode}.png')as image:assert image.size==(2560,1440);image.verify()
  item['modes'][mode]={'native':native,'firefox':ff}
 result['worlds'].append(item)
(root/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
for world in result['worlds']:
 print(world['terrain'])
 for mode,m in world['modes'].items():print(mode,'native',round(m['native']['fps'],1),'Firefox',round(m['firefox']['fps'],1),'CPU',round(m['firefox']['cpu']['mean'],2),'GPU',round(m['firefox']['gpu']['mean'],2),'near pending',round(m['firefox']['nearNotReadyPercent'],1))
