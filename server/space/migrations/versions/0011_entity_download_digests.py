"""Repair world download digests written as name-free Market resource digests.

Only the known legacy mismatch is repaired. Definition bytes, names, snapshots,
and Market deduplication digests are preserved; unknown corruption aborts the
transaction. Revisions increase so connected clients refetch the definitions.
"""
import hashlib

from alembic import op
from google.protobuf.message import DecodeError
import sqlalchemy as sa

from space.contracts import inventory_pb2

revision = "space_0011"
down_revision = "space_0010"
branch_labels = None
depends_on = None


def _legacy_digest(definition: bytes) -> bytes:
    resource = inventory_pb2.InventoryResource()
    try:
        resource.ParseFromString(definition)
    except DecodeError as error:
        raise RuntimeError("Entity definition is not valid Protobuf") from error
    if resource.schema_version != 8 or resource.WhichOneof("content") != "entity":
        raise RuntimeError("Expected a schema v8 entity definition")
    # Work on the stored wire message: re-encoding through the current codec can
    # add defaults that were absent when the legacy digest was calculated.
    pending = [resource.entity.root]
    while pending:
        component = pending.pop()
        component.ClearField("name")
        pending.extend(component.children)
    return hashlib.sha256(resource.SerializeToString(deterministic=True)).digest()


def upgrade():
    bind = op.get_bind()
    entities = sa.table(
        "space_world_entities",
        sa.column("world_id", sa.Uuid(as_uuid=False)),
        sa.column("id", sa.Uuid(as_uuid=False)),
        sa.column("definition", sa.LargeBinary()),
        sa.column("content_digest", sa.LargeBinary()),
        sa.column("size_bytes", sa.Integer()),
        sa.column("revision", sa.BigInteger()),
    )
    # Lock before reading to avoid replacing a concurrent checkpoint's digest.
    rows = bind.execute(sa.select(entities).with_for_update()).fetchall()
    for row in rows:
        definition = bytes(row.definition)
        if len(definition) != row.size_bytes:
            raise RuntimeError(f"Entity {row.id} has an unexpected definition size")
        digest = hashlib.sha256(definition).digest()
        if digest == bytes(row.content_digest):
            continue
        if _legacy_digest(definition) != bytes(row.content_digest):
            raise RuntimeError(f"Entity {row.id} has an unrecognized definition digest")
        bind.execute(
            entities.update()
            .where(entities.c.world_id == row.world_id, entities.c.id == row.id)
            .values(content_digest=digest, revision=int(row.revision) + 1)
        )


def downgrade():
    # Earlier APIs already require exact-byte hashes; retaining the repaired
    # metadata is compatible and avoids restoring the download failure.
    pass
