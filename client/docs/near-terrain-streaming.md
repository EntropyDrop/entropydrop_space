# Near terrain streaming

The terrain worker starts its next eligible chunk as soon as a result arrives,
with at most four completed results awaiting publication. Finished generation
also publishes during render frames, even without local edits or idle time.
A standard/micro conversion barrier delays only its own chunk; independent
results can pass it. Jobs awaiting publication are excluded from redispatch.

Micro detail uses a separate worker for background mesh construction. The main
thread captures sparse immutable cell snapshots, including the six neighboring
partitions and wrapped torus boundaries. The worker expands the halo and runs
the existing WASM mesher, transferring compact geometry buffers back. There are
at most 16 outstanding partitions, and result publication shares the update
slice's time/count limits. Queue order follows player distance; direct edits keep
priority and use the existing budgeted local mesher for immediate feedback.

Only an update slice publishes mesh and collision state. Revision checks reject
obsolete results, and authoritative snapshot barriers remain atomic. An evicted
or blocked result returns to the dirty queue. Worker failure falls back to local
meshing. Empty partitions cleared after an outgoing terrain fade are retired
even outside the active AOI, preventing hidden meshes and dirty-queue scans from
accumulating after movement.

The far terrain, effects, shaders, projection, terrain detail density and render
distance are unchanged. The 12 modified/untracked files present before this
work were verified byte-for-byte unchanged, including the September 28 far
terrain maintenance and cinematic effects optimizations.

## Measurements

Codex in-app browser, local Copper fixture, seed 20260922, medium lighting,
100% resolution, shadows off, 153 near chunks, no accounts/network/entities or
far surface data. `dev_stream_busy=1` grants no browser idle time, only the
50 ms timeout callbacks. From (8200, 128, 1032), **Move to new chunks** moves
256 m along X. In the final repeat, all standard and micro meshes reached
ready in about **2.9 s**. After settling: about **120 FPS**, main CPU p50
**1.6 ms**, p95 **1.8 ms**;
3,002 micro partitions, 152 draw meshes. These are local fixture measurements,
not an online loading-time guarantee or a before/after FPS comparison.

Run the independent CPU comparison with:

```sh
node --import ./engine/test/setup.ts engine/tools/benchmark-near-streaming.ts
```

It compares the local and actual worker paths using the same 36,432 Copper
cells in nine chunks (771 partitions), 1.25 ms meshing slices, and timer pacing
targeting 60 Hz. It excludes initial worker startup, generation, network and GPU
rendering. One run produced:

| Path | Main-thread CPU total | Time to publication | Update p95 |
| --- | ---: | ---: | ---: |
| Local | 824 ms | 7.29 s | 4.97 ms |
| Worker | 312 ms | 2.35 s | 6.12 ms |

Both geometry digests were identical. Timers, JIT and host load affect these
numbers. The slice deadline is cooperative: geometry publication and render
batch copies are synchronous, so a faster total load does not imply a lower
worst-frame cost. The bounded worker queue also bounds result bursts.

## Validation

`engine/test/near-terrain-streaming.test.ts` covers exact geometry/materials,
vertical and wrapped seams, nearest-first work, editing during a full queue,
stale results, AOI eviction, authoritative snapshot blocking, atomic collision
publication, worker failure, bounded terrain lookahead and independent progress
past a blocked chunk. Existing terrain, collision, remote snapshot, LOD handoff
and rendering tests are also run.

The earlier performance report documents three pre-existing unrelated failures:
one WASM LOD equivalence test, the Agent Build authorization-copy test and the
wrench COM pick test. Full-suite validation for this change skips those named
cases rather than changing their expectations.

Final validation: 427 engine tests and 1,000 client tests passed with those
three cases excluded. Both TypeScript checks, the production build, the
English-only check and documentation-link validation passed. The production
build includes the micro worker and excludes the development fixture.
