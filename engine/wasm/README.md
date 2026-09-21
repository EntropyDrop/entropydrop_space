# Shared terrain kernels

`terrain.ts` compiles with pinned AssemblyScript into the **same** import-free
WebAssembly binary for all hosts:

- Browser main thread and terrain workers: embedded in `TerrainKernelBinary.ts`.
- Node hosting and Copper surface workers: embedded in their normal bundles.
- Python surface worker: `server/space/terrain-kernels.wasm`, executed directly
  through Wasmtime (no subprocess for nature terrain or LOD reductions).

Run from the workspace root:

```sh
npm run build:terrain-wasm
npm run check:terrain-wasm
npm run bench:terrain
# Optional full server Copper zone, after npm run build:server-runtime:
npm run bench:terrain -- --server-zone
PYTHONPATH=server DATABASE_URL=sqlite:///:memory: python server/tools/benchmark_terrain_wasm.py
```

Both generated files are committed. `npm run check` recompiles and checks their
bytes, so production bundlers do not need a native WASM toolchain. The approximately
4 KB module is compiled once per JS realm; Python caches the compiled module per
process and gives each thread its own store. The compiler is development-only.

## Scope and compatibility

WASM handles batched 3D simplex heights, standard box paints, Copper micro-shell
rasterization/filtering, occupied bounds, frontend linear-color LOD pyramids and
backend packed sRGB LOD reductions. Copper's seeded building/parcel grammar stays
in one TypeScript implementation. Nature copies only its occupied-height slab.
Generated decorations still enter `World.microVoxels` as real editable/collidable
microterrain; they are not a second visual-only mesh.

The source generator versions, seed semantics and surface wire formats do not
change. Heights, colors, micro-cell order/duplicates, first-peak tie breaking,
minimum heights, conservative color errors and authored-solid trailers are covered
by exact reference comparisons. Nature noise arithmetic remains f64. Frontend
error buffers remain f32 and backend error buffers remain bytes; the two error
representations intentionally have distinct reduction entry points.

Camera-dependent LOD selection, connection meshes, meshing, physics and GPU drawing
remain on their existing paths. These benchmarks measure CPU generation and LOD
preparation, **not FPS** or the complete world-loading time.

## Memory and fallback

The module allocates no managed objects and imports no host functions. Scratch
memory starts at byte 65536, is reset/reused per synchronous call, and is bounded
to 32 MiB. Results are copied into host-owned arrays before returning; later calls
or memory growth cannot overwrite installed chunks/mips. Micro boxes retain their
unclipped shell bounds when intersecting a chunk.

Initialization failure logs a warning and uses the reference implementation.
Execution/validation errors are not silently swallowed. For diagnostics, set
`SPACE_TERRAIN_BACKEND=js` in Node and `SPACE_TERRAIN_BACKEND=python` in Python.
`setTerrainKernelMode('js' | 'wasm' | 'auto')` selects a mode in JS tests/benchmarks;
Python `SPACE_TERRAIN_BACKEND=wasm` makes initialization failure fatal. Defaults
use WASM automatically. The offline hosting smoke test requires native WASM.

The simplex kernel adapts simplex-noise's MIT-licensed 3D algorithm; see
[its license](simplex-noise-LICENSE.txt).
