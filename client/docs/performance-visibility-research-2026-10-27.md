# Community and paper follow-up: packed terrain visibility — 2026-10-27

> Update: [Fast CPU and wider reuse are now in production](performance-visibility-integration-2026-10-27.md). The measurements below retain their original capture-time state.

This follow-up keeps the production packed-quad renderer and PBR material. The experiments are explicit offline DEV hooks. No default graphics setting or production rendering source is changed.

## Measured results and recommendation

The accepted set contains **192 blocks, 50,432 measured frames and 8,401 whole-frame GPU samples**: 96 main blocks, 48 moving-repeat blocks and 48 identical-code control blocks. Excluded warmups are stored but not counted. All accepted runs have zero GPU errors and pass the per-frame compute-timeline checks.

### Moving across the ring: main run

| World | Original FPS | Fast CPU FPS | Wide CPU FPS | GPU indirect FPS |
| --- | ---: | ---: | ---: | ---: |
| Aether | 100.3 | 107.9 (+7.6%) | 109.7 (+9.4%) | 93.5 (-6.8%) |
| Nature | 120.0 | 120.0 (-0.0%) | 120.2 (+0.1%) | 119.2 (-0.7%) |
| Copper | 77.1 | 86.2 (+11.8%) | 87.4 (+13.3%) | 66.2 (-14.2%) |

### Separately warmed moving repeat

| World | Original FPS | Fast CPU FPS | Wide CPU FPS | GPU indirect FPS |
| --- | ---: | ---: | ---: | ---: |
| Aether | 102.7 | 105.9 (+3.1%) | 107.6 (+4.7%) | 92.7 (-9.7%) |
| Nature | 119.9 | 120.0 (+0.1%) | 120.0 (+0.1%) | 118.0 (-1.6%) |
| Copper | 73.9 | 81.2 (+9.8%) | 85.0 (+15.0%) | 65.8 (-11.0%) |

The same-code control has maximum absolute label-vs-original FPS differences of approximately **1.4% Aether, 0.13% Nature, and 2.0% Copper**. These are descriptive noise observations, not confidence intervals. Aether's CPU gain is smaller in the repeat, so a fixed 8–9% promise is not justified. Copper's CPU improvement remains larger than the observed control spread.

Turning without translation stays about 120 FPS for all four variants in all three worlds. Fast CPU mainly benefits camera translation, because the original position cache already avoids repeated distance work during rotation alone. Nature is also near the presentation limit when moving; its useful change is lower CPU time, not a measurable FPS gain.

### Main moving-frame costs

All entries are per-frame means in milliseconds; draws are whole-scene means. CPU and GPU overlap, so do not add their columns to predict FPS.

| World / mode | CPU ms | GPU ms | Arena sync ms | Draw calls | GPU encode ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Aether / Original | 6.820 | 3.034 | 2.442 | 103.1 | 0.000 |
| Aether / Fast CPU | 6.126 | 2.935 | 1.802 | 102.5 | 0.000 |
| Aether / Wide CPU | 5.864 | 2.941 | 1.446 | 116.2 | 0.000 |
| Aether / GPU indirect | 8.229 | 4.186 | 1.485 | 399.6 | 1.432 |
| Nature / Original | 3.853 | 2.144 | 1.062 | 46.9 | 0.000 |
| Nature / Fast CPU | 3.630 | 2.117 | 0.816 | 47.1 | 0.000 |
| Nature / Wide CPU | 3.552 | 2.126 | 0.711 | 52.4 | 0.000 |
| Nature / GPU indirect | 4.887 | 3.092 | 0.781 | 167.0 | 0.724 |
| Copper / Original | 10.807 | 2.985 | 3.010 | 111.8 | 0.000 |
| Copper / Fast CPU | 9.277 | 2.779 | 1.799 | 111.8 | 0.000 |
| Copper / Wide CPU | 9.104 | 2.929 | 1.569 | 126.3 | 0.000 |
| Copper / GPU indirect | 13.116 | 5.201 | 1.762 | 328.1 | 2.594 |

The GPU experiment saves arena-selection work but increases source-map uploads, command preparation and draw submission. Moving Aether goes from about 103 to 400 draws; Copper from 112 to 328. The compute passes and extra encoding are included in the measured costs. Zero-instance indirect commands still need submission. On Copper, GPU span rises from 2.99 to 5.20 ms and CPU from 10.81 to 13.12 ms. This particular GPU architecture loses; this is not evidence that every GPU-driven renderer must lose.

The trial allocates approximately 14.4 / 6.4 / 19.2 MiB of additional GPU buffers for Aether / Nature / Copper. All modes share those warmed resources during comparison, so this is not a measured VRAM saving. No new GPU pages are allocated in accepted timed frames. Live LOD work remains enabled and some frames report pending transitions, but resident face counts stay constant within each main block.

### Image and correctness results

There are 225 frozen image rows across nine captures, including 135 candidate comparisons, 45 original references and 45 restored-original checks. **Fast CPU is byte-identical in all 45 of its comparisons.** Wide CPU and GPU indirect have a maximum RGB-byte difference of 1 in a few captures; no pixel differs by more than 2 levels. These tiny changes are retained in the raw measurements, not described as strict equality. All restored-original captures are byte-identical and all picking comparisons match.

All 45 GPU buffer checks retain every required Float64-reference block and preserve ordering. Conservative GPU allowances occasionally retain extra blocks. The [interactive comparison](performance-visibility-research-2026-10-27.html) includes 24 full-resolution main-run PNGs at near and across views; the other poses are checked numerically outside timed frames.

### Decision

1. **Prioritize Fast CPU for a future production change.** It preserves geometry and materials, removes duplicate distance work, and gives Aether about 3–8% and Copper about 10–12% moving FPS improvement across the two runs. Nature saves roughly 0.22–0.31 ms CPU while staying near 120 FPS. It has the smallest implementation scope and all sampled images are exact.
2. **Keep Wide CPU as a secondary candidate.** It gives about 5–9% in Aether and 13–15% in Copper, with roughly 0.30–0.38 ms CPU saved in Nature. Extra conservative geometry raises draw counts; wider cache correctness should be checked for rapid movement, FOV changes, projection changes and terrain edits before integrating it.
3. **Do not enable this GPU-indirect version.** It loses about 7–10% moving FPS in Aether and 11–14% in Copper, and increases CPU/GPU time in Nature. A useful next GPU hypothesis would need fewer submitted runs and less CPU map rebuilding, not just moving the current per-block predicate to compute. Hi-Z occlusion also needs a separate conservative torus/view-flattening test and a full-frame cost measurement.

The existing packed-quad/PBR production renderer and defaults remain unchanged. These measurements justify a small CPU optimization more strongly than another representation replacement. Neither the CUDA, mesh-shader nor analytic-patch papers have been reproduced here; their hardware and scene assumptions are recorded below.

The later [native Firefox trial](performance-visibility-firefox-2026-10-27.md) confirms the GPU regression and smaller Copper CPU gains, while small Aether/Nature gains are less conclusive relative to its controls. Its automatic memory budgets differ, so absolute browser FPS is not directly comparable. Production remains unchanged.

## Research scope and selection

Sources were checked on 2026-10-27. Community source repositories and original author/publisher pages are distinguished from measured results in this application. Published speedups on other scenes or devices are not treated as predictions for this game.

| Primary source | Relevant contribution | Application and limits here |
| --- | --- | --- |
| [Binary Greedy Meshing v2](https://github.com/cgerikj/binary-greedy-meshing) | Compact quad records, vertex pulling and indirect submission; the example also filters back-facing faces. | Supports keeping merged rectangles. Its small chunk coordinates permit tighter packing than our large LOD spans; the demo uses OpenGL multi-draw. Our renderer already has packed records and page batching. |
| [meshoptimizer cluster culling](https://github.com/zeux/meshoptimizer#cluster-culling) | Bounds and normal cones; recommends culling at a lower frequency than shading, including separate compute dispatches. | Existing 16-face blocks already have conservative bent-space spheres and cones. We test cheaper CPU predicates and wider conservative reuse, rather than claiming to add previously absent cone culling. |
| [Niagara](https://github.com/zeux/niagara) | GPU culling, scene submission, indirect command compaction and occlusion experiments in an open Vulkan renderer. | Adapt GPU-generated instance counts to the existing WebGPU pages. Preserve run ordering and original materials. This is an adaptation of the architecture, not a Vulkan port. |
| [RE ENGINE Meshlet Rendering Pipeline, REAC 2025](https://www.enginearchitecture.org/downloads/REAC_2025_Capcom.pdf) | Production experience with cluster granularity, two-phase visibility, indirect work and hardware/software rasterization. | Culling itself has a cost; finer clusters need not win. Its native mesh-shader and visibility-buffer architecture is larger than this experiment. Hi-Z would require a separate current-frame correctness and cost test. |
| [WebSplatter, February 2026 preprint](https://arxiv.org/html/2602.03207v1) | Portable GPU preprocessing and hierarchical scan with separate dispatches, avoiding cross-workgroup spin waiting. | Borrow the synchronization principle for stable block compaction. We do not run Gaussian depth sorting or opacity pruning on opaque terrain, and do not claim to reproduce its viewer benchmark. |
| [CuRast, 2026](https://www.cg.tuwien.ac.at/research/publications/2026/SCHUETZ-2026-CURAST/) | CUDA software rasterization specialized for massive dense opaque triangle data, with a separate strategy for larger triangles. | The reported platform is RTX 5090 and the workload reaches billions of triangles. This does not establish a gain for our Apple WebGPU scene, where ordinary CPU work and presentation limits are material. No CUDA or hardware ray tracing is used here. |
| [Adaptive LOD for Parametric Objects, TVCG 2026](https://www.cg.tuwien.ac.at/research/publications/2026/UNTERGUGGENBERGER-2026-ALOD/) | Per-frame analysis and sampling of parametric patches, with tessellation or point rasterization. | The torus bend is analytic, but editable voxel surfaces, colors and holes are not one smooth parametric object. Adaptive curvature sampling is a separate future hypothesis, not evidence that another fixed-density point trial should be faster. |

The preceding [point-cloud trial](performance-point-cloud-2026-10-27.md) found substantial single-pixel holes and no convincing surfel advantage over matched rectangles. This motivates reducing the cost of selecting and submitting existing geometry before changing its representation again.

The CPU distance simplification below is a local code finding: the position-cache rebuild computes a general-purpose distance and then computes it again inside the normal-cone predicate. It is not attributed to a paper. The exact reuse margins are also this experiment's engineering choices, not values prescribed by a source.

## Implementations

- **Original:** production packed pages, 16-byte face records, 16-face visibility blocks, 32 faces per draw instance, existing PBR and conservative CPU culling.
- **Fast CPU:** reuse one Float64 square root of squared displacement for distance and normal-cone classification. Keep original 16 m translation and 0.06 plane-normal-change reuse thresholds. Finite world coordinates make overflow/underflow protection in a general hypot unnecessary here.
- **Wide CPU:** Fast CPU plus 32 m / 0.12 reuse thresholds. Expand translation/plane-offset slack from 18 to 34 m and angular slack from 0.061 to 0.121. More geometry may be submitted; bounds stay conservative for accepted camera changes. Nearby view-flattened blocks are exempt through the larger radius guard. Coverage ownership updates remain independent of camera reuse.
- **GPU:** retain original quad records, materials, page grouping and run ordering. Opaque CPU submission supplies all eligible blocks; GPU compute filters spheres/cones and frustum planes, performs a stable per-run prefix scan, compacts the original mapping records and writes indexed-indirect instance counts. Masked handoff geometry retains the existing CPU decision. There are three dispatches per changed active page and no cross-workgroup polling. Unchanged view/maps reuse their prior GPU result.

GPU compaction preserves source order, including depth-tied boundaries, rather than using unordered atomic append. A small positive Float32 error allowance can keep extra blocks. It cannot intentionally remove blocks retained by the Float64 reference. The last opaque block may be duplicated to fill a 32-face instance when the compacted 16-face block count is odd; it stays inside its original run allocation. Geometry and material code are unchanged.

The GPU variant retains CPU source visibility and page assembly. It is a bounded experiment moving block selection and instance counts to the GPU, not a fully GPU-driven streaming/LOD engine and not Hi-Z occlusion. It uses the pinned Three.js backend's private buffer access only inside DEV modules.

## Validation and timing protocol

Use all three existing local offline fixtures: Aether, Nature and Copper. Nature is raised to Y = 180 m so the far ring is visible. Use 1280 × 720 CSS, DPR 2, a 2560 × 1440 framebuffer, Medium lighting, shadows off, four scene samples, fixed resolution scale, and torus surface backface filtering off. Exact camera and distant settings are saved in each capture.

The adapter reports Apple / metal-3, with no model identifier exposed. The browser reports Chromium 156. Command caching is enabled; distant settings use 64 px² subdivision, a 2048-chunk distance, 512 MiB data budget and 160 MiB geometry budget. Ordinary physics can shift the starting position slightly between separately warmed runs; each run saves its own camera and compares all labels against the same path within that run. Reported gains use that run's baseline, not an absolute FPS comparison across sessions.

Frozen near and across views, short cached motion, guard-crossing motion and a return pose compare every candidate to original PBR. Original restoration and picking are checked. Outside timings, GPU mapping and indirect buffers are read back to verify order and that no required Float64-reference block was lost. These readbacks and PNG encoding are excluded from the measured frames.

Ordinary game frames retain physics, HUD and live LOD publication. Turning and moving while looking across the ring each use four interleaved repetitions per mode: 1 s warmup then 2.5 s measurement. The order is A B C D / D C B A / C A D B / B D A C, where A is original, B Fast CPU, C Wide CPU and D GPU. Shader warmup is excluded. CPU timing includes the normal animate call; GPU timing spans the first through last pass, including all visibility compute work. Near-120 FPS results are presentation-limited.

Three.js cannot read GPU-written instance counts for its ordinary triangle statistics. Therefore those counters are explicitly labelled nominal for GPU mode. Actual indirect instances are verified in frozen captures; timing comparisons use measured CPU/GPU/FPS, not a falsely reduced nominal triangle counter.

Each world also has a separately warmed moving repeat and an identical-code control in the same browser session. The control keeps the same four labels and schedule but runs the original renderer for every label. Its differences estimate order/session noise; they are not optimization gains. Control and repeat blocks use the same four repetitions, one-second warmup and 2.5-second measurement. No build, typecheck or other benchmark runs concurrently with the timed frames.

These are single-device, local offline workloads with settled repeated-district terrain, not online-world or cross-device guarantees. Five frozen poses cover small movement and crossing the original 16 m reuse guard; they do not exhaust crossings of the wider 32 m guard or establish correctness for every FOV, projection, world edit or fast camera transition. A production integration would need those cases covered, especially for the wider cache.

## Reproduction

The optional entry point is [VisibilityExperiment](../src/dev/VisibilityExperiment.ts). On the matching offline game URL, temporarily enable far terrain and run `await runVisibilityExperiment(game)`. `{ probeOnly: true }` performs image and GPU-map checks without timings. `{ repeat: true }` repeats the moving workload with a fresh warmup. `{ control: true }` runs the identical-code moving control. Restore temporary far enablement and Nature's height afterward; the harness restores hooks and rendering state in a finally block.

Raw compressed captures, full-resolution images and the generated summary are in [the results directory](../src/dev/results/visibility-2026-10-27/). Rebuild and validate the summary with `node client/tools/summarize-visibility.mjs` from the repository root. [The summarizer](../tools/summarize-visibility.mjs) verifies block counts, rendering settings, pixel/picking checks and matching per-frame GPU compute-pass counts before producing tables.
