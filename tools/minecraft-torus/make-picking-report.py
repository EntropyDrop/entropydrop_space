"""Audit the Firefox A/B experiment for exact terrain picking discovery."""
from pathlib import Path
import gzip
import hashlib
import json
import math
import statistics
from PIL import Image

base = Path(__file__).resolve().parents[2]
root = base / 'client/src/dev/results/archipelago-picking-2026-10-29'
folder = root / 'firefox/aether-archipelago/paired'
data = json.loads(gzip.decompress((folder / 'result.json.gz').read_bytes()))
assert json.loads((folder / 'status.json').read_text())['state'] == 'complete'
assert data['experiment'] == 'picking' and data['terrain'] == 'aether-archipelago'
assert 'Firefox/' in data['userAgent'] and not data['errors']
assert (data['width'], data['height'], data['samples'], data['fixedCellSize']) == (2560, 1440, 0, 1)
assert [r['variant'] for r in data['rows']] == ['reference', 'discovery', 'discovery', 'reference'] * 2
assert [r['mode'] for r in data['rows']] == ['dense'] * 4 + ['move'] * 4
assert data['pickingEquality'] and data['nearBatchPixelCheck']['changedPixels'] == data['mapUploadPixelCheck']['changedPixels'] == 0
for row in data['rows']:
    assert abs(row['effectiveFov'] - 100) < .001 and len(row['sourceMips']) == 8
    assert all(1 in s['sizes'] for s in row['sourceMips'])
    assert row['raw'] and row['gpu']
    assert min(v['phaseSeconds'] for v in row['raw']) >= 6 and max(v['phaseSeconds'] for v in row['raw']) >= 18
    for value in row['raw']:
        assert value['frame'] > 0 and all(math.isfinite(value[k]) for k in ['frame', 'cpu', 'renderCpu'])
        assert value['streaming']['cacheEnabled'] and value['streaming']['workers'] == 2
        assert not value['streaming']['parallelPrefetch'] and value['nearBatch']['enabled']
    with Image.open(folder / f"stress-{row['block']}-{row['mode']}.png") as image:
        assert image.size == (2560, 1440)
        image.verify()
with Image.open(folder / 'near-plain.png') as a, Image.open(folder / 'near-batch.png') as b:
    assert a.convert('RGBA').tobytes() == b.convert('RGBA').tobytes()


def stats(rows):
    raw = [v for row in rows for v in row['raw']]
    frames = sorted(v['frame'] for v in raw)
    mean = statistics.mean
    return {'fps': 1000 / mean(frames), 'cpu': mean(v['cpu'] for v in raw),
            'picking': mean(v['probes']['picking'] for v in raw),
            'gpu': mean(v['spanMs'] for row in rows for v in row['gpu']),
            'p95': frames[int(len(frames) * .95)], 'frames': len(raw),
            'blockFps': [1000 / mean(v['frame'] for v in row['raw']) for row in rows],
            'blockCpu': [mean(v['cpu'] for v in row['raw']) for row in rows],
            'blockPicking': [mean(v['probes']['picking'] for v in row['raw']) for row in rows],
            'readyPercent': 100 * mean(v['nearProgress']['readyChunks'] / v['nearProgress']['totalChunks'] for v in raw)}


summary = {variant: {mode: stats([r for r in data['rows'] if r['variant'] == variant and r['mode'] == mode])
                     for mode in ['dense', 'move']} for variant in ['reference', 'discovery']}
(root / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
sources = ['engine/src/voxel/World.ts', 'engine/test/aim-raycast-discovery.test.ts',
           'client/src/dev/TorusStressChild.ts', 'client/src/dev/TorusStressHost.ts']
(root / 'source-hashes.json').write_text(json.dumps({s: hashlib.sha256((base / s).read_bytes()).hexdigest()
                                                  for s in sources}, indent=2) + '\n')
rows = []
for variant, modes in summary.items():
    for mode, s in modes.items():
        rows.append(f'<tr><td>{variant}<small>{mode}</small></td><td>{s["fps"]:.1f}<small>{" / ".join(f"{v:.1f}" for v in s["blockFps"])}</small></td><td>{s["cpu"]:.2f}</td><td>{s["picking"]:.3f}</td><td>{s["gpu"]:.2f}</td><td>{s["p95"]:.1f}</td><td>{s["readyPercent"]:.3f}%</td></tr>')
before, after = summary['reference']['move'], summary['discovery']['move']
assets = '../src/dev/results/archipelago-picking-2026-10-29/'
page = f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Exact terrain picking: skip overlapping discovery</title><style>body{{margin:0;background:#101923;color:#e8eff6;font:16px/1.65 system-ui}}main{{max-width:1160px;margin:auto;padding:40px 28px}}h1{{font-size:42px;line-height:1.2}}h2{{margin-top:36px}}p,li{{color:#bacbda}}a{{color:#8bcaff}}.note{{background:#1d3345;border-left:3px solid #79dcc5;padding:18px}}.scroll{{overflow:auto}}table{{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}}th,td{{padding:12px;border-bottom:1px solid #34495c;text-align:right}}th:first-child,td:first-child{{text-align:left}}small{{display:block;color:#9db8cd;font-size:12px}}img{{width:100%;height:auto}}.tag{{font-size:12px;letter-spacing:2px;color:#79dcc5}}</style><main><div class="tag">FIREFOX · AETHER ARCHIPELAGO · 29 OCTOBER 2026</div><h1>Exact picking,<br>less repeated discovery.</h1>
<p class="note">Moving picking CPU time changes from {before['picking']:.3f} to {after['picking']:.3f} ms ({(after['picking']/before['picking']-1)*100:+.1f}%). Whole-frame CPU changes from {before['cpu']:.2f} to {after['cpu']:.2f} ms; FPS from {before['fps']:.1f} to {after['fps']:.1f} ({(after['fps']/before['fps']-1)*100:+.1f}%). FPS block ranges overlap, so this session supports lower picking CPU cost, not a stable FPS gain. These are paired measurements on this machine, not a cross-device guarantee.</p>
<h2>What changed</h2><p>The inverse-bent ray still takes every original sample and intersects the same exposed triangles. Adjacent samples cover overlapping 3 × 3 × 3 neighborhoods. Skip a neighborhood when its center has not changed, skip cells covered by the immediately previous neighborhood, and remember empty cells as already classified. Preserve first-visit ordering so coplanar tie handling is unchanged. Periodic seam jumps conservatively reduce reuse rather than guessing continuity.</p>
<p>The completed previous optimization is saved in commit <code>b8e07bc</code>. Both variants here retain its cache, demand-priority two-worker schedule, command reuse, seam shader and incremental far uploads. Only <code>aimRaycastDiscoveryOptimized</code> changes. No ray throttling, reduced reach, coarse replacement, or image-quality reduction is used.</p>
<h2>Same-page reference / optimized / optimized / reference</h2><div class="scroll"><table><thead><tr><th>Variant / case</th><th>FPS<small>individual blocks</small></th><th>CPU ms</th><th>Picking ms</th><th>GPU ms</th><th>P95 ms</th><th>Ready chunks</th></tr></thead><tbody>{''.join(rows)}</tbody></table></div>
<p>Native Firefox, actual 2560 × 1440, no MSAA, 100° vertical FOV and 55° downward pitch, eight fixed 1 m source zones, 8-chunk near radius and 576-chunk far radius. Each view runs ABBA, with 6 seconds settling and 12 seconds sampled per block after 60 seconds initial warmup. Moving x/z amplitudes are 64/32 m on a six-second route. CPU and GPU overlap; picking time is included in CPU. The stationary view is close to a 120 Hz presentation ceiling. One session is not a confidence interval.</p>
<h2>Correctness</h2><p>400 hit-and-read-order comparisons cover JS/WASM kernels, flat/torus projection, camera-local correction, standard/micro voxels, edges, periodic seams and height limits. Another 64 moving/diagonal empty-space rays retain the exact read order with less repeated classification. Existing cache invalidation, edit publication and tool-interaction regressions also pass; see the validation record.</p>
<p>The browser's settled reference and optimized picking queries agree. After streaming and ownership fades settle, map-upload and near-command reference captures differ at zero of 3,686,400 RGBA pixels. These checks do not establish equivalence at every possible camera; the algorithm's unchanged discovery set and regression comparisons provide the broader correctness argument.</p>
<a href="{assets}firefox/aether-archipelago/paired/stress-6-move.png"><img loading="lazy" width="2560" height="1440" src="{assets}firefox/aether-archipelago/paired/stress-6-move.png" alt="Aether Archipelago with exact optimized picking"></a>
<h2>Evidence</h2><p><a href="{assets}summary.json">Summary</a> · <a href="{assets}validation.json">Validation</a> · <a href="{assets}source-hashes.json">Source hashes</a> · <a href="{assets}firefox/aether-archipelago/paired/result.json.gz">Raw frames</a> · <a href="../../tools/minecraft-torus/README.md">Reproduction</a></p></main></html>'''
(base / 'client/docs/performance-archipelago-picking-2026-10-29.html').write_text(page)
print(json.dumps(summary, indent=2))
