"""Validate native Firefox near-streaming captures and render their local report."""
from pathlib import Path
import gzip
import hashlib
import html
import json
import math
import statistics
from PIL import Image

base = Path(__file__).resolve().parents[2]
root = base / 'client/src/dev/results/archipelago-near-streaming-2026-10-28'
folder = root / 'firefox/aether-archipelago'
labels = {
    'baseline': 'Reference: no cache, one worker, ordinary draws',
    'cache': 'Cache + preload, one worker',
    'workers': 'Cache + unrestricted two workers',
    'batch': 'Cache + unrestricted two workers + command reuse',
    'optimized': 'Cache + demand-priority two workers + command reuse',
    'repeat': 'Reference repeated',
}


def stats(rows):
    raw = [v for row in rows for v in row['raw']]
    frames = sorted(v['frame'] for v in raw)
    mean = statistics.mean
    return {
        'fps': 1000 / mean(frames), 'frames': len(frames),
        'blockFps': [1000 / mean(v['frame'] for v in row['raw']) for row in rows],
        'p95': frames[int(len(frames) * .95)], 'p99': frames[int(len(frames) * .99)],
        'onePercentLow': 1000 / mean(frames[-math.ceil(len(frames) * .01):]),
        'cpu': mean(v['cpu'] for v in raw),
        'draw': mean(v['probes']['draw'] for v in raw),
        'gpu': mean(v['spanMs'] for row in rows for v in row['gpu']),
        'readyPercent': 100 * mean(v['nearProgress']['readyChunks'] / v['nearProgress']['totalChunks'] for v in raw),
        'nearPendingPercent': 100 * mean(not v['nearReady'] for v in raw),
        'peakCacheMiB': max(v['streaming']['cacheBytes'] for v in raw) / 2**20,
        'calls': mean(v['calls'] for v in raw), 'triangles': mean(v['triangles'] for v in raw),
        'probes': {k: mean(v['probes'].get(k, 0) for v in raw) for k in raw[0]['probes']},
    }


def read_run(run, count):
    data = json.loads(gzip.decompress((folder / run / 'result.json.gz').read_bytes()))
    assert 'Firefox/' in data['userAgent'] and data['terrain'] == 'aether-archipelago'
    assert not data['errors']
    assert (data['width'], data['height'], data['samples'], data['fixedCellSize']) == (2560, 1440, 0, 1)
    assert len(data['rows']) == count
    for row in data['rows']:
        assert abs(row['effectiveFov'] - 100) < .001
        assert len(row['sourceMips']) == 8 and all(1 in s['sizes'] for s in row['sourceMips'])
        assert row['raw'] and row['gpu']
        assert min(v['phaseSeconds'] for v in row['raw']) >= 6
        assert max(v['phaseSeconds'] for v in row['raw']) >= 18
        for value in row['raw']:
            assert value['frame'] > 0
            assert all(math.isfinite(value[k]) for k in ['frame', 'cpu', 'terrainCpu', 'renderCpu'])
            assert value['streaming']['inFlight'] + value['streaming']['completed'] <= 4
            assert value['streaming']['cachedChunks'] <= 96
            assert value['streaming']['cacheBytes'] <= value['streaming']['cacheBudgetBytes']
        with Image.open(folder / run / f"stress-{row['block']}-{row['mode']}.png") as image:
            assert image.size == (2560, 1440)
            image.verify()
    assert data['mapUploadPixelCheck']['changedPixels'] == 0
    if run in ['batch', 'optimized', 'repeat', 'paired']:
        assert data['nearBatchPixelCheck']['changedPixels'] == 0
        # Independently verify the saved images, in addition to the browser check.
        with Image.open(folder / run / 'near-plain.png') as plain, Image.open(folder / run / 'near-batch.png') as batched:
            assert plain.convert('RGBA').tobytes() == batched.convert('RGBA').tobytes()
    return data


raw_runs = {run: read_run(run, 4) for run in labels}
runs = {run: {mode: stats([r for r in data['rows'] if r['mode'] == mode]) for mode in ['dense', 'move']}
        for run, data in raw_runs.items()}
paired_status = json.loads((folder / 'paired/status.json').read_text())
paired = {}
if paired_status.get('state') == 'complete':
    data = read_run('paired', 8)
    assert [r['variant'] for r in data['rows']] == ['baseline', 'scheduled', 'scheduled', 'baseline'] * 2
    assert [r['mode'] for r in data['rows']] == ['dense'] * 4 + ['move'] * 4
    raw_runs['paired'] = data
    paired = {variant: {mode: stats([r for r in data['rows'] if r['variant'] == variant and r['mode'] == mode])
                       for mode in ['dense', 'move']} for variant in ['baseline', 'scheduled']}

summary = {'runs': runs, 'paired': paired, 'pairedStatus': paired_status,
           'pixelChecks': {k: v.get('nearBatchPixelCheck') for k, v in raw_runs.items()}}
(root / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
source_paths = ['engine/src/voxel/World.ts', 'engine/src/render/NearTerrainBatches.ts',
                'engine/src/torus/TorusWorld.ts', 'client/src/dev/TorusStressChild.ts',
                'client/src/dev/TorusStressHost.ts', 'engine/test/near-terrain-optimization.test.ts']
(root / 'final-source-hashes.json').write_text(json.dumps({p: hashlib.sha256((base / p).read_bytes()).hexdigest()
                                                        for p in source_paths}, indent=2) + '\n')

assets = '../src/dev/results/archipelago-near-streaming-2026-10-28/'


def table(entries):
    rows = []
    for label, modes in entries:
        for mode, s in modes.items():
            rows.append(f'<tr><td>{html.escape(label)}<small>{mode}</small></td>'
                        f'<td>{s["fps"]:.1f}<small>{" / ".join(f"{v:.1f}" for v in s["blockFps"])}</small></td>'
                        f'<td>{s["p95"]:.1f}</td><td>{s["cpu"]:.2f}</td><td>{s["draw"]:.2f}</td>'
                        f'<td>{s["gpu"]:.2f}</td><td>{s["readyPercent"]:.3f}%</td><td>{s["peakCacheMiB"]:.1f}</td></tr>')
    return '<div class="scroll"><table><thead><tr><th>Version / view</th><th>FPS<small>individual blocks</small></th><th>P95 ms</th><th>CPU ms</th><th>Draw CPU ms</th><th>GPU ms</th><th>Ready chunks</th><th>Cache MiB</th></tr></thead><tbody>' + ''.join(rows) + '</tbody></table></div>'


paired_html = '<p>The same-page ABBA follow-up has no accepted complete capture. No FPS claim is made from an interrupted attempt.</p>'
headline = 'Cache and preload improve moving near-chunk readiness from approximately 97.5% to over 99.99% in the staged captures. Separate reference runs span 92.6–101.3 FPS, so those runs do not establish a stable FPS improvement.'
if paired:
    paired_html = table([('Reference', paired['baseline']), ('Production candidate', paired['scheduled'])])
    ref, opt = paired['baseline']['move'], paired['scheduled']['move']
    paired_html += f'<p>Within this ABBA run, moving FPS changes by {(opt["fps"] / ref["fps"] - 1) * 100:+.1f}%, CPU by {(opt["cpu"] / ref["cpu"] - 1) * 100:+.1f}%. This is one short paired session, not a cross-device result or confidence interval.</p>'
    headline = f'In the accepted same-page ABBA test, moving FPS rises from {ref["fps"]:.1f} to {opt["fps"]:.1f} ({(opt["fps"] / ref["fps"] - 1) * 100:+.1f}%). CPU frame time falls from {ref["cpu"]:.2f} to {opt["cpu"]:.2f} ms. Mean near-chunk readiness rises from {ref["readyPercent"]:.2f}% to {opt["readyPercent"]:.3f}%. Peak additional cached terrain is estimated at {opt["peakCacheMiB"]:.1f} MiB. This is a measured gain on this Firefox fixture, not a general hardware guarantee.'

shots = ''.join(f'<figure><a href="{assets}firefox/aether-archipelago/{run}/{name}.png"><img width="2560" height="1440" loading="lazy" src="{assets}firefox/aether-archipelago/{run}/{name}.png" alt="{label}"></a><figcaption>{label}</figcaption></figure>'
                for run, name, label in [('optimized', 'near-plain', 'Same frozen pose: ordinary near submission'),
                                         ('optimized', 'near-batch', 'Same frozen pose: near command reuse; zero RGBA pixel differences')])
links = ''.join(f'<li>{html.escape(labels.get(run, "Same-page ABBA"))}: <a href="{assets}firefox/aether-archipelago/{run}/result.json.gz">raw frame data</a></li>' for run in raw_runs)
page = f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Near terrain: caching, two workers and command reuse</title>
<style>body{{margin:0;background:#101923;color:#e8eff6;font:16px/1.65 system-ui}}main{{max-width:1280px;margin:auto;padding:40px 28px}}h1{{font-size:42px;line-height:1.18;max-width:900px}}h2{{margin-top:38px}}p,li,figcaption{{color:#bacbda}}a{{color:#8bcaff}}.note{{background:#1d3345;border-left:3px solid #79dcc5;padding:18px}}.scroll{{overflow:auto}}table{{width:100%;border-collapse:collapse;font:14px/1.5 system-ui;font-variant-numeric:tabular-nums}}th,td{{padding:12px;border-bottom:1px solid #34495c;text-align:right}}th:first-child,td:first-child{{text-align:left;min-width:235px}}small{{display:block;color:#a4bdcf;font-size:12px}}figure{{margin:22px 0}}img{{width:100%;height:auto}}.tag{{font-size:12px;letter-spacing:2px;color:#79dcc5}}</style>
<main><div class="tag">NATIVE FIREFOX · AETHER ARCHIPELAGO · 28–29 OCTOBER 2026</div><h1>Keep nearby terrain ready.<br>Reuse work before adding concurrency.</h1>
<p><a href="#paired">Paired test</a> · <a href="#results">Staged results</a> · <a href="#correctness">Correctness</a> · <a href="#images">Images</a></p>
<p class="note">{headline} Final command reuse produces identical RGBA pixels in the tested frozen view.</p>
<h2>Production implementation</h2><ol><li>Retain clean, unedited standard terrain near the active window. Preload one extra chunk ring at lower priority. Cache up to 96 chunks within a 64 MiB estimate; evict beyond a two-ring margin. The active ownership mask stays unchanged until a chunk is activated. Procedural micro geometry is unloaded outside the active region.</li>
<li>Use up to two terrain workers for active demand and edits, with at most four in-flight plus completed jobs. Only the primary worker performs speculative preloading by default. Start the second worker after the first successful response to avoid overlapping cold module loads. Preserve healthy in-flight work when a worker fails.</li>
<li>Reuse one globally ordered opaque near-terrain render bundle. Keep transparent terrain in the normal globally sorted list. Invalidate on publication, visibility and material changes. This batches command submission; it does not merge vertex buffers, reduce triangle counts, or promise fewer GPU draw calls.</li></ol>
<p>Cache MiB estimates voxel arrays plus CPU and GPU mesh data. It is not measured process memory or VRAM usage; active chunks, worker runtimes, recycled arrays and driver overhead are additional. This cache uses a bounded distance margin, not LRU. Preloading can increase total generated work while reducing visible waiting.</p>
<h2 id="paired">Same-page ABBA follow-up</h2><p>For each view: reference → production candidate → production candidate → reference, with six seconds to settle each switch and twelve seconds of samples. This reduces page-reload drift but does not remove thermal, scheduling, presentation or warm-cache effects.</p>{paired_html}
<h2 id="results">Staged exploratory captures</h2><p>Each run: 60-second warmup, then dense/move/move/dense with 6 + 12 seconds per block. Actual framebuffer 2560 × 1440, no MSAA, 100° vertical FOV, 55° downward pitch, eye height 180 m. The moving route repeats every six seconds with x/z amplitudes of 64/32 m. Same eight fixture zones, fixed 1 m far cells, near radius eight chunks and far radius 576 chunks. No geometry or shading reduction.</p>
{table([(label, runs[run]) for run, label in labels.items()])}
<p>CPU and GPU spans overlap; Draw CPU is nested inside CPU. Ready chunks is the mean ready/required count, not the percentage of complete screen pixels. More complete near residency changes the moving near/far workload, even though source detail and rendering rules remain identical. The stationary view approaches Firefox's 120 Hz presentation ceiling. The unrestricted second worker did not show a reliable FPS benefit, which is why production reserves it for active demand and edits. Separate reference runs range from 92.6 to 101.3 FPS, demonstrating why paired comparisons are necessary.</p>
<h2 id="correctness">Correctness and excluded attempts</h2><p>Early 4 × 4 regional bundles changed seven pixels, then four pixels after correcting near/far order. Those candidates were rejected. The final single opaque command list retains global near material/depth order and executes before far terrain bundles. The final batch, scheduled and repeated-reference captures each have zero differences across 3,686,400 RGBA pixels; saved PNG bytes are independently checked by this report generator. This demonstrates equivalence at these poses, not at every possible camera.</p>
<p>The first three runs completed their timing with command reuse disabled, then failed the post-timing candidate pixel check. Their timings remain exploratory evidence for caching and worker count; they are not acceptance evidence for the rejected bundle implementation. Two pre-timing initialization attempts stalled, one with Firefox's empty-worker-source warning. The exact cause is unproven. Sequential worker warmup subsequently reached sampling. A later tab-visibility interruption is excluded from timing conclusions.</p>
<p>The first complete ABBA timing attempt then compared maps while the return-to-origin streaming/fades were still active and reported 3,013 differing pixels. It is retained as <code>paired-unsettled</code>, outside the primary results. The final harness waits for ready near chunks, no far pending work or transitions, and no ownership fades for 120 consecutive frames before pixel checks. The rerun passed both map and near-command RGBA checks. Timed blocks and production renderer code were unchanged.</p>
<p>Regression coverage includes hidden prefetch ownership, cached-mesh activation, wrap seams, cache bounds, authority windows, out-of-order worker results, queue pressure, worker failure, transparency and command invalidation. See the linked validation record for final test and build results.</p>
<h2 id="images">Identical pose and pixels</h2>{shots}
<h2>Audit and reproduction</h2><p><a href="{assets}summary.json">Computed summary</a> · <a href="{assets}validation.json">Validation</a> · <a href="{assets}exclusions.json">Excluded attempts</a> · <a href="{assets}final-source-hashes.json">Final source hashes</a> · <a href="../../tools/minecraft-torus/README.md">Reproduction steps</a></p><ul>{links}</ul></main></html>'''
(base / 'client/docs/performance-archipelago-near-streaming-2026-10-29.html').write_text(page)
print(json.dumps({'staged': runs, 'paired': paired}, indent=2))
