import importlib

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker

from space import models
from space.contracts import inventory_pb2
from space.inventory_codec import decode_inventory_resource, encode_inventory_resource


def _legacy_entity_bytes() -> bytes:
    portable = {
        "type": "space-entity",
        "version": 8,
        "root": {
            "name": "Legacy entity",
            "id": "root",
            "body": {"type": "dynamic"},
            "blocks": [{"dx": 0, "dy": 0, "dz": 0, "block": 1, "color": 0x123456}],
            "seats": [],
            "children": [],
        },
        "constraints": [],
    }
    message = inventory_pb2.InventoryResource.FromString(
        encode_inventory_resource("entity", portable)
    )
    message.schema_version = 7
    return message.SerializeToString(deterministic=True)


def test_palette_migration_upgrades_world_entities_and_market_schema(monkeypatch):
    migration = importlib.import_module("space.migrations.versions.0009_palette_gradients")
    engine = sa.create_engine("sqlite:///:memory:")
    legacy = _legacy_entity_bytes()

    with engine.begin() as connection:
        metadata = sa.MetaData()
        entities = sa.Table(
            "space_world_entities",
            metadata,
            sa.Column("world_id", sa.Uuid(as_uuid=False), primary_key=True),
            sa.Column("id", sa.Uuid(as_uuid=False), primary_key=True),
            sa.Column("schema_version", sa.SmallInteger(), nullable=False, server_default="7"),
            sa.Column("definition", sa.LargeBinary(), nullable=False),
            sa.Column("content_digest", sa.LargeBinary(), nullable=False),
            sa.Column("size_bytes", sa.Integer(), nullable=False),
            sa.Column("revision", sa.BigInteger(), nullable=False),
        )
        sa.Table(
            "space_market_resources",
            metadata,
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("schema_version", sa.SmallInteger(), nullable=False, server_default="7"),
            sa.CheckConstraint(
                "schema_version IN (6, 7)",
                name="ck_space_market_resource_schema_version",
            ),
        )
        metadata.create_all(connection)
        connection.execute(entities.insert().values(
            world_id="00000000-0000-4000-8000-000000000001",
            id="00000000-0000-4000-8000-000000000002",
            schema_version=7,
            definition=legacy,
            content_digest=b"x" * 32,
            size_bytes=len(legacy),
            revision=4,
        ))

        monkeypatch.setattr(migration, "op", Operations(MigrationContext.configure(connection)))
        migration.upgrade()

        row = connection.execute(sa.text("""
            SELECT schema_version, definition, content_digest, size_bytes, revision
            FROM space_world_entities
        """)).one()
        assert row.schema_version == 8
        assert row.revision == 5
        assert row.size_bytes == len(row.definition)
        assert row.content_digest != b"x" * 32
        assert decode_inventory_resource(row.definition)[0] == "entity"

        connection.execute(sa.text(
            "INSERT INTO space_market_resources (id, schema_version) VALUES ('new', 8)"
        ))
        connection.execute(sa.text(
            "INSERT INTO space_market_resources (id) VALUES ('defaulted')"
        ))
        assert connection.execute(sa.text(
            "SELECT schema_version FROM space_market_resources WHERE id = 'defaulted'"
        )).scalar_one() == 8

    engine.dispose()


def test_market_object_migration_rewrites_v7_bytes_and_is_restart_safe(db, monkeypatch):
    migration = importlib.import_module("space.migrate_market_v8")
    portable = {
        "type": "space-blockset",
        "version": 8,
        "name": "Legacy market block",
        "blocks": [{"dx": 0, "dy": 0, "dz": 0, "block": 1, "color": 0x123456}],
    }
    message = inventory_pb2.InventoryResource.FromString(
        encode_inventory_resource("blockset", portable)
    )
    message.schema_version = 7
    legacy = message.SerializeToString(deterministic=True)
    old_key = "space-market/resources/legacy/legacy.pb"
    row = models.SpaceMarketResource(
        id="legacy",
        kind="blockset",
        schema_version=7,
        name=portable["name"],
        content_digest=b"x" * 32,
        object_key=old_key,
        size_bytes=len(legacy),
        block_count=1,
        node_count=1,
    )
    db.add(row)
    db.commit()

    objects = {old_key: legacy}
    monkeypatch.setattr(migration, "SessionLocal", sessionmaker(bind=db.get_bind()))
    monkeypatch.setattr(
        migration.object_store,
        "download_from_s3",
        lambda key, is_public=True: objects[key],
    )
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

    assert migration.migrate_market_v8() == 1
    db.expire_all()
    upgraded = db.query(models.SpaceMarketResource).filter_by(id="legacy").one()
    assert upgraded.schema_version == 8
    assert upgraded.object_key != old_key
    assert old_key not in objects
    assert decode_inventory_resource(objects[upgraded.object_key]) == ("blockset", portable)

    assert migration.migrate_market_v8() == 0
