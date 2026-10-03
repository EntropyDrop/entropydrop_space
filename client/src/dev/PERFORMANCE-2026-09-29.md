# Far-terrain performance and native renderer decision

Initially inspected revision `8167325` on 2026-09-29. The investigation below
records that baseline. The subsequent implementation and measurements are in
the follow-up section at the end; that change fixes browser LOD preparation.
Native rendering remains a future prototype, not part of this patch.

## Current findings

There are two different workloads: drawing resident geometry every frame, and
reselecting/repacking geometry when the view or sources change. The latter can
already exceed an entire frame budget before any GPU drawing occurs.

`DistantVoxelLayer.updateView` synchronously invokes `fitBudget` and `select`
after 8 m of camera displacement, a sufficient focal-length change, or a
settings/budget change. `fitBudget` scans all zones, potentially several times.
`select` builds maps/signature strings, allocates packed attribute arrays and
copies every face in affected tiles. `SurfaceBatch.submit` then compares and
copies attributes into render buffers. This volumetric selection/publication
path is JavaScript even though many generation/meshing kernels already use WASM.

`DistantVoxelLayer.install` indexes every mip's faces, fits the global budget
and visits all zones synchronously. The normal rendering path reaches these
operations through `DistantSurfaceLayer`, on the browser main thread. Background
generation alone does not make this publication work asynchronous.

Visibility uses CPU frustum/distance tests on 128 m tiles. There is no Hi-Z
occlusion traversal or GPU-generated indirect draw list in this path. Each
resident tile uses Three meshes and materials; fades can draw two generations.
The face cap controls resident geometry, not visible triangles or frame time.
Increasing it can increase memory, uploads and drawing work.

## New CPU measurement

Run from the workspace root:

```sh
npm run bench:voxel-view
# Optional: subdivision area in CSS px^2, then geometry budget in MiB.
npm run bench:voxel-view -- 16 160
```

Apple M1 Pro, Node v24.11.1. One generated Aether district is repeated over all
128 zones, with all source mip levels resident. Camera starts at flat
(8192, 180, 1024), 75 degree FOV, 720 CSS-pixel height. Requested subdivision is
64 px^2 and geometry budget is 160 MiB, matching current defaults. The initial
selection has 2,089,055 resident faces; the motion sequence ends at 2,314,908.
This is a synthetic full-world stress fixture, not a seed-exact online world.

The table is from a run with the diagnostic browser tab navigated to blank and
without concurrent builds/tests. Generation and fade waits are outside timed
operations. The benchmark allows fades to finish between 16 m steps, so it
does not reproduce continuous fast-flight transition pressure.

| Operation | Samples | CPU p50 ms | CPU p95 ms | Maximum ms |
| --- | ---: | ---: | ---: | ---: |
| Initial full view selection | 1 | 130.322 | 130.322 | 130.322 |
| Stationary maintenance | 240 | 0.042 | 0.047 | 0.183 |
| Rotation only | 120 | 0.115 | 0.159 | 1.072 |
| Move 16 m, triggering reselection | 24 | 22.979 | 34.100 | 34.755 |
| Reinstall identical nearby source | 5 | 91.644 | 103.200 | 103.200 |
| Stationary after motion | 240 | 0.035 | 0.051 | 1.549 |

Motion produced 1,487 changed batch submissions and processed 6,138,690 source
faces over 24 updates. These are CPU `SurfaceBatch.submit` calls, not WebGL
draw calls. Reinstalling the identical source produced zero changed submissions,
but still paid indexing/selection/packing costs. This intentionally exercises the
lower-level installation API; it does not establish that network deduplication
allows identical snapshots through in ordinary gameplay.

At 60 Hz a frame interval is 16.67 ms; at 120 Hz it is 8.33 ms. A synchronous
23-34 ms update is therefore a credible movement-hitch mechanism. These are
individual CPU operations, not measured browser frame times or an FPS prediction.
Stationary and rotation assertions verify that neither repacks resident geometry.
Absolute times vary with power state and background applications.

## Current browser control

URL: `/space/app/?dev_offline=1&world=nature&dev_lod=world&dev_perf=1`.
Codex in-app browser, current development sources, fixed camera at
(5377.6, 18, 821.3), 2560 x 1440 drawing buffer, Medium lighting, 100% scale,
shadows off. Play was clicked and the pointer released before sampling.
153 near chunks; 128 repeated Nature districts; 10 fine sources;
1,027,311 resident far faces; 64 px^2 subdivision. No entities, online network
traffic or active build/Node benchmark. Cached sources reported zero reads;
LOD publications stayed at 64 throughout the suite.

The existing profiler warms each case for 1.5 s and samples for 4 s, with GPU
queries on one in six frames. CPU stages are nested; GPU timing excludes
compositing/presentation. The displayed FPS can vary slightly above nominal
refresh cadence. This is a development fixture, not an online-world claim.

| Case | FPS | CPU p50 / p95 ms | GPU p50 ms | Calls | Submitted triangles |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline | 122.3 | 3.00 / 3.40 | 2.72 | 354 | 1,120,532 |
| No drawing | 120.8 | 1.10 / 1.70 | 0.66 | 0 | 0 |
| No far terrain | 123.1 | 2.10 / 2.50 | 1.38 | 127 | 189,796 |
| Baseline repeat | 120.5 | 2.90 / 3.30 | 3.48 | 354 | 1,120,532 |

Far terrain adds 227 calls and 930,736 submitted triangles in this view.
The default stationary fixture can sustain approximately 120 Hz; browser
execution alone is not evidence of an unavoidable low frame-rate ceiling.
Baseline GPU p50 changed from 2.72 to 3.48 ms on repeat, and GPU timing in
other isolation cases was also noisy; do not assume every case provides a
clean additive cost decomposition. All nine cases completed and the UI
confirmed that the original settings were restored.

The September 27 online capture had 1,068 calls and about 3.86 million triangles,
with far terrain contributing about 85% of them. It used different settings,
an online world and older effects code. September 28 reduced AO/shaft resolution
and stationary maintenance. Those old frame rates must not be presented as
current results, or compared with this different fixture as a measured speedup.
See [September 27](PERFORMANCE-2026-09-27.md) and
[September 28](PERFORMANCE-2026-09-28.md).

## Why Voxy differs

Voxy's far view represents terrain at multiple levels of detail; a large visual
distance does not mean full-detail simulation of every distant Minecraft chunk.
Its upstream implementation uses a compute shader for hierarchical traversal,
a hierarchical depth buffer for visibility and screen-area criteria for LOD.
The section backend builds draw commands on the GPU and calls
`glMultiDrawElementsIndirectCountARB`. Java orchestrates this GPU pipeline.
The distinction relevant here is the amount and placement of work, not simply
Java versus TypeScript.

Primary references inspected:

- [Voxy traversal](https://github.com/MCRcortex/voxy/blob/dev/src/main/java/me/cortex/voxy/client/core/rendering/hierachical/HierarchicalOcclusionTraverser.java)
- [Voxy section renderer](https://github.com/MCRcortex/voxy/blob/dev/src/main/java/me/cortex/voxy/client/core/rendering/section/backend/mdic/MDICSectionRenderer.java)
- [Voxy screen-area shader](https://github.com/MCRcortex/voxy/blob/dev/src/main/resources/assets/voxy/shaders/lod/hierarchical/screenspace.glsl)

Space already has greedy faces, mip levels, compact attributes, residency and
rotation-stable selection. It has adopted the screen-area idea, not the entire
Voxy GPU pipeline. Space's torus and visible opposite wall also change occlusion
opportunities; measure conservative bent-space occlusion instead of assuming a
Minecraft-like ground horizon. No Voxy source has been copied.

## Native options

| Option | Actual change | Assessment |
| --- | --- | --- |
| Electron/Tauri packaging | Desktop shell around web rendering | Useful distribution/runtime control; does not remove current selection, Three traversal or GPU work |
| Additional WASM kernels | Faster CPU operations with a host interface | Useful after profiling; does not independently reduce drawing or GPU pixel cost |
| Rust + wgpu renderer | A new render core with native and browser targets | Appropriate prototype for shared GPU-driven terrain; requires substantial renderer work |
| Whole application rewrite | Rendering, interaction, simulation, UI and platform ports | Too broad for the current evidence |

[Electron's process model](https://www.electronjs.org/docs/latest/tutorial/process-model)
uses Chromium renderers; [Tauri](https://v2.tauri.app/concept/architecture/) uses a
WebView. Packaging the existing application does not compile its Three renderer
into a native Metal renderer. Browser analysis is already possible with the
existing GPU timers and [Chrome Performance tooling](https://developer.chrome.com/docs/devtools/performance/reference).

[wgpu](https://docs.rs/wgpu/latest/wgpu/) supports native Metal/Vulkan/D3D12 and
browser WebGPU through WASM. A native viewer can use
[Apple's GPU profiling tools](https://developer.apple.com/documentation/xcode/optimizing-gpu-performance)
on Metal. This would profile the new viewer, not retroactively explain the old
browser application's scheduling. Compare matching data, algorithms and camera
traces to distinguish architecture gains from platform gains.

Develop the browser target from the first prototype. Do not depend on native-only
features and promise a later automatic migration. In the inspected wgpu docs,
[`MULTI_DRAW_INDIRECT_COUNT`](https://docs.rs/wgpu/latest/wgpu/struct.Features.html#associatedconstant.MULTI_DRAW_INDIRECT_COUNT)
is native-only and listed for DX12/Vulkan, not a portable Metal/WebGPU baseline.
Use capability checks. A portable design can compact visible quad references
on the GPU and issue a bounded set of indirect instanced draws per material/page.
Shader representation, storage alignment, buffer sizes and fallback behavior
must fit the actual browser adapter limits.

## Proposed sequence and acceptance gates

1. Fix the current synchronous LOD path first: pre-index sources off-thread,
   compute affected brick selections incrementally, coalesce newer view requests,
   and move packing to a worker. Preserve generation/revision cancellation and
   old coverage until replacement geometry is ready. Budget main-thread
   publication by bytes and elapsed time, including delayed GPU upload cost.
   Aim initially for p95 publication under 2 ms; this is a target, not a result.
2. Benchmark stationary, 180-degree turns, continuous motion, source arrival
   and edits using the same camera trace. Capture p50/p95/p99 frame time,
   worst long task, upload bytes, resident/visible faces, submissions and memory.
   Separate cold/warm cache and production-like/profiling builds. Preserve
   subdivision quality and resolution when comparing architectures.
3. Build a small Rust/wgpu terrain viewer from existing snapshot bytes, sharing
   camera/torus math, packed geometry and WGSL between a native window and a
   browser canvas. Start with equivalent rendering; add GPU frustum selection,
   conservative Hi-Z and compacted indirect drawing as separate measured steps.
   Keep React, networking and simulation outside this first prototype.
4. Migrate the browser scene renderer only if measurements justify it. Near and
   far geometry need a common depth/lighting/handoff strategy. A separate WebGPU
   canvas cannot simply share the current Three/WebGL depth target. Port the
   necessary scene passes to one compatible backend; retain UI and world formats.

Acceptance requires correct torus coverage, no holes during rapid turns/source
replacement, stable edits and transitions, matched image quality, bounded memory,
and a useful improvement to frame-time tails. A native executable or a lower
draw-call count alone does not establish success.

## Validation performed

- CPU diagnostic completed, including stationary/rotation residency assertions.
- Engine TypeScript check passed.
- English-only text check, documentation-link check and diff whitespace check passed.
- Browser render-isolation controls exercised on current sources.
- Runtime rendering code was not modified; no full application rewrite, native
  build, or production deployment was performed.

## Follow-up implementation: background LOD and paced publication

`VoxelLodPlanner` now owns source indexing, global budget fitting, brick
selection and tile packing. Browser clients use `VoxelLodWorker`; the synchronous
path remains available for headless reference tests. If a worker cannot start or
fails, the same generator-based planner runs in cooperative 1 ms slices instead
of returning to a synchronous world rebuild. Sources retain their original arrays
on the main thread; 256 KiB transferable copies, capped at 512 KiB per frame,
avoid a large synchronous structured clone. Identical immutable source arrays
can share a worker copy and their relative brick index.

Only one output packet may await publication. The worker waits for an
acknowledgement, so it cannot flood the main-thread event queue with meshes.
Camera changes coalesce behind the active build; source tokens reject outdated
results after replacement, removal or remove/reinstall. A pending first source
does not claim far-terrain handoff coverage. Existing terrain remains present
through preparation and is replaced using the existing complementary fade.

`SurfaceBatch.submitPrepared` adopts the packed attributes directly. It avoids
the second full comparison/copy and defers further replacements while a fade is
active, preventing a hidden third generation from later uploading outside the
publication budget. Publication uses a 1.25 ms soft CPU deadline and 1 MiB byte
target per frame. An indivisible oversized tile can run alone; this is exposed
in diagnostics rather than silently starving. GPU driver time and first upload
of culled geometry remain separate costs, so these are not hard GPU limits.

Disabling distant terrain or removing all its sources terminates its worker;
reenabling reconstructs preparation from current sources while retaining the
last valid geometry. The development panel now reports worker/fallback backend,
pending work, publication counts, and per-frame CPU/byte figures.

### CPU result

```sh
npm run bench:voxel-view -- --worker
```

Same M1 Pro, Node version, 128 repeated Aether zones, 64 px^2, 160 MiB budget,
camera path and 24 movement steps as the baseline. No browser rendering or
concurrent build/test process during this run. Sources are 1,480.43 MiB logically
when repeated, but only 11.57 MiB of unique immutable mip data. Source aliases
preserve this sharing in the worker; this synthetic fixture does not demonstrate
memory consumption for 128 different full-resolution zones.

| Measured main-thread operation | Baseline p50 / p95 ms | Worker p50 / p95 ms |
| --- | ---: | ---: |
| Initial view request | 130.322 / single sample | 0.391 / single sample |
| Stationary maintenance | 0.042 / 0.047 | 0.013 / 0.015 |
| Rotation only | 0.115 / 0.159 | 0.172 / 0.257 |
| Move 16 m trigger | 22.979 / 34.100 | 0.611 / 2.075 |
| Reinstall same immutable source | 91.644 / 103.200 | 0.047 / 0.062 |

The request duration alone is not the whole cost. Across all 279 main-thread
updates used to finish the 24 movement requests, CPU p50/p95 was 0.454/1.929 ms,
with a 9.152 ms maximum. Completion latency was 184.634 ms median / 235.256 ms
p95, excluding the following fade wait. Existing geometry remains visible during
this latency. First full-world preparation completed in 3.315 s over 171 updates;
those updates had 5.302 ms p95 and an 11.699 ms maximum. Cold allocation and
individual publication work can exceed the soft deadline.

Quality was unchanged: 2,089,055 faces initially, 2,314,908 at the last camera
position, and exactly 1,487 changed tiles / 6,138,690 packed faces during motion,
matching the original benchmark. The independent whole-world quality benchmark
also retained 4,183,595 faces at the historical 64 MiB cap with an effective
23 px^2 threshold. Turning caused no geometry publications. These results show
less main-thread blocking, not reduced total work or a promised FPS increase.

### Follow-up validation

Browser verification used the same local 128-district Nature fixture at
2560 x 1440, Medium, 64 px^2, with no concurrent builds or benchmarks. The real
worker reached `settled`, with no queued sources or tiles. The initial settled
view retained exactly 354 calls, 1,120,532 submitted triangles and 1,027,311
resident faces, matching the earlier browser control. Cadence remained around
120 Hz; the purpose of this patch is reducing stalls, not increasing this
already refresh-limited stationary rate.

Continuous rotation for more than a minute left worker publications fixed at
3,552 and source reads at zero. A 256 m move reached all 153 near chunks ready
in 1.1 s; the far worker subsequently settled at 3,771 publications and 1,102,825
faces. Culling/skyline changes did not trigger new geometry. Visual checks showed
continuous near terrain and a connected distant ring. No worker or WebGL errors
were logged; the existing Clock deprecation and pointer-lock warnings appeared.
The across-ring view increased drawing to 763 calls / about 1.41 million
triangles and showed about 101 FPS in one sample, reinforcing that drawing cost
still depends on view direction. This is not an online-world FPS comparison.

- 61 targeted tests passed, including real worker and cooperative output parity,
  source-buffer ownership, quality/budget recovery, source aliasing, byte pacing,
  empty-tile removal, stale revisions, remove/reinstall, movement coalescing,
  worker failures, transitions, handoffs and offline entry.
- Client and engine TypeScript checks passed.
- Whole-world LOD quality/residency benchmark passed.
- Production build passed and includes the worker bundle; development-only entry
  remains excluded. Existing large-chunk warnings remain.
- This is a local browser rendering fix; the native prototype and production
  deployment have not been performed.
