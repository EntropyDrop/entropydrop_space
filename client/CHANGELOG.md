# Changelog

All notable Space wire-format and API changes. Space intentionally rejects older data, so
breaking versions are called out explicitly.

## 2026-09 — Inventory v7 and unified Protobuf transport

### Breaking

- **Inventory `InventoryResource` v6 → v7.** The `Voxel` message now follows the
  authoritative `space.multiplayer.v2.VoxelMutation` conventions: `is_micro` plus
  `micro_x`/`micro_y`/`micro_z` (0..7) and the varint `color_rgb`, replacing the packed
  `micro_index` and `fixed32 color`. `ColorSet.colors` is now `repeated uint32`.
- **Backpack v7 → v8.** `space.backpack.v8.pb` embeds inventory v7; v7 backpacks are
  ignored.
- **Database:** migration `space_0004_inventory_v7` converts every stored v6 entity
  definition to canonical v7 in place, recomputing the name-free content digest and byte
  size and bumping the entity revision so clients refetch. Terrain overlays, far-surface
  snapshots, player positions and hosting leases are left untouched. Market rows are
  retained on `schema_version` 6, hidden from listings and rejected with
  `MARKET_RESOURCE_LEGACY_SCHEMA` on download until re-published as v7. Account, quota and
  billing records are retained.

### Changed

- Entity definitions and blockset builds now accept a binary
  `entropydrop.space.api.v2` request envelope (`space_api.proto`) with
  `Content-Type: application/x-protobuf`, carrying the raw canonical resource in
  `definition`. The JSON `definition_base64` form is still accepted; both store identical
  canonical bytes and share one content digest.
- Agent documentation now covers the binary envelope and the v7 micro encoding.

### Documentation

- Added `docs/architecture.md`, `docs/networking.md` and `docs/formats.md`.
- Repaired stale references to the removed `apps/space/backend/` design directory and the
  deleted 2026-09-02 audit report; removed the unsupported CI claim.
- Documented the `space-relay-v1` MessagePack schema and the `EDSZ` v3 layout, which were
  previously only in code.

## Earlier

- 8×8×8 micro grid (0.125 m) with merged collision caches; inventory v6, backpack v7,
  offline entities v4, world edits v3, far-surface snapshots v3. See
  [docs/micro-grid-p0.md](docs/micro-grid-p0.md).
