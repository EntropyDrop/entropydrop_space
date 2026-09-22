# Local rendering fixture

Open `/space/app/?world=copper-metropolis&dev_offline=1` on localhost while
running Vite. There is deliberately no navigation link. `main.ts` imports the
fixture only inside `import.meta.env.DEV`; production builds do not contain it.
The fixture also rejects non-loopback hostnames.

This is a deterministic local Copper world, not an authentication bypass. It
has no token, HTTP account/world adapters, WebSocket, or persistent world store.
Edits and inventory changes disappear on reload. Account-backed tools remain
unavailable. Local bundled assets and terrain workers still load normally.

The panel shows frame p50/p95, main-thread CPU p50/p95, Three render calls and
triangles, and independent edit-partition/render-mesh counts. Graphics are fixed
at medium lighting, 100% resolution and shadows enabled. Baseline reloads with
the previous square detailed window and separate micro meshes; Optimized uses
the rectangular window and bounded per-chunk render batches. Both retain WASM.
Use Rotate camera to exercise visibility changes without editing the world.

The fixture measures **near terrain only**; it does not fetch the server's far
surface snapshots, remote players or entities. Its frame rates are not a claim
about the full online world. Keep viewport size and browser visibility unchanged
and wait for initial compilation/warm-up before comparing results.

## Distant terrain regression

Add `&dev_lod=1`, or use **Test distant terrain**. A local worker generates eight
real districts from the selected world (four around spawn, four across the ring) with the shared
server 3D voxel mesher and seven-level mip ladder. The normal authenticated-byte
decoder, source-demand allocator, IndexedDB cache and renderer are exercised by
a local fetch adapter. There are no account or server requests. This bounded
fixture is not a whole-world performance benchmark.

Use `dev_lod=world` for the complete 128-zone working set. It repeats one real
Aether district at all world coordinates through the normal download allocator;
it tests global geometry/cache pressure without generating or storing 128 copies
of every source mip. The panel explicitly labels this repeated-district fixture.
`npm run bench:voxel-lod` also checks whole-world quality, packed memory, zoom
budgeting, recovery and rotation stability without a browser.

Wait for `8/8 districts` and stable LOD publications, then rotate for at least 20 seconds.
The pixel-area selector need not load every far district at 1m resolution.
Source reads and LOD publications should remain fixed; draw counts may change.
Reload: source reads should be zero when IndexedDB is available and warm.
Immutable terrain snapshots may persist in the site's cache; edits and inventory
are still ephemeral. Denied storage falls back to local generation normally.

Resident surface data defaults to 256 MiB (up to 1024 MiB). This is the raw source
budget, not total browser RAM: decoded mips, geometry, transitions and GPU copies
use additional memory. Disk cache is capped at 2 GiB and 20% of browser quota,
with a 512 MiB fallback when quota reporting is unavailable. The global geometry
budget for v7 is 4,194,304 directed faces, at 15 packed attribute bytes per face.
Under pressure the pixel-area threshold is fitted to the budget, with read-only
estimation and a fresh fit on source replacement; power-of-two overshoot and
stale budget pressure must not keep the entire world at an unnecessarily coarse LOD.
Each 512m source zone is drawn in independently culled 128m tiles. Culling a
tile never removes its CPU data or GPU buffers, including during a 180-degree turn.

## Voxy-inspired pixel-area selection

Defaults: 16 CSS px^2 subdivision area, 2048 chunks far render distance
(32768 m, covering the finite torus without repetition), and a 16-chunk maximum
near/network AOI radius. Near Z stays capped at six chunks; network Z is 12 to
include movement padding. Detailed online meshes are clipped to the last fully
synchronized AOI, leaving its unsynchronized fringe in far LOD. Legacy pixel-error
and metre-distance preferences migrate to the new defaults, preserving cache size.

The JS and WASM selectors use the same torus-inflated projected box-face area
bound, with 0.65 area hysteresis and a half-pixel residual guard for flat surfaces.
Unlike view-dependent projected AABBs, this conservative estimate depends only
on position and CSS viewport/FOV, so turning or adaptive rendering resolution
does not trigger subdivision/recycling. Frustum culling affects drawing only.

Reference: [Voxy screen-space traversal](https://github.com/MCRcortex/voxy/blob/534d58ec8b4aa412ef314b884295552c69d480a6/src/main/resources/assets/voxy/shaders/lod/hierarchical/screenspace.glsl).
This adapts the screen-area concept, not Voxy's OpenGL 4.6 compute/Hi-Z pipeline.
No Voxy source code is included. Space uses a finer default to preserve its
small floating islands and buildings across the full torus.

This is a DH/Voxy-inspired residency/LOD pipeline, not a port of either mod.
Procedural far terrain uses EDSZ v7 volumetric LOD: six-sided surface quads,
64m bricks and 1/2/4/8/16/32/64m voxel levels. Air below floating islands and
between bridges remains empty. Authored structures retain exact solid proxies.
The progress line reports the zone and completed bricks while generating.

## Aether Archipelago preview

Append `&world=aether-archipelago` to the local `?dev_offline=1` entry to
preview the development floating-island world with its standard and micro blocks.

## Busy-frame near streaming

Add `&dev_stream_busy=1` and click **Move to new chunks** after entry. This moves
256m and simulates a browser that grants no idle time: only explicit timeout
callbacks run, always with a zero remaining budget. The near-detail counter must
return to all chunks ready, including micro meshes, without an edit, another move
or a reload. Combine with `dev_lod=world` to retain full-world distant coverage.
The live scheduler prefers idle time and requests a one-millisecond queue
slice with a 50ms timeout; generation remains in the terrain worker.
