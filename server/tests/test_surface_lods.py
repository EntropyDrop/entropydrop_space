import hashlib
import importlib
import struct
from types import SimpleNamespace

import pytest
import space_surface as surface
from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


def source_payload():
    raw = bytearray(struct.pack('<4sBBBBHHiIQI', b'EDSZ', 3, 8, 32, 5, 31, 3, 42, 1, 99, 65536))
    for cx in range(32):
        for cz in range(32):
            for sx in range(8):
                for sz in range(8):
                    x, z = cx * 8 + sx, cz * 8 + sz
                    raw.extend(struct.pack('<HBBB', 100 + x + z, x, z, 71))
    return bytes(raw)


def test_pyramid_reorders_chunk_major_data_and_preserves_peak_colour_at_every_level():
    levels, compressed = surface.build_surface_lods(source_payload())
    row = SimpleNamespace(lod_payload=compressed)
    assert [level['sample_size'] for level in levels] == [4, 8, 16, 32, 64]
    for level in levels:
        raw = surface.decode_surface_lod(row, level)
        header = struct.unpack_from('<4sBBBBHHiIQI', raw)
        size = level['sample_size']
        axis = 512 // size
        assert header == (b'EDSZ', 5, size, 32, 8, 31, 3, 42, 1, 99, axis ** 2)
        assert len(raw) == 36 + axis ** 2 * 8
        assert hashlib.sha256(raw).hexdigest() == level['digest']
        for x in range(axis):
            for z in range(axis):
                peak_x, peak_z = (x + 1) * size // 2 - 1, (z + 1) * size // 2 - 1
                assert struct.unpack_from('<HHBBBB', raw, 32 + (x * axis + z) * 8) == (
                    100 + peak_x + peak_z, 100 + x * size // 2 + z * size // 2, peak_x, peak_z, 71, size // 2 - 1)
    assert levels[-1]['byte_length'] == 548
    # Errors and the empty authored trailer accompany even the coarsest mip.
    assert levels[-1]['byte_length'] * 128 < 70 * 1024


def test_pyramid_uses_stable_first_maximum_and_rejects_corrupt_metadata():
    source = bytearray(source_payload())
    for offset in range(32, len(source), 5):
        struct.pack_into('<H', source, offset, 100)
    levels, compressed = surface.build_surface_lods(bytes(source))
    row = SimpleNamespace(lod_payload=compressed)
    coarse = surface.decode_surface_lod(row, levels[-1])
    assert struct.unpack_from('<HHBBBB', coarse, 32)[:5] == (100, 100, 0, 0, 71)
    with pytest.raises(ValueError, match='metadata'):
        surface.decode_surface_lod(row, {**levels[-1], 'byte_length': 2 ** 31})
    with pytest.raises(ValueError, match='checksum'):
        surface.decode_surface_lod(row, {**levels[-1], 'digest': '0' * 64})
    with pytest.raises(ValueError):
        surface.build_surface_lods(bytes(source[:-1]))


def test_surface_lod_migration_preserves_existing_source_snapshots(monkeypatch):
    migration = importlib.import_module('space.migrations.versions.0008_surface_lods')
    engine = sa.create_engine('sqlite:///:memory:')
    with engine.begin() as connection:
        connection.execute(sa.text('CREATE TABLE space_surface_zone_snapshots (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)'))
        connection.execute(sa.text('INSERT INTO space_surface_zone_snapshots VALUES (1, :payload)'), {'payload': b'original'})
        monkeypatch.setattr(migration, 'op', Operations(MigrationContext.configure(connection)))
        migration.upgrade()
        assert connection.execute(sa.text('SELECT payload, lod_manifest, lod_payload FROM space_surface_zone_snapshots')).one() == (b'original', None, None)
        migration.downgrade()
        assert connection.execute(sa.text('SELECT payload FROM space_surface_zone_snapshots')).scalar() == b'original'
    engine.dispose()


def test_authored_columns_preserve_bridges_excavation_and_micro_air_gaps():
    class Flat:
        def sample_height(self, x, z):
            return 16
    overlay = {'standard': [[1, 16, 1, 0, 0], [1, 40, 1, 1, 0xff0000],
                            [1, 41, 1, 1, 0xff0000]],
               'micro': [[8, 160, 8, 0x0000ff], [8, 161, 8, 0x0000ff]]}
    boxes = surface._chunk_solid_runs(Flat(), 0, 0, overlay)
    def colors_at(x, y, z):
        return [c for bx, by, bz, w, h, d, c in boxes
                if bx <= x < bx + w and by <= y < by + h and bz <= z < bz + d]
    assert colors_at(8, 16 * 8, 8) == []  # excavated terrain is still empty
    assert colors_at(8, 30 * 8, 8) == []  # air beneath the floating beam
    assert colors_at(8, 40 * 8, 8) == [0xff0000]
    assert colors_at(8, 41 * 8, 8) == [0xff0000]
    assert colors_at(8, 160, 8) == [0x0000ff]
    assert colors_at(9, 160, 8) == []  # micro footprint is not inflated to 2m


def test_authored_trailer_survives_all_mips_byte_for_byte():
    source = bytearray(source_payload())
    levels, payload = surface.build_surface_lods(bytes(source))
    # Build a valid v5 fine lattice with an authored chunk at the wrapped corner.
    fine = bytearray(source[:32])
    fine[4:8] = bytes((5, 2, 32, 8))
    fine.extend(struct.pack('<HHBBBB', 136, 128, 113, 143, 97, 0) * 65536)
    trailer = struct.pack('<IBBQI6H3B', 1, 31, 31, 123, 1, 120, 320, 120, 8, 16, 8, 255, 0, 0)
    fine.extend(trailer)
    levels, payload = surface.build_surface_lods(bytes(fine))
    for level in levels:
        raw = surface.decode_surface_lod(SimpleNamespace(lod_payload=payload), level)
        assert raw[32 + (512 // level['sample_size']) ** 2 * 8:] == trailer
        assert struct.unpack_from('<HH', raw, 32) == (136, 128)


def test_v6_source_retains_one_metre_steps_and_pyramid_bounds(monkeypatch):
    class Steps:
        def __init__(self, *args):
            pass
        def sample_height(self, x, z):
            return 16 + x % 2
    monkeypatch.setattr(surface, 'TerrainSurfaceGenerator', Steps)
    world = SimpleNamespace(seed=42, width_chunks=1024, length_chunks=128, terrain_generator_version=1)
    raw = surface.build_surface_zone_payload(world, 0, 0, 0)
    assert raw[4:8] == bytes((6, 1, 32, 8))
    assert len(raw) == 36 + 512 * 512 * 8
    assert struct.unpack_from('<HH', raw, 32) == (136, 136)
    assert struct.unpack_from('<HH', raw, 32 + 512 * 8) == (144, 144)
    levels, compressed = surface.build_surface_lods(raw)
    assert [l['sample_size'] for l in levels] == [2, 4, 8, 16, 32, 64]
    for level in levels:
        mip = surface.decode_surface_lod(SimpleNamespace(lod_payload=compressed), level)
        assert struct.unpack_from('<HH', mip, 32) == (144, 136)
