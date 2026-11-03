# Frame submission and light-shaft work, 2026-11-02

This comparison starts from `0a12646`, including the previous packed varying,
opaque terrain and CPU visibility improvements. Ultra resolution, 4x MSAA,
4096px native shadows, geometry budgets, AO, clouds, bloom and FXAA are unchanged.

## Implementation

Native submits shadow, scene and offscreen post-processing before requesting a
window drawable. The final FXAA/UI command uses the same Metal queue, preserving
execution order. Waiting for its completion fences both commands and all data
in the frame's dynamic resource slot. Missing drawables still retain a fence for
already submitted scene work. Non-Ultra and screenshot paths retain the original
single-command path. Screenshot readback temporarily disables `framebufferOnly`.

FXAA and egui continue in one render encoder on the same attachment, retaining
the original pipeline formats, blend state, clipping and draw order. Normal
drawable textures use `framebufferOnly`. This follows Apple's guidance to
[acquire drawables late](https://developer.apple.com/library/archive/documentation/3DDrawing/Conceptual/MTLBestPracticesGuide/Drawables.html)
and [merge compatible render encoders](https://developer.apple.com/library/archive/documentation/3DDrawing/Conceptual/MTLBestPracticesGuide/RenderCommandEncoders.html).
The Web UI is DOM-based and its presentation is browser-managed, so these Metal
changes do not have a direct Web equivalent.

An excluded experiment tested skipping color fetches for light-shaft taps whose depth
proves that their weight is zero. All 24 positions, decay steps and contributing
samples remain. Native additionally skips the loop when projected sun visibility
is zero; Web already had that check. This experiment was removed from both
production renderers after measurements failed to establish a portable benefit.
The accepted native implementation retains the previous shaders byte for byte.

## Protocol

- Native frozen render tests: 128 Aether zones, identical geometry, 720p/1440p,
  20 balanced short A/B batches per motion, 480 samples per variant.
- Native window: 1788x2178, Ultra 100%, VSync disabled only for measurement,
  normal streaming, physics, UI layout and presentation. After loading and a
  24-second moving warm-up, eight candidate/reference blocks are interleaved
  with eight identical-code control blocks. Every block excludes two seconds
  and samples four seconds along the same moving path. Focus, occlusion,
  size and successful drawable submission are checked. Player saves are read
  but never written.
- Web: Chrome, 2560x1440 backing canvas, Ultra 100%, 4x MSAA and shadows.
  The normal moving path and a sun-facing moving path use balanced A/B blocks,
  followed by a sun-facing repeat and identical-code control. Frozen captures
  include visible, edge and hidden sun poses, plus picking checks.

Builds, tests and other benchmark renderers are stopped during timed samples.
The clients use their existing different LOD budgets; these are within-client
comparisons. Window FPS counts completed render/present-loop iterations, not
unique display scanouts. Native GPU spans include scheduling gaps between the
scene and final command; they are not isolated busy time or FPS estimates.

## Excluded experiments

Merging the final pass and skipping zero-weight taps without early scene
submission produced 152.7 to 154.4 FPS in the first window run, approximately
1.1%, within its roughly 1.5% identical-code control difference. It does not
establish a frame-rate improvement. Mean drawable waits were about 3.3 ms,
motivating early scene submission. See
[first-window.json](../src/dev/results/frameflow-2026-11-02/first-window.json).

The first late-drawable run completed and wrote all 16 blocks, then hit an
already queued redraw after requesting event-loop exit. The app now ignores
redraws while the event loop is exiting. Its samples are retained separately;
a clean-exit replication follows below. This earlier experimental version still
included the subsequently removed shader branch and measured 220.8 to 225.6 FPS
(+2.2%; identical-code label difference -0.9%). It is retained in
[window-early-excluded.json](../src/dev/results/frameflow-2026-11-02/window-early-excluded.json).
Desktop/compositor conditions vary substantially; a gain under one level of
drawable pressure is not a universal speedup guarantee.

The seven initial standard image pairs were also invalid as frozen comparisons:
`optimized()` skipped its initial timed rounds in these modes, so cloud time
remained animated until the later moving benchmark. It now freezes cloud time
at entry. The 30 dedicated UI/sun image pairs already froze time explicitly.
The earlier small near-view differences are retained in
[native-unfrozen-images-excluded.json](../src/dev/results/frameflow-2026-11-02/native-unfrozen-images-excluded.json)
and are not presented as a visual cost of the accepted submission change.
Timed GPU results are unaffected because each timed method already freezes time.

## Native foreground window results

The retained implementation completed two clean-exit runs on Apple M1 Pro.
Both remained focused and unoccluded at 1788x2178, with 128/128 distant zones
and 11,283,518 resident faces at the beginning of measurement. All four candidate
blocks in each run exceed all four reference blocks. No builds, tests or other
benchmark renderers ran during these samples.

| Run | Previous FPS | Optimized FPS | Gain | Identical-code label difference |
|---|---:|---:|---:|---:|
| 1 | 147.39 | 172.05 | +16.7% | +5.2% |
| 2 | 147.83 | 165.43 | +11.9% | -0.7% |

These are actual render/present-loop completion rates with VSync off, not unique
monitor scanouts. Normal VSync defaults are unchanged. The cleaner second
control supports a benefit beyond measurement noise; the first run alone would
have overstated precision. The magnitude depends on compositor/drawable pressure.

Mean frame intervals improve from 6.785 to 5.812 ms and 6.765 to 6.045 ms.
The p95 intervals improve from 15.937 to 12.976 ms in run 1 but only from 15.913
to 15.571 ms in run 2. This establishes higher average throughput, not elimination
of long frames.

Mean drawable acquisition drops from 4.173 to 2.507 ms and 4.195 to 2.826 ms.
CPU encoding increases slightly, while part of the wait moves to the in-flight
fence. The completed frame's GPU timeline span increases from about 10.9 to
13.3-13.4 ms because it now starts before drawable acquisition and includes
scheduling gaps; it must not be interpreted as isolated GPU busy time or inverted
into FPS. The frozen render results below show no established GPU work reduction.

Per-block timings, aggregate frame distributions and production source hashes:
[run 1](../src/dev/results/frameflow-2026-11-02/window-run1.json),
[run 2](../src/dev/results/frameflow-2026-11-02/window-run2.json).
The adjacent `.json.gz` files retain every raw frame/GPU/visible-face sample.

## Native quality and resource validation

After fixing the capture clock, **all seven standard image pairs and all 30
sun/UI pairs are pixel-identical**. The Metal shader source is byte-identical
to `0a12646`. Quality, geometry, shading and contributing samples are unchanged.

The 36-frame queued-resource check also matches its reference exactly, including
four injected unavailable-drawable events after scene submission. All 20 shadow
invalidation cases match, and the 144-frame ordered visibility comparison passes.
These checks exercise the new two-command fence rather than only the offscreen
single-command wrapper. See [native.json](../src/dev/results/frameflow-2026-11-02/native.json).

Frozen GPU timings do not establish a gain. The final moving GPU medians are
3.990 to 4.171 ms at 720p and 6.018 to 5.978 ms at 1440p; moving with UI is
4.007 to 4.167 ms and 5.906 to 5.919 ms. The preceding run, before the diagnostic
capture-clock fix, had much smaller differences. No production shader changed
between these runs. This submission optimization targets compositor overlap;
offscreen measurements do not include drawable acquisition and should not be
used to claim an equivalent GPU workload reduction.

Native format checks, Clippy, 31 Rust tests and four Node integration tests pass.
Client type checking, application tests, production build, bundle guards and
documentation links pass. The repository-wide English-only check still reports
275 existing lines in native README/RENDERING/MIGRATION; this change adds no
new non-English text. Benchmark sessions preserve the native player save hash.

## Web experiment: rejected

Two fixtures completed their main run, moving repeat and identical-code control:
64 timed blocks, 17,035 frames and 2,836 GPU samples. Every one of the 176 frozen
image/control rows is pixel-identical and preserves picking. The sun-facing path
records sun visibility of 1; the ordinary path records 0, so the experiment
exercises both relevant shader paths.

| Sun-facing movement | Reference FPS | Candidate FPS | Reference GPU ms | Candidate GPU ms |
|---|---:|---:|---:|---:|
| Aether main | 118.61 | 117.31 | 6.671 | 6.725 |
| Aether repeat | 118.52 | 118.12 | 6.705 | 6.867 |
| Copper main | 91.84 | 90.42 | 7.873 | 8.175 |
| Copper repeat | 91.89 | 92.30 | 7.990 | 7.858 |

Identical-code control label differences were +0.48% FPS / +0.89% GPU duration
for Aether and +1.76% FPS / +2.96% GPU duration for Copper. Aether is also near
the browser/display cadence ceiling. The results do not support enabling the
branch: Aether GPU time rises in both runs, and Copper reverses direction within
control variation. Fewer source-level texture operations do not establish less
GPU execution time; shader compilation and branching must be measured.

Web production code is unchanged. No unrelated quality reduction or unproven
optimization was substituted. The experiment's source is archived in
[web-sparse-excluded.patch](../src/dev/results/frameflow-2026-11-02/web-sparse-excluded.patch),
with [validated summaries](../src/dev/results/frameflow-2026-11-02/summary.json)
and raw compressed samples in the sibling world directories. Nature was not
run because the candidate had already failed the acceptance criterion in both
tested fixtures. PNG originals remain in the ignored browser capture directories.

## Reproduction

```sh
sh native-space/tools/bundle.sh
native-space/target/release/space-native --profile-frameflow --world=aether-archipelago --lod-zones=128
'native-space/build/Space Native.app/Contents/MacOS/space-native' --profile-window-frameflow --world=aether-archipelago
```

Keep the window focused and visible. Run each benchmark separately. Native raw
samples and PNGs are generated under `native-space/results/`. To reproduce the
rejected Web experiment, apply the archived patch to `0a12646` in a separate
checkout, run the local development server and loopback result receiver, then open
`/space/app/tools/visibility-browser.html?trial=sparse&world=aether-archipelago`.
Use the same URL with `copper-metropolis` for the second measured fixture.
The summary tool accepts an explicit world list:

```sh
node client/tools/summarize-visibility.mjs client/src/dev/results/frameflow-2026-11-02 aether-archipelago copper-metropolis
```
