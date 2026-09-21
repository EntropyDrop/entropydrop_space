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
npm run bench:render-kernels
npm run bench:physics
# Optional full server Copper zone, after npm run build:server-runtime:
npm run bench:terrain -- --server-zone
PYTHONPATH=server DATABASE_URL=sqlite:///:memory: python server/tools/benchmark_terrain_wasm.py
PYTHONPATH=server DATABASE_URL=sqlite:///:memory: python server/tools/benchmark_authored_solids.py
```

Both generated files are committed. `npm run check` recompiles and checks their
bytes, so production bundlers do not need a native WASM toolchain. The approximately
11 KB module is compiled once per JS realm; Python caches the compiled module per
process and gives each thread its own store. The compiler is development-only.

## Scope and compatibility

WASM handles batched 3D simplex heights, standard box paints, Copper micro-shell
rasterization/filtering, occupied bounds, frontend linear-color LOD pyramids and
backend packed sRGB LOD reductions, world microvoxel greedy meshing, camera-dependent
LOD subdivision, far-surface connection runs, standard chunk meshes, authored
solid extraction/merging and collision probe transforms. Copper's seeded building/parcel grammar stays
in one TypeScript implementation. Nature copies only its occupied-height slab.
Generated decorations still enter `World.microVoxels` as real editable/collidable
microterrain; they are not a second visual-only mesh.

The source generator versions, seed semantics and surface wire formats do not
change. Heights, colors, micro-cell order/duplicates, first-peak tie breaking,
minimum heights, conservative color errors and authored-solid trailers are covered
by exact reference comparisons. Nature noise arithmetic remains f64. Frontend
error buffers remain f32 and backend error buffers remain bytes; the two error
representations intentionally have distinct reduction entry points.

Micro meshing packs one 16x16x16 partition plus its neighbor halo. Packing can
yield; mesh and collision publication still use the existing revision checks and
handoff barriers. Material groups, normals, winding and Three color conversion
match the JS reference. Other working color spaces retain the JS path.

LOD subdivision visits at most 256 quadtree nodes per call and keeps its frontier
and compact hysteresis bitset in host-owned arrays between calls. Root caches,
generation cancellation, screen-error thresholds, coverage budgets and render
yields remain in the host. Trigonometry uses cached JS samples of the same torus
projection. Connection owners use a numeric hash table in a separate WASM instance
per rebuild, with at most 128 queried cells per call. Side-zone caches and atomic
publication are unchanged; owner sets above 524288 cells use the JS path.

Standard meshes preserve indexed face order, material groups, neighbor culling,
streaming cut-face runs and Uint16/Uint32 indices. Python authored solids preserve
air gaps, first-seen grouping order, duplicate edit semantics and the 2m horizontal
span cap. Their bytes (and therefore snapshot digests) are unchanged. Copper
overlays request at most 32 procedural chunks per Node process, bounding IPC to
8 MiB and avoiding one startup per chunk. Oversized solid arenas use Python.

Collision sample templates cache geometry-only local probes until the source
geometry changes; live pivots, body attachment, collision flags and poses are
applied in f64 batches. Returned vectors remain independent across pose changes.
Templates above 262144 points retain JS. SAT, sweeps, impulses, resting support,
sleep, scene publication and GPU drawing stay on their existing paths. A negative
terrain broadphase skips redundant probes only for unit-scale rigid transforms,
complete micro-occupancy queries and non-sweeping motion. Point-only hosts and
fast sweeps always retain the full path. `bench:physics` compares the old full
probe path with the optimized path in an empty world: this is **not** a dense
contact benchmark or a WASM-only speedup.

These benchmarks measure CPU work, **not FPS** or complete
world-loading time. `bench:render-kernels` alternates JS/WASM, discards two warmup
rounds, reports nine-sample medians and verifies geometry hashes. Its full Copper
LOD rebuild deliberately excludes cache reuse and yield waiting.

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
