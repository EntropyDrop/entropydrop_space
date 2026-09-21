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
Copy `.env.example` to `.env.local` and set the account API origin and optional
Space API origin. These public Vite settings are read from this workspace root.

For the existing same-origin login flow, install this workspace, then run `npm ci`
and `npm run dev` in the sibling `entropydrop_frontend/`. Its development server
mounts this client. Production publishes Space independently and provides the
main-site login return page at `/space/login`.
The account API-key page consumes explicit client package exports.

Development also provisions the Copper Metropolis world, generated from the
terrain-lab algorithm with terrain generator version 2. Enter it at
`/space/app/?world=copper-metropolis`; omitting `world` continues to select the
default nature world. The alternate world is intentionally unavailable in the
production environment.

## Contracts

```sh
npm run generate:protobuf
npm run check:protobuf
npm run docs:generate
npm run docs:check
```

Protobuf checks require protoc 33.2. Schemas and wire formats are unchanged.
Python bindings and public Agent copies live in `server/space/`. Verify them with:

```sh
python3 tools/sync_server_contracts.py --check --protobuf
```

See [protocol rules](proto/README.md), [client guide](client/README.md), and
[engine guide](engine/README.md).

## Server and development deployment

See [server setup](server/README.md) and [DS development deployment](deploy/README.md).
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

The repository retains the original engine Git history and the new repository's
initial commit. The frontend's client history remains in its original repository.
