# Contributing

## Local verification

Use Node.js 24 or newer, npm 10 or newer, and a `protoc` release with
proto3 optional-field support. The checked-in bindings were generated with
protoc 33.2 and `protoc-gen-ts_proto` 2.12.1.

Run from the Space workspace root (`entropydrop_space/`):

```bash
npm ci
npm run check
npm run audit:deps --workspace @entropydrop/space
```

`entropydrop_space/proto/` owns the shared contracts: `inventory.proto`
(portable resource, v8), `backpack.proto` (browser-local state, v10) and
`space_api.proto` (binary REST request envelopes, v2). See
[`proto/README.md`](../proto/README.md) for the
versioning rules and generation commands. After any schema change run
`npm run generate:protobuf` and commit the regenerated TypeScript bindings and
descriptor under `engine/src/generated/`. Unified Item is an additive inventory v8
alternative that reuses `BlockSet` and `Entity`; backpack v10 merges their local
collections and explicitly reads v8/v9 storage. Shared resource or API-envelope changes
must also regenerate both backend Python bindings (`inventory_pb2.py`,
`space_api_pb2.py`). Sync the public agent reference copies with
`python3 tools/sync_server_contracts.py`, then verify with
`python3 tools/sync_server_contracts.py --check --protobuf` from the workspace root.
`npm run check` runs the engine
checks (including `check:protobuf`) and the frontend integration tests.

Add a regression test for behavior changes. Browser-facing changes should also
be checked manually in a WebGPU-capable browser with GPU acceleration and the
developer console open. See the [module boundaries](docs/architecture.md) before
adding controller, rendering or inventory dependencies.

## API and documentation changes

The public entity scripting API is rendered from one source of truth:
`entropydrop_space/engine/src/contraption/ScriptApiContract.ts`. Edit that
contract, then run `npm run docs:generate` from the workspace root to refresh
`engine/docs/generated/api-v2.md` and `engine/docs/generated/agent-api-v2.md`.
Run `python3 tools/sync_server_contracts.py` from the workspace root to copy
the public Agent references into `server/space/agent/`; use `--check` to detect
drift. The in-game reference (`src/ui/react/components/EditorModal.tsx` via
`apiDocsMarkup.ts`) and
the Agent system prompt (`src/engine/contraption/AgentChat.ts`) consume the same
contract, so there is no separate API copy in `index.html`.

Multiplayer protocol changes update
`server/space/contracts/protocol.proto` (linted by
`server/space/contracts/buf.yaml`), the storage design in
`server/docs/space-backend.md`, and `server/tests/test_space_contracts.py`
together. The realtime WebSocket channel is still the transitional
`space-relay-v1` MessagePack relay;
the `space.multiplayer.v2` protobuf contract is the target authoritative
protocol and is not yet compiled or implemented. Do not describe it as live.
`protocol.proto` must stay `buf lint` clean (run
`cd server/space/contracts && buf lint`, using the workspace's pinned
`@bufbuild/buf` if buf is not installed).

Changing a `space-relay-v1` frame (field names, types, or the 4096-byte inbound
limit) requires regenerating the shared wire fixture: run
`node client/tools/generate-relay-fixtures.mjs` from the workspace root, copy
`client/test/fixtures/space-relay-v1.json` to
`server/tests/fixtures/space-relay-v1.json`, and update
`client/docs/networking.md`. The contract tests on both sides
(`client/test/space-relay-v1.test.ts`,
`server/tests/test_space_relay_contract.py`) fail on drift.

## Security-sensitive boundaries

- Treat entity scripts and imported files as untrusted input.
- Keep AssemblyScript/WASM memory, time, state, and command-buffer limits intact.
- Never send an Agent API key to a non-HTTPS remote endpoint.
- Validate compressed and uncompressed sizes before allocating or decoding.
- Keep request envelopes (`space_api.proto`) free of secrets; the opaque runtime
  snapshot is untrusted input that the backend re-validates.
