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

Use `?dev_offline=1&world=nature&dev_perf=1` for green nature terrain (generator
version 1), or select `world=aether-archipelago` / `world=copper-metropolis`.
The nature fixture starts at (5377.6, 18, 821.3). It still has **no entities or far
terrain** unless `dev_lod` is added; do not treat it as an online-world benchmark.

In a normal development session, **Settings > Graphics > Performance > Open
Frame Profiler** opens the same panel on the actual loaded world. The module
and entry button are stripped from production builds.

The panel reports CPU frame/stage p50/p95, asynchronous GPU timer queries (when
supported), drawing-buffer dimensions, and whole-frame calls/triangles including
all Ultra passes. CPU stages are nested, not additive. GPU samples are discarded
on disjoint events and across test boundaries; no synchronous GPU wait is used.
GPU timing samples one in six frames and can be disabled to check its overhead.
GPU time does not include browser compositing or presentation, and CPU timing
does not include other browser tasks outside `Game.animate`.

Temporary switches isolate scene drawing, distant LOD, standard near terrain,
micro terrain, sky and Ultra post-processing. They only hide rendering for the
draw and restore visibility immediately; simulation, streaming and world data
are unchanged. **Run render A/B** holds the current resolution fixed and uses
full effects (fixed mode disables Auto's effect degradation), warms each
case for 1.5 seconds, samples for 4 seconds and repeats the baseline at the end.
It also compares 50% resolution, or 100% if already at 50%. The results label
these conditions; do not compare this full-effects baseline directly with an
Auto/reduced-effects baseline. Click Play, then Escape before measuring to
exclude the full-screen startup blur. Avoid moving the camera, resizing the window or
running builds during sampling. Hiding the tab cancels the test. Completion,
cancellation and closing the panel restore the original graphics preferences
without writing localStorage. Close removes instrumentation and GPU queries.

Ultra evaluates contact occlusion and sun shafts at half width/height, then
composites them over the original scene using depth-aware AO upsampling. Bloom,
emission masking, fog, grading and FXAA keep their existing resolutions. Auto's
reduced-effects mode skips the secondary pass entirely.

**Compare effect resolution** measures half/full/half secondary resolution with
fixed scene resolution and full effects. It takes about 17 seconds and restores
the original state. The full-resolution case is the new split pipeline's
reference, not a replay of the old combined shader or an online-world benchmark.

Run this workspace's Vite server and open
`/space/app/tools/cinematic-effects-preview.html` for a deterministic visual
comparison of edges, thin geometry, emission and foreground viewmodels. It also
checks reduced effects and reports pixel differences and shader compile errors.
The parent website's Vite server only mounts the app entry, so use the standalone
Space server for this tool page. Neither tool is included in the production app.

`npm run bench:render-maintenance` isolates bookkeeping for 1024 settled batches.
An optional old `SurfaceBatch.ts` path after `--` enables a reference comparison.
This excludes scene traversal, WebGL submission, GPU work and presentation.

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
The pixel-area selector need not load every far district at 1m resolution.
Source reads and LOD publications should remain fixed; draw counts may change.
Reload: source reads should be zero when IndexedDB is available and warm.
Immutable terrain snapshots may persist in the site's cache; edits and inventory
are still ephemeral. Denied storage falls back to local generation normally.

Resident surface data defaults to 256 MiB (up to 1024 MiB). This is the raw source
budget, not total browser RAM: decoded mips, geometry, transitions and GPU copies
use additional memory. Disk cache is capped at 2 GiB and 20% of browser quota,
with a 512 MiB fallback when quota reporting is unavailable. The default geometry
budget for v7 is 10,485,760 directed faces, at 15 packed attribute bytes per face.
Graphics > Voxel Geometry Budget exposes 16–512 MiB, defaulting to 160 MiB
with 16 bytes budgeted per face. CPU/GPU copies and transition buffers consume
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
