# EntropyDrop Space

Space is a Node 24+ / npm 10+ workspace with one root lockfile:

- `client/`: Three.js browser client and UI (`@entropydrop/space`).
- `engine/`: shared TypeScript physics, voxels, simulation and scripting (`@entropydrop/space-engine`).
- `proto/`: canonical Protobuf definitions; generated TS stays in `engine/src/generated/`.
- `server/`: independent FastAPI/WebSocket service, simulation worker, storage and migrations.
- `tools/`: protocol/API generators and development deployment driver.
- `deploy/`: standalone server Dockerfile and development deployment guide.

## Development

```sh
npm ci
npm run dev
npm run check
npm run build
```

The standalone client is served at `/space/app/`; output is `client/dist/`.
Copy `.env.example` to `.env.local` and set the account API origin and optional
Space API origin. These public Vite settings are read from this workspace root.

For the existing same-origin login flow, install this workspace, then run `npm ci`
and `npm run dev` in the sibling `entropydrop_frontend/`. Its development server
mounts this client; its production build still merges `client/dist/` into the site.
The account API-key page consumes explicit client package exports.

## Contracts

```sh
npm run generate:protobuf
npm run check:protobuf
npm run docs:generate
npm run docs:check
```

Protobuf checks require protoc 33.2. Schemas and wire formats are unchanged.
Python bindings and public agent copies remain in `entropydrop_backend/`:

```sh
cd ../entropydrop_backend
python3 space/sync_agent_docs.py --check --protobuf
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
Development Space is built entirely from this repository. The backend's legacy Space
implementation is retained for the existing production release until production rollout;
it is not used to build the new development image.

The repository retains the original engine Git history and the new repository's
initial commit. The frontend's client history remains in its original repository.
