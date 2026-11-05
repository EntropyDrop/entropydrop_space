"""Summarize captured ordinary-frame benchmarks and deterministic image differences."""
import json
import sys
from pathlib import Path
from statistics import mean
import numpy as np
from PIL import Image

root = Path(sys.argv[1])
summary = {"capture": root.name, "worlds": []}
for path in sorted(root.glob('*.json')):
    result = json.loads(path.read_text())
    if 'rows' not in result:
        continue
    assert not result['errors'], result['errors']
    rows = result['rows']
    assert result['revision'] in ('texture-bake-v2-settled', 'texture-bake-v3-proxy')
    assert rows and all(row['raw'] and row['gpu'] for row in rows), 'Missing timing samples'
    assert all(row['pendingFrames'] == 0 for row in rows), 'Streaming contaminated a timed block'
    assert all(frame['frame'] > 0 for row in rows for frame in row['raw']), 'Invalid frame interval'
    if result.get('control'):
        assert all(not row['settings']['textureProxyEnabled'] and not row['texture'].get('used') for row in rows)
    world = {"world": result['world'], "adapter": result['adapter'], "framebuffer": [result['width'], result['height']],
             "userAgent": result['userAgent'], "control": result.get('control', False),
             "quality": result['quality'], "shadows": result['shadows'], "rows": [], "images": [], "pooled": [],
             "totals": {"blocks": len(rows), "frames": sum(len(r['raw']) for r in rows),
                        "gpuSamples": sum(len(r['gpu']) for r in rows)}}
    # Pool elapsed frame intervals, not instantaneous FPS. Blocks are repeated
    # observations; thousands of autocorrelated frames are not independent trials.
    for view in ['all', *sorted({r['view'] for r in rows})]:
        for config in dict.fromkeys(r['config'] for r in rows):
            group = [r for r in rows if r['config'] == config and (view == 'all' or r['view'] == view)]
            if not group:
                continue
            frames = [f for r in group for f in r['raw']]
            intervals = [f['frame'] for f in frames]
            world['pooled'].append({"config": config, "view": view, "blocks": len(group), "frames": len(frames),
                "fps": 1000 / mean(intervals), "blockFps": [r['fps'] for r in group],
                "frameMeanMs": mean(intervals), "frameP95Ms": float(np.percentile(intervals, 95)),
                "cpuMeanMs": mean(f['cpu'] for f in frames),
                "gpuMeanMs": mean(g['spanMs'] for r in group for g in r['gpu']),
                "drawCalls": mean(f['calls'] for f in frames), "triangles": mean(f['triangles'] for f in frames)})
    for row in rows:
        ref = [r for r in rows if r['config'] == 'off' and r['view'] == row['view']]
        baseline_gpu = mean(r['metrics']['gpu']['mean'] for r in ref)
        baseline_faces = mean(r['arena']['residentFaces'] for r in ref)
        world['rows'].append({"config": row['config'], "view": row['view'], "block": row['block'], "fps": row['fps'],
            "frameMeanMs": row['metrics']['frame']['mean'], "frameP95Ms": row['metrics']['frame']['p95'],
            "cpuMeanMs": row['metrics']['cpu']['mean'], "gpuMeanMs": row['metrics']['gpu']['mean'],
            "gpuP50Ms": row['metrics']['gpu']['p50'], "gpuChangePercent": 100 * (row['metrics']['gpu']['mean'] / baseline_gpu - 1),
            "triangles": row['metrics']['triangles']['mean'], "residentFaces": row['arena']['residentFaces'],
            "residentReductionPercent": 100 * (1 - row['arena']['residentFaces'] / baseline_faces),
            "texture": row['texture'], "settleMs": row['settleMs']})
    for view in sorted({r['view'] for r in rows} - {'sweep', 'turn'}):
        references = [r for r in rows if r['config'] == 'off' and r['view'] == view]
        reference = references[-1]
        def read(row):
            name = f"{result['world']}-{row['config']}-{view}-{row['block']+1}.png"
            return np.asarray(Image.open(root / name).convert('RGB'), dtype=np.int16)
        baseline = read(reference)
        for row in [r for r in rows if r['view'] == view]:
            delta = np.abs(read(row) - baseline).max(axis=2)
            world['images'].append({"config": row['config'], "view": view, "block": row['block'],
                "changedOver2Percent": float((delta > 2).mean() * 100), "meanMaxRgb": float(delta.mean()),
                "maxRgb": int(delta.max()), "p99Rgb": float(np.percentile(delta, 99))})
    summary['worlds'].append(world)
output = root / 'summary.json'
output.write_text(json.dumps(summary, indent=2) + '\n')
print(output)
for world in summary['worlds']:
    print(world['world'])
    for row in world['rows']:
        print(f"  {row['config']:8s} {row['view']:6s} GPU {row['gpuMeanMs']:.3f} ms ({row['gpuChangePercent']:+.1f}%), FPS {row['fps']:.1f}, resident {row['residentReductionPercent']:.1f}% fewer")
    for row in world['images']:
        print(f"  pixels {row['config']:8s} {row['view']:6s}: {row['changedOver2Percent']:.4f}% >2, mean {row['meanMaxRgb']:.4f}, max {row['maxRgb']}")
