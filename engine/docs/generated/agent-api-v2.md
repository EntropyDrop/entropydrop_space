# entityAPI V3 — Code generation reference

<!-- GENERATED from src/contraption/ScriptApiContract.ts. Do not edit by hand. -->

## Canonical entityAPI V3 contract

[spaceAPI](<../spaceAPI.md>) · [entityAPI](<api-v2.md>)

entityAPI is called by entity component code through `self` and `ctx` inside the runtime. spaceAPI is the authenticated HTTP API used by agents and clients to query or change Space. Agents may generate entityAPI code; the entity runtime executes it.

Use the entityAPI below when generating entity code. API facts come from the same contract as the in-game reference.
### AssemblyScript language and available libraries

- Write an AssemblyScript controller BODY. The compiler supplies `self: Component` and `ctx: Context`; do not add imports, exports, or a tick wrapper. Source is compiled to native WebAssembly when saved. Compilation is asynchronous; the browser uses a separate compiler worker.
- Use explicit numeric types (`f64`, `i32`, `u32`), `bool`, `string`, and `f64[]` vectors. AssemblyScript resembles TypeScript but does not implement JavaScript dynamic objects, undefined, eval, or npm module loading.
- Available standard library: Math/Mathf, typed arrays, Array<T>, StaticArray<T>, Map<K,V>, Set<T>, and strings. The pinned AssemblyScript compiler is 0.28.20. No third-party guest packages are currently exposed. The former gl-matrix, simplex-noise, seedrandom, tween.js, robot3, culori and ngraph namespaces, and ctx.math/spatial/random/noise/ease/control/timer helpers, have been removed.
- Math.random() uses a deterministic seed derived from entity ID, component ID and tick. The sequence restarts from that seed each invocation; store custom PRNG state explicitly when you need another sequence.
- Persistent state uses `self.state.getNumber/setNumber`, `getString/setString`, `getBoolean/setBoolean`, `get/set` and `setVector`. Getter defaults are 0, empty string and false; an optional fallback may be supplied. Do not write `self.state.foo`. Only state survives ticks; WASM instances and local variables are recreated each tick.
- Records, options, snapshots, command results, contacts and messages use `Value`. Construct with `Value.object()` / `Value.array()`, set typed fields, and read with typed getters. Use `.at(i)` for array items, `.length`, `.isNull`, and `.asVector()`. A missing record is a Value with isNull=true, not a JavaScript null. child(id) is the exception: it returns Component | null.
- Returned snapshots are read-only. Assigning one into state copies its JSON-compatible data. Prototype access, host globals, browser APIs, Node, filesystem and network are unavailable. Prefer local typed arrays for computation; each SDK access crosses the WASM/host boundary.
- New portable components store `scriptLanguage: "assemblyscript"`; flat runtime script entries store `language: "assemblyscript"`. Loading/importing/saving unmarked or differently marked legacy scripts replaces their code with an empty string. No historical source translation is performed.

### Portable Items and runtime Entity scope

- Backpack and Market share a portable Item template: `id`, `name`, an optional BlockSet, and an Entity list. The wrapper reuses complete Entity component trees, physics defaults, scripts, seats and constraints.
- Independent Item placement stamps BlockSet voxels into world terrain and creates each Entity tree as a separate runtime Entity in one shared construction frame. Static BlockSet voxels have no component scripts or Entity start/stop lifecycle.
- `ctx.entityId` identifies the current runtime Entity, not the Item template id. `ctx.root` and `self` belong to that Entity; component ids and `self.child(id)` lookups are scoped to its component tree. Separate Entity entries may reuse component ids.
- An Item containing one Entity and no static blocks can instead be installed as a component of a stopped target Entity. Its component ids are remapped into the target tree; scripts then run in the target Entity context. Mixed or multiple-Entity Items cannot be installed as one component.
- Item integration does not add a runtime Item object, backpack access, or Item-wide start/stop to entityAPI V3. Use the existing component, world voxel, nearby Entity and messaging APIs for runtime behavior. spaceAPI world creation still accepts standalone Entity or BlockSet resources, rather than an Item wrapper.

### Defaults and coordinate conventions

- Coordinates are right-handed and Y-up: +X right, +Y up, -Z forward. Euler angles use YXZ order; quaternions are `[x,y,z,w]`.
- A component pivot starts at its own block AABB centroid and never moves automatically after block edits. Use `getBounds()` then `setPivot(bounds.get('center').asVector())` to recenter a kinematic body without moving its blocks.
- Component IDs are unique across the entire entity; no string is reserved. The root is identified structurally by `parentId` equal to the empty string in the typed SDK, and a child's local position is its pivot offset in the parent pivot frame.
- Entities have only running and stopped states. Start enables entity physics and all component scripts. Stop disables physics and scripts, clears state/time/tick/motion, resets child transforms, and restores persisted BodyConfig defaults. Individual component code switches do not create a third entity state.
- BodyConfig defaults are type, mass, restitution, friction, gravity, and collision. Script setters are runtime-only; serialization always writes defaults.
- Collision defaults to enabled. A disabled component remains rendered/editable but has no terrain, player, entity, or raycast shapes.

### World topology

- The world is a torus: X is `[0,16384)` and Z is `[0,2048)` for world voxel operations and raycasts. Y does not wrap; voxel edits require Y in `[0,256)`.
- `ctx.position` is continuous and does not wrap. Follow/orbit/seek logic must use shortest wrapped X/Z deltas.
- An entity whose root falls below `y = -30` is removed with its scripts and state.

### Execution model

- Every component script receives `(self, ctx)` once per fixed 20 Hz entity tick. `self` is the target component; root body fields in `ctx` always describe the root entity.
- The root script runs before child scripts. All components share one frozen frame-start `ctx` snapshot; admitted commands commit after the synchronous AssemblyScript/WASM tick.
- Entity messages arrive only while this entity is active and connected. The root script reads `ctx.messages.received`; each submitted frame consumes at most 8 messages and 16 KiB, leaving the rest in the bounded runtime inbox. Messages are ephemeral and are not queued by the service while the target is inactive or disconnected.
- Send with `ctx.messages.send(targetId, type, payload)` for UTF-8 or `sendBytes(targetId, type, Uint8Array)` for Protobuf; UTF-8 is the default, `chat` requires UTF-8, and Protobuf types must include a positive version suffix such as `radar.v1`. The runtime authenticates and de-duplicates the send outside AssemblyScript/WASM. Check `ctx.commands.result(commandId)` on a later frame for `deliveryStatus` and any rejection reason.
- Each component owns `self.state`. Completed state survives chunk streaming and disabling component code; Stop clears it.
- Queued mutation success means command-buffer admission (`reason:'queued'`), not final commit. Successful admission includes `commandId`; the main thread revalidates bounds, occupancy, and permissions and publishes the final result through `ctx.commands` on the next submitted frame.
- Limits: 4 MiB aggregate WASM linear-memory quota, 16 KiB stack per invocation, 1 MiB serialized state, 1 MiB host-bridge allocations per tick, 64 components per entity, 256 commands, 256 world voxel reads, and 64 raycasts per tick, 50 ms per component invocation, 250 ms aggregate entity time, and 100,000 metered WASM function/loop entries per entity tick.
- Any component runtime exception or time/fuel/memory budget failure triggers global Stop: entity physics and every component script stop, state/time/motion and runtime BodyConfig changes reset, and commands from the interrupted tick are discarded. The error remains available for diagnosis.
- Entities only exist and run while their wrapped root chunk is active; streaming serializes identity, hierarchy, physics, scripts, defaults, and completed state.

### ctx — read-only frame snapshot

- `ctx.apiVersion` — Current entityAPI version: `3`.
- `ctx.entityId` — Stable random ID of the current entity.
- `ctx.root` — Root component and entry point for recursive tree traversal.
- `ctx.time` — Seconds with at least one component script enabled; disabled code does not advance it and Stop resets it.
- `ctx.deltaTime` — Fixed entity simulation step: always `0.05` seconds (20 Hz); scripts cannot change it.
- `ctx.tick` — Executed script-frame count; disabled code does not advance it and Stop resets it.
- `ctx.position` — Root entity world position. It is continuous and does not wrap at the torus seam.
- `ctx.velocity` — Root world-space velocity in m/s.
- `ctx.rotation` — Root Euler angles in radians using YXZ order.
- `ctx.angularVelocity` — Root angular velocity in rad/s.
- `ctx.groundDistance` — Distance in metres to the ground below.
- `ctx.isOnGround` — Whether the root dynamic body was supported during the latest completed physics frame.
- `ctx.mass` — Root entity mass in kg.
- `ctx.bodyType` — Root body type: `'kinematic'` or `'dynamic'`.
- `ctx.gravity` — Current gravity vector; default `[0,-18,0]`.
- `ctx.limits` — `{maxForce,maxTorque}` for the legacy root-body force surface only.
- `ctx.input` — Keyboard edge/held-state API described below.
- `ctx.blocks` — Block-edit snapshot: `pressed(type?)` and `event()`; types are `'place'|'remove'|'color'|'subdivide'`.
- `ctx.players` — Frozen player observations. `position` remains the eye-position compatibility alias; records also expose `eyePosition`, nullable `feetPosition`/`velocity`/pose and movement flags, riding IDs, `isLocal`, and fixed 50 kg mass.
- `ctx.driver` — Current local driver for this entity as `{playerId,componentId,seatIndex}`, or `null` when it is not mounted.
- `ctx.contacts` — Up to 32 frozen contacts observed since the previous submitted script frame. Kinds are `terrain|entity|player`; records include component IDs, point, normal, relative velocity, penetration, and impulse when available. Player contacts are one-way observations with zero impulse and never modify entity dynamics. Resting support contacts retained during physics sleep have `sleeping: true` and zero impulse/relative velocity.
- `ctx.messages.received / ctx.messages.send(targetId,type,payload) / ctx.messages.sendBytes(targetId,type,bytes)` — The root component reads a frozen inbound batch from `received`; child batches are empty. Records are `{messageId,sourceId,targetId,type,encoding,payload}`. UTF-8 payloads are strings and Protobuf payloads are frozen byte-number arrays. `send` defaults to UTF-8 and returns `{ok,queued,reason,commandId}`; use `ctx.commands.result(commandId)` later for `deliveryStatus` (`routed` or `dropped`). Payloads are limited to 4 KiB, types to 16 ASCII bytes, Protobuf types require a version suffix such as `radar.v1`, and the backend enforces 20 sends per second per source entity.
- `ctx.world` — World query and mutation API described below.
- `ctx.selection` — Shared engine selection command API described below.
- `ctx.commands` — Final main-thread command results from the previous submitted frame: `result(commandId)` and `all()`.
- `ctx.log(msg)` — Append one line to the component console.

### Complete typed SDK signatures

Signatures below are generated from the compiler SDK. Component, Context, Value and the other named classes are available without imports. Generic Value.call(name,args) invokes only registered own host API methods; use Value.array() for its argument list.

#### Value

- `get apiVersion(): i32` — Callable SDK signature.
- `static object(): Value` — Callable SDK signature.
- `static array(): Value` — Callable SDK signature.
- `static number(n: f64): Value` — Callable SDK signature.
- `static string(s: string): Value` — Callable SDK signature.
- `static boolean(b: bool): Value` — Callable SDK signature.
- `static vector(v: f64[]): Value` — Callable SDK signature.
- `get isNull(): bool` — Callable SDK signature.
- `get length(): i32` — Callable SDK signature.
- `get(key: string): Value` — Callable SDK signature.
- `at(index: i32): Value` — Callable SDK signature.
- `asNumber(): f64` — Callable SDK signature.
- `asBoolean(): bool` — Callable SDK signature.
- `asString(): string` — Callable SDK signature.
- `asVector(): f64[]` — Callable SDK signature.
- `getNumber(key: string, fallback: f64 = 0): f64` — Callable SDK signature.
- `getString(key: string, fallback: string = ""): string` — Callable SDK signature.
- `getBoolean(key: string, fallback: bool = false): bool` — Callable SDK signature.
- `set(key: string, value: Value): Value` — Callable SDK signature.
- `setNumber(key: string, n: f64): Value` — Callable SDK signature.
- `setString(key: string, s: string): Value` — Callable SDK signature.
- `setBoolean(key: string, b: bool): Value` — Callable SDK signature.
- `setVector(key: string, v: f64[]): Value` — Callable SDK signature.
- `push(value: Value): Value` — Callable SDK signature.
- `call(name: string, args: Value = Value.array()): Value` — Callable SDK signature.
#### State

Extends Value; inherited typed data accessors are available.
#### Input

Extends Value; inherited typed data accessors are available.

- `down(key: string): bool` — Callable SDK signature.
- `pressed(key: string): bool` — Callable SDK signature.
- `released(key: string): bool` — Callable SDK signature.
#### Body

Extends Value; inherited typed data accessors are available.

- `getType(): string` — Callable SDK signature.
- `setType(type: string): Value` — Callable SDK signature.
- `getMass(): f64` — Callable SDK signature.
- `setMass(mass: f64): Value` — Callable SDK signature.
- `getMaterial(): Value` — Callable SDK signature.
- `setMaterial(material: Value): Value` — Callable SDK signature.
- `getGravityEnabled(): bool` — Callable SDK signature.
- `setGravityEnabled(enabled: bool): Value` — Callable SDK signature.
- `getCollisionEnabled(): bool` — Callable SDK signature.
- `setCollisionEnabled(enabled: bool): Value` — Callable SDK signature.
- `getVelocity(): f64[]` — Callable SDK signature.
- `getAngularVelocity(): f64[]` — Callable SDK signature.
- `applyForce(v: f64[]): bool` — Callable SDK signature.
- `applyLocalForce(v: f64[]): bool` — Callable SDK signature.
- `applyTorque(v: f64[]): bool` — Callable SDK signature.
#### Api

- `get apiVersion(): i32` — Callable SDK signature.
- `call(name: string, args: Value = Value.array()): Value` — Callable SDK signature.
#### Voxels

Extends Api; inherited typed data accessors are available.

- `get(p: f64[]): Value` — Callable SDK signature.
- `set(p: f64[], options: Value = Value.object()): Value` — Callable SDK signature.
- `clear(p: f64[]): Value` — Callable SDK signature.
- `paint(p: f64[], options: Value = Value.object()): Value` — Callable SDK signature.
- `clearCell(p: f64[]): Value` — Callable SDK signature.
- `subdivide(p: f64[], offset: f64[] | null = null): Value` — Callable SDK signature.
#### MicroVoxels

Extends Api; inherited typed data accessors are available.

- `get(p: f64[], offset: f64[]): Value` — Callable SDK signature.
- `set(p: f64[], offset: f64[], options: Value = Value.object()): Value` — Callable SDK signature.
- `clear(p: f64[], offset: f64[]): Value` — Callable SDK signature.
- `paint(p: f64[], offset: f64[], options: Value = Value.object()): Value` — Callable SDK signature.
#### Constraints

Extends Value; inherited typed data accessors are available.

- `all(): Value` — Callable SDK signature.
- `create(options: Value): Value` — Callable SDK signature.
- `remove(id: string): bool` — Callable SDK signature.
#### Decorations

Extends Value; inherited typed data accessors are available.

- `all(): Value` — Callable SDK signature.
- `get(id: string): Value` — Callable SDK signature.
- `upsert(id: string, patch: Value): Value` — Callable SDK signature.
- `remove(id: string): Value` — Callable SDK signature.
#### Component

Extends Value; inherited typed data accessors are available.

- `get id(): string` — Callable SDK signature.
- `get parentId(): string` — Callable SDK signature.
- `get state(): State` — Callable SDK signature.
- `get body(): Body` — Callable SDK signature.
- `get constraints(): Constraints` — Callable SDK signature.
- `get decorations(): Decorations` — Callable SDK signature.
- `get voxels(): Voxels` — Callable SDK signature.
- `get microVoxels(): MicroVoxels` — Callable SDK signature.
- `child(id: string): Component | null` — Callable SDK signature.
- `children(): Component[]` — Callable SDK signature.
- `stop(): void` — Callable SDK signature.
- `getBounds(): Value` — Callable SDK signature.
- `setSeats(seats: Value): void` — Callable SDK signature.
- `getSeats(): Value` — Callable SDK signature.
- `setLocalSpin(axis: f64[], rpm: f64): void` — Callable SDK signature.
- `applyForceAt(force: f64[], point: f64[]): void` — Callable SDK signature.
- `localToWorldDirection(v: f64[]): f64[]` — Callable SDK signature.
- `getWorldPosition(): f64[]` — Callable SDK signature.
- `getWorldRotation(): f64[]` — Callable SDK signature.
- `getPivot(): f64[]` — Callable SDK signature.
- `getLocalPosition(): f64[]` — Callable SDK signature.
- `getLocalRotation(): f64[]` — Callable SDK signature.
- `applyThrust(v: f64[]): void` — Callable SDK signature.
- `applyLocalThrust(v: f64[]): void` — Callable SDK signature.
- `applyForce(v: f64[]): void` — Callable SDK signature.
- `applyLocalForce(v: f64[]): void` — Callable SDK signature.
- `applyTorque(v: f64[]): void` — Callable SDK signature.
- `setLocalPosition(v: f64[]): void` — Callable SDK signature.
- `setLocalRotation(v: f64[]): void` — Callable SDK signature.
- `setLocalEuler(v: f64[]): void` — Callable SDK signature.
- `setPivot(v: f64[]): void` — Callable SDK signature.
#### World

Extends Value; inherited typed data accessors are available.

- `getInfo(): Value` — Callable SDK signature.
- `get voxels(): Voxels` — Callable SDK signature.
- `get microVoxels(): MicroVoxels` — Callable SDK signature.
- `entities(origin: f64[], radius: f64 = 16): Value` — Callable SDK signature.
- `entity(id: string): Value` — Callable SDK signature.
- `entitiesInChunk(id: string): Value` — Callable SDK signature.
- `raycast(origin: f64[], direction: f64[], maxDistance: f64 = 24): Value` — Callable SDK signature.
- `raycastWithOptions(origin: f64[], direction: f64[], options: Value): Value` — Callable SDK signature.
#### Messages

Extends Value; inherited typed data accessors are available.

- `get received(): Value` — Callable SDK signature.
- `send(target: string, type: string, payload: string): Value` — Callable SDK signature.
- `sendBytes(target: string, type: string, payload: Uint8Array): Value` — Callable SDK signature.
#### CommandResults

Extends Value; inherited typed data accessors are available.

- `result(id: string): Value` — Callable SDK signature.
- `all(): Value` — Callable SDK signature.
#### Blocks

Extends Value; inherited typed data accessors are available.

- `pressed(type: string = ""): bool` — Callable SDK signature.
- `event(): Value` — Callable SDK signature.
#### Selection

Extends Value; inherited typed data accessors are available.

- `snapshot(): Value` — Callable SDK signature.
- `clear(): Value` — Callable SDK signature.
- `cornerA(p: f64[], options: Value = Value.object()): Value` — Callable SDK signature.
- `cornerB(p: f64[], options: Value = Value.object()): Value` — Callable SDK signature.
- `box(a: f64[], b: f64[], options: Value = Value.object()): Value` — Callable SDK signature.
- `cells(cells: Value): Value` — Callable SDK signature.
- `toggle(p: f64[]): Value` — Callable SDK signature.
- `entity(id: string, node: string = ""): Value` — Callable SDK signature.
- `entityBox(id: string, node: string, a: f64[], b: f64[], space: string = "local"): Value` — Callable SDK signature.
- `delete(): Value` — Callable SDK signature.
- `assemble(mode: string = "programmable", options: Value = Value.object()): Value` — Callable SDK signature.
- `createChild(id: string = ""): Value` — Callable SDK signature.
#### Context

Extends Value; inherited typed data accessors are available.

- `get root(): Component` — Callable SDK signature.
- `get input(): Input` — Callable SDK signature.
- `get world(): World` — Callable SDK signature.
- `get messages(): Messages` — Callable SDK signature.
- `get commands(): CommandResults` — Callable SDK signature.
- `get blocks(): Blocks` — Callable SDK signature.
- `get selection(): Selection` — Callable SDK signature.
- `log(message: string): void` — Callable SDK signature.
- `get time(): f64` — Callable SDK signature.
- `get deltaTime(): f64` — Callable SDK signature.
- `get tick(): f64` — Callable SDK signature.
- `get groundDistance(): f64` — Callable SDK signature.
- `get mass(): f64` — Callable SDK signature.
- `get entityId(): string` — Callable SDK signature.
- `get bodyType(): string` — Callable SDK signature.
- `get isOnGround(): bool` — Callable SDK signature.
- `get position(): f64[]` — Callable SDK signature.
- `get velocity(): f64[]` — Callable SDK signature.
- `get rotation(): f64[]` — Callable SDK signature.
- `get angularVelocity(): f64[]` — Callable SDK signature.
- `get gravity(): f64[]` — Callable SDK signature.
- `get players(): Value` — Callable SDK signature.
- `get driver(): Value` — Callable SDK signature.
- `get contacts(): Value` — Callable SDK signature.
- `get limits(): Value` — Callable SDK signature.

### Component API (self)

Every root and child receives the same top-level API. Namespaces target the current component unless explicitly described as legacy root-body methods.

#### Universal component surface

- `self.apiVersion` — Current component API version: `3`.
- `self.id / self.parentId` — Component ID and direct parent ID; the root has an ordinary ID and `parentId` equal to the empty string in the typed SDK.
- `self.state` — Mutable persistent state scoped to this component and retained across completed ticks and streaming.
- `self.child(id)` — Look up a direct child by its ordinary ID; returns `null` when missing.
- `self.children()` — Return a typed array of direct child handles. Recurse from `ctx.root` to traverse the tree.
- `self.applyThrust([x,y,z])` — Apply root-local force at this component. A child mounting offset produces torque; dynamic root only and subject to `ctx.limits`.
- `self.applyLocalThrust([x,y,z])` — Apply component-local force at this component. Installed anchor orientation controls its direction and an offset produces torque.
- `self.applyForce([x,y,z])` — Apply world-space force to the root center of mass; no effect on a kinematic root.
- `self.applyLocalForce([x,y,z])` — Apply root/body-local force. A child's direction is interpreted in that component's local frame.
- `self.applyForceAt(force, localPoint)` — Apply world-space force at a component-local offset, producing translation and torque.
- `self.applyTorque([x,y,z])` — Apply world-space torque to the root body.
- `self.getWorldPosition()` — Return this component world position as `[x,y,z]`.
- `self.getWorldRotation()` — Return this component world quaternion `[x,y,z,w]`, including ancestor rotations.
- `self.localToWorldDirection(dir)` — Convert a component-local direction to world space.
- `self.getPivot()` — Return the rotation pivot in entity-local coordinates.
- `self.getBounds()` — Return entity-local block bounds `{min,max,size,center}`, or `null` when empty.
- `self.setSeats(seats)` — Replace this component's pivot-relative driver seats. Each entry is `[x,y,z]` or `{position,rotation?,fixedOrientation?}`. `position` is the character/physics anchor, not the cushion top: on an upright seat, the standard 1.8 m sitting pose contacts the cushion 0.567 m above it, placing the head 1.233 m and the world-Y camera eye 1.053 m above the cushion, and needs about 0.33 m behind plus 0.59 m forward clearance. `rotation` is a `[x,y,z,w]` rider orientation in the pivot frame (default identity, facing the component's -Z forward); `fixedOrientation:true` makes the mounted rider's body and sitting clearances follow the seat's solved world orientation while the camera retains unrestricted horizontal mouse look and independent pitch. Changes take effect while mounted without resetting the camera. Invalid positions or degenerate quaternions drop that seat. An entity is mountable when any component has a seat.
- `self.getSeats()` — Return this component's pivot-relative driver seats as `{position,rotation,fixedOrientation}` records.
- `self.voxels.set(position, options?)` — Queue one pivot-relative standard voxel placement. `options.materialId` is `0` (default) or `1` (emissive); returns `{ok,placed,reason}`.
- `self.voxels.clear(position)` — Queue removal of one standard voxel; returns `{ok,removed,reason}`.
- `self.voxels.paint(position, options?)` — Queue color and optional `materialId` changes on one standard voxel; returns `{ok,painted,reason}`.
- `self.voxels.clearCell(position)` — Queue removal of all standard and micro voxels in one 1 m component cell.
- `self.voxels.subdivide(position, clearOffset?)` — Queue conversion to 512 micro voxels, optionally removing one offset atomically.
- `self.microVoxels.set(cell, offset, options?)` — Queue a 0.125 m voxel with optional `materialId` `0` or `1`; each offset coordinate is an integer from 0 through 7.
- `self.microVoxels.clear(cell, offset)` — Queue removal of one exact 0.125 m component voxel.
- `self.microVoxels.paint(cell, offset, options?)` — Queue color and optional `materialId` changes on one exact 0.125 m component voxel.

> Component voxel cells are measured from the current pivot, not the entity corner. Fractional cell coordinates floor after applying the pivot.

> All voxel changes are queued and action-specific. Check `result.getBoolean("ok")` and `result.getString("reason")`; entity bounds are capped at 256×256×256.

> Removing an entity's final voxel deletes the entity, scripts, and state.
#### Visual decorations

- Decorations are visual-only cubes. They never change collisions, mass, inertia, seats or constraints, and accept runtime edits on both dynamic and kinematic components.
- IDs are component-local, case-sensitive, 1-64 ASCII letters, digits, underscores or hyphens. Use self.child(id) or ctx.root to address another component. An entity may display at most 1024 decorations in total.
- position is [x,y,z] in component construction coordinates, independent of the pivot, each within ±512. rotation is a unit [x,y,z,w] quaternion. scale contains positive dimensions, each at most 256. color is an integer 0xRRGGBB; materialId is 0 (lit) or 1 (emissive). Unknown/null fields and malformed transforms return invalid_decoration.
- New decorations default to position [0,0,0], rotation [0,0,0,1], scale [1,1,1], color 0 and materialId 0. Reads may omit default transform/material fields. Supply explicit identity values to reset a field.
- Admitted commands update the shared optimistic in-tick view and consume the usual 256-command budget. Check ok/reason/commandId and later ctx.commands.result(commandId) for final commit; command_limit and too_many_decorations leave the view unchanged.
- Script edits affect runtime values only. They survive ticks, disabling code and streaming/checkpoints; global Stop or reset restores authored decorations and removes runtime-created ones. Inventory export and configuration reads retain the authored definition. Use spaceAPI configuration decoration_ops for persistent edits.
- The executor displays edits each script tick. Remote observers receive decoration values at checkpoint cadence; the 20 Hz rigid-body pose stream does not yet carry decoration animation.

- `self.decorations.all(): Value` — Read the sorted, frozen effective decoration list for this component.
- `self.decorations.get(id: string): Value` — Read one frozen decoration; isNull is true when absent.
- `self.decorations.upsert(id: string, patch: Value): Value` — Queue creation or a partial update. Fields are position, rotation, scale, color and materialId; omitted fields retain existing values.
- `self.decorations.remove(id: string): Value` — Queue removal of an existing decoration. Missing IDs return decoration_not_found.
#### Kinematics

Only kinematic bodies accept direct pose commands; dynamic bodies are solver-driven.

- `self.setLocalPosition([x,y,z])` — Set a kinematic child relative to its parent, or a kinematic root in world space.
- `self.setLocalEuler([x,y,z])` — Set kinematic orientation in radians using YXZ Euler order.
- `self.setLocalRotation([x,y,z,w])` — Set kinematic orientation as a quaternion.
- `self.setLocalSpin([ax,ay,az], rpm)` — Command continuous local-axis spin; call each entity tick to sustain it.
- `self.getLocalPosition()` — Return current local position as `[x,y,z]`; root returns `[0,0,0]`.
- `self.getLocalRotation()` — Return current local quaternion `[x,y,z,w]`.
- `self.setPivot([x,y,z])` — Set a kinematic pivot in entity-local coordinates while preserving block world positions. Dynamic bodies use their physical center of mass.
#### Rigid body, constraints, and Stop

- `self.body.getType() / self.body.setType(type)` — Read or set `'kinematic'|'dynamic'`; setter returns `{ok,type,reason}`. Entity bodies have no static type.
- `self.body.getMass() / self.body.setMass(kg)` — Read or set runtime mass; setter returns `{ok,mass,reason}`. Automatic mass is owned block count × 10 kg; minimum is 0.1 kg and invalid input returns `invalid_mass`.
- `self.body.getMaterial() / self.body.setMaterial(options)` — Read or set `{restitution,friction}`; setter returns `{ok,material,reason}`. Both coefficients clamp to `[0,1]` and default to 0.1/0.7.
- `self.body.getGravityEnabled() / self.body.setGravityEnabled(bool)` — Read or set runtime gravity; setter returns `{ok,enabled,reason}`. Kinematic bodies retain the flag but are not gravity-driven.
- `self.body.getCollisionEnabled() / self.body.setCollisionEnabled(bool)` — Read or set collision participation for terrain, player, entity, and raycast shapes; setter returns `{ok,enabled,reason}`.
- `self.body.getVelocity() / self.body.getAngularVelocity()` — Read this component body's world-space velocities.
- `self.body.applyForce(force)` — Apply world force to this dynamic component body; returns boolean.
- `self.body.applyLocalForce(force)` — Apply body-local force to this dynamic component body; returns boolean.
- `self.body.applyTorque(torque)` — Apply world torque to this dynamic component body; returns boolean.
- `self.constraints.all()` — Return a frozen snapshot of constraints connected to this component.
- `self.constraints.create(options: Value)` — Queue a `point`, `hinge`, or `weld`; `bodyA:null` denotes the external world and an omitted `bodyA` uses the structural parent (or external world for the root). Immediate Worker success is provisional `{ok:true,id:null,reason:'queued'}`. Supply an explicit ID for later lookup. Stiffness defaults to 0.9, `collideConnected` to false, omitted anchors use pivots, and hinge limits are radians.
- `self.constraints.remove(id)` — Queue removal of one constraint; returns boolean.
- `self.stop()` — Root-only global Stop: disable entity physics and scripts, clear state/time/tick/motion, reset child poses, and restore persisted BodyConfig defaults. Collision and selection shapes remain active. Child code must call `ctx.root.stop()`.

> `self.body` setters alter runtime values only. They persist until global Stop, which disables dynamics while retaining static collision/query shapes and restores persisted defaults.

> `self.body.apply*` targets the current component body and bypasses the legacy `ctx.limits`/HUD budget, but rejects non-finite values and components above `1e12`.

> Constraint creation is queued. Supply an explicit ID when later script logic requires a stable name; hinge limits are radians.

### ctx.world

- `ctx.world.apiVersion` — Current world API version: `3`.
- `ctx.world.getInfo(): Value` — Read the current runtime world: `id`, `slug`, `name`, `seed`, `terrainGeneratorVersion`, and `width`, `height`, `length` in metres. Use typed Value getters. Identity strings can be empty in engine-only fixtures without server metadata.
- `ctx.world.voxels.get(position)` — Read a real standard world voxel as `{block,color,materialId}` plus the current tick's admitted-write overlay; maximum 256 combined standard/micro host reads per entity tick.
- `ctx.world.voxels.set(position, options?)` — Queue a standard placement; `options.materialId` is `0` (default) or `1` (emissive), and the admitted result is provisional `{ok:true,placed:1,reason:'queued'}`.
- `ctx.world.voxels.clear(position)` — Queue removal of one standard voxel without deleting micro voxels in its cell.
- `ctx.world.voxels.paint(position, options?)` — Queue color and optional `materialId` changes on one existing standard voxel.
- `ctx.world.voxels.clearCell(position)` — Queue removal of all standard and micro voxels in one world cell.
- `ctx.world.voxels.subdivide(position, clearOffset?)` — Queue conversion of one standard voxel to 512 micro voxels.
- `ctx.world.microVoxels.get(cell, offset)` — Read one real 0.125 m world voxel as `{block,color,materialId}` plus the current tick overlay; offset coordinates are integers from 0 through 7.
- `ctx.world.microVoxels.set(cell, offset, options?)` — Queue one 0.125 m world voxel placement with optional `materialId` `0` or `1`.
- `ctx.world.microVoxels.clear(cell, offset)` — Queue removal of one exact 0.125 m world voxel.
- `ctx.world.microVoxels.paint(cell, offset, options?)` — Queue color and optional `materialId` changes on one existing micro world voxel.
- `ctx.world.entities(origin, radius=16)` — Filter the prefetched 64 m nearby-entity snapshot using shortest wrapped X/Z distance. Descriptors include pose, velocities, mass, bounds, collision/ground state, physics enabled state, script status, and component count.
- `ctx.world.entity(id: string)` — Look up an entity in the frozen nearby snapshot.
- `ctx.world.entitiesInChunk(chunkId: string)` — Filter nearby entities by wrapped chunk ID `"cx,cz"`.
- `ctx.world.raycast(origin, direction, maxDistance=24)` — Compatibility form: bounded synchronous standard-world-voxel raycast.
- `ctx.world.raycastWithOptions(origin: f64[], direction: f64[], options: Value)` — Full existing engine raycast over standard/micro world voxels and/or entities. Returns normalized kind, voxelKind, IDs, block/color, normal, position, and distance; maximum 64 calls per entity tick.

> Every entity executes in its selected world. All ctx.world voxel reads, writes, entity queries, raycasts, players and messages stay in that world; equal coordinates in Nature and Copper Metropolis identify different terrain.

> External agents select worlds through spaceAPI: GET /space/api/v2/worlds, resolve aether-archipelago (default alias), nature or copper-metropolis to the returned UUID, and use that UUID for construction and configuration. Entity programs have no HTTP credentials or network access and cannot switch runtime worlds.

> World writes never overwrite occupied cells or implicitly convert between standard and micro voxels. X/Z wrap automatically.

### ctx.selection

- `ctx.selection.snapshot()` — Read the current frozen shared selection snapshot.
- `ctx.selection.clear()` — Queue clearing the shared selection; returns `{ok,cleared,reason}`.
- `ctx.selection.cornerA(point) / cornerB(point)` — Set progressive world-box corners; accepts `{micro:true}` and returns `{ok,selected,reason}`.
- `ctx.selection.box(a, b)` — Set an atomic world box; accepts `{micro:true}`.
- `ctx.selection.cells(list) / toggle(cell)` — Replace or toggle sparse cells; micro mode uses 0.125 m cells.
- `ctx.selection.entity(entityId, nodeId?)` — Select a component subtree. Internal component selection requires a stopped entity.
- `ctx.selection.entityBox(entityId, nodeId, a, b, space?)` — Select directly owned voxels intersecting a node-local or world-space box; requires stopped.
- `ctx.selection.delete()` — Delete the shared selection; internal entity edits require stopped. Returns removal counts and IDs.
- `ctx.selection.assemble(mode='programmable', options={})` — Assemble world voxels in `auto|free_physics|projectile|programmable` mode; options are `{bodyType,restitution,friction,useGravity,mass}` and result is `{ok,assembled,entityId,runtimeId,reason}`. Invalid mode fails before changing selection or world.
- `ctx.selection.createChild(id?)` — Create a child from selected entity blocks; requires stopped and returns `{ok,childId,reason}`.

> Selections are capped at a 256×256×256 AABB. Boxes can clamp; sparse operations that exceed the cap fail with `bounds_exceeded`.

> Mutations update an optimistic in-tick snapshot, but the main thread can still reject internal entity edits with `entity_not_stopped`.

> Assembly defaults: dynamic body, restitution 0.1, friction 0.7, gravity enabled for dynamic bodies, and mass equal to owned block count × 10 kg with a 0.1 kg minimum.

> Gate destructive selection commands with `self.state` or an input edge so they run once.

### ctx.input and ctx.blocks

- `ctx.input.down(code)`, `pressed(code)`, and `released(code)` expose held, leading-edge, and trailing-edge keyboard state.
- Only the mounted entity receives player input. Generic `Shift`, `Control`, and `Alt` match either side.
- Reserved keys never reach scripts: Escape, Backspace, Delete, F3, F5, C, E, F, G, R, V, and digits 0–9.
- `ctx.blocks.pressed(type?)` is a one-tick edit edge for `place|remove|color|subdivide`; `event()` returns type/node, source/player, affected cell(s), voxel metadata, truncation, and final blockCount when available.

### Legacy root force budget

- `self.applyForce`, `applyLocalForce`, `applyThrust`, `applyForceAt`, and `applyTorque` target the root and share `maxForce = max(80, mass×65)` and `maxTorque = max(40, maxForce×max(0.75,boundingRadius))`.
- The engine clamps that legacy surface and displays its utilization in the Root Power Budget HUD.
- `self.body.apply*` is independent of that gameplay budget. Both force surfaces reject non-finite components and values above the separate `1e12` safety ceiling.
