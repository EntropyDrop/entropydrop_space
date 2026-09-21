from concurrent.futures import ThreadPoolExecutor
import struct
from types import SimpleNamespace

import pytest
import space_surface as surface
from space.terrain_wasm import get_terrain_kernels
import space.terrain_wasm as wasm


@pytest.mark.parametrize('seed,zone_x,zone_z', [(42, 0, 0), (20260922, 16, 2), (1337, 31, 3)])
def test_nature_zone_is_byte_identical_to_python(monkeypatch, seed, zone_x, zone_z):
    world = SimpleNamespace(seed=seed, width_chunks=1024, length_chunks=128, terrain_generator_version=1)
    monkeypatch.setenv('SPACE_TERRAIN_BACKEND', 'python')
    expected = surface.build_surface_zone_payload(world, zone_x, zone_z, 123)
    monkeypatch.setenv('SPACE_TERRAIN_BACKEND', 'wasm')
    assert get_terrain_kernels() is not None
    assert surface.build_surface_zone_payload(world, zone_x, zone_z, 123) == expected


@pytest.mark.parametrize('schema,axis', [(3, 256), (5, 256), (6, 512)])
def test_lod_payloads_hashes_compression_and_authored_trailer_match(monkeypatch, schema, axis):
    count = axis * axis
    samples, record_bytes = (8, 5) if schema == 3 else (512 // axis, 8)
    raw = bytearray(struct.pack('<4sBBBBHHiIQI', b'EDSZ', schema, samples, 32, record_bytes,
                                31, 3, 42, 2, 123, count))
    for i in range(count):
        h = i * 173 % 2049 if i % 5 else 0
        color = (i * 11 % 256, i * 3 % 256, i * 17 % 256)
        raw.extend(struct.pack('<HBBB', h, *color) if schema == 3 else
                   struct.pack('<HHBBBB', h, max(0, h - i * 37 % 100), *color, i * 13 % 256))
    if schema != 3:
        raw.extend(struct.pack('<IBBQI6H3B', 1, 31, 31, 123, 1, 120, 320, 120, 8, 16, 8, 255, 0, 0))
    monkeypatch.setenv('SPACE_TERRAIN_BACKEND', 'python')
    expected = surface.build_surface_lods(bytes(raw))
    monkeypatch.setenv('SPACE_TERRAIN_BACKEND', 'wasm')
    assert surface.build_surface_lods(bytes(raw)) == expected


def test_threads_have_isolated_stores_and_invalid_lattices_fail(monkeypatch):
    monkeypatch.setenv('SPACE_TERRAIN_BACKEND', 'wasm')
    main = get_terrain_kernels()
    with ThreadPoolExecutor(max_workers=1) as pool:
        worker = pool.submit(get_terrain_kernels).result()
    assert main is not worker
    with pytest.raises(ValueError, match='lattice'):
        main.surface_lods(b'', 512)
    with pytest.raises(ValueError, match='lattice'):
        main.nature_surface([], 0, 0, 16384, 2048)


def test_initialization_failure_has_reference_fallback_and_strict_mode(monkeypatch):
    monkeypatch.setattr(wasm, '_initialization_error', RuntimeError('WASM disabled for fixture'))
    monkeypatch.setenv('SPACE_TERRAIN_BACKEND', 'auto')
    assert get_terrain_kernels() is None
    monkeypatch.setenv('SPACE_TERRAIN_BACKEND', 'wasm')
    with pytest.raises(RuntimeError, match='initialization failed'):
        get_terrain_kernels()
