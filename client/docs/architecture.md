# Space architecture

Space is one workspace with a browser client, shared engine and independent server.
The sibling applications supply the main site and account service:

```text
entropydrop_website/
  entropydrop_frontend/        # main site
  entropydrop_space/           # workspace: client/, engine/, server/, proto/, tools/
  entropydrop_backend/         # account service: identity, API keys and credits
```

## Responsibility split

- **`entropydrop_space/engine`** owns voxel/chunk data, terrain generation, meshing, torus
  math, entities, physics, simulation timing, the AssemblyScript/WASM script sandbox, the entityAPI
  contract (`src/contraption/ScriptApiContract.ts`), the inventory/backpack Protobuf codecs
  (`src/storage/InventoryProtobuf.ts`). Shared schemas live in workspace `proto/`. It does not import either
  application.
- **`entropydrop_space/client`** owns the browser experience: React UI, Three.js
  rendering, input, sound, browser storage, REST/WebSocket clients and login handoff.
- **`entropydrop_space/server`** owns world/entity/market persistence, quotas,
  the billing reservation/capture outbox, the `space-relay-v1` realtime relay,
  the hosting worker (`space/runtime/`) and the multiplayer storage contracts.
- **`entropydrop_backend`** owns account authentication, API-key records and
  authoritative credit balances. Space calls it through `server/space/integrations/`.

## `client/` module map

| Path | Responsibility |
| --- | --- |
| `src/main.ts` | Entry: bootstrap the session, build the world/renderer/controller, mount React. |
| `src/bootstrap/SpaceBootstrap.ts` | `/bootstrap` + terrain-edit REST client, world edit outbox, player checkpointing. |
| `src/bootstrap/SpaceAuthSession.ts` | Main-site login token handoff and refresh; no account system of its own. |
| `src/bootstrap/NetworkSafety.ts` | URL allow-listing, response-size limits, SHA-256 helpers, off-main-thread JSON parsing. |
| `src/bootstrap/SpaceEntityClient.ts` | Entity REST client; sends `application/x-protobuf` envelopes, verifies definition digests. |
| `src/bootstrap/SpaceMarketClient.ts` | Market list/publish/download/like/delete. |
| `src/bootstrap/SpaceSurfaceSnapshot.ts` | Far-surface `EDSZ` manifest and zone download/verification. |
| `src/bootstrap/SpaceApiKeyClient.ts`, `LatencyMonitor.ts`, `JsonParseWorker.ts` | API keys/usage, latency sampling, JSON worker. |
| `src/engine/controls/PlayerController.ts` | Player/tool interaction, selection and build/entityize flows; coordinates UI effects and delegates backpack operations, persistence and placement geometry to `inventory/`. |
| `src/engine/controls/SelectionGeometry.ts`, `SelectionTypes.ts` | Component-local selection frames, virtual micro voxels, selection bounds and state contracts. |
| `src/engine/controls/ControlBindings.ts`, `PreviewDragForce.ts` | Tool identifiers, reserved keys, perspective types and camera-relative drag-force math. |
| `src/engine/inventory/InventoryImport.ts` | Bounded Protobuf input validation, with separate Item, Block Set, Entity and Color Set parsers. |
| `src/engine/inventory/InventorySerialization.ts` | Runtime-to-portable conversion, resource encoding, names and flat entity root resolution. |
| `src/engine/inventory/InventoryGeometry.ts` | Shared preview geometry, hierarchy transforms, grid alignment and voxel occupancy checks. |
| `src/engine/inventory/Backpack.ts` | Backpack collections, legacy category aliases, selection, item mutations and default palettes. |
| `src/engine/inventory/BackpackPersistence.ts` | Injected storage, Protobuf save/load, v8/v9 migration and retention of malformed original storage. |
| `src/engine/inventory/InventoryRotation.ts`, `InventoryPlacementGeometry.ts` | Grid rotations, cached placement footprints, support probes and oriented-box overlap. |
| `src/engine/building/` | Retired `SpaceBuilder` and `BuildAgent` BuildPlan libraries; reference/tests only, not connected to application startup. |
| `src/engine/contraption/` | `AgentChat` (model calls + prompts), `AgentConfig`, `BehaviorAgent`, entity script generation. |
| `src/engine/network/` | `MultiplayerSync` (`space-relay-v1` client) and `SpaceEntitySync` (AOI entity polling, checkpoint cadence, execution-lease coordination). |
| `src/engine/render/InventoryPreviewMesh.ts`, `PreviewTypes.ts` | Inventory surface meshing and typed preview/remote-player state. |
| `src/engine/render/` | Scene, terrain LOD/far-surface layer, lighting/HDR presets, particles, character/skin, held tools. |
| `src/engine/voxel/` | Model import (GLTF/STL) and voxelization. |
| `src/engine/storage/BrowserStorage.ts` | IndexedDB with localStorage fallback and legacy-key migration. |
| `src/engine/audio/` | Procedural/streamed sound and music. |
| `src/ui/` | `Minimap`, `NavigationSystem`, and the React store/components (`ui/react/`). |
| `src/ui/react/components/AgentBuildModal.tsx`, `SpaceAgentInstructions.tsx` | HUD Agent Build: external-agent prompt, public API/Skill links, and shared spaceAPI key management. |
| `tools/`, `test/` | Screenshot/benchmark helpers and the Node test suite. |

## Inventory dependency boundaries

Inventory import, serialization and geometry are callable without creating a
controller, renderer or browser DOM. They use the engine's Protobuf codecs,
constants, decoration normalization and portable ID rules
(`engine/src/contraption/PortableIds.ts`). Import validation retains byte, voxel,
component, script and geometry limits; it does not execute entity scripts.

Placement, scene previews and thumbnail rendering all consume the same geometry
functions. UI components import tool identifiers from `ControlBindings.ts`.
Existing controller methods and renderer exports remain compatibility adapters;
new data-only callers should import the inventory modules directly. Browser
storage discovery and UI updates stay in the controller/store layer. The persistence
module receives a storage interface; it never accesses localStorage or the DOM.
`test/inventory-modules.test.ts` verifies this boundary in
a fresh process, while the existing backpack/copy/placement suites exercise the
compatibility paths.

`engine/src/storage/InventoryTypes.ts` defines the portable resource union and the
runtime Item, Entity, Block Set and Color Set contracts. Portable entity voxels use
integral cells plus micro offsets; validated runtime entity voxels use local
construction coordinates. `InventoryInput` is the explicit compatibility projection
for older in-memory callers, which may omit defaulted fields. Binary import returns
a discriminated success/failure result and validates its contents before use.

`npm run typecheck:inventory --workspace @entropydrop/space` checks every inventory
module and its transitive imports with `strict` and `noImplicitAny`. This gate also
runs from the normal `typecheck` and `check` commands. Compile-only tests ensure
resource categories and failed imports cannot be used without narrowing. The engine,
client and hosted runtime use `strict: true`, including their TypeScript tests.
Core voxel, component, rigid-body, terrain-worker, script-snapshot, inventory and
selection data now have explicit contracts. Legacy dynamic action dispatch and
some integration adapters still use explicit `any`; strict mode prevents new
implicit `any` and unchecked nullable values, and does not by itself eliminate
all dynamic boundaries.

The shared engine separates `Contraption` into `EntityVoxelMeshes.ts` (mesh/index
construction), `ComponentScriptApi.ts` (component capabilities), `EntityInput.ts`
(input normalization) and `EntityTypes.ts` (runtime contracts).
`ContraptionManager` delegates world/selection capabilities to `WorldScriptApi.ts`
and checkpoint capture/restore to `EntityStreaming.ts`. Browser UI and renderer
code remain outside these engine modules. `PhysicsTerrain.ts` describes the
terrain queries required by physics instead of accepting an untyped world.

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
## Settings, LOD and model import

- Settings UI lives in `src/ui/react/components/SimpleModals.tsx` (tabs: Character,
  Graphics, Sound, API) and is persisted through `SpaceUiStore`/`BrowserStorage`.
- Far-surface LOD is `../engine/src/render/DistantSurfaceLayer.ts`. Settings expose
  a screen-error target in pixels, bent-world viewing distance, and a refinement
  data budget. Old distance tiers are discarded during settings normalization.
  Height range, colour residual and torus curvature drive subdivision using the
  current camera projection and drawing-buffer height, with hysteresis and height
  morphing. The data/geometry ceilings can limit attainable quality; increasing
  the data budget allows more fine source data, not a larger simulation radius.
- EDSZ v6 includes conservative errors in each precomputed mip and sparse authored
  chunk solids (`DistantChunkLayer.ts`). Vertical runs preserve excavations, air
  gaps, colour boundaries and microcell footprints independently of the terrain
  sample width. Microcell part shapes use their voxel bounds in the far proxy.
  Local edits are captured before near meshes leave the AOI and retained until
  an equally new acknowledged server chunk revision arrives.
- The v6 source has exact 1m columns. Unknown finer residuals request real data;
  subdividing below a downloaded mip only improves torus curvature. Cache space
  is assigned in refinement waves across visible zones, avoiding a 64m cliff
  after the first few zones exhaust the budget. Overview installs inform demand
  in the same download pass, and refreshes replace the current resolution directly.
  Network polling never waits for the moving camera's mesh queue to become idle.
- The 128 KiB ownership texture distinguishes procedural far surface, authored
  far solids, and ready near terrain. Fine boundary cells, inward-owned side
  masks and closed side connections prevent near/far and curved-LOD cracks.
  Curved top normals interpolate per vertex to avoid lighting bands between LODs.
  GPU batches stay live until a complete replacement is ready; camera updates are
  coalesced without cancelling an in-progress build. Dirty/unavailable manifests
  keep last-good coverage. Server schema upgrades retain legacy snapshots while
  the background generator fills v6. The torus far layer remains active in the
  canonical world projection.
- To reproduce the authored handoff in WebGL, run
  `python tools/generate_distant_surface_fixture.py` from `server/`, then open
  `tools/distant-surface-preview.html` through the client dev server. The fixture
  exercises the actual server serializer, client decoder, near voxel world,
  suspended beam, pit and microcell, with near/far views, forced 64m source data,
  camera travel and revision refresh. The remaining overview is deliberately
  uniform test terrain; fixture triangle counts are not production benchmarks.
  With `--terrain-json <export> --all-zones`, the same tool instead builds all
  128 zones and a streaming manifest from a read-only development-world export.
  Select Live streaming in the preview to exercise the real cache and loader.
- Lighting presets and automatic resolution live in
  `src/engine/render/LightingQuality.ts` and `AdaptiveResolution.ts`.
- Model import (`GLTF`/`STL`/`OBJ`) runs through `src/engine/voxel/ModelVoxelizer.ts`,
  `STLVoxelizer.ts`, `ModelImportArchive.ts` and the STL worker, all treated as untrusted
  input and bounded by triangle/voxel/size limits.

## Build and test

Run `npm run check` from the workspace root for engine checks, client type checking,
documentation links, client tests, the production build, hosted-runtime checks and
Python server tests. Set `SPACE_PYTHON` when using a Python environment outside
`server/.venv`. Vite defaults to
`base: '/space/app/'`; `VITE_SPACE_BASE_PATH` selects the production entry path.
Build output is `client/dist/`, and the build checks production module initialization
and excludes development-only entry points. See [`CONTRIBUTING.md`](../CONTRIBUTING.md),
the [deployment guide](../../deploy/README.md) and
[release gates](../../tools/RELEASING.md).
