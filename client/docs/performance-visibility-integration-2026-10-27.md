# Production visibility integration and upload follow-up — 2026-10-27

**Fast CPU plus wider conservative visibility reuse are now the production defaults.** The subsequent differential-upload experiment remains DEV-only because it did not show a repeatable whole-frame advantage. Geometry, materials, lighting settings and GPU indirect submission are unchanged. See the [interactive report](performance-visibility-integration-2026-10-27.html).

## Production change

[The arena](../../engine/src/render/VoxelFaceArena.ts) computes one Float64 square-root distance per position block and shares it between normal-cone and frustum decisions. Cached and uncached paths use the same facing predicate. Query reuse changes from 16 m / 0.06 plane-normal delta to **32 m / 0.12**. Matching rejection slack changes from 18 m / 0.061 to **34 m / 0.121**. Nearby view-flattened geometry remains exempt from bent-space rejection.

The slack bounds accepted camera translation, camera-relative plane-offset changes and normal changes. Projection changes, visibility switches and coverage updates invalidate dependent data. Empty-frustum transitions now bypass the small-change guard, including recovery from a negative zero-normal plane with a small offset. The optional lossy torus-surface filter receives the wider motion slack too; its default remains off.

This increases the range over which results are reused, not a memory-budget setting. It can submit extra geometry. Fast CPU and wider reuse are cumulative; their gains cannot be added together. Reversible DEV hooks retain legacy and Fast-only references and restore production policy when disposed.

## Measured results

Accepted: **144 moving blocks, 37,848 frames and 6,304 GPU timestamp samples**, including independently warmed repeats and identical-code controls.

### Main run

| World | Legacy FPS | Fast-only FPS | Production FPS | Upload trial FPS |
| --- | ---: | ---: | ---: | ---: |
| Aether | 111.5 | 115.5 | 116.3 | 117.0 |
| Nature | 119.9 | 120.0 | 120.0 | 119.9 |
| Copper | 75.9 | 87.2 | 88.8 | 88.9 |

### Repeat

| World | Legacy FPS | Fast-only FPS | Production FPS | Upload trial FPS |
| --- | ---: | ---: | ---: | ---: |
| Aether | 109.1 | 114.2 | 115.8 | 116.2 |
| Nature | 119.6 | 120.0 | 120.0 | 120.0 |
| Copper | 77.2 | 85.8 | 89.8 | 87.7 |

Production improves moving FPS **4.3–6.2% in Aether** and **16.3–17.0% in Copper**. Nature stays around 120 FPS while CPU time falls approximately **0.37–0.41 ms**. CPU reductions are approximately 0.65–0.92 ms in Aether and 1.95–2.07 ms in Copper.

Maximum absolute label-vs-baseline FPS differences in identical-code controls were **0.79%, 0.29% and 1.76%** for Aether, Nature and Copper. These are observed noise, not confidence intervals. Every label executes legacy code during controls. Copper's final control uses a separate page load and original-only images; it is not a paired statistical correction to its main run.

## Follow-up: differential uploads

[The DEV trial](../src/dev/VisibilityUploadTrial.ts) compares new mapping records with existing data, skips identical ranges and updates the span between the first and last changed component. Pending ranges are preserved. Source records and draw ordering remain unchanged.

Marked map-update bytes fall **84–86% in Aether, 78% in Nature and 83–85% in Copper**, relative to production. This is a buffer-range counter, not measured physical bus traffic. Additional FPS changes are:

- Aether: +0.65% and +0.33%, inside the control spread.
- Nature: -0.08% and -0.02%, near the presentation limit.
- Copper: +0.18% and -2.33%; CPU time increases by about 0.09 and 0.03 ms.

**Keep this experiment out of production.** Array comparisons consume CPU time and lower update volume does not establish a whole-frame improvement here. GPU spans cover render passes, not transfer work before those passes. Ordinary-frame FPS and CPU timing remain the decision metrics.

## Validation and limitations

The engine suite passes **660 tests** and the client suite **1,655 tests**. New regressions cover both sides of the 32 m guard, reversal and teleportation, FOV/aspect/clip changes, projection switches, stationary geometry replacement and empty-frustum recovery. Required blocks are checked against current-frustum spheres and independent normal-cone predicates. A separate surface-normal test covers accepted translations for the optional torus filter. Existing coverage, fade, storage and draw-order tests still pass.

There are **225 accepted frozen image rows**, including 120 candidate comparisons and 45 restored-original checks. Candidate differences are at most one RGB level. Every restored-original image is byte-exact and picking matches. Copper's accepted main/repeat captures include **50 GPU-map readbacks**, with zero mismatched words. All accepted frozen captures have constant resident geometry.

The screenshot harness now pauses LOD publication and synchronous rebuilding while retaining camera culling. Pausing simulation alone was insufficient: rendering still updates the distant view, and asynchronous readbacks allowed terrain generations to change between images. Publication resumes before timed frames. Earlier accepted Aether/Nature images preceded this harness correction, but recorded residency was constant and strict restoration passed.

A later Copper candidate-control return image still differed by one RGB level after publication was frozen. It was rejected. A separate control comparing only repeated original images passed the unchanged strict-equality rule. No tolerance was relaxed. Copper main and repeat had already passed candidate and restoration checks. This distinction is preserved in the artifacts rather than describing every attempted capture as exact.

Live LOD stays active during timing. One Aether Fast-only repeat block changes residency by 30 faces, from 2,133,035 to 2,133,065; other accepted blocks keep residency constant. This event and long frames remain in the samples. The initial filename-rejection attempt and failed image attempts are excluded; [provenance](../src/dev/results/visibility-integration-2026-10-27/accepted/provenance.json) lists the accepted source sessions and exclusions. Session metadata and failure logs remain beside accepted data.

## Reproduction

Chromium 156 in the in-app browser, WebGPU on the same Apple computer. Firefox was in active use, so this round used an independent browser fixture. Compare variants within each run rather than absolute FPS with the preceding Firefox or GPU-culling experiments. This run never warms or switches into indirect geometry.

1280 × 720 CSS iframe, DPR 2, 2560 × 1440 framebuffer, Medium lighting, shadows off, 4× MSAA, fixed resolution, 64 px² subdivision, 2048-chunk range, **512 / 160 MiB data/geometry budgets**, and torus-surface backface filtering off. Nature uses Y = 180 m. Actual camera positions are retained per capture.

Four interleaved blocks per mode use 1 s warmup and 2.5 s sampling. The order is A B C D / D C B A / C A D B / B D A C: legacy, Fast-only, production, upload trial. Main/repeat/control all use the moving-across-ring path. Physics, HUD and LOD publication stay live. Initialization, PNG encoding, readbacks, saving, builds and typechecks are outside timed frames.

Open the [launcher](../tools/visibility-browser.html) with `trial=production&autorun=1`. Add `world=copper-metropolis` for one world, `run=control` for the independent control, or `probe=1` for image-only checks. The receiver setup is in the [Firefox report](performance-visibility-firefox-2026-10-27.md); the task's receiver has been stopped.

Regenerate the [validated summary](../src/dev/results/visibility-integration-2026-10-27/accepted/summary.json):

```sh
node client/tools/summarize-visibility.mjs client/src/dev/results/visibility-integration-2026-10-27/accepted
```

Typechecking, English-only text, documentation links, the production build and production-entry isolation checks pass. These single-device offline results do not guarantee gains on every map or GPU.
