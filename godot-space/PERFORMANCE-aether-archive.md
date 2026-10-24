# Full Aether torus — 2026-10-24

The corrected prototype renders the complete 16,384 × 2,048 closed torus,
with both directions wrapping and near terrain streamed over an 8-unit far
scene. The previous flat 512 × 512 crop was not a correct implementation of
the requested world. Its measurements are retained only in
`PERFORMANCE-flat-archive.md` and must not be attributed to this version.

## Current observations

Apple M1 Pro, macOS 26.5.1, Godot 4.7.2 / Voxel Tools 1.7 release build,
Metal Forward+, fixed 1280 × 720 internal resolution, vertical FOV 70°,
FXAA, static vertex lighting, no shadows, VSync disabled. Each run has an
8-second warm-up followed by 24 seconds of a fixed camera orbit.

| Measurement | Whole ring | Near islands |
| --- | ---: | ---: |
| Average FPS | 167.00 | 193.18 |
| Mean frame interval (ms) | 5.99 | 5.18 |
| Median frame interval (ms) | 5.46 | 3.89 |
| p95 frame interval (ms) | 9.28 | 11.87 |
| p99 frame interval (ms) | 14.85 | 15.78 |
| Worst observed interval (ms) | 116.79 | 112.38 |
| 1% low FPS | 27.80 | 30.44 |
| Samples | 4009 | 4638 |
| Maximum draw calls | 2048 | 137 |
| Maximum rendered triangles | 2,373,078 | 930,324 |
| Unfocused measurement frames | 0 | 0 |

Both table runs completed in the foreground without recorded focus loss.
They were initiated with F9 through native UI automation. An accessibility
state query overlapped the beginning of each run; this was not an isolated
benchmark machine. Occasional intervals above 100 ms remain in the results,
and their cause has not been isolated. Average FPS does not establish smooth
frame pacing.

Frame intervals use a monotonic wall clock rather than Godot's smoothed
simulation delta. The 1% low is the reciprocal of the mean of the slowest 1%
of intervals. Native GPU timing was unavailable. The release memory monitor
reported zero and is not a meaningful memory measurement.

The whole-ring run draws all 2,048 far sectors, totaling 2,373,078 triangles.
The near run ended with 20 standard sectors and 8 micro sectors resident, no
pending jobs, and 32 total published sector meshes across the run. The full
far scene stays available behind streamed replacements; most distant sectors
are outside the near camera's frustum. Initial loading had already completed
before F9, so `initialLoadSeconds` in these two records is **not** application
startup time or cold map-loading time.

## Local records

- `results/torus-overview-foreground.json` and `.png`: whole-ring table run.
- `results/torus-near-release.json` and `.png`: near-island table run.
- `results/torus-overview-release.json`: intermediate full-ring run with focus
  loss; excluded from the table.
- `results/torus-overview-first.json`: earlier, closer camera framing with all
  frames unfocused; excluded from the table.
- Editor previews and the old flat-map/browser records are also excluded.

The standalone app has been exported, launched, visually checked at both
scales, and locally code-signed. Its packed archives successfully supply the
near and micro meshes at runtime. The application is about 1.4 GB on disk.

## Correctness checks

- All 2,048 sector indices and 263,131 archive records passed size and bounds
  checks. Fresh source generation matched 2,097,152 standard voxel samples
  and 1,820 occupied micro voxel samples at eight locations, including both
  world seams and distant areas.
- Godot projection positions and tangent frames match reference outputs from
  the original `TorusWorld.ts`; wrapped flight stays continuous across both
  axes. The original near-camera flattening optimization is not used.
- Native neighbor-buffer halo tests passed across both world seams.
- Actual runtime streaming loaded nonempty meshes at spawn and both seams,
  hid/revealed far sectors correctly, and unloaded near meshes in overview.
- Keyboard input tests passed for F2 view switching and W flight across both
  coordinate seams.

## What these results mean

This establishes a working Godot + Voxel Tools tour of the correct toroidal
world, including runtime terrain loading. It does **not** establish a speedup
over the existing web Space client. The new far LOD, render distance, lighting,
anti-aliasing, mesh grouping and camera path differ from that client. The old
browser control uses the obsolete flat crop and is not a valid comparison.

The streamer deliberately uses a compact implementation: 8-unit far voxels,
1-unit standard terrain within about 285 map units, and 1/8-unit micro voxels
within about 155 map units. Coarse distant islands and visible LOD transitions
are expected. There is no physics, editing, multiplayer, or dynamic lighting.
The next useful comparison would match visual workload and flight path in
the original client; these native FPS values alone are not a migration claim.
