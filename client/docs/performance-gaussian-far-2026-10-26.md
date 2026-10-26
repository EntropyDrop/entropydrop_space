# Extreme far Gaussian LOD experiment — 2026-10-26

This procedural Gaussian prototype is not a better default than the current packed terrain renderer. In the visible far-terrain workload, Aether falls from 119.9 FPS to 104.1–105.0 FPS and Copper from 120.0 to 85.0–86.4 FPS. Nature remains close to the 120 Hz limit, but its GPU span rises from 1.919 ms to 4.349–4.448 ms. The replacement also blurs silhouettes, joins small gaps and loses block detail.

[Open the interactive image comparison](performance-gaussian-far-2026-10-26.html).
[Raw summaries and block statistics](../src/dev/results/gaussian-2026-10-26/summary.json) are retained with the compressed frame captures and 18 full-resolution PNGs. Production rendering and Settings defaults are unchanged.

## What was implemented

Only whole, settled far-terrain source entries whose conservative bounds are at least 768 m from the bent camera are eligible. Near and middle-distance geometry retain their original rendering. Each eligible quad contributes area-weighted position, RGB and full covariance moments. Spatial groups preserve face direction, emissive status and a coarse color bucket. An 8/16/32/64/128/256 m hierarchy selects whole source levels to meet two resident budgets: fine 160,000 and coarse 80,000 Gaussians. No random surface deletion is used.

Each Gaussian has a full 3D covariance, transformed through the local torus Jacobian and projected to an ellipse using the camera perspective Jacobian. A 3-sigma billboard rasterizes a Gaussian alpha profile. The prototype uses depth testing, alpha blending without depth writes, center-depth sorting and the original PBR lights/material parameters. It does not reduce the render resolution. Covariance axes are inflated by 1.8 to cover gaps, which trades sharper edges for more overlap. The generated data is a surface approximation; it has no image training, spherical-harmonic radiance or learned opacity.

Visible candidates are culled on the CPU at source and point level, then sorted with a 24-bit radix depth sort. Changed views upload a 4-byte order index per visible Gaussian. Exact static views reuse the order. Source geometry or material changes fall back to the original source. The immutable snapshot has a 64 m movement guard; this is an offline experiment, not a complete streaming renderer.

## Measurement conditions

- Same local Apple / Metal 3 WebGPU adapter, 1280 × 720 CSS pixels at DPR 2: **2560 × 1440** framebuffer, fixed 100% resolution, Medium lighting, shadows off, 4 samples. The browser does not expose the exact GPU model in these captures.
- All three offline terrain fixtures use the existing world LOD stress fixture. Near terrain, HUD, physics and ordinary LOD publication remain active during timing. These are local rendering measurements, not live-server performance or a representative network-streaming test.
- Each terrain has three motions: near-facing yaw sweep, moving yaw sweep and a yaw sweep looking across the ring. Each uses 12 balanced/interleaved blocks: original, fine, coarse, coarse, fine, original, fine, original, coarse, coarse, original, fine.
- Each block warms for 1.2 s and samples for 3 s. The original moving path is preloaded for 9 s before building a snapshot. Pixel captures warm all three pipelines; the main run also has a separate excluded shader/JIT warmup. No candidate materials are created during accepted timing blocks.
- Total: **108 blocks, 34,734 ordinary frames, 5,786 GPU timestamp samples**. A GPU sample is recorded every sixth eligible frame. No uncaptured GPU errors occurred.
- FPS is 1,000 divided by the pooled mean animation-frame interval. CPU time is the complete normal animate call. GPU span is the first GPU pass start to the final GPU pass end; it is not GPU busy time, a sum of pass durations or an FPS estimate. Refresh-capped results near 120 FPS do not demonstrate equal GPU headroom.
- Camera yaw oscillates ±0.6 rad around π/2. Near/moving pitch is −0.85 rad; across-ring pitch is 1.35 rad. Moving offsets are X = 16 sin(2πt), Z = 8(1 − cos(2πt)). Nature is elevated to Y = 180 m; Aether is at Y = 180 m and Copper at Y = 128 m. Exact camera coordinates are in each raw environment.

## Far terrain visible: across-ring yaw sweep

| Terrain | Original FPS | Fine FPS | Coarse FPS | Original GPU ms | Fine GPU ms | Coarse GPU ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Aether archipelago | 119.9 | 104.1 | 105.0 | 2.823 | 6.221 | 6.162 |
| Nature | 119.7 | 118.5 | 118.6 | 1.919 | 4.349 | 4.448 |
| Copper metropolis | 120.0 | 86.4 | 85.0 | 2.824 | 8.135 | 8.265 |

Aether loses 13.2% / 12.4% FPS (fine / coarse); Copper loses 28.0% / 29.1%. Their original blocks stay near 120 FPS throughout, while every candidate block is slower. Nature loses less than 1% FPS at this refresh limit but uses more than twice the GPU span. All across-ring blocks have zero pending LOD frames and zero invalid selected-source fallbacks.

The coarse budget does not ensure fewer visible splats in every camera direction. For example, Copper has roughly 12,580 visible fine and 11,762 visible coarse Gaussians in this workload, despite halving resident count. Spatial merging increases the size of remaining ellipses.

## Near-facing yaw sweep

| Terrain | Original FPS | Fine FPS | Coarse FPS | Original GPU ms | Fine GPU ms | Coarse GPU ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Aether archipelago | 119.9 | 113.9 | 103.6 | 3.587 | 5.606 | 6.579 |
| Nature | 120.0 | 120.0 | 120.0 | 3.041 | 3.220 | 3.237 |
| Copper metropolis | 119.8 | 119.6 | 119.3 | 4.480 | 4.127 | 4.507 |


## Near-facing movement and yaw

| Terrain | Original FPS | Fine FPS | Coarse FPS | Original GPU ms | Fine GPU ms | Coarse GPU ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Aether archipelago | 95.9 | 91.5 | 83.9 | 3.269 | 6.102 | 6.896 |
| Nature | 119.6 | 116.2 | 116.5 | 2.758 | 2.746 | 2.644 |
| Copper metropolis | 74.5 | 73.5 | 79.8 | 4.629 | 4.728 | 4.643 |

The coarse Copper sample improves moving FPS by 7.0%, with a small CPU reduction and essentially unchanged GPU span. That view is overwhelmingly occluded by nearby buildings: omitting the entire selected far layer changes only 0.002% of the frozen reference screen. It does not establish that visible Gaussian terrain is faster. The across-ring test reverses the apparent advantage. Nature's near-facing view similarly shows only 0.104% changed screen pixels when the replacement layer is omitted.

Movement deliberately retains normal LOD activity. Up to 3 selected sources in Aether, 1 in Nature and 38 in Copper become invalid and revert to original geometry. Pending publication frames are included and recorded, not silently discarded. These samples describe a guarded hybrid snapshot; the stationary-position across-ring test provides the cleaner visible-far comparison. Per-block FPS, frame percentiles, pending counts and CPU/GPU distributions are available in the summary.

## Why fewer primitives did not help here

The measured candidate CPU culling cost is about 0.45–1.13 ms in across-ring views, while the actual depth sort is only 0.04–0.12 ms. Optimizing sorting alone cannot remove the observed 2.4–5.4 ms increase in GPU span. Even when whole-scene draw counts fall, the candidate is slower: in the frozen Copper across-ring capture, calls fall from 87 to 32, yet the ordinary-frame GPU span rises from 2.824 to over 8 ms.

The likely GPU costs are the projected ellipse math, larger covered regions, repeated transparent shading/blending and lost opaque depth rejection between Gaussian surfaces. Coarser ellipses cover more pixels and overlap more, consistent with the timing and blur. These are mechanism-based inferences; no fragment-invocation counter or native GPU profile was collected to assign an exact fraction to each cause. The implementation retains per-fragment PBR and MSAA and does not have GPU tile binning, early transmittance termination or GPU visibility preparation.

## Picture and restoration controls

| Terrain / view | Fine changed pixels | Coarse changed pixels | Far omission control |
| --- | ---: | ---: | ---: |
| Aether archipelago / near | 11.076% | 14.178% | 6.923% |
| Aether archipelago / across | 8.305% | 8.764% | 7.827% |
| Nature / near | 0.181% | 0.203% | 0.104% |
| Nature / across | 5.339% | 8.919% | 8.774% |
| Copper metropolis / near | 0.002% | 0.036% | 0.002% |
| Copper metropolis / across | 8.897% | 9.070% | 7.521% |

Percentages count screen pixels whose maximum RGB difference from the original exceeds two byte levels. They measure affected screen area, not perceptual quality. The omission control temporarily hides only the eligible far sources to reveal whether foreground geometry conceals them.

Aether loses separate island detail, and small gaps can be filled by soft splats. Copper building silhouettes and surface details blur into broad patches. Nature's fine tier is closer in overall shape, but surfaces show softened edges and grid-like overlap; coarse loses more structure. Near geometry and the held tool remain sharp. The source-to-Gaussian boundary and temporal popping are not quantitatively evaluated by these stills.

The frozen sequence is original → fine → coarse → omitted layer → fine → original. Original restoration is byte-exact for all six views in both capture batches; repeated fine output differs by at most one RGB level of blending rounding. Picking results are identical. The gallery uses near images from the main run and across images from the matching supplementary run; its counts and metadata follow those respective snapshots.

## Construction and memory

| Terrain | Eligible quad faces | Fine Gaussians | Coarse Gaussians | Construction seconds |
| --- | ---: | ---: | ---: | ---: |
| Aether archipelago | 795,085 | 159,832 | 79,999 | 2.13 |
| Nature | 584,294 | 159,981 | 79,992 | 1.69 |
| Copper metropolis | 957,644 | 159,969 | 79,965 | 2.56 |

These are main-run snapshots; the independent across-ring snapshots can differ slightly after source publication and their own prewarm. Construction takes 1.68–2.58 s across the retained runs, including CPU surface aggregation, hierarchy selection and packing, while gameplay is paused.

Each candidate uses 96 bytes of Gaussian data plus a 4-byte sorted index: about **15.25 MiB fine** or **7.63 MiB coarse**, before CPU work arrays and other resources. The original packed representation stores 16 bytes per quad face. Therefore point-count reduction does not automatically imply memory reduction. The A/B experiment keeps the original buffers and both Gaussian candidates resident; candidate byte counts are not a measurement of total VRAM saved.

## Scope and recommendation

Keep the current packed opaque geometry as the default. This prototype fails the combined speed and image-quality goal in the tested visible-far workload. A cheaper trained/baked-radiance splat renderer with GPU culling, compressed storage, smaller screen footprints and a streaming hierarchy would be a different experiment. The current result does not prove that every 3DGS implementation is slower, but it does not justify replacing this game's distant renderer with this implementation.

One earlier Aether exploratory capture, saved as `exploratory-before-source-culling.json.gz`, predates source-level culling and path prewarming. It had extra CPU overhead and up to 83 selected-source fallbacks. It is excluded from every table and summary. Warmup blocks are also excluded. There is no broad device matrix, exact image-trained 3DGS baseline, dynamic rebuild throughput test or live-network acceptance test.

## Reproduce and inspect

Open the local game with `?world=aether-archipelago&dev_offline=1&dev_lod=world&dev_dpr=2`; repeat with `nature` and `copper-metropolis`. Use a 1280 × 720 viewport, Medium lighting, shadows off and Ring projection. Keep Torus Backface Culling off, enable distant terrain without persisting the temporary change, and wait for the ordinary far layer to settle. For Nature, save the starting position and elevate Y to 180 before testing.

From the development console, import `client/src/dev/GaussianFarExperiment.ts` through the dev server's `/@fs/` URL and call:

```js
const result = await runGaussianFarExperiment(game);
const across = await runGaussianAcrossExperiment(game);
```

Both functions dispose the experimental render hooks in a finally block and restore camera/frame instrumentation. The caller must restore its temporary far-enable setting and Nature position. The result contains comparison rows, raw frame and GPU samples, pixel controls and PNG data URLs. The retained `raw.json.gz` and `across.json.gz` omit inline PNG data; corresponding image files are stored alongside them.

Regenerate all tables and validate budgets, image restoration, picking, environment and warmed blocks with:

```sh
node client/tools/summarize-gaussian-far.mjs
npm --prefix client run typecheck
npm --prefix client run check:docs
npm --prefix client run check:english
```

The harness lives entirely under `client/src/dev` and is loaded explicitly. No production module imports it. The 24-bit depth radix implementation was also checked against a numeric depth-sort reference on 0, 1, 2, 255, 1,024 and 30,000 random entries.

## Background sources

The original [3D Gaussian Splatting project](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/) and [hierarchical Gaussian project](https://repo-sam.inria.fr/fungraph/hierarchical-3d-gaussians/) describe trained radiance representations and hierarchy techniques. [PlayCanvas's Gaussian performance guide](https://developer.playcanvas.com/user-manual/gaussian-splatting/building/performance/) discusses visible splat count, sorting and pixel coverage. These sources informed the experiment design; their performance claims are not substituted for the local measurements above.
