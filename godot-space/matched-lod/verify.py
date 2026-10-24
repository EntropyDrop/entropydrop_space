"""Verify captured geometry integrity, renderer workloads, and 720p image agreement."""
import hashlib
import json
import struct
from pathlib import Path
from PIL import Image
import numpy as np

root = Path(__file__).resolve().parent
manifest_bytes = (root / 'data/manifest.json').read_bytes()
manifest = json.loads(manifest_bytes)
digest = hashlib.sha256(manifest_bytes).hexdigest()
triangles = 0
for draw in manifest['draws']:
    data = (root / 'data' / draw['file']).read_bytes()
    assert hashlib.sha256(data).hexdigest() == draw['sha256'], draw['file']
    vertices, indices = struct.unpack_from('<II', data)
    assert len(data) == 8 + vertices * 32 + indices * 4
    assert vertices == draw['vertices'] and indices == draw['triangles'] * 3
    index = np.frombuffer(data, '<u4', offset=8 + vertices * 32)
    assert index.max() < vertices
    triangles += indices // 3
assert triangles == manifest['totalTriangles']
pairs = [
    ('720p', root.parent / 'results/copper-web-1792804528102.json', root / 'results/godot-720p.json'),
    ('1440p', root.parent / 'results/copper-web-1792804596128.json', root / 'results/godot-1440p.json'),
]
for label, web_file, native_file in pairs:
    web, native = json.loads(web_file.read_text()), json.loads(native_file.read_text())
    assert web['manifestSha256'] == native['manifestSha256'] == digest
    assert web['resolution'] == native['resolution']
    assert web['unfocusedFrames'] == native['unfocusedFrames'] == 0
    assert native['minPrimitives'] == native['maxPrimitives'] == triangles
    # Three's renderer adds a one-triangle output pass (Renderer._quad).
    assert web['minPrimitives'] == web['maxPrimitives'] == triangles + 1
    assert web['maxDrawCalls'] == native['maxDrawCalls'] + 1 == len(manifest['draws']) + 1
    assert not native['debugBuild']
    for data in (web, native):
        assert len(data['rawFrameMs']) == data['frameMs']['count']
        assert abs(sum(data['rawFrameMs']) / len(data['rawFrameMs']) - data['frameMs']['mean']) < 1e-6
    image = Image.open(native_file.with_suffix('.png'))
    assert list(image.size) == native['resolution']
    print(label, 'HASH_AND_RENDER_COUNTS_PASS')
web_image = root.parent / 'results/copper-web-1792804463486.png'
native_image = root / 'results/godot-720p.png'
a = np.asarray(Image.open(web_image).convert('RGB'), dtype=float)
b = np.asarray(Image.open(native_image).convert('RGB'), dtype=float)
assert a.shape == b.shape == (720, 1280, 3)
difference = np.abs(a - b)
foreground = (a.max(axis=2) > 40) | (b.max(axis=2) > 40)
result = {
    'manifestSha256': digest, 'terrainTriangles': triangles, 'terrainDraws': len(manifest['draws']),
    'wholeImageMeanAbsoluteRgbError255': float(difference.mean()),
    'wholeImagePixelsWithin8PerChannel': float((difference.max(axis=2) <= 8).mean()),
    'foregroundMeanAbsoluteRgbError255': float(difference[foreground].mean()),
    'foregroundPixelsWithin8PerChannel': float((difference.max(axis=2)[foreground] <= 8).mean()),
}
assert result['wholeImageMeanAbsoluteRgbError255'] < .1
assert result['foregroundPixelsWithin8PerChannel'] > .99
(root / 'results/verification.json').write_text(json.dumps(result, indent=2))
print('IMAGE_AGREEMENT_PASS', json.dumps(result))
