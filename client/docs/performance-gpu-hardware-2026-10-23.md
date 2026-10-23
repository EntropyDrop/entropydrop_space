# GPU hardware isolation and measurement controls

## Status

No production rendering optimization is enabled in this follow-up. The Arena,
distant layer and production renderer match this turn's starting files exactly;
compact maps remain off. Default graphics, HUD, controls and picking are unchanged.
The changes are development analysis tools and benchmark validity fixes.

The user will upgrade macOS and install Xcode before the next native profiling
step. Shader occupancy, cache stalls, bandwidth saturation and the exact cause
of the ordinary rotating-frame regression are **not yet established**. There is
no claimed production before/after speedup in this report.

## Tools added and corrected

- `GpuHardwareProbe.m`: a read-only native Metal/IOKit executable. It enumerates
  available counter sets and samples AGX device/tiler/renderer utilization,
  per-process driver accounting deltas, thermal state and low-power mode. It
  tracks registry client identities, detects counter resets and skips new clients
  until a delta exists. Sampling is finite; it changes no power settings, clocks,
  services or other applications.
- `GpuSceneReplay.ts`: captures the real main-scene and output render commands,
  including native far bundles and direct near draws. It replaces only the
  presentation attachment with an offscreen texture. Each ABBA/BAAB quartet is
  submitted in **one command buffer**, eliminating JavaScript gaps between its
  submissions. It preserves independent roles even for identical-code A/A trials.
  Every captured view must pass a full RGB comparison against its live canvas
  before timing. Unsupported compute/copy/occlusion contexts are rejected.
- Paused command replay now temporarily suppresses page UI by default, to separate
  scene execution from browser compositor work. It restores the UI and hooks on
  exit. `isolateUi: false` retains the HUD for a separate diagnostic. Neither mode
  measures ordinary game frames or presentation, and neither is a product setting.
- `GpuBenchmarkEnvironment.ts`: rejects a visible start overlay, open frame
  profiler or hidden document. The guard uses computed visibility, including
  ancestors, rather than trusting the HTML `hidden` attribute.
- `sampleTurn` now actually hides development panels with an inline display rule,
  restoring its previous value and priority afterward. Its ordinary-frame runs
  retain the gameplay HUD. The new validity guard also protects far-only and
  render-only replay entry points.

Native compilation with the installed Command Line Tools succeeded. Outside the
sandbox, this M1 Pro exposes only the `timestamp` counter set through the public
Metal API; stage-boundary sampling is supported, draw-boundary sampling is not.
No public stage-utilization or statistics set was returned. The capture-support
value in the capability artifact describes that probe's default launch environment,
not a claim that this hardware cannot capture Metal traces.

Only Command Line Tools are currently selected; `xctrace` requires full Xcode.
Apple documents Instruments/Metal System Trace and its newer command-line tools
on the [Metal developer tools page](https://developer.apple.com/metal/tools/).
The official download redirected to Apple authentication; after the user authorized
access, the login page was reached. The user chose to perform the OS/Xcode setup
and report back. Temporary download/test tabs were closed afterward.

## A significant source of interference

The main renderer's queue was instrumented while the game animation loop was
paused and drained. It recorded **zero submissions and zero buffer writes**.
Nevertheless, the shared Codex GPU process remained active. Temporarily hiding
page UI reduced that activity, and restoring UI brought it back.

One early capture had the full-screen start overlay and profiler reopened by
Vite HMR. It passed geometry/pixel checks but was not a valid gameplay condition.
That capture is explicitly excluded from performance conclusions and retained
only as an instrument audit. A separate attempt with zero resident far faces was
rejected before collecting rows. The new guard was verified in a real browser to
reject the reopened start overlay. All accepted captures below explicitly record
`startOverlayVisible: false` and `frameProfilerVisible: false`.

The start overlay is **not the entire explanation**. A second test, after clicking
Play and closing the profiler, measured the normal HUD independently:

| Paused main renderer, normal game entry | System device utilization | Codex accounting rate relative to HUD-on | GPU frequency | GPU power |
| --- | ---: | ---: | ---: | ---: |
| HUD visible, 20 s | 78.15% | 100% | 1097.9 MHz | 7.17 W |
| Only HUD hidden, 15 s | 42.00% | 9.93% | 451.2 MHz | 0.83 W |

These are diagnostic removals, **not visual optimizations**. The accounting rate
is the per-process `accumulatedGPUTime` delta divided by sample duration; it is not
a busy percentage, and overlapping client accounting must not be added to infer
physical utilization. System utilization/power and average frequency are separate
measurements. The GPU process is shared with browser composition; its entire time
cannot be attributed to the main WebGPU scene.

With the start overlay present, removing backdrop filters or pausing CSS animations
also substantially reduced activity. Those exploratory stages are labeled with
the overlay state in the summary, so they cannot be mistaken for isolated normal-HUD
results. No blur, animation or HUD component has been removed from production.
The next native trace must separate browser compositor passes from WebGPU passes.

Before any test tab was opened, system device utilization already averaged 38.83%
over 30 s, with WindowServer the largest process accounting delta. WindowServer
and Firefox activity also remained during scene replay. This work reduces and
measures interference; it does not claim an idle machine or a hardware clock lock.

## Accepted measurements

Apple M1 Pro, 16 GPU cores, macOS 26.5.1. Offline Aether repeated-district fixture:
2,089,207 resident far faces, 153 near chunks, 2560 x 1440 canvas, Medium lighting,
shadows off, original visibility map. Four fixed poses are drawn from the turning
benchmark. Each candidate has 16 warm-up quartets and 48 measured quartets; each
quartet has four groups of four complete frames. ABBA and BAAB alternate so both
roles occupy each position equally.

Camera, uniforms and geometry are frozen within a captured view. Simulation,
streaming uploads, presentation and dynamic rotation are excluded. GPU values are
first-pass-start to last-pass-end envelopes divided by replayed frame count, not
busy-time counters. They can still contain dependencies and scheduling from other
queues. They must not be used as FPS or as a replacement for ordinary turning tests.

For HUD-retained replay, pose-average GPU frequencies were 1294.96-1296.00 MHz,
with observed samples from 1294 to 1296 MHz. Thus slow clock drift was negligible
in that series, but shared compositor load remained. A/A mean differences ranged
from -3.03% to +1.09%, demonstrating a material noise floor.

For UI-suppressed replay, three pose averages were 1292.77-1294.25 MHz; across-ring
averaged 1266.50 MHz and included a 1126 MHz sample. Reverse included one 1268 MHz
sample. Thermal state remained nominal and low-power mode was false. One-second
samples cannot exclude subsecond frequency changes. These outliers are retained,
not normalized into a claimed gain or silently filtered out.

### Main-scene isolation, UI suppressed

| Pose | Identical-code A/A difference | Main pass limited to 1 pixel | Far bundle omitted |
| --- | ---: | ---: | ---: |
| Turned | +1.87% | -14.05% | -57.90% |
| Near | -0.76% | -16.05% | -60.25% |
| Across ring | +0.41% | -8.52% | -45.34% |
| Reverse | -0.61% | -12.38% | -62.12% |

Each reduction is relative to its own interleaved reference; different candidates'
absolute baselines are not pooled. Scissoring and omitting terrain deliberately
change the image and are diagnostic only. The much larger far-bundle reduction
supports concentrating on far geometry processing and work before fragment shading,
rather than treating pixel fill alone as the primary problem. It does **not**
distinguish vertex ALU, memory access, cache behavior or primitive processing;
that still requires native stage/counter evidence.

### Candidate comparison: discard unused private attachments

The existing development-only attachment experiment discards private MSAA/depth
contents after the main pass while preserving resolved color. The new replay
compares the same operation on captured descriptors:

| Pose | UI-suppressed before | Candidate | Change | HUD-retained change |
| --- | ---: | ---: | ---: | ---: |
| Turned | 1.5973 ms | 1.5647 ms | -2.04% | +0.93% |
| Near | 2.2787 ms | 2.2347 ms | -1.93% | -5.04% |
| Across ring | 1.0383 ms | 1.0243 ms | -1.35% | -6.84% |
| Reverse | 1.7727 ms | 1.7336 ms | -2.20% | -3.60% |

These are native-command replay results, not an ordinary-frame improvement. The
small isolated benefit is close to A/A variation; the HUD-retained turned view
regresses, and the previous ordinary rotating-frame test did not show a stable
benefit. **The candidate remains development-only and disabled in production.**
No cross-reload HUD-on/off percentage is reported as a causal scene speedup.

## Verification and evidence

Both accepted four-view captures matched their live canvases exactly: zero changed
RGB pixels and zero maximum channel difference at 2560 x 1440. All hooked methods
were restored by identity. The final isolated run also verified removal of the
temporary UI stylesheet. No production geometry, shading, UI or input code changed.

TypeScript and inventory checks pass. Eight focused tests pass, covering timestamp
intervals/readback, attachment exclusions, computed visibility and balanced sham
roles. The production build passes development-entry exclusion, four module import
orders and compiler-worker checks. Native compilation passes `-Wall -Wextra -Werror`.
This follow-up did not rerun the full application suite; the preceding report
records its three existing failures.

- [Summary, hardware alignment and source hashes](../src/dev/results/gpu-hardware-summary-2026-10-23.json)
- [Metal capability probe](../src/dev/results/gpu-hardware-capabilities-2026-10-23.json)
- [All retained raw captures and telemetry](../src/dev/results/gpu-hardware-raw-2026-10-23.json.gz)
- [Restored default scene screenshot](../src/dev/results/gpu-hardware-final-scene-2026-10-23.png)
- [Previous ordinary-frame attachment comparison](performance-gpu-turn-regression-2026-10-23.md)

The gzip archive is a JSON object mapping each original filename to its exact text.
It includes the rejected overlay capture under its original filename; the summary
explicitly lists its exclusion. No rejected capture contributes to the tables above.

## Reproduction and next native profiling step

From the repository root, build the local probe and record concurrently with a
benchmark, using fresh output paths:

```sh
clang -fobjc-arc -Wall -Wextra -Werror -framework Foundation -framework Metal \
  -framework IOKit client/tools/GpuHardwareProbe.m -o /tmp/space-gpu-hardware
/tmp/space-gpu-hardware --capabilities
/tmp/space-gpu-hardware 180 > /tmp/space-gpu-native.jsonl
node client/tools/sample-gpu-hardware.mjs /tmp/space-gpu-clock.jsonl 180
```

The two collectors should run concurrently in separate terminals; they record
wall-clock timestamps for alignment. macmon must already be installed. A sandbox
that hides Metal/IOKit is reported as unavailable, never as zero GPU utilization.

Open the documented offline fixture, click Play, close the profiler, enable and
settle far terrain, and import `GpuSceneReplay.ts` through the local development
module URL. `sampleGpuSceneReplay(game)` isolates page UI by default. Use
`{ isolateUi: false }` explicitly to retain it. `sampleTurn` always retains normal
HUD rendering and is the final ordinary-frame gate.

After the user's OS/Xcode setup:

1. Verify the active Xcode, Instruments/Metal System Trace availability, and the
   native command-line tools actually included with that version. Rebuild this
   probe and record the new OS, browser, driver, power and thermal environment.
2. Establish a **new before baseline on the upgraded system**. Do not compare an
   old-system before value with a new-system after value as an optimization gain.
3. Trace normal HUD-on rotation and a scene-only replay separately. Identify
   compositor versus WebGPU command buffers, GPU scheduling, vertex/fragment stage
   overlap and the available shader/bandwidth counters. Investigate the HUD's
   backdrop/animation cost without removing visible effects.
4. Select a targeted change from that evidence. Repeat ordinary-frame ABBA/reverse
   pairs with matched clocks/background activity and an A/A noise control. Retain
   raw outliers and fail unstable comparisons; do not substitute a frequency-scaled
   estimate or isolated replay throughput for actual elapsed frame time.
5. Enable a default only after a stable ordinary-frame GPU reduction and image,
   picking and interaction checks. Until then, keep the current production path.
