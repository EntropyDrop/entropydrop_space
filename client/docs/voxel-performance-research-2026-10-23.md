# Voxel performance research, 2026-10-23

Research and code review only; no renderer or gameplay changes are introduced by
this report. Local observations refer to the working tree based on `cc84c71`,
including existing uncommitted changes. External results are not measurements of
EntropyDrop. Historical repository measurements are explicitly identified below.

The recommended sequence is to remove repeated CPU work, measure conservative
occlusion and geometry costs, and then consider a hybrid rendering experiment.
Keep the existing mesh, worker, WASM and face-arena architecture as the baseline.
The recently added low-FPS distant-terrain switch remains a useful fallback; it
does not establish that the same scene has become cheaper to render.

## What is already implemented

The [architecture](architecture.md), [engine documentation](../../engine/README.md),
[rendering experiments](../src/dev/README.md) and current source show substantial
existing optimization:

- Worker mesh preparation and shared AssemblyScript/WASM kernels; separate near
  terrain and distant surface snapshots.
- Screen-area LOD with hysteresis, bounded publication, near/far coverage handoff,
  compressed face records, vertex pulling, page batching and command caching.
- Greedy meshing for micro voxels and distant surfaces; bounded micro render
  batching that preserves independent edit/collision partitions.
- Physics sleeping, spatial broadphase, merged collision proxies, cached work
  within simulation ticks, and fixed simulation with render interpolation.

Therefore, generic advice to add workers, use WASM, add LOD, enable greedy meshing
everywhere, or combine draw calls would largely repeat completed work. The main
questions are which remaining stages dominate particular scenes and how much
work still executes when geometry is unchanged or hidden.

The world also has constraints absent from most comparison engines: toroidal
coordinates, camera-local flattening, exact bent-geometry picking, editable
structures, holes and ceilings, and near/far ownership transitions. A spatial
bound or merged face that is correct in a flat world can be wrong here.

## Evidence from this repository

| Observation | Evidence and limit | Implication |
| --- | --- | --- |
| Arena batching already removed substantial CPU submission cost | Historical local fixture: across-ring Ultra rose from roughly 72 to 91 FPS; Medium rotation from roughly 78 to 120. Separate GPU timing did not consistently improve. See the arena results preceding the remaining-opportunities section in the [experiment log](../src/dev/README.md). | Draw-call reductions have been valuable, but further reductions alone cannot guarantee GPU or whole-frame gains. |
| Static far source objects remain in the scene graph | The October 4 audit counted 2,247 direct children after a sweep. A temporary matrix-propagation prototype saved about 0.3-0.7 ms CPU p50, with no established stable FPS gain. | This is the strongest measured small CPU opportunity, subject to current-baseline revalidation. |
| Rotation can trigger repeated arena bookkeeping | The same audit recorded LOD work around 0.1 ms stationary versus 2.7 ms during rotation. Current [arena sync](../../engine/src/render/VoxelFaceArena.ts) still filters/sorts sources, constructs membership, scans entries and recounts storage before its unchanged check. | Split membership/geometry changes from visibility changes. The whole 2.7 ms is not attributable to arena bookkeeping. |
| Some earlier allocation advice is already implemented | `visibleBlocks` now retains a typed map per entry and caches view/coverage revisions. | Do not repeat the October 4 recommendation to eliminate a per-block temporary array as though it were still missing. |
| Exact picking can repeat unchanged work | Historical stationary, entity-free picking cost was about 0.5 ms/frame. [PlayerController](../src/engine/controls/PlayerController.ts) still calls the exact aim query from `updateAimRaycast`. | A revision-aware result cache is worth measuring; a slower query cadence would change interaction behavior. |
| Packed records are not the whole geometry allocation | [VoxelFaceArena](../../engine/src/render/VoxelFaceArena.ts) uses 16 bytes/face for records and six uint32 indices per face. Each page owns a GPU index buffer while sharing a CPU template; visibility maps add storage. [DistantVoxelLayer](../../engine/src/render/DistantVoxelLayer.ts) conservatively budgets 48 bytes/face. | Investigate index-buffer ownership and allocation separately. Do not report 16 bytes/face as total GPU memory. |
| Micro edits can cause aggregate publication spikes | [MicroRenderBatches](../../engine/src/render/MicroRenderBatches.ts) caps a merged chunk at 32,768 vertices, but `flush` visits all dirty chunks and retires their previous meshes. | A bounded individual merge does not bound a burst of many edits; measure total copy/upload/retirement work. |

These are historical measurements and current code observations, not a fresh
benchmark of the latest working tree. The fixtures also exclude some live-world
costs such as active remote entities and server synchronization.

## Community and game implementations

| Reference | Relevant mechanism | Application here |
| --- | --- | --- |
| [Binary Greedy Meshing v2](https://github.com/cgerikj/binary-greedy-meshing) | Uses 64-bit occupancy masks for bulk face rejection, material-aware merging, compact quad records and vertex pulling. Its demo uses native OpenGL multi-draw. | Prototype bitmask extraction inside WASM. Existing packed rendering already covers part of the design. Its native timings and 8-byte format do not transfer directly to our attributes, coordinate ranges or browser. |
| [Sodium occlusion traversal](https://github.com/CaffeineMC/sodium/blob/dev/common/src/main/java/net/caffeinemc/mods/sodium/client/render/chunk/occlusion/OcclusionCuller.java) | Traverses section connectivity with face visibility and frustum constraints. | Consider conservative connectivity rejection for dense enclosed scenes. Start with caves/interiors; evaluate topology and projection carefully for our curved world. This is a different technique from a GPU depth pyramid. |
| [Voxy Hi-Z](https://github.com/MCRcortex/voxy/blob/dev/src/main/resources/assets/voxy/shaders/hiz/hiz.comp) and [hierarchical traversal](https://github.com/MCRcortex/voxy/blob/dev/src/main/resources/assets/voxy/shaders/lod/hierarchical/traversal_dev.comp) | Public native shader references for hierarchical depth reduction and GPU traversal. | Useful architectural comparison for far visibility. Native GLSL extensions, queue layout and backend integration need a WebGPU-specific design. |
| [Godot Voxel Tools performance guide](https://voxel-tools.readthedocs.io/en/latest/performance/) | Discusses worker throughput, main-thread budgets, mesh block size, upload/destruction spikes and bulk edits. | Unify publication and retirement accounting; put backpressure on producers. Increasing workers alone can make queued results and main-thread spikes worse. |
| [Sector's Edge developer article](https://vercidium.com/blog/further-voxel-world-optimisations/) | Uses occupied-column bounds, contiguous traversal, precomputed terms, face runs and direct buffer writes to accelerate rebuilds. | Benchmark edit latency as well as polygon count. Small destructible regions may favor fast run meshing over maximum merging. Our standard mesher already restricts a vertical range, so finer bounds need measured justification. |
| [Veloren development report](https://veloren.net/blog/devblog-81/) | Historical implementation notes on greedy meshes, atlases and distant terrain. | Supports separating close interaction geometry from distant appearance. This 2020 report is a design precedent, not evidence of Veloren's complete current renderer. |
| [noa](https://github.com/fenomas/noa) | Browser voxel engine with configurable chunk priorities, load distances and fast paths for uniform chunks. | A useful browser-oriented comparison for scheduling and stress fixtures; avoid comparing native engines' peak FPS with browser workloads. |
| [Distant Horizons](https://gitlab.com/distant-horizons-team/distant-horizons) | Separates distant simplified terrain from normal detailed chunks. | This separation is already present here. Further research should target snapshot invalidation, generation, transfer and publication costs rather than adding another parallel LOD system. |
| [Teardown developer talk, 2025](https://graphicsprogrammingconference.com/archive/2025/) | Describes production voxel ray tracing and renderer tradeoffs, including operation without dedicated ray-tracing hardware. | A useful precedent for experimenting with ray-traced voxel objects. It does not establish that replacing our browser terrain rasterizer would be faster. |
| [Unreal Nanite Foliage](https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-foliage) | Experimental mixed representations address small disconnected geometry and distant coverage. | Borrow the principle of selecting representations by projected error and coverage. Preserve thin structures and silhouettes; porting the full renderer is a separate project. |

Public source availability is not the same as an unrestricted open-source
license. In the reviewed revisions, [Sodium's README](https://github.com/CaffeineMC/sodium)
identifies PolyForm Shield, and [Voxy's license](https://github.com/MCRcortex/voxy/blob/dev/LICENSE.md)
reserves rights. Treat these as architectural references rather than assuming
their code can be incorporated. Binary Greedy Meshing and noa identify MIT
licenses. No external implementation was copied for this report.

## Recent research and its limits

**Six Ways to Draw Vangers with WebGPU, August 2026.** This
[preprint](https://arxiv.org/html/2608.17390v1) compares six terrain representations
in one engine, from ray marching and sliced proxies to compute scatter and
triangulated irregular networks. TIN had the lowest mean frame time on the
selected devices, with substantial geometry and editable-triangulation memory.
The main comparisons used native wgpu backends; browser coverage was a limited
smoke test, not a six-method browser performance comparison. Its layered
heightfield is also less general than our editable volumetric world. Use its
multi-axis evaluation method: horizon artifacts, memory, edit cost and frame
time all matter. The [vange-rs implementation](https://github.com/kvark/vange-rs)
offers a reproducible research starting point. The paper identifies itself as
submitted to JCGT; this report does not claim acceptance.

**NAADF, Eurographics / Computer Graphics Forum, May 2026.**
[The paper](https://www.cg.tuwien.ac.at/research/publications/2026/ulschmid-2026-naadf/)
combines a nested spatial structure with axis-aligned distance caches for empty
space skipping, plus voxel-aware temporal accumulation for global illumination.
It supports edits and dynamic overlays. This makes it more relevant to editable
worlds than static-only DAG demos, but its reported ray-throughput gains are not
rasterization FPS gains. The [MIT reference implementation](https://github.com/cg-tuwien/NAADF)
uses a compute-enabled MonoGame fork and currently documents Windows support.
Editing/entity logic stays on CPU and synchronizes to GPU. A compact near-object
or shadow-ray prototype is a reasonable long-term experiment; a browser port and
curved-world validation remain substantial work.

**Aokana, PACMCGIT / I3D, May 2025.**
[The paper](https://arxiv.org/html/2505.02017v1) uses shallow chunk SVDAGs,
tile/chunk work, LOD and a visibility-buffer pipeline. A particularly useful
idea is two-stage occlusion: previous-frame Hi-Z predicts visibility, and a
current-frame pass recovers falsely rejected work. Its implementation uses
Unity/Vulkan and 64-bit atomic visibility updates; it does not support runtime
voxel modification or transparent voxels. Borrow conservative visibility and
streaming ideas first. Its reported speedups are relative to its own comparison
renderers, not a forecast for this project.

**Encoding Occupancy in Memory Location for Efficient and Compact
High-Resolution Voxel Structures, November 2025.**
[This CGF paper](https://onlinelibrary.wiley.com/doi/10.1111/cgf.70292) encodes
occupancy information in address layout to reduce explicit occupancy storage and
accesses, including integration with editable compact structures. The relevant
lesson is to optimize memory access as well as compressed byte counts. It is a
long-term storage/traversal direction, not a drop-in replacement for our face
arena.

**Transform-Aware Sparse Voxel Directed Acyclic Graphs, I3D, May 2025.**
[The author publication page](https://publications.graphics.tudelft.nl/papers/810)
describes compression of repeated structures under transformations, extending
ordinary subtree sharing. Repeated buildings make static far-world storage a
plausible application. Material variation, edits and synchronization would need
separate accounting; a smaller representation alone does not prove faster frames.

**Editing Compact Voxel Representations on the GPU, Pacific Graphics, 2024.**
[The paper](https://diglib.eg.org/items/ffd7acf6-01f7-4e53-87f8-4cded382c944) and
[CUDA implementation](https://github.com/mathijs727/GPU-SVDAG-Editing) demonstrate
GPU editing of compact voxel structures. They show that DAG editing is possible,
but not that it is inexpensive to integrate into a browser engine with shared
CPU/server state. Evaluate synchronization and collision/picking latency before
considering GPU-resident authoritative edits.

## WebGPU feasibility, checked against current specifications

Older blanket claims that WGSL only has 32-bit atomic operations are incomplete.
The [September 21, 2026 WGSL draft](https://www.w3.org/TR/2026/CRD-WGSL-20260921/#atomic-types)
defines the optional `atomic_vec2u_min_max` extension: paired uint32 values support
64-bit unsigned atomic min/max through `atomicStoreMin` and `atomicStoreMax`.
This is relevant to depth/ID visibility-buffer packing, but it is not general
64-bit integer arithmetic or arbitrary atomic compare/exchange. Target adapters
and browser versions must expose and enable the feature; specification presence
alone is not proof of broad deployment.

The reviewed [WebGPU API specification source](https://github.com/gpuweb/gpuweb/blob/main/spec/index.bs)
does not include `multiDrawIndirect` or `multiDrawIndexedIndirect`.
[Chrome's original experimental implementation](https://developer.chrome.com/blog/new-in-webgpu-131)
used a non-standard feature and unsafe flag. Do not require that experiment for
production users. A baseline prototype should work with supported indirect
draws, storage/compute and existing render-bundle facilities, then add optional
capabilities after runtime checks. Native Vulkan/OpenGL/CUDA code is not a direct
browser implementation, and Three's renderer integration must be evaluated too.

## Prioritized experiments

| Priority | Experiment and entry points | Expected kind of benefit | Decision evidence |
| --- | --- | --- | --- |
| P0 | Rebaseline current fixtures and live scenes through [FrameDiagnostics](../src/dev/FrameDiagnostics.ts) | Trustworthy attribution | Same scene, settings and visible geometry; CPU stages, GPU passes, cadence distributions and queues recorded separately |
| P1 | Avoid redundant static far matrix propagation around [DistantVoxelLayer](../../engine/src/render/DistantVoxelLayer.ts) | CPU headroom | Reproduce historical CPU reduction; no regression in transforms, publication or teardown |
| P1 | Split membership/geometry maintenance from visibility in [VoxelFaceArena](../../engine/src/render/VoxelFaceArena.ts) | Rotation CPU time and fewer transient allocations | Source sort/count work disappears for visibility-only updates; preserve ordering and handoff |
| P1 | Cache unchanged exact aim results in [PlayerController](../src/engine/controls/PlayerController.ts) | Stationary CPU time | Identical hit/selection under edits, entity motion and camera changes |
| P2 | Conservative opaque cluster occlusion | GPU geometry/shading work in occluded views | Net GPU win after depth-pyramid/selection overhead; no missing geometry during rapid motion |
| P2 | Share immutable GPU index storage or evaluate procedural quad topology | Resident buffer allocation; possibly bandwidth | Actual created-buffer accounting, lifetime correctness, GPU timing and shader invocation cost |
| P2 | Binary occupancy extraction / incremental remeshing in [standard](../../engine/wasm/standard-mesh.ts), [micro](../../engine/wasm/micro-mesh.ts) and [surface](../../engine/wasm/voxel-surface.ts) kernels | Worker throughput, edit latency, potentially fewer faces | End-to-end edit-to-visible p95; material/geometry equivalence, boundary cases |
| P2 | Aggregate upload/retirement budgets and bounded dirty queues around [MicroRenderBatches](../../engine/src/render/MicroRenderBatches.ts) and distant publication | Fewer streaming and edit hitches | Lower p95/p99 without starvation or growing memory/visibility latency |
| P3 | Small hybrid brick ray-tracing / compact far-storage prototype | Potential long-term scalability | Browser A/B against current meshes at equal image quality, including edits, memory and integration costs |

**Static scene work.** Do not freeze the entire scene or merely set
`matrixAutoUpdate = false`; the latter is already used and does not eliminate
forced world-matrix propagation. A narrowly scoped optimization must handle new
children under transformed parents, reparenting, local changes, explicit force,
manual matrices and `updateWorldMatrix`. Reducing retained source-object count is
another possibility, but would change restoration/publication ownership and is
more invasive than the first experiment.

**Arena maintenance.** Keep a stable ordered source registry with membership and
attribute revisions; update residency counters on allocation/retirement. Use
existing child events, while distinguishing arena-generated children from source
meshes. Visibility changes should update cached blocks/maps without rebuilding
unrelated source state. Preserve coplanar draw order, fade fallback and the
ability to reconstruct source geometry. Current per-entry visibility caching
should be retained.

**Aim cache.** Key reuse on the actual bent ray, world projection revision,
published terrain/collision revision, relevant entity poses and tool/query
policy. Ensure a previously empty ray invalidates when new geometry appears.
Keep action-time queries correct; do not substitute render visibility for
interaction visibility.

**Occlusion.** First prototype opaque far clusters in the dense Copper street
fixture, then compare open/aerial Aether views where occlusion may lose. Use
conservative bounds after torus bending and local flattening. Invalidate or
recover visibility on abrupt camera movement, edits and near/far handoff.
Transparent/fading geometry must not become an opaque occluder. Keep visibility
on GPU where practical; a per-frame CPU readback can erase the benefit. A
two-phase recovery pass or fail-open policy is necessary for stale depth. Shadow
casters need independent visibility: camera-hidden geometry may still cast a
visible shadow.

**Index storage.** Each full 262,144-face page has a 6 MiB uint32 index allocation
in addition to its 4 MiB face records. The CPU index template is already shared.
A shared GPU buffer requires explicit lifetime ownership across geometry disposal
and renderer caches. A procedural six-vertex quad avoids the index allocation
but can increase vertex work relative to four unique indexed vertices, including
our projection arithmetic. Test memory and time separately; neither topology is
assumed faster.

**Meshing.** Standard visible faces are generally emitted per block, with a
special vertical cut-edge merge. Micro/surface paths already have scalar greedy
meshing. Try WASM bit operations for occupancy rejection before changing geometry
semantics. Any broader merging must preserve color, material, emission,
transparency and shading, and respect curvature error: one large flat quad after
nonlinear projection is not necessarily equivalent to many small quads. Chunk
halos, holes, seams and exact picking require regression cases. End-to-end gains
also require that uploading or publishing the result is not the dominant stage.

**Streaming and editing.** Count total work across copy, installation, buffer
upload and retirement, using both time and byte budgets. Coalesce superseded
revisions, cancel obsolete requests and cap outstanding worker output. Preserve
fairness so distant or expensive chunks eventually publish. For micro edits,
compare partition-local patching or reusable buffer regions against the current
bounded rebuild. Measure snapshot fetch/decode/republication before changing the
network protocol; revisions, caching and separate far snapshots already exist.

**Shadows and simulation.** Profile quality modes independently. Current
[SceneRenderer](../src/engine/render/SceneRenderer.ts) avoids ordinary near camera
culling when shadows require broader geometry; a separate caster list could
reduce work without dropping offscreen shadows. Physics already has sleeping,
broadphase and tick-local reuse. Optimize active islands, script allocations or
entity synchronization only when live-scene profiles identify them. Lowering the
fixed simulation rate is a gameplay change, not a generic renderer optimization.

## Measurement and acceptance plan

Use identical recorded camera paths and world revisions for each variant:

| Scene | Main question |
| --- | --- |
| Aether stationary near and across-ring views | Baseline CPU/GPU cost and static work |
| Aether repeated yaw, rapid turns and travel | Visibility maintenance, stale depth, publication |
| Copper street, interior and aerial views | Occlusion benefit versus overhead and thin-structure correctness |
| Sparse and dense micro edits, repeated boundary edits | Remeshing, uploads, retirement and edit-to-visible latency |
| Active entities, scripts, physics and remote updates | Full-world CPU contention absent from offline fixtures |
| Cold cache, warmed cache, teleport and background/resume | Queue bounds, first-use compilation, loading and recovery |

Record canvas dimensions, DPR, quality/shadows, device/browser/backend, refresh
rate, scene revision and visible/resident counts. Start with the existing Mac
environment plus a Windows integrated GPU and another relevant browser; include
mobile only for supported product targets. A native test is supplementary and
must not stand in for browser results.

Use repeated alternating baseline/variant/baseline runs after publication and
shader warmup, with longer samples than the historical four-second probes (for
example, at least three 30-60 second samples per case). Record CPU stage p50/p95,
callback frame-time p50/p95/p99, frames exceeding 16.67/33.3 ms, edit latency,
queue depth, transferred/uploaded bytes and allocated buffer capacity. Measure
GPU timestamps asynchronously where supported. CPU time and GPU pass sums overlap
and must not be added into a claimed displayed-frame duration. Browser callback
cadence is not direct proof of presentation timing.

The automatic distant-terrain FPS guard was removed on 2026-10-24. Benchmark mode
must still fix graphics quality, preserve/restore user
preferences, and verify distant terrain stayed enabled throughout a comparison.
Otherwise a faster later sample might simply be rendering less of the world.

For equivalent-output optimizations, compare fixed images plus moving views and
interaction/collision regressions. For LOD or new representations, define the
permitted screen-space error, thin-feature coverage and transition behavior
before timing. Retain only repeatable improvements larger than observed run
variation, without meaningful p95/p99 or memory regressions. FPS may remain
refresh-capped despite useful CPU headroom; conversely, a higher mean FPS with
worse long frames is not a complete success.

The first implementation batch should contain the diagnostic baseline and the
three P1 CPU experiments as independently switchable changes. Decide on Hi-Z,
mesher replacement or ray tracing only after those results identify the remaining
cost. No percentage or FPS uplift is promised by this research.
