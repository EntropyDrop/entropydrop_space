import datetime as dt
import hashlib
import importlib

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import Session

from space import models, surface_jobs
import space_surface


def test_zone_claims_are_exclusive_and_expired_workers_cannot_release_successors(db):
    world = models.SpaceWorld(seed=42)
    db.add(world)
    db.commit()
    world_id = world.id
    first = surface_jobs.claim_zone(db, world_id, 0, 0)
    assert first and not db.in_transaction()
    with Session(db.get_bind()) as other:
        assert surface_jobs.claim_zone(other, world_id, 0, 0) is None
        assert surface_jobs.claim_zone(other, world_id, 1, 0)
        other.query(models.SpaceSurfaceGenerationLease).filter_by(world_id=world_id, zone_x=0).update({
            'expires_at': surface_jobs.now() - dt.timedelta(seconds=1),
        })
        other.commit()
        successor = surface_jobs.claim_zone(other, world_id, 0, 0)
    assert successor and successor != first
    surface_jobs.release_zone(db, world_id, 0, 0, first)
    assert db.get(models.SpaceSurfaceGenerationLease, (world_id, 0, 0)).token == successor


@pytest.mark.parametrize('change', ['none', 'terrain', 'world', 'lease', 'failure'])
def test_generation_has_no_open_transaction_and_fences_stale_results(db, monkeypatch, change):
    world = models.SpaceWorld(seed=42)
    db.add(world)
    db.commit()
    world_id = world.id
    successor = None

    def generate(*args):
        nonlocal successor
        assert not db.in_transaction(), 'Expensive generation must release its read transaction'
        with Session(db.get_bind()) as other:
            if change == 'terrain':
                payload = b'{"standard":[],"micro":[]}'
                other.add(models.SpaceChunkSnapshot(world_id=world_id, chunk_x=0, chunk_z=0,
                    revision=1, last_event_id=1, codec=0, uncompressed_size=len(payload),
                    content_hash=hashlib.sha256(payload).digest(), payload=payload))
            elif change == 'world':
                other.get(models.SpaceWorld, world_id).seed += 1
            elif change == 'lease':
                other.query(models.SpaceSurfaceGenerationLease).update({
                    'expires_at': surface_jobs.now() - dt.timedelta(seconds=1),
                })
            other.commit()
            if change == 'lease':
                successor = surface_jobs.claim_zone(other, world_id, 0, 0)
        if change == 'failure':
            raise RuntimeError('generation failed')
        return b'volume'

    def lods(raw):
        assert not db.in_transaction(), 'LOD construction must also run outside a transaction'
        return [], b'lods'

    monkeypatch.setattr(space_surface, '_terrain_runtime_payload', generate)
    monkeypatch.setattr(space_surface, 'build_surface_zone_payload', lambda *args, **kwargs: b'surface')
    monkeypatch.setattr(space_surface, 'build_surface_lods', lods)
    if change == 'failure':
        with pytest.raises(RuntimeError, match='generation failed'):
            space_surface.generate_surface_zone(db, world, 0, 0)
    else:
        result = space_surface.generate_surface_zone(db, world, 0, 0)
        assert (result is not None) == (change == 'none')
    assert db.query(models.SpaceSurfaceZoneSnapshot).count() == (1 if change == 'none' else 0)
    lease = db.get(models.SpaceSurfaceGenerationLease, (world_id, 0, 0))
    assert (lease.token if lease else None) == successor


def test_surface_lease_migration_is_reversible(monkeypatch):
    migration = importlib.import_module('space.migrations.versions.0012_surface_generation_leases')
    engine = create_engine('sqlite:///:memory:')
    with engine.begin() as connection:
        models.SpaceWorld.__table__.create(connection)
        monkeypatch.setattr(migration, 'op', Operations(MigrationContext.configure(connection)))
        migration.upgrade()
        assert inspect(connection).get_pk_constraint('space_surface_generation_leases')['constrained_columns'] == [
            'world_id', 'zone_x', 'zone_z',
        ]
        migration.downgrade()
        assert not inspect(connection).has_table('space_surface_generation_leases')
    engine.dispose()
