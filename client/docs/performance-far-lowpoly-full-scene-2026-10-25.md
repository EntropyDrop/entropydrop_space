# Full-scene low-poly terrain performance — 2026-10-25

This follows the [isolated far-render experiment](performance-far-lowpoly-2026-10-25.md).
It measures normal game animation with the actual scene renderer, PBR and
emission materials, near terrain, sky, antialiasing and HUD. It is an offline
repeated-district fixture, not an online multiplayer measurement.

## Decision

**Do not enable this low-poly integration in production.** The isolated GPU
benefit does not translate into a complete-frame improvement. Aether loses
about 13–18% FPS and Copper about 33–35%; Nature is close to unchanged in
fixed/sweep views and somewhat slower during movement. CPU cost rises in all
three worlds, and moving-frame tails get worse.

| World | Fixed FPS, packed → low-poly | Sweep FPS | Moving FPS | Moving frame p95 |
| --- | --- | --- | --- | --- |
| Aether | 126.0 → 108.0 | 123.7 → 107.5 | 105.7 → 86.9 | 16.7 → 24.8 ms |
| Nature | 125.9 → 123.5 | 125.3 → 125.1 | 124.0 → 119.4 | 9.9 → 12.0 ms |
| Copper | 122.6 → 80.0 | 124.0 → 81.6 | 98.9 → 66.0 | 20.6 → 30.4 ms |

Keep packed greedy quads. Any subsequent low-poly trial needs to preserve
fine-grained visibility rejection and remove per-frame source/index work before
considering another production integration. These results reject this particular
prototype, not every possible low-poly renderer. No production path was changed.

## Integration tested

`FarLowPolyScene.ts` installs a reversible development-only replacement at
nominal 0.5 px, the conservative candidate from the first experiment. It is
explicitly imported into an initialized offline game. No production import or
default renderer setting changes.

The production packed renderer remains the reference. Only entire source
entries whose bent bounds are at least 384 m from the initial camera can be
replaced. This avoids partial packed-block removal and keeps near handoff
rendering in the original path. Entries are split into 64 m bricks and separate
emission classes before T-junction preparation and simplification. Locked
borders and the prior seam fallback remain. PBR roughness/metalness and the
production emission function are retained; the candidate uses geometric flat
normals, so shading is not pixel-identical to production's interpolated normals.

The simplified meshes are combined into an indexed Three mesh with prebent
positions. Each production Arena view epoch rebuilds its visible index list
using conservative bent brick bounds. Source ownership, version changes and
masked materials fall back to the original packed draw. Normal LOD planning,
publication, near chunks and game updates continue during measurements.

This prototype still checks source validity on the main thread and uploads
selected indices when visibility changes. Its frustum selection is coarser
than the production renderer's face-block/backface tests. It does not implement
incremental low-poly rebuilding, compressed vertices or GPU culling. A 64 m
movement guard prevents using the frozen geometry outside the tested area.
Both representations remain allocated for switching; these tests are not a
measurement of final standalone memory residency.

## Measurement conditions

- Same Mac/browser adapter: `apple / metal-3`; exact GPU name masked. No new
  frequency/thermal telemetry or clock lock.
- 2560×1440, medium lighting, fixed 100% resolution, renderer antialiasing
  enabled, shadows disabled. Main HUD remains visible; developer panels are hidden.
- Same initial simulation position `(8192.5, 180, 1024.5)`, pitch −0.85 and yaw π/2.
- Fixed camera, a ±0.6-radian yaw sweep, and a short flying loop with that sweep.
  The loop sets X offset to `16*sin(2πt)` and Z offset to `8*(1-cos(2πt))`.
  A measured cycle takes four seconds. Physics/game updates run normally;
  position/velocity are controlled by the fixture for repeatability.
- Eight blocks per motion in `A B B A B A A B` order. Each block warms for
  1.5 seconds and measures four seconds. Both roles traverse the same path.
- Separate packed/packed A/A control: four two-second blocks, one-second warm-up.
- GPU timestamps sample approximately one in six normal frames, without blocking
  each frame on readback. Independent queries measure first GPU pass start to
  last pass end; this is a span, not a hardware busy-time counter.
- FPS below is `1000 / mean RAF interval`, pooling raw frames within each role
  and motion. P95 is the pooled RAF interval, not the mean of per-block p95s.
  CPU is wall time inside the game animation call; nested stages are not summed.

This measures actual complete frames under the stated fixture and settings.
It does not predict every camera, graphics preset, device, editing workload,
long-distance traversal or live-server load. Native/world/browser pacing can
limit observable FPS even when GPU medians fall.

There are 72 accepted A/B blocks plus 12 A/A blocks across the three worlds.
All accepted runs report zero WebGPU validation errors. No build, typecheck or
other heavy development job runs concurrently with accepted timing blocks.

## Aether accepted results

| Motion | Packed FPS | Low-poly FPS | Frame p95, packed → low-poly | CPU p50 | GPU span p50 |
| --- | ---: | ---: | --- | --- | --- |
| Fixed | 126.0 | 108.0 | 9.7 → 16.2 ms | 3.0 → 4.3 ms | 2.818 → 2.687 ms |
| Sweep | 123.7 | 107.5 | 9.7 → 16.7 ms | 3.5 → 5.1 ms | 2.884 → 2.753 ms |
| Move | 105.7 | 86.9 | 16.7 → 24.8 ms | 4.5 → 6.1 ms | 3.015 → 3.080 ms |

Per-block FPS ranges, reference / candidate: fixed 122.7–129.5 / 105.7–110.5;
sweep 122.3–125.5 / 104.2–110.6; move 103.4–108.2 / 80.6–89.8. This regression
is much larger than the A/A control's roughly 5% role difference. That control's
four block FPS values are 127.5, 121.5, 120.7 and 128.4.

Fixed-camera submitted triangles rise from 1,782,105 to 1,909,174 despite the
smaller candidate source mesh; draw calls fall from 265 to 259. Reduced total
geometry does not compensate for the coarser visibility selection. The candidate
adds CPU work on every frame, plus index refreshes on turns. Across the four
candidate sweep blocks, refresh work totals about 1.66 s including warm-up;
the same figure is 1.68 s in the moving blocks. These measurements support an
integration-cost explanation, not a claim to have isolated every CPU/GPU stall.

## Nature accepted results

| Motion | Packed FPS | Low-poly FPS | Frame p95, packed → low-poly | CPU p50 | GPU span p50 |
| --- | ---: | ---: | --- | --- | --- |
| Fixed | 125.9 | 123.5 | 9.8 → 9.9 ms | 2.4 → 3.4 ms | 1.835 → 1.704 ms |
| Sweep | 125.3 | 125.1 | 9.7 → 9.8 ms | 2.8 → 3.9 ms | 1.901 → 1.638 ms |
| Move | 124.0 | 119.4 | 9.9 → 12.0 ms | 3.3 → 4.6 ms | 1.966 → 1.901 ms |

Fixed/sweep FPS is effectively unchanged within browser variation, despite
some lower GPU medians. The movement result and CPU/RAF tails are less favorable.
Per-block FPS ranges are fixed 124.6–127.0 / 121.8–126.6, sweep 121.8–129.2 /
123.0–128.5, and move 121.6–127.3 / 117.8–121.1. The A/A block FPS values are
127.5, 128.1, 123.3 and 124.8.

Fixed-camera triangles rise from 596,723 to 715,253, with calls falling from
121 to 101. Candidate index refreshes total approximately 0.49 s across the
sweep blocks and 0.63 s across moving blocks, including warm-up.

## Copper accepted results

| Motion | Packed FPS | Low-poly FPS | Frame p95, packed → low-poly | CPU p50 | GPU span p50 |
| --- | ---: | ---: | --- | --- | --- |
| Fixed | 122.6 | 80.0 | 9.9 → 17.7 ms | 3.1 → 5.1 ms | 3.932 → 3.408 ms |
| Sweep | 124.0 | 81.6 | 9.8 → 18.0 ms | 3.6 → 5.6 ms | 4.063 → 3.539 ms |
| Move | 98.9 | 66.0 | 20.6 → 30.4 ms | 5.2 → 7.8 ms | 3.998 → 4.194 ms |

Per-block FPS ranges are fixed 121.1–124.0 / 79.1–80.9, sweep 122.3–126.7 /
77.6–84.4, and move 96.0–101.3 / 64.0–67.5. A/A FPS values are 126.2, 130.4,
122.4 and 123.5. The candidate regression is far larger than that variation.
Lower fixed/sweep GPU spans coexist with much worse complete-frame cadence;
GPU/CPU spans cannot simply be added because work can overlap and presentation
pacing also matters.

Fixed-camera submitted triangles increase from 2,275,903 to 2,598,453, despite
draw calls decreasing from 209 to 188. Candidate refresh work totals 0.72 s
across sweep blocks and 0.79 s across movement blocks, including warm-up.

## Candidate construction and storage

These figures cover the eligible source subset before normal streaming replaces
some entries. The indexed mesh uses 16-byte position records, a separate 4-byte
RGBA/emission attribute and uint32 indices. Byte figures are data-buffer payloads,
excluding CPU copies, render targets, retained packed storage and other game data.

| World | Selected original quads | Candidate triangles | Reduction vs selected original | Candidate buffers | Construction |
| --- | ---: | ---: | ---: | ---: | ---: |
| Aether | 1,232,087 | 2,051,008 | 16.8% | 69.82 MiB | 16.08 s |
| Nature | 840,228 | 1,429,940 | 14.9% | 43.49 MiB | 10.42 s |
| Copper | 1,812,860 | 3,089,456 | 14.8% | 108.11 MiB | 26.19 s |

All three have zero simplification seam fallbacks at construction. Boundary and
emission partitions number 20,120 / 8,016 / 9,401 respectively. Construction is
outside frame timing, on the main thread with periodic yields; it is not a
production loading or incremental-edit benchmark. The candidate uses additional
memory while the original buffers remain resident for switching/fallback.

## Streaming and fidelity limits

Preflight camera poses and the moving loop trigger normal LOD publication.
Fixed/sweep frames have no pending terrain work in the three accepted captures.
Their moving blocks include 55/52, 65/61 and 68/36 pending frames for
reference/candidate in Aether, Nature and Copper. These are counts, not
normalized rates: slower variants produce fewer frames. Residency changes during early traversal,
then stabilizes; these are deliberately not frozen-LOD timings.

Aether has 50 fallback source entries during fixed/sweep and up to 104 during
movement. Nature has 29 and 61; Copper has 34 and 84. Fallback renders updated/owned
sources through production geometry rather than displaying stale low-poly data.
This preserves coverage but also limits how much geometry is replaced. It is
not a completed dynamic low-poly streaming system.

Fixed/sweep resident quad counts are 2,111,714 / 1,018,711 / 2,767,704 in
Aether/Nature/Copper. After moving they settle at 2,127,731 / 1,025,885 /
2,799,987. Initial movement blocks therefore contain some one-time publication.
Later reference and candidate blocks still show the same broad regression or
near-parity pattern. This is not a perfectly immutable moving workload, and
small movement differences should not be overinterpreted.

Post-run pixel checks use fixed near, across-ring, reverse and displaced poses.
They copy the WebGPU canvas before presentation, assert nonempty images and
compare packed → candidate → restored packed outside all timings. In all three
worlds, restored packed images match exactly and picking is unchanged.
Candidate RGB changes remain; this is an approximation rather than a fidelity pass.

| World | Changed RGB pixels >2, near/across/reverse/moved | Mean maximum-channel error, same order (0–255) |
| --- | --- | --- |
| Aether | 147978 / 26610 / 112160 / 185229 | .466 / .106 / .330 / .544 |
| Nature | 9071 / 25978 / 92268 / 155847 | .023 / .082 / .208 / .370 |
| Copper | 11793 / 40315 / 67996 / 178452 | .052 / .140 / .225 / .663 |

Each image has 3,686,400 pixels. These checks include final PBR/color output,
not a separate internal-edge or hole classifier. They do not certify all mixed
LOD seams, cave interiors, temporal popping or long-distance handoff.

## Reproduction and retained evidence

Open the existing offline fixture with `world=aether-archipelago`, `nature` or
`copper-metropolis`, plus `dev_offline=1&dev_lod=world&dev_dpr=2`, on localhost.
Press Play, move to the common position above, enable distant terrain and wait
for near and far work to settle. In the page's development console, import the
files using their Vite `/@fs/<checkout>/client/src/dev/…` URLs:

```js
const { createFarLowPolyScene } = await import('/@fs/<checkout>/client/src/dev/FarLowPolyScene.ts');
const { runFarLowPolyFrames } = await import('/@fs/<checkout>/client/src/dev/FarLowPolyFrames.ts');
const trial = await createFarLowPolyScene(game, 0.5);
const control = await runFarLowPolyFrames(game, trial, {
  control: true, motions: ['fixed'], order: [false, true, true, false],
  sampleMs: 2000, warmMs: 1000,
});
const result = await runFarLowPolyFrames(game, trial);
trial.dispose();
```

`FarLowPolyScenePixels.ts` supplies the separate paused readback check. The
captured runs include four preflight poses before the timing control; wait for
publication to settle before interpreting fixed-camera samples. Use fresh
module URLs or a page reload after editing the explicit dev modules, because
an already imported module can remain cached.

Complete per-frame intervals, CPU samples, per-frame GPU timestamp records and
per-block summaries are GZIP/base64 in `full-lowpoly-<world>-comparison-gzip`
and `full-lowpoly-<world>-control-gzip` sessionStorage keys. Corrected post-run
image summaries use `full-lowpoly-images-<world>`. Navigate the same tab to
`/@fs/<checkout>/client/tools/full-lowpoly-results.html` to inspect and manually
export captures without keeping a game/GPU context active. The report is the
durable repository summary; raw captures have not been exported as files and
may be lost when the results tab closes.

An early pilot used an unsupported 3-byte vertex stride and was discarded.
The accepted shader uses a 4-byte RGBA/emission attribute. An initial image
readback after awaiting the GPU returned cleared canvases; those zero-difference
rows are invalid and excluded. The corrected immediate-copy check verifies
nonempty images and has been rerun after performance measurement.

Validation: 11 focused geometry/timestamp/environment/order tests pass. Client
typecheck and production build pass, including offline-entry exclusion,
production module initialization and compiler-worker checks. Existing vendor
and chunk warnings remain. No new experimental module is imported by production.
