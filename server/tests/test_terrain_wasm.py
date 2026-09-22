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


@pytest.mark.parametrize('procedural', [False, True])
@pytest.mark.parametrize('chunk', [(0, 0), (1023, 127)])
def test_authored_runs_match_order_colors_gaps_and_duplicate_edits(monkeypatch, procedural, chunk):
    import random
    rng = random.Random(20260922)
    cx, cz = chunk
    generator = surface.TerrainSurfaceGenerator(42, 16384, 2048)
    overlay = {'standard': [], 'micro': []}
    for _ in range(400):
        x, y, z = rng.randrange(16), rng.randrange(256), rng.randrange(16)
        overlay['standard'].append([cx * 16 + x, y, cz * 16 + z, rng.randrange(3), rng.randrange(0x1000000)])
    overlay['standard'].extend([[cx * 16, 20, cz * 16, 1, 0xffffff], [cx * 16, 20, cz * 16, 0, 0]])
    for _ in range(1000):
        overlay['micro'].append([cx * 128 + rng.randrange(12), rng.randrange(100), cz * 128 + rng.randrange(12), rng.choice([0, 0xffaacc])])
    overlay['micro'].extend([[cx * 128, 2047, cz * 128, 0], [cx * 128, 2047, cz * 128, 0xffffff]])
    packed = None
    if procedural:
        packed = bytearray(262144)
        for i in range(65536):
            if i % 5:
                packed[i * 4:i * 4 + 4] = bytes((1, i % 256, (i // 256) % 256, 0))
    monkeypatch.setenv('SPACE_TERRAIN_BACKEND', 'python')
    expected = surface._chunk_solid_runs(generator, cx, cz, overlay, packed)
    monkeypatch.setenv('SPACE_TERRAIN_BACKEND', 'wasm')
    actual = surface._chunk_solid_runs(generator, cx, cz, overlay, packed)
    assert actual == expected
    assert all(box[3] <= 16 and box[5] <= 16 for box in actual)


def test_authored_zone_and_lod_payloads_are_byte_identical(monkeypatch):
    world = SimpleNamespace(seed=42, width_chunks=1024, length_chunks=128, terrain_generator_version=1)
    overlay = {(0, 0): {'revision': 7, 'standard': [[0, 8, 0, 0, 0], [0, 30, 0, 1, 0xff0033]],
                         'micro': [[1, 64, 1, 0], [1, 65, 1, 0], [127, 2000, 127, 0xff0000]]}}
    monkeypatch.setenv('SPACE_TERRAIN_BACKEND', 'python')
    expected = surface.build_surface_zone_payload(world, 0, 0, 7, overlay)
    lods = surface.build_surface_lods(expected)
    monkeypatch.setenv('SPACE_TERRAIN_BACKEND', 'wasm')
    actual = surface.build_surface_zone_payload(world, 0, 0, 7, overlay)
    assert actual == expected
    assert surface.build_surface_lods(actual) == lods


@pytest.mark.parametrize("version", [2, 3])
def test_runtime_chunk_batches_match_single_chunk_generation(version):
    keys = [(512, 64), (1023, 127), (512, 64)]
    actual = surface._terrain_runtime_payload('chunks', 42, version, 0, 0, keys)
    expected = b''.join(surface._terrain_runtime_payload('chunk', 42, version, x, z) for x, z in keys)
    assert actual == expected
    with pytest.raises(ValueError, match='1..32'):
        surface._terrain_runtime_payload('chunks', 42, version, 0, 0, keys * 11)


@pytest.mark.parametrize("version", [2, 3])
def test_runtime_edits_use_bounded_batches_and_preserve_sorted_trailers(monkeypatch, version):
    calls = []
    def runtime(mode, seed, version, x, z, chunks=None):
        calls.append((mode, chunks))
        return bytes(512 * 512 * 8 if mode == 'zone' else len(chunks) * 262144)
    monkeypatch.setattr(surface, '_terrain_runtime_payload', runtime)
    world = SimpleNamespace(seed=42, width_chunks=1024, length_chunks=128, terrain_generator_version=version)
    keys = [(i // 32, i % 32) for i in range(65)]
    payload = surface.build_surface_zone_payload(world, 0, 0, 1, {key: {'revision': 1} for key in reversed(keys)})
    assert [len(batch) for mode, batch in calls if mode == 'chunks'] == [32, 32, 1]
    offset = 32 + 512 * 512 * 8
    assert struct.unpack_from('<I', payload, offset)[0] == 65
    for key in keys:
        offset += 4 if key == keys[0] else 14
        assert struct.unpack_from('<BBQI', payload, offset) == (*key, 1, 0)
