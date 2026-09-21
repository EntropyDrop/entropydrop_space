"""CPU/IPC benchmark; run with PYTHONPATH=server DATABASE_URL=sqlite:///:memory:."""
import os
from statistics import median
from time import perf_counter

import space_surface as surface
from benchmark_terrain_wasm import benchmark


if __name__ == '__main__':
    generator = surface.TerrainSurfaceGenerator(20260922, 16384, 2048)
    for cx, cz in [(512, 64), (511, 63), (513, 65)]:
        procedural = surface._terrain_runtime_payload('chunk', 20260922, 2, cx, cz)
        overlay = {'standard': [[cx * 16 + 1, 20, cz * 16 + 1, 0, 0],
                                [cx * 16 + 3, 100, cz * 16 + 4, 1, 0xff8800]],
                   'micro': [[cx * 128 + i % 128, 500 + i // 128, cz * 128 + 1, 0x44aacc]
                             for i in range(1024)]}
        benchmark(f'Copper authored solids {cx},{cz}',
                  lambda: surface._chunk_solid_runs(generator, cx, cz, overlay, procedural), repeats=9)
    os.environ['SPACE_TERRAIN_BACKEND'] = 'wasm'
    keys = [(512 + i, 64) for i in range(8)]
    times = {'single': [], 'batch': []}
    for _ in range(4):
        start = perf_counter()
        singles = b''.join(surface._terrain_runtime_payload('chunk', 20260922, 2, cx, cz) for cx, cz in keys)
        times['single'].append((perf_counter() - start) * 1000)
        start = perf_counter()
        batch = surface._terrain_runtime_payload('chunks', 20260922, 2, 0, 0, keys)
        times['batch'].append((perf_counter() - start) * 1000)
        assert batch == singles
    old, new = median(times['single'][1:]), median(times['batch'][1:])
    print(f'8 Copper chunks including IPC/startup: single {old:.3f} ms -> batch {new:.3f} ms ({old / new:.2f}x)')
