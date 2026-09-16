# Space engine

[spaceAPI](docs/spaceAPI.md) · [entityAPI](docs/generated/api-v2.md)

entityAPI is the runtime interface for entity code (`self` / `ctx`); spaceAPI is the HTTP interface for Agent requests.

`@entropydrop/space-engine` contains the TypeScript engine shared by the Space browser
application and the backend hosting worker. It owns voxel/chunk data, terrain generation,
meshing, torus math, entities, physics, simulation timing, the QuickJS script sandbox,
entityAPI contracts, inventory Protobuf codecs, and their tests.

The engine does not import either application repository. `SpaceStorage` and
`SurfaceZoneSnapshot` define the data interfaces supplied by the browser or backend.
The shared World still includes optional terrain mesh/streaming support for the browser;
using the engine on Node does not create a WebGL renderer. React UI, character rendering,
input, sound, browser storage implementation, HTTP clients and login remain in the frontend.
Hosting policy, IPC, authentication, billing and persistence remain in the backend.

## Local setup

Install from the Space workspace root (`entropydrop_space/`) with Node 24+ and npm 10+:

```sh
npm ci
npm run check
```

The workspace links `client/` and `engine/`. The frontend and backend hosting runtime
consume these packages via local `file:` dependencies with `install-links=false`.
Run `npm ci` in those consumers after installing Space.

The package exports TypeScript source: Vite builds it into the browser application, and
the backend's esbuild step builds it into the standalone Node runtime. Neither deployed
artifact needs this source checkout. Three is a peer dependency; Vite and the browser
integration tests deduplicate it so the application uses one Three instance.

```ts
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { ContraptionPhysics } from '@entropydrop/space-engine/physics/ContraptionPhysics.ts';
// The package root is the entry used by the backend's headless simulation.
```

## Contracts and validation

`proto/` owns the shared contracts and their versioning rules (see
[`../proto/README.md`](../proto/README.md)): `inventory.proto` (portable resource, v7),
`backpack.proto` (browser-local state, v8) and `space_api.proto`
(`entropydrop.space.api.v2` binary REST request envelopes). `npm run check` verifies the
generated Protobuf files, lints the schemas with the pinned `@bufbuild/buf` CLI,
verifies the API docs, typechecks the package, and runs engine tests.
Protobuf generation/checks require `protoc` on PATH; the TypeScript generator is a local
dev dependency. Use `npm run generate:protobuf` after changing `proto/`, and
`npm run docs:generate` after changing `src/contraption/ScriptApiContract.ts`. Generated
files are checked in, so ordinary consumer builds do not need `protoc`.

The Python server keeps its generated bindings under `server/space/contracts/`. To
regenerate them from the Space workspace root (using protoc 33.2 to match the checked-in
Python runtime version):

```sh
protoc --proto_path=space/contracts=proto --python_out=server space/contracts/inventory.proto
protoc --proto_path=space/contracts=proto --python_out=server space/contracts/space_api.proto
```

From the Space workspace root, `python3 tools/sync_server_contracts.py --check --protobuf`
verifies those bindings and the public agent reference copies against the canonical
schemas. The virtual proto path preserves the Python module name and descriptor identity.
Moving these files does not change the wire format or database schema. Frontend
`npm run check --workspace @entropydrop/space` also runs the engine checks and browser
integration tests.

Rebuild both consumers after shared physics/script/codec changes. The optional hosting
Docker image builds from the backend and this repository only. Hosting remains disabled
in both applications until explicitly enabled; extracting this package does not enable it.

## Entity collision performance

Physics uses exact unions of merged, component-local voxel boxes. Standard and
micro voxels can merge where their complete faces match; gaps and component
boundaries remain intact. Editing, raycasts and player collision retain original
voxel cells. Terrain keeps its surface probes and uses merged boxes with bounded
extent for exact contacts, preserving support and fast-motion checks.

The entity solver rejects disjoint swept entity bounds before checking component
boxes, then uses a per-pose box tree for complex shapes. Bounds are checked again
at every substep/iteration because earlier impulses can move another entity.
Stopped/stopped pairs are omitted; stopped entities still collide with active ones.

Player carriage follows the supporting component's actual solved world transform,
including translation, yaw and collision push-outs, exactly once. Swept bounds are
only candidate envelopes: linear moving-face sweeps and current-pose recovery are
separate, so vacated volumes cannot become ghost floors. Repeated local player
queries reuse transformed voxel candidates until pose or geometry invalidation.
Player/entity collision is one-way: entities carry, block and push characters,
while character weight, landing, side impacts and jump reactions never mutate
the single-authority entity simulation.

An existing flat terrain support manifold is solved before advancing the body's
pose, with no restitution for a resting load. Its cached contact cells, shape,
collision switches and attached kinematic transforms are validated before reuse.
The ground applies only non-negative normal impulses: it cannot pull a lifted body
down or hold a removed support, overhang or tilted body artificially level.

Design references are Create's [contact-point pose motion](https://github.com/Creators-of-Create/Create/blob/mc1.21.1/dev/src/main/java/com/simibubi/create/content/contraptions/AbstractContraptionEntity.java)
and [local collision candidate handling](https://github.com/Creators-of-Create/Create/blob/mc1.21.1/dev/src/main/java/com/simibubi/create/content/contraptions/ContraptionCollider.java).
These ideas are adapted, not a Java implementation port or full Create parity:
the character's rotating-voxel narrowphase still uses world AABBs, while the
dynamic entity solver uses oriented SAT contacts.

Entities settle to sleep after one second of low motion when supported (or without
gravity). Their authored run state stays unchanged. Impacts, forces, impulses,
pose/shape/body-setting changes, Stop/Play and support movement/removal wake them.
World checks only overlapping terrain chunks and published micro partitions, so
remote edits and unrelated streaming-window changes leave sleepers alone. Hosts
without local collision stamps fall back to numeric `terrainVersion` and window
invalidation; hosts without revision notifications keep simulating.
Scripts still run every tick while physics sleeps. `ctx.contacts` retains resting
support observations with `sleeping: true`, zero relative velocity and zero impulse;
a script force wakes its body in the same update.

Microterrain caches exact merged collision boxes and a BVH per 2×2×2 m partition (at most 4,096 microcells).
Geometry merges across colors and labels but never across holes. Live edits invalidate
the live cache; published colliders remain immutable until the replacement mesh is
published, including incremental chunk replacement and cross-layer subdivision.
Torus queries unwrap these boxes into the caller's periodic window.

The construction grid is 8×8×8: 512 cells of 0.125 m per standard 1 m block.
The pure `src/voxel/MicroGrid.ts` constants are shared by editing, geometry, physics,
inventory and the browser. Inventory v7, backpack v8, offline entities v4, local
world edits v3 and far-surface snapshots v3 intentionally reject older formats.
Backend deployment requires fresh Space content/storage; no historical migration
or automatic deletion is included.

Run a reproducible CPU benchmark with `node tools/benchmark-physics.ts`. It reports
median/p95 time per 50 ms simulation update for 100 entities of 100 voxels each,
with awake, stopped and sleeping cases. It excludes GPU drawing, terrain occupancy,
scripts and network work; it does not estimate browser FPS.

`node tools/benchmark-micro-terrain.ts` compares cell scans and cached box queries
on the same 8³ microgrid, reporting cold-cache cost separately.
