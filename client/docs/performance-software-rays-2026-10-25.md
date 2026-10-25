# Software ray rendering experiments — 2026-10-25

## Decision

Keep the production raster renderer. Three WebGPU compute prototypes were
implemented and run on actual curved far-terrain faces: a triangle SAH BVH,
a sparse spatial brick hierarchy, and nonlinear distance-bound skipping with
exact triangle fallback. None won any accepted view/resolution comparison.
No production rendering path was changed or enabled.

The BVH is the most promising of these prototypes for a future **small number
of queries**, not for a full-resolution primary-ray replacement. This experiment
does not establish a picking, shadow, reflection or gameplay FPS improvement.
It also does not establish an upper bound on all possible software ray renderers.

## Scope and implementation

The offline Aether repeated-district fixture settled at 2,089,207 resident far
faces and 153 near chunks. A frozen snapshot retained 1,498,756 far quads;
590,451 were excluded using a conservative 320 m distance rule at the original
camera, to avoid its local shape correction. The moved view changes the camera
by 64 m in X and 32 m in Z against that same frozen snapshot. It does not test
streaming, re-snapshotting or the production near/far transition.

Each face is decoded from the real packed Arena records and bent with
`bendTorusPoint`. All modes use the same resulting two triangles, backface
culling, flat color, directional illumination and one sample per pixel.
This is a **far visibility and simple shading benchmark**, not full PBR,
MSAA, fog, post-processing, near terrain, entities, simulation or online play.
It tests the far component of a possible near-raster/far-ray hybrid; it does
not implement or validate the complete composite renderer.

| Prototype | Implemented algorithm | Important boundary |
| --- | --- | --- |
| BVH | 12-bin SAH, binary bent-space AABBs, at most 8 faces/leaf, near-first stack traversal | Full CPU build, no incremental refit or compressed nodes |
| Sparse bricks | Flat-space 4×4×4 partitions, 32 m base bricks, finer spatial groups, threaded stackless traversal of bent bounds | References exact triangles; not a compact occupancy SVO or flat-space straight DDA |
| Distance field | 8³ unsigned Chebyshev distance bounds per base brick, packed to 4 bits/cell; analytic torus inverse at each step; exact triangle fallback | Local empty-space skipping, not a signed global SDF surface renderer |

An ordinary straight DDA in simulation coordinates would follow the wrong
path: a straight ray in rendered space becomes curved under the torus inverse.
The sparse prototype therefore intersects bounds enclosing the actual bent
triangles. The distance variant explicitly evaluates that inverse along its ray.
Its 1/8 step scale and inflated occupancy are empirical deformation safeguards,
**not a proven global Lipschitz bound**. Zero coverage differences in this fixture
cannot certify all possible edits, heights or torus singularities.

The raster control vertex-pulls these same pre-bent faces in one draw after
CPU frustum selection. It deliberately isolates visibility from the production
shader's deformation and material costs. CPU selection is outside GPU timing.
Therefore its timings must not be presented as the production far pass time.

## Measurement method

Browser adapter reports `apple / metal-3`; the environment is the same local
Mac used in the [M1 Pro hardware study](performance-gpu-hardware-2026-10-23.md).
The browser masks its exact device name. User agent: Chromium 156 on macOS.
These trials did not collect new native frequency, thermal or occupancy data.

Four fixed poses: near-facing, across-ring, reverse, and moved. Rendering sizes
were 640×360, 1280×720 and 2560×1440. Raster submits respectively 378,069,
117,988, 471,489 and 408,202 selected faces; ray traversal sees the whole snapshot.

ABBA and BAAB alternate. Each treatment submits four identical passes, then
drains its timestamp readback before the next treatment. The GPU envelope from
first pass start to last pass end is divided by four. Pixel readbacks, CPU builds,
upload, camera setup and diagnostic atomics are outside timings. There are four
warm-up quartets, then 12 measured quartets at 360p and eight at 720p/1440p.
Identical-code raster A/A controls preserve their separate role positions.

There is no clock lock or claim of an idle GPU/compositor. A/A median differences
reach about 18% in the initial matrix, and about 14% in the final field variant.
That precludes small-win claims, but is much smaller than the candidate regressions.
Numbers below are GPU milliseconds, not FPS, busy-time percentages or a complete
game-frame budget. Each candidate must be compared with **its own paired reference**.

## Accepted initial matrix

Each algorithm cell is `candidate / paired raster`, p50 milliseconds.
The original field used padded, potentially thin rectangular domains.

| Resolution | View | Raster A/A | BVH | Sparse bricks | Distance bounds |
| --- | --- | --- | --- | --- | --- |
| 640×360 | Near-facing | 0.508 / 0.508 | 2.294 / 0.524 | 6.160 / 0.508 | 20.808 / 0.508 |
| 640×360 | Across ring | 0.164 / 0.164 | 0.737 / 0.164 | 1.524 / 0.164 | 5.145 / 0.164 |
| 640×360 | Reverse | 0.623 / 0.606 | 2.212 / 0.606 | 3.555 / 0.623 | 12.878 / 0.606 |
| 640×360 | Moved | 0.557 / 0.541 | 2.081 / 0.557 | 6.439 / 0.557 | 25.166 / 0.557 |
| 1280×720 | Near-facing | 0.573 / 0.590 | 6.783 / 0.590 | 14.860 / 0.623 | 49.480 / 0.606 |
| 1280×720 | Across ring | 0.197 / 0.180 | 2.245 / 0.197 | 2.933 / 0.197 | 9.978 / 0.197 |
| 1280×720 | Reverse | 0.688 / 0.803 | 5.882 / 0.754 | 8.749 / 0.721 | 28.901 / 0.705 |
| 1280×720 | Moved | 0.606 / 0.639 | 6.259 / 0.623 | 15.647 / 0.688 | 58.278 / 0.770 |
| 2560×1440 | Near-facing | 0.803 / 0.786 | 20.808 / 0.786 | 43.270 / 0.819 | 126.042 / 0.786 |
| 2560×1440 | Across ring | 0.442 / 0.442 | 7.389 / 0.442 | 8.733 / 0.426 | 24.265 / 0.573 |
| 2560×1440 | Reverse | 0.901 / 0.983 | 18.399 / 0.901 | 25.772 / 0.901 | 72.892 / 0.918 |
| 2560×1440 | Moved | 0.983 / 0.803 | 19.382 / 0.852 | 44.794 / 0.852 | 146.506 / 0.836 |

1440p BVH p95 values: 21.316, 7.913, 19.071 and 19.743 ms.
Sparse-brick p95 values: 43.811, 9.290, 26.198 and 45.433 ms, in the same view order.

## Final field refinement

Thin field domains made their minimum cell dimension unnecessarily small.
The final code uses a cube centered on each padded brick bound, with side at
least 32 m. Occupancy inflation and the 1/8 deformation factor stay unchanged.
All four modes still run pixel comparisons, but only raster A/A and the field
candidate are timed in this refinement, with eight measured quartets per case.

| Resolution | View | Raster A/A | Field's paired raster | Cubic field p50 | Cubic field p95 |
| --- | --- | --- | ---: | ---: | ---: |
| 640×360 | Near-facing | 0.508 / 0.524 | 0.557 | 14.991 | — |
| 640×360 | Across ring | 0.164 / 0.164 | 0.164 | 6.652 | — |
| 640×360 | Reverse | 0.639 / 0.606 | 0.606 | 9.781 | — |
| 640×360 | Moved | 0.541 / 0.590 | 0.541 | 20.972 | — |
| 2560×1440 | Near-facing | 0.786 / 0.803 | 0.852 | 94.700 | 95.584 |
| 2560×1440 | Across ring | 0.475 / 0.459 | 0.442 | 26.001 | 27.230 |
| 2560×1440 | Reverse | 1.032 / 0.885 | 0.967 | 55.214 | 56.132 |
| 2560×1440 | Moved | 0.852 / 0.819 | 0.852 | 115.835 | 117.539 |

The refinement helps three views and hurts across-ring. It does not change
the recommendation. Comparisons between field revisions were sequential,
not an interleaved revision-vs-revision experiment; no precise percentage gain
is asserted. The final code is the cubic variant; rerunning it will not reproduce
the initial rectangular-field column exactly.

At 640×360 across-ring, diagnostic counters explain some of the extra work:

| Mode | Node visits | Face tests | Field steps | 64-step fallbacks | Field skips |
| --- | ---: | ---: | ---: | ---: | ---: |
| BVH | 2,148,780 | 258,989 | 0 | 0 | 0 |
| Sparse bricks | 18,078,594 | 635,574 | 0 | 0 | 0 |
| Cubic field | 18,078,594 | 558,975 | 1,540,709 | 8,821 | 11,222 |

All three hit 17,882 pixels. This brick ordering visits many more nodes than
the near-first BVH. The field avoids only 76,599 face tests while adding over
1.5 million nonlinear inverse evaluations. These counters support a local
algorithmic explanation; they do not identify hardware cache or occupancy stalls.

## Correctness and costs

There were zero reported WebGPU validation errors in either accepted matrix.
All three compute modes agreed exactly at 360p in the initial matrix. At 720p
and 1440p there were a few RGB tie differences between compute traversal orders,
with no coverage or depth differences in the measured cases. In the final cubic
variant, field-vs-BVH had zero differences at 360p; at 1440p it had 1, 1, 10 and
8 changed RGB pixels, with zero coverage or depth differences.

Compute vs raster is **not pixel-identical**. In the initial 1440p matrix, BVH
had 61, 8, 37 and 43 coverage differences out of 3,686,400 pixels; RGB differences
were 2,145, 14,422, 2,105 and 2,965 pixels, using a 1e-4 channel threshold. The
largest normalized depth difference was approximately 0.000241 in that matrix.
Raster edge rules, depth precision and coplanar ties are plausible contributors,
but every mismatch has not been individually classified. Strict visual fidelity
therefore remains unproven. The benchmark compares the shared experimental
geometry, not all production materials and transition behavior.

| Resource/build | Measured value |
| --- | ---: |
| CPU snapshot and bend | 1.01–1.03 s |
| BVH full CPU build | 2.37–2.58 s |
| Brick hierarchy plus field full CPU build | 6.17–6.23 s |
| Shared bent face buffer | 95,920,384 bytes (91.48 MiB) |
| BVH nodes and face IDs | 39,771,472 bytes (37.93 MiB), 527,757 nodes, depth 25 |
| Brick nodes and face IDs | 41,264,592 bytes (39.35 MiB), 551,087 nodes, depth 8 |
| Packed distance values | 22,278,912 bytes (21.25 MiB) |

These are prototype buffer sizes, not a total process-memory measurement.
The lab retains both structures, CPU arrays, readbacks and render targets. A
single hypothetical implementation could release the unused ones. Builds run
synchronously for research and are unsuitable for the game main thread.
Incremental edits, worker building, streaming updates, GPU upload latency and
transition costs are not implemented or benchmarked. Full-build costs are not
substitutes for an incremental-edit benchmark.

For context only, the unchanged full-scene baseline at 2560×1440 measured
125.3 / 123.7 / 125.5 FPS for fixed / sweep / rapid rotation; independent GPU
span p50 was 2.884 / 3.211 / 2.621 ms and CPU p50 2.9 / 3.5 / 3.3 ms. These
are separate ordinary-frame workloads, not the raster controls in the tables.

## Instrument audit and evidence retention

Early attempts exceeded a storage binding limit or aliased a storage output
with the raster attachment. Those invalid attempts were fixed and excluded.
An initial inverse-view-projection ray generator had unnecessary cancellation
error at world scale; accepted trials use camera-relative projection and rays.
An early mixed raster/compute command buffer also made the reference time track
the following compute treatment. Those timings were rejected. Accepted runs
drain between treatment groups and retain A/A controls.

The browser JSON download authority was cancelled; **no raw JSON file was
exported to the repository**. It was not retried through another export channel.
Complete accepted measurements, including raw timestamp strings, remain in the
experiment tab's `sessionStorage` under:

- `space-software-ray-initial-complete`: the initial 12-case matrix.
- `space-software-ray-results`: the final eight-case cubic refinement and counters.

This report is an analytical summary, not a replacement raw capture. Closing
that tab can discard session storage. The lab's Download JSON button is available
for a manual export on future runs. Re-running overwrites the second key.

## Reproduction

Open the local offline URL, click Play, enable distant terrain, and wait for
2,089,207 resident faces with no pending Arena work:

```text
http://localhost:5173/space/app/?world=aether-archipelago&dev_offline=1&dev_lod=world&dev_dpr=2
```

From DevTools in that offline page (the absolute Vite path is this checkout):

```js
game.uiStore.setDistantSurfaceEnabled(true, false);
// Wait until game.world.distantSurface.voxels.arena is settled.
const { createSoftwareRayLab } = await import(
  '/@fs/Users/ha/Documents/entropydrop_website/entropydrop_space/client/src/dev/SoftwareRayLab.ts'
);
window.rtLab = await createSoftwareRayLab(game);
await rtLab.run({ sizes: [[640,360],[1280,720],[2560,1440]], batches: 16 });
// Use the lab buttons to inspect modes or manually export the result.
// Restore the ordinary game and release experiment GPU resources:
await rtLab.dispose();
```

The lab requires DEV, an offline game and GPU timestamp support. Keep the tab
visible and do not run builds while timing. HMR can reload the fixture; completed
rows are saved to session storage after each case. The lab does not import into
the production entry point.

## Recommended next work

1. Retain rasterization for primary visibility. Continue the existing native
   profiling investigation of far geometry and browser composition before
   selecting another production optimization.
2. Retain this BVH experiment as a possible base for sparse queries. Measure
   actual query counts, latency and update cost before adopting it for picking
   or secondary visibility. No such speedup is claimed here.
3. Do not integrate the tested sparse hierarchy or distance field into the main
   view. A compact occupancy SVO, GPU coherent traversal, proven curved DDA,
   temporal reconstruction or a different shading workload would be a new
   experiment, not an outcome already demonstrated by this one.

## Validation

- `node --import ./test/setup.ts --test test/software-ray-data.test.ts` in `client/`: three tests passed (face coverage/bounds, distance-grid transform, traversal candidates).
- `npm run typecheck --workspace @entropydrop/space`: passed, including inventory type checking.
- `npm run build --workspace @entropydrop/space`: passed; production excludes the offline entry, module initialization passes four import orders, and the compiler worker checks pass. Existing chunk-size, circular-chunk and browser-externalization warnings remain.
- Browser runs: 12 initial cases plus eight field-refinement cases, each with all-mode pixel comparisons; no accepted-run GPU validation errors.

## Primary references

- [PBRT: Bounding Volume Hierarchies](https://www.pbr-book.org/4ed/Primitives_and_Intersection_Acceleration/Bounding_Volume_Hierarchies): SAH and the tradeoff between build and traversal cost; this prototype uses 12 bins.
- [Laine and Karras: Efficient Sparse Voxel Octrees](https://research.nvidia.com/publication/2010-02_efficient-sparse-voxel-octrees): compact voxel ray casting. The prototype here is inspired by sparse spatial traversal, not a reproduction of that representation or its reported performance.
- [Hart: Sphere tracing](https://experts.illinois.edu/en/publications/sphere-tracing-a-geometric-method-for-the-antialiased-ray-tracing/): distance-based safe stepping for implicit surfaces. Our local unsigned field plus empirical deformation scale does not inherit that guarantee automatically.
