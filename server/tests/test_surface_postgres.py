"""Optional real-lock checks: SPACE_TEST_POSTGRES_URL must name a test database."""
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from space import models, surface_jobs
from space.database import Base
from routers.space import _require_world_membership
import space_surface


@pytest.fixture
def postgres():
    url = os.getenv('SPACE_TEST_POSTGRES_URL')
    if not url:
        pytest.skip('Set SPACE_TEST_POSTGRES_URL for PostgreSQL lock tests')
    base = create_engine(url)
    schema = 'space_test_' + uuid.uuid4().hex
    with base.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA {schema}'))
    engine = base.execution_options(schema_translate_map={None: schema})
    try:
        Base.metadata.create_all(engine)
        with Session(engine) as db:
            db.add(models.User(id='lock-user'))
            world = models.SpaceWorld(seed=1)
            db.add(world)
            db.flush()
            world_id = world.id
            db.add(models.SpaceWorldPlayerProfile(world_id=world_id, user_id='lock-user'))
            db.commit()
        yield engine, world_id
    finally:
        with base.begin() as connection:
            connection.execute(text(f'DROP SCHEMA {schema} CASCADE'))
        base.dispose()


def test_postgres_read_membership_does_not_wait_on_world_writer(postgres):
    engine, world_id = postgres
    user = SimpleNamespace(id='lock-user')
    with Session(engine) as writer, Session(engine) as reader:
        _require_world_membership(writer, world_id, user, for_update=True)
        reader.execute(text("SET LOCAL lock_timeout = '300ms'"))
        assert _require_world_membership(reader, world_id, user).id == world_id
        # Verify the held lock is real and that explicit mutations still wait.
        with pytest.raises(OperationalError, match='lock timeout'):
            _require_world_membership(reader, world_id, user, for_update=True)


def test_postgres_simultaneous_claims_have_one_winner(postgres):
    engine, world_id = postgres
    barrier = threading.Barrier(2)
    def claim():
        with Session(engine) as db:
            barrier.wait(timeout=5)
            return surface_jobs.claim_zone(db, world_id, 0, 0)
    with ThreadPoolExecutor(max_workers=2) as workers:
        first, second = workers.submit(claim), workers.submit(claim)
        tokens = [first.result(timeout=5), second.result(timeout=5)]
    assert sum(token is not None for token in tokens) == 1


def test_postgres_generation_allows_reads_and_rejects_concurrent_world_change(postgres, monkeypatch):
    engine, world_id = postgres
    started, release = threading.Event(), threading.Event()
    def generate(*args):
        started.set()
        assert release.wait(timeout=5)
        return b'volume'
    monkeypatch.setattr(space_surface, '_terrain_runtime_payload', generate)
    monkeypatch.setattr(space_surface, 'build_surface_zone_payload', lambda *args, **kwargs: b'surface')
    monkeypatch.setattr(space_surface, 'build_surface_lods', lambda raw: ([], b'lods'))
    def worker():
        with Session(engine) as db:
            return space_surface.generate_surface_zone(db, db.get(models.SpaceWorld, world_id), 0, 0)
    with ThreadPoolExecutor(max_workers=1) as workers:
        result = workers.submit(worker)
        try:
            assert started.wait(timeout=5)
            with Session(engine) as db:
                db.execute(text("SET LOCAL lock_timeout = '300ms'"))
                world = _require_world_membership(db, world_id, SimpleNamespace(id='lock-user'), for_update=True)
                world.seed += 1
                db.commit()
                assert surface_jobs.claim_zone(db, world_id, 0, 0) is None
                assert surface_jobs.claim_zone(db, world_id, 1, 0)
        finally:
            release.set()
        assert result.result(timeout=5) is None
    with Session(engine) as db:
        assert db.query(models.SpaceSurfaceZoneSnapshot).count() == 0
