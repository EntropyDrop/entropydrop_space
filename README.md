# EntropyDrop Space

Space is a Node 24+ / npm 10+ workspace with one root lockfile:

- `client/`: Three.js browser client and UI (`@entropydrop/space`).
- `engine/`: shared TypeScript physics, voxels, simulation and scripting (`@entropydrop/space-engine`).
- `proto/`: canonical Protobuf definitions; generated TS stays in `engine/src/generated/`.
- `tools/`: protocol and API documentation generators.

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

## Migration boundary

This is the first migration stage. Server code, database migrations, account and
billing services remain in the backend. The backend hosting runtime now links
`../../../entropydrop_space/engine`; reinstall its dependencies after migration.
Hosting Docker builds still use the parent directory as their build context.

The workspace retains the original engine Git history and remote configuration.
Client files are moved from the frontend working tree; frontend history remains
in that repository. No commits, remote changes or deployments are performed by
this migration. Review and commit the Space, frontend and backend changes together.
