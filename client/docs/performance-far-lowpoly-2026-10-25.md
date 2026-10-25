# Far terrain low-poly experiment — 2026-10-25

Follow-up: the [complete-scene integration trial](performance-far-lowpoly-full-scene-2026-10-25.md)
fails the gameplay-frame acceptance gate. Its added CPU/index work and coarser
culling outweigh the isolated savings below. Keep the production packed path.

## Decision

Keep the production renderer unchanged. The low-poly raster prototype is worth
developing further: its 1 px setting reduces isolated far-render GPU medians by
26–38% in the nine terrain-heavy 1440p views across Aether, Nature and Copper.
That saves approximately 0.08–0.28 ms in this particular pass. Across-ring gains
are only 7–15%, close to timer granularity and control variation.

The current implementation is not ready for production. It reduces original
triangle counts by only 15–18%, increases the measured geometry/index allocation
to 2.37–2.57 times the packed control, and takes 21–52 seconds to construct all
three candidate levels. These are frozen, offline measurements, not game FPS.

Use **0.5 px as the conservative starting candidate**, with 1 px as an optional
quality/performance tradeoff to validate. In Aether and Nature, 0.5 px often
performs close to 1 px while changing fewer pixels. Copper shows a somewhat
larger separation. Do not adopt 2 px generally: Aether has a measured silhouette
outlier beyond four pixels. No setting has passed full visual equivalence,
streaming, editing or ordinary-frame acceptance.

Unlike the [software ray prototypes](performance-software-rays-2026-10-25.md),
this experiment finds promising isolated GPU savings. Those experiments use
different snapshots and controls, so their absolute times are not directly
comparable.

## What was implemented

The development-only `FarLowPolyData.ts` / `FarLowPolyLab.ts` modules snapshot
actual settled packed far-Arena records. The fixture repeats local districts
across the world; it is not a captured online world. Camera simulation position
is `(8192.5, 180, 1024.5)`, with a 75-degree vertical FOV. All three worlds use
the same four poses and 2560×1440 output. Aether also runs 1280×720.

Whole 64 m bricks are selected only when their bent bounding box is at least
384 m from the initial camera. Existing caps remain. The moved camera offsets
simulation X/Z by 64/32 m. This frozen selection deliberately excludes the local
view-correction region; **it does not measure the cost of near-camera distortion**.
Global torus curvature remains in every representation.

| World | Resident far quads | Selected quads | Selected bricks |
| --- | ---: | ---: | ---: |
| Aether archipelago | 2,089,207 | 1,346,559 | 15,874 |
| Nature | 1,012,284 | 868,043 | 8,052 |
| Copper metropolis | 2,734,623 | 1,929,838 | 9,435 |

The current far renderer already removes hidden faces and merges rectangular
faces. The experiment simplifies that existing surface; it does not compare
against six separately drawn faces for every solid voxel.

| Mode | Geometry and purpose |
| --- | --- |
| `packed` | Original quads, integer angle LUT torus bend in the vertex shader, 32 faces per indexed instance |
| `mesh` | Same original triangles, welded by position and color, CPU-bent indexed vertices; conversion control |
| `prepared` | Split greedy T-junctions, add center fans where needed, then bend vertices; preparation control |
| `0.5px`, `1px`, `2px` | Independently simplify the prepared bent mesh at nominal screen-error targets |

Preparation changes curved chord surfaces slightly because newly inserted
vertices are bent too. Keeping `mesh` and `prepared` separate makes this visible.
The `prepared` versus `1px` timing pair uses the same vertex layout and shader,
isolating simplification from the packed-to-mesh conversion.

Simplification uses the pinned JavaScript package `meshoptimizer@1.0.1`:
`simplifyWithAttributes`, RGB weights 0.25, `ErrorAbsolute`, `LockBorder` and
`Permissive`. The requested index count is 8% of input, subject to the error and
boundary restrictions; actual counts are much higher. All vertices on the six
brick boundary planes are locked. An unchanged geometric boundary-edge parity
signature is required, otherwise the brick falls back to its prepared mesh.
There were zero such fallbacks in all three worlds. Component pruning is off.
Vertices are not relocated. This is conservative per-brick reduction, not
cross-brick HLOD or a heightfield reconstruction.

The meter target is `nominalPixels * max(1, distanceToBentAABB - 80) / focal`,
where focal length is derived from 1440p. The 80 m margin covers the displaced
validation pose approximately. These are QEM settings, **not guaranteed
Hausdorff, silhouette or pixel-error bounds**. The same geometry is reused at
720p. The library's [official simplification documentation](https://github.com/zeux/meshoptimizer/blob/v1.0/README.md#simplification)
describes error-based simplification and boundary/attribute constraints.

## Measurement method and limits

The browser adapter reports `apple / metal-3`, with the exact device name masked.
This is the local Mac environment used in the earlier hardware study. No new
native clock, thermal or occupancy measurements were collected.

Both paths render one draw with backface culling and matched simple directional
shading from derivative normals. They write RGBA8 color and R32F radial depth,
plus a depth attachment, with one sample per pixel. The packed control uses
custom global-coordinate packing and a 4-byte visible-face map, whereas the
production map is 2 bytes. This control is not the literal production shader.
Indexed meshes use float32 XYZ plus RGBA8, 16 bytes per vertex, and uint32 indices.
They pre-bake the global bend. CPU selection, concatenation and uploads are
outside GPU timing. All modes use the same conservative union bounds and
selected bricks at each pose.

ABBA/BAAB alternates, including an independent packed A/A comparison. Each
treatment submits four identical passes in its own command buffer, then drains
timestamp readback before the next treatment. The first-start to last-end GPU
envelope is divided by four. Four warm-up quartets precede 24 measured quartets
per comparison at 1440p; Aether's accepted 720p extension uses 16. Each case has
seven comparisons: packed against all six modes, plus prepared against 1 px.
There are 16 accepted cases in total. Two initial Aether 720p pilot cases with
eight quartets are retained separately and excluded from these tables.

Observed timing steps are approximately 0.016384 ms after division by four.
A/A median differences reach 11.3% at 1440p. P95 tails remain substantially
larger than medians. Each candidate must be compared with its own paired
reference; reference medians vary across pairs. All six representations remain
allocated during the experiment, unlike a final single-representation renderer.

These timings exclude PBR, MSAA, fog, shadows, near terrain, entities, gameplay,
streaming and the production near/far transition. They cannot establish a total
frame-time gain, a p95 improvement or hardware-wide performance superiority.

## Accepted 1440p timings

Times are GPU p50 milliseconds. “Change” compares 1 px with its own packed
reference. A/A columns show separate identical-code role medians.

| World | Pose | Packed A/A | Paired packed | 1 px | Change | 1 px p95 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Aether | Near-facing | 0.475 / 0.508 | 0.459 | 0.328 | −28.6% | 0.541 |
| Aether | Across ring | 0.213 / 0.197 | 0.213 | 0.180 | −15.4% | 0.623 |
| Aether | Reverse | 0.557 / 0.573 | 0.557 | 0.410 | −26.5% | 0.655 |
| Aether | Moved | 0.524 / 0.524 | 0.524 | 0.377 | −28.1% | 0.639 |
| Nature | Near-facing | 0.262 / 0.279 | 0.262 | 0.180 | −31.3% | 0.459 |
| Nature | Across ring | 0.164 / 0.147 | 0.197 | 0.180 | −8.3% | 0.524 |
| Nature | Reverse | 0.393 / 0.393 | 0.393 | 0.246 | −37.5% | 0.442 |
| Nature | Moved | 0.377 / 0.360 | 0.377 | 0.262 | −30.4% | 0.410 |
| Copper | Near-facing | 0.705 / 0.688 | 0.688 | 0.508 | −26.2% | 0.737 |
| Copper | Across ring | 0.180 / 0.180 | 0.229 | 0.213 | −7.1% | 0.672 |
| Copper | Reverse | 0.868 / 0.967 | 0.885 | 0.606 | −31.5% | 0.852 |
| Copper | Moved | 0.868 / 0.836 | 0.852 | 0.590 | −30.8% | 0.836 |

Controls and alternative error targets follow. Every cell is
`paired reference → candidate`, p50 ms. This prevents attributing all savings
to simplification or choosing a convenient reference from another pair.

| World / pose | Packed → mesh | Packed → prepared | Prepared → 1 px | Packed → 0.5 px | Packed → 2 px |
| --- | --- | --- | --- | --- | --- |
| Aether / near | .459 → .442 | .459 → .459 | .459 → .328 | .459 → .328 | .459 → .311 |
| Aether / across | .213 → .197 | .229 → .229 | .213 → .197 | .213 → .197 | .246 → .213 |
| Aether / reverse | .557 → .541 | .573 → .557 | .541 → .410 | .557 → .442 | .557 → .393 |
| Aether / moved | .557 → .557 | .541 → .557 | .524 → .377 | .524 → .393 | .524 → .377 |
| Nature / near | .262 → .197 | .262 → .246 | .246 → .180 | .262 → .180 | .262 → .180 |
| Nature / across | .164 → .164 | .180 → .164 | .131 → .131 | .164 → .147 | .180 → .147 |
| Nature / reverse | .393 → .311 | .377 → .393 | .360 → .246 | .377 → .246 | .393 → .246 |
| Nature / moved | .360 → .295 | .360 → .344 | .344 → .229 | .360 → .229 | .410 → .279 |
| Copper / near | .721 → .639 | .770 → .934 | .786 → .508 | .705 → .541 | .754 → .492 |
| Copper / across | .229 → .229 | .246 → .229 | .229 → .213 | .197 → .180 | .213 → .180 |
| Copper / reverse | .852 → .819 | .852 → .950 | .901 → .606 | .885 → .672 | .836 → .590 |
| Copper / moved | .868 → .803 | .852 → .901 | .983 → .606 | .852 → .606 | .819 → .557 |

The same-layout prepared comparison supports a real simplification benefit in
terrain-heavy views. The across-ring result is weak: Nature shows no median
gain and the other two worlds improve by one timer step. Conversion alone
helps some views, particularly Nature. No bottleneck attribution to vertex,
fragment or memory hardware has been proven by these timings.

Aether's 720p extension uses the same geometry:

| Pose | Packed A/A | Paired packed → 1 px |
| --- | --- | --- |
| Near-facing | .475 / .459 | .459 → .295 |
| Across ring | .180 / .180 | .180 → .131 |
| Reverse | .541 / .590 | .524 → .377 |
| Moved | .524 / .524 | .508 → .360 |

## Geometry, memory and construction

Triangle counts cover the entire selected snapshot, not just visible triangles.

| World | Original | Prepared | 0.5 px | 1 px | 2 px | 1 px vs original |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Aether | 2,693,118 | 2,893,840 | 2,223,798 | 2,198,608 | 2,133,592 | −18.36% |
| Nature | 1,736,086 | 2,077,558 | 1,486,480 | 1,481,568 | 1,449,724 | −14.66% |
| Copper | 3,859,676 | 4,746,132 | 3,278,078 | 3,161,332 | 3,052,910 | −18.09% |

Geometry plus index/map allocation, MiB:

| World | Packed control | Original mesh | Prepared | 0.5 px | 1 px | 2 px |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Aether | 25.68 | 84.10 | 88.13 | 65.83 | 65.02 | 62.87 |
| Nature | 16.56 | 51.15 | 57.71 | 39.46 | 39.31 | 38.41 |
| Copper | 36.81 | 125.87 | 144.45 | 98.77 | 94.59 | 91.08 |

These are exact prototype data-buffer payloads, not total GPU/process memory.
They exclude render targets, CPU copies, unused variants and small shared
resources such as the angle table. Packed uses 16 bytes/quad plus a 4-byte map;
the production map's smaller size means this is not a favorable production
memory estimate. Position/color seams, locked boundaries and retained caps
constrain reduction. A low triangle count alone does not imply a compact mesh.

| World | Capture | Prepare | Simplify all 3 | Build wall | Per-brick p95 / p99 / max |
| --- | ---: | ---: | ---: | ---: | --- |
| Aether | 1.327 s | 11.037 s | 19.754 s | 31.285 s | 6.8 / 24.4 / 153.7 ms |
| Nature | 0.885 s | 5.137 s | 15.637 s | 21.054 s | 11.0 / 18.5 / 71.8 ms |
| Copper | 1.676 s | 17.937 s | 33.594 s | 51.950 s | 27.8 / 56.8 / 209.7 ms |

Build wall covers preparing and reducing all bricks with periodic frame yields.
It excludes snapshot capture, final buffer concatenation/upload and pipeline
creation. Per-brick time includes preparation and all three simplifications.
It is not a single-level production build estimate. The prototype builds on
the main thread and is unsuitable for normal play. No worker cache, incremental
edit invalidation, upload budget or dynamic LOD handoff has been benchmarked.

## Image checks

There were zero reported WebGPU validation errors in the 16 accepted cases.
Both 0.5 px and 1 px had zero background-coverage differences farther than two
pixels from the other image's terrain coverage in these cases. This check uses
a Chebyshev neighborhood and measures **terrain/background silhouettes only**;
it does not validate internal occlusion edges or all mixed-LOD seams.

At 1440p, coverage-mismatch counts for near/across/reverse/moved are:

| World | 0.5 px | 1 px | 2 px | 2 px differences beyond 2 / 4 px, summed |
| --- | --- | --- | --- | --- |
| Aether | 189 / 16 / 166 / 190 | 242 / 16 / 177 / 217 | 2306 / 151 / 1121 / 1331 | 114 / 1 |
| Nature | 39 / 2 / 34 / 49 | 66 / 2 / 46 / 72 | 221 / 2 / 180 / 148 | 0 / 0 |
| Copper | 193 / 33 / 125 / 129 | 292 / 64 / 160 / 183 | 500 / 151 / 236 / 307 | 2 / 0 |

Each image has 3,686,400 pixels. The 1 px mean maximum-channel RGB difference
(0–255 scale) ranges from 0.206–1.025 in Aether, 0.102–0.337 in Nature and
0.243–1.285 in Copper. Changed RGB pixels are far more numerous than coverage
differences because color interpolation and triangle normals also change.
The 0.5 px setting has a lower mean RGB difference in every tested 1440p pose.

Mean radial-depth differences for 1 px range from 0.019–0.676 m, 0.039–0.454 m
and 0.034–0.441 m respectively. Maximum differences can exceed 1 km at pixels
where a different surface wins. Occlusion boundaries and coplanar ordering are
plausible contributors, but those pixels have not all been classified.

Even the original indexed-mesh control is not pixel-identical to packed:
1440p coverage differences are 10/1/8/3 in Aether, 0/0/0/3 in Nature and
3/0/1/0 in Copper. CPU versus GPU bending precision and ordering are potential
causes. Preparation adds its own changes; Aether's mesh-to-prepared coverage
differences are 37/0/28/19. Thus the simplified-image comparison is against
packed and also separately against prepared in the retained captures.

The inspected previews show recognizable curved terrain and city silhouettes.
They do not certify caves, thin bridges, material boundaries, moving highlights,
temporal stability or transitions to the unchanged near renderer. A no-cracks
guarantee would require mixed-level and edit stress tests beyond this experiment.

## Recommendation for a subsequent integration experiment

1. Keep current packed greedy quads as the fallback. Try low-poly selectively
   on expensive far bricks; choose by measured reduction and byte cost, not
   by world name. Copper also benefits, so this is not only a natural-terrain option.
2. Start at nominal 0.5 px. Validate 1 px where its extra GPU savings justify
   the visual change. Keep the 2 px failure case as a regression fixture.
3. Address memory before broad adoption: evaluate compact positions and local
   indices/mesh partitions, including their decoding and draw-submission costs.
   None of these compression savings has been measured here.
4. Build/cache in a worker with edit invalidation and bounded publication, then
   test real near/far handoff, silhouettes and PBR normals while moving.
5. Make the final decision using paired ordinary gameplay frames and p95 tails.
   An isolated 0.1–0.3 ms saving must survive the additional CPU, memory and
   material work to justify production complexity.

## Reproduction and evidence

Run the client Vite development server and open:

```text
/space/app/?world=aether-archipelago&dev_offline=1&dev_lod=world&dev_dpr=2
```

Also repeat with `world=nature` and `world=copper-metropolis`. Press Play and
wait for the offline fixture to initialize. In that local page's dev console:

```js
game.playerPhysics.position.set(8192.5, 180, 1024.5);
game.playerPhysics.velocity.set(0, 0, 0);
game.playerPhysics.resetRenderInterpolation();
game.uiStore.setDistantSurfaceEnabled(true, false);
```

Wait until the terrain workers, Arena publication and resident face counts
settle, then:

```js
// This checkout's verified Vite file URL; adjust the checkout path if moved.
const { createFarLowPolyLab } = await import(
  '/@fs/Users/ha/Documents/entropydrop_website/entropydrop_space/client/src/dev/FarLowPolyLab.ts'
);
window.lpLab = await createFarLowPolyLab(game);
await lpLab.run({ sizes: [[2560, 1440]], batches: 24 });
// Aether resolution extension:
// await lpLab.run({ sizes: [[1280, 720]], batches: 16 });
```

The lab requires an offline DEV fixture and GPU timestamps, pauses the game's
animation method, and never changes the production path. Show/View buttons
permit manual comparison; Close lab restores the game. For reading results
without keeping GPU buffers resident, navigate **the same tab** to the verified
Vite file URL:

```text
/@fs/Users/ha/Documents/entropydrop_website/entropydrop_space/client/tools/far-lowpoly-results.html
```

Do not substitute `/space/app/tools/…`: this local server routes that URL
through the main application instead of serving the standalone result viewer.

Complete per-brick records, raw timestamps, A/A roles and pixel summaries are
retained as GZIP/base64 in sessionStorage keys `far-lowpoly-<world>-gzip`.
Two preserved results tabs contain Aether and Nature/Copper respectively.
The viewer offers manual JSON export. No raw capture JSON file was exported
to the repository; this report is the durable derived summary. Closing those
tabs may discard the raw records. Plain JSON exceeded Aether's storage quota
initially; its completed result was subsequently compressed and verified.

An attempt to keep a third full WebGPU world open stalled initialization.
Closing the unused context and replacing completed game pages with the static
viewer resolved it. No timings from that stalled attempt are included.
Avoid running multiple heavy world contexts or build/test jobs during timing.

Validation completed:

- Four focused data tests pass: T-junction splitting, compacted vertex/color
  preservation, curved-patch simplification and locked-boundary preservation.
- Client typecheck passes, including inventory checks.
- Production build passes, including offline-entry exclusion, module-init
  order checks and compiler-worker checks. Existing chunk-size/circular-chunk
  warnings remain. The lab has no production imports.

No production rendering code was changed or enabled. The only package change
is declaring the already available meshoptimizer version as an exact client
development dependency.
