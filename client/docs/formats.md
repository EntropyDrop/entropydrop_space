# Space data formats

Portable contracts use additive changes when wire-compatible. Explicit release readers
migrate supported legacy versions; unknown formats are rejected without rewriting their bytes.

| Data | Version | Owner / location |
| --- | --- | --- |
| Portable `InventoryResource` | **8** | `entropydrop_space/proto/inventory.proto` |
| Browser backpack | **10** | `entropydrop_space/proto/backpack.proto`; stored at `space.backpack.v10.pb` |
| REST request envelopes | **2** | `entropydrop_space/proto/space_api.proto` (`entropydrop.space.api.v2`) |
| Far-surface zone snapshot | **5** | `EDSZ` binary, parsed in `src/bootstrap/SpaceSurfaceSnapshot.ts` |
| Local terrain outbox | **3** | `space.world-edits.v3.*` (`entropydrop_space/engine/src/voxel/WorldEditPersistence.ts`) |
| Legacy browser entities (purged on online entry) | **4** | JSON `entropydrop_space_entities.*` (`entropydrop_space/engine/src/contraption/ContraptionManager.ts`, `ENTITY_STORAGE_VERSION`) |
| Realtime relay | `space-relay-v1` | MessagePack subprotocol; no `.proto` |
| Authoritative realtime | `space.multiplayer.v2` | target design in `entropydrop_backend/space/contracts/protocol.proto`; not implemented |

## Portable InventoryResource (v8)

`InventoryResource` is the canonical binary contract for `.edpb` files, backpack export,
market upload/CDN objects and entity definitions. It has a `schema_version` and a `oneof
content` of `item`, `block_set`, `entity` or `color_set`. New backpack items use the
`Item` wrapper: a template `id`, a display `name`, an optional original `BlockSet`, and
an `entity_list` of original `Entity` messages. Static-only, Entity-only and mixed content
share one item concept. Runtime entity APIs retain their single-Entity envelope.

The outer wrapper reuses the existing messages:

```proto
message Item {
  string id = 1;
  string name = 2;
  BlockSet block_set = 3;
  repeated Entity entity_list = 4;
}
```

`block_set` may be absent and `entity_list` may be empty, but their combined content
must contain at least one voxel. Template ids identify saved Items independently from
backpack slot indices and newly created world-entity UUIDs. Each Entity retains its own
component ids, hierarchy, scripts, physics, seats and constraints.

`Voxel` follows the authoritative realtime `VoxelMutation` conventions:

```proto
sint32 dx = 1; sint32 dy = 2; sint32 dz = 3;
bool   is_micro = 4;                 // false = standard 1 m voxel
uint32 micro_x  = 5;                 // 0..7, meaningful only when is_micro
uint32 micro_y  = 6;
uint32 micro_z  = 7;
uint32 color_rgb = 8;                // 0xRRGGBB varint
uint32 material_id = 9;              // 0 default, 1 emissive
```

The v6 packed `micro_index = 1 + mx + 8*my + 64*mz` and `fixed32 color` are rejected.

Canonical encoders (both `InventoryProtobuf.ts` and `inventory_codec.py`):

- normalize every `double` `-0.0` to `+0.0`;
- sort `BlockSet.blocks` and `Component.blocks` by
  `(dx, dy, dz, is_micro, micro_x, micro_y, micro_z, color_rgb, material_id)`;
- sort `Component.children` and `Entity.constraints` by Unicode code point id order;
- preserve Entity-list, palette-entry and seat order;
- omit zero/identity Item root poses and normalize their quaternion sign.

The market content digest is SHA-256 over canonical bytes with Item template ids and
all display names removed, so copying or renaming does not change content identity. Entity display names live on
`Component.name`; `Entity` has no `name` field (`reserved 1`, `reserved "name"`).

Limits (enforced by `routers/space_market.py` and `routers/space_entities.py`): 8 MiB per
definition, 65,536 voxels, 64 components, hierarchy depth 16, 256 constraints, 64 KiB per
script and 512 KiB of scripts. For Item, these budgets apply across all its Entity trees
and static geometry together. Root poses inside Item describe each Entity construction
frame relative to the Item origin. World-constraint A endpoints use Item coordinates
and transform once on placement; component-local endpoints retain their original frames.
Entity root translations may be any finite bounded position relative to Item, including
offsets between micro cells. Grid alignment applies to each Entity's internal construction;
combined Item overlap and extent checks preserve fractional root offsets.

Market migration `space_0010` admits `item`; the Items listing also includes existing
v8 `blockset` and `entity` rows without rewriting their immutable objects, digests or
counters. Static and Entity resources are wrapped on backpack import, subject to the
legacy-world-anchor exception below. See the [Item contract](../../proto/README.md#unified-items).

## Browser backpack (v10)

`backpack.proto` embeds `entropydrop.space.inventory.v8.InventoryResource` and is never
uploaded. `PlayerController` stores it at `space.backpack.v10.pb` through
`BrowserStorage` (IndexedDB with a localStorage fallback). `items` has one cursor, one
nine-slot hotbar and 198 slots; `color_sets` retains its own cursor and 99 slots. Empty
`BackpackSlot` wrappers preserve gaps; trailing empty wrappers are omitted.

The explicit v8/v9 reader prioritizes the old active kind's nine hotbar slots, then the
other kind's hotbar, followed by both storage ranges. It maps the selected index through
this permutation and retains the original storage key. Legacy external-world Entity
anchors require their source world pose to become Item coordinates, so those resources
retain their standalone envelope instead of guessing or losing anchors.

## REST request envelopes (v2)

`space_api.proto` carries the small amount of metadata around a raw canonical resource:

```proto
message CreateEntityRequest   { string operation_id = 1; bytes definition = 2; PositionCm position = 3; uint32 yaw_quarter_turns = 4; EntityRunState desired_run_state = 5; bytes snapshot_json = 6; }
message CheckpointEntityRequest { string operation_id = 1; uint64 expected_revision = 2; bytes definition = 3; PositionCm position = 4; EntityRunState desired_run_state = 5; bytes snapshot_json = 6; }
message BuildBlocksetRequest  { string operation_id = 1; uint64 created_at_ms = 2; bytes definition = 3; PositionCm position = 4; uint32 yaw_quarter_turns = 5; }
```

`definition` is the raw `InventoryResource` v8, so the resource uses the same encoding on
upload and download. `snapshot_json` is the opaque engine runtime state as UTF-8 JSON;
it stays JSON until a typed snapshot schema exists. Requests use
`Content-Type: application/x-protobuf`; the equivalent JSON form with `definition_base64`
(base64 of the same bytes) is still accepted for existing agents. Definitions are always
downloaded as raw `application/x-protobuf`.

## Far-surface zone snapshot (`EDSZ`, v6)

The backend publishes independently compressed 1/2/4/8/16/32/64m levels. Each download
has a 32-byte little-endian header, a zone-wide X-major lattice, and an authored-solid
trailer. The browser also reads legacy v3 (chunk-major) and v4 (coarse lattice) data
while the server rebuilds its cache.

| Offset | Field | Type |
| --- | --- | --- |
| 0 | magic `EDSZ` | 4 bytes |
| 4 | schema version (`6`) | uint8 |
| 5 | sample width in metres (`1/2/4/8/16/32/64`) | uint8 |
| 6 | zone size in chunks (`32`) | uint8 |
| 7 | lattice record bytes (`8`) | uint8 |
| 8 | zone X | uint16 LE |
| 10 | zone Z | uint16 LE |
| 12 | terrain seed | int32 LE |
| 16 | terrain generator version | uint32 LE |
| 20 | source terrain revision | uint64 LE |
| 28 | record count (`(512 / sample_width)^2`) | uint32 LE |

Each lattice record contains maximum height (`uint16`), minimum source height
(`uint16`), RGB (`3 * uint8`) and conservative colour error (`uint8`). Heights use
1/8m micro units. Errors survive downsampling so coarse data can request sufficient
source detail for the screen-error budget. Procedural terrain and authored solids
are separate, preventing a high beam from raising the surrounding terrain mip.

The trailer begins with `uint32 chunk_count`. Each authored chunk has local chunk X/Z
(`2 * uint8`), accepted chunk revision (`uint64`), box count (`uint32`), then 15-byte
solid records: `x, bottom, z, width, height, depth` (`6 * uint16`) in chunk-local micro
units, followed by RGB (`3 * uint8`). Vertical runs and air gaps remain separate. The
same authored trailer accompanies every data mip; a 64m overview still preserves
thin structures. A zero-box chunk is valid and masks an entirely excavated chunk.

A fine zone without authored solids is 2,097,188 bytes; its 64m overview is 548 bytes.
The parser caps each payload at 16 MiB, validates exact lengths, dimensions, solid
bounds, unique chunk ownership and safe revisions, and verifies SHA-256 and manifest
identity before installation. Unavailable/dirty zones retain their last valid data;
`complete: false` means more generation is pending, not that absent zones were deleted.

## Visual decorations

Inventory v8 Component field 14 stores `decorations`: component-local ids, optional
construction-frame position, unit quaternion, positive XYZ scale, RGB and material.
Default transforms are omitted. Each centered 1m cube follows its owner; dimensions
may vary independently from physical voxels. The aggregate limit is 1024 per Entity
or Item. Decorations are preserved by backpack copies, binary export, market
validation, entity checkpoints and hosted simulation, without entering physical
bounds, mass, collision or construction-grid validation.

Tool 7 (Modeling, the triangular trowel) adds a cube with RMB at an entity or component
surface. LMB selects a decoration and releases the cursor for local position,
Euler-angle input (stored as a quaternion), XYZ dimensions and appearance controls.
Entities must be stopped and editable. Duplicate/Delete and Ctrl/Cmd+Z,
Ctrl/Cmd+Shift+Z provide decoration-only undo/redo during the current session.

## Local terrain outbox (v3)

`space.world-edits.v3.*` stores unacknowledged terrain mutations and the last published
revision. Mutations are a discriminated JSON union (`set_standard`, `set_micro`,
`remove_micro`, `clear_micro_cell`) sent in idempotent batches of at most 256 through
`POST /space/api/v2/worlds/{world_id}/terrain-edits/batches`. Obsolete v1/v2 overlays are
ignored, never uploaded.
