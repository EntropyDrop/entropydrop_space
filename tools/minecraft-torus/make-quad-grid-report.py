"""Audit and summarize the native Firefox quad-perimeter experiment."""
from pathlib import Path
import gzip
import html
import json
import math
import statistics as st
from PIL import Image

base = Path(__file__).resolve().parents[2]
root = base / 'client/src/dev/results/quad-grid-2026-11-08'
folder = root / 'accepted-moving/firefox/aether-archipelago/paired'
data = json.loads(gzip.decompress((folder / 'result.json.gz').read_bytes()))
static = json.loads(gzip.decompress((root / 'partial-export-limit/firefox/aether-archipelago/paired/result.json.gz').read_bytes()))
assert json.loads((folder / 'status.json').read_text())['state'] == 'complete'
assert data['experiment'] == 'quad-grid' and data['terrain'] == 'aether-archipelago'
assert 'Firefox/' in data['userAgent'] and not data['errors'] and 'failure' not in data
assert not data['options']['preview']
assert (data['width'], data['height'], data['samples']) == (2560, 1440, 0)
variants = ['original', 'unlit', 'grid']
expected = [variants[i] for p in [[0,1,2],[2,1,0],[1,2,0],[0,2,1],[2,0,1],[1,0,2]] for i in p]
assert [r['variant'] for r in data['rows']] == expected
assert [r['motion'] for r in data['rows']] == ['move'] * 18
assert not static['errors'] and len(static['rows']) == 31
assert static['userAgent'] == data['userAgent'] and static['settings'] == data['settings']
assert (static['width'], static['height'], static['samples'], static['fixedCellSize']) == (2560, 1440, 0, None)
static_rows = static['rows'][:18]
assert [r['variant'] for r in static_rows] == expected
assert [r['motion'] for r in static_rows] == ['dense'] * 18
assert len({v['trial']['terrainTriangles'] for r in static_rows for v in r['raw']}) == 1
assert all(v['focused'] for r in data['rows'] for v in r['raw'])
all_rows = static_rows + data['rows']
for view, check in data['checks'].items():
    assert check['restoration']['exact'] == check['depthRestoration']['exact'] == 0
    assert check['occlusionEffect']['visible'] >= 100
    assert len({v['terrainTriangles'] for v in check['variants'].values()}) == 1
    for variant in variants + ['no-depth']:
        with Image.open(folder / f'grid-{view}-{variant}.png') as image:
            assert image.size == (2560, 1440)
            image.verify()
for row in all_rows:
    assert row['raw'] and row['gpu'] and len(row['sourceMips']) == 8
    assert min(v['phaseSeconds'] for v in row['raw']) >= 6
    assert max(v['phaseSeconds'] for v in row['raw']) >= 12
    for v in row['raw']:
        assert v['frame'] > 0 and all(math.isfinite(v[k]) for k in ['frame', 'cpu'])
        assert v['streaming']['cacheEnabled'] and v['streaming']['workers'] == 2
        assert not v['streaming']['parallelPrefetch'] and v['nearBatch']['enabled']
        assert v['trial']['nearDraws'] > 0 and v['trial']['farDraws'] > 0
        assert (v['trial']['lineSegments'] > 0) == (row['variant'] == 'grid')


def metrics(rows):
    values = [v for r in rows for v in r['raw']]
    frames = sorted(v['frame'] for v in values)
    return dict(fps=1000/st.mean(frames), cpu=st.mean(v['cpu'] for v in values),
                draw=st.mean(v['probes']['draw'] for v in values),
                hook=st.mean(v['trial']['hookMs'] for v in values),
                gpu=st.mean(v['spanMs'] for r in rows for v in r['gpu']),
                p95=frames[int(len(frames)*.95)], frames=len(values),
                blockFps=[1000/st.mean(v['frame'] for v in r['raw']) for r in rows],
                blockGpu=[st.mean(v['spanMs'] for v in r['gpu']) for r in rows],
                calls=st.mean(v['calls'] for v in values),
                triangles=st.mean(v['trial']['terrainTriangles'] for v in values),
                lines=st.mean(v['trial']['lineSegments'] for v in values),
                readyPercent=100*st.mean(v['progress']['readyChunks']/v['progress']['totalChunks'] for v in values))

summary = {motion: {variant: metrics([r for r in all_rows if r['motion'] == motion and r['variant'] == variant])
                    for variant in variants} for motion in ['dense', 'move']}
(root / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
labels = {'original': 'Current PBR', 'unlit': 'Unlit solid', 'grid': 'Depth-hidden quad grid'}
rows = []
for motion, modes in summary.items():
    for variant, s in modes.items():
        rows.append(f'<tr><td>{labels[variant]}<small>{motion}</small></td><td>{s["fps"]:.1f}<small>{min(s["blockFps"]):.1f}–{max(s["blockFps"]):.1f}</small></td><td>{s["cpu"]:.2f}</td><td>{s["draw"]:.2f}</td><td>{s["gpu"]:.2f}</td><td>{s["p95"]:.1f}</td><td>{s["readyPercent"]:.2f}%</td></tr>')
notes = []
for motion, modes in summary.items():
    for variant in ['unlit', 'grid']:
        a, b = modes['original'], modes[variant]
        overlap = max(min(a['blockFps']), min(b['blockFps'])) <= min(max(a['blockFps']), max(b['blockFps']))
        notes.append(f'<li>{motion}, {labels[variant]}: pooled FPS {(b["fps"]/a["fps"]-1)*100:+.1f}%; GPU span {(b["gpu"]/a["gpu"]-1)*100:+.1f}%. '
                     + ('FPS block ranges overlap; this is not evidence of a stable frame-rate gain.' if overlap else 'FPS block ranges do not overlap in this session; this is still one machine and one session.') + '</li>')
assets = '../src/dev/results/quad-grid-2026-11-08/'
images = assets + 'accepted-moving/firefox/aether-archipelago/paired/'
checks = ''.join(f'<li>{view}: original restoration {c["restoration"]["exact"]:,} changed pixels; depth restoration {c["depthRestoration"]["exact"]:,}; disabling depth changes {c["occlusionEffect"]["visible"]:,} pixels (RGB/A difference &gt; 2).</li>' for view,c in data['checks'].items())
geometry = ''.join(f'<tr><td>{view}</td><td>{c["variants"]["original"]["terrainTriangles"]:,}</td><td>{c["variants"]["grid"]["lineSegments"]:,}</td><td>{c["variants"]["original"]["terrainDraws"]}</td></tr>' for view,c in data['checks'].items())
moving = summary['move']
stationary = summary['dense']
page = f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Firefox terrain: solid versus quad grid</title>
<style>body{{margin:0;background:#101923;color:#e8eff6;font:16px/1.65 system-ui}}main{{max-width:1220px;margin:auto;padding:40px 26px}}h1{{font-size:42px;line-height:1.15}}h2{{margin-top:36px}}p,li{{color:#bdcddb}}a{{color:#8bcaff}}.note{{padding:18px;background:#1c3345;border-left:3px solid #76d8c1}}table{{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}}th,td{{padding:10px;border-bottom:1px solid #34495c;text-align:right}}th:first-child,td:first-child{{text-align:left}}small{{display:block;font-size:12px;color:#9db8cd}}.scroll{{overflow:auto}}img{{display:block;width:100%;height:auto}}button,select{{font:inherit;padding:6px 12px;margin:5px;background:#243c52;color:white;border:1px solid #5a778e;border-radius:5px}}button.active{{background:#416d65}}.tag{{color:#76d8c1;font-size:12px;letter-spacing:2px}}code{{overflow-wrap:anywhere}}</style>
<main><div class="tag">NATIVE FIREFOX · AETHER ARCHIPELAGO · 8 NOVEMBER 2026</div><h1>Solid terrain or<br>four edges per quad?</h1>
<p class="note"><strong>Keep the current renderer.</strong> Moving FPS is {moving['original']['fps']:.1f} with current PBR, {moving['unlit']['fps']:.1f} with unlit solid, and {moving['grid']['fps']:.1f} with depth-hidden quad edges. The grid changes FPS by {(moving['grid']['fps']/moving['original']['fps']-1)*100:+.1f}% in this local comparison. Unlit reduces GPU time, but its FPS ranges overlap the reference. These are development-only variants; production settings are unchanged.</p>
<ul>{''.join(notes)}</ul>
<h2>Paired performance</h2><div class="scroll"><table><thead><tr><th>Rendering / workload</th><th>FPS<small>six-block range</small></th><th>CPU ms</th><th>Draw CPU ms</th><th>GPU span ms</th><th>P95 frame ms</th><th>Near ready</th></tr></thead><tbody>{''.join(rows)}</tbody></table></div>
<p>Native {html.escape(data['userAgent'])}. Actual framebuffer 2560 × 1440, no MSAA, 100° vertical FOV, medium lighting, no shadows or fog. Near radius 8 × 8 chunks; far radius 576 chunks, subdivision threshold 64 px², texture proxies disabled. LOD selection: {'fixed 1 m stress reference' if data['fixedCellSize'] else 'production adaptive selection'}. Eight generated source zones; each role uses the same source data, culling, geometry construction, ownership masks and streaming options. Stationary submitted terrain is exactly 856,460 triangles in all roles. During movement, sampled geometry and near readiness vary with streaming; equal camera paths do not imply identical submissions on every frame.</p>
<p>At eye height 180 m and downward pitch 55°, the moving path repeats every six seconds with X/Z amplitudes 64/32 m. Preflight screenshots and 18 seconds of path warmup per variant precede measurements. Each stationary and moving workload uses ABC CBA BCA ACB CAB BAC: six repetitions per variant, each with six seconds settling and six seconds sampled. Exports and screenshots are outside timing; a hidden tab invalidates the run. No builds or tests run during accepted timing.</p>
<p>FPS is 1000 divided by pooled mean RAF interval. GPU values are first-to-last-pass timestamp spans sampled roughly once per six frames, not GPU busy counters. CPU/GPU overlap, and draw CPU is included in total CPU. Displays may cap presentation. Block ranges describe variation, not confidence intervals or cross-device guarantees.</p>
<h2>Accepted sessions and exclusions</h2><p>The stationary table uses all 18 completed stationary blocks from the first session, before a later export hit the 64 MiB request limit. Its incomplete moving workload is not used in the main table. JSON transport was then compressed outside timing. A subsequent session developed repeated WebAssembly memory reservation failures and caught terrain-connection rebuild errors; that entire session is excluded. Developer Tools was found open after that session. Its retained state was cleared and the panel was explicitly closed and verified before the final independent 18-block moving rerun. The precise cause of the memory reservation failure is not established.</p>
<p>The final moving rerun has zero captured console errors, zero WebGPU errors, and window focus throughout every sampled frame. It retains the same rendering implementation and workload settings. Each workload therefore has one accepted, internally interleaved comparison, from two separate sessions. The earlier harness did not capture caught <code>console.error</code> messages; it now does. A completed export alone is insufficient to validate a performance run.</p>
<h2>Same-pose image comparison</h2><p>Switch modes without moving the image. Download the full-resolution PNG to inspect small distant edges. The no-depth image is a diagnostic, excluded from performance measurements.</p>
<div><select id="view"><option value="dense">Across the torus</option><option value="near">Lower / nearby terrain</option></select><span id="modes"></span></div><a id="full"><img id="compare" width="2560" height="1440" alt="Same-pose terrain rendering comparison"></a><p id="caption"></p>
<p>Unlit surfaces preserve colors and silhouettes but flatten directional shading, making faces harder to distinguish. The grid replaces filled surfaces with thin colored edges against the sky background while still hiding rear terrain edges. Distant dense grids lose much of the filled surface's shape and color readability. The close image is at eye height 132 m, above the highest solid cell in the resident camera column, with 35° downward pitch; performance samples use the 180 m route.</p>
<h2>Implementation and image checks</h2><p>Unlit solid shares production positions, base colors, emission output and ownership masks, but removes scene-light and BRDF evaluation. Grid rendering first draws the same filled triangles with color writes disabled and a small polygon depth bias, then draws indexed native one-pixel line segments after all terrain depth bundles. Each original quad becomes four edges; triangle diagonals are absent. Adjacent faces can share coincident edges; this trial does not globally deduplicate them. Greedy merged faces retain their perimeter, not an invented one-metre subdivision. LOD faces likewise retain their own quad perimeters.</p>
<p>The depth fill is included in the grid cost, along with extra line indices, vertex deformation and line draws. It keeps terrain occlusion; disabling it is only a visual diagnostic. Grid lines use base terrain colors. Line width is one framebuffer pixel (half a CSS pixel at DPR 2); thicker anti-aliased lines would be a separate experiment. Terrain material substitution and cached edge maintenance run in all three roles, so absolute FPS includes common diagnostic overhead, recorded as <code>trial.hookMs</code>. No raycasting, visibility or terrain-accuracy reduction is used.</p>
<p>In the accepted stationary samples, the grid retains {stationary['grid']['triangles']:,.0f} terrain triangles for depth and adds {stationary['grid']['lines']:,.0f} line segments. Whole-scene draws increase from {stationary['original']['calls']:.0f} to {stationary['grid']['calls']:.0f}. This is a measured cost of this implementation, not a claim that every possible grid shader must be slower.</p>
<ul>{checks}</ul><p>Zero GPU errors. Pixel restoration checks establish reversibility at these two poses, not all possible scenes. Perimeter index tests verify intact packed face/corner IDs and no diagonal edges. The fixture rejects visible transparent terrain rather than silently treating it as opaque.</p>
<div class="scroll"><table><tr><th>Frozen view</th><th>Terrain triangles, all modes</th><th>Additional grid segments</th><th>Original terrain draws</th></tr>{geometry}</table></div>
<h2>Evidence and reproduction</h2><p><a href="{assets}summary.json">Summary</a> · <a href="{assets}partial-export-limit/firefox/aether-archipelago/paired/result.json.gz">First session: accepted stationary blocks 0–17</a> · <a href="{assets}accepted-moving/firefox/aether-archipelago/paired/result.json.gz">Accepted moving frames and GPU timelines</a> · <a href="{assets}excluded-wasm-memory/exclusion.json">Excluded memory-failure session</a> · <a href="{assets}static-source-hashes.json">Stationary rendering source hashes</a> · <a href="{assets}source-hashes.json">Final source hashes</a> · <a href="{assets}validation.json">Validation</a> · <a href="../../tools/minecraft-torus/README.md">Reproduction</a></p></main>
<script>const names={{original:'Current PBR',unlit:'Unlit solid',grid:'Depth-hidden quad grid','no-depth':'Grid without depth (diagnostic)'}};let mode='original';const buttons=document.getElementById('modes');for(const [key,label]of Object.entries(names)){{const b=document.createElement('button');b.textContent=label;b.dataset.mode=key;b.onclick=()=>{{mode=key;update()}};buttons.append(b)}}function update(){{const view=document.getElementById('view').value,url='{images}grid-'+view+'-'+mode+'.png';document.getElementById('compare').src=url;document.getElementById('full').href=url;document.getElementById('caption').textContent=names[mode]+' · '+view;for(const b of buttons.children)b.classList.toggle('active',b.dataset.mode===mode)}}document.getElementById('view').onchange=update;update();</script></html>'''
(base / 'client/docs/performance-quad-grid-2026-11-08.html').write_text(page)
print(json.dumps(summary, indent=2))
