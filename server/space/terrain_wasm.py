"""Direct Python adapter for the same import-free kernels used by browser/Node.

Compile once per process and isolate stores/scratch arenas per thread. Only
initialization falls back; kernel traps and ABI/data errors must remain visible.
SPACE_TERRAIN_BACKEND=python selects the reference implementation for diagnosis.
"""

import logging
import math
import os
from pathlib import Path
import struct
import threading

logger = logging.getLogger(__name__)
_lock = threading.Lock()
_local = threading.local()
_engine = _module = None
_initialization_error = None


def get_terrain_kernels():
    global _engine, _module, _initialization_error
    mode = os.getenv('SPACE_TERRAIN_BACKEND', 'auto')
    if mode in ('python', 'js'):
        return None
    if _module is None and _initialization_error is None:
        with _lock:
            if _module is None and _initialization_error is None:
                try:
                    import wasmtime
                    _engine = wasmtime.Engine()
                    _module = wasmtime.Module(_engine, Path(__file__).with_name('terrain-kernels.wasm').read_bytes())
                except Exception as error:
                    _initialization_error = error
                    logger.warning('Terrain WASM unavailable; using Python kernels: %s', error)
    if _initialization_error is not None:
        if mode == 'wasm':
            raise RuntimeError('Terrain WASM initialization failed') from _initialization_error
        return None
    if not hasattr(_local, 'kernels'):
        _local.kernels = TerrainKernels(_engine, _module)
    return _local.kernels


class TerrainKernels:
    def __init__(self, engine, module):
        import wasmtime
        self.store = wasmtime.Store(engine)
        self.exports = wasmtime.Instance(self.store, module, []).exports(self.store)
        if self.exports['abiVersion'](self.store) != 1:
            raise RuntimeError('Terrain WASM ABI mismatch')
        self.memory = self.exports['memory']

    def _reserve(self, end):
        if not 65536 <= end <= 32 * 1024 * 1024:
            raise ValueError('Terrain WASM scratch budget exceeded')
        missing = end - self.memory.data_len(self.store)
        if missing > 0:
            self.memory.grow(self.store, (missing + 65535) // 65536)

    def nature_surface(self, permutation, x, z, width, length, axis=512):
        if axis not in (16, 256, 512) or width <= 0 or length <= 0 or len(permutation) != 512:
            raise ValueError('Invalid nature surface lattice')
        p, tx = 65536, 65536 + 512
        tz = tx + axis * 16
        heights = tz + axis * 16
        output = heights + axis * axis * 2
        self._reserve(output + axis * axis * 8)
        self.memory.write(self.store, bytes(permutation), p)
        for pointer, origin, period in ((tx, x, width), (tz, z, length)):
            # Same host libm as the reference generator, tabulated per axis.
            values = []
            for i in range(axis):
                angle = ((origin + i) / period) * math.tau
                values.extend((math.cos(angle), math.sin(angle)))
            self.memory.write(self.store, struct.pack(f'<{axis * 2}d', *values), pointer)
        self.exports['natureHeights'](self.store, p, tx, tz, heights, axis,
                                     float(x), float(z), float(width), float(length))
        self.exports['natureSurface'](self.store, heights, output, axis * axis)
        return bytes(self.memory.read(self.store, output, output + axis * axis * 8))

    def surface_lods(self, records, axis):
        if axis not in (256, 512) or len(records) != axis * axis * 8:
            raise ValueError('Invalid surface lattice')
        pointer = 65536
        self._reserve(pointer + len(records) * 2)
        self.memory.write(self.store, records, pointer)
        result = []
        while 512 // axis < 64:
            output = pointer + axis * axis * 8
            self.exports['reduceSurfaceBytes'](self.store, pointer, output, axis)
            axis //= 2
            result.append((512 // axis, bytes(self.memory.read(self.store, output, output + axis * axis * 8))))
            pointer = output
        return result

    def solid_runs(self, heights, procedural, edits, micro):
        if len(heights) != 256 or (procedural is not None and len(procedural) != 262144):
            raise ValueError('Invalid authored solid lattice')
        capacity = 65536 + len(micro)
        table_size = 2
        while table_size < capacity * 2:
            table_size *= 2
        h = 65536
        p = h + 512
        e = p + (len(procedural) if procedural is not None else 0)
        m = e + len(edits) * 20
        a = m + len(micro) * 28
        b = a + capacity * 28
        columns = b + capacity * 28
        table = columns + 262144
        groups = table + table_size * 4
        indices = groups + capacity * 4
        temporary = indices + capacity * 4
        end = temporary + capacity * 4
        if end > 32 * 1024 * 1024:
            return None  # Preserve the Python path for oversized edited chunks.
        self._reserve(end)
        self.memory.write(self.store, struct.pack('<256H', *heights), h)
        if procedural is not None:
            self.memory.write(self.store, procedural, p)
        self.memory.write(self.store, b''.join(struct.pack('<5I', *row) for row in edits), e)
        self.memory.write(self.store, b''.join(struct.pack('<7I', *row) for row in micro), m)
        count = self.exports['solidRuns'](self.store, h, p if procedural is not None else 0,
                                         e, len(edits), m, len(micro), a, columns)
        for axis in (0, 2):
            count = self.exports['mergeSolidRuns'](self.store, a, count, axis, b,
                                                  table, table_size - 1, groups, indices, temporary)
            a, b = b, a
        return list(struct.iter_unpack('<7I', self.memory.read(self.store, a, a + count * 28)))
