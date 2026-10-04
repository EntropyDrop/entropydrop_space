# Near terrain streaming

## Firefox camera rotation (2026-10-05)

The entry gate now compiles resident terrain pipelines in all directions with
`compileAsync` before its final GPU completion fence. Hidden terrain is included,
retired source attributes are excluded, and native bundle groups are temporarily
opened because Three r183's compiler does not process their render lists.
Compilation uses Ultra's HDR target when that is the active terrain pass. All
visibility, culling, bundle and target state is restored before gameplay.

Far ownership classification also covers offscreen tiles. Their settled faces
can finish migration into shared GPU storage during loading; looking at them
for the first time no longer creates storage pages or retires source attributes.
The arena always allows one bounded copy before enforcing its soft time budget,
so a coarse browser clock cannot starve the last pending source.

Firefox 153.0.1 on this Mac reproduced approximately 1 FPS while turning in the
default online terrain at `http://localhost:5173/space/app/`, with a callback gap
of about 1.8 seconds. An isolated 8-second full-turn comparison, retaining the
ownership fix but bypassing pipeline warmup, recorded a 925 ms maximum gap;
the repeated turn peaked at 34 ms. After a fresh reload of the fixed build,
complete 8-second first and repeated turns averaged 68.4 and 68.6 callback FPS.
Their maximum gaps were 25.86 and 25.82 ms, with no frames above 33.33 ms.
The [raw comparison](../src/dev/results/firefox-rotation-2026-10-05.json)
preserves both diagnostic and final samples. These measurements use Ultra, shadows off,
1912 x 957 pixels, 1,511,059 resident LOD faces, and a fixed test resolution
selected from the existing Auto scale. Callback FPS does not measure compositor
presentation, and GPU timestamps exclude browser/driver compilation stalls.

The development profiler is available on the normal local entry with
`?dev_perf=1`; **Measure full rotation** retains current terrain and sweeps the
camera 360 degrees twice. Its timed sweep starts after the warmup interval.
The temporary pipeline-bypass switch used for diagnosis has been removed.
Regression tests cover hidden-tile migration without work on rotation, progress
with a coarse clock, pipeline state restoration after success/failure, and the
entry gate waiting for compilation. Full validation passed 475 engine and
1,048 client tests, excluding the same three previously documented baseline
failures. Type checks, generated assets/contracts, documentation checks and
the production build passed.

## Streaming and publication

The terrain worker starts its next eligible chunk as soon as a result arrives,
with at most four completed results awaiting publication. Finished generation
also publishes during render frames, even without local edits or idle time.
A standard/micro conversion barrier delays only its own chunk; independent
results can pass it. Jobs awaiting publication are excluded from redispatch.

Micro detail uses a separate worker for background mesh construction. The main
thread captures sparse immutable cell snapshots, including the six neighboring
partitions and wrapped torus boundaries. The worker expands the halo and runs
the existing WASM mesher, transferring compact geometry buffers back. There are
at most 16 outstanding partitions, and result publication shares the update
slice's time/count limits. Queue order follows player distance; direct edits keep
priority and use the existing budgeted local mesher for immediate feedback.

Only an update slice publishes mesh and collision state. Revision checks reject
obsolete results, and authoritative snapshot barriers remain atomic. An evicted
or blocked result returns to the dirty queue. Worker failure falls back to local
meshing. Empty partitions cleared after an outgoing terrain fade are retired
even outside the active AOI, preventing hidden meshes and dirty-queue scans from
accumulating after movement.

The far terrain, effects, shaders, projection, terrain detail density and render
distance are unchanged. The 12 modified/untracked files present before this
work were verified byte-for-byte unchanged, including the September 28 far
terrain maintenance and cinematic effects optimizations.

## Measurements

Codex in-app browser, local Copper fixture, seed 20260922, medium lighting,
100% resolution, shadows off, 153 near chunks, no accounts/network/entities or
far surface data. `dev_stream_busy=1` grants no browser idle time, only the
50 ms timeout callbacks. From (8200, 128, 1032), **Move to new chunks** moves
256 m along X. In the final repeat, all standard and micro meshes reached
ready in about **2.9 s**. After settling: about **120 FPS**, main CPU p50
**1.6 ms**, p95 **1.8 ms**;
3,002 micro partitions, 152 draw meshes. These are local fixture measurements,
not an online loading-time guarantee or a before/after FPS comparison.

Run the independent CPU comparison with:

```sh
node --import ./engine/test/setup.ts engine/tools/benchmark-near-streaming.ts
```

It compares the local and actual worker paths using the same 36,432 Copper
cells in nine chunks (771 partitions), 1.25 ms meshing slices, and timer pacing
targeting 60 Hz. It excludes initial worker startup, generation, network and GPU
rendering. One run produced:

| Path | Main-thread CPU total | Time to publication | Update p95 |
| --- | ---: | ---: | ---: |
| Local | 824 ms | 7.29 s | 4.97 ms |
| Worker | 312 ms | 2.35 s | 6.12 ms |

Both geometry digests were identical. Timers, JIT and host load affect these
numbers. The slice deadline is cooperative: geometry publication and render
batch copies are synchronous, so a faster total load does not imply a lower
worst-frame cost. The bounded worker queue also bounds result bursts.

## Validation

`engine/test/near-terrain-streaming.test.ts` covers exact geometry/materials,
vertical and wrapped seams, nearest-first work, editing during a full queue,
stale results, AOI eviction, authoritative snapshot blocking, atomic collision
publication, worker failure, bounded terrain lookahead and independent progress
past a blocked chunk. Existing terrain, collision, remote snapshot, LOD handoff
and rendering tests are also run.

The earlier performance report documents three pre-existing unrelated failures:
one WASM LOD equivalence test, the Agent Build authorization-copy test and the
wrench COM pick test. Full-suite validation for this change skips those named
cases rather than changing their expectations.

Final validation: 427 engine tests and 1,000 client tests passed with those
three cases excluded. Both TypeScript checks, the production build, the
English-only check and documentation-link validation passed. The production
build includes the micro worker and excludes the development fixture.

## Settled near rendering (2026-10-04)

Fully owned near chunks now use the original material without the handoff
texture read or fragment discard. Incomplete and outgoing coverage uses a
shared masked variant, reclassified before each draw. Both variants share the
same deformation, normal and emission nodes; the masked variant also preserves
classic shading properties and the emissive render-target callback. Cloned
node materials are recognized as already bent. Source or ownership-texture
disposal retires the extra variant once.

When the active renderer has shadows disabled, the near frustum test no longer
keeps every mesh within the 80 m shadow-protection ring. Enabled shadows retain
the existing caster visibility. Main and entity-preview cameras each use their
renderer state. These changes keep resident terrain, meshing density, detail
distance, graphics preferences and cross-layer publication unchanged.

The development Frame Profiler adds **Compare near materials**, **Compare near
drawing**, pixel checks and completed-work probes. Temporary switches restore
after each comparison and do not write preferences.

The [raw measurements](../src/dev/results/near-rendering-2026-10-04.json) use
local Aether and Nature fixtures, 153 ready near chunks, a 2560 x 1440 drawing
buffer and fixed 100% resolution. There are no far snapshots, entities or live
server traffic. Timed comparisons use OFF / ON / OFF, 1.5 seconds of warm-up
and four seconds of sampling. GPU pass queries sample one in six frames.

| Fixture and settings | Before / repeat | Optimized |
| --- | ---: | ---: |
| Aether, Medium, shadows off, material only: GPU p50 | 2.42 / 2.42 ms | 2.03 ms |
| Nature, Medium, shadows off: GPU p50 | 3.28 / 3.08 ms | 2.29 ms |
| Nature, Medium: CPU p50 | 1.90 / 1.90 ms | 1.70 ms |
| Nature, Medium: draw calls | 128 / 128 | 78 |
| Nature, Medium: submitted triangles | 189,797 / 189,797 | 113,829 |
| Nature, Ultra, shadows on: average frame cadence FPS | 112.5 / 114.0 | 119.4 |

Medium frame cadence remained around 120 FPS, without an established FPS
improvement. Ultra GPU query samples did not show a consistent reduction
(18.55 / 19.86 ms versus 19.92 ms), despite the faster cadence in this run.
GPU samples sum render passes and exclude presentation; do not add CPU/GPU
times or infer online performance from these fixtures.

The Nature completed-work probe uses 12 batches of four renders, awaiting GPU
completion after each batch with simulation and timestamp sampling suspended.
Median work per render was 1.77 / 2.27 ms for the reference/repeat and 1.28 ms
optimized. This excludes browser presentation; repeat drift remains in the
record and prevents a precise general speedup claim.

At fixed camera/simulation, culling alone produced zero changed pixels. Combined
Medium changes affected 683 of 3,686,400 pixels, with maximum RGB delta 1; Ultra
with shadows affected 887 pixels, with maximum delta 2. Aether's material-only
check affected 1,277 pixels with maximum delta 1. Every reference repeat was
identical. These small shader-rounding differences are recorded rather than
claimed as bit-identical output.

Validation includes five near-material/culling regression cases, fade reversal,
wrapped child origins, shared variants, shading and emission preservation,
disposal, camera turns and shadow restoration. The engine suite passed 469
tests with the documented unrelated WASM LOD equivalence case excluded, followed
by final culling/projection checks. The client suite passed 1,015 tests and
reproduced the two previously documented Agent Build and Wrench COM failures;
the 16 preview tests passed after the final renderer integration. Both type
checks and the production build passed.

### Copper Metropolis follow-up

The [Copper measurements](../src/dev/results/copper-near-rendering-2026-10-04.json)
use generator version 2, seed 20260922, the same 2560 x 1440 buffer and 153
ready near chunks. Copper contains 7,347 micro partitions batched into 153
micro draw meshes. The aerial eye position is (8200, 129.62, 1032), with the
fixture's original view. The street eye position is (8200, 2.67, 1032), yaw 0,
pitch 0.12, facing nearby architecture. Moving vertically keeps the same
resident chunks; the player remains stationary and flying. These are local
offline fixtures without far snapshots, entities or server traffic.

Every timed row uses OFF / ON / OFF repeat. FPS rows below use timestamp
sampling disabled; the separate GPU rows use one query every six frames.
Medium uses shadows off, while Ultra uses shadows on and full post-processing.

| Camera, settings and metric | Before / repeat | Optimized |
| --- | ---: | ---: |
| Aerial, Medium: FPS without GPU sampling | 121.0 / 122.2 | 123.1 |
| Aerial, Medium: GPU p50 | 3.15 / 3.60 ms | 2.49 ms |
| Aerial, Ultra: FPS without GPU sampling | 125.7 / 121.7 | 120.4 |
| Aerial, Ultra: GPU p50 | 11.80 / 11.21 ms | 10.22 ms |
| Street, Ultra: FPS without GPU sampling | 92.6 / 94.3 | 105.4 |
| Street, Ultra: GPU p50 | 25.23 / 23.27 ms | 18.55 ms |
| Street, Ultra: completed-work p50 per render | 7.48 / 7.35 ms | 5.85 ms |
| Street, Ultra: calls / submitted triangles | 453 / 1,506,692 in both controls | 453 / 1,506,692 |
| Street, Medium: GPU p50 | 4.26 / 3.74 ms | 2.16 ms |
| Street, Medium: CPU p50 | 2.90 / 2.90 ms | 2.50 ms |
| Street, Medium: calls | 245 / 245 | 133 |
| Street, Medium: submitted triangles | 822,335 / 822,335 | 528,925 |

Street Ultra improves average FPS by approximately 12–14% against both
controls. The run with GPU sampling enabled also improves from 94.1 / 94.6
to 106.4 FPS. CPU p50 stays around 4.0–4.2 ms, and geometry submissions stay
identical: the opaque material path provides the benefit while shadows keep
the conservative caster visibility. Frame p95 remains around 16.7 ms, and
1% low FPS only changes from 54.3 / 54.9 to 56.1; this does not establish a
large improvement in occasional slow frames.

Street Medium reduces GPU p50 by approximately 42–49%, draw calls by 46% and
submitted triangles by 36%. Its sampled FPS is 120.8 / 124.5 versus 123.0,
so no FPS improvement is established at that cadence. The aerial view also
does not establish an FPS improvement. GPU pass queries and completed-work
probes measure different scopes; neither is interchangeable with presented
frame time.

Fixed street pixel comparisons change 112 pixels in Ultra and 262 in Medium,
out of 3,686,400, with maximum channel delta 1/255 and zero differences in
both reference repeats. Aerial Medium changes 4,237 pixels with maximum
delta 1. Aerial Ultra changes 3,814 pixels: 120 exceed delta 2, with maximum
delta 34 at one pixel. The same material-only differences persist without
shadows; disabling Ultra post-processing reduces maximum delta to 5. This
isolates an amplification by post-processing, without establishing the exact
shader-level cause. The aerial reference repeat remains identical. Visual
inspection found no missing terrain, but Ultra is not pixel-identical.
The raw [reference](../src/dev/results/copper-ultra-reference-2026-10-04.png)
and [optimized](../src/dev/results/copper-ultra-optimized-2026-10-04.png)
aerial renders preserve that evidence, alongside the
[street render](../src/dev/results/copper-street-ultra-2026-10-04.png) and
[street screenshot](../src/dev/results/copper-near-rendering-2026-10-04.png).
The UI screenshot closes the profiler for visibility, so its reset draw
counters are not authoritative; use the timed JSON reports for draw counts.

This follow-up changes only measurement artifacts and this documentation;
runtime code and persisted graphics preferences are not changed. Existing runtime
validation above still applies.
