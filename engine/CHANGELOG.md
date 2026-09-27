# Changelog

## 2026-09 — Joint and contact solvers in WASM

- Run all point, hinge, limited-hinge and weld iterations against resident f64
  body poses, packing once and publishing once per constraint solve.
- Move entity impulses, terrain manifold iterations, friction, resting velocity
  stabilization and narrow-support toppling into the trusted WASM module.
- Retain host Math sin/cos/atan2 rounding through three scalar imports so tiny
  orientation differences do not change subsequent contact-feature choices.
- Preserve solver order, kinematic carrier velocities, material response and
  JS initialization/oversized-arena fallback; add a solver-only JS override.
- Add differential solver tests and `bench:physics-solver`, comparing complete
  updates with WASM collision geometry in both modes.

## 2026-09 — Picking, contact and import WASM

- Cache both air and occupied picking samples, and batch inclusive projected
  quad intersections through a shared f64 WASM kernel.
- Batch entity/entity and entity/terrain SAT contacts while preserving solver
  ordering, support features, sweeps, sleep and collision publication.
- Accelerate model parity fill, hollowing and nearest-surface queries in private
  bounded WASM arenas, retaining exact host texture/color and block semantics.
- Add differential trajectory/model tests, reproducible binary checks and
  `bench:geometry` with packing/copy costs included.

## 2026-09 — Volumetric LOD WASM

- Generate far-terrain columns and all seven voxel mip levels in a private,
  reusable WASM arena, including chunk packing, micro occupancy, height records,
  colour/emission reduction and greedy face output.
- Preserve VXL7 snapshot bytes, brick boundaries and JS fallback behavior, with
  less than 18 MiB of scratch memory per zone generation.
- Add adversarial byte-equivalence tests and `bench:voxel-surface` to compare
  complete zone CPU time with the same terrain backend in both runs.

## 2026-09 — Shared terrain WASM

- Share deterministic terrain rasterization and LOD reduction kernels across
  browser workers, Node hosting/surface generation and Python/Wasmtime.
- Keep Copper's building grammar and real world microvoxels, existing seeds,
  generator versions, surface snapshots and authored-solid trailers unchanged.
- Add byte-identical reference tests, bounded reusable arenas, explicit fallback
  controls, reproducible builds and end-to-end CPU generation benchmarks.

## 2026-09 — Endpoint-owned entity trajectories

- Replicas project authoritative root and child body poses without advancing
  scripts, forces, constraints or gravity, while retaining collision/render history.
- Moving-platform contact velocities follow the interpolated path and become zero
  when it stops. Teleports reset sweep history instead of sweeping across the world.
- Browser Start atomically acquires execution; live Stop/Delete require the same
  endpoint and epoch. Account permissions alone cannot take over another tab.
- Fenced 20 Hz body-pose relay is separate from six-second recovery checkpoints;
  committed hosting trajectories retain the existing one-second transaction cadence.

## 2026-09 — Seat rider orientation

- `inventory.proto` v7 stays wire-compatible: `Seat` gains optional `rotation`
  (`Quaternion`) and `fixed_orientation` (`bool`) with new field numbers 2 and 3.
  Identity orientation and free look are the implicit defaults, so an untouched
  seat encodes to exactly the pre-orientation bytes.
- `self.setSeats(seats)` accepts the legacy `[x,y,z]` shorthand plus
  `{position,rotation?,fixedOrientation?}` entries; `self.getSeats()` reports the
  three-field record, which is a breaking read change for scripts that destructured
  the old bare position arrays.
- A seat with `fixedOrientation:true` drives the mounted player's body from its
  solved world quaternion. The camera keeps free horizontal mouse look and
  independent pitch; mounting, dismounting and seat rotation do not reset it.
  Runtime `self.setSeats` changes apply immediately to an already mounted rider.

## 2026-09 — Contracts

- `inventory.proto` v6 → v7: `Voxel` adopts `is_micro` + `micro_x`/`micro_y`/`micro_z` and
  the varint `color_rgb`, matching `space.multiplayer.v2.VoxelMutation`; `ColorSet.colors`
  becomes `repeated uint32`. Old v6 files are rejected.
- `backpack.proto` v7 → v8: embeds inventory v7.
- Added `space_api.proto` (`entropydrop.space.api.v2`) binary REST request envelopes so the
  canonical resource travels as raw bytes on upload and download.
- Added `proto/README.md` (ownership, versioning, codegen) and `proto/buf.yaml`
  (`buf lint` + `buf breaking`).
- `tools/generate-protobuf.mjs` now generates and verifies `space_api.ts` and its source
  hash alongside the inventory and backpack bindings.

## Earlier

- 8×8×8 micro grid (0.125 m) across editing, collision, inventory and snapshots.
