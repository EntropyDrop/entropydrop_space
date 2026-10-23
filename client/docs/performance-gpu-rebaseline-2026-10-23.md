# GPU rebaseline and transient MSAA color storage

## Outcome

**No new production optimization is enabled.** The color-only attachment candidate
looked promising in repeated comparisons, but final integration and identical-code
controls did not pass the stability gate. Its provisional production adapter was
removed. SceneRenderer, SpaceRenderer, Arena, distant layer and CSS match the
starting source hashes exactly. Graphics, HUD, controls and picking are unchanged.
Color/depth disposal and compact visibility maps remain development experiments.

The user confirmed that macOS/Xcode had not yet been upgraded and requested work
in the current Codex environment. This is a fresh baseline on macOS 26.5.1 (25F80),
Apple M1 Pro, Codex IAB / Chromium 155, not an OS-upgrade comparison. Full Xcode
and `xctrace`, `gpucapture`, `gpudebug`, `metalperftrace` are still unavailable.
The retained changes improve measurement and auditability. There is no claimed
production before/after speedup in this report.

## Before and candidate: ordinary game frames

Same settled Aether stress fixture: 2,089,207 resident far faces, 153 near chunks,
1280 x 720 CSS viewport, DPR 2, 2560 x 1440 drawing buffer, Medium, shadows off.
The gameplay HUD remains visible. The start overlay and development profiler are
closed. Each run warms for three seconds after the workload settles. No tracing,
builds, tests, screenshots or pixel readbacks run during these measurements.

| Motion and order | Duration per run | Before GPU mean | Candidate GPU mean | Change | Before / candidate GPU p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Sweep, ABBA | 32 s | 2.9862 ms | 2.8615 ms | -4.18% | 3.9977 / 3.9322 ms |
| Rapid, BAAB | 32 s | 2.7928 ms | 2.7430 ms | -1.78% | 3.9977 / 3.9322 ms |
| Rapid repeat, ABBA | 48 s | 2.8755 ms | 2.6889 ms | -6.49% | 4.0632 / 3.8011 ms |

A is the previous `store` behavior; B discards only the unused multisample color
attachment after preserving the resolve. These are independent pass timestamps
from ordinary animated game frames, not replay FPS. Each table distribution pools
the two runs of its treatment within that quartet; different quartets are not
pooled into a single advertised percentage. FPS remains approximately 120, so no
FPS increase is claimed. The metric is first GPU pass start to last pass end;
it is an elapsed envelope, not hardware busy time or browser presentation latency.

One adjacent pair in the initial rapid quartet regressed by 0.85%; the other pair
improved. That mixed result prompted the longer reverse-order repeat, rather than
being omitted. Both pairs in that repeat improved. All five color-only interleaved
runs also improved: -3.23%, -2.03%, -4.00%, -4.28%, -4.51%. These results justified a provisional integration, but the final audit below
rejected default enablement. They are retained candidate observations, not accepted
production gains.

## Final audit: why the candidate was not enabled

The actual integrated switch preserved all 16 warmed pixel/picking comparisons,
and the recorded descriptors confirmed exactly the intended change: main-pass
multisample color `store` to `discard`, with depth and output color still `store`.
However, its final interleaved rapid run regressed. The order subsets differed
strongly, so a seeded schedule was added: every pair still contains ABBA and BAAB,
but a deterministic hash randomizes which comes first. This tests the hypothesis
of correlation with the periodic camera/compositor; it does not assume that this
hypothesis explains all noise.

| Audit | Reference GPU mean | Candidate-label GPU mean | Observed change |
| --- | ---: | ---: | ---: |
| Integrated sweep | 2.2625 ms | 2.2106 ms | -2.30% |
| Integrated rapid | 2.2703 ms | 2.3129 ms | **+1.88%** |
| Randomized identical-code control, before | 2.2671 ms | 2.3310 ms | **+2.82%** |
| Randomized color candidate, seed 99 | 2.3134 ms | 2.2237 ms | -3.88% |
| Randomized color candidate, seed 12345 | 2.3380 ms | 2.1998 ms | -5.91% |
| Randomized identical-code control, after | 2.3186 ms | 2.2270 ms | **-3.95%** |

Randomized runs last 48 seconds each, retaining normal gameplay HUD and animation.
Only complete eight-observation pairs enter their comparison; excluded tail counts
are 7, 2, 3 and 4 respectively, with all raw observations retained. The integrated
rapid comparison excludes one incomplete-quartet tail observation. The last control
runs identical code in both roles: its apparent 3.95% improvement is measurement
variation, not optimization. That variation is comparable to the candidate effect,
and randomization did not remove it. The final decision is therefore conservative:
retain the original renderer and do not advertise the favorable earlier samples
as a stable production gain.

## Controlling measurement interference

Four initial, unchanged-code 24-second sweeps measured 3.2388, 3.0788, 3.3726 and
3.1190 ms. This substantial drift makes a single before/after run insufficient.
`sampleTurn` now accepts a synchronous render-state `variant`. GPU observations
alternate ABBA and BAAB quartets while simulation, HUD and rotation continue.
Each raw observation records its independent treatment role, quartet, position
and order. An optional `variant.orderSeed` reproducibly randomizes balanced pairs.
The analysis retains all raw samples and excludes only incomplete quartets from
the balanced comparison, reporting their counts. Identical-code controls measured
-0.40% for sweep and +0.98% for rapid motion. Individual order subsets are noisier;
they remain in the evidence rather than being cherry-picked.

Interleaving is only appropriate for synchronous renderer changes. CSS changes
and browser composition are asynchronous and must not be compared using this
switch. A failing variant setter now schedules the animation successor so cleanup
can restore the game loop.

The native AGX probe and macmon sampled per-process accounting, system utilization,
frequency, power and temperature concurrently. Their samples are aligned to each
run's wall-clock timestamps. No clocks, power settings, background applications or
services were changed. Thermal state stayed nominal and low-power mode was off.

The candidate did not obtain its gains from a higher *mean observed* GPU frequency:
approximately 828 vs 853 MHz in the steady sweep comparison, 885 vs 891 MHz in the
first rapid comparison, and 877 vs 884 MHz in the repeat. WindowServer and Firefox
continued to contribute GPU activity; their per-process rates are recorded.
One-second frequency samples cannot exclude subsecond DVFS, and shared-process
accounting cannot separate the game from the Codex compositor. This work reduces
and measures interference; it does **not** claim a locked clock or an idle system.
No GPU duration is frequency-normalized into a reported improvement.

## HUD and main-scene diagnosis

Chromium GPU/Viz/Dawn tracing is available through the current Codex tab. With the
scene animation loop suspended and its queue drained, two complete three-second
captures recorded:

| Diagnostic capture | Metal submission events | Viz render-pass events | Skia paint events |
| --- | ---: | ---: | ---: |
| Normal HUD | 1,934 | 2,924 | 2,091 |
| HUD temporarily hidden | 613 | 1,386 | 681 |

Both captures report no data loss. These are shared-process event counts, not
GPU-time savings or isolated hardware utilization. The corresponding Dawn trace
begins around command-buffer submission and ends in its completion callback;
it must not be interpreted as a pure hardware execution interval. See the
[Dawn Metal queue implementation](https://dawn.googlesource.com/dawn/+/refs/heads/main/src/dawn/native/metal/QueueMTL.mm).
The HUD is restored after diagnosis and remains unchanged in production.

An initial detailed trace and a first short trace overflowed their buffers and
are excluded. HUD `will-change` experiments made under intrusive tracing also had
large reference drift; no performance conclusion or default CSS change follows
from them. The retained successful recipe limits tracing to three seconds in one
tool invocation, uses a 32 MiB buffer, and includes only `gpu`, `viz`, and
`gpu.dawn.gpu_work`. Trace collection is separate from performance acceptance.

UI-suppressed, complete-scene native command replay was also rebuilt. Both views
matched their live canvases with zero RGB differences before timing. In the turned
view, a 1-pixel main-pass scissor reduced elapsed time by 14.24%, while omitting the
far bundle reduced it by 60.77%. In the near view the reductions were 19.51% and
62.46%. These removals change the image and are diagnostic only. They support
prioritizing distant geometry and work before fragment shading, not pixel fill
alone. They do not distinguish vertex ALU, cache stalls or saturated bandwidth.
Public Metal enumeration still exposes timestamp counters only.

## Retained tools and rejected alternatives

`GpuTrialOrder.ts` and `sampleTurn.variant` provide balanced fixed or seeded
interleaved comparisons. The seed is validated before any hooks are installed.
GPU roles remain distinct in A/A controls. A throwing setter resumes animation
following cleanup; a real-browser injected failure verified that frames continue,
query/render hooks restore by identity, and temporary styles are removed.

`GpuAttachmentExperiment.ts` remains development-only. Its r183 adapter requires
an owned multisample output framebuffer, a resolve target, clear passes and
automatic clearing; it preserves resolved color. Tests cover single-sample
outputs, absent resolve targets, load passes, disabled automatic clearing,
sampled depth, custom targets, late backend assignments and restoration.
The color-only candidate passed images but failed the final performance audit.
Discarding color and depth together was also inconsistent: ordinary rapid
interleaved tests changed by +1.44% and -4.80%. Depth-only disposal had only one
small sweep result. Neither attachment option is enabled in production.

To reproduce a color-only trial, install `installTransientFrameAttachments` in the
local offline fixture with a local mode variable. Pass a `sampleTurn.variant`
whose setter changes that mode between 0 and 1, and restore the adapter in `finally`.
Use explicit seeds for randomized comparisons and include identical-code controls.
Use separate settled runs for continuous-version ABBA/BAAB validation. Do not use
CSS/compositor mutations as synchronous variants, or benchmark during tracing.

HUD layer hints remain unadopted. No shader, Arena, distant-layer or CSS change is
included. The provisional `SceneRenderer` switch and production helper were both
removed after the final audit; there is no disabled production hook left behind.

## Verification and evidence

The initial color-only pixel test had a first-entry Ultra difference also present
in the repeated reference (862 pixels, maximum channel delta 8). A warmed repeat
passed all 16 combinations of four views, Medium/Ultra and shadows off/on:
zero RGB changes and identical picking, with nonempty images. The initial result
is retained. Experiment hooks were restored after each full comparison.

Final integration checks confirmed all 16 warmed comparisons, intended descriptors,
and failure cleanup. Integration was then rolled back, and source hashes verify
that production files match the starting state. Check results are recorded in the
linked summary; the full application run has the same three previously recorded
failures (entity-menu-icons and two shovel-cursor tests).
After rollback, all 11 focused tests, TypeScript/inventory checks and the production
build pass. The build verifies development-code exclusion, four import orders and
compiler-worker recovery. The full application run during provisional integration
passed 1,520 of 1,523 tests; it was not repeated after removing that integration.
A final browser smoke check confirms the production candidate switch is absent,
all main/output store operations are restored, and no GPU validation error occurs.
The temporary browser tab was closed and the viewport override reset.

- [Summary, telemetry alignment and source hashes](../src/dev/results/gpu-rebaseline-summary-2026-10-23.json)
- [Raw measurements, complete traces and reproduction script](../src/dev/results/gpu-rebaseline-raw-2026-10-23.json.gz)
- [Final scene with unchanged HUD](../src/dev/results/gpu-rebaseline-final-scene-2026-10-23.png)

The archive is a JSON object mapping original filenames to their exact text.
`summarize-gpu-rebaseline.py` rebuilds the measurement summary from extracted raw
files in `/private/tmp`; final validation and source hashes are attached afterward.
