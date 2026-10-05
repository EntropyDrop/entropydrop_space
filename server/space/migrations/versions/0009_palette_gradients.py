"""Upgrade stored entities to inventory v8 and admit v8 market resources.

Inventory v8 is wire-compatible for entities and block sets, and adds gradient
palette entries to color sets. World entity definitions are rewritten in this
transaction. Market object bytes are migrated separately by
``python -m space.migrate_market_v8`` because Alembic must not perform object
store I/O inside its database transaction.
"""
import hashlib

from alembic import op
import sqlalchemy as sa

from space.inventory_v7 import convert_v7_inventory_resource

revision = "space_0009"
down_revision = "space_0008"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    entities = sa.table(
        "space_world_entities",
        sa.column("world_id", sa.Uuid(as_uuid=False)),
        sa.column("id", sa.Uuid(as_uuid=False)),
        sa.column("schema_version", sa.SmallInteger()),
        sa.column("definition", sa.LargeBinary()),
        sa.column("content_digest", sa.LargeBinary()),
        sa.column("size_bytes", sa.Integer()),
        sa.column("revision", sa.BigInteger()),
    )
    rows = bind.execute(sa.select(
        entities.c.world_id,
        entities.c.id,
        entities.c.schema_version,
        entities.c.definition,
        entities.c.revision,
    )).fetchall()
    for world_id, entity_id, schema_version, definition, revision in rows:
        version = int(schema_version)
        if version == 8:
            continue
        if version != 7:
            raise RuntimeError(
                f"Entity {entity_id} has unsupported inventory schema version {version}"
            )
        kind, _portable, canonical, _resource_digest = convert_v7_inventory_resource(bytes(definition))
        if kind != "entity":
            raise RuntimeError(f"Entity {entity_id} is not an entity inventory resource")
        bind.execute(
            entities.update()
            .where(entities.c.world_id == world_id, entities.c.id == entity_id)
            .values(
                definition=canonical,
                content_digest=hashlib.sha256(canonical).digest(),
                size_bytes=len(canonical),
                revision=int(revision) + 1,
                schema_version=8,
            )
        )

    with op.batch_alter_table("space_market_resources") as batch:
        batch.drop_constraint("ck_space_market_resource_schema_version", type_="check")
        batch.alter_column("schema_version", existing_type=sa.SmallInteger(), server_default="8")
        batch.create_check_constraint(
            "ck_space_market_resource_schema_version", "schema_version IN (6, 7, 8)"
        )
    with op.batch_alter_table("space_world_entities") as batch:
        batch.alter_column("schema_version", existing_type=sa.SmallInteger(), server_default="8")


def downgrade():
    raise RuntimeError(
        "Inventory v8 entity definitions and gradient palettes cannot be downgraded; "
        "restore the pre-release backup"
    )
