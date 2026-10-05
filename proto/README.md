# Space Protobuf contracts

`entropydrop_space/proto/` is the single source of truth for every Space schema that
crosses a process boundary.

| File | Package | Purpose | Current version |
| --- | --- | --- | --- |
| `inventory.proto` | `entropydrop.space.inventory` | Portable `InventoryResource`: unified Items, legacy blocksets/entities, gradient color sets and materials. Used by backpack export, market upload/CDN, entity create/checkpoint and `.edpb` files. | **v8** |
| `backpack.proto` | `entropydrop.space.backpack` | Browser-local backpack UI state. Never uploaded; the backend has no backpack endpoint or message. | **v10** |
| `space_api.proto` | `entropydrop.space.api` | Binary REST request envelopes (`CreateEntityRequest`, `CheckpointEntityRequest`, `BuildBlocksetRequest`). `definition` carries raw canonical `InventoryResource` bytes. | **v2** |

`space.multiplayer.v2` (the authoritative realtime protocol) lives in the backend at
`entropydrop_backend/space/contracts/protocol.proto`. It is target design and is not yet
compiled or implemented; the running realtime channel is the transitional
`space-relay-v1` MessagePack relay. Do not add consumers for it until it is wired up.

## Ownership and versioning

- `inventory.proto` is the authority for portable content. Its Voxel geometry follows the
  realtime `VoxelMutation` conventions: `is_micro` guards `micro_x`/`micro_y`/`micro_z`
  (0..7), color is the varint `color_rgb` (`0xRRGGBB`), and `material_id` is
  `0` (default) or `1` (emissive). The removed v6 packed
  `micro_index` and `fixed32 color` are not accepted.
- A wire-breaking change bumps the package version (`.v8` -> `.v9`) and the
  `schema_version` carried in the message. Release migrations may read the immediately
  preceding schema explicitly, but normal API decoding accepts only the current version.
- Never reuse a retired field number or name; add `reserved` entries instead. Additive,
  backward-compatible fields may stay in the current package version.
- Keep `space_api.proto` free of secrets and of typed imports; its `bytes definition`
  field is validated by the existing inventory codec so the Python binding keeps the
  `space/contracts/*_pb2` descriptor identity.

## Code generation

Generated artifacts are checked in; consumers do not need `protoc`.

```sh
npm run generate:protobuf   # engine: ts-proto bindings + descriptor set + source hashes
npm run check:protobuf      # verify the checked-in outputs are current
```

The server Python bindings are generated from the Space workspace root:

```sh
protoc --proto_path=space/contracts=proto --python_out=server space/contracts/inventory.proto
protoc --proto_path=space/contracts=proto --python_out=server space/contracts/space_api.proto
```

Then run `python3 tools/sync_server_contracts.py --check --protobuf` to verify the bindings
and the public agent reference copies.

## Linting and compatibility

`buf.yaml` (buf v2) configures `buf lint` and `buf breaking`. The CLI is pinned as a dev
dependency (`@bufbuild/buf`), so no global install is required:

```sh
npm run check:buf                                # buf lint (part of `npm run check`)
cd proto && buf breaking --against '.git#branch=main'   # manual / CI only
```

The lint exceptions are intentional: enum zero values are semantic
(`BODY_TYPE_DYNAMIC`, `CONSTRAINT_TYPE_POINT`, …), the versioned package names do not
mirror the proto directory, and the directory deliberately carries three independently
versioned packages (`inventory.v8`, `backpack.v10`, `api.v2`) side by side. `buf breaking`
compares the working tree against the last released branch, so a wire change without a
package version bump fails the check; run it before releasing, not on every commit.
`protoc` 33.2 and `protoc-gen-ts_proto` 2.12.1 generated the checked-in bindings; the
source hashes in `engine/src/generated/inventory_descriptor.ts` fail `npm run check:protobuf` if
`proto/` changes without regenerating.

## Unified Items

`Component.decorations` (field 14) adds visual cubes without changing v8 voxel or
physics semantics. Each decoration has a component-local id, an optional position
in the component's voxel construction frame, a unit quaternion, positive XYZ
dimensions, RGB and material (0 standard, 1 emissive). The unit cube is centered on
its position. Omitted transforms mean zero translation, identity rotation and
1m dimensions; component pivot changes preserve its authored position.

Decorations follow their owning component through articulation, copies, exports,
checkpoints and hosted simulation. They do not affect mass, colliders, voxel counts,
physical bounds or structural raycasts. Dedicated modeling raycasts and visual
preview bounds include them. Ids are unique within each component and sorted;
default transforms are omitted and quaternion signs are canonicalized. The limit
is 1024 decorations per Entity and per aggregate Item.

`inventory.proto` adds `Item` as an additive v8 resource alternative. An Item contains
`id`, `name`, an optional original `BlockSet`, and `entity_list` of original `Entity`
messages. Existing standalone resource tags and runtime entity APIs remain compatible.
Component trees, physics, scripts, seats and constraints retain their original shape.
Template ids and all display names are excluded from content deduplication.

An Entity root inside Item uses `local_position`/`local_rotation` for its construction
frame relative to the Item origin. Missing fields mean zero translation and identity.
The Item decoder extracts this pose before standalone Entity validation. World constraint
A endpoints inside Item use Item coordinates and are transformed by the overall world
placement pose once. Body-local endpoints retain their original frames. Separate Entity
entries have independent component-id namespaces and cannot constrain one another.

Backpack v10 merges the two old collections into `items`, with one selection and one
nine-slot hotbar. Migration prioritizes the previously active kind's first nine slots,
then the other kind's hotbar, then both storage ranges. All 198 positions, gaps and the
selected slot are retained. Old v8/v9 browser bytes are read with `LegacyBackpack`; the
new storage key leaves the original bytes available. Static and detached Entity resources
are wrapped as Items. Legacy Entity resources with absolute world anchors retain their
original envelope until their source world pose is available. New captures supply that
pose so their world anchors can be rebased safely.

The market admits `item` after Alembic `space_0010`. Its Items listing includes existing
v8 blocksets and entities, preserving their immutable objects, digests and counters.
Combined geometry and aggregate voxel/component/constraint/seat/script limits are checked
before accepting Item uploads. Component installation remains available for a single
Entity item; mixed/multiple-Entity items place their parts independently in one frame.

Compile and round-trip the mixed example:

```sh
protoc -I proto --encode=entropydrop.space.inventory.v8.InventoryResource \
  proto/inventory.proto < proto/examples/mixed_item.textproto > /tmp/mixed-item.edpb
protoc -I proto --decode=entropydrop.space.inventory.v8.InventoryResource \
  proto/inventory.proto < /tmp/mixed-item.edpb
```
