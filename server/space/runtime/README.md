# Space hosting runtime

`hosting-runtime.ts` handles the private stdin/stdout protocol; `HostedSimulation.ts`
applies hosting limits and runs the shared engine. The Python worker owns world
leases, persistence and the account-service billing outbox.
The coordinator uses one independent runtime process per entity/core, capped globally
at 128 physical CPU reservations. Linux pins each process before sending guest input.
See [hosting allocation, UI and deployment](../../docs/entity-hosting.md).

The worker and browser share the Rapier WASM solver for eligible rigid bodies.
Bodies with constraints or independent collision components use the Space solver
alongside any bodies that could contact them. The worker checks Rapier during its
readiness probe and uses the stored terrain geometry directly for collision.
Rapier colliders are resident for each transaction batch. Each batch starts from
the supplied checkpoint, then releases its WASM world when the candidate finishes.

Use Node 24.22.1+ on the 24.x line (or 26.12.1+ on 26.x) and run from the Space workspace root:

```sh
npm ci
npm run build:server-runtime
```

The runtime links `engine/` through the root workspace and bundles it and Rapier WASM into
`server/space/runtime/dist/hosting-runtime.mjs`. `deploy/Dockerfile` installs the pinned
AssemblyScript compiler and Binaryen alongside the bundle.
Use the Docker image for deployment; there is no runtime-specific lockfile.

From `server/`, `DATABASE_URL=sqlite:///:memory: python -m space.hosting_smoke`
checks execution and restart recovery without enabling hosting. Hosting remains
opt-in via `SPACE_HOSTING_ENABLED=true`.
See [development deployment](../../../deploy/README.md).
