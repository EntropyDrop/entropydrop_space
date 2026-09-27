# Geometry and physics solver WASM kernels

Picking, contact geometry, physics solvers and model voxelization share an
AssemblyScript module. This is trusted engine code, independent of the metered
Entity Code sandbox. Browsers, workers and the Node hosting runtime consume the
same embedded binary. No network fetch or native compiler is needed at runtime.

## Execution boundaries

- Bent voxel picking caches both air and occupied cells for one ray using exact
  numeric keys. It retains published collision snapshots and torus projection on
  the host, then intersects projected quads in batches of at most 4096 in WASM.
  Plane intersections, inclusive barycentric edges, face/triangle order, maximum
  distance and last-hit ties match the reference. Keeping projection shared also
  preserves the active tangent-chart correction and host trigonometry.
- Entity and terrain narrowphase pack oriented boxes in batches of at most 1024.
  f64 SAT, support features and contact points run in WASM. Broadphase selection,
  sweeps, terrain-face exposure checks, contact grouping,
  sleep and event publication retain their existing ordering on the host. Poses
  never change in the middle of a contact-collection batch.
- Point, hinge, limited-hinge and weld constraints pack unique body poses and
  ordered joint rows once per solve. All iterations update the same resident
  WASM state; later rows see earlier corrections, and poses are copied back
  once. External world anchors, disabled bodies and kinematic bodies retain
  their established behavior. Definitions and masses are read afresh each call.
- Entity contact impulses include angular effective mass, restitution, Coulomb
  friction, scripted owner/carrier velocity offsets and resting stabilization.
  Terrain contact solves its complete manifold (including accumulated unilateral
  impulses across 10 or 32 iterations), friction and narrow-support toppling in
  one call. Contact groups still execute in their original order and publish
  velocities before the next group. Integration, collision detection/control,
  manifold construction, sleep and event delivery remain host responsibilities.
- Model import keeps file parsing, initial surface samples, texture/vertex-color
  sampling and final block emission in TypeScript. Interior parity filling,
  hollow-shell extraction and nearest-triangle barycentrics run in a private
  WASM arena with resident triangles and numeric Y/Z buckets. The nearest pass
  returns at most 4096 records per call. Texture wrapping, transparency, tint,
  monochrome channels, microblock merging and output ordering stay shared.

The shared picking/contact arena is capped at 32 MiB (current batches require
less than 0.5 MiB). Solvers have a separate reusable 32 MiB arena. Oversized joint
or manifold layouts select JS before changing any body state. A model job has a
separate arena capped at 128 MiB, checked
before allocation. Oversized models retain the JS implementation. This is a
WASM scratch limit, not a cap on total browser/import memory: input triangles,
textures, JS grids and output blocks still consume host memory.

Only three scalar host functions are imported: `Math.sin`, `Math.cos` and
`Math.atan2`, used by the joint solver. Compilation and initialization reject
any other imports. The AssemblyScript versions produced a quaternion difference
of about 7e-18 in the trajectory fixture, which later selected a different contact
feature. Using the host builtins restores the reference trajectory without
moving solver state, iteration control or vector operations back into JS. These
imports are pure numeric operations and expose no Entity Code capabilities.
Cross-browser bitwise determinism is not promised by this change.

There are no managed allocations, threads, SIMD instructions or relaxed
floating-point operations. The compiled module is cached per realm; small
geometry calls reuse an instance and model jobs
own their instance until the job becomes unreachable. Public results are copied
into host-owned buffers/objects; model arenas survive interleaved imports.

## Build and diagnostics

From the workspace root:

```sh
npm run build:geometry-wasm
npm run check:geometry-wasm
npm run bench:geometry
npm run bench:physics-solver
```

`GeometryKernelBinary.ts` is generated and committed alongside the sources.
The engine check verifies it by recompilation. Production selects WASM by
default; initialization failure logs a warning and selects JS. Kernel execution
errors are not silently swallowed. `SPACE_GEOMETRY_BACKEND=js` selects the
reference in Node; `SPACE_GEOMETRY_BACKEND=wasm` makes initialization failure
fatal. `setGeometryKernelMode('auto' | 'js' | 'wasm')` supports browser diagnostics
and isolated tests. This switch is independent of terrain kernels.
`SPACE_PHYSICS_SOLVER_BACKEND=js` or `setPhysicsSolverMode('js')` retains WASM
geometry while selecting reference solvers. `setPhysicsSolverMode('auto')`
restores the default; the geometry switch still controls module availability.
No schema or saved-code migration is required.

## Initial geometry CPU measurements, 2026-09-27

Measured locally in Node 24.11.1. Eleven measured rounds alternate JS/WASM after
warm-up. Costs include packing, copies and returned objects. Picking compares
the same improved discovery/cache path in both modes. Model timings cover the
complete voxelization call, excluding file parsing. These are synthetic CPU
fixtures, not browser FPS or production-scene measurements.

| Work | JS median | WASM median | Ratio |
| --- | ---: | ---: | ---: |
| 1024 mixed oriented-box pairs | 0.634 ms | 0.174 ms | 3.64x |
| Downward micro picking | 0.266 ms | 0.254 ms | 1.05x |
| Grazing checkerboard micro picking | 0.439 ms | 0.339 ms | 1.29x |
| 32-cell cube voxelization | 10.353 ms | 3.103 ms | 3.34x |
| 64-cell cube voxelization | 66.940 ms | 16.953 ms | 3.95x |
| Rotated 24-cell cube voxelization | 11.143 ms | 3.217 ms | 3.46x |
| 12 interpenetrating rotated bodies, complete 50 ms simulation update | 10.900 ms | 9.512 ms | 1.15x |

These measurements precede the solver migration. The dense-contact fixture
recreates identical starting states outside the timed region and verifies
resulting poses. At that point a separate 63-hinge fixture measured 2.660 ms per
complete 50 ms update, including 1.415 ms in the JS constraint solver. Current
`bench:geometry` uses the WASM solver too; use the isolated comparison below to
measure the additional solver benefit. These fixtures do not establish
performance for every joint or collision configuration.

Air-cache verification on one synthetic 16 m ray reduced standard occupancy
reads from 1782 to 162 and micro reads from 3510 to 1062. That reduction is shared
by both backends and is separate from the ratios above.

Differential tests cover thousands of rotated/separated/degenerate boxes,
batch-boundary ties, torus seams, corrected views, black microvoxels, 120-tick
contact/hinge trajectories with impulses and terrain edits, and complete model
output across rotations, scales, hollow/solid modes and color sources.

## Solver comparison

`bench:physics-solver` keeps collision geometry in WASM for both backends. It
creates identical scenes and performs five preceding updates outside the timed
region, then measures one complete 50 ms simulation update. Five warmup rounds
are discarded; fifteen measured rounds alternate backends. Packing, state
publication and all three substeps are included. The complete final body states
are checked for exact equality. The joint fixture has 63 moving, limited hinges;
the dense fixture has 12 overlapping rotated bodies; terrain and sparse fixtures
have 32 bodies. These are CPU measurements, not browser FPS.

Local Node 24.11.1 measurements on 2026-09-27 (medians, including packing):

| Complete 50 ms update | JS solver | WASM solver | Ratio |
| --- | ---: | ---: | ---: |
| 63 moving limited hinges | 1.928 ms | 1.444 ms | 1.34x |
| 12 dense rotated bodies | 4.766 ms | 4.801 ms | 0.99x |
| 32 bodies contacting terrain | 2.631 ms | 2.690 ms | 0.98x |
| 32 sparse bodies | 0.461 ms | 0.461 ms | 1.00x |

The contact-focused measurements, including identical velocity resets, packing
and publication, were 0.493 to 0.264 microseconds per entity impulse (1.86x), and
1.284 to 1.119 microseconds per five-point terrain solve (1.15x). Joint-heavy
updates improve about 25%; complete contact-heavy updates remain close to the
reference and are slightly slower in this sample. Faster arithmetic alone does
not remove host collision traversal, contact grouping or transform costs. No
universal full-scene speedup is claimed.

Differential tests separately cover 300 mixed constraint graphs, 1200 entity
contacts with scripted owner/carrier aliases, 600 terrain manifolds, degenerate
axes/world anchors and memory growth/reuse/oversized fallback. The continuous
120-frame contact/hinge fixture also verifies
impacts and terrain removal without relaxing its existing tolerance.
