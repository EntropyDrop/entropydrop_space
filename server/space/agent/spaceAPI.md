# spaceAPI — Agent HTTP interface

[spaceAPI](spaceAPI.md) · [entityAPI](entityAPI.md)

**spaceAPI** is used by agents and clients for authenticated HTTP requests. **entityAPI** is called only by entity component code through `self` and `ctx` inside the runtime. To program an entity, generate entityAPI code and submit it as part of the entity definition through spaceAPI. Reading entityAPI documentation does not grant direct runtime access.

Use the backend origin and `edapi_…` API key supplied by the user. A complete handoff contains **backend origin + API key + this document URL + the requested build**. Documentation is public; player positions and writes require authentication. Send the key only to the user-approved backend in `Authorization: Bearer <API_KEY>`, never in a URL or a public artifact.

`localhost` means the machine executing the request. A remote Agent needs a backend address it can reach. Preserve the user's intended server; do not substitute another server when a connection fails.

All valid spaceAPI keys, including existing keys, have full Space permissions. Create keys under **Space → API Keys** or **Settings → API** using only a name; no permission selection or reissue is needed. World membership, exclusive execution occupancy, quotas and any hosting budget still apply. World-entity operations do not check authorship; market resources retain publisher permissions.

## Find the player's position first

```sh
curl --fail-with-body "$SPACE_BASE_URL/space/api/v2/players/me/position" \
  -H "Authorization: Bearer $SPACE_API_KEY"
```

This reads the key owner's latest saved position in the server's default world. No world ID is needed beforehand. To target a known world the owner has joined, use `GET /space/api/v2/worlds/{world_id}/players/me/position`.

```json
{
  "world_id": "00000000-0000-4000-8000-000000000002",
  "position": {"x_cm": 744710, "y_cm": 1500, "z_cm": 55290},
  "yaw_q15": 0,
  "pitch_q15": 0,
  "updated_at": "2026-09-06T12:00:00Z",
  "age_seconds": 1.2,
  "stale": false,
  "stale_after_seconds": 30,
  "source": "checkpoint"
}
```

These coordinates are **integer centimetres**, not metres. `yaw_q15 / 32767 * π` converts yaw to radians; yaw 0 faces -Z. The position is the player's physics/feet position, not the camera eye. After the player moves or turns, the browser normally saves the changed pose within about five seconds. A stationary player may retain an older checkpoint; this is not a live tracking stream. To refresh an old position, move slightly in the online world and retry after a few seconds.

- `stale: true`: the checkpoint is older than 30 seconds or has an invalid future timestamp. For a request to build "near me", obtain a fresh checkpoint or ask the user to confirm using the old position.
- `404 PLAYER_POSITION_UNAVAILABLE`: there is no usable checkpoint. Ask the user to enter the online world and retry. Never use bootstrap's random fallback as their real location.
- `403 WORLD_MEMBERSHIP_REQUIRED`: the player has not joined that world.
- `401`: missing, invalid, or revoked credentials. Do not retry with someone else's credential.

Both position routes are self-only. All existing keys work without reissuing them. They cannot read another player's position or use the general login APIs.

## Create the requested object

1. Read [entity encoding and a complete request example](references/entity-create.md).
2. Encode a canonical **InventoryResource Protobuf v7** using [inventory.proto](references/inventory.proto). Raw JSON in `definition_base64` is not accepted.
3. Preferred transport: send the request body as `application/x-protobuf` using the
   `entropydrop.space.api.v2.CreateEntityRequest` envelope from
   [space_api.proto](references/space_api.proto), whose `definition` field holds the raw
   canonical resource bytes. The JSON form with `definition_base64` (base64 of the same
   bytes) remains accepted for existing clients; both produce identical stored content.
4. For programmable parts, read the [entityAPI reference](entityAPI.md). Only use its documented methods.
5. Read `GET /space/api/v2/worlds/{world_id}/api-usage` with the same key for current quotas and pricing.
6. Place the object a few metres away from the player's coordinates, leaving room for its full bounds. Player Y is not a terrain-height query. Account for terrain clearance, gravity, and wrapped coordinates.
7. Submit `POST /space/api/v2/worlds/{world_id}/entities`. Retain the request and `operation_id`; retry an uncertain submission with exactly the same body. A successful response includes the entity ID, requested run state and execution mode.

All keys can create entities (stopped or running), read their account's position, read world-entity configurations, edit stopped/unoccupied entities, start/stop unoccupied entities, and stamp blocksets through `POST /space/api/v2/worlds/{world_id}/blocksets/build`. World terrain stores `material_id` independently from color: `0` is the default lit material and `1` is emissive. Detailed nearby terrain uses the stored material; distant LOD intentionally renders the default material for performance.

Creation and blockset building are free within quotas. `running` uses an exclusive browser execution lease; it does not buy hosting and needs an online endpoint. Any nearby world participant may claim available running intent, regardless of author. Ordinary nearby browsers discover entities through a roughly two-second poll. Creation can succeed before the object is visible or simulating.

## Read and edit an existing entity

Use the entity ID returned by creation or copied from the Entity Editor. The following paths share the prefix `/space/api/v2/worlds/{world_id}/entities/{entity_id}`. They accept a player login token or a spaceAPI key and enforce world membership and exclusive execution occupancy, not authorship. All world participants are equal, including authors and administrators.

| Request | Purpose |
| --- | --- |
| `GET /configuration` | Read `{ "entity": <metadata>, "definition": <decoded InventoryResource v7 JSON> }`, including component code and authored body defaults |
| `PATCH /configuration` | Modify selected components' code, names, body defaults and voxels while stopped |
| `PUT /run-state` | Set `desired_run_state` to `running` or `stopped` |

Configuration reads are private and not cached. Binary definition/snapshot, AOI listing, checkpoint and execution-lease endpoints remain browser login interfaces. Use the JSON configuration endpoint for Agent reads; a spaceAPI key is not a general login credential.

**There are only two entity states: running and stopped.** Start enables physics and all component scripts. Stop disables both, restores authored BodyConfig defaults and child construction poses, and clears state, clocks, forces and velocities. It preserves the last saved root position and orientation. Individual component code switches do not create an entity Pause state. Browser execution needs one online endpoint holding its lease.

Read the current configuration, edit a stopped/unoccupied entity, then start it if requested. A live browser executor is exclusive to its endpoint, not merely its account: an Agent, another tab, the author or an administrator cannot stop, modify or take over it (`409 ENTITY_OCCUPIED`). Ask the occupying browser to stop/release it first, or wait for its lease to expire. Agent Start queues unoccupied running intent for an available browser; browser Start atomically acquires its execution lease. Creator attribution `owner_user_id` remains unchanged; `execution_user_id`/`executor_name` identify the actual holder. Each write returns entity metadata with a new `revision`; use that returned revision for the next write. Stop and edits invalidate old execution leases and prevent stale browser checkpoints and pose packets from overwriting the result.

```sh
SPACE_ENTITY_URL="$SPACE_BASE_URL/space/api/v2/worlds/$WORLD_ID/entities/$ENTITY_ID"
curl --fail-with-body "$SPACE_ENTITY_URL/configuration" \
  -H "Authorization: Bearer $SPACE_API_KEY"
```

Stop with `PUT /run-state` and a JSON body like the following (replace the UUID and revision with your operation ID and current revision):

This example applies only when no browser endpoint holds a live lease. Hosted execution must be paused/released through its separate hosting API.

```json
{"operation_id":"43b0697b-62fc-43f2-a572-2c74551a9df7","expected_revision":1,"desired_run_state":"stopped"}
```

If Stop returns revision 2, send this JSON to `PATCH /configuration`, with `Content-Type: application/json` and the same Authorization header:

```json
{
  "operation_id": "70a509c3-3421-4d93-b2c4-25627f5eff23",
  "expected_revision": 2,
  "components": [
    {
      "id": "root",
      "script": "self.state.frames = (self.state.frames || 0) + 1;",
      "body": {"type": "dynamic", "mass": 80, "friction": 0.8, "useGravity": true}
    }
  ]
}
```

Only named fields change; other components, constraints and properties remain intact. `components` contains 1–64 unique, existing component IDs. Each patch accepts `name`, `script`, `script_patch`, `body`, and/or `voxel_ops`. Use `script: ""` to clear code. Null values, duplicate IDs, unknown fields and empty patches are rejected. No owner, permission, runtime-state or arbitrary object-path updates are accepted.

`body` accepts `type` (`dynamic` / `kinematic`), `mass` (0.1–10¹²), `restitution` / `friction` (0–1), and Boolean `useGravity` / `collisionEnabled`. It merges into persisted defaults, which are also restored on Stop. Script bodies are limited to 64 KiB per component and 512 KiB per entity. Stored-definition validation checks the schema and limits; JavaScript compilation and execution errors are reported by the runtime.

For a small code change, use `script_patch` instead of resending the complete script. It accepts only a strict, file-independent unified diff. Compute `base_sha256` from the exact UTF-8 bytes of the current component script returned by `GET /configuration`. Optional `---` / `+++` headers are accepted, but Git metadata, paths and arbitrary file operations are not. `script` and `script_patch` are mutually exclusive. A stale hash returns `409 ENTITY_SCRIPT_BASE_CONFLICT`; malformed or non-matching hunks return `422 ENTITY_SCRIPT_PATCH_INVALID`.

Use semantic voxel operations rather than a text or JSON diff. `upsert` creates a voxel or changes its color/material; `remove` requires the addressed voxel to exist. A voxel is identified by its component plus `(dx, dy, dz, is_micro, micro_x, micro_y, micro_z)`. Standard voxels set `is_micro: false` and omit micro offsets. Micro voxels set `is_micro: true` and include all three offsets in 0–7. Colors use `color_rgb` in `0x000000`–`0xFFFFFF` (JSON sends this as a decimal integer). `material_id` is optional: `0` is the default lit surface and `1` is an emissive surface; omitting it while updating an existing voxel preserves that voxel's material. Each coordinate may occur once in a component patch, and one request may contain at most 65,536 voxel operations.

```json
{
  "operation_id": "ac8c1ed3-c79e-4597-bce8-25a784846c78",
  "expected_revision": 3,
  "components": [
    {
      "id": "root",
      "script_patch": {
        "format": "unified",
        "base_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "patch": "@@ -1 +1 @@\n-self.state.speed = 2;\n+self.state.speed = 3;\n"
      },
      "voxel_ops": [
        {
          "op": "upsert",
          "dx": 1,
          "dy": 0,
          "dz": 0,
          "is_micro": false,
          "color_rgb": 15040548,
          "material_id": 1
        },
        {
          "op": "remove",
          "dx": 2,
          "dy": 0,
          "dz": 0,
          "is_micro": true,
          "micro_x": 1,
          "micro_y": 2,
          "micro_z": 3
        }
      ]
    }
  ]
}
```

Replace the example hash with the SHA-256 of the current script. The server applies every component, code and voxel operation in memory, then validates and commits the complete canonical entity atomically. Bounds, voxel count, standard/micro exclusivity, component overlap, script limits and storage quotas still apply. A missing removal target returns `422 ENTITY_VOXEL_NOT_FOUND`; any final invalid geometry returns `422 ENTITY_DEFINITION_INVALID`. No partial change is stored after an error.

If the edit returns revision 3, start with another `PUT /run-state`:

```json
{"operation_id":"be2a45b6-c45f-486a-8559-f64d7f1fd0bb","expected_revision":3,"desired_run_state":"running"}
```

`expected_revision` is required for configuration edits; always supply it for run-state commands as well. `409 ENTITY_REVISION_CONFLICT` requires reading the current configuration and reconsidering the edit. `409 ENTITY_MUST_BE_STOPPED` requires stopping before editing. Hosted definitions cannot be edited through this endpoint (`ENTITY_HOSTED_EDIT_FORBIDDEN`); hosting has its separate API and must be explicitly enabled. A normal run-state request never purchases hosting.

Keep a distinct `operation_id` for each new command. Retry an uncertain write with the exact same ID **and body**. Successful edits and run-state commands have durable receipts: a delayed retry returns its original acknowledgement and cannot undo a newer Stop or edit. That acknowledgement can contain an older revision, so read configuration again when current state matters. Reusing the ID with a different command returns `409 ENTITY_OPERATION_ID_REUSED`.

HTTP success means the backend saved the definition or desired state. It does not assert that an online runtime has already applied it. Browsers discover changes through the existing poll.


## Geometry and physics rules

- Right-handed, Y-up; +X right, -Z forward. X wraps into `[0,16384)` metres and Z into `[0,2048)`. Buildable Y is `[0,256)` metres.
- Standard voxels are 1 metre; micro voxels are 0.125 metres. A micro voxel uses `dx/dy/dz` plus offsets `micro_x`/`micro_y`/`micro_z` in 0–7, guarded by the boolean `is_micro`; color is the varint `color_rgb` (0xRRGGBB). This matches the realtime `VoxelMutation` encoding; the v6 packed `micro_index` and `fixed32 color` are rejected.
- Components form one tree. IDs are unique; display names belong to each component's `name`, including `root.name`.
- Authored Stop poses must align to the 0.125-metre grid and **must not overlap between components**, even when collisions are disabled. Reserve wheel and joint clearances in the chassis.
- Dynamic bodies use force/torque. Direct pose setters work only on kinematic bodies. Persist default body settings in the definition; script setters are runtime changes.
- Scripts run at 20 Hz in bounded QuickJS. Only the mounted entity receives keyboard input. Add a seat for drivable vehicles; V mounts/unmounts. W/A/S/D and Space are available to scripts.
- For suspension, the current constraints are point/hinge/weld. There is no built-in spring or prismatic constraint; use a tested force-based controller (for example, raycast spring/damper suspension) or supported articulated mechanisms.

## Failure handling

`422 ENTITY_DEFINITION_INVALID` means the Protobuf, grid, hierarchy, names, scripts or body data failed validation. Correct the definition before retrying; do not silently create an unrelated fallback. `409 ENTITY_OPERATION_ID_REUSED` means a prior successful operation used a different request body. `429` means a quota/rate limit: inspect the response and usage rather than duplicating submissions. Preserve entity IDs and do not delete unrelated objects to free quota.
