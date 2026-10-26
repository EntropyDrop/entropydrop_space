# Local character rendering — 2026-10-26

**The visible third-person character is a meaningful cost; the tested
first-person character is not the cause of the low moving FPS.** In the Aether
fixture, hiding the third-person avatar improves moving FPS from 84.4 to 96.7
(+14.5%). Also bypassing its animation and root matrix updates reaches 99.9 FPS
(+18.4%). First-person moving FPS remains about 99.6 after disabling those paths.
These are diagnostic removals, not production optimizations or predicted gains
from a particular mesh rewrite.

## Method

The original local renderer remains unchanged. The explicit offline-only probe
in [CharacterFrames.ts](../src/dev/CharacterFrames.ts) intercepts existing methods
and restores them in `finally`. Each workload compares three roles:

- **Reference:** ordinary local character update and rendering.
- **Hidden:** hide the local avatar and camera-local hand/tool only during the
  world render. Animation and matrix updates continue.
- **Disabled:** additionally bypass `updatePlayerAvatar` and both character
  roots' `updateMatrixWorld`. This avoids hidden hierarchy work without repeatedly
  detaching objects. Other game, camera, terrain and remote-player logic remains.

The full game animation, HUD, sky and original PBR terrain continue. Terrain
backface filtering is off. There are no remote players in this fixture. Each
workload uses the six permutations `ABC CBA BCA ACB CAB BAC`, giving each role
six repetitions. Each block warms for 1 second and samples for 2.5 seconds.
Nine preliminary warm-up blocks, 1 second warm-up plus 1 second sample each,
are excluded from the results.

There are 54 accepted blocks, 14,133 full-frame samples and 2,355 GPU timestamps,
with zero uncaptured WebGPU errors. No image readbacks or exports run during the
accepted windows. FPS is the reciprocal of pooled mean callback interval; CPU
is full callback wall time. GPU is the span from the first GPU pass start to the
last pass end, sampled about every sixth frame, not a utilization counter.
Avatar update means are measured inside `updatePlayerAvatar` and do not include
the subsequent ordinary world rendering. Small means average many quantized
timer readings; they should not be read as nanosecond-accurate timings.

The browser reports Apple / metal-3; exact GPU model is masked. Canvas is
2560 x 1440, CSS viewport 1280 x 720, DPR 2, Medium lighting, shadows off, 4x MSAA,
100% fixed resolution, terrain command caching enabled. GPU clocks and thermals
are not locked. The offline fixture repeats one district over the 128 far
districts, at `(8192.5, 180, 1024.5)`, yaw pi/2 and pitch -0.85.

Fixed retains the pose. Moving repeats yaw `pi/2 + 0.6*sin(2*pi*t)` and adds
`16*sin(2*pi*t)` in X, `8*(1-cos(2*pi*t))` in Z. Velocity and interpolation are
reset before each callback. This is a camera/terrain movement workload, not a
maximal walk, dash or tool-swing animation stress test. The selected tool is
Selector. Third-person uses the normal back view. Comparisons are within each
perspective; switching perspective itself also changes the terrain view.

## Results

| View / motion | Reference FPS | Hidden FPS | Disabled FPS | CPU p50 reference / hidden / disabled, ms | GPU p50 reference / hidden / disabled, ms |
| --- | ---: | ---: | ---: | --- | --- |
| First person / fixed | 120.0 | 120.0 | 119.3 | 3.4 / 3.4 / 3.3 | 3.146 / 3.146 / 3.146 |
| First person / move | 99.6 | 98.8 | 99.6 | 5.5 / 5.7 / 5.7 | 3.015 / 3.080 / 3.015 |
| Third person / move | 84.4 | 96.7 | 99.9 | 8.9 / 6.1 / 5.5 | 3.670 / 3.015 / 3.015 |

First-person avatar update averages 0.013–0.016 ms per frame. Third-person update
averages 0.051 ms in reference and 0.059 ms while hidden. The major third-person
saving comes from eliminating rendering work, rather than the animation math.
The disabled role also avoids hierarchy matrix work; its difference from hidden
must not all be attributed to animation.

Moving third-person frame p95 improves from 21.2 ms to 18.9 ms when hidden and
18.0 ms when disabled. Reference blocks range 81.7–86.2 FPS, hidden 94.1–98.4,
disabled 96.7–103.1, with no overlap between reference and either removal. This
is stronger evidence than the tiny first-person differences. First-person moving
blocks overlap substantially: 97.6–102.6, 96.9–100.8 and 93.8–102.5 FPS. One disabled
fixed-view block drops to 115.2 FPS while most blocks hit about 120; that does not
establish a character-removal regression.

Ordinary pending terrain work is retained: 83/83/87 moving first-person sampled
frames and 78/111/84 moving third-person frames, in reference/hidden/disabled order.
Moving triangle/call medians can differ slightly because callbacks sample different
trajectory instants. No moving null control or independent device replication was
performed. Previous reports have different baselines; comparisons should stay
within this run.

## Why the character can be expensive

The inspected avatar root contains 76 objects, 54 meshes and 291 material slots,
including cached inactive held tools. The hand/tool root contains 16 objects,
9 meshes and 21 material slots. Both have **zero SkinnedMesh objects**: the
character animation changes component transforms, rather than using a skeletal
skinning path.

[createVoxelGroup](../src/engine/render/CuteCharacter.ts) makes each opaque voxel
in the skin's outer layer a separate box Mesh, with six face materials. Even a
small triangle count can therefore generate many separate draw calls. This is
the most concrete optimization opportunity identified here.

A separate frozen third-person check isolates the local character exactly:

| Same camera and terrain | Draw calls | Triangles | Packed far triangles |
| --- | ---: | ---: | ---: |
| Original | 596 | 1,807,413 | 1,469,888 |
| Local character hidden | 313 | 1,805,361 | 1,469,888 |
| Original restored | 596 | 1,807,413 | 1,469,888 |

The character adds **283 calls for just 2,052 triangles** in this pose. Restoring
it reproduces the original image exactly (maximum RGB difference zero). Only
50,869 of 3,686,400 pixels change by more than two RGB levels while it is hidden.
In the fixed first-person benchmark, hiding the selected tool removes only one
call and 988 triangles, with identical far-terrain counts.

[updatePlayerAvatar](../src/engine/render/SceneRenderer.ts) still calls the
character animation update and first-person projection update in first-person
view, even when the body is hidden. This is avoidable work, but its measured
size is too small to explain the first-person performance problem here.

## Recommendation and limits

Prioritize consolidating the skin outer-layer boxes **per animated body part**
and storing face color in vertex attributes with a shared material. This can
retain the raised voxel appearance and independent head/limb animation while
reducing mesh/material submissions. That optimization has not yet been implemented
or benchmarked; the removal result is only an upper-bound diagnostic target.

Separating first-person hand updates from hidden-body animation is a secondary,
smaller opportunity. It should not be sold as a cure for the moving first-person
FPS, which remains near 100 with the character paths disabled.

Nearby remote avatars may multiply the cost, especially with more elaborate
skins or shadows enabled, but this run does not measure those cases. The existing
remote-player path already uses full detail near 20 m, simplified models near
80 m, billboards to roughly 240 m, distance hysteresis and view culling. It also
limits outer-layer rendering and character shadows to nearby full-detail players.
Do not extrapolate this single-avatar result to an unmeasured crowd.

All hooks, perspective and temporary far-terrain choices were restored; the test
tab was closed and viewport override reset. No production character optimization
or setting change was made. Client typecheck passes.

## Retained evidence

- [Raw warm-up and comparison frames](../src/dev/results/character-2026-10-26.json.gz)
- [Numeric summary](../src/dev/results/character-2026-10-26-summary.json)
- [Frozen isolation and restoration check](../src/dev/results/character-2026-10-26-frozen.json)

Regenerate and validate with `node client/tools/summarize-character-frames.mjs`.
For reproduction, use the offline Aether fixture with
`dev_offline=1&dev_lod=world&dev_dpr=2`, the conditions above, and wait for settled
near/far terrain. Explicitly import `CharacterFrames.ts`; call
`runCharacterFrames(game, {order:['reference','hidden','disabled'], warmMs:1000,
sampleMs:1000, tag:'warmup'})` before `runCharacterFrames(game)`.
