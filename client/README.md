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
With a child targeted by the Wrench, Delete asks whether to remove that component
and its descendants or the entire entity. The menu captures the component before
unlocking; child deletion stops execution when needed and saves the remaining tree.
Right-clicking a running entity with any tool opens the same entity action menu
as Wrench. Stopped entities retain each tool's usual right-click behavior.
Menu actions retain text rows with leading icons and shortened captions, descriptive
hover titles and accessible labels. Nameplate playback uses filled green play/red
stop icons matching the code editor to the right of the entity name.
The browser executor name appears as a smaller second line below the entity name;
the playback icon remains on the right and hosting retains its purple badge.
The delete confirmation retains its explicit irreversible-action warning.
Nameplates share the world render pass's bent camera and interpolated root pivot.
They sit vertically above that pivot by half the entity's precomputed authored
height; runtime rotation and child-component motion do not recalculate the offset.
Selection bounding boxes respond to scene lighting, cast and receive shadows,
and show occluded edges at 30% of the visible opacity. This applies to both live
previews and confirmed selections.
Component outlines alternate white and black across all 16 hierarchy levels:
odd-numbered levels are white, even-numbered levels are black, starting with a
white root. Changing focus preserves descendant colors; preview, focus and
confirmed-selection boxes use the same color for a component.
Box-selecting a focused micro voxel automatically enables MICRO mode on terrain
or an editable Entity. If point A is already set, it is preserved and converted
to the micro grid before confirming point B; the toolbar mode updates immediately.

Selector (`1`) shows white straight links from the focused component's direct
children to its pivot. Its link to the immediate parent uses the same animated
yellow wave as a selected decoration. Wrench (`3`) uses this wave for all displayed
parent and child links. Grandparents and grandchildren are not included.

During Hammer (`2`) component installation, the pending preview shows an animated
yellow wave from the future component pivot to its parent pivot. It follows XYZ
adjustments and the parent's rendered pose, and clears on confirmation or cancellation.

Modeling (`7`) edits visual decoration cubes owned by an entity component.
Focusing an entity shows white links from all its decorations to their owning
component pivots. Selecting a decoration highlights its link with a yellow wave.
Aim and left-click a decoration to select it while keeping pointer lock. Hold
LMB on the decoration to move it in the camera plane, or aim at and drag its
local X/Y/Z arrows, curved arrows, or outer cubes to move, rotate, or resize.
The view stays fixed during a drag and resumes mouse look on release. A right
click adds a 0.5 × 0.5 × 0.5 m cube on release initially. Successful decoration
edits remember that decoration's dimensions in browser localStorage; subsequent
placements reuse them, including the thickness when drawing. Holding RMB and
dragging draws a custom footprint from the initial surface point, with the wheel
adjusting thickness.
There is no idle placement ghost; a translucent preview appears only during
RMB drawing. Release RMB to create once. Hold Shift for 0.125 m / 15° snapping.
The right panel always shows exact component-local position, Euler rotation
(degrees), and dimensions (meters). Esc releases the cursor while retaining the
selection; during a drag it first cancels that preview. Press Esc again to resume
game controls. Press I or click the toolbar color chip to open the shared palette
editor; color and material changes apply to the editable selected decoration and
set the appearance for new decorations. Copy (R), Delete (Del), Undo, and Redo are
in the toolbar. Each
completed drag saves one edit and creates one undo step; previews do not mutate
authored data or physics.

Wrench (`3`) shares Modeling's colored XYZ arrows, curved rotation arrows, and
camera-distance scaling so both tools have matching stroke widths,
with scaling disabled. Targeting a child component places the handles at its
authored pivot; moving or rotating it affects that component and its descendants,
preserving the parent and siblings. Completed edits retain their placement after
Stop and hierarchy rebuilds. Root handles move or rotate the whole entity around
the root body's center of mass. Holding any component lifts the entire entity;
independently dynamic children follow the root while held, and all authored body
types are restored on release. The current handles stay visible while aiming
between the body and an arrow, until another component is targeted or it is out of range.
While held, the entity follows the character's body rotation, preserving its
initial relative orientation and compensating motion around the grabbed point.
Camera pitch and perspective changes do not change that relative orientation.
Double-click any component with the Wrench to start or stop its entire entity.
Long holds, mouse movement during a grab, and gizmo drags do not count as double-clicks.

Driver seats with `fixedOrientation:true` keep the rider's body aligned to the
seat's solved world rotation, including articulated components. Camera mouse
look stays free in all three perspectives. Mounting, dismounting and runtime
`self.setSeats` changes preserve the camera's yaw and pitch. A mounted avatar
uses a stable sitting pose. `seats[].position` is the character/physics anchor,
not the cushion top: for an upright seat and the standard 1.8 m avatar, put it
0.567 m below the cushion. The head and eye are respectively 1.233 m and
1.053 m above the cushion, and the pose needs about 0.33 m behind and 0.59 m
forward (local `-Z`) from the anchor. Use a seat `rotation` with
`fixedOrientation:true` when that clearance must follow the vehicle.
Perspective changes ease over 280 ms: first/third-person switches zoom relative
to the current eye position, and rear/front third-person switches orbit around
the rider instead of cutting through the body. Interrupted switches continue
from the displayed pose. Mouse look and player/seat movement remain immediate;
saved perspective settings restore without an initial animation.
Both character perspectives and all held tools are compiled during entry so
the first F3 does not discover hidden skin/tool pipelines. Holding F3 cycles once.

Third-person distance adapts to the character and mounted vehicle. The combined
world bounding box of the rider, vehicle components and decorations stays fully
inside the viewport, with 10% padding on each edge. Framing accounts for width,
height and depth, and is recalculated for free look, FOV, viewport shape and
animated parts.
The camera pulls back immediately when more clearance is needed and eases inward
when the subject gets smaller or the player dismounts. While pointer-locked,
**Scroll** zooms in/out in both third-person views; **Shift+Scroll** keeps the
active tool's wheel action. Vehicle zoom stops at the automatic framing limit
and is separate from the saved 1.5–12 m walking distance. First-person wheel
bindings remain the same.

Press **Space** to jump, then release and press it again in midair to dash along
the crosshair's full 3D direction: look up to climb or down to dive. A quick tap
locks that direction for a 5 m active dash, easing in and out over 0.4 seconds. Keep the
second press held to sustain peak speed and smoothly steer with the crosshair.
Releasing Space finishes the eased deceleration; a sustained dash settles over
0.2 seconds. A clear exit retains at least 6 m/s along the final dash direction;
normal air control and gravity then reduce that momentum, adding a short coast.
Movement keys can brake or redirect it. The dash pauses gravity and stops at walls, ceilings and floors.
It becomes available again on landing, and gravity resumes after it finishes.
Holding the first jump does not trigger a dash or repeat jumps. In flight mode,
Space still ascends continuously.
The dash leans the torso, tucks the legs and lets the arms trail, with a smooth
return to the airborne pose. The first-person hand/tool retracts slightly and
the FOV opens by up to 4.5 degrees without rotating the aim. Render frames sample
the dash curve between simulation ticks; exit velocity carries through the end
instead of braking to zero, including when no movement key is held.

## Documentation map

| Document | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Three-repository split, module map and runtime data flow. |
| [docs/networking.md](docs/networking.md) | REST boundaries, credentials and the `space-relay-v1` MessagePack schema. |
| [docs/formats.md](docs/formats.md) | Unified Items, inventory v8, backpack v10, API envelopes v2, surface snapshots and the world-edit outbox. |
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
`space.backpack.v10.pb` and is never uploaded by this app. The explicit v8/v9 reader
migrates old slots and selection while retaining the original stored bytes.
Unsupported backpack versions are rejected. Player-authored standard
and micro-voxel terrain overlays are loaded from the authenticated spaceAPI and
sent back in idempotent batches of at most 256 mutations. A durable browser
outbox under `space.world-edits.v3.*` preserves unacknowledged batches across a
refresh; obsolete `space.world-edits.v1.*`/`v2` local-only overlays are ignored
rather than migrated, so only v3 edits are uploaded.

The entry gate waits for the complete near AOI and all 128 distant zone
snapshots before exposing Play. It also finishes the initial view's refinement,
mesh publication, terrain fades and GPU uploads at the saved graphics settings.
Loading progress reports distant zones as they arrive. Missing server-generated
zones keep the gate open; download or rendering failures show the entry error
instead of starting gameplay with incomplete terrain. Later world revisions
continue refreshing in the background after entry.

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
Settings → Graphics → Performance → Render Resolution offers 1× (default),
0.5× and 0.25× drawing-buffer width and height. Changes apply immediately and
persist locally; interface size stays unchanged. Legacy Auto preferences use 1×,
and older fixed preferences use the nearest available scale. Settings →
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
Settings → Graphics → Distant Terrain LOD also has a **Distant Terrain & LOD**
master switch, enabled by default and saved locally. It disables the far terrain,
authored distant structures and their LOD work together, preserving nearby terrain.
Frame rate does not change this switch. The preference survives reloads;
use Enabled or Reset Recommended to restore distant terrain when it is off.
While off, initial distant preparation and subsequent snapshot polls are skipped.
Recommended defaults keep every tier enabled, cover the full world, use
400/600/800/1000/1600m transitions, and connect through 4000m.

An AI-native programmable voxel physics prototype:

> Build anything. Tell it what to do.

Settings → Graphics → Performance → **Terrain Shape** selects **Ring** (default)
or **Flat**. Both use the same terrain, materials, resolution and distance
preferences. Flat displays the finite world in its original X/Z coordinates;
physics, storage and coordinate wrapping remain unchanged. Camera transforms,
picking, normals and near/far culling follow the selected projection.

The selected terrain shape is saved locally and restored on reload. Frame rate
does not change the terrain shape.

Settings → Graphics → Camera & View includes an experimental **Chain-Linked
Worlds** checkbox, off by default and saved locally. The current world stays live
as the fixed middle link of a three-ring chain. Two other worlds (preferring
Nature, Copper Metropolis and Aether Archipelago) are loaded once from
authenticated distant terrain snapshots, at the same size as the live world.
This linked-ring composition is hidden in Flat mode; its snapshots and preference
are retained for returning to Ring.
The live ring lies in XZ; the two snapshot rings lie in XY, centered at x=-4R/3
and x=+4R/3. Each end ring links the middle once. The two ends are separate and
do not link each other. There are no connecting shafts or bearings.

The left and right snapshot rings rotate in opposite directions around their
own normals, once every 12 and 18 minutes respectively. Their centers and planes
stay fixed, preserving the chain links and terrain-envelope clearance. Only
render transforms animate; geometry and snapshot data stay frozen. Rotation
uses the bounded display-frame delta, pauses during loading, and resets on
disable. The live world's coordinates, rendering and physics are unchanged.

Additional worlds are display-only, with no editing, picking, collisions,
entities, player presence or realtime connections. Snapshot access uses the
existing membership join endpoint when necessary, without admission,
player-position writes or simulation. Both complete snapshots must load before
either is displayed. Errors leave the live world usable and offer Retry;
unchecking cancels downloads and releases geometry and materials. Re-enabling
loads fresh snapshots. This view adds rendering/memory cost and starts only
after the primary world's entry gate completes.

For equal-radius circles in this orthogonal chain, let d be the adjacent center
offset, with R < d < 2R. Adjacent centerline clearance is 2R-d, while the two ends
have clearance 2d-2R. Balancing these at d=4R/3 maximizes the minimum within this
layout family, giving every pair centerline clearance 2R/3. With
R=16384/(2*pi) and tube radius r=2048/(2*pi), the reference-surface gap is
2R/3-2r = 1086.5 m. The complete 0..256 m terrain height range fits inside a tube
of radius r+(256-16)*(1+r/R) = 595.95 m, giving a conservative terrain-envelope
gap of 546.5 m throughout rotation. Settings show both values. The bound excludes
entities and camera-local rendering correction and is not an exact live terrain
mesh distance. Run `node client/tools/linked-world-clearance.ts` from the
workspace root to verify every pair numerically at multiple rotation phases.

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

The backpack has one **Items** collection for static blocks, entities, and mixed
creations, with 198 slots, one selection, and one nine-slot hotbar. An Item contains
an optional BlockSet and zero or more complete Entity trees; the content must
include at least one voxel. Color Sets remain a separate collection of 99 slots.
The Market's Items listing also includes existing BlockSet and Entity resources.
Users select and build an Item without choosing its internal resource kind.
Market previews and downloads resolve standalone `/space/objects/space-market/resources/`
files against the configured Space API origin, including local port forwards.
External CDN URLs retain their origin; all resources still pass canonical encoding,
display-name, and semantic SHA-256 checks before use.

1. Choose any color, then use the shovel for standard construction or the spoon
   for micro-voxel sculpting.
2. Use the Selector to confirm both selection corners A and B.
3. Press `G` to **Assemble** the selected terrain blocks into a contraption
   (a programmable entity).
4. Aim at the entity and press `C`.
5. Describe the behavior, inspect the generated controller, and run it.

An Item containing one Entity and no static blocks can also be reused as a module
with the Hammer: left-clicking terrain spawns an independent entity and puts it in **Play** (physics
active and all runnable component scripts enabled). Placing on a stopped entity
installs the item as a rigid child component under the crosshair; `Shift` + left-click
requests this installation mode explicitly, and the combined entity stays stopped.
Successful Hammer construction automatically switches to the Wrench; large items
switch after their frame-sliced construction finishes.
Hammer hides the black target-cell wireframe and keeps its placement ghost.
Hammer construction, rotation and slot cycling always use the Item hotbar.
Browsing Color Sets does not change what Hammer builds; apply a palette by
clicking its Color Set card in the backpack.
With Hammer selected, press `T` to open the text creation side panel at the focused surface.
Edit multiline text (including Chinese), font size (8–128 cells), color, material and
voxel size (micro or standard) while the voxel preview updates. Drag the colored
X/Y/Z arrows or edit the position offsets to move the preview in 0.125 m steps,
using the focused component's local axes when building on an entity. Edits keep
the current offset. Standard text at fractional positions is subdivided into
micro voxels without changing its shape, subject to the voxel limit. Choose
Vertical to stand the text upright or Horizontal to lay it flat, keeping it
outside the focused surface in both cases. Text defaults to Vertical, size 12,
and Micro. Create
builds those exact voxels into terrain or the focused stopped component;
occupied cells are skipped. Cancel or `Esc` discards the preview. Text is one
cell thick and shares the 65,536-voxel and 256 m size limits. Default, Emissive
and Transparent (0–100% transparency) materials apply to both the preview and
created terrain/component voxels. Arrow keys still
rotate inventory items. Running entities keep their right-click action menu.
Press `Tab` (or click the mode badge) to switch positioning between **STANDARD**
(1 m, the default) and **MICRO** (0.125 m). The ghost and construction share the
same snapped origin; installation uses the target component's local grid.
In MICRO mode, every standard voxel in the Item is subdivided into 8 × 8 × 8
micro voxels while preserving its size, colors, materials and Entity structure.
Preview and construction use this temporary converted copy; the backpack Item
stays unchanged, and STANDARD mode uses its original voxels. Conversion respects
the existing 65,536-voxel Item limit and refuses oversized results before building.
Mixed Items or Items with multiple Entities place static geometry as terrain and
each Entity as an independent running body, preserving their shared frame. They
cannot be installed as one child component.

For world selections, **Copy (R)** saves the orange selected terrain voxels and all
complete entities fully contained by the cyan outer box as one Item. Their relative
positions and orientations are preserved, including world constraint anchors. Entity
positions may fall between construction-grid cells and keep their original offsets. Entities
crossing the box boundary are excluded. A region containing only entities can also be
copied. Component-local Copy keeps its existing component behavior; `T` still copies
only selected voxel geometry. Copy leaves the source terrain and entities unchanged.

Selector delete, copy, fill, recolor, assembly, and rotation
require confirmed A/B; an A-only, component preselection, or Shift-picked selection
is not sufficient.
The `G` action is **Assemble** for terrain selections and **Assemble Sub-Contraption**
for entity component selections. A sub-contraption is a child component built from
the selected blocks.
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

Detailed component script and controller API documentation is available directly in-game via the Code Editor terminal (press `C` → entityAPI Docs) and in the generated [entityAPI V3 AssemblyScript reference](../engine/docs/generated/api-v2.md). The [entityAPI code-generation reference](../engine/docs/generated/agent-api-v2.md), in-game reference, and runtime Agent prompt are all rendered from `entropydrop_space/engine/src/contraption/ScriptApiContract.ts`; edit that contract instead of these generated views.

Component code is an AssemblyScript controller body with implicit `self` and `ctx`.
For single-axis motors, `self.setSpinXAxisRPM(rpm)`,
`self.setSpinYAxisRPM(rpm)` and `self.setSpinZAxisRPM(rpm)` select the
local rotation axis and take revolutions per minute directly. They retain the
kinematic-only behavior of `self.setLocalSpin(axis, rpm)`; the last spin command
in a tick wins.
Empty components show editor guidance as placeholder text; it is never stored
or compiled as script source. Exact legacy generated help templates become
empty drafts; existing player code and comments are preserved.
The editor suggests members after `self.`, `ctx.` and nested API objects, with
typed signatures and descriptions from the compiler SDK and API contract.
It also completes Math/Mathf, keywords and local variables (including component
and Value handles). Use Ctrl+Space to request suggestions, Up/Down to choose,
Tab or Enter to insert, and Escape to dismiss them before closing the editor.
Method completion inserts parentheses and positions the caret for arguments.
Suggestions run locally and do not compile or start the entity.
Editing, switching components, closing the editor, and applying Agent code only save
the source. Start compiles the latest changed component code in a browser worker;
the editor shows compilation progress and type errors. Unchanged code reuses its
compiled program. `SpaceUiStore` exposes this client's visible output from nearby
loaded entities through `entityOutput`: console lines, send/receive messages,
warnings, errors, and system events. The buffer retains up to 500 entries for a
custom UI; `filterEntityOutput` filters by source entity, output category, or message
type (such as `chat`), and `clearEntityOutput()` clears the collected view.
Remote output that this client never receives is not included.
State uses typed getters/setters such as `self.state.getNumber("ticks")` and
`self.state.setNumber("ticks", value)`. Read record fields through the `Value` SDK.
Only the AssemblyScript standard library is exposed; the former JavaScript guest
packages and helper namespaces are removed. Historical scripts without the
`assemblyscript` language marker load as empty code and are not translated.


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

Inventory Protobuf v8 stores display names on every `Component`, with no `Entity.name`.
An entity's display name is `root.name`; empty names display the component ID. Names may
repeat and survive subtree copies, attachment, independent publication, and reloads.
Only IDs determine references and sibling ordering. An Item has its own template `id`
and display `name`; each enclosed Entity retains its component tree and id namespace.
Market content digests omit Item template ids and all display names. Browser backpacks
use Protobuf v10 with explicit v8/v9 migration; unsupported versions and legacy offline
world entities retain their separate rejection/purge rules.
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
Item and Color Set backpack collections in browser IndexedDB with automatic
localStorage and supported v8/v9 migration.

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
