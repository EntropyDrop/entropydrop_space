# Ultra effect resolution and stationary terrain maintenance

## Changes

Contact occlusion and sun shafts now render at half width and half height into
a separate half-float target. A four-tap, depth-aware gather upsamples AO;
shafts use bilinear weights. Scene color, emission coverage, foreground masking,
haze, grading, bloom and FXAA retain their existing resolutions and ordering.
Logarithmic view depth avoids losing distant depth precision in the half-float
effect buffer. Reduced Auto effects skip the secondary draw entirely.

This cuts the expensive secondary shader's pixel count by 75%, with one extra
draw and at most about 7 MiB of additional target storage at the existing
2560 x 1440 scene cap. It does not cut total GPU cost by 75%.

Stationary far terrain reuses culling results. Camera motion, rotation, distance
changes and voxel source arrivals invalidate them. Fades still advance; idle
transition buffers are collected on their expiry instead of scanning every
slot every frame. Unchanged visibility is not rewritten, empty generation meshes
are omitted from scene traversal, and static terrain meshes skip local matrix
recomposition. The voxel layer shares a timestamp across batches.

Draw-call count, tile bounds, geometry budgets and resident LOD quality remain
unchanged. Larger tiles would trade fewer submissions for more offscreen
geometry, so this change retains the existing independent 128m culling units.
The far Standard material remains: its parameters deliberately match near
terrain to prevent a visible lighting seam. Neither measurement justified
replacing Three.js or changing the material response in this patch.

## Browser GPU comparison

Codex in-app browser, deterministic Nature near-terrain fixture, seed 42,
position (5377.6, 18, 821.3), fixed camera, 153 chunks, no entities or distant
data, Ultra full effects, shadows off, 100% scene scale, drawing buffer
2560 x 1440. Play was activated and the startup overlay removed.
No builds or Node benchmarks were running during these samples.

`Compare effect resolution` warms for 1.5 seconds and samples for 4 seconds
per case; asynchronous GPU timing samples one in six frames. The full-resolution
reference uses the new split pipeline, not the previous combined shader.

| Secondary scale | FPS | CPU p50 / p95 (ms) | GPU p50 (ms) | Calls | Triangles |
| --- | ---: | ---: | ---: | ---: | ---: |
| 50% | 109.1 | 1.40 / 1.80 | 9.26 | 144 | 189,813 |
| 100% reference | 87.3 | 1.60 / 2.00 | 13.46 | 144 | 189,813 |
| 50% repeat | 108.7 | 1.40 / 1.80 | 9.43 | 144 | 189,813 |

GPU time falls by about 30-31% against this reference. These are local fixture
measurements, not a promised online-world FPS improvement or a direct
before/after comparison with the September 27 Chrome capture.

## Visual and terrain checks

`tools/cinematic-effects-preview.html` renders the same 1280 x 720 scene with
half/full secondary resolution, including thin posts, contact edges, sun rays,
red/blue emissive blocks and a foreground white viewmodel. Shader errors: zero.
Mean RGB difference: 0.162/255. Maximum channel difference: 36/255.
Pixels with a channel difference above 8/255: 0.13%. Visual inspection found
no obvious edge halos or viewmodel darkening. Reduced-effects output was
pixel-identical for both secondary resolutions.

The eight-district Nature fixture loaded 8/8 districts and was rotated
continuously. Source reads stayed at 16, LOD publications at 9, and resident
faces at 77,116. Draw counts changed with view direction; no render errors
were logged. The separate whole-world repeated-district benchmark passed:
4,183,595 faces, 59.85 MiB packed attributes and an effective 23 px^2 threshold,
including zoom-budget recovery and rotation-residency assertions.

The optional old-source comparison in `bench:render-maintenance` measured
1024 settled batches at 0.0350 ms/frame before and 0.0038 ms/frame after.
This tiny synthetic CPU bookkeeping result excludes scene traversal, WebGL
submission, GPU time and browser presentation; do not extrapolate it to FPS.

## Validation and existing failures

- Client and engine TypeScript checks passed.
- Production build passed; development fixtures and profiler stay excluded.
- Targeted cinematic, terrain-transition, stationary-culling, source-arrival,
  remote-snapshot and lighting regressions passed.
- Full engine run: 424 passed; the render-kernels test process failed. The
  remaining two subdivision/connection cases passed when run separately.
- Full client run: 1000 passed, 2 failed.

All three underlying failures were reproduced against an isolated checkout of
the unchanged HEAD sources:

1. `WASM LOD matches JS`: generated arrays differ. The original assertion
   produces an enormous diff and the process was killed with SIGKILL. A
   temporary diagnostic comparing array lengths and SHA-256 digests instead
   reproduced the mismatch in about two seconds; all 385 diff lines were
   identical between HEAD and this change. The diagnostic was removed.
2. `Agent Build distinguishes full-access Space credentials from model API keys`:
   its expected literal no longer matches the existing authorization copy.
3. `Wrench COM gizmo exposes three translation and three rotation handles`:
   an existing pick returns `rotate-y` where the test expects `move-x`.

These unrelated failures were left unchanged. Consequently the aggregate
`npm run check` is not green, despite the rendering-specific checks and build
passing.

## Historical preset comparison (removed from the settings UI)

A prior UI revision exposed Low (256 px^2), Balanced (64 px^2), High
(16 px^2), and Ultra (4 px^2). The threshold controls projected terrain-cell
area before subdivision; it changes far geometry and source-detail demand,
not the scene render target's pixel resolution. Balanced is the new default.
Existing saved values, including the previous 16 px^2 default and custom
values, remain intact. Custom subdivision control remains available.
Near terrain AOI, scene resolution, far render distance and cache budget are
independent of the preset.

The whole-world repeated-district voxel benchmark retains its original High
quality assertions, then compares resident geometry under lower detail:

| Preset | Requested threshold | Resident faces | Reduction from High |
| --- | ---: | ---: | ---: |
| High | 16 px^2 | 4,183,595 | — |
| Balanced | 64 px^2 | 2,795,391 | 33.2% |
| Low | 256 px^2 | 1,065,130 | 74.5% |

High's effective threshold is 23 px^2 after the existing face budget is
applied. These counts measure resident geometry, not GPU time, visible
triangle count or online FPS.

Browser verification in the eight-district Nature fixture confirmed immediate
High/Low/Balanced application, custom-control values, and Low persistence
after reload. Near AOI stayed at 8 and scene resolution at 100%. The local
development diagnostics panel overlaps the Low button at this viewport;
clicking the exposed right side works. The panel is excluded from production.
All 53 targeted settings, distant-surface, terrain-motion and voxel-surface
tests passed, as did both TypeScript checks, the English check, the voxel LOD
benchmark and the production build.

## Follow-up: expose the quality cap at 1 px^2

The whole-world fixture reproduced the reported issue: targets of 16, 4 and
1 px^2 all fitted to approximately 23 px^2 under the fixed 4,194,304-face cap.
Moving the detail slider alone therefore could not improve those silhouettes.
At that stage Graphics exposed Voxel Geometry Budget (16–512 MiB; default 64) and a live
target/actual threshold readout. Geometry pressure and districts needing finer
source data are reported separately. The control is persisted independently
of source cache, near AOI and scene resolution. Legacy heightfields retain
their existing independent capacity limit, identified by the status message.

`npm run bench:voxel-lod -- --high-detail` passed with the same stationary camera:

| Target | Geometry budget | Actual threshold | Resident faces |
| --- | ---: | ---: | ---: |
| 1 px^2 | 64 MiB | 23 px^2 | 4,183,595 |
| 1 px^2 | 512 MiB | 1 px^2 | 26,677,008 |

The expanded geometry contains 381.62 MiB of packed attributes, before CPU/GPU
copies and fade buffers, so this is a quality/performance tradeoff, not a free
GPU optimization. Default allocation policy remains unchanged. A 1 px^2
target still allows subpixel simplification and is limited by source detail.

All 55 targeted settings, voxel, distant-surface and motion tests passed,
including a budget-only update publishing finer geometry without camera
motion, source-limit reporting, settings migration and persistence.
Both TypeScript checks, the English check and the production build passed.
The eight-district browser fixture retained 1 px^2 and 512 MiB after reload;
its settings status read Target 1 / Actual 1, with four 1m sources and 315,696
resident faces. Near AOI remained 8 and scene resolution 100%; no browser
errors were logged. This smaller fixture did not exercise the geometry cap.

## Current settings control

The preset row was removed. Subdivision Size is now the visible control for
all 1–256 px^2 values, with no disclosure step. Target/actual diagnostics remain.
The default voxel geometry budget is 160 MiB (10,485,760 faces); explicitly
saved budgets, including 64 MiB, remain intact. Reset Recommended restores
64 px^2 subdivision and 160 MiB geometry budget. Earlier benchmark tables in
this report use the former 64 MiB reference and remain historical measurements.
