# Distant voxel drawing follow-up

This follows the [worker/main-thread fix](PERFORMANCE-2026-09-29.md). The browser
renderer now reduces unnecessary draw submission without changing resident LOD,
surface colors, lighting quality, resolution or render distance.

## Implemented

- The worker calculates bounds from the extents of every selected quad, including
  all six directions. Empty vertical space no longer inflates every 128 m tile
  to a 256 m tall culling volume. The existing torus derivative bound covers the
  curved geometry; camera-local view correction is also applied before culling.
- Geometry transitions keep the full tile bound until both generations finish,
  including when the camera is stationary. Old geometry cannot disappear because
  the incoming generation has a smaller extent.
- A cached ownership classification checks every chunk in the padded flat
  rectangle, including periodic boundaries. Only complete near/authored coverage
  skips the entire draw. Partial coverage retains the existing fragment handoff.
  Eviction immediately restores resident geometry without requesting a rebuild.
- Unaffected tiles bypass the handoff texture lookup. Settled generations bypass
  transition dithering. Mask changes and fades invalidate classification; a
  stationary settled view reuses its culling results.

An experimental per-face early vertex exit was removed after the skyline pixel
check found 21 changed pixels. The retained implementation uses whole-tile
submission culling and fragment fast paths, without that vertex shortcut.

## Method

Local Apple M1 Pro, Codex in-app browser, fixed 1280 x 720 drawing buffer,
Medium lighting, full resolution, shadows off. The fixture is Nature with 128
repeated districts, 64 px^2 subdivision and 1,027,311 resident faces. Play was
started to remove the startup overlay. No tests/builds ran during timed samples.

The new **Compare voxel drawing** button runs reference/optimized/reference on
the same loaded geometry and camera. Each case warms for 1.5 seconds and samples
for 4 seconds. GPU queries sample one in six frames, without a synchronous wait.
Both modes retain conservative camera-local bound correction; the reference
turns off tight bounds, ownership draw skipping and fragment fast paths.

**Check voxel pixels** renders reference, optimized, shader-only, culling-only
and reference-repeat captures synchronously without advancing simulation. RGB
readback is explicit and excluded from performance timing. All temporary
settings restore automatically; production builds exclude these diagnostics.

GPU queries exclude compositing/presentation and can contain command-stream gaps.
Draw counts and submitted triangles cover the whole frame, not just terrain.
These local repeated-source results are not a live-server FPS claim.

## Final measurements

| View / case | CPU p50 / p95 ms | GPU p50 ms | Calls | Submitted triangles |
| --- | --- | --- | --- | --- |
| Near-facing reference | 2.90 / 3.40 | 2.01 | 364 | 1,175,064 |
| Near-facing optimized | 2.60 / 3.00 | 1.95 | 275 | 829,632 |
| Near-facing reference repeat | 2.90 / 3.40 | 1.94 | 364 | 1,175,064 |
| Across-ring reference | 5.60 / 6.20 | 2.32 | 1,015 | 854,006 |
| Across-ring optimized | 4.90 / 5.50 | 1.49 | 853 | 369,248 |
| Across-ring reference repeat | 5.60 / 6.20 | 2.31 | 1,015 | 854,006 |

In the near-facing view, submission falls by 24.5% in calls and 29.4% in
triangles. CPU frame time improves, but GPU time overlaps the reference repeat;
this view does not establish a GPU-time speedup. Cadence stays around 120 FPS.

Across the ring, calls fall by 16.0%, submitted triangles by 56.8%, and measured
GPU p50 by 35.5-35.8% against the two reference captures. CPU p50 falls by 12.5%.
All three cases remain around 120 FPS: these resource reductions must not be
presented as an equivalent FPS increase.

## Validation and remaining limits

- Final near-facing, across-ring and distant-skyline pixel checks: zero changed
  RGB pixels, maximum channel delta 0/255 for optimized, shader-only, culling-only
  and reference-repeat captures at 1280 x 720.
- 71 targeted tests pass, covering all face directions, periodic ownership,
  interior uncovered chunks, incomplete fades, near eviction, immutable
  residency, camera-local correction, transition bounds, worker parity and
  failure fallback, stale sources, LOD budgets and handoffs.
- Engine/client type checks and production build pass. The worker is bundled;
  development-only fixtures/profilers are excluded. Existing large-chunk build
  warnings remain.
- Moving 256 m restored all 153 near chunks in 1.2 seconds. Pixel checks after
  movement and after continuous rotation also reported a maximum RGB delta of
  0/255. Rotation left worker publications at 4,305 and triggered no new source
  reads. No worker, shader or WebGL errors were recorded; existing Clock
  deprecation and browser pointer-lock warnings remained.

The resident face/memory budget remains unchanged. During transitions, both
generations still draw under their complementary fade. This does not implement
general terrain occlusion, indirect multi-draw or a new native/WebGPU renderer.
Across-ring submission still has hundreds of calls, so further draw batching
remains a separate source of potential improvement. Changes are local and have
not been deployed.
