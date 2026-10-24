> Superseded: this measured an incorrect flat 512 × 512 crop. It does not describe the current full torus. See PERFORMANCE.md for the corrected implementation.

# Aether renderer experiment — 2026-10-24

The Godot prototype runs the touring scene successfully. It has higher uncapped
average FPS than the browser control, but **a performance improvement over the
existing Space game has not been established**. The browser is refresh-limited,
and the native run still has occasional long frames.

## Recorded results

Apple M1 Pro, macOS 26.5.1. Godot 4.7.2 / Voxel Tools 1.7 release build using
Metal Forward+, compared with Three.js r183 WebGPU in Chrome 154.
Both rendered at 1280 × 720, vertical FOV 70 degrees, with an 8-second warm-up
followed by the same 24-second camera orbit. No AA, shadows or post-processing.

| Measurement | Godot native | Three.js WebGPU control |
| --- | ---: | ---: |
| Average FPS | 209.05 | 120.00 |
| Mean frame interval | 4.78 ms | 8.33 ms |
| Median frame interval | 4.15 ms | 8.30 ms |
| p95 frame interval | 9.49 ms | 8.90 ms |
| p99 frame interval | 14.54 ms | 9.30 ms |
| Worst observed interval | 119.45 ms | 9.50 ms |
| 1% low FPS | 37.62 | 107.13 |
| Samples | 5,020 | 2,881 |
| Maximum draw calls | 1,812 | 1,813 |

The primary native run was unattended, with the browser comparison tab closed.
It recorded zero unfocused measurement frames and no focus loss. The browser
run recorded no visibility loss. The 1% low is the reciprocal of the mean of
the slowest 1% of frame intervals, not the reciprocal of p99.

Native frame intervals come from a monotonic wall clock; Godot's smoothed
simulation delta is deliberately not used. Browser intervals come from
`performance.now()` inside the animation loop. GPU timing was unavailable from
this native release build. The browser reported about 2.63 ms per GPU render
pass on average; without a native GPU measurement, that is diagnostic data only.

Raw local results:

- `results/godot-unattended.json` and `.png` — primary native run.
- `results/three-webgpu-1792799035588.json` — primary browser control.
- `results/godot-verified.json` — separate foreground native run: 188.10 FPS,
  p95 12.67 ms, 1% low 21.53 FPS; window automation overlapped this trial.

Earlier exploratory runs remain in `results/`. They include experiments using
smoothed simulation delta or losing window focus and are not used in the table.
Two earlier browser runs also reached approximately 120 FPS.

## What this establishes

The original generator can be transferred to a native touring application with
its micro detail intact. Voxel Tools' native greedy mesher produced 2,107 mesh
chunks and 1,255,866 triangles from 1,338,813 standard voxels and 401,715 unique
micro voxels. Initial export took about 6.7 seconds and mesh baking about
18.2 seconds; these are one-off observations, not repeated startup benchmarks.

Every compressed chunk checksum passed validation. A fresh source generation
matched 202,272 sampled voxel values, including neighbour halos. All exported
vertex values and triangle indices passed validation. The release app was
exported successfully and visually checked with the Aether map loaded.

## Limits on the conclusion

- Native VSync is disabled; browser requestAnimationFrame is effectively capped
  at 120 Hz here. Their FPS ratio is not an engine speedup percentage.
- Higher average throughput did not imply better frame pacing: native p95 and
  1% low were worse in these measurements. Long frames were retained in the
  statistics; their cause has not been isolated.
- Both controls render the exact same Voxel Tools mesh arrays and baked vertex
  lighting. This tests rendering paths, not the original Space renderer's meshes,
  custom shaders or total game-loop cost. Culling is engine-specific, so visible
  draw and triangle counts can differ slightly.
- This is a finite flat 512 × 512 crop, not the full toroidal world. Streaming,
  distant LOD, dynamic lighting, physics, building, and multiplayer are absent.
  Static meshes are baked before launch; this does not test runtime VoxelTerrain
  generation or editing performance.
- The desktop environment was not an otherwise idle dedicated benchmark machine.
  The measurements are useful for this prototype, not a production migration claim.

The appropriate conclusion is to try the native tour interactively and retain
Godot + Voxel Tools as a viable prototype path. A claim of improved full-game
performance would need a matched workload against the existing client and further
investigation of the native long frames.
