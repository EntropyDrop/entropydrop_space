# EntropyDrop Space

Space is a Node 24+ / npm 10+ workspace with one root lockfile:

- `client/`: Three.js browser client and UI (`@entropydrop/space`).
- `engine/`: shared TypeScript physics, voxels, simulation and scripting (`@entropydrop/space-engine`).
- `proto/`: canonical Protobuf definitions; generated TS stays in `engine/src/generated/`.
- `server/`: independent FastAPI/WebSocket service, simulation worker, storage and migrations.
- `tools/`: protocol/API generators and production/development deployment tools.
- `deploy/`: standalone server Dockerfile, backup script and deployment guide.

## Development

```sh
npm ci
npm run dev
npm run check
npm run build
```

The development client is served at `/space/app/`; production is served at
`https://space.entropydrop.com/`. Build output is `client/dist/`.
The 3D client requires WebGPU and GPU acceleration in a secure context
(HTTPS or localhost). It reports initialization failures instead of falling
back to WebGL. See the [rendering validation guide](client/src/dev/README.md).
Copy `.env.example` to `.env.local` and set the account API origin and optional
Space API origin. These public Vite settings are read from this workspace root.

For the existing same-origin login flow, install this workspace, then run `npm ci`
and `npm run dev` in the sibling `entropydrop_frontend/`. Its development server
mounts this client. Production publishes Space independently and provides the
main-site login return page at `/space/login`.
The account API-key page consumes explicit client package exports.

Development also provisions the Copper Metropolis world, generated from the
terrain-lab algorithm with terrain generator version 2. Enter it at
`/space/app/?world=copper-metropolis` in the integrated local frontend, or at
`https://space-dev-908123.entropydrop.com/?world=copper-metropolis` on the
private development domain. The natural world is named **Nature**:
`?world=nature` selects its original persistent world.
Copper is also available in production at
`https://space.entropydrop.com/?world=copper-metropolis`; its data is isolated
from the development deployment and from Nature.
Copper has coherent old-town, garden, industrial, terraced, civic and business
districts. Larger floor plates, gently changing neighbourhood heights and occasional
station halls, courtyard complexes, terraced megastructures and sky gates give the
city a varied distant silhouette. Seeded parks include paths, trees and reflecting pools.

Agents discover available worlds through authenticated `GET /space/api/v2/worlds`,
resolve `aether-archipelago`, `nature` or `copper-metropolis` to a backend-specific UUID, and join with
`POST /space/api/v2/worlds/{world}/join`. All entity, terrain and configuration
operations retain that UUID. Entity code reads its current world through
`ctx.world.getInfo()`, and the client copies the current world into its Agent Prompt.
See [the world-selection guide](server/space/agent/worlds.md).

Aether Archipelago is the default world (seed 42, generator version 3),
ported from terrain lab with floating islands, castles, bridges, crystals and
waterfalls. Solid terrain and buildings use 1 m blocks; ornaments use 0.125 m
micro blocks, including emissive details. The spawn is aligned with a major island.
Enter at `/space/app/?world=aether-archipelago` locally or
`https://space-dev-908123.entropydrop.com/?world=aether-archipelago` on the
private development domain. Production is available at
`https://space.entropydrop.com/?world=aether-archipelago`; `default` and an omitted
selector enter Aether. Nature and Copper retain their existing identities and data.

## Offline distribution for itch.io

```sh
npm ci
npm run build:offline
# Alias: npm run build:itchio
npm run preview:offline
```

The script builds a standalone production client in `dist/itchio/`, runs the
production bundle and compiler-worker checks, then creates
`dist/entropydrop-space-itchio.zip`. The ZIP has `index.html` at its root, uses
relative asset paths, and is verified against the
[itch.io HTML5 upload limits](https://itch.io/docs/creators/html5).
It does not overwrite the online production output in `client/dist/`.

On itch.io, select **HTML Game**, upload the ZIP, and enable **This file will be
played in the browser**. Use a desktop keyboard/mouse layout and click-to-launch
fullscreen. The game still requires a browser with WebGPU and GPU acceleration.
Test the uploaded draft on the target browsers before publishing.

The offline build bypasses login, queues, APIs and multiplayer. All required
assets are included; a restrictive offline CSP prevents external resource requests.
The default world is Aether Archipelago; `?world=nature` and
`?world=copper-metropolis` select the other included procedural worlds.
Terrain edits, entities, backpack contents and player position persist in browser
storage when available. Clearing browser data removes local saves; export important
backpack items as Protobuf for backup or transfer. Far-terrain server snapshots and
chain-linked worlds are unavailable. Market, publishing, custom skins and Agent
Build link to `https://space.entropydrop.com/` in a new tab; online saves are separate.
Feature links open their corresponding panel or settings tab after online login
once the updated online client is deployed.

| Online feature | Offline behavior | Online destination |
| --- | --- | --- |
| Market browsing, downloads and likes | Replaced with an online invitation; no Market client | `?panel=market` |
| Publish items or color sets | Shows export-and-transfer guidance with an Export Protobuf button; never uploads | `?panel=market` |
| Space API keys, credits and API allowances | Replaced with account guidance; no key or usage requests | `?panel=api-keys` |
| External Agent Build | Replaced with an online invitation | `?panel=agent-build` |
| Entity AI assistant and model API settings | Replaced with guidance; stored model keys are neither loaded nor saved | `?panel=agent-build` |
| Paid entity hosting | Replaced with transfer guidance; hosting handlers cannot be installed | `?panel=hosting` |
| Account character skins | Replaced with online customization guidance | `?panel=character` |
| Multiplayer, shared saves, server snapshots and linked worlds | Network adapters disabled; graphics settings explain online world features | `?panel=worlds` |

All destinations use `https://space.entropydrop.com/` and open a new tab.
Local editing, script compilation/execution, physics, backpack import/export and
model import remain available. The bundled entityAPI documentation stays readable,
and its online spaceAPI links use the production Space origin. Login, admission,
world API/WebSocket synchronization and administrator monitoring are disabled.

For local testing, use the preview command (or serve `dist/itchio/` over localhost).
Opening `index.html` directly through `file://` is unsupported because the client
uses ES modules and workers. The ZIP is a static HTML5 distribution, not a native
desktop executable or a service-worker cache for revisiting itch.io without a network.

## Contracts

The backpack and Market use one Item concept for static blocks, entities, or both.
An Item reuses an optional `BlockSet` and a list of existing `Entity` trees;
inventory remains v8 and browser-local backpack state is v10. See the
[Item contract and migration rules](proto/README.md#unified-items).

```sh
npm run generate:protobuf
npm run check:protobuf
npm run docs:generate
npm run docs:check
```

Protobuf checks require protoc 33.2.
Python bindings and public Agent copies live in `server/space/`. Verify them with:

```sh
python3 tools/sync_server_contracts.py --check --protobuf
```

See [protocol rules](proto/README.md), [client guide](client/README.md),
[engine guide](engine/README.md), and
[architecture and module boundaries](client/docs/architecture.md).

## Server and development deployment

See [server setup](server/README.md) and [DS development deployment](deploy/README.md).
`npm run check` runs the client/engine gates, builds and tests the hosted runtime,
checks Python contracts, and runs the Python suite. Install the server development
dependencies in `server/.venv`, or set `SPACE_PYTHON` to another Python interpreter.
Use `npm run check:client` or `npm run check:server` for a focused run.
Build the shared runtime with `npm run build:server-runtime`; run server checks from
`server/` with `python -m pytest`. Verify Python bindings and public Agent references:

```sh
python3 tools/sync_server_contracts.py --check --protobuf
```

Space owns world storage, Market objects, API/WebSocket handling, and hosted simulation.
The sibling backend retains login, API keys, authoritative credits and the account RPC.
Production and development Space are built from this repository. The backend's
legacy world implementation has been removed; historical account Alembic revisions
remain intact. Production deployments and CDN uploads must use the 19100 proxy.
See [deployment and rollback](deploy/README.md).
The [production release gates](tools/RELEASING.md) cover staged CDN publication,
legacy entry synchronization, live asset verification and persisted entity checks.

The repository retains the original engine Git history and the new repository's
initial commit. The frontend's client history remains in its original repository.
