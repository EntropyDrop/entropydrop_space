"""Validate the finer LOD fixture and the recorded cross-renderer measurements."""
import hashlib
import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image

root = Path(__file__).resolve().parent
manifest_bytes = (root / 'data/manifest.json').read_bytes()
manifest = json.loads(manifest_bytes)
digest = hashlib.sha256(manifest_bytes).hexdigest()
assert manifest['profile'] == 'fine'
assert manifest['distantSettings']['subdivisionSizePx2'] == 1
assert manifest['detail']['effectiveAreaPx2'] == 9.75
triangles = 0
for draw in manifest['draws']:
    data = (root / 'data' / draw['file']).read_bytes()
    assert hashlib.sha256(data).hexdigest() == draw['sha256'], draw['file']
    vertices, indices = struct.unpack_from('<II', data)
    assert len(data) == 8 + vertices * 32 + indices * 4
    assert vertices == draw['vertices'] and indices == draw['triangles'] * 3
    assert np.frombuffer(data, '<u4', offset=8 + vertices * 32).max() < vertices
    triangles += indices // 3
assert triangles == manifest['totalTriangles'] == 4206058
pairs = [
    ('720p', '1792805628399', 'godot-720p'),
    ('1440p', '1792805669243', 'godot-1440p'),
    ('4K run 1', '1792805716615', 'godot-4k-run1'),
    ('4K run 2', '1792805878875', 'godot-4k-run2'),
    ('5K run 1', '1792805765484', 'godot-5k-run1'),
    ('5K run 2', '1792805836006', 'godot-5k-run2'),
]
results = []
for label, web_id, native_id in pairs:
    web_path = root.parent / 'results' / f'copper-web-{web_id}.json'
    native_path = root / 'results' / f'{native_id}.json'
    web, native = json.loads(web_path.read_text()), json.loads(native_path.read_text())
    assert web['manifestSha256'] == native['manifestSha256'] == digest
    assert web['resolution'] == native['resolution']
    assert web['unfocusedFrames'] == native['unfocusedFrames'] == 0
    assert web['msaa'] == native['msaa'] == 4
    assert native['minPrimitives'] == native['maxPrimitives'] == triangles
    # Three.js also renders one fullscreen output triangle.
    assert web['minPrimitives'] == web['maxPrimitives'] == triangles + 1
    assert web['maxDrawCalls'] == native['maxDrawCalls'] + 1 == len(manifest['draws']) + 1
    assert not native['debugBuild']
    assert list(Image.open(native_path.with_suffix('.png')).size) == native['resolution']
    for data in (web, native):
        assert len(data['rawFrameMs']) == data['frameMs']['count']
        assert abs(sum(data['rawFrameMs']) / len(data['rawFrameMs']) - data['frameMs']['mean']) < 1e-6
    results.append({'label': label, 'webFile': str(web_path.relative_to(root.parent)),
                    'godotFile': str(native_path.relative_to(root.parent)),
                    'webFps': web['fps'], 'godotFps': native['fps'],
                    'webP95Ms': web['frameMs']['p95'], 'godotP95Ms': native['frameMs']['p95']})
    print(label, 'HASH_COUNTS_FOCUS_RESOLUTION_PASS')
images = []
for label, web_id, native_id in [('720p', '1792805637168', 'godot-720p'),
                                 ('5K', '1792805804238', 'godot-5k-run2')]:
    a = np.asarray(Image.open(root.parent / 'results' / f'copper-web-{web_id}.png').convert('RGB'), dtype=np.int16)
    b = np.asarray(Image.open(root / 'results' / f'{native_id}.png').convert('RGB'), dtype=np.int16)
    assert a.shape == b.shape
    difference = np.abs(a - b)
    foreground = (a.max(axis=2) > 40) | (b.max(axis=2) > 40)
    record = {'resolution': label, 'imageSize': [a.shape[1], a.shape[0]],
              'meanAbsoluteRgbError255': float(difference.mean()),
              'pixelsWithin8PerChannel': float((difference.max(axis=2) <= 8).mean()),
              'foregroundPixelsWithin8PerChannel': float((difference.max(axis=2)[foreground] <= 8).mean())}
    assert record['meanAbsoluteRgbError255'] < .1
    assert record['foregroundPixelsWithin8PerChannel'] > .99
    images.append(record)
    print(label, 'IMAGE_AGREEMENT_PASS', record)
output = {'manifestSha256': digest, 'terrainTriangles': triangles, 'terrainDraws': len(manifest['draws']),
          'distantSettings': manifest['distantSettings'], 'detail': manifest['detail'], 'trials': results, 'images': images}
(root / 'results/verification.json').write_text(json.dumps(output, indent=2) + '\n')
