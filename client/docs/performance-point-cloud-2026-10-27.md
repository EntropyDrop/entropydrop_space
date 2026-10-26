# Opaque point-cloud terrain experiment — 2026-10-27

The [interactive comparison](performance-point-cloud-2026-10-27.html) includes the original PBR renderer, a matching simple-light rectangle control and three opaque point implementations. The optional offline modules do not change production rendering or saved graphics defaults.

## Measured result

**Keep the existing packed geometry. None of these point representations demonstrates a convincing overall speed advantage over matching rectangles in this workload.** Opaque surfels give the best image of the point variants, but they use more data and their small advantage over original PBR is also available with rectangles. Native one-pixel points leave visible holes. Compute points add clear/reduction/composite work and even more holes with this pixel filter.

The main capture contains **120 blocks, 33,392 frames and 5,565 GPU samples**. A separate Aether movement replication adds **20 blocks, 5,686 frames and 947 GPU samples**. Each mean pools measured frames within that run; the replication is not silently substituted for the main capture.

### Actual FPS

| Terrain / motion | Original PBR | Matched rectangles | Native 1 px | Opaque surfels | Compute 1 px |
| --- | ---: | ---: | ---: | ---: | ---: |
| Aether / turn | 120.0 | 120.0 | 119.6 | 118.4 | 120.8 |
| Aether / move | 106.3 | 111.4 | 103.1 | 109.8 | 106.2 |
| Nature / turn | 120.1 | 120.0 | 120.0 | 120.0 | 120.0 |
| Nature / move | 119.8 | 120.1 | 119.8 | 119.9 | 120.0 |
| Copper / turn | 120.0 | 120.0 | 120.0 | 120.0 | 120.3 |
| Copper / move | 75.2 | 79.2 | 78.5 | 80.0 | 77.9 |
| Aether / move replication | 111.9 | 115.1 | 113.3 | 114.5 | 111.8 |

All turn tests are close to the display's 120 Hz cadence. Small readings above 120 come from short-window frame scheduling and are not evidence of higher uncapped throughput.

Aether native movement includes one 241.2 ms animation-frame interval in a block that measured 88.7 FPS; its other three blocks measured 106.7, 110.0 and 107.3 FPS. The long interval is not explained by the measured animate CPU duration, and no cause is assigned without a trace. The original data is retained. A fresh snapshot and full five-mode replication did not reproduce that outlier. All replication modes had a faster baseline than the first session, so compare candidates within each run rather than combining the sessions into a single claimed gain.

Surfel movement is +3.2% against original PBR in the Aether main run and +2.3% in the repeat, but -1.5% and -0.5% against matching rectangles. Copper is +6.3% against PBR, while matching rectangles already gain +5.2%; surfels exceed rectangles by only 1.0%, less than the observed block variation. Nature remains presentation-limited. These results do not isolate a meaningful gain from point representation.

### Full-frame GPU span while moving

Lower is better; these spans include compute and composition.

| Terrain | Original PBR ms | Matched rectangles ms | Native ms | Surfel ms | Compute ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Aether | 2.684 | 2.602 | 2.487 | 2.857 | 3.389 |
| Nature | 2.042 | 1.876 | 2.062 | 2.373 | 3.011 |
| Copper | 3.075 | 3.119 | 2.821 | 3.094 | 4.624 |
| Aether replication | 2.620 | 2.642 | 2.498 | 2.723 | 3.644 |

Native points can reduce GPU span in Aether and Copper, at much lower image coverage. Surfels do not improve moving GPU span versus original PBR in these three main captures. Compute raises it by roughly 26%, 47% and 50% in Aether, Nature and Copper. Its three compute passes are present in every sampled compute timeline.

Ordinary animate CPU averages while moving are 6.07 / 4.03 / 10.72 ms for original Aether / Nature / Copper. Native points use 6.78 / 4.92 / 10.91 ms; surfels use 6.17 / 4.59 / 10.55 ms; compute uses 6.91 / 4.98 / 11.00 ms. The candidate source selection and index upload alone cost about 0.45–1.27 ms per frame. Faster primitive rasterization therefore does not translate directly to faster complete frames. GPU span is not a complete measure of browser composition or all system work.

### Visible coverage and stability

The across-ring frozen captures expose the far layer. Missing percentages use the matched rectangle signal mask, not the PBR picture.

| Terrain | Native missing signal | Surfel missing signal | Compute missing signal | Surfel signal outside reference |
| --- | ---: | ---: | ---: | ---: |
| Aether | 22.61% | 0.24% | 52.45% | 8,985 pixels |
| Nature | 41.70% | 0.25% | 69.90% | 7,915 pixels |
| Copper | 29.13% | 0.34% | 59.87% | 6,390 pixels |

Native and compute pictures have perforated distant silhouettes and a noisy response to tiny camera turns. Surfels keep a continuous surface, but broaden edges, show square samples and can close genuine gaps. During the three tiny yaw steps, the missing-signal mask changes by about 31–72 thousand pixels for native points, 46–87 thousand for compute, and 298–865 for surfels. This is a diagnostic mask-change count, not a perceptual flicker score.

All 30 main PNGs are retained at 2560 × 1440. Near-facing Copper has only 77 reference-visible far pixels, so that particular view is a preservation check, not a useful far-quality stress test. Frozen candidate repeats and restored original images match, picking is identical, and no GPU validation errors occur in accepted captures. Frozen source fallback is zero. During ordinary moving LOD publication, up to five Aether and one Nature source entries fall back to original geometry; Copper has none. The repeat has up to three Aether fallbacks. These small fallbacks are included in frame timings and raw data.

### Storage and construction

| Terrain | Selected original faces | Original face-record MiB | Dense points / MiB incl. order | Surfels / MiB incl. order | Snapshot build s |
| --- | ---: | ---: | ---: | ---: | ---: |
| Aether | 794,089 | 12.12 | 2,906,965 / 99.80 | 1,063,318 / 36.51 | 2.44 |
| Nature | 584,294 | 8.92 | 2,874,896 / 98.70 | 1,108,379 / 38.05 | 2.51 |
| Copper | 962,655 | 14.69 | 2,752,847 / 94.51 | 1,097,789 / 37.69 | 2.67 |

Compute adds 28.13 MiB of framebuffer depth/ID storage. These are representation data sizes, not measured whole-process VRAM savings: all variants coexist during A/B, and original allocator overhead, staging and other scene buffers are excluded. Build time measures CPU snapshot generation including cooperative yields; it excludes later shader creation and GPU upload. Sampling requests are coarsened by the allocation cap; the exact scale is recorded rather than describing these as hole-free 1 px or 2 px surface grids.

The existing greedy rectangles already cover large flat areas with compact 16-byte records. A point replacement often needs many samples for the same area, and the opaque surfel implementation turns every sample back into a quad. That is why point count and record bytes can grow even though each primitive sounds simpler.

### Recommendation and scope

Keep packed quads as the production default. If optimizing further, profile the existing batching and source-culling path suggested by the rectangle control, then test that improvement on original geometry separately. The control changes more than lighting, so its gain cannot yet be credited to one specific change.

The point paths remain optional DEV/offline experiments. This result applies to these three torus fixtures, this Apple WebGPU environment, Medium quality, these budgets and short paths. It does not establish a universal limit on point renderers. A production hierarchy with compressed samples, GPU source compaction, adaptive resampling and a better coverage filter would be a different implementation with additional development and measurement costs.

## Implementations

| Mode | Representation | Lighting and coverage |
| --- | --- | --- |
| Original | Existing packed greedy quad faces | Existing PBR, emission, fog and MSAA |
| Rectangles | Reconstructed original face rectangles, source-batched | Matching quantized face brightness, emission and fog |
| Native points | Native WebGPU one-pixel point primitives | Same sampled positions/colors as compute; hardware MSAA coverage |
| Opaque surfels | Instanced screen-facing square point samples | Coarser surface sampling; projected size, depth test/write; no alpha blending |
| Compute points | Software one-pixel point rasterization using compute shaders | Deterministic nearest-depth and lowest-ID tie breaking; fullscreen depth-writing composite |

The snapshot includes only entire settled source entries whose conservative bounds are at least 768 m from the bent camera. Original near and middle-distance terrain, physics, picking, HUD, sky and tools remain active. Source edits or publications invalidate affected samples and restore original geometry. A 64 m motion guard protects the immutable snapshot. There is no incremental production point-cloud streaming implementation.

Samples are generated on the actual original flat quad surfaces and then bent with the existing torus function. Sampling is a regular grid with cell-center points, separated by face; it does not fit Gaussian moments or merge across gaps. Grid density uses the initial camera focal length, bent edge lengths and conservative source distance. An allocation guard adjusts requested density to at most three million dense samples and approximately 1.2 million surfel samples, with enough budget to retain at least one sample per source face. The final density multipliers and exact counts are retained in each result. Resident samples and density levels are fixed during this short movement test; surfel screen size changes continuously with camera depth. This is a screen-density-based snapshot, not a fully dynamic hierarchy that resamples the scene as the camera travels.

Point records are 32 bytes: bent position/source, packed color/emission, packed normal and world-space sample diameter. Rectangle records are also 32 bytes, with flat position, source, spans, direction and packed color. The current production quad record is 16 bytes. Each candidate also has a 4-byte order index per resident element. Source-level frustum/validity culling constructs a compact contiguous order buffer on the CPU; points receive normal-facing tests on the GPU. No CPU point sorting or individual CPU point projection is used.

All non-PBR modes use the same quantized flat-face brightness, original emissive luminance and exponential fog. The rectangle control shares the new source batching/culling path and is an algorithm control, not a pure material-only change to the production renderer. A difference between original and rectangles can include shading, batching, record layout and culling effects. The point-versus-rectangle comparison is needed to avoid attributing all cheaper shading to point rendering.

The surfel diameter is 1.15 times its projected world sample spacing, clamped to 1–6 physical pixels. It uses ordinary opaque depth testing/writing, without Gaussian alpha profiles or transparency sorting. Its large-point coverage can expand silhouettes and fill real gaps.

The compute renderer runs three compute passes: clear the per-pixel depth/ID buffers; select the minimum positive float-depth bit pattern with atomicMin; select the lowest point ID among equally nearest samples. A fourth, ordinary fullscreen draw reads the winning color and writes its depth into the normal scene, so nearer terrain and tools still occlude it. Separate passes avoid depth/color races. It uses 8 bytes per framebuffer pixel for depth and winner buffers, about 28.13 MiB at 2560 × 1440, in addition to point/order buffers. All compute passes and composition are included in full-frame GPU timing.

Native points and compute share identical resident data and source-culling indices. Their pixel filters differ: the scene uses 4× MSAA, allowing a native one-pixel square to affect neighboring sample locations; compute selects one whole pixel per point and fills that pixel during composition. A compute speed result is therefore not proof of equal image coverage. There is no hole filling, temporal accumulation or reconstruction network.

## Workloads and controls

- Local Apple / Metal 3 WebGPU, 1280 × 720 CSS viewport, DPR 2, 2560 × 1440 framebuffer, Medium lighting, shadows off, four scene samples and fixed resolution scale 1. Exact adapter model is not exposed by the browser.
- Aether, Nature and Copper use the existing offline world LOD stress fixtures. This is not a live-server or network-streaming benchmark. Exact distant settings, camera positions and resident counts are recorded.
- Nature is raised to Y = 180 m; Aether remains at Y = 180 m and Copper at Y = 128 m. The opposite side of the ring is visible in both timed motions.
- Across-ring yaw: pitch 1.35 rad, yaw pi/2 + 0.6 sin(2 pi t). Across-ring movement adds X = 16 sin(2 pi t), Z = 8(1 − cos(2 pi t)). Ordinary simulation and LOD publication remain active.
- Each motion uses four interleaved repetitions per mode, 1 s warmup plus 2.5 s sampling. The 20-block order is A B C D E / E D C B A / C E A D B / B D A E C. A is original, B rectangles, C native points, D surfels, E compute. Separate shader/JIT warmups are excluded.
- FPS is 1,000 divided by pooled mean animation-frame duration. CPU is the complete ordinary animate call. GPU is the first-to-last pass timestamp span, including all compute and composite passes; it is not a GPU busy-time counter. Near-120 FPS results are presentation limited.
- Frozen captures use original, rectangle, native, surfel, compute, omitted far layer, then repeat every candidate and restore original. Pixel identity, picking identity, GPU errors and invalid-source fallbacks are checked. Main timing does not contain PNG readbacks or shader construction.
- Tiny-turn probes advance yaw by 0.0007 rad for four poses. Each pose captures matching rectangles, an omitted layer and the three point modes. These provide a local aliasing/coverage diagnostic, not a long-motion temporal-quality score.

## Image metrics

Reference-visible pixels are those where matched rectangles differ from the omitted-layer control by more than six RGB byte levels. Missing signal counts those pixels where the candidate differs from the omitted layer by at most two levels. Signal outside that reference mask is reported separately. These are color-based coverage estimates; they do not exactly count geometric holes or measure perceptual quality. In particular, different MSAA filters affect this metric.

The tiny-turn metric counts changes in the binary missing-signal mask between neighboring poses. Some change comes from ordinary projected motion and edges. It indicates sensitivity to a subpixel turn and must not be reported as a precise flicker frequency or amount.

## Reproduction

Use `?world=aether-archipelago&dev_offline=1&dev_lod=world&dev_dpr=2` on the local game; repeat with `nature` and `copper-metropolis`. Temporarily enable distant terrain, use Medium lighting and Ring projection, disable torus backface culling, and wait for original LOD to settle. Save/restore Nature's position around elevation to Y = 180 m. Match the viewport and fixed resolution.

Import [PointCloudExperiment](../src/dev/PointCloudExperiment.ts) through the local Vite `/@fs/` URL and run `await runPointCloudExperiment(game)`. The harness prewarms the moving path, captures samples, checks pixels, excludes warmup frames and records both timed motions. For the separate Aether movement replication, pass `{ movingRepeat: true }`; it repeats pixel checks and excluded warmup before 20 moving blocks. It disposes experimental resources and hooks in a finally block. The caller restores temporary far enablement and camera setup afterward.

The [summary](../src/dev/results/points-2026-10-27/summary.json) is generated by [the summarizer](../tools/summarize-point-cloud.mjs). Main captures for [Aether](../src/dev/results/points-2026-10-27/aether-archipelago/raw.json.gz), [Nature](../src/dev/results/points-2026-10-27/nature/raw.json.gz) and [Copper](../src/dev/results/points-2026-10-27/copper-metropolis/raw.json.gz), plus the [Aether repeat](../src/dev/results/points-2026-10-27/aether-archipelago/repeat.json.gz), are retained. Compressed `raw.json.gz` captures contain frames, GPU timelines, image metrics and metadata. PNG data URLs are exported as separate files before compression. Regenerate the summary and run checks with:

```sh
node client/tools/summarize-point-cloud.mjs
npm --prefix client run typecheck
npm --prefix client run check:docs
npm --prefix client run check:english
```

## Background

[Three.js PointsNodeMaterial](https://threejs.org/docs/pages/PointsNodeMaterial.html) documents the WebGPU one-pixel point restriction. The [compute point-cloud paper](https://arxiv.org/abs/2104.07526) and [VTK WebGPU compute mapper](https://vtk.org/doc/nightly/html/classvtkWebGPUComputePointCloudMapper.html) motivate opaque depth reduction and depth composition. Their published speedups are not used as measurements of this game.
