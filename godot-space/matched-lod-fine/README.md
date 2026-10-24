# Fine identical-LOD rendering comparison

A separate fixed-view Copper fixture with 4,206,058 terrain triangles / 245
terrain draws. The original baseline is preserved in `../matched-lod/` and
the full free-flight tour in the parent directory. See `../PERFORMANCE.md`.

Open `launch.command`. F9 measures 8 seconds warm-up plus 24 seconds. F6 cycles
1280×720, 2560×1440, 3840×2160 and 5120×2880. The nominal native cap is 120 FPS.
Results and viewport images go to `results/godot-latest.*`; copy these between
runs to retain them. `--scale=3 --result=/absolute/path/trial.json` also works.

## Recreate the fixture

Start the local comparison server from the repository root:

```sh
node node_modules/vite/bin/vite.js --config godot-space/web-compare.vite.ts
```

The actual Copper surface cache must already exist at
`.local/godot-web-surfaces/copper-metropolis/`. If missing, run
`node godot-space/tools/export-web-surface.ts` first.

Open Chrome at a 1280×720 viewport:

`http://127.0.0.1:5188/space/app/?dev_offline=1&world=copper-metropolis&dev_lod=world&dev_dpr=1&native_comparison=1&lod_profile=fine`

1. Click Play, Escape, Prepare city orbit. Fine mode requests 1 px² with the
   maximum supported 512 MiB geometry / 1024 MiB data budgets. Wait for near
   terrain and far LOD to settle. Inspect renderer shows the *effective* LOD;
   this capture reached 9.75 px² because of the geometry budget.
2. Capture identical Web LOD exports its actual draw geometry to this folder's
   `data/`. The normal profile exports separately to `../matched-lod/data/`.
3. Use the matched-resolution buttons to measure Web. The frozen LOD is the
   same at every resolution. Save images at 720p and 5K for pixel comparison.
4. Build with `godot-space/matched-lod-fine/build.sh`. Close the Web test tab
   before measuring native. Do not compile or generate terrain during samples.
5. Open `launch.command`, keep the window foreground, measure each resolution.
   Avoid UI queries or screenshots during the 32-second warm-up/sample cycle.
6. `python3 godot-space/matched-lod-fine/verify.py` validates the recorded trials.
   For new captures, update that script's trial/image filenames and expected
   manifest counts; never combine records from different capture hashes.

This uses the original Web renderer's packed arena and GPU torus deformation,
while Godot loads preprojected ArrayMeshes in a release build. Identical
triangles/images do not imply identical buffer layouts or pipeline costs.
This fixture does not exercise Voxel Tools runtime meshing, streaming or
player movement. Both render unlit vertex color with 4× MSAA and no HUD.

Code and fixture definitions are versionable; `data/`, `build/`, `.godot/` and
`results/` are local generated files covered by the parent `.gitignore`.

Selected capture manifests, named raw result JSON, verification summaries and 720p
reference images are explicitly tracked as benchmark evidence. Other generated files
remain ignored; see the parent README's versioned-evidence section before running the
full verifier on a fresh checkout.
