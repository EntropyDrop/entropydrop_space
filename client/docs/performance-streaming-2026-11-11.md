# Teleport streaming and shadow-caster experiments, 2026-11-11

Five experiments follow the sun shadow-map reuse change (`5e8d234`). Four are
retained; one is rejected. Together the retained changes bring the measured
teleport from about 3.86 s to about 2.2 s to a ready detailed AOI.

All measurements use Chrome on an Apple M1 Pro
(10 cores), the offline Aether world (`?dev_offline=1`), Medium lighting, a
visible 60 Hz browser pane and a 153-chunk detailed AOI.

## Protocol

Each trial reloads the page, enters the world, waits until the detailed AOI
is ready and far-terrain downloads are idle, then waits two to three quiet
seconds. It teleports the player with `PlayerPhysics.setInitialPosition` to
the same fixed spot (`x = 3300`, `z = 1100`), with flight enabled, and
records the time until `World.getTerrainAoiLoadProgress()` reports ready,
plus every `requestAnimationFrame` interval during that time. A discarded
warm-up trial fills the persistent far-LOD cache first.

Variants are switched at runtime on the same build, so both run identical
code apart from the measured behaviour, in alternating order.

Two earlier protocols were invalid and are not reported as results:

- With the pane hidden, Chrome throttled `requestAnimationFrame` to 1 Hz and
  delayed timers, so the worker queue looked permanently full.
- Teleporting repeatedly within one page to new places produced steadily
  growing times (6.5 s to more than 30 s) as background state accumulated,
  and different places differ greatly in micro-detail density.
- Writing `PlayerPhysics.position` directly left the render interpolation on
  the old pose, so the stream centre alternated between two places.

## Rejected: cull shadow casters by the sun's shadow frustum

Torus-hooked terrain sets `frustumCulled = false`, so the shadow pass draws
every caster that `cullChunks` leaves enabled. The candidate additionally
required each caster's view-projected bent sphere to intersect the
orthographic shadow frustum. Three's WebGPU renderer does not enable depth
clamping, so clipped casters cannot write shadow texels and the change would
have been output-equivalent.

It removed nothing. Near chunk columns are tall: their bent spheres have a
radius of about 80 m, while Ultra's shadow box is ±64 m. All 50 casters that
pass the existing `radius + 64 m` camera-distance test intersect the box. An
earlier estimate of 30 culled chunks used the flat camera position and
counted chunks that the distance test already excludes. The shadow pass
stayed at 80 draws and 317,514 triangles. No code was kept.

## Retained: publish several finished terrain results per idle slice

The idle streaming callback used a fixed 1 ms budget and published at most
one finished terrain-worker result. It now uses the browser's remaining idle
time minus a 1 ms margin, clamped to 1-3 ms (a timed-out callback keeps 1 ms),
and keeps publishing while elapsed time plus a moving average of one
publication fits the budget. The in-frame publication in
`processInteractiveTerrainWork` is unchanged.

| Variant | Ready (ms) | Frames > 20 ms |
|---|---|---|
| One result per slice | 3882, 3810, 3891 | 0, 0, 0 |
| Idle-budget batches | 3757, 3721, 3714 | 0, 0, 0 |

The gain is about 3.5%. Instrumentation explains why it is small: the
completed-result queue was empty in 79% of frames and the two terrain workers
averaged 0.27 busy. Standard terrain had meshes for every AOI chunk about
0.8 s after the teleport; the remaining time was micro-detail meshing.

## Retained: bound micro mesh queue re-sorting

During a teleport the micro dirty queue holds roughly 45,000 partitions.
`MicroVoxelLayer.sortMeshQueue` re-sorted all of them, parsing every key,
whenever a single new partition arrived, which is almost every slice while
loading. In one trial it took 632 ms of the 1,057 ms spent in `updateMesh`,
more than packing (167 ms) and publication (49 ms) together. The single micro
mesh worker was also saturated (13.6 of 16 jobs outstanding on average).

Arrivals alone now trigger a re-sort at most every 100 ms. New partitions
already arrive roughly nearest-first because the terrain worker generates
nearest chunks first. A focus change or a disabled worker still re-sorts
immediately, and direct edits are moved to the front by `prioritizeMeshAt`
as before, independent of sorting. The sort itself caches each key's parsed
column and sorts an index array instead of allocating a record per key.

The baseline below forces a re-sort on every arrival with the cheaper sort
body, isolating the rate limit.

| Variant | Ready (ms) | Re-sorts | Sort time (ms) | Frames > 20 ms |
|---|---|---|---|---|
| Re-sort on every arrival | 3501, 3542, 3483 | 86, 85, 80 | 356, 340, 326 | 0, 0, 0 |
| At most every 100 ms | 2975, 3049, 2989 | 14, 14, 14 | 63, 63, 62 | 0, 0, 0 |

Mean time to a ready AOI falls from 3,509 to 3,004 ms (-14%). Compared with
the original code (about 3.86 s in the first experiment's baseline), the two
retained changes bring the same teleport to about 3.0 s.

These are single-machine, single-place results with three trials per
variant. They establish a repeatable reduction for this case, not a general
loading-time figure.

## Retained: a two-worker micro mesh pool

With the re-sort bound in place, the single micro mesh worker was the next
limit: in 245 of 293 `updateMesh` calls the outstanding snapshots were at the
16-job bound. Micro meshing now uses a pool. Each worker has its own 16-job
bound and receives new snapshots when it is the least loaded; results from
any worker publish through the same revision checks. A failure in any worker
disables the whole pool and falls back to budgeted local meshing, as a single
worker failure did before. The default is one worker per four reported cores,
at most two.

The pool size was switched at runtime on the same build:

| Workers | Ready (ms) | Mean | Calls at the queue bound | Frames > 20 ms |
|---|---|---|---|---|
| 1 | 3085, 3050, 3000 | 3045 | 245 of 293 | 0, 0, 0 |
| 2 | 2939, 2887, 2928 | 2918 | 0 of 272 | 0, 0, 0 |
| 3 | 2936, 2892 | 2914 | 0 of 276 | 0, 0 |

Two workers are 4.2% faster than one and the ranges do not overlap. A third
worker adds nothing: with two, the outstanding queue averages about 16 and
never reaches its bound, so snapshot packing on the main thread, inside the
idle streaming budget, is now the limit. The pool is therefore capped at two.

## Retained: empty partitions do not consume the micro build count

With two workers the queue no longer filled, yet packing time was small
(about 170 ms per teleport). Classifying why each `updateMesh` call stopped
showed the per-call count of 64 builds was the usual limit, followed by the
time budget. Published worker results, submitted snapshots and partitions
that scan as empty all shared that count, and about 7,800 of the roughly
16,000 items per teleport were empty partitions that had no mesh before and
have none after. They publish no geometry, but each used one of the 64
slots.

An empty partition with no previous mesh now returns `'empty'` and does not
count toward the build limit. It still publishes its empty collision state at
the same commit point, still respects the time budget, and at most 16 such
partitions are retired per counted build in one call. Removing a previously
published mesh still counts. The call's return value is unchanged.

The baseline below maps `'empty'` back to a counted completion at runtime:

| Variant | Ready (ms) | Frames > 20 ms |
|---|---|---|
| Empty partitions counted | 2914, 2940, 3028 | 0, 0, 0 |
| Empty partitions uncounted | 2175, 2179 | 0, 0 |

Mean time to a ready AOI falls from 2,961 to 2,177 ms (-26%), with no long
frames. A third uncounted trial is excluded: the browser pane was hidden
during it, throttling animation frames to 1 Hz (1,000 ms frame intervals),
so it measured the throttle rather than the change.

## Remaining opportunities

- Snapshot packing still runs on the main thread inside the idle streaming
  budget. Moving halo gathering into the workers would need a shared or
  transferred copy of the cell data; re-measure which limit applies first.
- Partitions that never contain cells could avoid entering the dirty queue
  at all, which would also shrink the 45,000-entry queue that sorting and
  progress checks scan.
- The benchmark's 20 ms progress polling calls `getPendingStandardChunkKeys`,
  which costs about 1.4 ms per call with a large dirty queue. Any UI that
  polls loading progress per frame should be checked for the same cost.

## Validation

Engine tests pass. Client tests pass except the existing
`resolution-settings.test.ts:284` failure, which also fails on `5e8d234`.
New tests cover the idle budget bounds, budgeted multi-publication, barrier
rotation without spinning, the bounded re-sort with immediate focus and
direct-edit priority, the default pool size, balanced pool dispatch with
output identical to local meshing, whole-pool fallback after a worker
failure, and empty partitions that do not consume the build count while mesh
removals still do.
