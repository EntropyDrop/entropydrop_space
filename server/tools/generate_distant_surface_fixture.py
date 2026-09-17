"""Generate reproducible EDSZ v5 browser fixtures without opening a database.

Run from server/: python tools/generate_distant_surface_fixture.py
Then open /space/app/tools/distant-surface-preview.html on the client dev server.
"""
import os
os.environ['DATABASE_URL'] = 'sqlite:///:memory:'
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import space_surface as surface

world = SimpleNamespace(seed=20260827, width_chunks=1024, length_chunks=128,
                        zone_size_chunks=32, terrain_generator_version=1)
overlays = {}
def block(x, y, z, value, color):
    entry = overlays.setdefault((x // 16, z // 16), {'standard': [], 'micro': [], 'revision': 123})
    entry['standard'].append([x, y, z, value, color])

# Floating magenta beam, red post / elbow, blue foot, and an excavated pit.
for x in range(8200, 8240):
    for z in range(1032, 1034):
        for y in range(58, 60):
            block(x, y, z, 1, 0xc64db0)
for y in range(28, 60):
    for x in range(8238, 8240):
        for z in range(1032, 1034):
            block(x, y, z, 1, 0xe54432)
for x in range(8226, 8240):
    for z in range(1032, 1034):
        block(x, 28, z, 1, 0xe54432)
for y in range(19, 28):
    for z in range(1032, 1034):
        block(8226, y, z, 1, 0x237b99)
for x in range(8208, 8216):
    for z in range(1040, 1048):
        for y in range(12, 24):
            block(x, y, z, 0, 0)
overlays[512, 64]['micro'] = [[8201 * 8, 40 * 8, 1036 * 8, 0x32cdef]]
output = Path(__file__).resolve().parents[2] / 'client/tools/generated-surface'
output.mkdir(exist_ok=True)
raw = surface.build_surface_zone_payload(world, 16, 2, 123, overlays)
(output / '2.bin').write_bytes(raw)
levels, compressed = surface.build_surface_lods(raw)
for level in levels:
    (output / f"{level['sample_size']}.bin").write_bytes(surface.decode_surface_lod(
        SimpleNamespace(lod_payload=compressed), level))
import json
(output / 'edits.json').write_text(json.dumps(list(overlays.items())))
print(f'Generated {len(overlays)} authored chunks in {output}')
