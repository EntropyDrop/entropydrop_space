import hashlib
import importlib
import uuid

from alembic.migration import MigrationContext
from alembic.operations import Operations
import pytest
import sqlalchemy as sa

from space.auth import get_current_user
from space.contracts import inventory_pb2, inventory_v6_pb2
from space.main import app
from space.models import SpaceWorldEntity, User


def _wire_definition():
    resource = inventory_pb2.InventoryResource(schema_version=8)
    root = resource.entity.root
    root.id, root.name = "root", "Original root"
    root.body.SetInParent()
    root.blocks.add(color_rgb=0x123456)
    # Preserve old wire defaults rather than round-tripping the current codec.
    root.script = "// legacy component"
    child = root.children.add(id="child", name="Original child")
    child.body.SetInParent()
    child.blocks.add(dx=1, color_rgb=0x654321)
    definition = resource.SerializeToString(deterministic=True)
    root.ClearField("name")
    child.ClearField("name")
    legacy_digest = hashlib.sha256(resource.SerializeToString(deterministic=True)).digest()
    return definition, legacy_digest


def _entities_table(connection):
    metadata = sa.MetaData()
    table = sa.Table(
        "space_world_entities", metadata,
        sa.Column("world_id", sa.Uuid(as_uuid=False), primary_key=True),
        sa.Column("id", sa.Uuid(as_uuid=False), primary_key=True),
        sa.Column("schema_version", sa.SmallInteger(), nullable=False, server_default="8"),
        sa.Column("definition", sa.LargeBinary(), nullable=False),
        sa.Column("content_digest", sa.LargeBinary(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("revision", sa.BigInteger(), nullable=False),
        sa.Column("snapshot", sa.LargeBinary()),
    )
    metadata.create_all(connection)
    return table


def _row():
    definition, digest = _wire_definition()
    return dict(
        world_id=str(uuid.uuid4()), id=str(uuid.uuid4()), schema_version=8,
        definition=definition, content_digest=digest, size_bytes=len(definition),
        revision=17, snapshot=b'preserved snapshot',
    )


def _run(connection, monkeypatch):
    migration = importlib.import_module("space.migrations.versions.0011_entity_download_digests")
    monkeypatch.setattr(migration, "op", Operations(MigrationContext.configure(connection)))
    migration.upgrade()


def test_repairs_only_legacy_digests_preserving_bytes_and_is_idempotent(monkeypatch):
    engine = sa.create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        entities = _entities_table(connection)
        broken, healthy = _row(), _row()
        healthy["content_digest"] = hashlib.sha256(healthy["definition"]).digest()
        connection.execute(entities.insert(), [broken, healthy])
        _run(connection, monkeypatch)
        after = {row.id: dict(row._mapping) for row in connection.execute(sa.select(entities))}
        assert after[healthy["id"]] == healthy
        expected = {**broken, "revision": 18,
                    "content_digest": hashlib.sha256(broken["definition"]).digest()}
        assert after[broken["id"]] == expected
        _run(connection, monkeypatch)
        assert {row.id: dict(row._mapping) for row in connection.execute(sa.select(entities))} == after
    engine.dispose()


@pytest.mark.parametrize("damage", ["unknown_digest", "size", "protobuf"])
def test_unknown_corruption_aborts_without_repairing_rows(monkeypatch, damage):
    engine = sa.create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        entities = _entities_table(connection)
        broken = _row()
        if damage == "unknown_digest":
            broken["content_digest"] = b"x" * 32
        elif damage == "size":
            broken["size_bytes"] += 1
        else:
            broken["definition"] = b"invalid protobuf"
            broken["size_bytes"] = len(broken["definition"])
        connection.execute(entities.insert(), [_row(), broken])
    with engine.connect() as connection:
        before = connection.execute(sa.select(entities)).fetchall()
        connection.rollback()
        with pytest.raises(RuntimeError), connection.begin():
            _run(connection, monkeypatch)
        assert connection.execute(sa.select(entities)).fetchall() == before
    engine.dispose()


def test_repaired_definition_is_downloadable_with_matching_digest(client, db, monkeypatch):
    owner = User(id="digest-owner", username="digest-owner")
    db.add(owner)
    db.commit()
    app.dependency_overrides[get_current_user] = lambda: owner
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    values = _row()
    values.update(world_id=world_id, owner_user_id=owner.id, name="Original root",
                  position_x_cm=0, position_y_cm=100, position_z_cm=0,
                  create_operation_id=str(uuid.uuid4()), create_request_digest=b"r" * 32)
    entity = SpaceWorldEntity(**values)
    db.add(entity)
    db.commit()
    path = f"/space/api/v2/worlds/{world_id}/entities/{entity.id}"
    response = client.get(path + "/definition")
    assert response.status_code == 500
    assert response.json()["detail"]["code"] == "WORLD_ENTITY_DEFINITION_CORRUPT"
    _run(db.connection(), monkeypatch)
    db.commit()
    db.expire_all()
    record = client.get(path).json()
    downloaded = client.get(record["definition_url"])
    assert downloaded.status_code == 200
    assert downloaded.content == values["definition"]
    assert len(downloaded.content) == record["definition_size_bytes"]
    assert hashlib.sha256(downloaded.content).hexdigest() == record["definition_digest"]
    assert record["revision"] == 18


def test_v6_migration_also_writes_exact_byte_download_digest(monkeypatch):
    migration = importlib.import_module("space.migrations.versions.0004_inventory_v7")
    resource = inventory_v6_pb2.InventoryResource(schema_version=6)
    resource.entity.root.id, resource.entity.root.name = "root", "Legacy named root"
    resource.entity.root.body.SetInParent()
    resource.entity.root.blocks.add(color=0x123456)
    legacy = resource.SerializeToString(deterministic=True)
    engine = sa.create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        entities = _entities_table(connection)
        sa.Table(
            "space_market_resources", sa.MetaData(),
            sa.Column("schema_version", sa.SmallInteger(), server_default="6"),
            sa.CheckConstraint("schema_version = 6", name="ck_space_market_resource_schema_version"),
        ).create(connection)
        values = _row()
        values.update(schema_version=6, definition=legacy, size_bytes=len(legacy))
        connection.execute(entities.insert(), values)
        monkeypatch.setattr(migration, "op", Operations(MigrationContext.configure(connection)))
        migration.upgrade()
        row = connection.execute(sa.select(entities)).one()
        assert row.content_digest == hashlib.sha256(row.definition).digest()
        assert row.size_bytes == len(row.definition)
        assert row.revision == 18
    engine.dispose()
