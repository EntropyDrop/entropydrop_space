# Local rendering fixture

Open `/space/app/?world=copper-metropolis&dev_offline=1` on localhost while
running Vite. There is deliberately no navigation link. `main.ts` imports the
fixture only inside `import.meta.env.DEV`; production builds do not contain it.
The fixture also rejects non-loopback hostnames.

This is a deterministic local Copper world, not an authentication bypass. It
has no token, HTTP account/world adapters, WebSocket, or persistent world store.
Edits and inventory changes disappear on reload. Account-backed tools remain
unavailable. Local bundled assets and terrain workers still load normally.

The panel shows frame p50/p95, main-thread CPU p50/p95, Three render calls and
triangles, and independent edit-partition/render-mesh counts. Graphics are fixed
at medium lighting, 100% resolution and shadows disabled. Baseline reloads with
the previous square detailed window and separate micro meshes; Optimized uses
the rectangular window and bounded per-chunk render batches. Both retain WASM.
Use Rotate camera to exercise visibility changes without editing the world.

The fixture measures **near terrain only**; it does not fetch the server's far
surface snapshots, remote players or entities. Its frame rates are not a claim
about the full online world. Keep viewport size and browser visibility unchanged
and wait for initial compilation/warm-up before comparing results.

## Frame diagnostics

See the [September 29 performance and native renderer assessment](PERFORMANCE-2026-09-29.md)
for current CPU/view measurements and a proposed shared native/browser renderer.
See the [GPU drawing follow-up](PERFORMANCE-GPU-2026-09-29.md) for the implemented
submission and fragment optimizations, pixel validation and browser A/B results.
`npm run bench:voxel-view` isolates stationary, rotation, movement and source
installation costs without WebGL, networking or FPS claims.
Add `-- --worker` to measure the actual background worker and paced publication;
the default is the synchronous headless reference. Completion latency is separate
from main-thread frame work. The fixture reports both logical repeated-source
size and unique immutable-source size.

The browser now indexes/selects/packs volumetric LOD in `VoxelLodWorker`.
Source copying is paced at 512 KiB/frame in 256 KiB transferable pieces; output
publication has a 1.25 ms soft CPU budget and a 1 MiB byte target. One indivisible
oversized tile may occupy a frame alone and is counted in `voxelLodWorkStats`.
These are CPU/publication budgets, not GPU timer limits. Worker failure uses the
same planner with cooperative slices. Old terrain remains until replacement is
ready, and rotation only updates culling. The local panel reports backend, pending
sources/tiles, publication count and bytes; it must settle after streaming stops.

Volumetric drawing uses conservative bounds from the selected face extents,
including side walls and ceilings. Bounds account for camera-local torus
correction, and retain the full tile throughout geometry transitions. Fully
replaced tiles skip submission; partially covered tiles keep the original
fragment handoff. Unaffected tiles skip handoff texture sampling,
and settled generations skip transition dithering. Resident geometry and LOD
selection do not change when these drawing optimizations are toggled.

**Compare voxel drawing** runs reference/optimized/reference cases on the same
resident geometry and camera, with the same warm-up, sampling and restoration
rules as the render A/B below. The reference disables the new draw optimizations
but keeps conservative camera-local bound correction in both modes.
**Check voxel pixels** synchronously compares reference, optimized, shader-only,
culling-only and reference-repeat captures without advancing simulation. It
reports RGB differences and repeat noise, and restores
settings. This explicit readback stalls the GPU and is excluded from timing;
it never runs during ordinary rendering or a timed comparison.

Use `?dev_offline=1&world=nature&dev_perf=1` for green nature terrain (generator
version 1), or select `world=aether-archipelago` / `world=copper-metropolis`.
The nature fixture starts at (5377.6, 18, 821.3). It still has **no entities or far
terrain** unless `dev_lod` is added; do not treat it as an online-world benchmark.

In a normal development session, **Settings > Graphics > Performance > Open
Frame Profiler** opens the same panel on the actual loaded world. The module
and entry button are stripped from production builds.

The panel reports CPU frame/stage p50/p95, asynchronous WebGPU timestamp queries (when
supported), drawing-buffer dimensions, and whole-frame calls/triangles including
all Ultra passes. CPU stages are nested, not additive. GPU samples sum every
render pass and are discarded across test boundaries; no synchronous GPU wait is used.
GPU timing samples one in six frames and can be disabled to check its overhead.
GPU time does not include browser compositing or presentation, and CPU timing
does not include other browser tasks outside `Game.animate`.

Temporary switches isolate scene drawing, distant LOD, standard near terrain,
micro terrain, sky and Ultra post-processing. They only hide rendering for the
draw and restore visibility immediately; simulation, streaming and world data
are unchanged. **Run render A/B** holds the current resolution fixed and uses
the selected lighting quality, warms each
case for 1.5 seconds, samples for 4 seconds and repeats the baseline at the end.
It also compares 50% resolution, or 100% if already at 50%. The results label
these conditions. Auto changes resolution only; lighting and effects remain
at the selected quality. Click Play, then Escape before measuring to
exclude the full-screen startup blur. Avoid moving the camera, resizing the window or
running builds during sampling. Hiding the tab cancels the test. Completion,
cancellation and closing the panel restore the original graphics preferences
without writing localStorage. Close removes instrumentation and GPU queries.

Ultra evaluates contact occlusion and sun shafts at half width/height, then
composites them over the original scene using depth-aware AO upsampling. Bloom,
emission masking, fog, grading and FXAA keep their existing resolutions. All
Ultra passes run at every render resolution.

## WebGPU bottleneck investigation (2026-10-03)

Measured on Apple M1 Pro in the desktop in-app browser at a 2560 x 1440 drawing
buffer. Reproduce with a 1280 x 720 viewport and
`?dev_offline=1&world=aether-archipelago&dev_lod=world&dev_perf=1&dev_dpr=2`.
Wait for 153 near chunks and all 128 repeated districts to settle; the fixture
contains 2,089,207 resident far faces. This is a deterministic stress scene, not
an online-world FPS claim. `dev_dpr` is an optional local-fixture override only.

The [original isolation samples](results/webgpu-profile-before-2026-10-03.json)
identify distant terrain as the first priority. With Ultra and shadows enabled:

| Rendering case | Average FPS | CPU p50, ms | GPU sample p50, ms |
| --- | ---: | ---: | ---: |
| Original baseline | 79.9 | 5.9 | 23.46 |
| Hide far terrain | 130.2 | 4.3 | 7.80 |
| Disable shadows | 80.7 | 5.1 | 22.87 |
| Disable Ultra post-processing | 89.8 | 5.4 | 12.71 |
| Half scene width and height | 100.4 | 6.0 | 14.81 |

These isolations overlap and cannot be added. GPU samples sum render passes;
they are not presented-frame latency and can exceed the frame interval. The
Medium baseline was 90.9 FPS; hiding far terrain reached 120.0 FPS and reduced
submitted triangles from 2,567,813 to 337,817. Shadows were already off in that
Medium run, so the Ultra isolation is the meaningful shadow comparison.

The implemented change gives settled, unowned distant tiles an opaque material
without ownership texture reads or fragment discard. Mixed near/far ownership,
authored replacement and incomplete generation fades keep the masked pipeline.
Both active generations are reclassified as coverage changes. Materials remain
shared and are disposed with their ownership texture. Geometry, LOD threshold,
view distance, resolution and shadow settings are unchanged.

[Final A/B measurements](results/webgpu-opaque-terrain-2026-10-03.json) use
OFF / ON / OFF with identical geometry and camera, 1.5 seconds warm-up and
4 seconds sampling per case. The following FPS runs **disable GPU timestamp
queries** to check the improvement without their overhead; shadows are on:

| Quality | Before / repeat FPS | After FPS | Change | Before / after CPU p50 |
| --- | ---: | ---: | ---: | ---: |
| Medium | 89.8 / 89.6 | 103.6 | +15.5% | 5.5–5.7 / 5.2 ms |
| Ultra | 71.9 / 71.8 | 78.6 | +9.4% | 6.2 / 6.1 ms |

An additional Medium run with shadows off and timestamp queries on measured
85.0 / 84.9 FPS before and 97.0 after; GPU sample p50 was 13.24–13.43 ms before
and 8.98 ms after. This GPU reduction must not be called an equivalent end-to-end
speedup. A separate queue-completed test (48 warm-up renders, then 12 batches
of 4 renders, waiting for `onSubmittedWorkDone` after each batch) was noisy:
before/repeat mean 9.58/8.37 ms versus 8.95 ms after. It did **not** establish a
robust throughput improvement. That test excludes simulation and presentation;
the ordinary RAF comparisons above are the evidence for improved average FPS.
The short samples did not establish a consistent improvement in 1% low FPS.

Across-ring checks of the first implementation measured 85.4/86.1 to 88.0 FPS,
with CPU p50 8.6 to 7.6 ms and 884 draw calls. That view is primarily limited by
CPU submission; reducing far draw calls is the next priority there. Covered-face
vertex gating and groups of packed faces were also tried and removed because
their benefit did not justify the extra work and complexity.

Synchronous image comparisons are separate from all timings. The final fixed
near view differs in 43 of 3,686,400 pixels in Medium (max RGB delta 101), and
580 pixels in Ultra (max delta 33); reference repeats differ in zero pixels.
Thus the result is **not bit-identical**, although the inspected capture shows
no missing terrain. Initial across-ring/skyline checks differed in 27/49 pixels.
The [optimized capture](results/webgpu-opaque-terrain-2026-10-03.png) retains the
same geometry and viewing distance. Tests cover incoming/outgoing near coverage,
both geometry generations, authored ownership, culling, streaming and disposal.

Profiler controls: **Compare opaque terrain**, **Check opaque terrain pixels**,
and **Check completed GPU work** expose these distinct measurements. Completion
probes pause the ordinary game loop and restore it in `finally`; neither GPU
waits nor pixel readbacks run in production or ordinary frame sampling.
**Save profiler results** / **Save render PNG** expose local download links;
**Show profiler JSON** is a fallback for browsers that block downloads.

**Compare effect resolution** measures half/full/half secondary resolution with
fixed scene resolution and full effects. It takes about 17 seconds and restores
the original state. The full-resolution case is the new split pipeline's
reference, not a replay of the old combined shader or an online-world benchmark.

Run this workspace's Vite server and open
`/space/app/tools/cinematic-effects-preview.html` for a deterministic visual
comparison of edges, thin geometry, emission and foreground viewmodels. It
reports pixel differences and shader compile errors.
The parent website's Vite server only mounts the app entry, so use the standalone
Space server for this tool page. Neither tool is included in the production app.

`npm run bench:render-maintenance` isolates bookkeeping for 1024 settled batches.
An optional old `SurfaceBatch.ts` path after `--` enables a reference comparison.
This excludes scene traversal, WebGL submission, GPU work and presentation.

## Production WebGPU migration (2026-10-03)

All production 3D renderers now use the WebGPU backend: the main scene, terrain,
characters, tools, particles, shadows, Ultra effects, inventory thumbnails,
skin previews and entity previews. Torus projection, near/far handoff, transitions
and emission use TSL node graphs. The renderer rejects unavailable WebGPU instead
of silently selecting WebGL. DOM UI, the 2D minimap, texture generation and PNG
encoding still use their appropriate DOM/Canvas 2D paths.

WebGPU initialization is asynchronous. Previews wait for their renderer, discard
stale work on unmount, and thumbnails read back through a queued render target.
Shadow quality changes resize the existing shadow target so cached node bindings
remain valid. Shared distant materials use per-object uniforms to avoid compiling
a separate shader graph for every terrain tile. Packed worker attributes are
expanded to WebGPU-compatible vertex strides before upload; the voxel geometry
budget accounts for 32 GPU attribute bytes per directed face.

Open `/space/app/?dev_offline=1&world=aether-archipelago&dev_lod=1&dev_webgpu=1`
and click **Play**, then **Run WebGPU migration checks**. This runs the real scene
at Low, Medium, High, Ultra, Low and Ultra again, waits for submitted GPU work,
checks nonempty frames, and exercises thumbnail readback plus both preview paths.
It also changes resolution while reducing/restoring Ultra effects, ensuring that
skipped passes retain valid texture bindings after target resizing.
It collects runtime exceptions and uncaptured main-device GPU errors. The fixture is local, ephemeral,
and excluded from production bundles. Reload before repeating the checks.

The retained [production smoke report](results/webgpu-production-2026-10-03.json)
passed on an Apple M1 Pro with no captured GPU errors. Shadow targets were
1024/2048/4096 pixels at Medium/High/Ultra; Low releases their allocation to 1x1
after use. The [near scene](results/webgpu-production-2026-10-03.png) and
[cross-ring scene](results/webgpu-production-across-2026-10-03.png) were inspected.
This eight-district offline fixture verifies rendering paths, not full online
performance or pixel-identical output to the previous renderer.

Validation also includes client/engine type checks, the production build and
its development-code exclusion guard, renderer contract tests and packed-attribute
tests. The client suite passes 1008 of 1010 cases. The engine suite passes 455 cases when excluding the existing
`WASM LOD matches JS through camera motion, hysteresis, torus seams, handoff and source replacement`
case: its JS/WASM face-count mismatch was reproduced using the pre-migration
renderer sources. Two unrelated client baseline failures remain: Agent Build's
outdated copy assertion and the wrench hover test's move-X/rotate-Y expectation;
the latter was also reproduced with the pre-migration scene renderer. These are
not reported as passing migration checks.

## Historical WebGPU backend experiment (2026-10-03)

Run the standalone Space Vite server, then open
`/space/app/tools/webgpu-terrain-benchmark.html`. The tool is restricted to local
development and has no imports from the application entry. **Check pixels**
compares three fixed views; **Run comparison** runs two reversed-order rounds of
each view and then captures pixels. **Download results** saves the complete JSON.
The raw [October 3 measurement](results/webgpu-terrain-2026-10-03.json) is retained.
**Run extended comparison** adds the frame, upload and completed-work measurements
below. Open the tool with `?saved=validated` to inspect the retained extended
results without repeating the measurements.

The fixture uses the production voxel generator and LOD planner: Aether seed 42,
generator version 3, district (16,2) repeated over all 128 zones, 64 px^2
subdivision, 160 MiB geometry budget. It retains 2,089,055 directed faces in
2,048 tiles. All three renderers use the same 1280 x 720 buffers, no MSAA, camera
poses, CPU frustum selection, tile granularity and a shared simplified diffuse
lighting formula. The local torus shader matches the engine projection, with
camera-local flattening disabled on all paths. Actual WebGPU backend use is
asserted; silent WebGL fallback is rejected.

This initial suite is a backend experiment, not a port or benchmark of the complete game.
It excludes PBR, emission, sky, shadows, near terrain, transitions, handoff,
post-processing, simulation and networking. LOD remains frozen during the
256 m oscillating movement/full-turn trace, so it does not measure streaming
or movement-triggered repacking. It implements no GPU culling, Hi-Z or indirect
draw generation. The legacy renderer also uses the simplified shader and the
expanded attribute layout; its times are not current production frame costs.

Each case warms for 120 frames and samples 300 frames. GPU timing samples one in
six frames asynchronously, with no waits/readbacks during timed rendering.
CPU time measures `renderer.render`; camera/culling/preparation is separately
recorded. The frame interval includes browser scheduling and is refresh-limited
in many cases. The node renderer adds one fullscreen color-conversion triangle;
reported draw counts include it, while terrain counts are asserted equal on
every frame. Tab hiding/resizing cancels a run. No builds or tests ran during
the retained timed samples.

On Apple M1 Pro, Codex in-app Chromium 154, Three.js r183, the p50 ranges across
the two rounds were:

| View | Legacy WebGL CPU ms | WebGPU CPU ms | Node WebGL2 CPU ms | Legacy / WebGPU GPU ms |
| --- | ---: | ---: | ---: | ---: |
| Near-facing | 1.0-1.1 | 1.8-1.9 | 1.6-1.7 | 3.72-3.93 / 4.52-4.59 |
| Across-ring | 2.5-2.6 | 5.4 | 4.8-4.9 | 2.64-2.96 / 3.21-3.28 |
| Movement + rotation | 1.0 | 1.8-2.0 | 1.7-1.9 | 3.57-3.65 / 4.39-4.72 |

All 18 cases completed, with 50 GPU samples each and no recorded errors. The
cross-ring view submitted 1,162 terrain draws / 703,680 triangles; new-renderer
totals were 1,163 / 703,681 with output conversion. WebGPU did not improve the
median submission/GPU times in this experiment. Near-facing CPU p95 was lower
with WebGPU, so the result is not that every metric always worsens. The node
WebGL2 control also costs more CPU, suggesting renderer/node overhead contributes;
this is not a quantitative decomposition of that overhead. These results do not
predict other devices or gains from a redesigned GPU-driven terrain pipeline.

Mean RGB differences against legacy were 0.0111/255 (near), 0.0767/255 (across)
and 0.0042/255 (motion). At most 0.283% of pixels differed by more than 8/255 in
any channel. Images are close, not bit-identical; large maximum differences at
individual pixels remain. Repeated legacy captures were identical in all views.

An actual porting constraint appeared during validation: three-component RGB8
attributes have a 3-byte stride, rejected by WebGPU. Also, r183 expands
unnormalized 8/16-bit attributes to 32-bit. For the controlled comparison, all
paths explicitly use float offsets/spans/directions and padded RGBA8 colors:
63.75 MiB of instance attributes per backend versus 29.88 MiB of production
packed source attributes. This is one simple compatible layout, not an inherent
WebGPU memory requirement or a measurement of total browser/GPU memory.

The initial CPU submission measurements alone cannot establish overall rendering
performance. The extended measurements below supersede any broad conclusion
that WebGPU is slower: completed-work throughput improves in the near view,
while the across-ring view remains slower with this implementation.

### Extended frame and GPU completion measurements

The [validated extended results](results/webgpu-extended-validated-2026-10-03.json)
contain 40 frame-loop cases (19,320 measured renders, 3,220 asynchronous GPU
samples), followed by a separate completion validation. Hardware and renderer
versions are the same as above. There are no recorded GPU errors or main-thread
tasks above 50 ms in these cases. These are two rounds on one machine, not a
statistical confidence interval or a cross-device comparison.

The frame suite measures 720p, 1440p and 4K buffers, asserted through
`getDrawingBufferSize`, with two reversed backend orders for near, across-ring
and movement views. Each case has 120 warmup frames and 450 measured frames.
Four additional 1440p upload cases have 780 measured frames each. The raw data
contains both animation timestamps and callback wall intervals, full callback
CPU time, render submission time, preparation time, GPU render-pass time,
resource accounting and publication bytes. CPU and GPU overlap: **never add
their durations to infer frame time**. GPU pass queries do not cover every
transfer, compositor operation or display scanout.

FPS is measured animation-loop cadence: interval count divided by elapsed time.
It is not verified screen presentation FPS. This in-app browser schedules most
cases around 120 callbacks/s, occasionally above 120. Refresh/scheduler limits
hide unused rendering capacity. The 1% low is 1000 divided by the mean of the
slowest 1% of intervals; p95 and p99 below are frame intervals. CPU metrics cover
the measured terrain callback, including packing/replacement, preparation,
rendering and instrumentation, not the entire application.

1440p ranges across the two rounds:

| View / backend | Loop FPS | 1% low FPS | Frame p95 / p99 ms | GPU p50 ms |
| --- | ---: | ---: | ---: | ---: |
| Near / WebGL | 120.4-124.2 | 95.2-97.1 | 9.7-10.0 / 10.2-10.4 | 3.78-4.01 |
| Near / WebGPU | 123.6-124.8 | 86.4-96.0 | 9.7-9.8 / 10.2 | 4.59-4.98 |
| Across / WebGL | 122.7-127.3 | 54.5-78.4 | 9.8-13.7 / 10.7-16.0 | 2.73-3.14 |
| Across / WebGPU | 107.3-115.9 | 49.4-57.4 | 13.9-16.1 / 16.7-18.1 | 3.21-3.74 |
| Movement / WebGL | 123.6-124.6 | 87.3-99.2 | 9.7-10.1 / 9.9-10.8 | 3.68-3.83 |
| Movement / WebGPU | 121.5-124.5 | 97.8-98.0 | 9.5-9.8 / 10.1 | 4.59-4.78 |
| Uploads / WebGL | 121.2-123.0 | 78.2-97.4 | 9.9-10.0 / 10.2-10.4 | 3.69-4.07 |
| Uploads / WebGPU | 124.9-126.1 | 74.1-97.6 | 9.8 / 10.2-10.4 | 5.64-5.77 |

The upload trace replays production planner outputs from twelve 16 m steps:
666 tile replacements and 38,474,970 source bytes on each backend. Publication
uses a deterministic 1 MiB source-byte budget per frame (a single larger tile
is allowed), with a new packet every 60 frames. CPU packing/replacement and
GPU buffer uploads occur inside the measured loop. Worker planning is prepared
beforehand and its costs are reported separately; this is not a simultaneous
worker/streaming test. No fades are included. Both backends had two frames above
16.67 ms in the first upload round and none in the second, so the retained runs
do not establish a consistent upload-stutter advantage.

To measure capacity beyond the callback ceiling, the completion validation
performs 32 stationary renders per batch and waits for GPU completion after each
batch: WebGL `fenceSync`/`clientWaitSync` with `flush`, WebGPU
`queue.onSubmittedWorkDone`. After warmup, 24 batches per case and two reversed
orders at 720p/4K produce 12,288 measured renders. This measures amortized wall
time including CPU/GPU overlap and notification overhead. It is **not gameplay
FPS or single-frame latency**; the repeated camera may benefit from reuse and
only the batch's final canvas contents are eligible for presentation. The JSON
also retains an earlier exploratory batch-size-8 run; use `batchSize: 32` for
the validated comparison.

| Resolution / view | WebGL completed ms/render p50 | WebGPU completed ms/render p50 |
| --- | ---: | ---: |
| 720p / near | 3.34-3.37 | 2.57-2.61 |
| 720p / across | 3.82-4.16 | 5.90-6.57 |
| 4K / near | 3.53-3.56 | 2.64-2.65 |
| 4K / across | 3.88-4.43 | 6.14-6.66 |

WebGPU reduces completed-work cost by about 22-26% in the near view in these
runs. The across-ring view regresses in both cadence and completed throughput.
The near view has 220 terrain draws / 2,051,554 triangles; across has 1,162 draws
/ 703,680 triangles. Higher per-draw CPU cost is a plausible contributor to the
across-ring regression, not a proven causal decomposition. Sparse GPU queries
in the paced loop and dense completion batches have different scheduling and
reuse behavior; their absolute durations are not interchangeable. The evidence
supports a workload-dependent result, not a general backend ranking.

All renderer resources stay resident but only the active backend draws. The
memory counters enumerate geometry attributes and nominal color buffers, not
total GPU/browser memory, depth buffers, driver allocations or swapchains.
At 4K the node renderer's additional HDR color buffer alone is nominally
63.28 MiB. Cold startup, peak total memory, energy consumption, actual display
presentation and input-to-photon latency remain unmeasured. Pixel checks remain
at 720p, not all measured resolutions.

A complete game comparison still requires equivalent WebGPU implementations of
PBR/emission, sky, near terrain, transitions/handoff and post-processing, plus
the real simulation and concurrent streaming workloads. These measurements
justify investigating the near-view throughput opportunity and the many-draw
bottleneck; they do not yet justify claiming that replacing the production
renderer improves overall game performance.

## Distant terrain regression

Add `&dev_lod=1`, or use **Test distant terrain**. A local worker generates eight
real districts from the selected world (four around spawn, four across the ring) with the shared
server 3D voxel mesher and seven-level mip ladder. The normal authenticated-byte
decoder, source-demand allocator, IndexedDB cache and renderer are exercised by
a local fetch adapter. There are no account or server requests. This bounded
fixture is not a whole-world performance benchmark.

Use `dev_lod=world` for the complete 128-zone working set. It repeats one real
Aether district at all world coordinates through the normal download allocator;
it tests global geometry/cache pressure without generating or storing 128 copies
of every source mip. The panel explicitly labels this repeated-district fixture.
`npm run bench:voxel-lod` also checks whole-world quality, packed memory, zoom
budgeting, recovery and rotation stability without a browser.

Wait for `8/8 districts` and stable LOD publications, then rotate for at least 20 seconds.
For Copper, **City overview** moves to a fixed aerial view of the actual surrounding
districts. Use `dev_lod=1` to inspect city diversity; the `world` fixture deliberately
repeats one source district and cannot validate the procedural city's layout variety.
The pixel-area selector need not load every far district at 1m resolution.
Source reads and LOD publications should remain fixed; draw counts may change.
Reload: source reads should be zero when IndexedDB is available and warm.
Immutable terrain snapshots may persist in the site's cache; edits and inventory
are still ephemeral. Denied storage falls back to local generation normally.

Resident surface data defaults to 256 MiB (up to 1024 MiB). This is the raw source
budget, not total browser RAM: decoded mips, geometry, transitions and GPU copies
use additional memory. Disk cache is capped at 2 GiB and 20% of browser quota,
with a 512 MiB fallback when quota reporting is unavailable. The default geometry
budget for v7 is 5,242,880 directed faces, with 15 packed worker bytes and
32 uploaded GPU attribute bytes per face.
Graphics > Voxel Geometry Budget exposes 16–512 MiB, defaulting to 160 MiB
with 32 bytes budgeted per face. CPU copies and transition buffers consume
additional memory. Saved geometry budgets remain unchanged; older preferences
without a geometry budget gain the 160 MiB default. The legacy heightfield capacity is
independent of this voxel-only control.
Under pressure the pixel-area threshold is fitted to the budget, with read-only
estimation and a fresh fit on source replacement; power-of-two overshoot and
stale budget pressure must not keep the entire world at an unnecessarily coarse LOD.
Each 512m source zone is drawn in independently culled 128m tiles. Culling a
tile never removes its CPU data or GPU buffers, including during a 180-degree turn.

## Voxy-inspired pixel-area selection

Graphics > Subdivision Size directly controls the projected cell area from
1 to 256 CSS px^2. Larger values reduce far geometry and source-detail demand
while keeping near terrain unchanged. The default is 64 px^2; saved values
are preserved. The slider takes effect immediately and persists through the
existing distant-terrain preference.

The settings panel reports target and actual subdivision thresholds. A 1 px^2
target still permits subpixel LOD; it does not disable simplification. When the
actual value is higher, the panel identifies the geometry budget constraint.
Increasing Voxel Geometry Budget refits selection at a stationary camera too.
Source-detail shortages are reported separately: refinement may still be
loading or constrained by Terrain Detail Cache. Even an actual 1 px^2 geometry
threshold cannot recover details absent from the downloaded source.
`npm run bench:voxel-lod -- --high-detail` additionally checks recovery from
the default geometry cap to a 1 px^2 target with 512 MiB; it deliberately
allocates hundreds of MiB and is opt-in.

Defaults: 64 CSS px^2 subdivision area, 2048 chunks far render distance
(32768 m, covering the finite torus without repetition), and a 16-chunk maximum
near/network AOI radius. Near Z stays capped at six chunks; network Z is 12 to
include movement padding. Detailed online meshes are clipped to the last fully
synchronized AOI, leaving its unsynchronized fringe in far LOD. Legacy pixel-error
and metre-distance preferences migrate to the new defaults, preserving cache size.

The JS and WASM selectors use the same torus-inflated projected box-face area
bound, with 0.65 area hysteresis and a half-pixel residual guard for flat surfaces.
Unlike view-dependent projected AABBs, this conservative estimate depends only
on position and CSS viewport/FOV, so turning or adaptive rendering resolution
does not trigger subdivision/recycling. Frustum culling affects drawing only.

Reference: [Voxy screen-space traversal](https://github.com/MCRcortex/voxy/blob/534d58ec8b4aa412ef314b884295552c69d480a6/src/main/resources/assets/voxy/shaders/lod/hierarchical/screenspace.glsl).
This adapts the screen-area concept, not Voxy's OpenGL 4.6 compute/Hi-Z pipeline.
No Voxy source code is included. Space uses a finer default to preserve its
small floating islands and buildings across the full torus.

This is a DH/Voxy-inspired residency/LOD pipeline, not a port of either mod.
Procedural far terrain uses EDSZ v7 volumetric LOD: six-sided surface quads,
64m bricks and 1/2/4/8/16/32/64m voxel levels. Air below floating islands and
between bridges remains empty. Authored structures retain exact solid proxies.
The progress line reports the zone and completed bricks while generating.

## Aether Archipelago preview

Append `&world=aether-archipelago` to the local `?dev_offline=1` entry to
preview the development floating-island world with its standard and micro blocks.

## Busy-frame near streaming

Add `&dev_stream_busy=1` and click **Move to new chunks** after entry. This moves
256m and simulates a browser that grants no idle time: only explicit timeout
callbacks run, always with a zero remaining budget. The near-detail counter must
return to all chunks ready, including micro meshes, without an edit, another move
or a reload. Combine with `dev_lod=world` to retain full-world distant coverage.
The live scheduler prefers idle time and requests a one-millisecond queue
slice with a 50ms timeout; generation remains in the terrain worker.

The top-left HUD reports ready chunks including micro meshes, followed by
download/upload rates over the last second. **Test 256 KiB/s download** streams
3 MiB over 12 seconds. After the first second, download should remain close to
256 KiB/s during transfer, without a burst at completion, then return to zero.
**Test upload with delayed reply** sends 8 MiB and delays the response by six
seconds: upload must register before the reply and reach zero while waiting.
Both endpoints exist only in the Vite development server and retain no data.

Rates measure application payload, excluding protocol overhead: HTTP download
bytes after decompression, actual XHR upload progress, and WebSocket queue drain.
Browser-cache hits are removed when resource timing exposes cache status;
all-zero cross-origin timing is treated as unavailable, not proof of a cache hit.
Native fetch remains in use for keepalive/unload and unsupported request modes;
their upload progress is unavailable. The game's normal foreground writes use
the progress transport; terrain downloads retain the bounded streaming reader.

## Preserve full far terrain: command reuse (2026-10-03)

A second optimization keeps the preceding opaque material optimization enabled
and reuses WebGPU render bundles for distant terrain. It does not reduce view
distance, LOD precision, resident faces, image resolution, shadows or the number
of executed draws. Unchanged batches reuse encoded commands while camera,
lighting, torus correction and fade uniforms continue updating. Changes to
visibility, generation, material, instance count or GPU buffers invalidate the
bundle. Production enables this through `SpaceRenderer`; other consumers retain
ordinary rendering by default.

Three r183 needs a small adapter: pending opaque bundles execute before
transparent objects, replay counts as executed work in `renderer.info`, and a
bundle is rebuilt when switching render targets or shadow allocations. Shadow
override passes invalidate only their own camera. Array cameras and override
materials use ordinary submission. The adapter is guarded to revision 183;
upgrading Three requires revalidating it before enabling command caching again.

[Final raw measurements](results/webgpu-far-commands-2026-10-03.json) contain
OFF / ON / OFF comparisons at 2560 x 1440, with 2,089,207 resident far faces,
153 near chunks and 128 repeated districts. Settings match the fixture above.
GPU timestamp queries are **off** in this table. Each case warms for 1.5 seconds
and samples ordinary RAF cadence for 4 seconds:

| View / quality | OFF / repeat FPS | ON FPS | OFF / ON CPU p50, ms | Draws / triangles (unchanged) |
| --- | ---: | ---: | ---: | ---: |
| Across ring, Medium | 79.8 / 79.8 | 90.8 | 10.3 / 5.4 | 915 / 1,630,099 |
| Across ring, Ultra | 72.2 / 72.3 | 82.1 | 11.5–11.6 / 5.9 | 930 / 1,630,114 |
| Near terrain, Medium | 104.7 / 103.7 | 102.4 | 5.6–6.3 / 5.1 | 459 / 2,702,893 |
| Near terrain, Ultra | 79.8 / 89.8 | 87.2 | 5.8–6.5 / 5.4 | 474 / 2,702,908 |

Across-ring average FPS improves approximately 14%, and CPU p50 falls 48–49%.
The near view shows **no stable FPS improvement**: Medium is slightly slower in
this short run and Ultra's reference drifts substantially. This is a submission
optimization for views with many batches, not a universal GPU speedup. Short
across-ring samples also improved 1% low FPS from about 39.5–39.8 to 57.3–58.4,
but they do not establish sustained frame pacing during travel or online play.

A separate Medium across-ring run with GPU timestamps enabled measured
80.7 / 79.9 FPS OFF and 91.1 FPS ON. GPU pass sum p50 was 6.29 / 6.82 ms OFF
versus 7.01 ms ON: GPU execution itself did not improve. A queue-completed probe
(48 warm renders, then 12 batches of 4 renders, waiting for
`onSubmittedWorkDone` after each batch) measured mean 11.86 / 11.08 ms OFF
versus 7.53 ms ON. This includes command preparation and GPU completion but
excludes simulation and presentation; it is not GPU-only time or displayed FPS.
CPU and GPU times must not be added.

Final synchronous pixel checks compare an already retained cache, ordinary
submission, newly recorded/replayed commands and a reference repeat. All valid
checks have zero differing pixels, including camera rotation, a 180-degree turn,
Medium/Ultra switching, moving 256 metres to new chunks, and a viewport resize
from 2560 to 2048 pixels wide and back. Transparent planes in front of and behind
terrain also match in Medium and Ultra. One early transparency probe is retained
with `invalidProbe`: its reference repeat changed because the ordinary material
scan bent the diagnostic geometry. Camera-local `torusPreBent` probes fixed that
test fixture; the corrected results are included later in the same JSON.

After movement, all 153 near chunks were ready in 3.4 seconds and the far worker
settled at 2,304,489 faces, with no browser error logs. The
[final Ultra skyline capture](results/webgpu-far-commands-2026-10-03.png) shows the
retained far terrain. This is a local synthetic stress test on M1 Pro, not an
online-world performance guarantee.

Validation: 70 client and 58 engine tests passed, along with both TypeScript
checks, English-only validation and the production build. Tests cover bundle
ordering/statistics, target and shadow invalidation, unsupported paths, pooled
buffer replacement, visibility, terrain transitions, streaming and torus
projection. The production build still excludes all development diagnostics.
Profiler controls **Compare far commands**, **Check far command pixels**,
**Check far transparency**, and **Check completed far commands** reproduce the
separate checks. **Far command cache: toggle** allows movement testing with the
reference implementation.

## Far vertex optimization investigation (2026-10-03)

The next proposed priority was reducing repeated torus vertex transformations.
Three prototypes were implemented and measured, but **none was retained**:
their whole-frame results did not justify enabling them. The previous opaque
material path and far command reuse remain unchanged. This investigation does
not claim another FPS improvement.

[All 27 raw records](results/webgpu-vertex-investigation-2026-10-03.json) include
the rejected cases, reference repeats, GPU timestamps, ordinary RAF cadence,
CPU timings, pixel comparisons and a queue-completed probe. Measurements used
the same local M1 Pro fixture at Medium, 2560 x 1440, with 153 near chunks,
128 repeated districts and 2,089,207 resident far faces. View distance, LOD,
resolution and executed geometry were unchanged. Each RAF case warmed for
1.5 seconds and sampled for 4 seconds; these are short local comparisons,
not a sustained or online-world benchmark.

| Prototype / view | OFF / repeat FPS | ON FPS | Decision |
| --- | ---: | ---: | --- |
| Shared angle texture lookup, near | 101.4 / 99.4 | 95.4 | Rejected: near-view regression |
| Shared angle texture lookup, across ring | 89.2 / 90.4 | 91.4 | Small gain did not offset near regression |
| Static world-space transform, near | 106.5 / 106.9 | 105.7 | No improvement |
| Static world-space transform, across ring | 92.4 / 92.7 | 92.9 | Below 1% |
| Front-to-back batch order, near | 107.3 / 107.2 | 107.9 | Below 1% |
| Front-to-back batch order, across ring | 93.4 / 92.7 | 92.4 | No improvement |
| Static transform final check, across ring, GPU timing off | 93.2 / 93.3 | 91.0 | No whole-frame improvement |

The first six rows had GPU timing enabled once every six frames. The shared
texture replaced angle calculations with two vertex texture loads and needed
about 2.27 MiB of additional GPU storage. Near-view GPU pass-sum p50 increased
from 8.59 / 8.72 ms to 9.24 ms. Static-transform specialization removed identity
matrix work and an unnecessary axis-normal normalization. Its across-ring GPU
pass-sum p50 fell from 6.23 / 6.36 ms to 5.90 ms, but this did not translate into
an FPS improvement when timestamp overhead was removed. Sorting batches by
depth also failed to improve across-ring GPU time.

The static-transform queue-completed probe warmed 48 renders, then measured
12 batches of four renders with `onSubmittedWorkDone`. Mean time was
7.97 / 7.56 ms OFF versus 7.49 ms ON; p50 was 8.025 / 7.50 ms OFF versus
7.675 ms ON. The drifting reference and mixed mean/median result do not
establish a useful throughput gain. This probe includes preparation and GPU
completion, excludes simulation and presentation, and is not displayed FPS.
GPU pass sums and CPU submission times must not be added.

At identical settings, lookup / specialization / sorting changed respectively
2,680 / 37 / 488 of 3,686,400 pixels; their reference repeats changed zero.
These prototypes were therefore not pixel-identical either. No quality
tradeoff was accepted. All experimental production and profiler changes were
restored byte-for-byte from the snapshots taken before this investigation.
The [restored scene capture](results/webgpu-vertex-investigation-2026-10-03.png)
shows the retained full far terrain.

This evidence downgrades torus arithmetic as the next optimization priority
on this fixture. It does not establish the remaining GPU bottleneck; further
work should first isolate vertex-buffer bandwidth, rasterization/fragment
cost and CPU submission before choosing another implementation.

Final checks: both TypeScript checks, English-only validation and
`git diff --check` passed; the restored browser scene reported no error logs.
The broad `npm run check` was stopped during engine tests after 300 passes
(17 cancellations), so it is not reported as a full-suite pass. No production
code from these experiments remains.

## Shared far buffers and fewer draws: experiment (2026-10-03)

**Historical prototype, superseded by the default-on implementation below.**
At this stage it improved distant views but remained disabled by default. `VoxelFaceArena` snapshots settled opaque faces into shared,
read-only storage pages. Each record occupies 32 bytes. A small block map selects
visible runs of 64 faces, reducing hundreds of per-object submissions and uniform
updates to a few page draws. Turning updates the map instead of copying face
records. Existing torus projection, shading, ownership classification, view
distance, resolution, LOD and full-world residency remain in use.

The last block of a source may contain padding. Padding vertices collapse to
degenerate quads, so no detail is removed. Consequently the executed triangle
counter rises slightly: across-ring Medium has 1,630,099 triangles OFF versus
1,678,387 ON, although its actual terrain faces are unchanged. This is not a
geometry reduction benchmark. Masked/fading or changed generations retain
ordinary submission. New, edited, removed or relocated sources cannot silently
reuse stale arena records. Oversized sources also use ordinary submission.

[Raw measurements](results/webgpu-merged-buffers-2026-10-03.json) preserve all
prototype stages, including preliminary runs. The final stage uses explicit
attribute versions rather than Three r183's unconditional DynamicDrawUsage
uploads. Sources are sorted by their original object IDs to preserve ordering
within pages. GPU storage attributes are explicitly released on disposal.

The local M1 Pro fixture uses 2560 x 1440, 153 nearby chunks, 128 repeated
districts and 2,089,207 resident distant faces. The previously validated opaque
path and command cache stay enabled in every comparison. Each case warms for
1.5 seconds and measures 4 seconds of ordinary RAF cadence, in OFF / ON / OFF
order. These short synthetic runs do not predict online-world performance.

| Comparison | OFF / repeat FPS | ON FPS | CPU p50 OFF / ON, ms | Whole-frame calls OFF / ON |
| --- | ---: | ---: | ---: | ---: |
| Final Ultra, across ring, timers off | 79.3 / 79.4 | 104.9 | 6.2 / 3.8 | 930 / 103 |
| Final Medium, repeated camera sweep, timers off | 81.5 / 81.2 | 119.9 | 7.8–7.9 / 4.5 | 1025 / 88 at sweep end |
| Final Medium, across ring, timers on | 91.4 / 104.0 | 120.0 | 5.8–5.9 / 3.4 | 915 / 89 |
| Earlier Medium, near view, timers off | 83.4 / 83.4 | 83.8 | 5.7 / 5.1 | 459 / 284 |
| Earlier Ultra, near view, timers off | 62.0 / 62.1 | 63.3 | 6.6–6.8 / 5.8 | 474 / 299 |

The final rotation test repeats the same 1.2-radian yaw sweep over four seconds,
holding pitch and position fixed. Frame p95 fell from 23.9–24.0 ms to 9.7 ms.
Near-view gains are small; batching is not a universal FPS improvement. Absolute
rates varied between sessions, and the final timestamp-enabled reference drifted
from 91.4 to 104.0 FPS. Therefore the result is expressed with reference repeats,
not a single universal percentage or an uncapped peak-FPS claim.

Final Medium GPU pass-sum p50 was 6.68 / 6.36 ms OFF versus 5.05 ms ON.
An earlier run was 4.33 ms OFF versus 4.59 ms ON, so GPU-only benefit is less
consistent than the CPU submission improvement. The separately measured
queue-completed probe warmed 48 renders, then measured 12 batches of four:
mean 7.80 / 7.25 ms OFF versus 4.26 ms ON. It includes command preparation and
GPU completion, excludes simulation and presentation, and is not displayed FPS.
Do not add CPU and GPU times.

This remains an experiment for two reasons. First, the A/B path retains original
attributes as well as approximately 39–42 MiB of extra GPU arena/map storage, plus
CPU copies. Builds took about 29–35 ms on the main thread, excluding
initial pipeline compilation/upload. It does not automatically repack edited
generations; they safely fall back until the arena is rebuilt by toggling it.
A production implementation should make the arena the primary store, pack/update
it incrementally in the worker and retire unused ranges without a synchronous
full snapshot. Second, images are close but not pixel-identical: one sorted
across-ring check differed by four Medium pixels or one Ultra pixel, all by one
channel level; Ultra near-view differed by 758 / 3,686,400 pixels, maximum channel
delta 43. The reference repeats were identical. This difference needs resolution
before making the feature the default.

Controls in the `dev_perf=1` panel are **Compare merged buffers**,
**Compare merged rotation**, **Merged buffers: toggle**, **Check merged pixels**
and **Check completed merged work**. Pixel checks while ON first capture the
retained arena, then compare ordinary submission and a fresh arena; this checks
that camera changes do not leave an old visibility map on the GPU. The panel
restores the saved view and settings after comparisons.

A retained-arena 180-degree turn differed from the reference by two pixels,
maximum channel delta one. After moving 256 metres, all 153 near chunks were
ready in 2.1 seconds and the far worker settled at 2,304,489 faces without
browser error logs. The retained arena versus ordinary submission differed by
289 pixels (maximum delta 86), and versus a fresh arena by 272 pixels. These
remaining differences are recorded, not treated as pixel-equivalence passes.
The [Ultra scene capture](results/webgpu-merged-buffers-2026-10-03.png) shows the
full far terrain with the experiment enabled after that movement.

Validation: 61 engine and 70 client tests passed, including buffer packing,
partial blocks, visibility-map updates without face copies, stale-source
fallback and storage disposal. Both TypeScript checks, English-only validation,
documentation-link validation and the production build passed. The build
continues to exclude development diagnostics. Normal startup does not enable
or allocate the experimental arena.


## Shared far buffers enabled by default (2026-10-04)

The production WebGPU renderer now enables shared far storage automatically once
its r183 adapter is initialized, including when the world is attached before
renderer initialization finishes. The development switch remains available for
reference comparisons. Unsupported renderer integration contracts retain normal
submission. Full-world residency, distance, subdivision, geometry budget,
resolution, lighting and ownership/fade behavior are unchanged.

The arena is now the primary store for settled opaque faces. Each face packs
losslessly into four unsigned words (16 bytes): local offsets, spans, direction,
emission and RGBA8. Original attributes and renderer caches are retired after a
source is fully copied; fallback reconstructs the original attributes exactly.
Inactive ranges coalesce and empty pages release their CPU/GPU storage. World
teardown discards pages without reconstructing terrain that is being destroyed.
Fading, edited, masked or not-yet-copied sources continue ordinary submission.
New generations migrate automatically without toggling the feature.

Packing is incremental, with a 0.75 ms soft CPU budget, 16,384 faces per update
and 4,096-face copy slices. Allocation, retirement and a slice can overrun the
soft time budget. Measured maximum copy work was 1.1–1.4 ms in the settled-view
comparisons and 2.8 ms while loading after movement (3.0 ms after the next view
change), rather than the prototype's synchronous 29–35 ms snapshot. These values
exclude pipeline compilation, initial GPU uploads and unrelated frame work;
they are not a hard total-frame-time guarantee. Unchanged views reuse the draw
map without scanning/copying the arena each frame.

Two correctness fixes preserve output. Draw runs keep original source order
across unmerged meshes, and shader records preserve local offset plus origin
arithmetic. The WebGPU adapter requests invariant vertex positions for both far
terrain variants, preventing compiler rounding differences at coplanar edges.
The attribute is confined to far terrain; see the
[WGSL invariant definition](https://www.w3.org/TR/WGSL/#invariant-attr).
Native UNORM decoding preserves the original color values.

[Raw final measurements](results/webgpu-merged-production-2026-10-04.json)
contain 21 records, including the movement and capture diagnostics. On the local
M1 Pro, 2560 x 1440, 153 near chunks and 128 repeated far districts, each RAF
comparison uses OFF / ON / OFF repeat, waits for migration to finish, then warms
for at least 1.5 seconds and samples for four seconds. The resident far terrain
contains 2,089,207 faces in all cases. Command caching remains enabled.

| View | OFF / repeat FPS | ON FPS | CPU p50 OFF / ON, ms | Whole-frame calls OFF / ON |
| --- | ---: | ---: | ---: | ---: |
| Ultra near terrain, GPU timer off | 74.3 / 75.6 | 75.5 | 6.8–6.3 / 6.4 | 474 / 360 |
| Ultra across ring, GPU timer off | 72.1 / 71.7 | 91.4 | 6.3 / 3.6 | 930 / 115 |
| Medium repeated yaw sweep, GPU timer off | 78.1 / 78.8 | 119.7 | 9.6–8.0 / 5.2 | 1025 / 103 at sweep end |
| Medium across ring, GPU timer on | 89.3 / 89.6 | 120.0 | 6.7–6.0 / 4.0 | 915 / 95 |

Ultra across-ring FPS improves about 27%; the Medium rotation improves about
53%. Rotation frame p95 falls from 24.9 to 8.8 ms. Near-view FPS remains within
reference variation. These are short synthetic local runs, with an observed
120 Hz cadence ceiling, not a prediction for every world or device. GPU pass-sum
p50 actually increases from 4.85 / 5.18 ms to 6.42 ms in the timestamp-enabled
comparison. The gain is chiefly reduced CPU submission and scheduling overhead,
not a universal reduction in GPU execution. Do not add CPU and GPU measurements.

The separate queue-completed probe warms 48 renders, then measures twelve
batches of four renders with `queue.onSubmittedWorkDone()`: mean 8.14 / 8.24 ms
OFF versus 4.46 ms ON. It measures command preparation through GPU completion
without simulation, presentation or timestamp-query sampling, and is distinct
from displayed RAF FPS and sampled GPU pass sums.

Across-ring allocation is 20.6–21.7 MiB of shared face/map capacity, replacing
38.9–40.0 MiB of logical original attributes for migrated sources. This is no
longer an extra arena retained alongside the original data. Unmerged geometry,
worker source data, fade generations and renderer overhead remain separate.
Byte counters describe storage capacity and retired attributes, not a hardware
measurement of total process VRAM. Padding still emits degenerate quads: Medium
whole-frame triangles are 1,630,099 OFF versus 1,678,387 ON, with unchanged
logical terrain faces.

The four final pixel probes cover Ultra near view, Ultra across ring, Medium
180-degree turn, and Ultra near view after moving 256 metres. Every comparison
of retained arena / OFF / fresh arena / OFF repeat reports **zero changed pixels
and zero maximum channel delta** over 3,686,400 pixels. The asynchronous probe
now waits for the already queued animation callback to stop before capturing
its first reference and waits for incremental migration between cases.

After movement, 153 near chunks became ready in 3.4 seconds and the far layer
settled at 2,304,489 faces. The retained arena grew to 26.8 MiB while replacing
45.9 MiB of source attributes, with no browser error logs. Its pixel comparison
also matches freshly rebuilt storage exactly. The
[final Ultra skyline capture](results/webgpu-merged-production-2026-10-04.png)
shows the complete near and distant scene with merging enabled.

Validation: 29 engine and 60 client tests pass, including lossless restoration,
bounded publication, draw order, changed generations, handoff transitions,
resource retirement, permanent teardown and renderer contract fallback. Both
TypeScript checks, English-only validation, documentation links and production
build pass. The production build excludes the development diagnostic entry.

## Remaining rendering opportunities (2026-10-04)

An exploratory audit found more CPU headroom while retaining the entire far
world. This audit adds measurements and recommendations only. Runtime prototypes
were restored in `finally`; no production renderer change is enabled by this
audit. The [measurement record](results/render-opportunities-2026-10-04.json)
includes reference repeats, cadence, CPU samples, geometry counters and pixel
checks. The baseline was commit `d4748e9` with a clean checkout. Separate near
material changes appeared after measurement and reloaded the fixture; those
changes were preserved and are not attributed to this prototype.

Use the existing Aether fixture with `dev_lod=world&dev_perf=1&dev_dpr=2` and wait
for 153 near chunks, 128 repeated districts, 2,089,207 resident far faces and
settled publication. The measured canvas was 2560 x 1440 in in-app Chromium 154.
Far distance stayed at 2048 chunks (32,768 m), subdivision at 64 CSS px^2,
geometry budget at 160 MiB, and fixed scene resolution at 100%. Command caching
and shared far storage remained enabled. Timing used Medium with shadows and
GPU timestamps off. Adapter metadata was unavailable, so this audit does not
assert a freshly verified GPU model.

The first priority is **static far matrix updates**. After a camera sweep, the
voxel group still contained 2,247 direct children despite submitting only tens
of arena draws. Retired source meshes remain in the scene tree for publication
and culling. Three updates world matrices for invisible objects too, and the
scene's automatic updates propagate `force` through those static children.
Disabling `matrixAutoUpdate` alone does not stop that world-matrix propagation.
CPU sample stacks confirmed this work originates in `Renderer._renderScene`.

A temporary group override recalculated the group's world matrix, compared it
with the previous matrix, and propagated force to children only when that
matrix changed. Each case warmed for 1.5 seconds and sampled `Game.animate` for
four seconds in reference / prototype / reference-repeat order:

| View | Reference / repeat CPU p50, ms | Prototype CPU p50, ms | Reference / prototype / repeat cadence, ms |
| --- | ---: | ---: | ---: |
| Near | 3.6 / 3.6 | 3.0 | 9.71 / 9.65 / 9.66 |
| Across ring | 2.4 / 2.7 | 2.1 | 9.29 / 9.78 / 9.64 |
| Repeated 1.2-radian yaw sweep | 5.6 / 5.6 | 4.9 | 9.61 / 9.56 / 9.66 |

An earlier across-ring run measured CPU p50 2.7 / 2.8 ms versus 2.2 ms, with
cadence 8.21 / 8.16 / 8.26 ms. The consistent CPU reduction is about 0.3-0.7 ms;
**there is no established stable FPS improvement**. Near geometry stayed at
313 calls / 2,580,517 triangles, and across at 81 / 1,543,307. Resident faces
and graphics settings were identical. The yaw trace uses wall-time sampling,
so its last frame can have slightly different visibility and padding counts;
those endpoint counters are retained in the record. CPU excludes other browser
tasks and GPU completion. Cadence is callback scheduling, not verified display
presentation. Profiling and synchronous pixel readbacks were separate from the
timed cases.

Fixed near and across-ring RGB comparisons at both Medium and Ultra each
reported zero changed pixels and zero maximum channel delta over 3,686,400
pixels; the reference repeat also matched exactly. Simulation was suspended
only after the already queued callback drained. These four probes validate
the loaded fixed views, not every transform or publication path. A production
implementation must handle initial/new children under transformed parents,
reparenting, local-matrix changes, explicit force requests, manually managed
world matrices and `updateWorldMatrix`, plus streaming, handoff and teardown.
Globally freezing the scene would be an unsafe shortcut.

The second priority is **visibility-only arena maintenance**. LOD view work
rose from about 0.1 ms stationary to 2.7 ms during rotation while sources and
resident geometry stayed settled. `VoxelFaceArena.sync` rebuilds/sorts its source
list, checks entries and recounts residency before testing whether the draw map
changed. Map construction also allocates an eight-value array for every block.
Keep source order and residency accounting until membership/attributes change;
handle visibility in a separate pass with reusable storage and update only
changed map ranges. This is a code-supported candidate, not a measured speedup;
the whole LOD stage includes culling and material classification as well as the
arena. Preserve draw ordering, fade fallback and source restoration.

The third priority is **repeated exact aim queries**. Picking remained around
0.5 ms per frame in these stationary, entity-free views. A query cache could
reuse results when the bent ray, terrain publication, entity poses and tool
policy are all unchanged. Camera motion, terrain edits, entity motion and view
correction must invalidate it; lowering query frequency would change interaction
behavior. This opportunity is smaller and is not yet benchmarked.

Further GPU work still needs separate evidence. Previous torus-arithmetic
prototypes did not produce reliable whole-frame gains, and the matrix experiment
does not reduce executed geometry or shading. Conservative occlusion/cluster
selection could preserve visible distant terrain, but its payoff and correctness
are unmeasured here. Start with the confirmed matrix CPU waste, then measure
visibility maintenance before expanding the rendering architecture.
