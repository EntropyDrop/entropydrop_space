# Space torus comparison mod

An isolated, experimental Minecraft 1.21.1 / Java 21 Fabric mod for comparing the existing Nature, Copper Metropolis and Aether Archipelago standard-cell terrain with Space. This is a rendering experiment, not a playable curved-physics implementation. Entities, sky, weather and gameplay physics retain Minecraft's flat coordinates.

## Dataset

Run from the repository root:

```sh
node tools/minecraft-torus/export-terrain.ts
```

This invokes the original generators (versions 1, 2, 3; seeds 42, 20260922, 42), without microvoxel details. Eight real 512 m zones are exported: `(15,1)`, `(15,2)`, `(16,1)`, `(16,2)`, `(0,1)`, `(0,2)`, `(31,1)`, `(31,2)`. Four surround the camera and four lie across the torus hole. Other zones are empty. No template is repeated. This bounded fixture is **not the complete 128-zone world**.

Each chunk stores 65,536 little-endian uint16 palette indices, deflated. Index 0 is air. The palette stores RGB plus material flags. The export also records per-chunk CRC32 and a canonical SHA-256 over occupancy, RGB and material flags. Minecraft validates all cells after generation, including air. Standard opaque cubes use exact constant-color textures; emissive cells emit light. Native lighting and LOD reconstruction still differ from Space.

Space development fixtures are `torus-compare-nature`, `torus-compare-copper-metropolis` and `torus-compare-aether-archipelago`, generator versions 11–13. They delegate to the originals without details and apply the same zone bounds. These fixtures are not offered in the normal world selector.

## Build and isolated launch

```sh
JAVA_HOME=/path/to/java21 gradle -p tools/minecraft-torus \
  -PbenchmarkMods=/path/to/isolated/mods build
```

Gradle 8.10.2 / Fabric Loom 1.8.13 are used. The compile-only directory must contain Sodium `0.6.13+mc1.21.1` and Distant Horizons `3.3.3-1.21.1`. Their binaries are not redistributed. Fabric API `0.116.11+1.21.1` is provided by the installed DH distribution. The output is `build/libs/space-torus-benchmark-1.0.0.jar`. Exported data is external and must accompany the mod; a JAR alone does not contain the terrain.

Use a **new disposable game directory**, only these two rendering mods and this mod, and fresh saves. Do not install into an existing gameplay modpack or open valuable saves with it. Generate a new save's metadata from a disposable template with Python `nbtlib`:

```sh
python3 tools/minecraft-torus/create-save.py /path/to/template/level.dat \
  '/path/to/isolated/saves/Torus nature' --terrain nature
```

Repeat for `copper-metropolis` and `aether-archipelago`. This copies only modified metadata, not region or player files, and refuses existing destinations. Supply Java flags:

```text
-Dspace_torus.benchmark=true
-Dspace_torus.data=/absolute/path/to/tools/minecraft-torus/data
-Dspace_torus.warmSeconds=60
```

Use Minecraft's `--quickPlaySingleplayer` for the new save. Set Sodium `performance.use_fog_occlusion=false` and `performance.use_block_face_culling=false` in this isolated instance. The benchmark disables Minecraft's section occlusion traversal, fixes the camera and disables VSync. Physical framebuffer size must be exactly 1280 × 720. On the tested Retina Mac this requires a 640 × 360 logical window. A size mismatch or pause aborts sampling. The harness retries size calibration after loading, resetting only this test window's size limits and position.

## Projection and measurements

Small shader-load injections insert our original GLSL into Sodium and DH vertex shaders, and upload the same torus mapping, camera tangent frame and 96–256 m local correction used by Space. Shader source is not copied into this repository. Both CPU frusta use conservative bent bounds. Flat-coordinate face selection and occlusion traversal cannot safely reject curved geometry, so those paths are disabled for **all** comparison modes, including the flat control.

Validate the mapping against the actual Space implementation:

```sh
JAVA_HOME=/path/to/java21 node tools/minecraft-torus/validate-projection.ts /path/to/joml-1.10.5.jar
node --test engine/test/torus-comparison-terrain.test.ts
```

The benchmark validates 8,192 chunks, waits an additional 60 seconds, then measures `flat, torus, across, across, torus, flat`, each with 5 seconds warmup and 10 seconds collection. Eye `(8192.5,180,1024.5)`, vertical FOV 70°, near radius 8 chunks, DH radius 576 chunks. Near views face north and 18° down; across views face north and 85° up. Whole-application frame intervals and screenshots are written locally. Source-generation and screenshot time is excluded.

The Space harness is `client/tools/torus-browser.html?terrain=nature&autorun=1`. Start `node client/tools/torus-result-receiver.mjs OUTPUT_DIRECTORY` first. Keep its 1280 × 720 iframe visible, and stop Minecraft before browser timing. The harness records raw frame intervals, CPU submission spans, asynchronous WebGPU pass timestamps, submitted geometry and pending work.

## Interpretation limits

DH retains its ordinary flat-distance quadtree and LOD error rules; bending a shader does not replace that selection algorithm. Its hierarchy, fog, lighting, sky and near/far stitching differ from Space. Native FPS is uncapped while browser presentation can be capped. A native frame interval must not be compared directly to a browser GPU timestamp. Inspect silhouettes and across-hole coverage before interpreting performance, and use within-renderer flat/torus comparisons only with their changed visible workload stated explicitly.

For a timing rerun of the same unchanged disposable save, `-Dspace_torus.reuseValidation=true` accepts the matching previous `torus-validation.json`. This is opt-in and checks the terrain name and source digest. DH cache coverage must be audited with the SQLite WAL included; reading only the main database can undercount recently written chunks.

## Archived evidence

`client/src/dev/results/torus-minecraft-2026-10-27/` retains accepted compressed frame samples, one valid screenshot per view, validation records, configuration and binary hashes, and compressed native launch logs. `exclusions.json` explains unsuccessful attempts and capture substitutions. Duplicate screenshots, live status files, probe captures and the report preview remain local. The mod's generated terrain, Gradle cache, JARs and distribution archives are reproducible build outputs and are not tracked. Minecraft writes screenshots asynchronously; wait for complete PNG files before archiving them.
