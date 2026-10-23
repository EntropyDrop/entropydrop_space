# Turning GPU regression: independent timelines and hardware telemetry

## Outcome

No new rendering optimization is enabled by this follow-up. The production
renderer and Arena are byte-for-byte identical to this turn's starting files.
The earlier compact visibility map remains disabled. The new tools and the
timestamp cleanup fix are development-only.

The regression is concentrated in the main scene's GPU interval. It is not an
extra output-pass cost, extra buffer uploads, pipeline compilation, or a larger
CPU gap between the main and output submissions. GPU frequency varies materially
between runs, so the earlier 6-8% result cannot be interpreted as a 6-8% increase
in shader work. Independent queries still reproduce a longer frame interval;
the exact cache/occupancy/scheduling mechanism is **not established**.

## What was added

- `GpuFrameTimeline.ts`: an independent timestamp query set with explicit slot
  ownership for render and compute passes, exact mapped ranges, raw nanoseconds,
  wall-clock alignment, pass labels, attachment operations, queue submission
  times, and upload sizes. It records overlapping and uncovered intervals
  separately and restores its hooks and GPU buffers after use.
- `GpuTurnReplay.ts`: a deterministic angular sweep that renders the complete
  scene and output pipeline in four-frame batches. Simulation, input and
  presentation are excluded. CPU submission gaps may remain in this diagnostic;
  its per-frame GPU envelope is not a GPU busy counter or game FPS.
- `sample-gpu-hardware.mjs`: finite, local JSONL collection of GPU frequency,
  active residency, power and temperature using `macmon`. It refuses to overwrite
  an existing file and does not start a service or add an application dependency.
- `guardTimestampWrites`: r183 keeps `timestampWrites` on a cached render-pass
  descriptor after `trackTimestamp` becomes false. The development profiler now
  clears these writes on unsampled frames and on teardown. The independent probe
  also clears stale descriptor writes before assigning its own query slots.
- `GpuAttachmentExperiment.ts`: a reversible, development-only experiment that
  discards private MSAA color/depth contents after their final use. Resolved color,
  sampled depth, shadows, custom render targets and load passes are preserved.
  It is excluded from production and has no default setting.

Installed and verified **macmon 0.8.2** through Homebrew. `xctrace` cannot run
because only Command Line Tools are installed; `powermetrics` requires an
administrator password. macmon successfully provides rootless hardware telemetry.
These counters are system-wide, not per-application GPU busy time or shader
occupancy. No clock lock, power-mode change or other application shutdown was used.

## Measurement conditions

Apple M1 Pro, 16 GPU cores; the same local offline Aether stress fixture as the
previous batch: 128 repeated districts, 153 nearby chunks and 2,089,207 resident
far faces. Canvas 2560 x 1440, CSS 1280 x 720, DPR 2, Medium lighting, shadows off,
fixed 100% scale. Automatic far shutdown was temporarily bypassed during probes.

The ordinary sweep is +/-0.6 radians about yaw pi/2, pitch 0.35, with an eight-second
period. Each run settles and warms for three seconds, then measures 24 seconds,
querying one frame in six. ABBA order provides both forward and reverse pairs.
Builds, tests, screenshots and readback comparisons were kept outside timing.
Comparisons below are within the same page load; totals from separate loads are
not pooled. Display cadence remained approximately 120 Hz.

The metric is the interval from the first GPU pass start to the last pass end.
It can contain dependency waits and scheduling delays. Pass durations are not
summed to represent elapsed GPU time. On Dawn's Metal backend the render-pass
timestamps delimit vertex start and fragment end, allowing consecutive pass
envelopes to overlap. See the [Dawn implementation](https://dawn.googlesource.com/dawn/+/refs/heads/main/src/dawn/native/metal/CommandBufferMTL.mm)
and [Apple's GPU timeline explanation](https://developer.apple.com/documentation/xcode/analyzing-apple-gpu-performance-using-a-visual-timeline).

## Independent-query compact-map comparison

| ABBA run | Frame GPU mean | Main pass mean | Output tail after main | Mean GPU frequency |
| --- | ---: | ---: | ---: | ---: |
| Original map A1 | 3.2783 ms | 3.0123 ms | 0.2660 ms | 696 MHz |
| Compact map B1 | 3.3081 ms | 3.0379 ms | 0.2702 ms | 691 MHz |
| Compact map B2 | 3.3173 ms | 3.0461 ms | 0.2712 ms | 691 MHz |
| Original map A2 | 3.0772 ms | 2.8073 ms | 0.2699 ms | 796 MHz |

Equal weighting of the two run means: **3.1777 -> 3.3127 ms (+4.25%)**.
All runs have valid independent timestamps and zero new render pipelines.

The output tail remains about 0.27 ms. Its apparent pass duration includes
roughly 1.33-1.45 ms of overlap with the main pass; it is misleading to call that
entire duration additional post-processing work. Main-to-output CPU submit gaps
average 0.081-0.094 ms and do not grow with compact maps. Average uploaded bytes
fall from approximately 109-111 KB/frame to 77-88 KB/frame in queried frames.

Frequency changes are a measured confound: the second original-map run is faster
at a higher average clock. This does not prove that frequency explains all of the
regression, or that compact maps caused the frequency change. Temperature was
falling during this sequence, so temperature alone is not a sufficient explanation.
We do not frequency-normalize these timestamps into a claimed performance win.

The legacy-query audit reproduced the same direction before this independent
comparison. An initial independent readback implementation requested more bytes
than were mapped; its invalid rows are retained only in the query-audit archive
and are excluded from every result above. The exact-range behavior now has a
regression test and successful real-GPU validation.

## Targeted experiments

The compact shader repeats address/header expressions in generated WGSL. Two
selective `.toVar()` experiments cached either the block address or the whole
map vector. Neither consistently improved native far-only GPU time over the
existing compact shader. A direct-index variant added a guard map entry to
remove the final-instance clamp; it also failed to produce a stable benefit.
All three shader experiments were reverted.

| Native far-only replay, paired run means | GPU per replay |
| --- | ---: |
| Original map, address experiment | 1.3860 ms |
| Existing compact map | 1.3435 ms |
| Compact + cached address | 1.3586 ms |
| Compact + cached map vector | 1.3934 ms |
| Original map, direct-index experiment | 1.3968 ms |
| Original map + direct index | 1.3974 ms |
| Compact map, direct-index experiment | 1.3383 ms |
| Compact map + direct index | 1.3613 ms |

These are the actual render bundles, 16 passes per command buffer, 32 warm-up
batches followed by 32 measured batches. They exclude near geometry and output
processing. The deterministic complete-scene replay is retained as additional
evidence; it has order-dependent variation and is not substituted for ordinary
frame measurements.

The attachment experiment targets the main pass's final stores. Keeping the
resolved image while discarding the unused multisample image is supported by
[WebGPU's conformance tests](https://github.com/gpuweb/cts/blob/main/src/webgpu/api/validation/render_pass/resolve.spec.ts)
and [Metal's multisample resolve store action](https://developer.apple.com/documentation/metal/mtlstoreaction/multisampleresolve).
The application never subsequently samples the private depth attachment in this
path. Ultra's sampled depth and custom targets are excluded from this experiment.

| Both private attachments discarded | Before | Candidate | Change |
| --- | ---: | ---: | ---: |
| Complete-scene four-frame replay | 1.5689 ms | 1.5350 ms | -2.16% |
| Ordinary rotation, forward pair | 3.2911 ms | 3.3107 ms | +0.59% |
| Ordinary rotation, reverse pair | 3.2114 ms | 3.1716 ms | -1.24% |
| Ordinary rotation, equal run means | **3.2513 ms** | **3.2411 ms** | **-0.31%** |

The ordinary-frame result changes sign between pairs. It fails the requirement
for a stable reduction in actual GPU elapsed time and is **not enabled**.

## Image, interaction and validation

The attachment candidate passes two complete warmed image/picking comparisons:
16 unique views per pass (four orientations x Medium/Ultra x shadows off/on).
All RGB differences are zero; all aim-ray picking results are identical and all
images are nonempty. These are sampled states, not an exhaustive proof over all
world content. Default rendering has no production-code change in this follow-up.

Twelve focused tests pass, including overlap accounting, partial readback ranges,
render/compute slot ownership, stale timestamp removal, hook/buffer cleanup and
attachment exclusions/restoration. TypeScript and inventory checks pass. The
production build passes its development-entry exclusion, four import-order
checks and compiler-worker checks. Full client results and source hashes are
recorded in the checks artifact linked below.

## Reproduction and evidence

Start Vite and open
`/space/app/?dev_offline=1&world=aether-archipelago&dev_lod=world&dev_perf=1&dev_dpr=2`.
Click Play, release pointer capture and close the profiler before an explicit
benchmark. Use the existing development module import mechanism and call:

```ts
await sampleTurn(game, 'reference', {
  gpu: true, timeline: true, motion: 'sweep', durationMs: 24000,
});
await sampleGpuAttachments(game); // reversible ABBA experiment; never persists
```

Collect hardware telemetry concurrently, using a new output path:

```sh
node client/tools/sample-gpu-hardware.mjs /tmp/space-gpu-hardware.jsonl 180
```

The deterministic replay accepts explicit `apply()` callbacks. Its caller owns
restoring the chosen rendering variant; the helper always restores camera,
animation, timestamp tracking and GPU query resources.

- [Summary with pass, upload and hardware statistics](../src/dev/results/gpu-turn-summary-2026-10-23.json)
- [Starting source hashes](../src/dev/results/gpu-turn-baseline-manifest-2026-10-23.json)
- [Validation and final source hashes](../src/dev/results/gpu-turn-checks-2026-10-23.json)
- [Independent compact ABBA raw data](../src/dev/results/gpu-turn-native-abba-2026-10-23.json.gz)
- [Compact ABBA hardware telemetry](../src/dev/results/gpu-turn-native-hardware-2026-10-23.jsonl.gz)
- [Legacy/initial query audit, including rejected invalid rows](../src/dev/results/gpu-turn-query-audit-2026-10-23.json.gz)
- [Address caching trials](../src/dev/results/gpu-turn-address-trial-2026-10-23.json.gz)
- [Direct indexing trials](../src/dev/results/gpu-turn-direct-trial-2026-10-23.json.gz)
- [Attachment isolation replay](../src/dev/results/gpu-turn-store-isolation-2026-10-23.json.gz)
- [Attachment ordinary frames and pixel/picking checks](../src/dev/results/gpu-turn-store-frames-2026-10-23.json.gz)
- [Attachment hardware telemetry](../src/dev/results/gpu-turn-store-hardware-2026-10-23.jsonl.gz)

Raw JSON is losslessly gzip-compressed. Rejected experiments are evidence,
not recommended production settings. Native shader occupancy/cache counters
remain unavailable in this environment; this report does not claim to have
proven a specific hardware stall mechanism.
