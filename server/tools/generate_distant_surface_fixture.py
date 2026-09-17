"""Generate reproducible EDSZ v6 browser fixtures without opening a database.

Run from server/: python tools/generate_distant_surface_fixture.py
Then open /space/app/tools/distant-surface-preview.html on the client dev server.
"""
import os
os.environ['DATABASE_URL'] = 'sqlite:///:memory:'
import sys
import argparse
import json
import base64
import hashlib
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import space_surface as surface

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--terrain-json', type=Path, help='Read-only export of a development terrain snapshot')
parser.add_argument('--zone-x', type=int, default=29)
parser.add_argument('--zone-z', type=int, default=1)
parser.add_argument('--all-zones', action='store_true', help='Generate a full streaming manifest from the terrain export')
args = parser.parse_args()

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
zone_x, zone_z = 16, 2
metadata = {'zoneX': zone_x, 'zoneZ': zone_z, 'focus': [8220, 36, 1033], 'seed': world.seed}
export = None
if args.terrain_json:
    export = json.loads(args.terrain_json.read_text())
    world = SimpleNamespace(**export['world'])
    zone_x, zone_z = args.zone_x, args.zone_z
    overlays = {(cx, cz): {**overlay, 'revision': rev, 'event': event}
        for cx, cz, rev, event, overlay in export['overlays'] if (cx // 32, cz // 32) == (zone_x, zone_z)}
    cells = [e[:3] for overlay in overlays.values() for e in overlay['standard'] if e[3]]
    focus = [(min(c[a] for c in cells) + max(c[a] for c in cells)) / 2 for a in range(3)]
    metadata = {'zoneX': zone_x, 'zoneZ': zone_z, 'focus': focus, 'seed': world.seed, 'developmentSnapshot': True}
output = Path(__file__).resolve().parents[2] / 'client/tools/generated-surface'
output.mkdir(exist_ok=True)
revision = max((o.get('event', 123) for o in overlays.values()), default=0)
raw = surface.build_surface_zone_payload(world, zone_x, zone_z, revision, overlays)
(output / '1.bin').write_bytes(raw)
levels, compressed = surface.build_surface_lods(raw)
for level in levels:
    (output / f"{level['sample_size']}.bin").write_bytes(surface.decode_surface_lod(
        SimpleNamespace(lod_payload=compressed), level))
(output / 'edits.json').write_text(json.dumps(list(overlays.items())))
(output / 'metadata.json').write_text(json.dumps(metadata))
(output / 'overviews.json').write_text(json.dumps(export.get('overviews', []) if export else []))
print(f'Generated {len(overlays)} authored chunks in {output}')
if args.all_zones:
    all_overlays = {(cx, cz): {**overlay, 'revision': rev, 'event': event}
        for cx, cz, rev, event, overlay in export['overlays']} if export else overlays
    zones = []
    for zx in range(32):
        for zz in range(4):
            selected = {k: v for k, v in all_overlays.items() if (k[0] // 32, k[1] // 32) == (zx, zz)}
            rev = max((o.get('event', 123) for o in selected.values()), default=0)
            fine = surface.build_surface_zone_payload(world, zx, zz, rev, selected)
            mips, compressed = surface.build_surface_lods(fine)
            def entry(size, data):
                name = f'{zx}_{zz}_{size}.bin'
                (output / name).write_bytes(data)
                return {'sample_size': size, 'byte_length': len(data), 'digest': hashlib.sha256(data).hexdigest(),
                        'url': '/space/app/tools/generated-surface/' + name}
            zones.append({'zone_x': zx, 'zone_z': zz, 'revision': 1, 'source_terrain_revision': rev,
                **entry(1, fine), 'lods': [entry(m['sample_size'], surface.decode_surface_lod(
                    SimpleNamespace(lod_payload=compressed), m)) for m in mips]})
        print(f'Generated streaming zones {zx * 4 + 4}/128', flush=True)
    (output / 'manifest.json').write_text(json.dumps({'schema_version': 6, 'samples_per_chunk_axis': 16,
        'zone_size_chunks': 32, 'width_chunks': 1024, 'length_chunks': 128, 'complete': True, 'zones': zones}))
