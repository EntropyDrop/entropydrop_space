# Firefox visibility experiments — 2026-10-27

> Update: [Fast CPU and wider reuse are now in production](performance-visibility-integration-2026-10-27.md). The measurements below retain their original capture-time state.

Firefox 153 completed **192 blocks, 39,113 measured frames and 6,514 whole-frame GPU timestamp samples** across Aether, Nature and Copper. These are native Firefox measurements, not Chromium emulation. Production rendering and default settings remain unchanged.

The same four algorithms from the [community and paper study](performance-visibility-research-2026-10-27.md) were tested: original packed PBR, one-distance Fast CPU, wider conservative CPU reuse, and stable GPU culling with indirect draws. The [interactive report](performance-visibility-firefox-2026-10-27.html) includes all 24 main-run near/across PNGs, separate repeats and identical-code controls.

## Moving results

### Main run

| World | Original FPS | Fast CPU FPS | Wide CPU FPS | GPU indirect FPS |
| --- | ---: | ---: | ---: | ---: |
| Aether | 71.3 | 74.0 (+3.8%) | 76.8 (+7.8%) | 60.6 (-15.0%) |
| Nature | 90.9 | 93.1 (+2.4%) | 94.7 (+4.2%) | 86.5 (-4.9%) |
| Copper | 55.2 | 58.4 (+5.7%) | 60.5 (+9.5%) | 50.2 (-9.2%) |

### Independently warmed repeat

| World | Original FPS | Fast CPU FPS | Wide CPU FPS | GPU indirect FPS |
| --- | ---: | ---: | ---: | ---: |
| Aether | 73.9 | 75.6 (+2.4%) | 77.2 (+4.4%) | 62.0 (-16.1%) |
| Nature | 91.7 | 93.3 (+1.7%) | 89.9 (-1.9%) | 89.1 (-2.9%) |
| Copper | 53.5 | 57.1 (+6.8%) | 58.2 (+8.8%) | 48.1 (-10.0%) |

All gains use the baseline from the same run. The identical-code control runs the original renderer under every label. Its largest absolute label-vs-baseline differences were **Aether 4.37%, Nature 2.75%, Copper 4.18%**. These are observations of order/session noise, not confidence intervals or a correction to subtract from results.

- **Fast CPU remains the smallest and most promising change.** Copper improves 5.7–6.8% in Firefox, versus 9.8–11.8% in the preceding Chromium configuration. Its CPU time falls about 0.94–0.96 ms. Aether's 2.4–3.8% and Nature's 1.7–2.4% FPS changes fit inside their observed control spread; this Firefox session does not establish stable FPS gains for those worlds. Their measured CPU reductions are approximately 0.45–0.52 ms and 0.16–0.28 ms, with coarse CPU timer resolution and control variation.
- **Wide CPU has a narrower recommendation.** Copper improves 8.8–9.5%, with about 1.32–1.63 ms less CPU work. Aether improves 4.4–7.8%, but the repeat is at the observed control spread. Nature changes from +4.2% to -1.9%, so there is no repeatable FPS benefit there. The existing wider-cache correctness limitations still apply.
- **This GPU-indirect implementation is still not recommended.** Moving Aether loses 15–16%, Copper loses 9–10%, and Nature loses 3–5%. It increases full-frame GPU span in all three worlds. This result concerns this implementation, not every GPU-driven architecture.

Firefox exposes more headroom below the presentation limit, but does not universally magnify optimization gains. The prior research recommendation remains: retain packed geometry and prioritize the small CPU arithmetic change for a separately reviewed production integration. Do not enable the GPU experiment or assume wider reuse helps every world.

## Frame costs

Per-frame means; CPU and GPU overlap and must not be added to predict FPS. GPU spans include the visibility compute passes and the normal render passes. Draw counts are actual submitted commands, including zero-instance indirect commands. GPU-mode triangle counters remain nominal.

| World / mode | CPU ms | GPU ms | Arena ms | Draw calls |
| --- | ---: | ---: | ---: | ---: |
| Aether / Original | 10.017 | 1.976 | 3.389 | 40.936 |
| Aether / Fast CPU | 9.495 | 2.062 | 2.969 | 40.995 |
| Aether / Wide CPU | 8.867 | 2.049 | 2.426 | 46.902 |
| Aether / GPU indirect | 11.502 | 4.210 | 2.903 | 142.683 |
| Nature / Original | 6.352 | 1.216 | 1.995 | 29.212 |
| Nature / Fast CPU | 6.072 | 1.200 | 1.725 | 29.207 |
| Nature / Wide CPU | 5.880 | 1.158 | 1.595 | 30.766 |
| Nature / GPU indirect | 6.731 | 2.299 | 1.605 | 59.990 |
| Copper / Original | 14.281 | 2.041 | 4.508 | 49.973 |
| Copper / Fast CPU | 13.345 | 2.135 | 3.633 | 49.859 |
| Copper / Wide CPU | 12.648 | 2.362 | 2.972 | 56.421 |
| Copper / GPU indirect | 15.451 | 4.838 | 3.261 | 139.771 |

For example, Copper GPU mode increases CPU time from 14.28 to 15.45 ms and GPU span from 2.04 to 4.84 ms. Submitted draw calls rise from about 50 to 140. Moving work to compute did not eliminate the original source-map and command-submission costs.

## Images and correctness

There are 225 frozen image rows: 135 candidate comparisons, 45 original references and 45 restored-original comparisons. **Every candidate comparison differs by at most one RGB-byte level; no pixel differs by more than two levels.** Unlike the preceding Chromium capture, Fast CPU is not byte-exact in every Firefox comparison. Do not describe the Firefox images as strictly identical.

All 45 restored-original images are byte-exact, picking matches throughout, and all 45 GPU buffer checks have zero missing required blocks and zero ordering errors. Near, across, cached-step, guard-step and return poses were checked. The figures show the near/across views; the remaining checks are stored numerically. These samples do not establish correctness for every FOV change, rapid transition, world edit or crossing of the wider cache guard.

All nine accepted captures have zero reported GPU errors and pass per-frame compute-pass/timestamp validation. No new GPU pages are allocated inside accepted timed frames. Ordinary LOD publication remains active: one Aether main Fast CPU block changes resident faces from 2,133,250 to 2,133,266. Its repeat and control have constant residency, as do all Nature and Copper blocks. The 16-face change is retained and disclosed rather than silently discarding that block. Occasional long frames are retained too.

## Environment and comparison limits

- Native Firefox 153 on the same macOS computer; WebGPU and `timestamp-query` are available. Firefox exposes empty adapter identification fields, so no GPU model is inferred from them.
- Fixed 1280 × 720 CSS iframe, DPR 2, 2560 × 1440 framebuffer, Medium lighting, shadows off, 4× scene MSAA, FOV 75, fixed resolution scale. Start overlay and developer tools were closed before timed frames. Physics, HUD and live LOD work remain active. Visibility and framebuffer dimensions are checked during sampling.
- 64 px² distant subdivision, 2048-chunk range, torus surface backface filtering off. **Firefox automatically selected a 776 MiB data budget and a 512 MiB geometry budget; the previous Chromium capture used 512 / 160 MiB.** Camera starting positions also differ slightly, and Chromium's timed page was top-level while Firefox uses the launcher iframe. Resident face counts and draw grouping are not identical across browsers. This is an internally controlled Firefox algorithm trial, not a matched browser-speed ranking. Do not attribute all differences from Chromium to its JavaScript or GPU backend.
- Each mode has four interleaved blocks per motion: 1 s warmup, then 2.5 s measured frames. Main captures include turn and move; repeat and control captures include move. The order is A B C D / D C B A / C A D B / B D A C. PNG encoding, buffer verification, initialization and result uploads occur outside measured blocks. No build, typecheck or other benchmark ran during sampling.
- Firefox CPU duration samples in this session are quantized to whole milliseconds. Means across many frames can be fractional, but small differences should be interpreted alongside the control spread. GPU timestamps are a separate measurement. No browser timer or security settings were changed.
- The accepted launcher session ran from 02:54 to 03:11 UTC. The earlier downloaded ZIP contains only an initialization timeout and browser metadata: **zero usable performance frames**. It is preserved under `attempt-1` and excluded from all totals. A longer initialization guard allowed diagnosis; the accepted run initialized each world in seconds. Startup time is not FPS.

## Reproduction and artifacts

The [browser launcher](../tools/visibility-browser.html) uses the same DEV trial code as the first study. It only runs on loopback development pages. Keep at least a 1280 × 844 browser viewport so the full fixture remains visible, then select **Run all three worlds**. Only `autorun=1` starts automatically; add `probe=1` for image/GPU-map checks only. Initialization has a separate 300-second guard.

For automatic local capture, start `node client/tools/visibility-result-receiver.mjs client/src/dev/results/visibility-firefox-2026-10-27` from the repository root before opening the launcher. The receiver listens only on `127.0.0.1:54379`, accepts the configured local development origins and whitelisted capture filenames, and creates one timestamped directory per page load. Stop it after capture. If unavailable, **Download results** exports a ZIP. The receiver used for this run has been stopped.

The accepted [raw captures and images](../src/dev/results/visibility-firefox-2026-10-27/firefox-1793069674578/), [browser metadata](../src/dev/results/visibility-firefox-2026-10-27/firefox-1793069674578/browser.json) and [validated summary](../src/dev/results/visibility-firefox-2026-10-27/firefox-1793069674578/summary.json) are retained. Rebuild the summary with:

```sh
node client/tools/summarize-visibility.mjs client/src/dev/results/visibility-firefox-2026-10-27/firefox-1793069674578
```

The optional directory argument preserves the original Chromium default when omitted. The validator checks image counts, dimensions, restoration, picking, GPU maps, block counts, actual modes, positive frame durations and per-frame GPU compute-pass coverage. Research sources and implementation details remain in the [original study](performance-visibility-research-2026-10-27.md).
