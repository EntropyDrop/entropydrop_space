# Chrome stationary-frame investigation, 2026-09-27

## Scope and method

Investigated the local Vite development app in Chrome, using the existing green
Nature world and a separate deterministic offline Nature fixture. No world data,
entities, production rendering defaults or saved graphics preferences were
modified. Development-only instrumentation lives in `FrameDiagnostics.ts` and is
available under Settings > Graphics > Performance > Open Frame Profiler.

Each render-isolation case gets 1.5 seconds of warm-up and 4 seconds of samples,
with a repeated baseline at the end. Keep the camera and viewport unchanged,
click Play first to remove startup blur, and release the pointer with Escape.
Counts include all render passes, not just the last Three.js render call.
CPU stages are nested; do not add their durations together. Asynchronous GPU
timers exclude browser compositing/presentation and can include command-stream
gaps. FPS is measured frame cadence, not `1000 / (CPU + GPU)`.

The first online suite sampled GPU time every frame. The final tool samples one
in six frames, allows disabling timing, uses rAF timestamps for cadence, and
labels fixed/full-effects comparisons explicitly. These measurements diagnose
relative costs; they are not a production-build or instrument-free FPS promise.

## Actual online Nature scene

Position: (5377.6, 18, 821.3). There were three entities, including one running
vehicle, 377 near chunks, near radius 16, far distance 649 chunks and a 16 CSS
pixel-squared subdivision threshold. Shadows were off, lighting was Ultra.
The undocked viewport was 1792 x 1034 CSS pixels with native DPR 2.

After terrain settled, Auto had reached 50% scale and reduced effects. The
drawing buffer was 1792 x 1034, with about 1,055 draw calls and 3,856,025
triangles per frame. CPU frame median was approximately 13 ms, including
9-11 ms rendering, 1.8 ms distant-view maintenance and 1.5 ms picking. GPU
median was approximately 10 ms. Observed instrumented cadence was 31-34 FPS.
The initial scene before reload/warm-up had shown approximately 58 FPS; these
are not a controlled before/after optimization comparison.

Fixed resolution selects **full effects**, unlike Auto's degraded state. The
following suite deliberately used Ultra, fixed 50%, full effects, shadows off:

| Case | FPS | CPU p50 / p95 (ms) | GPU p50 (ms) | Calls | Triangles |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline | 29.0 | 13.0 / 14.9 | 19.42 | 1,068 | 3,856,038 |
| No scene drawing | 49.1 | 4.5 / 7.0 | 0.79 | 0 | 0 |
| No distant LOD | 37.5 | 8.6 / 10.5 | 16.34 | 375 | 589,880 |
| No standard near terrain | 30.9 | 12.3 / 14.1 | 19.27 | 818 | 3,441,340 |
| No micro terrain | 29.0 | 12.9 / 14.7 | 20.40 | 990 | 3,731,212 |
| No sky | 29.8 | 12.9 / 14.9 | 18.16 | 1,067 | 3,855,078 |
| No Ultra post-processing | 33.2 | 12.5 / 14.4 | 9.38 | 1,052 | 3,856,022 |
| Baseline repeat | 29.2 | 13.0 / 14.8 | 19.34 | 1,068 | 3,856,038 |

The initial suite's 50% resolution case duplicated the baseline. The final
diagnostic tool instead compares 100% if the baseline is already at 50%.

Confirmed findings:

- Distant terrain contributes 693 calls and 3,266,158 triangles, about 85% of
  submitted triangles. Hiding it saves about 4.4 ms of main-thread frame work.
  This isolation hides drawing only; distant-view maintenance still runs.
- Full Ultra post-processing adds approximately 10 ms GPU time in this view,
  even with shadows off. Disabling sky alone has a much smaller effect.
- Near standard geometry and micro geometry contribute 250 and 78 calls,
  respectively. They are not the largest measured draw-submission cost here.
- No-draw cadence is still below 60 despite low measured CPU/GPU times. Work
  outside `Game.animate`, browser scheduling/compositing, development overhead,
  and profiling overhead remain unresolved contributors. Do not claim that the
  measured rendering costs explain every missing frame.

An additional 8.66-second Chrome Performance capture, with the in-app profiler
closed and DevTools docked, showed 4.947 seconds of scripting. The largest
self-time entry was `WebGLRenderer.render` (1.546 seconds), followed by
profiling overhead (0.630 seconds) and console task machinery. `SurfaceBatch`
`advance` used 0.272 seconds self-time; bent voxel raycasting used 0.571 seconds
including callees. Recording had substantial overhead and changed viewport
size, so this trace is useful for hotspot identification, not FPS comparison.
Repeated entity-definition HTTP 500 and entity-checkpoint HTTP 409 responses
were also present. Their frame-rate impact has not been isolated.

## Offline Nature control

URL: `/space/app/?dev_offline=1&world=nature&dev_perf=1`.
Generator v1, seed 42, no entities, no distant data, 153 near chunks, Medium,
100% scale, shadows off, drawing buffer 3584 x 2068. Startup overlay removed,
DevTools closed, no build/test processes running during the recorded cases.

| Case | FPS | CPU p50 / p95 (ms) | GPU p50 (ms) | Calls | Triangles |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline | 90.7 | 2.3 / 2.6 | 3.40 | 127 | 189,796 |
| No scene drawing | 105.5 | 1.7 / 2.0 | 1.60 | 0 | 0 |
| No distant LOD | 92.9 | 2.2 / 2.6 | 3.38 | 127 | 189,796 |
| No near terrain | 104.3 | 1.9 / 2.2 | 1.99 | 3 | 1,948 |
| No micro terrain | 94.2 | 2.2 / 2.5 | 2.98 | 127 | 189,796 |

The Mac locked before the remaining cases and final repeat could be read.
The no-far/no-micro cases are controls: those layers are absent in this fixture,
and the differing FPS demonstrates some measurement/environmental variation.
This shows ordinary near terrain alone can exceed 60 FPS here, not that the
complete online Nature world is cheap. Earlier samples with the startup blur
visible are excluded from this table.

## Optimization direction, not implemented in this investigation

1. Reduce distant draw submission and redundant idle batch maintenance.
   Inspect `engine/src/render/DistantVoxelLayer.ts`, `SurfaceBatch.ts`, and
   `DistantSurfaceLayer.ts`. Preserve the ring's bent-space culling and avoid
   popping when turning. A resident-face memory cap is not a GPU frame budget.
2. Budget Ultra passes separately from shadow quality. Inspect
   `client/src/engine/render/CinematicEffects.ts` and `SceneRenderer.ts`.
3. Cache or skip unchanged picking work before rewriting it. The bent-face
   raycast in `engine/src/voxel/World.ts` repeatedly samples occupancy and tests
   faces; its approximately 1.5 ms/frame is a plausible CPU/WASM target but not
   the dominant measured cost.
4. Recheck no-draw cadence in a production preview and investigate the entity
   retry errors independently. Do not infer their contribution from logs alone.

WASM acceleration of voxel LOD generation helps generation/streaming. A static
view does not regenerate those meshes every frame. Moving that generator to
WASM does not remove the existing Three/WebGL calls, GPU vertices or Ultra
pixel shader work. Batching, visibility/geometry budgets and effect resolution
are the first priorities indicated by these measurements.

## Validation

- Client TypeScript check passed.
- Thirty tests passed across frame diagnostics, offline entry, adaptive
  resolution, resolution settings and lighting quality.
- Production build passed, including a check that the diagnostics module and
  offline entry are excluded. Existing bundle-size/browser-external warnings
  remain; this change does not address bundle size.
