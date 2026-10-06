"""Fenced, expiring zone claims shared by API warmup and background workers."""
import datetime as dt
import uuid
from dataclasses import dataclass

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from space.models import SpaceSurfaceGenerationLease

LEASE_SECONDS = 600


def now():
    return dt.datetime.now(dt.timezone.utc)


@dataclass(frozen=True)
class SurfaceWorld:
    id: str
    seed: int
    terrain_generator_version: int
    width_chunks: int
    length_chunks: int
    zone_size_chunks: int

    @classmethod
    def capture(cls, world):
        return cls(**{field: getattr(world, field) for field in cls.__dataclass_fields__})


def claim_zone(db, world_id, zone_x, zone_z):
    """Atomically create or take over an expired claim, then end the transaction."""
    lease = SpaceSurfaceGenerationLease
    token = str(uuid.uuid4())
    timestamp = now()
    insert = pg_insert if db.get_bind().dialect.name == 'postgresql' else sqlite_insert
    statement = insert(lease).values(
        world_id=world_id, zone_x=zone_x, zone_z=zone_z, token=token,
        expires_at=timestamp + dt.timedelta(seconds=LEASE_SECONDS),
    )
    statement = statement.on_conflict_do_update(
        index_elements=[lease.world_id, lease.zone_x, lease.zone_z],
        set_={'token': statement.excluded.token, 'expires_at': statement.excluded.expires_at},
        where=lease.expires_at <= timestamp,
    )
    claimed = db.execute(statement).rowcount == 1
    db.commit()
    return token if claimed else None


def release_zone(db, world_id, zone_x, zone_z, token):
    # A delayed worker must never release its successor's claim.
    db.query(SpaceSurfaceGenerationLease).filter_by(
        world_id=world_id, zone_x=zone_x, zone_z=zone_z, token=token,
    ).delete(synchronize_session=False)
    db.commit()
