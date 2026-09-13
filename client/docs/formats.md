# Space data formats

Every version below is intentionally breaking: Space rejects older data instead of
migrating it, and a release that changes a format resets the affected Space content.

| Data | Version | Owner / location |
| --- | --- | --- |
| Portable `InventoryResource` | **7** | `entropydrop_space/proto/inventory.proto` |
| Browser backpack | **8** | `entropydrop_space/proto/backpack.proto`; stored at `space.backpack.v8.pb` |
| REST request envelopes | **2** | `entropydrop_space/proto/space_api.proto` (`entropydrop.space.api.v2`) |
| Far-surface zone snapshot | **3** | `EDSZ` binary, parsed in `src/bootstrap/SpaceSurfaceSnapshot.ts` |
| Local terrain outbox | **3** | `space.world-edits.v3.*` (`entropydrop_space/engine/src/voxel/WorldEditPersistence.ts`) |
| Offline entities (browser-local, offline mode only) | **4** | JSON `entropydrop_space_entities.*` (`entropydrop_space/engine/src/contraption/ContraptionManager.ts`, `ENTITY_STORAGE_VERSION`) |
| Offline player position | **1** | `space.offline.player-position.v1` JSON (`src/bootstrap/SpaceBootstrap.ts`) |
| Realtime relay | `space-relay-v1` | MessagePack subprotocol; no `.proto` |
| Authoritative realtime | `space.multiplayer.v2` | target design in `entropydrop_backend/space/contracts/protocol.proto`; not implemented |

## Portable InventoryResource (v7)

`InventoryResource` is the canonical binary contract for `.edpb` files, backpack export,
market upload/CDN objects and entity definitions. It has a `schema_version` and a `oneof
content` of `block_set`, `entity` or `color_set`.

`Voxel` follows the authoritative realtime `VoxelMutation` conventions:

```proto
sint32 dx = 1; sint32 dy = 2; sint32 dz = 3;
bool   is_micro = 4;                 // false = standard 1 m voxel
uint32 micro_x  = 5;                 // 0..7, meaningful only when is_micro
uint32 micro_y  = 6;
uint32 micro_z  = 7;
uint32 color_rgb = 8;                // 0xRRGGBB varint
```

The v6 packed `micro_index = 1 + mx + 8*my + 64*mz` and `fixed32 color` are rejected.

Canonical encoders (both `InventoryProtobuf.ts` and `inventory_codec.py`):

- normalize every `double` `-0.0` to `+0.0`;
- sort `BlockSet.blocks` and `Component.blocks` by
  `(dx, dy, dz, is_micro, micro_x, micro_y, micro_z, color_rgb)`;
- sort `Component.children` and `Entity.constraints` by Unicode code point id order;
- preserve color-set order and seat order.

The market content digest is SHA-256 over the canonical bytes re-encoded with component
`name` fields removed, so renaming never changes identity. Entity display names live on
`Component.name`; `Entity` has no `name` field (`reserved 1`, `reserved "name"`).

Limits (enforced by `routers/space_market.py` and `routers/space_entities.py`): 8 MiB per
definition, 65,536 voxels, 64 components, hierarchy depth 16, 256 constraints, 64 KiB per
script and 512 KiB of scripts per entity.

## Browser backpack (v8)

`backpack.proto` embeds `entropydrop.space.inventory.v7.InventoryResource` and is never
uploaded. `PlayerController` stores it at `space.backpack.v8.pb` through
`BrowserStorage` (IndexedDB with a localStorage fallback). Three category groups
(`block_sets`, `entities`, `color_sets`) each keep a `selected` index and a list of
`BackpackSlot` wrappers; empty wrappers preserve internal gaps and trailing empty slots are
omitted. At most 99 slots per category. v7 backpacks are ignored.

## REST request envelopes (v2)

`space_api.proto` carries the small amount of metadata around a raw canonical resource:

```proto
message CreateEntityRequest   { string operation_id = 1; bytes definition = 2; PositionCm position = 3; uint32 yaw_quarter_turns = 4; EntityRunState desired_run_state = 5; bytes snapshot_json = 6; }
message CheckpointEntityRequest { string operation_id = 1; uint64 expected_revision = 2; bytes definition = 3; PositionCm position = 4; EntityRunState desired_run_state = 5; bytes snapshot_json = 6; }
message BuildBlocksetRequest  { string operation_id = 1; uint64 created_at_ms = 2; bytes definition = 3; PositionCm position = 4; uint32 yaw_quarter_turns = 5; }
```

`definition` is the raw `InventoryResource` v7, so the resource uses the same encoding on
upload and download. `snapshot_json` is the opaque engine runtime state as UTF-8 JSON;
it stays JSON until a typed snapshot schema exists. Requests use
`Content-Type: application/x-protobuf`; the equivalent JSON form with `definition_base64`
(base64 of the same bytes) is still accepted for existing agents. Definitions are always
downloaded as raw `application/x-protobuf`.

## Far-surface zone snapshot (`EDSZ`, v3)

A 32-byte little-endian header followed by fixed 5-byte records, produced by the backend
and parsed in `src/bootstrap/SpaceSurfaceSnapshot.ts`:

| Offset | Field | Type |
| --- | --- | --- |
| 0 | magic `EDSZ` | 4 bytes |
| 4 | schema version (`3`) | uint8 |
| 5 | samples per chunk axis (`8`) | uint8 |
| 6 | zone size in chunks (`32`) | uint8 |
| 7 | record bytes (`5`) | uint8 |
| 8 | zone X | uint16 LE |
| 10 | zone Z | uint16 LE |
| 12 | terrain seed | int32 LE |
| 16 | terrain generator version | uint32 LE |
| 20 | source terrain revision | uint64 LE |
| 28 | record count (65,536) | uint32 LE |

Each record is `uint16 LE height_micro`, `R`, `G`, `B`, so a zone is
`32 + 65536 * 5 = 327,712` bytes. A JSON manifest lists zone digests, byte lengths and
URLs; the browser verifies the SHA-256 before installing a zone. The browser derives
2/4/8/16/32/64 m mip levels from the 8×8 two-metre summary per chunk.

## Local terrain outbox (v3)

`space.world-edits.v3.*` stores unacknowledged terrain mutations and the last published
revision. Mutations are a discriminated JSON union (`set_standard`, `set_micro`,
`remove_micro`, `clear_micro_cell`) sent in idempotent batches of at most 256 through
`POST /space/api/v2/worlds/{world_id}/terrain-edits/batches`. Obsolete v1/v2 overlays are
ignored, never uploaded.
