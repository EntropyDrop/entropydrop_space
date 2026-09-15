# 8×8×8 Micro Grid and P0 Physics Optimizations

Each standard one-metre block is divided into 512 micro cells with a 0.125-metre edge length. Integer micro-cell indices and metre coordinates use shared grid constants, with in-cell offsets ranging from 0 to 7.

## Completed work

- Unified scale handling across carving, micro-cell selection, copy/paste, assembly/disassembly, rotation, previews, model import, and collision geometry.
- Historical note: Protobuf originally used the packed micro-cell index `1 + mx + 8*my + 64*mz` (indices 1–512). Inventory v7 now uses `is_micro` plus the three `micro_x`/`micro_y`/`micro_z` components (0–7). See [formats.md](formats.md) for the current wire format.
- Updated coordinate conversion in backend voxel operations, the hosting runtime, distant-height snapshots, and shaders.
- Cached merged collision boxes and BVHs in three-dimensional 2×2×2-metre partitions, with at most 4,096 micro cells per partition. Collision boxes can merge across colors while preserving holes, and queries no longer scan empty micro cells inside the bounding volume.
- Tied collision-cache publication to mesh publication. Editing and sliced clearing continue using the complete displayed shape, including across toroidal world seams.
- Allowed entities to sleep after one second at rest. Nearby chunk changes, forces, impulses, collisions, and support movement or removal wake them; distant edits and unrelated loading-window changes do not.
- Kept scripts running while entities sleep. Static support contacts are delivered with `sleeping: true`, zero impulse, and zero relative velocity, allowing scripted forces to wake the entity during the same update.

## Data formats

| Data | Current version |
| --- | --- |
| InventoryResource | 7 |
| Backpack | 8, `space.backpack.v8.pb` |
| Offline entities | 4 |
| Local terrain cache and upload outbox | 3, `space.world-edits.v3.*` |
| Distant-surface snapshots | 3 |

As required, v1/v2 local terrain data is not converted. Standalone Space database migration `space_0003` resets old terrain, entities, market resources, player positions, and derived snapshots, then updates resource constraints to v6. Migration `space_0004` converts v6 entity definitions in place to the v7 wire format (`is_micro` + `micro_x/y/z` + `color_rgb`), recomputes content digests and sizes, and increments entity revisions while preserving terrain, surfaces, player positions, and hosting leases. Market resources remain in object storage but are temporarily unavailable for download. World configuration, account data, quotas, and billing records are preserved. Stop all Space API and worker writes, create a backup, and run `tools/deploy_space.py <dev|prod> --quiesce` before release. `space_0003` refuses to run while unused paid hosting time or linked authorizations remain.

## Verification

At the 2026-09-08 snapshot, 259 engine tests, 571 frontend tests, and 104 relevant backend tests passed. Engine, frontend, and hosting-runtime type checks also passed. Coverage included encoding and decoding all 512 offsets, negative coordinates and seams, carved holes, sliced replacement, static support, and local wakeups. Use `npm run check` for the current baseline.

Local CPU microbenchmark on 2026-09-08: a 4×4×4-metre query volume contained 1,024 ground micro cells merged into one collision box. The initial cache build took 1.88 ms.

| Query path | Median | P95 |
| --- | ---: | ---: |
| Per-cell query | 5.1181 ms | 5.5617 ms |
| Cached collision boxes | 0.0013 ms | 0.0014 ms |

An existing benchmark with 100 entities, 100 standard blocks per entity, and 50 ms simulated per iteration measured medians of 26.48 ms for active entities, 0.25 ms for stopped entities, and 0.30 ms for sleeping entities. It excludes scripts, terrain occupancy, rendering, and networking and therefore cannot predict browser FPS.

Reproduce these results from the shared-engine directory with `node tools/benchmark-micro-terrain.ts` and `node tools/benchmark-physics.ts`. Cached-query gains depend on shape continuity and edit frequency; the first cache-build cost is measured separately.

## Continuous spoon-edit stutter fix (2026-09-08)

- Reduced micro-mesh and collision rebuild scope from a four-metre-wide full-height column to a 2×2×2-metre region, so continuous input no longer repeatedly discards large column tasks.
- Preserved unchanged collision indices and sleep versions during painting, component labeling, and neighboring-surface updates.
- Prevented acknowledgements for consecutive local chunk versions from reinstalling chunks. Version jumps still request authoritative data without advancing the global event cursor, so edits to other chunks are not skipped.
- Skipped mesh replacement when an incoming snapshot matches final local content. The comparison happens after merging pending uploads and is itself frame-budgeted.
- Preserved newer committed operations using per-chunk snapshot and acknowledgement versions during sliced comparison, preventing an old snapshot from restoring a recently removed micro cell while still keeping later edits from other users.
- Limited minimap queries to changed micro chunks inside the viewport, consistently converted micro heights to metres, made upload-batch spatial statistics incremental, and removed the default extra 200 ms wait between batches.

Same-machine Node CPU comparison for continuous local carving in a dense 4×4×8-metre micro-cell region with a 2 ms mesh-build budget per frame:

| Metric | Before | After |
| --- | ---: | ---: |
| Median mesh CPU per cut | 37.48 ms | 2.56 ms |
| Frames until the mesh appeared | 19 | 2 |
| Median collision query after publication | 43.27 ms | 2.32 ms |
| Cuts displayed before the next cut, out of 30 | 0 | 30 |
| Mesh CPU for sparse regions 64 metres apart | 213.30 ms | 0.158 ms |

These are CPU benchmarks, not browser FPS or actual network latency. Reproduce the current version by running `node tools/benchmark-spoon-edits.ts` from the engine directory. The earlier query microbenchmark records the historical four-metre partition implementation.

Regression snapshot for this change: 291 engine tests and 574 frontend tests passed, with added coverage for continuous editing, write acknowledgements during sliced comparison, cross-chunk synchronization, and atomic publication of new and old standard/micro meshes. Counts are from 2026-09-08.
