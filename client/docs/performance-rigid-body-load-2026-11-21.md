# Concurrent rigid bodies in Chrome

The first set of captures below used the loopback prototype. The same runner
now loads the browser's default Rapier backend for the Rapier samples.

Measured on Apple M1 Pro with headless Chrome 158.0.8127.37, WebGPU, a
960 × 640 viewport, pixel ratio 0.75, medium lighting and shadows off. The
loopback Space application used the same entity manager, fixed timestep, terrain
and rendering in both versions. Each fixture gave the same forces and torques to
the same one-voxel dynamic entities on both backends.

- Spread starts separated with gravity disabled so the bodies move without contact.
- Stack starts in four-high piles on a flat voxel deck with gravity and changing lateral forces.
- Agitated stack increases the lateral force from 145 N to 420 N to keep every body moving.

Each run starts a fresh Chrome process, waits for visible geometry and initial
terrain readiness, then runs 10 warmup and 48 measured entity updates at 20 Hz.
Each update advances three physics substeps. The 32-body cases have one run per
backend. The 128-body cases have two runs per backend in Space/Rapier then
Rapier/Space order. Percentiles pool samples of the same backend and workload.

## Performance

All values are p95 in milliseconds. Each cell shows Space → resident Rapier WASM.

| Bodies and layout | Entity update CPU | Synchronous frame CPU | Animation frame interval |
| --- | ---: | ---: | ---: |
| 32 spread | 1.8 → 1.6 | 4.1 → 4.1 | 17.4 → 17.3 |
| 32 stack | 7.8 → 2.4 | 9.9 → 5.0 | 16.8 → 17.6 |
| 128 spread | 7.1 → 4.2 | 11.9 → 9.2 | 17.5 → 17.5 |
| 128 stack | 39.0 → 6.9 | 44.6 → 11.9 | 49.7 → 17.4 |
| 128 agitated stack | 41.7 → 7.5 | 47.1 → 12.1 | 52.4 → 17.6 |

The agitated stack kept all 128 bodies moving in every measured update in both
versions. The median number of bodies that reported contact with another body in
an update was 76 in Space and 84 in Rapier. The median animation frame interval
was 42.7 ms in Space and 16.7 ms in Rapier. Chrome reported six frames over 50 ms
in the two Space runs and zero in the two Rapier runs. The spread case had zero
long frames in either version. Entity update time includes the whole manager
update. Frame CPU measures the synchronous application frame callback. The
animation frame interval measures callback cadence.

## Memory and contacts

- Peak sampled Chrome renderer RSS was 789–790 MiB in Space and 969–992 MiB in
  Rapier for the 128-body agitated stack. RSS sums renderer processes sampled
  every 500 ms and measures the browser process footprint of the fixture.
- In both 128-body spread and agitated-stack fixtures, every body stayed awake
  and above either 0.05 m/s linear speed or 0.05 rad/s angular speed on every
  measured update. In the gentler 128-body stack, Space had 128 moving bodies
  at the median and Rapier had 96. All 128 stayed awake in both versions.
- The deepest sampled corner below the floor surface was 15.2 cm in Space and
  4.8 cm in Rapier for the agitated stack. This measures the lowest point of the
  rotated cube at the end of each entity update. The motion and contact records
  differ between solvers under the same inputs.
- Every Rapier run executed all 174 substeps, created one body and one voxel
  shape per entity and built the deck collider once. The timed fixture uses
  simple bodies with fixed geometry. This isolates concurrent body and contact
  work from geometry edits, vehicle scripts and constraints.

The gain in frame cadence is concentrated in dense contact workloads. In the
128-body spread fixture, Rapier freed about 2.9 ms of entity-update p95 and the
frame interval stayed at 17.5 ms p95. The dense workload completed each Rapier
substep in one shared world and read its poses and contacts back into Space.

## Reproduce

Run from the repository root.

```sh
npm run dev --workspace @entropydrop/space -- --host 127.0.0.1 --port 4174 --strictPort --base /space/app/
```

In another terminal, run the Chrome samples.

```sh
mkdir -p .local/rigid-body-load
node client/tools/benchmark-rigid-body-load.mjs --count 32 --layout spread --layout stack --runs 1 --output .local/rigid-body-load/32.json
node client/tools/benchmark-rigid-body-load.mjs --count 128 --runs 2 --output .local/rigid-body-load/128.json
```

The measured captures are in `.local/rigid-body-load-2026-11-21/32.json`,
`.local/rigid-body-load-2026-11-21/128.json` and
`.local/rigid-body-load-2026-11-21/128-agitated.json`.

## Browser migration

Space initializes Rapier 0.21.0 alongside terrain and rendering preparation
for online, tutorial and offline browser sessions. The entity manager keeps its
20 Hz update and three physics substeps. Rapier owns the local simulation of
eligible root bodies, static contacts and sleep. The adapter publishes poses,
velocities and bounded script contact observations back to Space.

Voxel volume and decoration footprints have separate colliders. Body motion,
paint and collision enablement keep the shapes resident. Construction edits
replace the affected shape. Nearby terrain is published as 16 m collision tiles
using the world's standard, microvoxel and decoration geometry. Terrain stamps
invalidate the affected tiles, including across a wrapped world seam.

Space handles a body with authored constraints, additional colliding components,
a moving kinematic or replicated collider, or an active wrench grab. Nearby
bodies in the same swept broadphase component use Space for that update.
Initialization failure also selects Space. Player movement and hosted entity
simulation continue through their established solvers.

The migrated backend ran the 128-body agitated stack twice per solver in
Chrome. All bodies stayed awake and at least 127 were moving in every sampled
update. The median was 128. Each Rapier run completed all 174 substeps, created
128 bodies and 128 voxel shapes, and published 25 terrain shapes.

| Metric | Space | Default browser Rapier |
| --- | ---: | ---: |
| Entity update p95 | 39.1 ms | 8.5 ms |
| Synchronous frame CPU p95 | 43.9 ms | 13.7 ms |
| Animation frame interval p95 | 49.5 ms | 18.5 ms |
| Peak sampled renderer RSS | 778–802 MiB | 953–986 MiB |

The full captures are in `.local/rigid-body-load-2026-11-21/128-migration.json`.
