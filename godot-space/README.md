# Space: Copper torus tour

A local, single-player flying tour of the complete `copper-metropolis` world,
seed 20260922. The 16,384 × 2,048 world wraps around both directions of a closed
torus using the original Space projection. It is no longer a flat map crop.
The original TypeScript generator supplies the terrain and micro detail;
Voxel Tools meshes the voxels and Godot renders them through Metal.

## Open and fly

Double-click `launch.command`, or open `build/Space Torus Tour.app`.
The standalone application needs neither a server nor an account.
It starts outside the torus so the complete ring is visible. Press **F2** to
enter the city near the original spawn, and F2 again to see the whole ring.
Near terrain loads progressively over the coarse overview.

| Input | Action |
| --- | --- |
| F2 | Switch between whole-ring overview and city flight |
| Left click, mouse | Capture mouse, look around |
| WASD | Fly relative to the camera |
| Space / E, Q / Control | Ascend, descend |
| Shift | Fly five times faster |
| Escape | Release mouse |
| F9 | Benchmark the current view |
| Command-Q | Quit |

City flight follows the torus surface and wraps seamlessly in both map
directions. The overview uses free flight in 3D space. There are no collisions,
editing, inventory, saving, multiplayer, or additional gameplay systems.

## Terrain and LOD

The source map contains 707,685,994 solid cells and 194,644,844 unique micro cells.
It is stored in 128 compressed tile archives, about 5.43 GB in total, and
indexed into 2,048 horizontal sectors. It is not all expanded into memory.

- **Far:** the complete ring is available at launch, with 8-unit cells and
  3,626,806 triangles in a prebuilt scene.
- **Near:** 1-unit terrain loads within roughly 285 map units of the camera.
- **Detail:** original 1/8-unit micro voxels load within roughly 155 map units.

Distances are measured to sector centers; sectors are 128 × 128 map units.
An 85-unit eviction margin reduces repeated loading at boundaries. Near terrain
replaces its far sector only when ready; unloaded sectors reveal the far mesh
again. Above logical altitude 520, or in overview mode, only the far scene is
needed. The coarse far mesh is deliberately different from the web renderer,
and transitions can be visible.

Disk reads, decompression and torus projection run on workers. Voxel Tools'
native `VoxelMesherCubes` does greedy meshing on the main thread with a 2 ms
per-frame scheduling budget; a single chunk can exceed that budget. Meshes
are combined per sector to reduce draw calls. Wrapped neighbor halos remove
internal faces at both world seams. This uses Voxel Tools' native buffers and
mesher with a small custom streamer, rather than `VoxelTerrain`.

Lighting is static vertex color; emissive cells retain their color without
directional darkening. There are no dynamic shadows, bloom or illumination
from emissive cells. Rendering uses FXAA and a fixed 1280 × 720 internal
resolution. The actual torus projection is used even near the camera, without
the web client's local flattening optimization.

## Installed tools

- Godot 4.7.2 custom build with Voxel Tools 1.7, installed at
  `/Applications/Godot Voxel.app`.
- Official editor and release template archives from
  [Voxel Tools v1.7](https://github.com/Zylann/godot_voxel/releases/tag/v1.7)
  are under `../.local/godot-install/`.
- Godot and Voxel Tools are MIT-licensed. Third-party license information is
  available in the editor's About dialog and upstream repositories.
- Unity Hub remains installed from the earlier engine choice. This project
  uses neither Unity Editor nor Voxel Play.

Open `project.godot` with the installed Godot Voxel editor to edit the project.

## Regenerate, verify and build

From the repository root, with its Node dependencies installed:

```sh
./godot-space/prepare.sh
node godot-space/tools/verify-torus.ts
"/Applications/Godot Voxel.app/Contents/MacOS/Godot" --headless --path godot-space --script tools/test-torus.gd
./godot-space/build.sh
./godot-space/launch.command
```

The initial Copper export took about 11 minutes on this machine.
`./godot-space/prepare.sh aether-archipelago` switches back to the previous
map; other maps are cached in `../.local/godot-worlds/` and only the active
map is packed into the app. Rebuild after switching maps.
The initial full export takes several minutes. Unchanged tile archives are
cached by source hash. `GODOT_BIN` overrides the binary used by the shell
scripts. The export preset uses the downloaded official macOS release template
at `../.local/godot-install/template/macos_template.app.zip`. The app is locally
ad-hoc signed, not notarized for public distribution.

`export-torus.ts` imports the original generator without changing it.
`verify-torus.ts` checks every archive record and independently regenerates
samples near spawn, at distant locations and at both seams. It also exports
reference positions and frames from the original torus math. `test-torus.gd`
checks those references, wrapped neighbor halos, real streaming at spawn and
both seams, overview unloading, and keyboard flight across both seams.

Generated archives (`world-data/`), baked meshes (`baked/`), app bundles
(`build/`) and measurements (`results/`) are ignored by Git. They are present
locally and reproducible. The old flat-map scripts, `data/` and browser control
remain only as historical experiments; they are not used by this app.

## Measure performance

```sh
./godot-space/launch.command --benchmark --quit-after-benchmark
./godot-space/launch.command --near --benchmark --quit-after-benchmark
```

Keep the application in the foreground. The near test first waits for initial
terrain loading to finish. Both tests then run an 8-second warm-up and a
24-second camera orbit, with uncapped native FPS. The launcher saves JSON and
PNG to `results/godot-latest.*`; use `--result=/absolute/path/result.json` to
keep separate runs. F9 in the directly opened app saves under Godot's user
data directory in `benchmarks/`.

See `PERFORMANCE.md` for current results and limits. Previous Aether torus measurements are archived in `PERFORMANCE-aether-archive.md`.
The older flat-map measurements in `PERFORMANCE-flat-archive.md` do not measure
this torus. Current identical-LOD comparison results are in `PERFORMANCE.md`.

## Identical-LOD comparison

The finer stress test is in `matched-lod-fine/`: 4.21 million identical terrain
triangles, tested from 720p through 5K. Open `matched-lod-fine/launch.command`;
see `PERFORMANCE.md` for the current results and `matched-lod-fine/README.md`
for reproduction. The prior baseline report is `PERFORMANCE-matched-baseline.md`.

The corrected comparison is in `matched-lod/`. It imports the Web client’s
actual settled LOD geometry, including near and micro terrain, and verifies
matching triangle counts and images. Open `matched-lod/launch.command`; see
`matched-lod/README.md` and `PERFORMANCE.md`. The earlier custom-LOD tour FPS
ratio is withdrawn as an engine-performance comparison.

## Original moving-tour experiment (different LODs)

```sh
node godot-space/tools/export-web-surface.ts
node node_modules/vite/bin/vite.js --config godot-space/web-compare.vite.ts
```

Open `http://127.0.0.1:5188/space/app/?dev_offline=1&world=copper-metropolis&dev_lod=world&dev_dpr=1&native_comparison=1`
in Chrome at a 1280 × 720 viewport. Click Play, Escape, Prepare city orbit,
then Run 32-second comparison. Results and optional scene PNGs save in
`results/`. The adapter serves the actual 128 Copper districts through the
existing snapshot loader and renderer; it does not use the repeated-district
dev stress fixture. Web source files are not modified.

The comparison fixes resolution, seed, logical camera path, vertical FOV, and
shadows off. It disables Web's automatic low-FPS far-terrain shutdown during
the comparison, following the client's existing GPU benchmark convention.
Both engines retain their own LOD and lighting. Run one renderer at a time,
keep its window foreground, and do not interpret browser refresh-limited FPS
as uncapped rendering throughput. See `PERFORMANCE.md` for details.

## Versioned benchmark evidence

The repository retains source code, project/build configuration, benchmark reports,
the two matched-LOD capture manifests, named raw frame-time JSON records, verification
summaries, and paired 720p reference images. Those small evidence files are explicitly
tracked even though their generated parent folders are ignored.

Large terrain archives, captured mesh binaries, baked scenes, `.godot/` caches,
application bundles, temporary latest-result files and high-resolution screenshots
remain local. A fresh checkout needs the documented data-generation/capture steps and
the Godot/Voxel Tools release template before building. The full image/mesh verifier
also needs those local generated artifacts; the saved `verification.json` files record
the checks performed on the original captures.
