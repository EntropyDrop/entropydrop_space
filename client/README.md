# EntropyDrop Space

[spaceAPI](../server/space/agent/spaceAPI.md) · [entityAPI](../engine/docs/generated/api-v2.md)

entityAPI is the runtime interface called by entity code through `self` / `ctx`; spaceAPI is the HTTP interface used by agents and clients.

World entities have overhead nameplates: name, playback status, browser executor
name, or a purple `Server hosting` badge. A live browser lease is distinguished
from a start request waiting for an available execution endpoint. The `…` button opens the
same entity menu with every tool; locked input hit-tests the crosshair before
tool actions. Menu commands target the clicked entity, not later hover state.
Actions include Start/Stop, whole-entity copy to the backpack, programming, root
block Select All, ID copy, and confirmed whole-entity deletion. Whole-entity copy
does not require a Selector A/B range and does not change the source's playback;
block selection actions still require confirmed A/B. Online deletion waits for
the backend acknowledgement and leaves the entity intact on failure. Existing
execution-occupancy restrictions and the paid-hosting availability switch remain enforced.
Menu actions retain text rows with leading icons and shortened captions, descriptive
hover titles and accessible labels. Nameplate playback uses filled green play/red
stop icons matching the code editor to the right of the entity name.
The browser executor name appears as a smaller second line below the entity name;
the playback icon remains on the right and hosting retains its purple badge.
The delete confirmation retains its explicit irreversible-action warning.
Nameplates share the world render pass's bent camera and interpolated component
transforms, caching authored extents rather than transforming every voxel per frame.

Driver seats with `fixedOrientation:true` keep the rider's body aligned to the
seat's solved world rotation, including articulated components. Camera mouse
look stays free in all three perspectives. Mounting, dismounting and runtime
`self.setSeats` changes preserve the camera's yaw and pitch.
Perspective changes ease over 280 ms: first/third-person switches zoom relative
to the current eye position, and rear/front third-person switches orbit around
the rider instead of cutting through the body. Interrupted switches continue
from the displayed pose. Mouse look and player/seat movement remain immediate;
saved perspective settings restore without an initial animation.

## Documentation map

| Document | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Three-repository split, module map and runtime data flow. |
| [docs/networking.md](docs/networking.md) | REST boundaries, credentials and the `space-relay-v1` MessagePack schema. |
| [docs/formats.md](docs/formats.md) | Inventory v7, backpack v8, API envelopes v2, `EDSZ` v5 and the world-edit outbox. |
| [docs/ai-builder.md](docs/ai-builder.md) | Agent Build external-agent workflow and retired BuildPlan reference. |
| [docs/micro-grid-p0.md](docs/micro-grid-p0.md) | 8×8×8 micro grid, collision caching and physics benchmarks. |
| [docs/agent-access-design.md](docs/agent-access-design.md) | Agent access architecture and migration plan (design, not shipped status). |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Local verification, schema regeneration and documentation sources. |
| [entropydrop_backend/docs/space-backend.md](../../entropydrop_backend/docs/space-backend.md) | Backend architecture and consistency contract. |

This app lives in the `entropydrop_frontend` npm workspace and is built as the
independent `/space/app/` document. The main `/space/intro` route is the product
introduction page. The app shares the repository's Three.js version and
the main site's `localStorage` login token. It does not own an account system.

Before constructing the Three.js scene it calls `POST /space/api/v2/bootstrap`,
loads the existing EntropyDrop user's latest backend state, or receives an
ephemeral world-wide random position when no snapshot exists. A configured
`skin_url` PNG is downloaded when available; otherwise Space immediately uses
the bundled default skin and shows a non-blocking reminder to configure a
character skin. An invalid or temporarily unavailable configured skin falls back
the same way instead of blocking entry. The first random position is checkpointed
immediately; later wrapped position/yaw updates are saved every five seconds,
on realtime disconnect, and before page suspension. Backpack data remains browser-local under
`space.backpack.v8.pb` and is never uploaded by this app. Older backpack schemas are
intentionally ignored. Player-authored standard
and micro-voxel terrain overlays are loaded from the authenticated spaceAPI and
sent back in idempotent batches of at most 256 mutations. A durable browser
outbox under `space.world-edits.v3.*` preserves unacknowledged batches across a
refresh; obsolete `space.world-edits.v1.*`/`v2` local-only overlays are ignored
rather than migrated, so only v3 edits are uploaded.

The distant world no longer uses a browser-generated low-poly thumbnail or a
synthetic doughnut. The backend builds 128 revisioned `32x32`-chunk zone
snapshots, each carrying an `8x8` two-metre height/color summary per chunk. The
browser validates the finest data and derives 4/8/16/32/64-metre mip levels, then
progressively installs them into one compact instanced surface layer. Outside
the fully loaded AOI the renderer uses 2m samples through 400m, 4m through 600m,
8m through 800m, 16m through 1000m, 32m through 1600m, and 64m beyond.
Samples through 4000m add merged side faces only where neighboring
heights actually differ, keeping nearby LOD boundaries continuous without the
overdraw of four full skirts per cell; farther tiers draw only their top faces.
Empty summaries render nothing and terrain edits dirty only their zone.
Automatic render resolution targets 120 FPS (60 FPS with Ultra lighting), reducing drawing-buffer scale
quickly below that cadence and restoring clarity only after a sustained healthy interval.
If 50% resolution is still insufficient, Auto temporarily pauses real-time
shadows and secondary lighting before accepting a sub-120 cadence. Settings →
Graphics → Performance → Lighting Quality offers four immediately applied,
locally saved presets: Low uses simple shadow-free daylight; Medium (default)
keeps the original 1024² soft shadows; High adds 2048² shadows, warmer sun,
cool bounce light and sun haze; Ultra adds a shader-pack-style HDR pipeline with
4096² long morning shadows, animated layered clouds, a bright solar disc,
depth-aware contact occlusion and sunlight shafts, distance/height haze,
multi-scale bloom, filmic color grading and FXAA. Post effects read depth from the
actual bent scene, so they support the donut projection, edited terrain and
entities. Near-camera viewmodels are excluded from haze and contact occlusion.
HDR buffers follow render resolution up to 2560 pixels on the longest side and
are released when leaving Ultra. GPUs without float color targets retain the
cinematic sky and daylight without the HDR chain.
Shadow maps are capped to GPU limits and released when disabled
or resized. The separate Shadows preference is retained at Low and during Auto
fallback, and restored when the selected quality permits it. Auto preserves the
selected preset while temporarily pausing shadows and secondary effects. In Ultra,
fallback pauses bloom, contact occlusion and sun shafts while retaining the
cinematic sky, color grading and atmospheric haze. Ultra targets 60 FPS to keep
its effects at ordinary display refresh rates; other presets still target 120 FPS.
Streaming work is capped at 3 ms per frame. Far topology follows a 64 m anchor
and rebuilds in 2 ms batches while the previous complete surface remains visible.
A 128 KiB GPU readiness mask hands each 16m chunk from the far snapshot to the
detailed mesh only after that mesh is attached, preventing streaming holes and
z-fighting without increasing the per-frame chunk budget.
The settings panel exposes all five LOD transition distances, a final far-surface
limit, per-tier 2/4/8/16/32/64m enable switches, and the neighbor-connection
radius. Values are stored locally, applied immediately through the staged rebuild,
constrained to increasing 50m bands and bounded by safe instance limits. A disabled
tier falls through to the next enabled coarser tier; beyond the final limit no
snapshot terrain is emitted, and setting connections to 0 disables them.
Recommended defaults keep every tier enabled, cover the full world, use
400/600/800/1000/1600m transitions, and connect through 4000m.

An AI-native programmable voxel physics prototype:

> Build anything. Tell it what to do.

The renderer always uses the seamless torus donut terrain. World shape is not a
per-player setting, so rendering, picking, distant LOD and physics all share the
same wrapped topology.

## Player spawn and reconnect

- A valid backend `player_snapshots` record always wins: its latest X/Y/Z and
  yaw become the player's initial pose.
- Without a valid snapshot, the backend samples X uniformly across
  `[0, 16384)` and Z uniformly across `[0, 2048)`, covering the complete
  wrapped torus rather than a central spawn area. It starts the player at
  `y = 32` above the procedural terrain ceiling and gives them a random yaw.
- Bootstrap always returns a complete start pose. `resumed=true` means the
  pose came from a durable snapshot; `resumed=false` means it is the new
  ephemeral random candidate. The client uses either pose to load the correct
  initial terrain AOI before constructing the world.
- The random pose is ephemeral until the admitted client starts successfully
  and checkpoints it. It is not stored as a permanent birth point in the
  player profile; another bootstrap may receive another random pose if no
  checkpoint was committed.

Players build with one freely colorable voxel material at two geometric scales,
select a region, and entityize it into a programmable component tree. Components
may be kinematic or dynamic rigid bodies connected by physical constraints. A natural-language
behavior is compiled into a controller that can read entity/world state and can
drive dynamic bodies through force/torque or kinematic bodies through direct pose commands.

## Geometry model

- There is one buildable block type. RGB color is stored per voxel instance.
- The shovel creates and removes standard `1 × 1 × 1` voxels.
- Clicking a standard voxel with the spoon replaces it losslessly with
  `8 × 8 × 8 = 512` micro voxels.
- The spoon can then create or remove individual `0.125 × 0.125 × 0.125` cells.
- Micro voxels live in a sparse grid and are merged into dirty-region render
  meshes per 16×16 standard-cell chunk; they are not 512 independent rigid bodies.
- Standard and micro voxels can be entityized together and are restored at the
  correct scale when the entity is solidified.

## Run locally

Requirements:

- Node.js 24 or newer and npm 10 or newer
- A current desktop browser with WebGL 2, ES modules, Web Workers, and WebAssembly
- No API key is required for the bundled local behavior compiler; remote Agent
  endpoints require HTTPS, except for localhost development

Run `npm ci` from `entropydrop_space/` first. For main-site integration,
run these commands from the sibling frontend repository:

```bash
npm ci
npm run dev
```

Open <http://localhost:5173/space/intro> for the introduction, manage account API keys at
<http://localhost:5173/space/apikeys>, then enter the app at
<http://localhost:5173/space/app/>. The main Vite process mounts Space directly
at that path, preserving the main site's origin and login token without a second
frontend server or proxy. API requests are sent by the browser directly to the
backend configured by `VITE_API_BASE_URL` (default: `http://localhost:8000`).

## Core loop

The selected toolbar tool appears as a voxel model, with movement sway and a
left-click stroke. In first person, an equipped tool replaces the visible arm
and enters from the lower-right edge with its handle partially offscreen;
clearing the tool restores the empty hand. Third person shows the tool held in
the right hand. Tools use silver metal; the brush has a wooden handle, metal
ferrule and matte natural bristles. The hammer's handle stays upright with its
striking face forward.

1. Choose any color, then use the shovel for standard construction or the spoon
   for micro-voxel sculpting.
2. Use the Selector to confirm both selection corners A and B.
3. Press `G` to entityize the selected blocks.
4. Aim at the entity and press `C`.
5. Describe the behavior, inspect the generated controller, and run it.

Entity backpack items can also be reused as modules with the Hammer: left-clicking
terrain spawns an independent entity and immediately puts it in **Play** (physics
active and all runnable component scripts enabled). Placing on a stopped entity
installs the item as a rigid child component under the crosshair; `Shift` + left-click
requests this installation mode explicitly, and the combined entity stays stopped.

Selector delete, copy, fill, recolor, assembly, and rotation require confirmed A/B;
an A-only, component preselection, or Shift-picked selection is not sufficient.
Right-click opens the complete Selector menu. **Select All** confirms the A/B bounds
of the current component's own blocks, excluding child-component blocks.
Changing the selection shape immediately updates selected cells, highlights,
counts, and action availability while preserving the A/B range; switching back
to Box restores that range without changing world or entity geometry.
Selection and manual geometry edits require a stopped entity: the first attempt
on a running entity immediately stops it and shows a notification. That
interaction does not also perform the attempted edit or selection. Online
entities request Stop immediately and remain non-editable until the server
acknowledges it; other endpoints' live occupations cannot be stopped or modified.

The bundled local Agent prototype currently understands English hover, follow,
orbit, launch, spin, attitude-stabilization, and stop intents.
Its result contract is intentionally small so it can later be replaced by a
remote LLM without changing the controller runtime.

Detailed component script and controller API documentation is available directly in-game via the Code Editor terminal (press `C` → entityAPI Docs) and in the generated [entityAPI V2 reference](../engine/docs/generated/api-v2.md). The [entityAPI code-generation reference](../engine/docs/generated/agent-api-v2.md), in-game reference, and runtime Agent prompt are all rendered from `entropydrop_space/engine/src/contraption/ScriptApiContract.ts`; edit that contract instead of these generated views.

The Entity Editor inspector separates authored values from live simulation data. **Defaults**
shows the pivot (`XYZ`), saved mounting-frame quaternion (`XYZW`), and, for child
components, the parent-relative position/quaternion restored by **Stop**. **Runtime** shows
the current local and composed world transforms, Euler angles for readability, plus the
physics center of mass, body quaternion, velocity, angular velocity, grounded state, and
simulation state. The root has no parent: its script-local position is `[0,0,0]`, while its
live local quaternion is also its world quaternion. The Authority panel identifies backend
versus offline persistence, edit/control permission, execution lease location, and
backend revisions.

## Multiplayer backend

The running browser client currently uses the transitional `space-relay-v1`
MessagePack WebSocket channel for player poses: changed poses are sampled at 20 Hz,
nearby-player snapshots arrive at 10 Hz, terrain is invalidated immediately and loaded
through its durable REST cursor, and reconnect positions are checkpointed every five
seconds. This relay is a compatibility stage, not the authoritative simulation protocol
described below.

Every world entity in online mode comes from the backend. The browser neither reads nor
writes `entropydrop_space_entities.*`; entering an online world removes that world's legacy
browser entity value. Creating or editing an entity uploads its canonical Protobuf definition
and a bounded runtime snapshot, and locally held entities checkpoint changed
state every six seconds. Removing one performs a backend hard delete. Legacy
browser entity data is removed and intentionally ignored. This boundary applies
only to world entities: the backpack deliberately remains local.

Inventory Protobuf v7 stores display names on every `Component`, with no `Entity.name`.
An entity's display name is `root.name`; empty names display the component ID. Names may
repeat and survive subtree copies, attachment, independent publication, and reloads.
Only IDs determine references and sibling ordering. Market content digests recursively
omit all component names; database list names are derived metadata. Browser backpacks
use Protobuf v8, and old resource, backpack, and offline entity versions are not migrated.
Micro voxels use `is_micro` plus `micro_x`/`micro_y`/`micro_z` offsets and a `uint32 color_rgb`,
matching the realtime `protocol.proto` encoding; the removed packed `micro_index` and
`fixed32 color` of v6 are not accepted.
Entity definitions travel as raw `application/x-protobuf` in both directions: upload uses
the `space_api.proto` request envelope (`CreateEntityRequest`/`CheckpointEntityRequest`) and
download is the raw canonical `InventoryResource`. JSON `definition_base64` requests remain
accepted for existing external agents.

External agents can submit canonical entity definitions directly with an account-level,
long-lived spaceAPI key with full Space permissions (including existing keys); market publication is not required. They can read world entities with `GET /entities/{id}/configuration`, edit component code/name/body defaults with `PATCH /entities/{id}/configuration`, and start/stop with `PUT /entities/{id}/run-state`, under the world API prefix. Edits require Stop and `expected_revision`; operation IDs make delayed retries safe. Entity playback has only running/stopped states. The browser polls the nearby
wrapped AOI, verifies the canonical Protobuf definition and optional
snapshot, then restores the exact construction/runtime pose, including its quaternion. For browser-executed entities, only
the endpoint holding the current eight-second execution lease advances physics/scripts;
observers interpolate non-simulating collision proxies. Any world member may start,
edit or delete an unoccupied entity regardless of author; nobody, including the author
or an administrator, may interfere with another endpoint's live occupation. Creator
attribution is unchanged, and market resources retain publisher permissions. Updated definition and state return to the
backend instead of browser storage. Entity `self.*` actions continue to run only on the lease
holder.

Explicit paid hosting now runs bounded entities without a browser executor at **1 credit/hour**.
The hosting API accepts an entity ID and a maximum credit budget funded by the requesting
account, whose active server occupation is protected from other accounts; the independent worker
commits simulation, terrain edits and billing atomically. Hosted entity viewers install
server snapshots and never obtain a browser execution lease. The editor Authority panel
shows the server executor. The entity menu exposes English `Host…` / `Stop hosting`
controls with explicit budget confirmation. HUD **Hosted Entities** lists your hosting
jobs across the world (outside the nearby AOI too), with `Teleport` and early `Stop`.
Each entity uses a separate runtime process and one dedicated physical CPU reservation;
the global pool is capped at 128 and by the worker's actual available physical cores.
Capacity/worker/credit/occupancy failures are shown in English. Early Stop preserves
unused prepaid time and releases the core after the process exits. See the
[hosting API and deployment guide](../server/docs/entity-hosting.md).
This bounded worker uses the current 20 Hz entity / 60 Hz physics engine and does not
replace the full multiplayer authority protocol below.
Its server-only source lives in `server/space/runtime/`. The backend build
bundles `@entropydrop/space-engine` from the `engine/` workspace package.
Install that repository’s dependencies with `npm ci` before installing the frontend.
The deployed worker needs neither frontend nor engine source files. Rebuild both consumers
when the shared engine changes. See the [engine setup and checks](../engine/README.md).

The Multiplayer V2 target is server-authoritative: zone workers own the 60 Hz
simulation and active chunks, binary WebSocket messages carry inputs and AOI
deltas, and PostgreSQL stores compressed chunk/entity checkpoints plus ordered
durable events. The database never participates in the per-frame physics path.
The V2 contract caps each world at 32 occupied sessions with FIFO queueing,
uses reliable AOI presence plus wake/sleep entity activation, and keeps the
three-category backpack in browser IndexedDB with automatic localStorage migration.

- Architecture and consistency contract: [`entropydrop_space/server/docs/space-backend.md`](../server/docs/space-backend.md)
- PostgreSQL 15+ schema: [`entropydrop_space/server/space/contracts/schema.sql`](../server/space/contracts/schema.sql)
- Protobuf realtime protocol: [`entropydrop_space/server/space/contracts/protocol.proto`](../server/space/contracts/protocol.proto)
- Portable resource, backpack, and API envelopes: [`entropydrop_space/proto/`](../proto/README.md)

## Verification

The 2026-09-02 gameplay, API, security, performance, and maintainability audit was
retired with the v7 wire format; its remediation is tracked by the tests below.

```bash
npm run check
npm run audit:deps
```

`npm run check` performs TypeScript validation, the engine checks (including
`check:protobuf`), the local documentation-link check, the complete Node test suite, and a
production Vite build. There is no hosted CI in this repository yet; run the same commands
locally (or in a future workflow) before merging.


### External blockset building and settings

Settings is organized into Character, Graphics, Sound, and API tabs. Character previews
its current skin with drag-to-rotate controls, retaining the setup guide when no skin
is available. The API tab shows live credit balance, pricing, account/world allowances,
and key management. Building and creation are free within quotas. Hosting controls are
enabled by `SPACE_HOSTING_UI_ENABLED = true` in `src/bootstrap/SpaceFeatures.ts`.
The backend still defaults to `SPACE_HOSTING_ENABLED=false`: new hosting purchases are
rejected, workers cannot run or bill, and hosting pricing/allowances are omitted.
The menu shows an English availability error rather than hiding the control; early
Stop remains available even when hosting or the account RPC is down. Ordinary browser
execution and its API-key run permission are unchanged.

Keys with `space:blockset:build` can call
`POST /space/api/v2/worlds/{world_id}/blocksets/build` to stamp a portable blockset at a
specified grid origin without an online browser. Builds support quarter-turn rotation,
standard and micro voxels, atomic quota enforcement, and bounded idempotent retries.
See [blockset API and live allowances](../../entropydrop_backend/docs/space-blockset-build-api.md).

### 8×8×8 micro grid and P0 physics

The construction grid is now 0.125 m (512 microcells per standard block).
Editing, selection, previews, model import, wire formats, backend builds and far
surfaces share this scale. Microterrain uses merged collision caches; sleeping
entities watch local terrain and keep running their scripts. See
[implementation and validation](docs/micro-grid-p0.md).
