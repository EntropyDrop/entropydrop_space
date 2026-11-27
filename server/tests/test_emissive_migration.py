import datetime
import hashlib
import importlib
import json
import uuid

from alembic.migration import MigrationContext
from alembic.operations import Operations
import pytest
import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker
import zstandard as zstd

from space import models
from space.inventory_codec import (
    decode_inventory_resource,
    encode_inventory_resource,
    inventory_content_digest,
)


def _pack_chunk(payload: dict, *, compress: bool) -> tuple[bytes, bytes, int, int]:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    digest = hashlib.sha256(encoded).digest()
    if compress:
        return zstd.ZstdCompressor(level=6).compress(encoded), digest, 1, len(encoded)
    return encoded, digest, 0, len(encoded)


def _unpack_chunk(row) -> dict:
    raw = bytes(row.payload)
    encoded = zstd.ZstdDecompressor().decompress(raw, max_output_size=row.uncompressed_size) if row.codec == 1 else raw
    assert len(encoded) == row.uncompressed_size
    assert hashlib.sha256(encoded).digest() == bytes(row.content_hash)
    return json.loads(encoded.decode("utf-8"))


def _legacy_entity_portable() -> dict:
    return {
        "type": "space-entity",
        "version": 8,
        "root": {
            "id": "root",
            "name": "Lamp Tower",
            "body": {"type": "kinematic"},
            "blocks": [
                {"dx": 0, "dy": 0, "dz": 0, "block": 1, "color": 0xFFFFFF, "material_id": 1},
                {"dx": 1, "dy": 0, "dz": 0, "block": 1, "color": 0x112233, "material_id": 61},
                {"dx": 2, "dy": 0, "dz": 0, "block": 1, "color": 0xFFAA00, "material_id": 180},
            ],
            "decorations": [
                {"id": "bulb", "color": 0xFFEEAA, "materialId": 1},
                {"id": "glass", "color": 0x88CCFF, "materialId": 61},
            ],
            "seats": [],
            "children": [
                {
                    "id": "beacon",
                    "name": "Beacon",
                    "body": {"type": "kinematic"},
                    "blocks": [
                        {"dx": 0, "dy": 1, "dz": 0, "mx": 1, "my": 2, "mz": 3, "block": 1, "color": 0x00FFFF, "material_id": 1},
                    ],
                    "decorations": [{"id": "halo", "color": 0xFF00AA, "materialId": 1}],
                    "seats": [],
                    "children": [],
                }
            ],
        },
        "constraints": [],
    }


def _create_migration_tables(connection):
    metadata = sa.MetaData()
    event_streams = sa.Table(
        "world_event_streams",
        metadata,
        sa.Column("world_id", sa.Uuid(as_uuid=False), primary_key=True),
        sa.Column("last_event_id", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    chunks = sa.Table(
        "chunk_snapshots",
        metadata,
        sa.Column("world_id", sa.Uuid(as_uuid=False), primary_key=True),
        sa.Column("chunk_x", sa.Integer(), primary_key=True),
        sa.Column("chunk_z", sa.Integer(), primary_key=True),
        sa.Column("revision", sa.BigInteger(), nullable=False),
        sa.Column("last_event_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("codec", sa.SmallInteger(), nullable=False),
        sa.Column("uncompressed_size", sa.Integer(), nullable=False),
        sa.Column("content_hash", sa.LargeBinary(), nullable=False),
        sa.Column("payload", sa.LargeBinary(), nullable=False),
    )
    entities = sa.Table(
        "space_world_entities",
        metadata,
        sa.Column("world_id", sa.Uuid(as_uuid=False), primary_key=True),
        sa.Column("id", sa.Uuid(as_uuid=False), primary_key=True),
        sa.Column("definition", sa.LargeBinary(), nullable=False),
        sa.Column("content_digest", sa.LargeBinary(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("snapshot", sa.LargeBinary(), nullable=True),
        sa.Column("snapshot_digest", sa.LargeBinary(), nullable=True),
        sa.Column("snapshot_size_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("revision", sa.BigInteger(), nullable=False),
    )
    metadata.create_all(connection)
    return chunks, entities, event_streams


def test_alembic_0013_migrates_chunks_and_entities_idempotently(monkeypatch):
    migration = importlib.import_module("space.migrations.versions.0013_emissive_levels")
    engine = sa.create_engine("sqlite:///:memory:")
    world_id = str(uuid.uuid4())

    with engine.begin() as connection:
        chunks, entities, event_streams = _create_migration_tables(connection)
        connection.execute(event_streams.insert().values(
            world_id=world_id,
            last_event_id=41,
            updated_at=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
        ))

        legacy_chunk_payload = {
            "standard": [
                [1, 10, 2, 1, 0xFF0000, 1],
                [2, 10, 2, 1, 0x00FF00, 61],
                [3, 10, 2, 1, 0x0000FF, 190],
                [4, 10, 2, 0, 0x000000, 1],
            ],
            "micro": [
                [8, 80, 16, 0xABCDEF, "tip", 1],
                [9, 80, 16, 0x123456, None, 102],
            ],
            "decorations": [
                {"id": "d1", "x": 1, "y": 10, "z": 2, "color": 0xFFFFFF, "material": 1},
                {"id": "d2", "x": 2, "y": 10, "z": 2, "color": 0x111111, "material": 61},
            ],
        }
        clean_chunk_payload = {
            "standard": [[1, 10, 2, 1, 0xFFFFFF]],
            "micro": [[8, 80, 16, 0xABCDEF, None, 151]],
        }
        raw_chunk = _pack_chunk(legacy_chunk_payload, compress=False)
        zstd_chunk = _pack_chunk(legacy_chunk_payload, compress=True)
        clean_chunk = _pack_chunk(clean_chunk_payload, compress=False)
        connection.execute(chunks.insert(), [
            dict(
                world_id=world_id, chunk_x=0, chunk_z=0, revision=3, last_event_id=10,
                payload=raw_chunk[0], content_hash=raw_chunk[1], codec=raw_chunk[2], uncompressed_size=raw_chunk[3],
            ),
            dict(
                world_id=world_id, chunk_x=1, chunk_z=0, revision=7, last_event_id=20,
                payload=zstd_chunk[0], content_hash=zstd_chunk[1], codec=zstd_chunk[2], uncompressed_size=zstd_chunk[3],
            ),
            dict(
                world_id=world_id, chunk_x=2, chunk_z=0, revision=9, last_event_id=30,
                payload=clean_chunk[0], content_hash=clean_chunk[1], codec=clean_chunk[2], uncompressed_size=clean_chunk[3],
            ),
        ])

        legacy_def = encode_inventory_resource("entity", _legacy_entity_portable())
        legacy_snap = json.dumps({
            "scriptStatus": "running",
            "runtimeDecorations": [
                {"id": "root", "decorations": [{"id": "pulse", "color": 0xFF0000, "materialId": 1}]},
            ],
        }, separators=(",", ":"), sort_keys=True).encode("utf-8")
        clean_portable = {
            "type": "space-entity",
            "version": 8,
            "root": {
                "id": "root",
                "name": "Clean",
                "body": {"type": "kinematic"},
                "blocks": [{"dx": 0, "dy": 0, "dz": 0, "block": 1, "color": 0x111111, "material_id": 151}],
                "seats": [],
                "children": [],
            },
            "constraints": [],
        }
        clean_def = encode_inventory_resource("entity", clean_portable)
        legacy_entity_id = str(uuid.uuid4())
        clean_entity_id = str(uuid.uuid4())
        connection.execute(entities.insert(), [
            dict(
                world_id=world_id,
                id=legacy_entity_id,
                definition=legacy_def,
                content_digest=hashlib.sha256(legacy_def).digest(),
                size_bytes=len(legacy_def),
                snapshot=legacy_snap,
                snapshot_digest=hashlib.sha256(legacy_snap).digest(),
                snapshot_size_bytes=len(legacy_snap),
                revision=4,
            ),
            dict(
                world_id=world_id,
                id=clean_entity_id,
                definition=clean_def,
                content_digest=hashlib.sha256(clean_def).digest(),
                size_bytes=len(clean_def),
                snapshot=None,
                snapshot_digest=None,
                snapshot_size_bytes=0,
                revision=12,
            ),
        ])

        monkeypatch.setattr(migration, "op", Operations(MigrationContext.configure(connection)))
        migration.upgrade()

        chunk_rows = {
            (row.chunk_x, row.chunk_z): row
            for row in connection.execute(sa.select(chunks)).fetchall()
        }
        for key, expected_rev in [((0, 0), 4), ((1, 0), 8)]:
            row = chunk_rows[key]
            assert row.revision == expected_rev
            assert row.last_event_id == 42
            overlay = _unpack_chunk(row)
            assert overlay["standard"] == [
                [1, 10, 2, 1, 0xFF0000, 151],
                [2, 10, 2, 1, 0x00FF00, 61],
                [3, 10, 2, 1, 0x0000FF, 190],
                [4, 10, 2, 0, 0x000000, 1],
            ]
            assert overlay["micro"] == [
                [8, 80, 16, 0xABCDEF, "tip", 151],
                [9, 80, 16, 0x123456, None, 102],
            ]
            assert overlay["decorations"] == [
                {"id": "d1", "x": 1, "y": 10, "z": 2, "color": 0xFFFFFF, "material": 151},
                {"id": "d2", "x": 2, "y": 10, "z": 2, "color": 0x111111, "material": 61},
            ]
        assert chunk_rows[(2, 0)].revision == 9
        assert chunk_rows[(2, 0)].last_event_id == 30
        stream_row = connection.execute(sa.select(event_streams)).one()
        assert stream_row.last_event_id == 42

        entity_rows = {
            row.id: row
            for row in connection.execute(sa.select(entities)).fetchall()
        }
        migrated_entity = entity_rows[legacy_entity_id]
        assert migrated_entity.revision == 5
        assert migrated_entity.size_bytes == len(migrated_entity.definition)
        assert bytes(migrated_entity.content_digest) == hashlib.sha256(bytes(migrated_entity.definition)).digest()
        kind, decoded = decode_inventory_resource(bytes(migrated_entity.definition))
        assert kind == "entity"
        assert [b.get("material_id", 0) for b in decoded["root"]["blocks"]] == [151, 61, 180]
        assert [d.get("materialId", 0) for d in decoded["root"]["decorations"]] == [151, 61]
        assert decoded["root"]["children"][0]["blocks"][0]["material_id"] == 151
        assert decoded["root"]["children"][0]["decorations"][0]["materialId"] == 151

        assert migrated_entity.snapshot_size_bytes == len(migrated_entity.snapshot)
        assert bytes(migrated_entity.snapshot_digest) == hashlib.sha256(bytes(migrated_entity.snapshot)).digest()
        snap_data = json.loads(bytes(migrated_entity.snapshot).decode("utf-8"))
        assert snap_data["runtimeDecorations"][0]["decorations"][0]["materialId"] == 151

        assert entity_rows[clean_entity_id].revision == 12

        # Second run is a complete no-op (idempotent).
        before_chunks = connection.execute(sa.select(chunks)).fetchall()
        before_entities = connection.execute(sa.select(entities)).fetchall()
        migration.upgrade()
        assert connection.execute(sa.select(chunks)).fetchall() == before_chunks
        assert connection.execute(sa.select(entities)).fetchall() == before_entities

    engine.dispose()


def test_alembic_0013_aborts_on_corrupted_chunk_checksum(monkeypatch):
    migration = importlib.import_module("space.migrations.versions.0013_emissive_levels")
    engine = sa.create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        chunks, _entities, _streams = _create_migration_tables(connection)
        connection.execute(chunks.insert().values(
            world_id=str(uuid.uuid4()),
            chunk_x=0,
            chunk_z=0,
            revision=1,
            last_event_id=1,
            codec=0,
            uncompressed_size=2,
            content_hash=b"x" * 32,
            payload=b"{}",
        ))
        monkeypatch.setattr(migration, "op", Operations(MigrationContext.configure(connection)))
        with pytest.raises(RuntimeError, match="checksum"):
            migration.upgrade()
    engine.dispose()


def test_market_emissive_migration_rewrites_all_kinds_and_is_idempotent(db, monkeypatch):
    migration = importlib.import_module("space.migrate_market_emissive")
    resources = [
        ("blk", "blockset", {
            "type": "space-blockset",
            "version": 8,
            "name": "Glow BlockSet",
            "blocks": [
                {"dx": 0, "dy": 0, "dz": 0, "block": 1, "color": 0xFFAA00, "material_id": 1},
                {"dx": 1, "dy": 0, "dz": 0, "block": 1, "color": 0x112233, "material_id": 61},
            ],
            "decorations": [{"dx": 0, "dy": 0, "dz": 0, "color": 0xFFFFFF, "materialId": 1}],
        }),
        ("ent", "entity", _legacy_entity_portable()),
        ("pal", "colorset", {
            "type": "space-colorset",
            "version": 8,
            "name": "Legacy Glow Colors",
            "entries": [
                {"stops": [{"color": "#ffaa00", "position": 0}], "material_id": 1 if i == 0 else 0}
                for i in range(9)
            ],
        }),
        ("itm", "item", {
            "type": "space-item",
            "version": 8,
            "id": "item-glow-1",
            "name": "Glow Bundle",
            "blockSet": {
                "type": "space-blockset",
                "version": 8,
                "name": "Glow Static",
                "blocks": [{"dx": 0, "dy": 0, "dz": 0, "block": 1, "color": 0xFFEE00, "material_id": 1}],
            },
            "entityList": [_legacy_entity_portable()],
        }),
        ("clean", "blockset", {
            "type": "space-blockset",
            "version": 8,
            "name": "Already Migrated",
            "blocks": [{"dx": 0, "dy": 0, "dz": 0, "block": 1, "color": 0x334455, "material_id": 180}],
        }),
    ]

    objects: dict[str, bytes] = {}
    old_keys: dict[str, str] = {}
    for res_id, kind, portable in resources:
        encoded = encode_inventory_resource(kind, portable)
        digest = inventory_content_digest(kind, portable)
        key = f"space-market/resources/{res_id}/{digest.hex()}.pb"
        objects[key] = encoded
        old_keys[res_id] = key
        db.add(models.SpaceMarketResource(
            id=res_id,
            kind=kind,
            schema_version=8,
            name=portable["name"] if kind != "entity" else portable["root"]["name"],
            content_digest=digest,
            object_key=key,
            size_bytes=len(encoded),
            block_count=1,
            node_count=1,
        ))
    db.commit()

    monkeypatch.setattr(migration, "SessionLocal", sessionmaker(bind=db.get_bind()))
    monkeypatch.setattr(migration.object_store, "download_from_s3", lambda key, is_public=True: objects[key])
    monkeypatch.setattr(
        migration.object_store,
        "upload_to_s3",
        lambda content, key, **_kwargs: objects.__setitem__(key, bytes(content)),
    )
    monkeypatch.setattr(
        migration.object_store,
        "delete_from_s3_strict",
        lambda key, is_public=True: objects.pop(key, None),
    )

    assert migration.migrate_market_emissive(dry_run=True) == 4
    assert set(objects.keys()) == set(old_keys.values())

    assert migration.migrate_market_emissive() == 4
    db.expire_all()

    clean_row = db.query(models.SpaceMarketResource).filter_by(id="clean").one()
    assert clean_row.object_key == old_keys["clean"]

    for res_id in ("blk", "ent", "pal", "itm"):
        row = db.query(models.SpaceMarketResource).filter_by(id=res_id).one()
        assert row.object_key != old_keys[res_id]
        assert old_keys[res_id] not in objects
        kind, decoded = decode_inventory_resource(objects[row.object_key])
        assert row.content_digest == inventory_content_digest(kind, decoded)
        assert row.size_bytes == len(objects[row.object_key])
        if kind == "blockset":
            assert decoded["blocks"][0]["material_id"] == 151
            assert decoded["blocks"][1]["material_id"] == 61
            assert decoded["decorations"][0]["materialId"] == 151
        elif kind == "entity":
            assert decoded["root"]["blocks"][0]["material_id"] == 151
            assert decoded["root"]["decorations"][0]["materialId"] == 151
            assert decoded["root"]["children"][0]["blocks"][0]["material_id"] == 151
        elif kind == "colorset":
            assert decoded["entries"][0]["material_id"] == 151
        elif kind == "item":
            assert decoded["blockSet"]["blocks"][0]["material_id"] == 151
            assert decoded["entityList"][0]["root"]["blocks"][0]["material_id"] == 151

    assert migration.migrate_market_emissive() == 0
