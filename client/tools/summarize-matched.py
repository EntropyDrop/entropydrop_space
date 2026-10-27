#!/usr/bin/env python3
"""Validate raw captures and build the repository's matched-terrain report."""
import json, statistics, gzip
from pathlib import Path
root=Path(__file__).resolve().parents[1]
data=root/'src/dev/results/matched-terrain-2026-10-27'
def read(p):
 path=data/p
 if path.exists():
  raw=path.read_bytes()
  if p.endswith('/result.json') or p=='minecraft/matched-minecraft.json':
   (data/(p+'.gz')).write_bytes(gzip.compress(raw,mtime=0))
 else:raw=gzip.decompress((data/(p+'.gz')).read_bytes())
 return json.loads(raw)
def stats(values):
 v=sorted(values)
 assert v and all(0 <= n < 10000 for n in v)
 return {'mean':statistics.mean(v),'p50':v[len(v)//2],'p95':v[min(len(v)-1,int(len(v)*.95))],'n':len(v)}
def space(name):
 d=read(name+'/result.json');assert d['width']==1280 and d['height']==720 and d['samples']==0 and d['terrainCrc32']=='bef315c8'
 assert len(d['rows'])==8 and not d['errors']
 result={}
 for mode in sorted(set(r['mode'] for r in d['rows'])):
  rows=[r for r in d['rows'] if r['mode']==mode];assert len(rows)==4
  frames=[f for r in rows for f in r['raw']];gpu=[g['spanMs'] for r in rows for g in r['gpu']]
  assert len(gpu)>80
  result[mode]={'frame':stats([f['frame'] for f in frames]),'cpu':stats([f['cpu'] for f in frames]),'gpu':stats(gpu),
   'faces':statistics.mean(f['visibleFaces'] for f in frames),'calls':statistics.mean(f['calls'] for f in frames),
   'triangles':statistics.mean(f['triangles'] for f in frames),'pendingFrames':sum(f['pending'] for f in frames),
   'blockGpuMeans':[statistics.mean(g['spanMs'] for g in r['gpu']) for r in rows]}
 return d,result
mc=read('minecraft/matched-minecraft.json');v=read('minecraft/matched-validation.json')
assert mc['width']==1280 and mc['height']==720 and len(mc['rows'])==8 and v['chunks']==4096 and v['canonicalVolumeCrc32']=='bef315c8'
native={}
for mode in [False,True]:
 rows=[r for r in mc['rows'] if r['dh']==mode];assert len(rows)==4
 native['dh' if mode else 'near']=stats([f for r in rows for f in r['framesMs']])
b,baseline=space('space-baseline');s,static=space('space-static');m,moving=space('space')
assert m['moving'] and len(m['pixels'])==19
for d in [s,m]:
 assert all(r['changedOver2']==0 and r['max']==0 for r in d['pixels'] if r['mode']!='near')
 assert d['pixels'][1]['visibleFaces']<d['pixels'][0]['visibleFaces']*.9
out={'native':native,'spaceBaseline':baseline,'spaceStatic':static,'spaceMoving':moving,
 'staticGpuReductionPercent':100*(1-static['flat']['gpu']['mean']/static['wide']['gpu']['mean']),
 'movingGpuReductionPercent':100*(1-moving['flat']['gpu']['mean']/moving['wide']['gpu']['mean']),
 'staticFaceReductionPercent':100*(1-static['flat']['faces']/static['wide']['faces']),
 'canonicalVolume':v,'minecraftMods':mc['mods'],'pixelChecks':m['pixels']}
(data/'summary.json').write_text(json.dumps(out,indent=2)+'\n')
def row(label,frame,cpu=None,gpu=None,faces=None):
 return '<tr>'+''.join('<td>'+x+'</td>' for x in [label,f'{1000/frame["mean"]:.1f}',f'{frame["mean"]:.3f}',f'{frame["p95"]:.3f}',f'{cpu["mean"]:.3f}' if cpu else '—',f'{gpu["mean"]:.3f}' if gpu else '—',f'{faces:,.0f}' if faces is not None else '—'])+'</tr>'
def table(rows):return '<table><thead><tr><th>Configuration</th><th>FPS</th><th>Frame ms</th><th>p95 frame</th><th>CPU ms</th><th>GPU span ms</th><th>Far faces submitted</th></tr></thead><tbody>'+''.join(rows)+'</tbody></table>'
base_rows=[row('Minecraft + Sodium / near',native['near']),row('Minecraft + Sodium + DH',native['dh'])]
for mode in ['near','wide']:
 r=baseline[mode];base_rows.append(row('Space / '+('near' if mode=='near' else 'near + far'),r['frame'],r['cpu'],r['gpu'],r['faces'] if mode!='near' else 0))
opt_rows=[]
for motion,group in [('Fixed',static),('Moving',moving)]:
 for mode in ['wide','flat']:
  r=group[mode];opt_rows.append(row(motion+' / '+('previous' if mode=='wide' else 'flat culling'),r['frame'],r['cpu'],r['gpu'],r['faces']))
imagebase='../src/dev/results/matched-terrain-2026-10-27/'
def figure(path,caption):return f'<figure><a href="{imagebase+path}"><img src="{imagebase+path}" alt="{caption}" loading="lazy"></a><figcaption>{caption}</figcaption></figure>'
report=f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Matched terrain: Minecraft DH and Space</title>
<style>body{{margin:0;background:#10151d;color:#dce6f3;font:16px/1.6 system-ui}}main{{max-width:1200px;margin:auto;padding:48px 24px}}h1{{font-size:42px;line-height:1.15}}h2{{margin-top:44px}}p{{max-width:1000px}}a{{color:#8dccff}}.tag{{color:#70e3ba;letter-spacing:.08em}}.cards,.images{{display:grid;grid-template-columns:1fr 1fr;gap:16px}}.card{{padding:24px;background:#1c2939;border-radius:14px}}.big{{font-size:36px;font-weight:700}}table{{width:100%;border-collapse:collapse;font-size:14px}}td,th{{text-align:right;padding:12px;border-bottom:1px solid #344258}}td:first-child,th:first-child{{text-align:left}}figure{{margin:0}}img{{width:100%;display:block}}figcaption{{font-size:14px;color:#acbbcc;padding:8px 0}}code{{background:#243247;padding:2px 5px}}.note{{border-left:3px solid #e4b878;padding-left:16px}}@media(max-width:800px){{.cards,.images{{grid-template-columns:1fr}}table{{display:block;overflow:auto}}}}</style>
<main><div class="tag">RENDERING EXPERIMENT · 27 OCTOBER 2026</div><h1>Same blocks. Two renderers.<br>A measured flat-world improvement.</h1>
<p>The requested controlled landscape is implemented in both Space and a new Fabric mod. The data matches exactly: 1024 × 1024 m, seed 42, 48,810,696 solid 1 m blocks, and 256 randomly assigned constant RGB colors. Full-volume CRC32: <code>bef315c8</code>. Every Minecraft chunk was validated against the shared contract before sampling.</p>
<div class="cards"><div class="card"><div class="big">−{out['staticGpuReductionPercent']:.1f}% GPU time</div>Fixed view, Space flat culling. Identical screenshot.</div><div class="card"><div class="big">−{out['movingGpuReductionPercent']:.1f}% GPU time</div>Moving view, repeated balanced comparisons.</div></div>
<h2>Controlled setup</h2><p>Apple M1 Pro; Minecraft 1.21.1, Java 21, Sodium 0.6.13, Distant Horizons 3.3.3 and the new <code>spacebench</code> mod. Fabric API is DH's bundled dependency. No content packs, Iris, shaders or unrelated mods are installed in the isolated instance. Existing installations and saves are untouched.</p>
<p>Both renderers use 1280 × 720 actual pixels, no MSAA, vertical FOV 70°, eye (512.5, 96, 512.5), looking north and 18° down, near distance 8 chunks and far radius 64 chunks. Space uses flat projection, medium lighting and no shadows. The map has no fluids, trees, entities, structures or microvoxels. Minecraft's daytime is fixed; the viewmodel is hidden in both captures.</p>
<p>All terrain preparation is excluded. Minecraft used an additional 60-second warmup after validating the already prepared save. Each renderer's comparison uses eight balanced blocks (four samples per variant), with 5 seconds warming and 10 seconds measuring per block. Minecraft was closed before Space sampling. Moving Space views follow ±16 m lateral displacement, up to 16 m forward displacement and ±0.6 radians yaw.</p>
<h2>Actual whole-application measurements</h2>{table(base_rows)}
<p class="note">These are matched input/view measurements, not an isolated algorithm ranking. The browser is limited to about 120 displayed FPS, while Minecraft's 260 setting means uncapped rendering. Minecraft has different fog, LOD reconstruction, lighting, near-chunk coverage and a Java integrated server. Space's GPU spans are measured WebGPU pass envelopes; native Minecraft GPU time was not instrumented. Do not compare a Minecraft frame interval directly with a Space GPU span.</p>
<h2>What changed in Space</h2><p>The existing visibility code preserved every nearby face block inside a 256 m guard because ring projection bends and locally flattens geometry around the camera. Flat projection has no such deformation. It now applies the existing conservative sphere/frustum and normal-cone tests inside that range too, retaining the same motion padding, cached-query guards and terrain coverage rules. Torus behavior is unchanged.</p>{table(opt_rows)}
<p>The fixed-view candidate reduces submitted far faces by {out['staticFaceReductionPercent']:.1f}% ({static['wide']['faces']:,.0f} → {static['flat']['faces']:,.0f}). Camera movement was retested separately. Pixel checks cover the initial view, translated camera, 90° and 180° turns, return view, and restoration of the reference path. All candidate/reference channels are exactly equal in those captures. Unit tests cover cached and uncached paths, stationary switch restoration, and retaining the torus exemption.</p>
<p>The first moving reference block had 115 frames with pending streaming work; later blocks had 9–10. Excluding that first block as a sensitivity check still gives about 17% lower GPU time. Initial unfrozen moving screenshots differed because geometry publication advanced between images; the accepted pixel checks freeze publication only, while ordinary timed frames remain live.</p><h2>Compare the rendered result</h2><div class="images">{figure('minecraft/matched-0-dh.png','Minecraft + Sodium + Distant Horizons')}{figure('space-static/flat.png','Space flat world with conservative culling')}{figure('minecraft/matched-1-near.png','Minecraft near terrain only')}{figure('space-baseline/near.png','Space near terrain only')}</div>
<p>The same ridges and per-block colors align. Space's distant silhouette is visibly coarser in this configuration; Minecraft's fog and shading also differ. Equal source data does not imply equal distant image quality. This single bounded heightfield is a reproducible first control, not a substitute for the three original toroidal terrains with overhangs and islands.</p>
<h2>Research that informed the experiment</h2><ul>
<li><a href="https://github.com/MCRcortex/voxy/blob/5bf33350a1cc7bb7e2b5d947b236c56d878b8a7d/src/main/java/me/cortex/voxy/client/core/rendering/hierachical/HierarchicalOcclusionTraverser.java">Voxy: hierarchical occlusion traversal</a> combines visibility hierarchy, screen-size refinement and GPU-generated work. Its upstream renderer requires compute and indirect-count capabilities absent from this Mac's OpenGL 4.1 driver. No upstream Voxy FPS is claimed. A <a href="https://github.com/srjefers/voxy-mseries-support/blob/dev/docs/METAL-MIGRATION.md">community Metal port</a> uses a different cross-API bridge and is not the tested upstream renderer.</li>
<li><a href="https://gitlab.com/distant-horizons-team/distant-horizons-core/-/blob/65e86b5c02d3c9bf3be807829227023d9a61ed9a61ed9a/src/main/java/com/seibel/distanthorizons/core/render/QuadTree/LodQuadTree.java">Distant Horizons: LOD quadtree</a> selects sections and retains parent coverage until child replacements are ready. Section-level selection and frustum rejection differ from Space's smaller face-block lists. <a href="https://modrinth.com/mod/distanthorizons/version/9w34y8ai">Tested release</a>.</li>
<li><a href="https://arxiv.org/html/2505.02017v1">Aokana (2025)</a> combines shallow voxel DAGs, streaming, Hi-Z and a visibility buffer to reduce memory traffic and overdraw. Its reported gains concern its own scenes and pipeline; copying one culling pass does not transfer those gains to Space.</li>
<li><a href="https://arxiv.org/abs/2608.17390">Six Ways to Draw Vangers with WebGPU (August 2026)</a> tests six representations over one data path. It finds that horizon-level views expose coverage and silhouette failures hidden by top-down views. This supports using a shared dataset and eye-level captures before replacing our representation; its fastest measured mesh also carries editing/storage costs.</li></ul>
<h2>Rejected candidate and follow-up priority</h2><p>Grouping 16, 32 or 64 visibility blocks for an extra CPU frustum level was measured on all three existing torus terrains: 144 blocks, 38,774 frames and 6,458 GPU samples, including repeats and identical-code controls. It did not yield a consistent improvement beyond drift, so it remains disabled. <a href="../src/dev/results/visibility-clusters-2026-10-27/chromium-1793089339134/summary.json">Cluster raw summary</a>. The next larger experiment should compare true occlusion rejection against its depth-pyramid and synchronization cost, keeping the source terrain and silhouette quality fixed. Merely increasing grouping or moving a flat scan to the GPU is not the key mechanism of Voxy/Aokana.</p>
<h2>Reproduce and audit</h2><p><a href="/space/app/?world=matched-blocks&amp;dev_offline=1&amp;dev_lod=world">Open the new flat test world</a> · <a href="../../tools/minecraft-matched/README.md">Mod build and terrain contract</a> · <a href="../tools/matched-browser.html">Space benchmark launcher</a> · <a href="{imagebase}summary.json">Validated summary</a> · <a href="{imagebase}provenance.json">Provenance and exclusions</a> · <a href="{imagebase}minecraft/matched-minecraft.json.gz">Native raw frames and mod inventory</a> · <a href="{imagebase}space-baseline/result.json.gz">Space near/far raw</a> · <a href="{imagebase}space-static/result.json.gz">Static optimization raw</a> · <a href="{imagebase}space/result.json.gz">Moving optimization raw</a></p>
<p>Excluded attempts are documented: the first native launch failed the framebuffer-size guard before collecting valid samples. The first Space candidate switch did not invalidate the layer's stationary draw list; its candidate data is excluded and preserved in the baseline file. The corrected switch is required to reduce submitted faces before timing. Production defaults keep the existing representation and enable only the verified flat-projection culling change.</p>
</main></html>'''
# Keep the exact pinned core revision; construct explicitly to avoid transcription drift.
report=report.replace('65e86b5c02d3c9bf3be807829227023d9a61ed9a61ed9a','65e86b5c02d3c9bf3be807829227023d9a61ed9a')
(root/'docs/performance-matched-terrain-2026-10-27.html').write_text(report)
print(json.dumps(out,indent=2)[:6000])
