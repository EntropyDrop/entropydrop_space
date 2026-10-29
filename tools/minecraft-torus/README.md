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

Use Minecraft's `--quickPlaySingleplayer` for the new save. Set Sodium `performance.use_fog_occlusion=false` and `performance.use_block_face_culling=false` in this isolated instance. The benchmark disables Minecraft's section occlusion traversal, fixes the camera and disables VSync. Physical framebuffer size must be exactly 1280 × 720. On the tested Retina Mac this requires a 640 × 360 logical window. A size mismatch or pause aborts sampling. The harness retries size calibration after loading, constraining only this test window to 640 by 360 logical pixels and resetting its position. It disables Minecraft flight FOV effects and view bobbing, then validates the actual projection matrix at 70 degrees before accepting samples.

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

## Common one-metre detail reference

The follow-up LOD alignment benchmark uses `-Dspace_torus.fixedDetail=true`. It refines all eight fixture zones to DH horizontal detail 0 (one metre), sets vertical quality to `PIXEL_ART`, disables cave culling, distant fog, SSAO and LOD noise, and waits until all 512 target 64 m sections report completed GPU uploads. A graded empty halo preserves DH's quadtree parent/child invariant; an abrupt change to its ordinary distance policy is invalid. This is a common source-detail reference, not the stock adaptive DH preset. Lighting, color transfer, greedy tessellation and near/far blending still differ.

`run-lod-benchmark.py` reuses only the validated disposable saves, runs the three terrains sequentially, checks complete PNG chunks before copying screenshots, and stops each owned Java process in `finally`. It refuses to overwrite accepted compressed samples. Fixed views use `torus, across, across, torus`, with the same 60 s warmup and 5 + 10 s blocks.

Space uses `client/tools/torus-browser.html?terrain=nature&profile=fixed&autorun=1`. Start the loopback receiver on port 54387. The fixed profile requires all eight finest sources, pins voxel mip selection to 1 m and fails if its explicit geometry budget is insufficient. The `adaptive` profile retains production LOD settings. Both run reference/tight/tight/reference for each view, keeping the terrain and lighting unchanged between variants. Do not run native and browser benchmarks together.

The `maintenance` Space profile tests a separate CPU-only candidate with the original visibility guards, 30 seconds of additional steady warmup, and reference/CPU/CPU/reference blocks for stationary and turning views. It records both complete CPU submission time and time spent in the distant voxel update. Changing residency, masks, projection, or publishing a fade invalidates the idle schedule; retired buffers still receive their timed cleanup. This profile does not enable tighter idle culling.

The 2026-10-27 report used a nominal Minecraft FOV of 70 without disabling flight FOV effects. Do not treat its camera framing as verified equal to Space. The 2026-10-28 common-detail comparison explicitly validates the actual matrix; the first nominal-FOV reruns are excluded as well.

## Native Firefox stress comparison

The opt-in `-Dspace_torus.stress=true` path adds a separate 2560 x 1440 experiment. Both renderers retain the common one-metre detail reference, disable MSAA and fog, and use the same eight original terrain zones. This is a high-detail bounded fixture, not a claim to render the complete world at one metre.

Four cases run in forward/reverse order: ordinary view (70-degree vertical FOV, 18 degrees down), dense view (100 degrees, 55 degrees down), a 6-second yaw sweep of plus/minus 90 degrees, and a 6-second translating route with x/z amplitudes 64/32 metres. Eye height is 180 m. Each block warms for 6 seconds and samples for 12 seconds, after 60 seconds of steady initial warmup. Minecraft's yaw is `180 - SpaceYawDegrees`; the signs are required to match the same flat-coordinate direction. Moving cases retain near-terrain streaming work. Screenshots reset to phase zero outside timing.

After building the mod, reuse the existing disposable fixture with:

```sh
python3 tools/minecraft-torus/run-stress-benchmark.py
```

The runner archives complete PNGs and compressed frame records, refuses to overwrite accepted native data, and terminates each owned Java process before the next terrain. After all native processes have stopped, start the local-only receiver:

```sh
node client/tools/torus-stress-receiver.mjs \
  client/src/dev/results/torus-firefox-stress-2026-10-28
```

In native Firefox open `client/tools/torus-stress.html?autorun=1` through the Vite server. The page requires a visible 1280 x 720 CSS iframe, fixes render DPR to 2, and rejects another browser. The archived comparison above included all three terrains. Current follow-up work intentionally runs only Aether Archipelago in native Firefox; the stress host now defaults to that terrain and rejects other world names. Archive any previous run before rerunning the same browser terrain. Do not build or run other benchmarks during sampling.

Run `python3 tools/minecraft-torus/summarize-stress.py` and `python3 tools/minecraft-torus/make-stress-report.py` after all six renderer/terrain captures complete. The summary checks dimensions, source detail, section coverage, actual FOV, all eight blocks, GPU errors and PNG integrity. It reports mean FPS, P95/P99, slowest-one-percent mean FPS, slow-frame fractions, Firefox CPU/GPU subspans and near/far pending-work fractions. Browser presentation limits and different runtime/lighting overhead remain explicit comparison limits.


## Current follow-up: Firefox / Aether Archipelago only

The 2026-10-28 seam and map-upload follow-up uses `focus=1` for dense/move/move/dense, with the same camera, source cells, display settings and 60-second warmup as the stress comparison. Run the receiver against a fresh output folder, then open `client/tools/torus-stress.html?autorun=1&focus=1&run=optimized` in native Firefox. `run=baseline`, `run=seam`, `run=optimized` and `run=repeat` select separate output folders. `maps=full` enables the full-upload reference while retaining the corrected coverage shader. Do not overwrite accepted results.

The host records CPU subspans, per-frame scheduled map bytes, residency and near readiness. Instrumentation is identical across timed variants; spans can be nested and must not be added. After timing, the map-upload reference and optimized path render the settled dense pose and require byte-identical RGBA pixels. That check is independent of moving performance samples.

### Near-terrain cache, workers and command reuse

The 2026-10-28/29 follow-up retains the same Firefox/Aether fixture. Start the stress receiver with a fresh output folder, then open the absolute Vite `/@fs/.../client/tools/torus-stress.html` URL. Use `autorun=1&focus=1&run=baseline&near=baseline`, then `run=cache&near=cache`, `run=workers&near=workers`, `run=batch&near=batch`, `run=optimized&near=scheduled`, and `run=repeat&near=baseline`. Keep the test tab visible; hidden pages abort rather than accepting throttled frames.

`near=cache` retains up to 96 clean standard chunks within a 64 MiB estimated budget and preloads one extra ring. `near=workers` adds a second worker, including speculative work. `near=batch` also reuses opaque near commands. The production `near=scheduled` variant reserves the second worker for active demand and edits; only the primary preloads. Both workers share a four-job in-flight/completed limit. The second module worker starts after the first successful response. None of these modes reduce source detail or shading quality. Command reuse does not merge geometry or reduce GPU draw calls.

For the same-page follow-up, use `autorun=1&focus=1&run=paired&near=scheduled&paired=1`. It runs reference/production/production/reference for dense and moving cases, with the same 6-second settling and 12-second timing windows. Allow approximately four uninterrupted minutes after page load, longer if source preparation is slow. This controls some reload drift but is not a statistical confidence interval. Do not run builds or tests concurrently.

All captures include ready/required near-chunk counts, cache estimates, worker queue depth and bundle counters. After timing, the harness renders ordinary and bundled near geometry at one frozen pose and saves both PNGs plus a strict RGBA equality result. The report generator independently compares these images. Early regional bundle attempts failed this check and are documented separately; they are not the production implementation.

Run `python3 tools/minecraft-torus/make-near-streaming-report.py` to validate accepted samples, update the summary and generate `client/docs/performance-archipelago-near-streaming-2026-10-29.html`. The archived results are under `client/src/dev/results/archipelago-near-streaming-2026-10-28/`. Separate reference runs varied substantially, so report readiness and CPU changes independently of any FPS claim. Cache estimates exclude active terrain, worker/runtime memory, reusable arrays and driver overhead.

### Exact picking discovery follow-up

The next CPU experiment uses the same native Firefox/Aether fixture and keeps all production near-streaming optimizations enabled. Start the stress receiver against a fresh folder and open `client/tools/torus-stress.html?autorun=1&focus=1&run=paired&near=scheduled&paired=1&experiment=picking` through the absolute Vite `/@fs/` URL. Only `World.aimRaycastDiscoveryOptimized` changes between the reference/discovery/discovery/reference blocks. The first-visit cell order, sampling interval, reach and exact face intersections remain identical; the optimized path skips overlapping sample neighborhoods and repeated empty-cell classification.

After timing, the harness waits for near readiness and ownership fades to settle, then checks the reference and optimized picking results, full/incremental upload pixels and ordinary/bundled near pixels. Keep the tab visible throughout timing and stop other builds or benchmarks. `python3 tools/minecraft-torus/make-picking-report.py` validates the archived `archipelago-picking-2026-10-29` results and writes `client/docs/performance-archipelago-picking-2026-10-29.html`. The test shows reduced picking CPU cost; FPS block ranges overlap, so do not describe the average FPS difference as a proven stable gain.

`client/tools/terrain-coverage-probe.html` is a native Firefox GPU regression check for the production coverage shader. It renders known ownership masks and compares every pixel against independent flat-coordinate chunk ownership, including both periodic seams and side-face offsets. The legacy shader is kept only inside this DEV probe to reproduce the failure. It must fail at least one case while the production shader must pass all cases. The output is `firefox/aether-archipelago/coverage-probe.json` under the active receiver root.
