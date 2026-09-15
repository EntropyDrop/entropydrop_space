# Space hosting runtime

`hosting-runtime.ts` handles the private stdin/stdout protocol; `HostedSimulation.ts`
applies hosting limits and runs the shared engine. The Python worker owns world
leases, persistence and the account-service billing outbox.
The coordinator uses one independent runtime process per entity/core, capped globally
at 128 physical CPU reservations. Linux pins each process before sending guest input.
See [hosting allocation, UI and deployment](../../docs/entity-hosting.md).

Use Node 24+ and run from the Space workspace root:

```sh
npm ci
npm run build:server-runtime
```

The runtime links `engine/` through the root workspace and bundles it into
`server/space/runtime/dist/hosting-runtime.mjs`. QuickJS/WASM stays external;
`deploy/Dockerfile` installs its exact production dependencies alongside the bundle.
Use the Docker image for deployment; there is no runtime-specific lockfile.

From `server/`, `DATABASE_URL=sqlite:///:memory: python -m space.hosting_smoke`
checks execution and restart recovery without enabling hosting. Hosting remains
opt-in via `SPACE_HOSTING_ENABLED=true`.
See [development deployment](../../../deploy/README.md).
