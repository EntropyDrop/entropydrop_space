# Aether Archipelago tilt-shift benchmark — 2026-11-16

The tilt-shift presets reduced GPU rendering time on both tested routes. The bounded test showed no frame p95 improvement. With the full world loaded, the coarsest LOD kept the Medium frame p95 at 13 ms and reduced Low from 13 to 11 ms. The coarsest LOD visibly merged islands and bridges into large blocks, including inside the sharp band. The trial ran through a development-only launcher.

## Bounded route with eight terrain districts

The camera follows one moving overlook route near the spawn at `(8192.5, 180, 1024.5)`. The four variants separate the cost of two quarter-width, quarter-height blur passes from the savings of changing the distant subdivision threshold from 64 to 256 CSS px². The composite replaces the usual output conversion and keeps its tone mapping.

| Lighting | Variant | GPU p50 (ms) | Frame p95 (ms) | Mean FPS | Mean visible far faces |
| --- | --- | ---: | ---: | ---: | ---: |
| Medium | Original | 2.425 | 13 | 119.4 | 498,991 |
| Medium | Blur only | 2.521 | 14 | 119.6 | 499,119 |
| Medium | Coarser LOD only | 1.613 | 13 | 120.1 | 240,832 |
| Medium | Coarser LOD and blur | 1.749 | 14 | 118.4 | 240,750 |
| Low | Original | 2.558 | 14 | 118.0 | 499,205 |
| Low | Blur only | 2.357 | 13 | 118.7 | 499,125 |
| Low | Coarser LOD only | 1.855 | 13 | 119.9 | 240,853 |
| Low | Coarser LOD and blur | 1.866 | 14 | 120.0 | 240,851 |

The combined variant reduced GPU p50 by 27.9% on Medium and 27.1% on Low. GPU p50 fell in all four paired rounds at each quality. The blur-only result differed by quality. The two combined variants submitted about 39% fewer triangles and drew about 52% fewer far faces. The sharp band still shows some coarser bridges and island edges. Blur also softens the foreground tool near the bottom of the screen.

- [Bounded run summary](../src/dev/results/aether-firefox-tilt-shift-2026-11-16/bounded/summary.json)
- [Bounded raw frames and GPU pass timestamps](../src/dev/results/aether-firefox-tilt-shift-2026-11-16/bounded/frames.json.gz)
- [Bounded native-resolution captures](../src/dev/results/aether-firefox-tilt-shift-2026-11-16/bounded/)

## Across-ring route with all 128 terrain districts loaded

The original run uses 64 CSS px² adaptive subdivision. The tilt-shift variant fixes the distant layer at its coarsest 64 m voxel mip. Both variants use the same coordinate-specific Aether voxel cache and standard visibility and handoff logic. The tested camera ranges and FOV determine the source mip cutoff per district. The planner selected 94,404 coarsest faces across all 128 districts, of which about 46,000 were visible on an average frame.

| Lighting | GPU p50 original → tilt (ms) | GPU p50 reduction | Frame p95 original → tilt (ms) | Mean FPS original → tilt | Mean visible far faces original → tilt |
| --- | ---: | ---: | ---: | ---: | ---: |
| Medium | 1.720 → 0.855 | 50.3% | 13 → 13 | 115.9 → 117.4 | 544,479 → 46,331 |
| Low | 1.657 → 0.837 | 49.5% | 13 → 11 | 113.8 → 118.7 | 544,176 → 46,357 |

All four paired rounds per quality show a lower GPU p50 with fixed 64 m LOD and blur. The full-world and bounded runs use different routes, far-LOD settings, and scene coverage. Each reduction uses its own run's baseline.

### Matched screenshots

| Lighting | Camera | Original | Fixed 64 m and tilt-shift |
| --- | --- | --- | --- |
| Medium | Skyline | [Original](../src/dev/results/aether-firefox-tilt-shift-2026-11-16/full/medium-baseline-skyline.webp) | [Tilt-shift](../src/dev/results/aether-firefox-tilt-shift-2026-11-16/full/medium-tilt-skyline.webp) |
| Medium | Across the ring | [Original](../src/dev/results/aether-firefox-tilt-shift-2026-11-16/full/medium-baseline-ring.webp) | [Tilt-shift](../src/dev/results/aether-firefox-tilt-shift-2026-11-16/full/medium-tilt-ring.webp) |
| Medium | Overlook | [Original](../src/dev/results/aether-firefox-tilt-shift-2026-11-16/full/medium-baseline-overlook.webp) | [Tilt-shift](../src/dev/results/aether-firefox-tilt-shift-2026-11-16/full/medium-tilt-overlook.webp) |
| Low | Skyline | [Original](../src/dev/results/aether-firefox-tilt-shift-2026-11-16/full/low-baseline-skyline.webp) | [Tilt-shift](../src/dev/results/aether-firefox-tilt-shift-2026-11-16/full/low-tilt-skyline.webp) |
| Low | Across the ring | [Original](../src/dev/results/aether-firefox-tilt-shift-2026-11-16/full/low-baseline-ring.webp) | [Tilt-shift](../src/dev/results/aether-firefox-tilt-shift-2026-11-16/full/low-tilt-ring.webp) |
| Low | Overlook | [Original](../src/dev/results/aether-firefox-tilt-shift-2026-11-16/full/low-baseline-overlook.webp) | [Tilt-shift](../src/dev/results/aether-firefox-tilt-shift-2026-11-16/full/low-tilt-overlook.webp) |

- [Full-world run summary](../src/dev/results/aether-firefox-tilt-shift-2026-11-16/full/summary.json)
- [Full-world raw frames and GPU pass timestamps](../src/dev/results/aether-firefox-tilt-shift-2026-11-16/full/frames.json.gz)
- [Prepared terrain manifest](../src/dev/results/aether-firefox-tilt-shift-2026-11-16/full/terrain-index.json)

## Conditions

- Firefox 159.0.1 on an Apple M1 Pro with WebGPU timestamp queries. Aether seed 42, terrain generator 3. Captured against checkout `fbe794062d244f3d3a39dc9db7f396f13641ddad` with the experiment loaded from a development page.
- Fixed 1280 × 720 CSS viewport, DPR 2, 2560 × 1440 framebuffer, 4× MSAA, 75° FOV and shadows off. The results describe this offline fixture and camera workload.
- Four interleaved 3-second sampling blocks per variant and quality. Each block has a 1.2-second warm-up. Timed frames exclude screenshot encoding. The bounded investigation has 32 blocks, 11,479 frames, and 1,906 GPU timestamp samples. The full-world investigation has 16 blocks, 5,607 frames, and 927 GPU samples. Both reported zero WebGPU errors.
- GPU elapsed time spans the earliest render-pass start and latest render-pass end. Frame p95 uses animation callback intervals. Power was not measured. The archived images are lossless WebP encodings of the 2560 × 1440 captures. Bounded screenshots came from a separate visual pass.

## Reproduce

For the full-world suite, prepare the 128 mips from the native Aether cache. The [native renderer's 128-zone profiling command](../../native-space/README.md) populates that cache. The preparation script accepts the directory containing the Aether `manifest.json` as an optional argument.

```sh
node client/tools/prepare-tilt-shift-terrain.mjs
```

Start the [loopback Vite fixture](../tools/tilt-shift-benchmark.vite.config.mjs) from the repository root.

```sh
npm run dev --workspace @entropydrop/space -- --config tools/tilt-shift-benchmark.vite.config.mjs
```

Keep Firefox in the foreground with at least a 1280 × 750 viewport. Open the [bounded benchmark](http://127.0.0.1:5198/space/app/tools/tilt-shift-benchmark.html) or the [full-world benchmark](http://127.0.0.1:5198/space/app/tools/tilt-shift-benchmark.html?surface=cached). Add `capture=1` for screenshot-only mode. The fixture saves JSON and PNG captures under `.local/aether-tilt-shift/bounded` or `.local/aether-tilt-shift/full`.
