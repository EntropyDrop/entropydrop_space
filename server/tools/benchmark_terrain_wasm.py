"""Run with PYTHONPATH=server DATABASE_URL=sqlite:///:memory: python server/tools/benchmark_terrain_wasm.py."""
import os
from statistics import median
from time import perf_counter
from types import SimpleNamespace

import space_surface as surface
from space.terrain_wasm import get_terrain_kernels


def benchmark(name, function, repeats=5):
    times = {'python': [], 'wasm': []}
    outputs = {}
    for round_index in range(repeats + 1):
        for mode in (('python', 'wasm') if round_index % 2 else ('wasm', 'python')):
            os.environ['SPACE_TERRAIN_BACKEND'] = mode
            start = perf_counter()
            outputs[mode] = function()
            if round_index:
                times[mode].append((perf_counter() - start) * 1000)
        assert outputs['python'] == outputs['wasm'], 'Output mismatch'
    old, new = median(times['python']), median(times['wasm'])
    print(f'{name}: Python {old:.3f} ms -> WASM {new:.3f} ms ({old / new:.2f}x)', flush=True)


if __name__ == '__main__':
    os.environ['SPACE_TERRAIN_BACKEND'] = 'wasm'
    start = perf_counter()
    get_terrain_kernels()
    print(f'WASM cold initialization: {(perf_counter() - start) * 1000:.3f} ms', flush=True)
    world = SimpleNamespace(seed=20260922, width_chunks=1024, length_chunks=128, terrain_generator_version=1)
    generate = lambda: surface.build_surface_zone_payload(world, 16, 2, 0)
    benchmark('512x512 nature surface zone', generate)
    raw = generate()
    benchmark('512x512 server LOD + Zstd + SHA256', lambda: surface.build_surface_lods(raw))
