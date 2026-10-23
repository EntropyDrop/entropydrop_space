# Terrain maintenance performance, 2026-10-23

The first batch reduces main-thread frame work by **19.4% in the near view,
28.3% across the ring, and 31.0% during rotation** in the controlled local
fixture. It changes static matrix updates, settled Arena maintenance, and
repeated exact terrain picking. Geometry, resolution, materials, visibility
rules, and query frequency are unchanged.

## Measurements

The table uses the mean of the two reference-run CPU means as "before".
Each view ran reference / optimized / reference-repeat, with at least three
seconds of settled warm-up followed by 32 seconds of measurement per run.
CPU time measures the synchronous `Game.animate` callback, including renderer
submission. It does not include GPU completion or other browser tasks.

| View | Before CPU mean, ms | After CPU mean, ms | Reduction | Before CPU p95 (first / repeat), ms | After CPU p95, ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Near, stationary | 3.568 | 2.875 | 19.4% | 4.2 / 4.1 | 3.3 |
| Across ring, stationary | 2.567 | 1.841 | 28.3% | 3.0 / 3.1 | 2.3 |
| Repeated yaw sweep | 3.859 | 2.662 | 31.0% | 4.3 / 4.2 | 2.9 |

| View | RAF FPS, reference / optimized / repeat | RAF p95, ms, reference / optimized / repeat |
| --- | ---: | ---: |
| Near | 119.97 / 119.97 / 119.94 | 9.0 / 9.2 / 9.0 |
| Across ring | 120.00 / 120.00 / 120.00 | 9.1 / 9.2 / 9.0 |
| Yaw sweep | 118.97 / 119.22 / 118.53 | 9.6 / 9.9 / 9.7 |

There is **no established stable FPS increase**. Stationary cadence is already
close to 120 Hz. Rotation CPU p99 remains 14.4 / 13.8 / 14.4 ms; this batch does
not eliminate long-tail work. Rotation callbacks above 16.67 ms numbered
21 / 11 / 30, which is too variable to claim a reliable hitch reduction from
this one three-run sequence. RAF cadence is not verified display presentation.

Stage means explain where CPU time was saved. Stages are nested and must not
be added together:

| Stage and view | Reference pair mean, ms | Optimized, ms |
| --- | ---: | ---: |
| Far matrix updates, near | 0.737 | 0.304 |
| Far matrix updates, across | 0.731 | 0.299 |
| Aim picking, near | 0.524 | 0.220 |
| Aim picking, across | 0.515 | 0.208 |
| Arena synchronization, rotation | 1.545 | 0.509 |
| Complete LOD view stage, rotation | 1.823 | 0.790 |
| Aim picking, rotation | 0.494 | 0.526 |

Moving rays continue computing intersections and show about 0.032 ms of cache
dispatch overhead here. They do not record cell dependencies until a ray repeats.
Stationary Arena synchronization was already skipped before this change, so
there is no stationary Arena saving to claim.

## Controlled workload and records

- Local Aether fixture, 153 nearby chunks and 128 repeated distant districts;
  2,089,207 resident far faces in every timed result, with zero pending copies.
- 2560 x 1440 canvas; Medium lighting; shadows off; fixed 100% resolution;
  distant terrain on; shared Arena storage and far command caching on.
- Far distance 2048 chunks, subdivision target 64 CSS px squared, geometry
  budget 160 MiB. Arena allocation stayed at 9 pages and 99,090,432 bytes.
- Near drawing stayed at 273 calls / 1,780,121 triangles; across-ring drawing
  stayed at 29 / 1,098,341. Yaw endpoints differ slightly because the sweep
  follows wall time, producing small padding/visibility counter differences.
- Browser reports in-app Chromium 155 on macOS. Adapter metadata was unavailable;
  no freshly verified CPU/GPU model is asserted.
- GPU timestamp collection, screenshots, pixel readback, builds, and tests were
  excluded from timing. The automatic far-terrain FPS guard was isolated only
  while measuring, then restored along with temporary viewport/settings changes.

The [original pre-edit baseline](../src/dev/results/maintenance-original-2026-10-23.json)
was captured before implementation. The
[final paired record](../src/dev/results/maintenance-comparison-2026-10-23.json)
contains all nine measurements, percentiles, geometry counts, settings, and
timestamps. "Reference" in that record means the original algorithms selected
by the three reference switches in the same loaded scene, not a separate old
binary. This controls publication/allocation differences between reloads.

An [initial implementation trial](../src/dev/results/maintenance-initial-trial-2026-10-23.json)
is retained for audit: validating both matrices on every static source erased
the expected matrix saving. The final implementation adds an explicit owned
static-leaf path and was measured again in full. Only the final record is used
for the headline results.

These are development/offline measurements with no remote players or live
entity workload. They demonstrate CPU savings for this fixture, not a promised
online FPS increase or a GPU speedup.

## Implementation and invariants

[`StaticTerrainGroup`](../../engine/src/render/StaticTerrainGroup.ts) updates
registered terrain-owned static leaves only when their parent transform changes
or the leaf is dirty/newly attached. Only far-source and Arena-page meshes whose
transforms remain fixed during publication/culling are registered. Future edits
to those owned transforms must call `updateMatrix()` or set
`matrixWorldNeedsUpdate`. Arbitrary unregistered leaves still validate local
and world matrix values; dynamic children, descendants, custom callbacks, and
manually managed world matrices keep Three's normal update path.

[`VoxelFaceArena`](../../engine/src/render/VoxelFaceArena.ts) retains source
ordering and membership until children change, and reuses drawing/material
scratch arrays. The owner explicitly identifies visibility-only updates; these
skip entry validation, allocation, copying, and residency recounting. Geometry
publication, disposal, membership, coverage, pending copies, and fades still
take full maintenance. Default public `sync()` calls remain fully validating.
Draw order, source restoration, and GPU map generation are preserved. During
the optimized rotation run, the cumulative maintenance counter advanced only
once (the initial variant change), with no source-list rebuild; reference runs
continued performing those passes as the view rotated.

[`BentRayCache`](../../engine/src/voxel/BentRayCache.ts) caches exact terrain
intersection geometry, separately for standard and micro voxels. It validates
every previously read cell, including empty cells and face neighbors, before
reuse; edits/new occluders cannot be hidden behind an incomplete world revision.
Ray, distance, subdivision, projection/view correction, geometry backend, and
published/live policy changes invalidate reuse. Metadata remains freshly read,
cached results are copied, and entity queries still execute each frame. Query
frequency and interaction latency are unchanged.

## Visual and interaction validation

[Pixel results](../src/dev/results/maintenance-pixels-2026-10-23.json) cover
Medium and Ultra at fixed near, across-ring, and turned views, using reference /
optimized / reference-repeat in a paused simulation. All **six warmed views**
have zero changed RGB pixels and zero maximum channel delta over 3,686,400
pixels, and identical picking results. Every image was nonempty.

The warm-up pass recorded 1,254 near Medium pixels differing by at most 1 channel
level and 862 near Ultra pixels by at most 8. Both optimized and reference-repeat
had the same differences against the first capture; the full repeated pass was
exactly equal. Both passes are retained. These probes cover the loaded fixed
views with shadows off, not every camera position or graphics combination.

Regression tests cover static parent/local transforms, reparenting, manual
world matrices, `updateWorldMatrix`, custom callbacks, Arena membership/disposal
and GPU maps, new occluders/removals, micro publication/painting, returned-result
mutation, ray/view changes, and moving entity queries alongside cached terrain.

Final validation:

- Engine suite: **630/630 passed**, run alone after browser timing ended.
- Focused matrix/cache/Arena/WASM tests: **22/22 passed**.
- Engine and client TypeScript checks, production build, production-module
  initialization/worker smoke checks, English text, documentation links,
  generated API documentation, and `git diff --check`: passed.
- Client suite: **1510/1513 passed**. Three existing failures remain: the
  `entity-menu-icons` test loader cannot load `OnlineSpaceNotice.tsx`, and two
  `shovel-cursor` assertions receive a null entity outline. All three reproduced
  with the original engine sources substituted into the same worktree. These
  unrelated loader/cursor issues were not changed by this batch.

One earlier engine run alongside build/browser work exceeded an existing
5 ms timing assertion (5.249 ms). Isolated complete reruns passed; no concurrent
builds/tests were used for the reported browser measurements.

## Reproduction

Run Vite locally and open
`/space/app/?dev_offline=1&world=aether-archipelago&dev_lod=world&dev_perf=1&dev_dpr=2`.
Use a 1280 x 720 CSS viewport, dismiss Play and close the frame profiler. Wait
for 153 near chunks, all 128 districts, 2,089,207 resident faces, and settled
publication. Import [`MaintenanceBenchmark.ts`](../src/dev/MaintenanceBenchmark.ts)
from the local development console:

```js
// Replace this checkout path when running on another machine.
const project = '/Users/ha/Documents/entropydrop_website/entropydrop_space';
const m = await import(`/@fs${project}/client/src/dev/MaintenanceBenchmark.ts`);
game.controller.yaw = Math.PI / 2;
game.controller.pitch = -0.85; // Across/rotation: 1.35.
game.controller.updateRender(0);
m.setMaintenanceVariant(game, false);
const before = await m.sampleMaintenance(game, 'near before');
m.setMaintenanceVariant(game, true);
const after = await m.sampleMaintenance(game, 'near after');
m.setMaintenanceVariant(game, false);
const repeat = await m.sampleMaintenance(game, 'near before-repeat');
m.setMaintenanceVariant(game, true);
```

Use `sampleMaintenance(game, label, true)` for the eight-second sinusoidal yaw
sweep; 32 seconds samples four periods. The sampler fixes far terrain and
resolution, temporarily disables FPS-guard sampling, checks tab visibility and
workload, then restores its instrumentation and settings in `finally`. If far
terrain was already disabled at startup, re-enable it and wait for the full
fixture before the first sample. Run `checkMaintenancePixels(game)` twice after
timing to retain warm-up and warmed comparisons. Restore all three variant
switches to `true` after manual experiments. The harness is explicitly imported
only in development and is absent from the production module graph.
