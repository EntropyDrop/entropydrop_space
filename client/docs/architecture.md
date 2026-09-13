# Space architecture

Three sibling repositories form one product. Keep them checked out side by side:

```text
entropydrop_website/
  entropydrop_frontend/        # main site
  entropydrop_space/           # workspace: client/, engine/, proto/, tools/
  entropydrop_backend/         # FastAPI Space service + hosting worker
```

## Responsibility split

- **`entropydrop_space/engine`** owns voxel/chunk data, terrain generation, meshing, torus
  math, entities, physics, simulation timing, the QuickJS script sandbox, the entityAPI
  contract (`src/contraption/ScriptApiContract.ts`), the inventory/backpack Protobuf codecs
  (`src/storage/InventoryProtobuf.ts`). Shared schemas live in workspace `proto/`. It does not import either
  application.
- **`entropydrop_space/client`** owns the browser experience: React UI, Three.js
  rendering, input, sound, browser storage, REST/WebSocket clients and login handoff.
- **`entropydrop_backend`** owns authentication, world/entity/market persistence, quotas
  and billing, the `space-relay-v1` realtime relay, the hosting worker
  (`space/runtime/`) and the multiplayer storage contracts.

## `client/` module map

| Path | Responsibility |
| --- | --- |
| `src/main.ts` | Entry: bootstrap the session, build the world/renderer/controller, mount React. |
| `src/bootstrap/SpaceBootstrap.ts` | `/bootstrap` + terrain-edit REST client, world edit outbox, offline player position. |
| `src/bootstrap/SpaceAuthSession.ts` | Main-site login token handoff and refresh; no account system of its own. |
| `src/bootstrap/NetworkSafety.ts` | URL allow-listing, response-size limits, SHA-256 helpers, off-main-thread JSON parsing. |
| `src/bootstrap/SpaceEntityClient.ts` | Entity REST client; sends `application/x-protobuf` envelopes, verifies definition digests. |
| `src/bootstrap/SpaceMarketClient.ts` | Market list/publish/download/like/delete. |
| `src/bootstrap/SpaceSurfaceSnapshot.ts` | Far-surface `EDSZ` manifest and zone download/verification. |
| `src/bootstrap/SpaceApiKeyClient.ts`, `LatencyMonitor.ts`, `JsonParseWorker.ts` | API keys/usage, latency sampling, JSON worker. |
| `src/engine/controls/PlayerController.ts` | The largest module: player, tools (shovel/spoon/hammer/wrench), selection, inventory, build/entityize flows, file import/export. |
| `src/engine/building/` | `SpaceBuilder` (AI BuildPlan validate/preview/commit) and `BuildAgent` (plan generation). |
| `src/engine/contraption/` | `AgentChat` (model calls + prompts), `AgentConfig`, `BehaviorAgent`, entity script generation. |
| `src/engine/network/` | `MultiplayerSync` (`space-relay-v1` client) and `SpaceEntitySync` (AOI entity polling, checkpoint cadence, execution-lease coordination). |
| `src/engine/render/` | Scene, LOD/far-surface layer, impostors, lighting/HDR presets, particles, character/skin, held tools. |
| `src/engine/voxel/` | Model import (GLTF/STL) and voxelization. |
| `src/engine/storage/BrowserStorage.ts` | IndexedDB with localStorage fallback and legacy-key migration. |
| `src/engine/audio/` | Procedural/streamed sound and music. |
| `src/ui/` | `Minimap`, `NavigationSystem`, and the React store/components (`ui/react/`). |
| `tools/`, `test/` | Screenshot/benchmark helpers and the Node test suite. |

## Runtime data flow

1. `main.ts` calls `POST /space/api/v2/bootstrap`, loads the start pose and surface manifest,
   then constructs the renderer, world and `PlayerController`.
2. Terrain edits arrive through the durable REST cursor and the `space-relay-v1` `terrain`
   invalidation; local edits queue in the `space.world-edits.v3` outbox and upload in
   idempotent batches.
3. Player poses flow over the relay at 20 Hz and are checkpointed to the backend every 5 s
   and on disconnect/suspension.
4. Entities are authored in the browser (or by an agent through spaceAPI), uploaded as
   canonical Protobuf, and executed by whichever browser holds the 8-second execution lease;
   observers keep a stopped collision pose.
5. Offline mode swaps the REST/relay clients for local storage and never calls the entity
   endpoints.

## Settings, LOD and model import

- Settings UI lives in `src/ui/react/components/SimpleModals.tsx` (tabs: Character,
  Graphics, Sound, API) and is persisted through `SpaceUiStore`/`BrowserStorage`.
- Far-surface LOD is `src/engine/render/DistantSurfaceLayer.ts` with
  `DISTANT_SURFACE_SETTING_LIMITS`; the five tier distances, final limit, per-tier
  switches and neighbor-connection radius are validated there before the staged rebuild.
- Lighting presets and automatic resolution live in
  `src/engine/render/LightingQuality.ts` and `AdaptiveResolution.ts`; per-entity impostor
  switches live in `src/engine/render/EntityImpostorSettings.ts`.
- Model import (`GLTF`/`STL`/`OBJ`) runs through `src/engine/voxel/ModelVoxelizer.ts`,
  `STLVoxelizer.ts`, `ModelImportArchive.ts` and the STL worker, all treated as untrusted
  input and bounded by triangle/voxel/size limits.

## Build and test

The Vite config builds `client/` with `base: '/space/app/'`. The frontend root's
`npm run build` builds the main site and Space, then `scripts/merge-space-dist.js` merges the
Space output into the site's `dist/space/app/` document. Local verification is documented in
[`CONTRIBUTING.md`](../CONTRIBUTING.md); production deployment steps live outside this
repository.
