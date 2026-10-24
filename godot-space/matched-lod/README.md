# Identical Web LOD rendering comparison

This separate app renders the existing Web client's captured Copper terrain
at one fixed camera position. It is not a new tour and does not estimate
streaming, gameplay, or meshing performance. The normal torus tour remains in
the parent directory. See `../PERFORMANCE-matched-baseline.md` for these baseline measurements and
limitations. The newer fine fixture is in `../matched-lod-fine/`, with its
results in `../PERFORMANCE.md`.

Double-click `launch.command`. **F9** measures 8 seconds warm-up + 24 seconds;
**F6** changes between 720p and 1440p. Native FPS is capped at 120 to match the
browser's observed display cadence. Results and viewport PNGs save under
`results/`. Optional `--scale=2 --result=/absolute/path/result.json` sets the
initial resolution and output location.

## Capture and build

From the repository root:

```sh
node godot-space/tools/export-web-surface.ts
node node_modules/vite/bin/vite.js --config godot-space/web-compare.vite.ts
```

Open the local URL at a 1280×720 browser viewport:

`http://127.0.0.1:5188/space/app/?dev_offline=1&world=copper-metropolis&dev_lod=world&dev_dpr=1&native_comparison=1`

1. Click Play, Escape, then Prepare city orbit. Wait for READY.
2. Click Capture identical Web LOD. The game stops and retains its settled
   terrain draw commands. Geometry files and the ownership mask are exported
   to `data/`. The replay uses original Web arena storage/material deformation
   and standard/micro meshes; it does not load a replacement Web renderer.
3. Run the matched 720p and 1440p buttons. Save the reference image. Close the
   Web test tab before measuring native performance.
4. Run `./godot-space/matched-lod/build.sh`, then `launch.command`. Building
   verifies each mesh hash and byte/index counts, reverses front-face winding,
   and writes a packed scene using the same positions, colors and mask UVs.
5. Keep the native window foreground, press F9, copy the result, then F6 and F9
   for the other resolution. Do not run export/generation during measurement.

The baker uses the official installed Godot/Voxel Tools editor and downloaded
release template. This app uses captured ArrayMeshes, so it does not exercise
Voxel Tools runtime meshing. Web continues to bend its packed vertices on the
GPU; the fixed native snapshot uses preprojected vertices. Both have the same
visible triangles but distinct rendering implementations.

`verify.py` checks the recorded trial named in that script, including pixel
agreement (Pillow and NumPy required). Recapturing replaces `data/`; new result
pairs and reference images must then be supplied before comparing hashes.
Do not combine measurements from different capture manifests.

The original Web client's source is unchanged. Adapter/export code lives in
`../web-compare/` and `../web-compare.vite.ts`. Data, build products and results
are intentionally Git-ignored.

Selected capture manifests, named raw result JSON, verification summaries and 720p
reference images are explicitly tracked as benchmark evidence. Other generated files
remain ignored; see the parent README's versioned-evidence section before running the
full verifier on a fresh checkout.
