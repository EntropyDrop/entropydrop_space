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
        assert header == (b'EDSZ', 4, size, 32, 5, 31, 3, 42, 1, 99, axis ** 2)
        assert len(raw) == 32 + axis ** 2 * 5
        assert hashlib.sha256(raw).hexdigest() == level['digest']
        for x in range(axis):
            for z in range(axis):
                peak_x, peak_z = (x + 1) * size // 2 - 1, (z + 1) * size // 2 - 1
                assert struct.unpack_from('<HBBB', raw, 32 + (x * axis + z) * 5) == (
                    100 + peak_x + peak_z, peak_x, peak_z, 71)
    assert levels[-1]['byte_length'] == 352
    # The full world's first overview is 44 KiB, including 128 headers.
    assert levels[-1]['byte_length'] * 128 == 44 * 1024


def test_pyramid_uses_stable_first_maximum_and_rejects_corrupt_metadata():
    source = bytearray(source_payload())
    for offset in range(32, len(source), 5):
        struct.pack_into('<H', source, offset, 100)
    levels, compressed = surface.build_surface_lods(bytes(source))
    row = SimpleNamespace(lod_payload=compressed)
    coarse = surface.decode_surface_lod(row, levels[-1])
    assert struct.unpack_from('<HBBB', coarse, 32) == (100, 0, 0, 71)
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
