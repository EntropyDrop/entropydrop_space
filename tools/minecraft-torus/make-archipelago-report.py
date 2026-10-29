"""Audit the Firefox-only follow-up and render its local report."""
from pathlib import Path
import gzip,json,statistics,math
from PIL import Image
import numpy as np
base=Path(__file__).resolve().parents[2]
root=base/'client/src/dev/results/archipelago-seam-optimization-2026-10-28'
folder=root/'firefox/aether-archipelago'
labels={'baseline':'Original coverage / full maps','seam':'Corrected coverage / full maps','optimized':'Corrected coverage / incremental maps','repeat':'Full-map reference repeated'}
def mean(v):return statistics.mean(v)
def stats(rows):
 raw=[v for r in rows for v in r['raw']];frames=sorted(v['frame']for v in raw)
 return dict(fps=1000/mean(frames),p95=frames[int(len(frames)*.95)],p99=frames[int(len(frames)*.99)],
  onePercentLow=1000/mean(frames[-math.ceil(len(frames)*.01):]),frames=len(frames),
  blockFps=[1000/mean(v['frame']for v in r['raw'])for r in rows],cpu=mean(v['cpu']for v in raw),
  gpu=mean(v['spanMs']for r in rows for v in r['gpu']),mapKiB=mean(v['arenaMapBytes']for v in raw)/1024,
  nearPendingPercent=mean(not v['nearReady']for v in raw)*100,
  probes={k:mean(v['probes'].get(k,0)for v in raw)for k in raw[0]['probes']})
results={};rawruns={}
for run in labels:
 d=json.loads(gzip.decompress((folder/run/'result.json.gz').read_bytes()));rawruns[run]=d
 assert 'Firefox/'in d['userAgent']and d['terrain']=='aether-archipelago'and not d['errors']
 assert (d['width'],d['height'],d['samples'],d['fixedCellSize'])==(2560,1440,0,1)
 assert [r['mode']for r in d['rows']]==['dense','move','move','dense']
 for r in d['rows']:
  assert abs(r['effectiveFov']-100)<.001
  assert len(r['sourceMips'])==8 and all(1 in s['sizes']for s in r['sourceMips'])
  assert r['raw']and r['gpu']and min(v['phaseSeconds']for v in r['raw'])>=6 and max(v['phaseSeconds']for v in r['raw'])>=18
  for v in r['raw']:assert v['frame']>0 and all(math.isfinite(v[k])for k in ['frame','cpu','terrainCpu','renderCpu'])
  with Image.open(folder/run/f"stress-{r['block']}-{r['mode']}.png")as im:assert im.size==(2560,1440);im.verify()
 if run in ['optimized','repeat']:assert d['mapUploadPixelCheck']['changedPixels']==0
 results[run]={mode:stats([r for r in d['rows']if r['mode']==mode])for mode in ['dense','move']}
probe=json.loads((folder/'coverage-probe.json').read_text());assert probe['passed']and not probe['errors']
assert all(c['wrongPixels']==0 for c in probe['cases']if not c['legacy'])
# Compare identically framed, settled captures. This is a visual difference
# metric, not a claim that every changed pixel used to be a hole.
before=np.asarray(Image.open(folder/'baseline/stress-3-dense.png').convert('RGB')).astype(int)
after=np.asarray(Image.open(folder/'seam/stress-3-dense.png').convert('RGB')).astype(int)
changed=np.any(before!=after,axis=2)
sky=before[0,0];filled=np.all(before==sky,axis=2)&np.any(after!=sky,axis=2)
visual={'changedPixels':int(changed.sum()),'previousBackgroundNowGeometry':int(filled.sum()),'totalPixels':2560*1440,'note':'Background-color difference is a screen-space indicator, not a complete hole detector.'}
summary={'runs':results,'coverageProbe':probe,'visual':visual}
(root/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
assets='../src/dev/results/archipelago-seam-optimization-2026-10-28/'
rows=[]
for run,label in labels.items():
 for mode,s in results[run].items():
  rows.append(f'<tr><td>{label}<small>{mode}</small></td><td>{s["fps"]:.1f}<small>{" / ".join(f"{v:.1f}"for v in s["blockFps"])}</small></td><td>{s["p95"]:.1f}</td><td>{s["cpu"]:.2f}</td><td>{s["probes"]["arena"]:.2f}</td><td>{s["gpu"]:.2f}</td><td>{s["mapKiB"]:.1f}</td><td>{s["nearPendingPercent"]:.1f}%</td></tr>')
shots=''.join(f'<figure><a href="{assets}firefox/aether-archipelago/{run}/stress-3-dense.png"><img width="2560" height="1440" src="{assets}firefox/aether-archipelago/{run}/stress-3-dense.png" alt="{label}"></a><figcaption>{label}</figcaption></figure>'for run,label in list(labels.items())[:3])
html=f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aether Archipelago: seam repair and Firefox optimization</title><style>body{{margin:0;background:#111925;color:#e8eff6;font:16px/1.65 system-ui}}main{{max-width:1280px;margin:auto;padding:40px 28px}}h1{{font-size:40px;line-height:1.2}}h2{{margin-top:40px}}p{{color:#b8c9dc}}a{{color:#8dcaff}}.note{{background:#203348;border-left:3px solid #81dcc5;padding:18px}}.scroll{{overflow:auto}}table{{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}}th,td{{padding:12px;border-bottom:1px solid #3d4f60;text-align:right}}th:first-child,td:first-child{{text-align:left}}small{{display:block;color:#9fbbd0;font-size:12px}}figure{{margin:20px 0}}img{{width:100%;height:auto}}figcaption{{color:#b8c9dc}}.tag{{font-size:12px;letter-spacing:2px;color:#81dcc5}}</style><main><div class="tag">FIREFOX ONLY · AETHER ARCHIPELAGO · 28 OCTOBER 2026</div><h1>Repair ownership seams,<br>then reduce redundant GPU uploads.</h1><p><a href="#results">Measured results</a> · <a href="#correctness">Correctness</a> · <a href="#images">Images</a></p>
<p class="note">All new terrain measurements use native Firefox and Aether Archipelago only. Actual framebuffer 2560 × 1440, no MSAA, 1 m cells, the same eight fixture zones (6.25% of the world), 8-chunk near radius and 576-chunk far radius. No geometry, visibility guard, shading quality or cache capacity was reduced.</p>
<h2 id="findings">Measured outcome</h2><p class="note">Moving map uploads fall from about 1,062 KiB to 79 KiB per frame, a 92.6% reduction. Moving FPS is about 80 with full uploads and 82 with incremental uploads. The repeated full-upload blocks range from 72.5 to 86.8 FPS, so this experiment establishes lower upload traffic, not a statistically demonstrated FPS gain.</p><h2 id="results">Stationary and moving frame performance</h2><p>Each run warms for 60 seconds, then measures dense/move/move/dense. Each block warms for 6 seconds and samples for 12 seconds. The dense camera uses 100° vertical FOV and 55° downward pitch. Movement uses the previous 6-second, 64 m × 32 m route. CPU and GPU spans overlap. The arena span is part of CPU time. Map KiB is scheduled upload volume per frame, not total GPU traffic.</p><div class="scroll"><table><thead><tr><th>Version / case</th><th>FPS<small>two blocks</small></th><th>P95 ms</th><th>CPU ms</th><th>Arena ms</th><th>GPU ms</th><th>Map KiB</th><th>Near pending</th></tr></thead><tbody>{''.join(rows)}</tbody></table></div><p>The last run restores full map uploads with the repaired shader. This reference repeat helps distinguish upload savings from run-to-run drift. Firefox's approximately 120 Hz presentation ceiling limits interpretation of stationary FPS; two blocks per run are not a confidence interval. Near-pending fractions describe readiness states, not missing-screen percentages.</p>
<h2 id="correctness">Correctness evidence</h2><p>The original shader rounded world coordinates to chunk IDs at vertices, then interpolated those IDs. This can advance ownership halfway across a face and interpolate across the entire texture at a periodic seam. The repaired shader interpolates continuous coordinates before wrapping and rounding in the fragment stage.</p><p>All six GPU ownership probes match independent expected pixels after repair. The old shader fails five of them. The settled terrain captures differ at {visual['changedPixels']:,} pixels; {visual['previousBackgroundNowGeometry']:,} previously background-colored pixels now contain geometry. That count is an indicator, not a complete hole detector.</p><p>Incremental uploads retain a revision for the actual visible block list, plus its immediately previous page placement. Unchanged spans keep their GPU contents. Hidden/reappearing entries, shifted spans, changed storage and pending uploads are explicitly covered by regression tests. The optimized and full-upload paths produce identical RGBA pixels at the settled dense pose in both final runs.</p><p class="note">This fixes the demonstrated coverage-mask defect. It does not establish pixel-identical reconstruction with Minecraft or prove that every possible LOD transition is artifact-free. Moving streaming readiness remains a separate performance and completeness issue.</p>
<h2 id="images">Same pose, before and after</h2><p>Open full-resolution images to inspect fine boundaries. Lighting and source data are unchanged; screenshots are captured outside timed samples.</p>{shots}
<h2>Audit and reproduction</h2><p><a href="{assets}summary.json">Summary and GPU probe</a> · <a href="{assets}validation.json">Validation</a> · <a href="../../tools/minecraft-torus/README.md">Reproduction</a></p><ul>{''.join(f'<li>{label}: <a href="{assets}firefox/aether-archipelago/{run}/result.json.gz">raw frames</a></li>'for run,label in labels.items())}</ul></main></html>'''
(base/'client/docs/performance-archipelago-seam-2026-10-28.html').write_text(html)
for run,modes in results.items():
 print(run)
 for mode,s in modes.items():print(mode,{k:round(s[k],2)for k in ['fps','p95','cpu','gpu','mapKiB']})
