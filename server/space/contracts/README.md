> Historical design schemas (`schema.sql` / `protocol.proto`) are retained for compatibility checks. The deployed standalone schema is owned by `space/migrations/` and uses `space_accounts` identity projections.

# Space protocol contracts

The canonical schemas live in `entropydrop_space/proto/`:

- `inventory.proto` — portable `InventoryResource` (v8) and backpack-independent content.
- `backpack.proto` — browser-local backpack state (v10), never uploaded.
- `space_api.proto` — `entropydrop.space.api.v2` binary REST request envelopes whose
  `definition` field carries raw canonical `InventoryResource` bytes.

Inventory v8 includes the additive `Item` wrapper: template `id`, display `name`, an
optional existing `BlockSet`, and `entity_list` of existing `Entity` trees. Each tree
keeps its component-id namespace, scripts, physics, seats and constraints. Backpack
v10 merges BlockSet and Entity slots into one Item collection with explicit v8/v9
migration; world entity APIs retain their standalone Entity contract. See the
[canonical Item contract](../../../proto/README.md#unified-items).

This directory retains the generated Python bindings so the Python API can run without a
Node or engine checkout. `inventory_v6.proto` is a legacy read-only copy of the retired v6
schema, used only by the `space_0004` entity migration; it is never served or used by the
running API.

From `server/`, with protoc 33.2 (Python gencode 6.33.2):

```sh
protoc --proto_path=space/contracts=../proto --python_out=. space/contracts/inventory.proto
protoc --proto_path=space/contracts=../proto --python_out=. space/contracts/space_api.proto
protoc -I. --python_out=. space/contracts/inventory_v6.proto   # legacy migration reader
```

The virtual path keeps the existing `space.contracts.inventory_pb2` /
`space.contracts.space_api_pb2` module and Protobuf descriptor identity. Regenerate and
check in the bindings whenever the shared schema changes;
`python3 tools/sync_server_contracts.py --check --protobuf` from the workspace root
verifies the bindings and public reference copies against the canonical schemas.
`protocol.proto` and `schema.sql` remain the backend's multiplayer storage contracts.

## Guardrails

`buf.yaml` (buf v2) lints this directory with `STANDARD` plus the documented exceptions
(semantic enum zeros, non-mirroring package names, two intentionally co-located
packages). `tests/test_space_contracts.py` enforces the contract in every test run:
`protocol.proto` and `inventory_v6.proto` must compile with protoc, and `buf lint` must
pass when the buf CLI is available on PATH or in the sibling
`entropydrop_space/node_modules` or `entropydrop_space/engine/node_modules` (pinned `@bufbuild/buf` dev dependency). The
pinned protoc is 33.2, matching the checked-in Python bindings.

The current construction grid has 8 divisions per metre and inventory schema v8 is
required. Standalone migration `space_0003` resets the pre-8×8×8 terrain, entities, market
resources and derived surface data, and moves the market check constraint to version 6.
`space_0004` then migrates stored v6 entity definitions in place to canonical v7 (content
digest, byte size and revision are recomputed), leaves terrain, surface, player-position
and hosting data untouched, and retains market rows on schema 6 while hiding them from
listings and returning `410 MARKET_RESOURCE_LEGACY_SCHEMA` on download. `space_0009`
rewrites v7 world entities to v8, then `python -m space.migrate_market_v8` upgrades v7
market objects and rows to the gradient-aware v8 contract. No database or object-store
content is deleted except superseded v7 market objects after their v8 replacements are
durably stored and committed.

`space_0010` admits the `item` market kind without rewriting existing v8 objects,
digests, attribution, likes or download counts. Items listings include `item`,
`blockset` and `entity` rows; Color Sets stay separate. Apply this migration before
publishing mixed Items. Its downgrade requires restoring the pre-release backup.
