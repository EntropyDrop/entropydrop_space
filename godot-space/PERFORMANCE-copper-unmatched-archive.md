> Historical unmatched-LOD experiment. Its FPS ratio is withdrawn as evidence of an engine speedup. See `PERFORMANCE.md` for the corrected identical-geometry test.

# Copper Metropolis: Godot versus existing Web client

Measured locally on 2026-10-24, Apple M1 Pro, macOS 26.5.1.
The Godot tour now uses the complete `copper-metropolis` torus, seed 20260922.
Both versions use the original Copper generator and the real 128 districts.

The native prototype had about **40–42% higher average FPS** in these two
city-flight runs. Its p95 intervals were shorter. This is a comparison of the
two current implementations, **not an isolated engine speedup**: native far
geometry is visibly coarser, native lighting and gameplay are simpler, and
Chrome approaches a 120 Hz frame-delivery ceiling. Tail latency did not
consistently improve; in the second run, Web had the better 1% low.

## City-flight results

| Measurement | Web run 1 | Web run 2 | Godot run 1 | Godot run 2 |
| --- | ---: | ---: | ---: | ---: |
| Average FPS | 101.37 | 107.98 | 144.08 | 151.96 |
| Mean frame interval, ms | 9.86 | 9.26 | 6.94 | 6.58 |
| Median interval, ms | 8.40 | 8.40 | 5.80 | 5.13 |
| p95 interval, ms | 17.20 | 16.00 | 12.79 | 12.70 |
| p99 interval, ms | 23.60 | 21.70 | 15.46 | 16.52 |
| Worst interval, ms | 267.30 | 39.50 | 116.77 | 121.25 |
| 1% low FPS | 22.38 | 38.47 | 28.37 | 32.19 |
| Samples | 2,435 | 2,594 | 3,459 | 3,648 |
| Maximum draw calls | 201 | 193 | 296 | 297 |
| Maximum submitted triangles | 1,952,333 | 1,894,887 | 747,202 | 792,884 |
| Unfocused frames | 0 | 0 | 0 | 0 |

The 1% low is 1000 divided by the mean of the slowest 1% of frame intervals.
Web intervals are monotonic animation-callback intervals; native intervals
are monotonic process-frame intervals. Neither is a measured compositor
presentation interval or a GPU duration. GPU timings were not collected;
Godot's GPU timing monitor was unavailable. Native memory-monitor zero values
are unavailable data, not zero memory use.

Both runs began after the initial view's terrain settled. Movement then
triggered normal streaming, which is included in the measurement. At the end
of the two Web runs, 145/153 and 146/153 near chunks were ready; the whole map
remained covered by far terrain. Godot ended with one pending sector job in
each run, 20/21 standard sectors and six micro sectors resident. These are
moving-tour results, not fully preloaded static-scene throughput results.

Run 2 reused caches and some previously visited terrain. No loading time or
cold-start advantage is claimed. The first Web run's 267 ms outlier and the
native runs' approximately 120 ms outliers remain in the statistics.

## Matched conditions and remaining differences

- Resolution: actual 1280 × 720 render buffers, vertical FOV 70°, shadows off.
- Seed 20260922; 16,384 × 2,048 toroidal map; 128 actual districts.
- Eight seconds of stationary warm-up, then the same 24-second logical path:
  `p(t) = (8402 + 60 sin(2πt/24), 240 + 15 sin(2πt/16), 1234 + 30 cos(2πt/24))`,
  looking toward `(8200,70,1032)`. Both bend the camera onto the torus.
- Each version was foreground throughout its two measured runs. The Web test
  tab was closed before native testing; no map generation or app export ran
  during measurement. This was a shared workstation, with other applications
  still open, not a controlled benchmark machine. Native F9 input was followed
  by an accessibility state query that could overlap the warm-up/measurement.
- Web: current existing Three.js WebGPU client in local offline development
  mode, Chrome 154.0.8037.93, Medium lighting, scale 1, DPR 1. The normal HUD,
  tools and game update loop remain active. No live network/multiplayer load.
  Browser callbacks have an observed approximately 120 Hz ceiling.
- Web LOD: existing volumetric renderer and snapshot loader; 64 px² subdivision,
  2,048-chunk far range, 512 MiB data budget and 160 MiB geometry budget.
  Near AOI is X ±8, Z ±4, or 153 chunks. Sources refine dynamically up to 1 m.
- Web's low-FPS automatic far-terrain shutdown is disabled only inside this
  comparison, as in the client's existing GPU benchmark scripts. Otherwise
  initial city loading triggered it and silently removed far terrain. The
  harness requires nonempty far geometry before warm-up; both saved results
  confirm far terrain stayed enabled. Early missing-terrain previews were
  excluded and no performance conclusion uses them.
- Godot: 4.7.2 custom release build with Voxel Tools 1.7, Metal Forward+, FXAA,
  static vertex lighting, no dynamic shadows, uncapped FPS / VSync off. The
  tour HUD remains visible. There is no gameplay simulation beyond flying.
- Godot LOD: fixed 8 m whole-ring mesh, 1 m standard terrain within about
  285 map units and 1/8 m micro voxels within about 155. It uses the original
  conformal torus even nearby, without Web's camera-local flattening. Sector
  handovers and coarse buildings are visible. In these runs it submitted
  substantially fewer triangles than Web, despite more draw calls.

The Web adapter lives entirely in `godot-space/`. It substitutes actual local
snapshots for the dev fixture's repeated district, through a Vite transform;
it does not modify the existing client renderer or production source files.

## Images and raw records

Web, settled city view (canvas capture; DOM HUD is not included in this image,
although it was present during measurement):

![Web Copper city](results/copper-web-1792803348499.png)

Godot, end of the second orbit (Y differs slightly from the stationary starting
view because the vertical oscillation has a 16-second period):

![Godot Copper city](results/copper-godot-2.png)

Complete native Copper torus:

![Godot complete Copper torus](results/copper-godot-overview.png)

- Web run 1: `results/copper-web-1792803273752.json`.
- Web run 2: `results/copper-web-1792803327315.json`.
- Native runs: `results/copper-godot-1.json` and `copper-godot-2.json`.
- Separate whole-ring native check: `results/copper-godot-overview.json`,
  129.75 average FPS, all 2,048 far sectors / 3,626,806 triangles, zero unfocused
  frames. This view has no matching Web run and is excluded from the table.
- Earlier preview images and Aether results are excluded. The HUD FPS shown
  in screenshots is a recent live sample, not the measured orbit average.

The app is `build/Space Torus Tour.app` (about 5.4 GiB on disk), locally ad-hoc
signed. `launch.command` opens it; **F2** switches full torus/city, **F9** runs
an orbit benchmark. It remains single-player and tour-only.

## Data correctness and reproducibility

Copper export: 707,685,994 standard voxels and 194,644,844 unique micro voxels,
128 tile archives, 2,048 sectors, 1,146,997 indexed records, 5,433,425,139 archive
bytes. Export took 669 seconds; far-mesh baking took 7.2 seconds on this run.

All archive bounds/indices passed validation. Independent fresh generation
matched 2,097,152 standard voxel samples and 5,581 occupied micro samples at
eight locations, including both seams and distant positions. Godot torus
positions and frames matched the original TypeScript projection. Actual
streaming, wrapped neighbor halos, unload/handover, F2 switching, and keyboard
flight across both seams all passed the existing native checks on Copper.

Native source SHA-256:
`313f76a3f9062d1328343e8c5469ed2ab39f06e6d65f9cbf7c24fce5203f40a8`.
Web snapshot-source SHA-256:
`89f5ce833728d49bd32ab926c8c32686bcda73144380dce2fe802c76f758ef23`.
The hashes cover different dependency sets; they are not expected to match.

See `README.md` for regeneration, verification, export and Web comparison
commands. Generated data, app bundles, raw records and screenshots are ignored
by Git but remain available locally. The previous Aether torus report is
`PERFORMANCE-aether-archive.md`; the obsolete flat crop is documented in
`PERFORMANCE-flat-archive.md`.
