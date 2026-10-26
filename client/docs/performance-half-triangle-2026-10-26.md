# One triangle per distant quad experiment

Date: 2026-10-26. Development-only, local offline fixtures.

Keeping one stable random triangle from every distant quad halves submitted far triangles, but does not demonstrate a useful game FPS gain in these three worlds. The picture develops pervasive triangular holes. Keep the production renderer unchanged. The [interactive image comparison](performance-half-triangle-2026-10-26.html) shows all three terrains.

## Full game measurements

Each cell compares original quads with the half-triangle candidate. FPS is computed from pooled frame durations. GPU time is the mean first-to-last pass span, including dependencies; it is not a hardware busy-time counter. Turning is near the approximately 120 FPS presentation ceiling. Moving retains normal simulation, culling, terrain publication and rendering.

| World | Motion | FPS original → half | CPU mean ms | GPU span mean ms |
| --- | --- | ---: | ---: | ---: |
| aether-archipelago | sweep | 120.0 → 120.0 | 4.023 → 3.984 | 3.487 → 3.624 |
| aether-archipelago | move | 105.7 → 105.9 | 6.960 → 6.875 | 3.188 → 3.248 |
| nature | sweep | 120.0 → 119.8 | 2.873 → 2.901 | 3.150 → 3.076 |
| nature | move | 118.5 → 117.9 | 5.045 → 5.103 | 2.902 → 2.813 |
| copper-metropolis | sweep | 120.0 → 120.0 | 4.113 → 4.017 | 4.046 → 3.893 |
| copper-metropolis | move | 76.3 → 75.2 | 11.385 → 11.452 | 4.724 → 4.634 |

Moving FPS changes by approximately +0.2%, −0.5% and −1.5% respectively. Individual blocks overlap, so these small differences are not evidence of a repeatable gain or a precise regression size. Some full-frame GPU spans fall slightly, but this does not translate into better game FPS.

## Isolated distant drawing

The existing far-bundle replay executes the actual candidate or original command bundle 16 times per measured batch, with color/depth cleared for each pass. Each of eight interleaved variant blocks has 32 warm and 32 measured batches. These measurements exclude near-terrain occlusion, post-processing, simulation and presentation; they are not game frame times.

| World | Original mean ms/pass | Half mean ms/pass | Change |
| --- | ---: | ---: | ---: |
| aether-archipelago | 1.965 | 1.987 | +1.1% |
| nature | 0.875 | 0.870 | -0.6% |
| copper-metropolis | 2.490 | 2.855 | +14.7% |

Aether and Nature are effectively unchanged at this scale. Copper is slower in all four candidate replay blocks (2.818–2.921 ms versus 2.473–2.513 ms for originals). This result is specific to the fixed far-only view and must not be reported as a 14.7% game FPS loss.

## Geometry and visual validation

Frozen checks render original → half → half → original at the same pose. The two candidate images match exactly, and restored originals match exactly. Draw calls are unchanged, far triangles are exactly halved, and the whole-scene triangle delta equals the removed far triangles. No fallback draws occurred.

| World | Far triangles original → half | Whole scene original → half | Draw calls both | Changed screen pixels |
| --- | ---: | ---: | ---: | ---: |
| aether-archipelago | 1,456,768 → 728,384 | 1,781,017 → 1,052,633 | 288 | 29.2% |
| nature | 482,560 → 241,280 | 607,109 → 365,829 | 109 | 26.3% |
| copper-metropolis | 1,864,832 → 932,416 | 2,416,263 → 1,483,847 | 217 | 16.3% |

Changed pixels have a maximum RGB-channel difference greater than two byte levels. This is a screen-space difference count, not a perceptual quality score. Screenshots retain nearby terrain and the held tool; the HTML HUD is not part of canvas PNGs.

Aether islands become perforated fragments. Nature loses continuity across the distant ground surface. Copper exposes gaps through walls and roofs while nearby buildings stay intact. Stable face selection prevents per-frame random changes, but does not eliminate normal edge aliasing or changes when LOD replaces faces. Physics and picking still use the original world, so invisible portions remain solid.

## Implementation and interpretation

The optional [trial](../src/dev/HalfTriangleTrial.ts) replaces only packed distant Arena materials and index geometry during rendering, restoring original mesh state immediately afterward. Every face keeps either original triangle [0,1,2] or [0,2,3], including the original winding, curvature projection, PBR lighting, color and emission. A deterministic hash of flat world coordinates, spans and face direction selects the half; page relocation and visible ordering are not hash inputs.

The original 32-face batch uses 192 indices and 128 distinct corner indices; the candidate uses 96 indices and 96 distinct corners. Halving triangles therefore reduces distinct indexed vertices by 25%, rather than 50%. There is no fragment discard or degenerate second triangle. Face records stay 16 bytes, and draw calls, CPU world work and visibility maps remain. The candidate adds hash arithmetic. Holes also expose previously hidden surfaces. These are plausible reasons triangle savings do not produce proportional speedups; this experiment does not isolate each contribution.

Transition source meshes would retain original geometry and are counted as fallbacks. Accepted captures have zero such draws. Page changes are supported and material creation is tracked; no new materials were created inside accepted sampling blocks. The code is explicitly DEV/offline and has no production import or settings switch.

## Reproduction and scope

- Backend: WebGPU, Apple / metal-3; the browser does not expose an exact GPU model.
- Viewport: 1280 × 720 CSS pixels, DPR 2, 2560 × 1440 framebuffer. Medium PBR, shadows off, four samples, fixed resolution scale 1, original command caching and block instancing, torus backface culling off.
- Fixtures: `aether-archipelago`, `nature`, `copper-metropolis`, using `?world=...&dev_offline=1&dev_lod=world&dev_dpr=2` at the local `/space/app/` entry. Enable distant terrain temporarily without persisting settings, and close the start screen.
- Positions: Aether [8192.5,180,1024.5], Nature [5377.6,180,821.3], Copper [8200,128,1032]. Nature is raised from its default Y=18 so near ground does not completely hide distant geometry.
- Set yaw π/2 and pitch −0.85 for frozen images and far replay. Sweep yaw by 0.6 sin(2πt). Moving also offsets X by 16 sin(2πt) and Z by 8(1−cos(2πt)). Each block repeats the same path.
- Warm the moving path in both modes before accepted sampling. For each motion, use original, half, half, original, half, original, original, half; 1.2 seconds warmup and 3 seconds sampling per block. Warmup results are retained but excluded.
- The [frame harness](../src/dev/HalfTriangleFrames.ts) records real animation frames and GPU timelines every sixth frame. Keep the gameplay HUD visible and diagnostics panel hidden; do not run builds or other heavy workloads during sampling.
- Moving tests intentionally retain pending terrain work. Nature publishes 168 additional resident faces in one candidate moving block, from 1,006,479 to 1,006,647 (about 0.017%). Its timing variation and source change reinforce that the small FPS difference should not be treated as a precise effect.
- The [pixel harness](../src/dev/HalfTrianglePixels.ts) pauses animation only for frozen screenshots. GPU replay uses [sampleFarBundle](../src/dev/GpuDrawingBenchmark.ts) with an explicit callback selecting the trial mode; restore the mode in a finally block.
- Import dev modules using Vite `/@fs/` URLs rooted at this checkout. Create the trial only after the original far layer settles. Dispose the trial and restore camera, distant terrain enablement and temporary viewport afterward.

Accepted evidence: 48 full-frame blocks, 15,876 frames and 2,645 GPU frame samples; zero recorded GPU errors. Far replay retains 768 measured batches of 16 passes. Three frozen sequences pass count, repeatability and restoration checks. TypeScript checks, documentation links, English-only checks and whitespace checks pass.

Raw gzip exports (including excluded warmups), six full-resolution PNGs and the [computed summary](../src/dev/results/half-triangle-2026-10-26/summary.json) are retained under `client/src/dev/results/half-triangle-2026-10-26/`. Recompute tables with `node client/tools/summarize-half-triangle.mjs`.

This local machine, resolution, lighting setup and these camera paths do not establish performance on all GPUs or views. For the tested settings, the visual cost is clear and there is no practical frame-rate benefit. The application remains on the original renderer.
