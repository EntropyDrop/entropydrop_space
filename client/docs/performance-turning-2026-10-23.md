# Turning performance and GPU diagnosis, 2026-10-23

This second batch reduces CPU p99 during the controlled yaw sweep from
**12.6 / 17.1 ms to 7.2 ms**, and during rapid turning from **16.6 / 16.5 ms
to 7.3 ms**. The two baseline values are the first and repeated reference runs.
Rapid-turn RAF cadence improves from about 99 Hz to 120 Hz. There is **no
established GPU speedup**. The GPU investigation identifies distant drawing
as a substantial cost and corrects a misleading pass-sum timer.

The baseline is commit `517fa14`; the first batch's static matrices, incremental
Arena maintenance, and exact picking cache remain enabled in every comparison.
Geometry, materials, visibility guard, resolution, LOD selection, draw ordering,
and interactions retain their previous behavior. The optimized path is on by
default. The complete warmed pixel/picking comparison passes in all 16 cases.

## Diagnosis before implementation

The [initial record](../src/dev/results/turn-diagnosis-before-2026-10-23.json)
contains a CPU-only baseline followed by GPU isolation samples. All **127 CPU
callbacks above 8 ms** in that baseline coincide with an Arena view-epoch
refresh. CPU p99 is 12.4 ms and Arena synchronization p99 is 9.4 ms. There are
zero pipeline creation events during sampling: this observed tail is not
attributable to new shader pipelines.

A separate [Chrome CPU profile](../src/dev/results/turn-before-2026-10-23.cpuprofile)
records about 570 ms of self time in `culled`, 243 ms in `sync`, and 82 ms in
`visibleBlocks`. Matrix traversal, top-level view updates, and moving-ray picking
also consume CPU, but the stage/epoch correlation singles out the full block
visibility refresh as the turning spike. The CPU profile is a separate probe;
its instrumentation is absent from the final timed comparisons.

### GPU measurement correction

The original diagnostics summed durations of all render passes. Raw query
readback shows overlapping intervals on this backend: one Ultra sample contains
17 passes with a **15.270 ms duration sum but a 4.588 ms first-start-to-last-end
span**. The [raw intervals](../src/dev/results/turn-gpu-query-diagnosis-2026-10-23.json)
are retained. Overlapping durations must not be treated as exclusive per-pass
cost or elapsed frame time. No claim about the driver's internal scheduling is
needed to establish this arithmetic problem.

[`GpuTimestampSpan.ts`](../src/dev/GpuTimestampSpan.ts) calculates the span from
raw BigInt timestamp pairs before the mapped buffer is released.
[`FrameDiagnostics.ts`](../src/dev/FrameDiagnostics.ts) uses that result for its
GPU metric. Queries remain asynchronous and sampled once every six frames.
The turn harness saves both `gpu` (span) and `gpuPassSum` (old sum) for audit.
The span includes gaps between passes, excludes work before/after those queries,
and is not compositor or display-presentation latency. Timestamp quantization
also limits interpretation of small changes.

The initial isolation record and the
[early Ultra probe](../src/dev/results/turn-ultra-before-2026-10-23.json) predate
this correction and contain pass sums. They are not the GPU results below.
Historical reports retain their original measurements and metric labels.

## Implemented changes

[`VoxelFaceArena.ts`](../../engine/src/render/VoxelFaceArena.ts) now separates
the inputs of the visibility tests:

- Camera-position changes invalidate cached block distance and normal-cone
  back-face results. Rotation at the same guarded position reuses them.
- Coverage texture identity or version changes invalidate cached ownership
  results. Replacing a texture with the same version is handled explicitly.
- An enclosing sphere first accepts or rejects whole-source frustum planes.
  Remaining planes run the original per-block comparison, with the same
  conservative translation/rotation margin and decision order.
- New/replaced/disposed geometry owns and releases its cache. Position values
  use Float64 storage to preserve the original comparison precision.

The full fixture uses **1,314,570 bytes (1.25 MiB)** of extra typed-array cache,
plus per-source object/bounds overhead. GPU allocation remains 9 pages and
99,090,432 bytes. Coverage, movement, material transitions, missing metadata,
and conservative frustum behavior retain their original paths and invalidation
rules. The reference switch only changes this batch's block-test implementation.

The original visibility guard remains unchanged: 16 m position threshold,
0.06 plane-normal threshold, 1 m plane-offset threshold, and the existing
18 m plus distance-dependent padding. A tighter guard was investigated and
removed: it raised refresh frequency and worsened CPU p95, while a cross-ring
pixel check found two pixels differing by one channel level. The
[first trial](../src/dev/results/turn-trial-2026-10-23.json) and
[hierarchy trial](../src/dev/results/turn-hierarchy-trial-2026-10-23.json) retain
that rejected experiment. It is not a hidden optional production setting.

## Final CPU measurements

The [final raw record](../src/dev/results/turn-final-2026-10-23.json) contains
15 runs. CPU runs use reference / optimized / reference-repeat, with at least
3 seconds of settled warm-up and then 32 seconds per run. GPU queries are off.
CPU is synchronous `Game.animate` callback time; nested stages must not be added.
Only the before *mean* column averages the two reference means; percentiles
are reported separately instead of averaging percentiles.

| Motion | Before CPU mean, ms | After CPU mean, ms | Mean reduction | Before p95, first / repeat, ms | After p95, ms | Before p99, first / repeat, ms | After p99, ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Eight-second yaw sweep | 2.798 | 2.617 | 6.5% | 3.0 / 3.1 | 3.1 | 12.6 / 17.1 | 7.2 |
| Four-second full turn with pitch motion | 5.628 | 3.299 | 41.4% | 16.0 / 16.0 | 6.9 | 16.6 / 16.5 | 7.3 |

| Motion | Arena p99, reference / optimized / repeat, ms | RAF Hz, reference / optimized / repeat | RAF p99, reference / optimized / repeat, ms | RAF gaps >16.67 ms, reference / optimized / repeat |
| --- | ---: | ---: | ---: | ---: |
| Yaw sweep | 9.7 / 4.3 / 14.1 | 119.96 / 120.03 / 115.97 | 10.3 / 10.3 / 16.7 | 1 / 0 / 63 |
| Rapid turn | 13.3 / 4.2 / 13.3 | 99.16 / 119.95 / 99.77 | 17.6 / 10.3 / 17.5 | 286 / 3 / 262 |

Yaw-sweep CPU p99 falls by 42.9-57.9%, but its baseline varies substantially;
there is no reliable ordinary-sweep FPS gain to claim from these runs.
Rapid-turn CPU p99 falls by about 56%, and RAF rate rises by 20.6% against the
mean reference rate. Rapid-turn callbacks over 16.67 ms number 23 / 0 / 21;
RAF gaps are a separate measurement and still include three optimized outliers.
The slow-frame detail array is capped at 1,000 entries; use the complete metric
counters, not that array length, for the threshold totals above.

Every final run has 2,089,207 resident faces, zero pending copies, unchanged
GPU allocation, and no recorded pipeline creation during sampling. Wall-time
camera motion means endpoint visibility counters can differ slightly across
runs; fixed-pose map/pixel tests provide the exact equivalence check.

## Final GPU measurements and remaining costs

These are separate reference / optimized / reference-repeat yaw sweeps, 24
seconds per run after warm-up, with one asynchronous GPU sample per six frames.
They must not be mixed with the CPU-only timings above. Shadows are off.

| Quality | GPU span mean, reference / optimized / repeat, ms | GPU span p95, reference / optimized / repeat, ms |
| --- | ---: | ---: |
| Medium | 2.663 / 2.815 / 2.887 | 3.998 / 4.325 / 4.260 |
| Ultra | 5.206 / 5.151 / 5.187 | 6.029 / 5.833 / 5.964 |

Medium's optimized mean is within baseline variation; Ultra's mean difference
is less than 1%. Neither establishes a robust GPU improvement. This is expected:
the retained optimization preserves the same GPU maps and rendered work.

Three additional 16-second Medium reference sweeps isolate drawing costs. The
normal reference mean is 2.775 ms (mean of the two Medium reference means).

| Diagnostic-only change | GPU span mean, ms | Change relative to reference mean |
| --- | ---: | ---: |
| Hide far drawing | 1.586 | -42.8% |
| Hide near drawing | 2.701 | -2.7% |
| Half scene width and height | 2.449 | -11.7% |

These are overlapping diagnostic interventions, not additive savings or shipped
quality reductions. The far-drawing result is much larger than the reduction
from quartering pixel count, suggesting far geometry/draw work matters beyond
pure fill cost in this view. Ultra also adds substantial GPU cost relative to
Medium, but overlapping pass timestamps do not identify exclusive shader costs.
Future GPU work should measure far geometry/bandwidth/submission and Ultra
effects separately while retaining pixel equivalence. This batch does not claim
that GPU bottlenecks on other hardware or online scenes have been removed.

## Workload, visual checks, and limits

- Deterministic local Aether fixture with 153 near chunks and 128 repeated far
  districts, using the same scene as the first batch.
- 1280 x 720 CSS viewport, DPR 2, 2560 x 1440 drawing buffer, fixed resolution
  1.0 except the explicit half-resolution isolation. Medium CPU runs; both
  Medium and Ultra GPU runs. Far terrain and first-batch optimizations on.
- Browser reports Chromium 155 on macOS. Adapter metadata did not establish
  a hardware model; no CPU/GPU model is asserted.
- No screenshots, pixel readbacks, CPU profiler, builds, or test suites ran
  during final timings. Temporary FPS-guard isolation and viewport changes
  were restored afterward, and the measurement tab was closed.
- This offline world excludes live entities, remote players, network streaming,
  and production-bundle behavior. RAF frequency is not verified presentation
  rate. Results are controlled local measurements, not an online FPS promise.

The [pixel record](../src/dev/results/turn-pixels-2026-10-23.json) has a warm-up
pass and a repeated 16-case pass: near / across-ring / turned / reverse views,
Medium / Ultra quality, shadows off / on. Each case approaches a guard boundary
and compares reference / optimized / reference-repeat without advancing
simulation. **All 16 warmed cases have zero differing RGB pixels, nonempty
images, and identical complete picking results.**

The first Ultra-near warm-up capture differs in 862 pixels by at most 8 channel
levels; optimized and reference-repeat have the same difference against that
first capture. The repeated pass is exactly equal. Both passes are retained;
this is evidence for the tested views, not an exhaustive proof for every scene.
Unit tests additionally compare exact GPU maps through rotation, camera motion,
coverage fades, material changes, same-version texture replacement, and disposal,
and ensure visible spheres remain included while the view guard is reused.

## Validation

- Engine suite: **632/632 passed**, run alone after browser timing and pixel
  checks ended and the measurement tab closed.
- Focused Arena, visibility, and GPU-span tests: **14/14 passed**.
- Client suite: **1512/1515 passed**. The same three failures documented in
  the [first batch](performance-maintenance-2026-10-23.md) remain:
  `entity-menu-icons.test.ts` cannot load `OnlineSpaceNotice.tsx`, and two
  `shovel-cursor.test.ts` entity-outline assertions receive null. The previous
  batch reproduced these against its original engine sources. This batch
  does not alter those loader/cursor paths and introduces no additional failures.
- Engine and client TypeScript checks, including inventory typing: passed.
- Production build, development-entry exclusion, four module initialization
  import orders, and compiler-worker smoke checks: passed. Vite still emits
  its large-chunk advisory.
- English text, documentation links, generated API documentation, and
  `git diff --check`: passed.

Useful commands: `npm test --workspace @entropydrop/space-engine`,
`npm run test:app --workspace @entropydrop/space`, the respective workspace
`typecheck` scripts, `npm run build`, `npm run check:english`,
`npm run check:docs --workspace @entropydrop/space`, and `npm run docs:check`.
Run suites separately from browser benchmarks; the engine has timing assertions
that should not compete with builds or browser rendering.

## Reproduction

Start Vite and open
`/space/app/?dev_offline=1&world=aether-archipelago&dev_lod=world&dev_perf=1&dev_dpr=2`.
Set a 1280 x 720 viewport, enter Play, release pointer lock, close the frame
profiler, and wait for the full fixture to settle. The harness rejects other
resident face counts. Import the development-only probe in the local console:

```js
const project = '/Users/ha/Documents/entropydrop_website/entropydrop_space';
const probe = await import(`/@fs${project}/client/src/dev/TurnPerformanceBenchmark.ts`);
const layer = game.world.distantSurface.voxels;
const rows = [];
try {
  for (const [label, enabled] of [['before', false], ['after', true], ['repeat', false]]) {
    game.sceneRenderer.setLightingQuality('medium');
    game.sceneRenderer.setShadowsEnabled(false);
    game.controller.yaw = Math.PI / 2;
    game.controller.pitch = 1.35;
    game.controller.updateRender(0);
    layer.setTurnOptimizationsEnabled(enabled);
    rows.push(await probe.sampleTurn(game, label, {
      motion: 'rapid', gpu: false, durationMs: 32000,
    }));
  }
} finally { layer.setTurnOptimizationsEnabled(true); }
console.log(rows);
```

Use `motion: 'sweep'` for the eight-second sinusoidal yaw trajectory. Rapid mode
makes a complete turn every four seconds and varies pitch every three seconds.
Use `gpu: true, durationMs: 24000` for the separate GPU sweeps, and set the
lighting quality explicitly. Diagnostic `hide: 'far'`, `hide: 'near'`, and
`scale: 0.5` apply only within the sampler and are restored in `finally`.
The sampler fixes far terrain and resolution, pauses FPS-guard sampling, waits
for settled terrain, checks page visibility/workload, and restores its hooks
and settings. Preserve and restore manual caller-level graphics choices too.

After timing, keep the full fixture settled and run
`await probe.checkTurnPixels(game)` twice. Pixel readback pauses the game loop
and is deliberately separate from performance sampling. The harness is only
explicitly imported in development and is absent from the production graph.
