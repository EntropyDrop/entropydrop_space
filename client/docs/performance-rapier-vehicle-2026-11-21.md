# Chrome vehicle physics experiment

The loopback development entry runs the existing TERRA-8 vehicle, AssemblyScript
suspension and tread controller, player seat code, voxel terrain publication
and WebGPU renderer. The challenger replaces terrain collision and stepping
for one dynamic hull on the course with Rapier WASM 0.21.0. The other vehicle
components retain their authored kinematic behavior. Both variants keep the
authored collision footprints, including the animated track shoes.

## Setup

Apple M1 Pro, headless Chrome 158, 960 by 640 viewport, fixed 0.75 pixel ratio,
medium lighting and shadows off. Each measurement starts a fresh browser, waits
for the renderer and 28 simulation ticks, mounts the same seat, holds forward
for 240 ticks and then brakes for 24 ticks. The runner invokes the game's key
handlers with the same events in both variants. The terrain edit adds 64
microvoxels across the left wheel path on the step, or on the shoulder for the
flat control, then removes them. The runner checks published collision geometry
and, on Rapier, waits for the changed shape to be applied.

The vertical course is the original 1 m step. The ramp course adds a 4 m
approach made of eight 0.125 m rises. The flat course removes the raised step
and measures sustained driving. The runner alternates Space and Rapier order
over repeat pairs. Timing covers the entity manager, synchronous application
frame CPU or animation-frame cadence as labeled. Renderer memory is peak
sampled RSS for Chrome renderer processes every 600 ms. The raw data also
contains V8 heap and backing-storage samples.

## Results

Times are p50 / p95 in milliseconds. The vertical course has one run per
backend. The ramp and flat controls have two runs per backend, pooled within
each course.

| Course | Space entity update | Rapier entity update | Space frame CPU | Rapier frame CPU | Space frame interval | Rapier frame interval |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Vertical step | 6.4 / 8.3 | 2.7 / 10.5 | 2.3 / 10.3 | 2.3 / 12.2 | 16.7 / 17.8 | 16.7 / 18.1 |
| Microvoxel ramp | 3.5 / 8.6 | 2.7 / 10.3 | 2.3 / 9.8 | 2.4 / 6.4 | 16.7 / 18.2 | 16.7 / 18.0 |
| Continuous flat driving | 7.5 / 8.4 | 9.8 / 10.7 | 2.3 / 10.3 | 2.3 / 12.6 | 16.7 / 18.1 | 16.7 / 17.5 |

On flat ground the vehicle traveled 20.54 m in Space and 20.37 m in Rapier.
In the initial prototype, Rapier replaced the tracked hull's compound shape on 245 of 264 measured
updates in each run, with a rebuild median of 3.8 ms and p95 of 4.2 ms.
The sampled peak Chrome renderer RSS was 1130–1170 MiB in Space and
1217–1222 MiB in Rapier. Frame interval p95 improved in the first flat pair
and regressed in the second. The synchronous CPU frame p95 was higher in
Rapier in both flat pairs.

Both variants stopped at the vertical step and at the first rise of the
microvoxel ramp. The Rapier candidate executed all three substeps in every
measured update. All runs completed mount, braking, and dismount. The seat
position matched the player's simulation position at every sampled tick and
all scripts stayed running. The two microvoxel edits reached the Rapier
collider within one or two simulation ticks, with 0.4–1.6 ms of collider
rebuild time across the trials. Local module import and initialization
took 38–41 ms.

Contact publication still differs. Space recorded 519 terrain contact reports
in each flat run, 696 at the vertical step and 1354 in each ramp run. The
Rapier prototype recorded zero in these runs. Counts describe reports
submitted to the bounded script contact buffer.

## Resident shapes follow-up

The updated prototype attaches separate voxel and decoration colliders to the
same rigid body. Each source is checked at the start of the fixed update after
script commands have been applied. A pose update moves the body, a pivot
change adjusts the collider attachment, and a geometry change replaces the
affected shape. A decoration paint update keeps the collision footprint.
Voxel edits still use the engine's existing per-region collision geometry.

After the timed sample, the Chrome runner pauses the vehicle script and tests
decoration addition, paint and removal, then removes and restores a vehicle
voxel. It checks the number of shape replacements and that the rigid body is
retained. The scripted terrain edits continue to run during the timed sample.
The current experiment keeps the decoration compound at hull-component
granularity.

The follow-up repeated the flat driving fixture in Space/Rapier and
Rapier/Space order, with 264 updates per run. All values below are p95 in
milliseconds. The initial Rapier column is the earlier capture.

| Metric | Initial Rapier | Resident Rapier | Space rerun |
| --- | ---: | ---: | ---: |
| Entity update | 10.7 | 8.5 | 8.6 |
| Synchronous frame CPU | 12.6 | 10.4 | 10.6 |
| Geometry replacement | 4.2 | 1.7 | |
| Frame interval | 17.5 | 17.6 | 17.4 |

Each resident Rapier run retained one body and its voxel collider for all
264 updates. The decoration compound changed 244 times per run. Removing and
restoring a voxel each replaced only the voxel shape. Adding and removing a
decoration each replaced only the decoration shape. Repainting caused zero
shape replacements. Both variants preserved the approximately 20 m drive and
the seat and braking checks. The resident adapter still recorded zero
terrain contact reports during the drive, while Space recorded 519 per run.

The follow-up samples are in
`.local/rapier-resident-2026-11-21/flat.json`.

## Reproduce

Run the loopback development server from the repository root.

```sh
npm run dev --workspace @entropydrop/space -- --host 127.0.0.1 --port 4174 --strictPort --base /space/app/
```

In a second shell, run the comparison with system Chrome installed.

```sh
mkdir -p .local/rapier-vehicle
node client/tools/benchmark-rapier-vehicle.mjs --course vertical --runs 1 --output .local/rapier-vehicle/vertical.json
node client/tools/benchmark-rapier-vehicle.mjs --course ramp --runs 2 --output .local/rapier-vehicle/ramp.json
node client/tools/benchmark-rapier-vehicle.mjs --course flat --runs 2 --output .local/rapier-vehicle/flat.json
```

For an interactive run, use the loopback Space app with
`?dev_offline=1&dev_physics=rapier&dev_physics_course=flat`. Set
`dev_physics=space` for the reference or select `vertical` or `ramp` as
the course. The development entry holds edits in ephemeral session storage.
