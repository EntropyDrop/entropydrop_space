"""Migrate legacy emissive material ID (1) to canonical 50% glow (151).

Rewrites persisted world terrain overlays (``chunk_snapshots``) and world entity
definitions and runtime decoration snapshots (``space_world_entities``) in place
inside this transaction. Market objects stored in the Space object store are
migrated separately by ``python -m space.migrate_market_emissive`` because
Alembic must not perform object store I/O inside its database transaction.
"""
import datetime
import hashlib
import json

from alembic import op
from google.protobuf.message import DecodeError
import sqlalchemy as sa
import zstandard as zstd

from space.contracts import inventory_pb2

revision = "space_0013"
down_revision = "space_0012"
branch_labels = None
depends_on = None

LEGACY_EMISSIVE = 1
CANONICAL_EMISSIVE = 151
SPACE_CHUNK_CODEC_RAW = 0
SPACE_CHUNK_CODEC_ZSTD = 1
MAX_CHUNK_SNAPSHOT_BYTES = 16 * 1024 * 1024


def _decode_chunk_payload(row) -> dict:
    payload = bytes(row.payload or b"")
    if not payload:
        return {}
    codec = int(row.codec)
    uncompressed_size = int(row.uncompressed_size)
    if codec == SPACE_CHUNK_CODEC_RAW:
        encoded = payload
    elif codec == SPACE_CHUNK_CODEC_ZSTD:
        if not (0 <= uncompressed_size <= MAX_CHUNK_SNAPSHOT_BYTES):
            raise RuntimeError(
                f"Chunk ({row.chunk_x}, {row.chunk_z}) has invalid uncompressed size {uncompressed_size}"
            )
        encoded = zstd.ZstdDecompressor().decompress(payload, max_output_size=uncompressed_size)
    else:
        raise RuntimeError(f"Chunk ({row.chunk_x}, {row.chunk_z}) has unsupported codec {codec}")
    if len(encoded) != uncompressed_size or hashlib.sha256(encoded).digest() != bytes(row.content_hash):
        raise RuntimeError(f"Chunk ({row.chunk_x}, {row.chunk_z}) failed checksum verification")
    parsed = json.loads(encoded.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise RuntimeError(f"Chunk ({row.chunk_x}, {row.chunk_z}) payload is not an object")
    return parsed


def _encode_chunk_payload(payload: dict) -> tuple[bytes, bytes, int, int]:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    compressed = zstd.ZstdCompressor(level=6).compress(encoded)
    if len(compressed) < len(encoded):
        return compressed, hashlib.sha256(encoded).digest(), SPACE_CHUNK_CODEC_ZSTD, len(encoded)
    return encoded, hashlib.sha256(encoded).digest(), SPACE_CHUNK_CODEC_RAW, len(encoded)


def _migrate_chunk_overlay(overlay: dict) -> bool:
    changed = False
    standard = overlay.get("standard")
    if isinstance(standard, list):
        for item in standard:
            if isinstance(item, list) and len(item) >= 6 and item[3] != 0 and item[5] == LEGACY_EMISSIVE:
                item[5] = CANONICAL_EMISSIVE
                changed = True
    micro = overlay.get("micro")
    if isinstance(micro, list):
        for item in micro:
            if isinstance(item, list) and len(item) >= 6 and item[5] == LEGACY_EMISSIVE:
                item[5] = CANONICAL_EMISSIVE
                changed = True
    decorations = overlay.get("decorations")
    if isinstance(decorations, list):
        for item in decorations:
            if not isinstance(item, dict):
                continue
            if item.get("material") == LEGACY_EMISSIVE:
                item["material"] = CANONICAL_EMISSIVE
                changed = True
            if item.get("materialId") == LEGACY_EMISSIVE:
                item["materialId"] = CANONICAL_EMISSIVE
                changed = True
    return changed


def _migrate_entity_definition(definition: bytes) -> tuple[bytes, bool]:
    resource = inventory_pb2.InventoryResource()
    try:
        resource.ParseFromString(definition)
    except DecodeError as error:
        raise RuntimeError("Entity definition is not valid Protobuf") from error
    if resource.schema_version != 8 or resource.WhichOneof("content") != "entity":
        raise RuntimeError("Expected a schema v8 entity definition")
    changed = False
    pending = [resource.entity.root]
    while pending:
        component = pending.pop()
        for block in component.blocks:
            if block.material_id == LEGACY_EMISSIVE:
                block.material_id = CANONICAL_EMISSIVE
                changed = True
        for decoration in component.decorations:
            if decoration.material_id == LEGACY_EMISSIVE:
                decoration.material_id = CANONICAL_EMISSIVE
                changed = True
        pending.extend(component.children)
    if not changed:
        return definition, False
    return resource.SerializeToString(deterministic=True), True


def _migrate_entity_snapshot(snapshot: bytes) -> tuple[bytes, bool]:
    parsed = json.loads(snapshot.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise RuntimeError("Entity snapshot is not a JSON object")
    changed = False
    runtime_decorations = parsed.get("runtimeDecorations")
    if isinstance(runtime_decorations, list):
        for entry in runtime_decorations:
            if not isinstance(entry, dict):
                continue
            decorations = entry.get("decorations")
            if not isinstance(decorations, list):
                continue
            for decoration in decorations:
                if isinstance(decoration, dict) and decoration.get("materialId") == LEGACY_EMISSIVE:
                    decoration["materialId"] = CANONICAL_EMISSIVE
                    changed = True
    if not changed:
        return snapshot, False
    encoded = json.dumps(
        parsed,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return encoded, True


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    chunk_columns = {col["name"] for col in inspector.get_columns("chunk_snapshots")}
    has_event_stream = (
        "last_event_id" in chunk_columns and inspector.has_table("world_event_streams")
    )

    chunk_table_cols = [
        sa.column("world_id", sa.Uuid(as_uuid=False)),
        sa.column("chunk_x", sa.Integer()),
        sa.column("chunk_z", sa.Integer()),
        sa.column("revision", sa.BigInteger()),
        sa.column("codec", sa.SmallInteger()),
        sa.column("uncompressed_size", sa.Integer()),
        sa.column("content_hash", sa.LargeBinary()),
        sa.column("payload", sa.LargeBinary()),
    ]
    if has_event_stream:
        chunk_table_cols.append(sa.column("last_event_id", sa.BigInteger()))
    chunks = sa.table("chunk_snapshots", *chunk_table_cols)

    migrated_by_world: dict[str, list[tuple]] = {}
    for row in bind.execute(sa.select(chunks).with_for_update()).fetchall():
        overlay = _decode_chunk_payload(row)
        if not overlay or not _migrate_chunk_overlay(overlay):
            continue
        stored, content_hash, codec, uncompressed_size = _encode_chunk_payload(overlay)
        migrated_by_world.setdefault(row.world_id, []).append(
            (row, stored, content_hash, codec, uncompressed_size)
        )

    event_streams = sa.table(
        "world_event_streams",
        sa.column("world_id", sa.Uuid(as_uuid=False)),
        sa.column("last_event_id", sa.BigInteger()),
        sa.column("updated_at", sa.DateTime(timezone=True)),
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    for world_id, items in migrated_by_world.items():
        new_event_id = None
        if has_event_stream:
            stream_row = bind.execute(
                sa.select(event_streams)
                .where(event_streams.c.world_id == world_id)
                .with_for_update()
            ).first()
            if stream_row is not None:
                new_event_id = int(stream_row.last_event_id or 0) + 1
                bind.execute(
                    event_streams.update()
                    .where(event_streams.c.world_id == world_id)
                    .values(last_event_id=new_event_id, updated_at=now)
                )
            else:
                max_chunk_event = max(int(item[0].last_event_id or 0) for item in items)
                new_event_id = max_chunk_event + 1
                bind.execute(
                    event_streams.insert().values(
                        world_id=world_id,
                        last_event_id=new_event_id,
                        updated_at=now,
                    )
                )
        for row, stored, content_hash, codec, uncompressed_size in items:
            chunk_values = {
                "payload": stored,
                "codec": codec,
                "content_hash": content_hash,
                "uncompressed_size": uncompressed_size,
                "revision": int(row.revision) + 1,
            }
            if new_event_id is not None:
                chunk_values["last_event_id"] = new_event_id
            bind.execute(
                chunks.update()
                .where(
                    chunks.c.world_id == row.world_id,
                    chunks.c.chunk_x == row.chunk_x,
                    chunks.c.chunk_z == row.chunk_z,
                )
                .values(**chunk_values)
            )

    entities = sa.table(
        "space_world_entities",
        sa.column("world_id", sa.Uuid(as_uuid=False)),
        sa.column("id", sa.Uuid(as_uuid=False)),
        sa.column("definition", sa.LargeBinary()),
        sa.column("content_digest", sa.LargeBinary()),
        sa.column("size_bytes", sa.Integer()),
        sa.column("snapshot", sa.LargeBinary()),
        sa.column("snapshot_digest", sa.LargeBinary()),
        sa.column("snapshot_size_bytes", sa.Integer()),
        sa.column("revision", sa.BigInteger()),
    )
    for row in bind.execute(sa.select(entities).with_for_update()).fetchall():
        definition = bytes(row.definition)
        if len(definition) != int(row.size_bytes):
            raise RuntimeError(f"Entity {row.id} has an unexpected definition size")
        new_definition, def_changed = _migrate_entity_definition(definition)

        snap_changed = False
        new_snapshot = None
        if row.snapshot is not None:
            snapshot_bytes = bytes(row.snapshot)
            if len(snapshot_bytes) != int(row.snapshot_size_bytes):
                raise RuntimeError(f"Entity {row.id} has an unexpected snapshot size")
            if snapshot_bytes:
                new_snapshot, snap_changed = _migrate_entity_snapshot(snapshot_bytes)

        if not def_changed and not snap_changed:
            continue

        values = {"revision": int(row.revision) + 1}
        if def_changed:
            values.update({
                "definition": new_definition,
                "content_digest": hashlib.sha256(new_definition).digest(),
                "size_bytes": len(new_definition),
            })
        if snap_changed and new_snapshot is not None:
            values.update({
                "snapshot": new_snapshot,
                "snapshot_digest": hashlib.sha256(new_snapshot).digest(),
                "snapshot_size_bytes": len(new_snapshot),
            })
        bind.execute(
            entities.update()
            .where(entities.c.world_id == row.world_id, entities.c.id == row.id)
            .values(**values)
        )


def downgrade():
    # Material ID 151 is a valid 50% glow preset; downgrading would be lossy for
    # content authored after migration. Legacy ID 1 remains reserved and supported.
    pass
