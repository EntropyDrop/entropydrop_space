# Color diversity and 8-bit palettes — 2026-10-26

Reducing far-terrain base colors does not show a consistent rendering-speed
advantage in these fixtures. An actual 8-bit palette index can shrink the face
record allocation by about 25%, but this is not a 25% reduction in total GPU
memory or frame time. Quantizing before greedy meshing has a separate, modest
effect in the sampled intermediate LODs.

Open the [image comparison](performance-color-palette-2026-10-26.html) to inspect
original, 256-color and monochrome far terrain. Production rendering and saved
settings are unchanged; all variants are explicit offline development probes.

## What “8-bit” means here

- **8 bits per channel:** already used by near/micro terrain color attributes,
  far-tile RGB arrays, and the far arena's packed RGB bytes. RGB has up to
  16,777,216 combinations. This is different from an 8-bit palette index.
- **8 bits per base-color index:** choose one of up to 256 RGB colors. The
  palette itself still stores byte RGB values. Lighting, interpolation and
  tone mapping can produce more than 256 final screen colors.
- **8-bit render targets:** a separate change to post-processing precision.
  Ultra's scene and atmosphere targets use half floats, and its emission path
  encodes information above 1 in alpha. Blindly changing those targets to
  normalized bytes would change the rendering semantics. These Medium-quality
  tests do not benchmark that change.

[VoxelLodPlanner](../../engine/src/render/VoxelLodPlanner.ts) already emits
`Uint8Array` colors and converts ordinary sRGB colors to byte linear RGB.
[VoxelFaceArena](../../engine/src/render/VoxelFaceArena.ts) packs the bytes into
the fourth `u32` of a 16-byte face record, then uses `unpack4x8unorm` in the vertex
shader. Materials are shared across differently colored far faces. Near standard
terrain similarly uses byte RGBA in
[LowPolyMesher](../../engine/src/mesher/LowPolyMesher.ts).

Lowering the number of values in an unchanged buffer does not change its layout.
The compact experiment uses three scalar `u32` words per face, with the palette
index packed alongside the three-bit direction and one-bit emission flag. A
`vec3<u32>` array would retain a 16-byte stride because of alignment. The relevant
rules and byte-unpacking operation are specified by
[WGSL memory layout](https://www.w3.org/TR/WGSL/#alignment-and-size) and
[unpack4x8unorm](https://www.w3.org/TR/WGSL/#unpack4x8unorm-builtin).

## Rendering experiment

[ColorPaletteTrial](../src/dev/ColorPaletteTrial.ts) prebuilds four versions:

| Mode | Color values | Face record | Shader / material behavior |
| --- | --- | --- | --- |
| Original | Original byte RGB | 16 bytes | Original production PBR |
| Palette 256 | Weighted median-cut palette, nearest RGB | 16 bytes | Original decoding, no palette lookup |
| Packed 256 | Identical palette colors | 12 bytes + shared 1 KB palette | Palette lookup in vertex shader |
| Mono | One base color | 16 bytes | Original decoding |

Only settled far-arena face colors/storage change. Geometry, indices, torus
projection, visibility maps, near terrain, character, lighting and HUD remain.
All roles run the same material-swap loop. Buffer creation, palette building,
uploads/compilation warm-up and image readbacks are outside accepted sampling.
All variant resources coexist, so the reported compact allocation is the size
of its face payload in isolation, not measured whole-process peak memory.

The three-world comparison uses 2560 x 1440, DPR 2, 4x MSAA, Medium, shadows off,
100% fixed resolution, command caching on and optional torus backface culling off.
This is the offline 128-district repeated-source fixture on Apple / metal-3;
the browser masks the precise GPU model. Clocks and thermals are not fixed.
Nature is viewed from Y=180 so the far surface is actually visible; the original
Y=18 ground view was occluded and is retained separately as a control.

Each world has 16 accepted blocks: four repetitions per mode in the balanced
order `ABDC BCAD CDBA DACB`. Each block has 1.2 seconds warm-up and 3 seconds
sampling. Four preliminary blocks, 1.2 seconds warm-up plus 1 second sampling,
are excluded. The camera stays at one position while yaw follows
`pi/2 + 0.6*sin(2*pi*t)`, pitch -0.85. This isolates settled render work, not
moving-camera streaming, palette regeneration, or editing cost.

The three-world runs contain 17,304 accepted frames and 2,883 GPU timestamp
samples, with zero uncaptured GPU errors. Resident data remains immutable and
all accepted blocks have zero pending terrain frames. GPU timing is the envelope
from first GPU pass start to last pass end, sampled about every sixth frame;
it is not a GPU utilization percentage.

| World | Original FPS | Palette 256 FPS | Packed 256 FPS | Mono FPS |
| --- | ---: | ---: | ---: | ---: |
| Aether | 120.0 | 120.0 | 120.0 | 120.2 |
| Nature, elevated | 120.0 | 120.1 | 120.0 | 120.0 |
| Copper | 119.5 | 119.1 | 119.8 | 119.4 |

These values are near the roughly 120 Hz presentation limit. Minor values above
120 are short-window callback timing effects. They cannot establish uncapped
throughput equivalence. GPU spans provide the additional comparison:

| World | Original GPU p50 | Palette 256 | Packed 256 | Mono |
| --- | ---: | ---: | ---: | ---: |
| Aether | 3.342 ms | 3.342 ms | 3.342 ms | 3.277 ms |
| Nature, elevated | 2.753 ms | 2.687 ms | 3.015 ms | 3.015 ms |
| Copper | 4.129 ms | 4.063 ms | 4.129 ms | 3.998 ms |

Block timings overlap and drift; for example Nature's original GPU block
medians range from 1.835 to 3.342 ms. Do not turn these small aggregate changes
into a promised speedup. In particular, the packed variant does not show a
consistent GPU benefit across worlds.

An additional 3840 x 2160 Copper run uses eight preliminary warm-up blocks
(21.6 seconds total), then the same 16-block comparison. The higher focal
resolution selects more resident terrain, so compare modes within this run,
not directly against the 1440p scene:

| 4K Copper mode | FPS | GPU span p50 | GPU span mean |
| --- | ---: | ---: | ---: |
| Original | 117.6 | 5.374 ms | 5.536 ms |
| Palette 256 | 118.8 | 5.374 ms | 5.537 ms |
| Packed 256 | 118.0 | 5.439 ms | 5.596 ms |
| Mono | 119.4 | 5.439 ms | 5.640 ms |

This is a higher GPU workload, but still close to the presentation limit. The
small FPS differences have overlapping block ranges; original and Palette 256
have effectively identical mean GPU spans. Compact storage has no demonstrated
speed advantage here either. Including this run gives 23,002 accepted frames
and 3,832 GPU samples, still with zero uncaptured GPU errors. Its face allocation
is 56 MiB original versus 42.001 MiB compact. Do not interpret these tests as an
uncapped, cross-device benchmark.

## Memory and image checks

| World | Resident distinct colors | Palette colors | Original face allocation | Compact allocation including palette |
| --- | ---: | ---: | ---: | ---: |
| Aether | 7,432 | 256 | 36 MiB | 27.001 MiB |
| Nature, elevated | 220 | 220 | 16 MiB | 12.001 MiB |
| Copper | 16,811 | 256 | 44 MiB | 33.001 MiB |

The allocation includes unused capacity within arena pages. Visibility maps,
index buffers, textures, render targets and other scene resources are excluded.
The decoded vertex color remains a floating-point vector; palette storage does
not make PBR lighting use 8-bit arithmetic.

Frozen captures have identical draw calls and triangles in all modes. Packed
256 matches Palette 256 exactly, and restoring Original reproduces its image
exactly. The 256-color image changes more than two RGB levels in 4.73% of Aether
pixels and 0.56% of Copper pixels. Nature is pixel-identical because its resident
colors already fit in a palette. These percentages include sky and unchanged
near terrain; they are not an error rate restricted to far-terrain pixels.
The adaptive palette looks close at this distance, with localized differences
in small colored details. Mono visibly removes terrain color information.

## Color equality and greedy meshing

[meshVoxelBrick](../../engine/src/worldgen/VoxelSurfaceGenerator.ts) merges
adjacent exposed cells only when their color/material tokens match. Lower color
diversity can therefore reduce geometry **if quantization precedes meshing**.
Changing colors on already generated faces cannot obtain that reduction.

[measure-color-meshing.ts](../tools/measure-color-meshing.ts) samples four
64x256x64 columns in district (16,2) for each terrain, includes micro ornaments
using the production solid-precedence rule, and uses the existing greedy mesher.
Each original mip is quantized independently, with a palette weighted by exposed
area. Occupancy and emissive flags are retained; exposed and emissive surface
areas match in every case. The palette differs from the whole-resident-scene
palette in the rendering experiment. These are face-count measurements, not
measured FPS or meshing-throughput gains.

| World | 1 m faces original → palette | 2 m faces | 4 m faces | 8 m and coarser |
| --- | --- | --- | --- | --- |
| Aether | 30,633 → 30,610 (-0.08%) | 10,253 → 9,833 (-4.10%) | 2,886 → 2,728 (-5.47%) | No reduction |
| Nature | 5,303 → 5,303 | 3,040 → 3,040 | 1,753 → 1,747 (-0.34%) | No reduction |
| Copper | 29,697 → 29,697 | 17,240 → 17,224 (-0.09%) | 5,568 → 5,413 (-2.78%) | No reduction |

The small Nature reduction and Aether's 1 m reduction come from equality after
the existing linear-byte conversion, not from exceeding 256 colors. Intermediate
mips introduce extra colors by averaging occupied children. At 8 m and above,
the mesher's `max(1, 8 / size)` merge limit permits only one cell per quad, to
bound torus chord error. Palette reduction cannot merge those faces under the
current geometry rules. Monochrome can merge much more at fine levels, but
discards the original terrain appearance; raw counts are retained in the data.

## Character relevance and recommendation

The loaded avatar has 291 material instances/slots, including textured faces
and cached tools, but only 44 distinct untextured material colors. Merely allowing
256 colors cannot solve those separate mesh/material submissions.
[createVoxelGroup](../src/engine/render/CuteCharacter.ts) creates six face
materials for each outer-layer box even when colors repeat. The earlier
[character benchmark](performance-character-rendering-2026-10-26.md) identified
283 extra draws for only 2,052 triangles in a frozen third-person pose.

Keep original color quality as the default. Prioritize merging character geometry
per animated body part and sharing materials; this preserves color variety.
Treat 8-bit far palettes as a possible memory/data-size feature, with explicit
handling of new colors, palette updates and transitions. A streaming palette
implementation was not built or measured here. Quantization before intermediate
LOD meshing is a separate candidate with modest sampled face reductions; it
needs an end-to-end image/FPS comparison before being adopted.

## Reproduction and retained data

- [Numeric summary](../src/dev/results/color-2026-10-26/summary.json)
- [Meshing counts](../src/dev/results/color-2026-10-26/meshing.json)
- [Avatar material audit](../src/dev/results/color-2026-10-26/avatar-materials.json)
- [Aether raw frames and pixel checks](../src/dev/results/color-2026-10-26/aether-archipelago/raw.json.gz)
- [Nature elevated raw frames and pixel checks](../src/dev/results/color-2026-10-26/nature/raw.json.gz)
- [Copper raw frames and pixel checks](../src/dev/results/color-2026-10-26/copper-metropolis/raw.json.gz)
- [4K Copper raw frames and pixel checks](../src/dev/results/color-2026-10-26/copper-4k/raw.json.gz)
- [Occluded Nature ground control](../src/dev/results/color-2026-10-26/nature-ground-control/raw.json.gz)

Use the explicit offline fixture with `dev_offline=1&dev_lod=world&dev_dpr=2`.
Enable far terrain temporarily and wait for settled residency, then explicitly
import `createColorPaletteTrial`, `runColorPaletteFrames` and
`captureColorPalettePixels`. Warm all four modes before accepted sampling;
capture images afterward and dispose the trial. Restore the temporary far
choice, camera position and browser viewport.

Run `node client/tools/measure-color-meshing.ts` and
`node client/tools/summarize-color-palette.mjs` to regenerate and validate the
summaries. GPU timing must not overlap those CPU-heavy steps. Typecheck and
English-only checks pass; no production renderer change is enabled.
