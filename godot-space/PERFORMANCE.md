# Copper Metropolis: Matched Fine-LOD Stress Test

2026-10-24, Apple M1 Pro, 32 GiB RAM, macOS 26.5.1. Map seed: 20260922.

**The current Godot comparison implementation did not improve performance.** With the
same fine terrain, viewpoint, and rendering settings, the two-run averages at 4K
were **120.03 FPS** for Web and **71.56 FPS** for Godot; at 5K they were **119.94 FPS**
and **59.39 FPS**, respectively. These results describe the two current static
rendering implementations, not all Godot games or Voxel Tools implementations.
Web remains limited by an approximately 120 Hz animation callback ceiling, so its
uncapped throughput has not been measured.

## How Much Finer Is the LOD?

| Setting | Previous matched-LOD baseline | Current fine preset |
| --- | ---: | ---: |
| Requested subdivision threshold | 64 px² | 1 px² |
| Effective threshold | 64 px² | 9.75 px² |
| Geometry budget | 160 MiB | 512 MiB |
| Data budget | 512 MiB | 1024 MiB |
| Resident distant faces | 2,668,593 | 11,183,165 |
| Terrain triangles submitted per frame | 1,571,882 | 4,206,058 |
| Terrain draw batches per frame | 93 | 245 |

The fine preset uses the maximum geometry and data budgets allowed by the current
Web settings. Requesting 1 px² hits the geometry budget, producing an effective
threshold of 9.75 px²; another 2 regions are limited by source-data resolution.
This is not a full-map 1 px² result. The triangle count increased by **2.676 times**.
Submission counts follow the GPU counter definition, including degenerate padding
in the existing arena; both implementations include identical padding and
near/distant ownership masks.

At the same fixed viewpoint, the real Web LOD selector generates and stabilizes
the terrain before its actual draw geometry is exported. Godot uses that geometry,
not the separate LOD implementation in the native exploration build. Subdivision
runs once at a 1280×720 viewport and is then frozen: 1440p, 4K, and 5K only increase
the output pixel count. Neither implementation subdivides again.

## Frame Rates and Frame Times

Each run warms up for 8 seconds, then records for 24 seconds. Both applications
remain in the foreground throughout, with zero unfocused frames. The browser test
page and native application run sequentially, never rendering at the same time.
Builds and image verification happen outside the sampling window. All frame
intervals, including stalls, are retained.

| Resolution | Web average FPS | Godot average FPS | Web p95 frame interval | Godot p95 frame interval |
| --- | ---: | ---: | ---: | ---: |
| 1280×720, 1 run | 120.04 | 102.10 | 9.10 ms | 12.33 ms |
| 2560×1440, 1 run | 119.85 | 84.90 | 9.10 ms | 16.93 ms |
| 3840×2160, run 1 | 120.02 | 71.61 | 9.10 ms | 20.16 ms |
| 3840×2160, run 2 | 120.04 | 71.51 | 9.90 ms | 20.25 ms |
| 5120×2880, run 1 | 119.88 | 59.23 | 9.80 ms | 23.19 ms |
| 5120×2880, run 2 | 120.00 | 59.55 | 9.70 ms | 22.86 ms |

Across the two-run averages, Godot FPS was **40.4%** lower than Web at 4K and
**50.5%** lower at 5K. Equivalently, the observed Web/Godot FPS ratios were 1.68 and
2.02. These are ratios of capped frame rates, not uncapped engine throughput.
The two high-resolution runs were close, but this was not a strictly exclusive-machine
experiment with randomized alternating run order.

An initial native 720p run measured 115.91 FPS (p95 9.75 ms), with window
accessibility reads overlapping the sample. That run is preserved as
`matched-lod-fine/results/godot-720p-ui-overlap.*` and is excluded from the table.
Subsequent sampling did not read or operate the window at all. The repeat without
UI operations was slower, so the variation cannot be attributed to automation.
Low-resolution results are single-run observations; repeated high-resolution
measurements provide the main comparison.

## Matched Conditions and Implementation Differences

- The same Copper map with 128 regions, logical camera `(8402,240,1264)`, and target
  `(8200,70,1032)`; vertical FOV 70°, near/far 0.1/10000, and the same camera-local
  torus projection.
- Identical terrain composition: distant terrain has 4,044,352 triangles / 194
  batches, standard near terrain 149,852 / 31, and microvoxels 11,854 / 20.
  Near/distant ownership masks and visible coverage are identical.
- Identical actual output resolutions, 4× MSAA, unlit vertex colors, no shadows,
  no fog, and no HUD. Neither application runs gameplay logic, LOD switching,
  loading, or meshing. The native application is a release build using Metal Forward+.
- Both have a nominal 120 FPS limit: Web uses the browser's approximately 120 Hz
  requestAnimationFrame, while Godot uses `Engine.max_fps=120` with VSync disabled.
  Their scheduling mechanisms differ. The recorded values are callback/process
  frame intervals, not direct measurements of GPU time or display presentation intervals.
- Web retains its existing WebGPU renderer, packed arena, instancing, vertex
  deformation, and output pass. Godot uses captured ArrayMesh geometry with
  positions already projected for the fixed viewpoint. Buffer layouts, projection
  work, and engine pipeline costs differ. **This does not test Voxel Tools runtime
  meshing or the frame rate of a full exploration session.**
- Web totals 4,206,059 triangles / 246 batches, one Three.js fullscreen output
  triangle more than the terrain count; Godot totals 4,206,058 / 245. Counts remain
  constant across all runs. The frame rates were not achieved by omitting geometry.

These results support retaining the current Web renderer. They do not support the
claim that switching to Godot will automatically make it faster. Comparing free
exploration requires measuring dynamic LOD, loading, transitions, culling, and
memory behavior along the same route. This experiment did not measure peak memory,
loading speed, or power consumption, nor isolate the specific cause of longer
native frame times.

## Data and Image Verification

Every run in this experiment references the same manifest SHA-256:

`711f98de39986f36c473abed67ad1713d5caa588cce95a6cdd124370cfc109bd`

Verification checks each exported mesh's SHA-256, byte size, and index range, then
compares both implementations' manifests, draw counts, output image dimensions,
MSAA, foreground status, release-build status, and calculations from raw frame times.

| Pixel comparison without resizing or alignment | 720p | 5K |
| --- | ---: | ---: |
| Mean absolute RGB error, 0–255 | 0.01689 | 0.01659 |
| All pixels with per-channel error ≤8 | 99.9251% | 99.9314% |
| Foreground pixels with per-channel error ≤8 | 99.8470% | 99.8596% |

| Web fine preset | Godot with identical geometry |
| --- | --- |
| ![Web](results/copper-web-1792805637168.png) | ![Godot](matched-lod-fine/results/godot-720p.png) |

Run `python3 godot-space/matched-lod-fine/verify.py` to repeat the complete verification.
Raw-file mappings and the verification summary are in
`matched-lod-fine/results/verification.json`; all raw per-frame data is retained in
the corresponding JSON files. The 5K Web reference image is
`results/copper-web-1792805804238.png`. Generated geometry, applications, and
measurement data are local files ignored by Git.

## Reproduction and Preserved Versions

Open `matched-lod-fine/launch.command`: F9 measures performance; F6 cycles through
720p / 1440p / 4K / 5K. See `matched-lod-fine/README.md` for the full capture and build
steps. New measurements overwrite `godot-latest.*`, but do not overwrite the named
raw records from this experiment.

The previous, coarser matched-LOD baseline, data, and application are all preserved
in `matched-lod/`, with its report in `PERFORMANCE-matched-baseline.md`. Its separate
`verify.py` passed verification again. The original free-exploration build remains
at the root `launch.command`. The earlier claim of an approximately 40% speedup
using unmatched LOD remains withdrawn; its historical record is retained only in
`PERFORMANCE-copper-unmatched-archive.md`.
