import pytest
import threading
import space_surface

def test_surface_manifest_warmup_starts_only_one_daemon(monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def fake_backfill():
        started.set()
        release.wait(timeout=2)

    monkeypatch.setattr(space_surface, "_generation_thread", None)
    monkeypatch.setattr(space_surface, "_run_surface_generation_until_current", fake_backfill)

    assert space_surface.ensure_surface_generation_started() is True
    assert started.wait(timeout=1)
    assert space_surface.ensure_surface_generation_started() is False

    release.set()
    space_surface._generation_thread.join(timeout=1)
    assert space_surface._generation_thread.is_alive() is False


def test_background_job_retries_failure_without_waiting_for_a_client(monkeypatch):
    import asyncio
    calls = []
    def generate():
        calls.append(True)
        if len(calls) == 1:
            raise RuntimeError('temporary database failure')
        return False
    async def sleep(_):
        if len(calls) == 2:
            raise asyncio.CancelledError
    monkeypatch.setattr(space_surface, 'generate_next_surface_zone', generate)
    monkeypatch.setattr(space_surface.asyncio, 'sleep', sleep)
    async def run():
        try:
            await space_surface.start_surface_snapshot_job()
        except asyncio.CancelledError:
            pass
    asyncio.run(run())
    assert len(calls) == 2


def test_migration_prioritizes_authored_zones_before_untouched_terrain(db, monkeypatch):
    from space import models
    world = models.SpaceWorld(seed=42)
    db.add(world)
    db.flush()
    for x, rev in [(0, 0), (29, 1237)]:
        db.add(models.SpaceSurfaceZoneSnapshot(world_id=world.id, zone_x=x, zone_z=1,
            schema_version=3, samples_per_chunk_axis=8, terrain_generator_version=1,
            source_terrain_revision=rev, uncompressed_size=1, content_hash=b'x'*32, payload=b'x'))
    db.commit()
    visited = []
    monkeypatch.setattr(space_surface, 'SessionLocal', lambda: db)
    monkeypatch.setattr(space_surface, 'generate_surface_zone', lambda session, w, x, z: visited.append((x,z)))
    assert space_surface.generate_next_surface_zone() is True
    assert visited == [(29,1)]


@pytest.mark.parametrize("version", [2, 3, 4, 5, 6, 7, 8])
def test_development_world_backfill_starts_at_spawn(db, monkeypatch, version):
    from space import models
    world = models.SpaceWorld(seed=20260922, terrain_generator_version=version)
    db.add(world)
    db.commit()
    visited = []
    monkeypatch.setattr(space_surface, 'SessionLocal', lambda: db)
    monkeypatch.setattr(
        space_surface,
        'generate_surface_zone',
        lambda session, selected, x, z: visited.append((x, z)),
    )
    assert space_surface.generate_next_surface_zone() is True
    assert visited == [(16, 2)]


def test_standalone_api_runs_surface_job_for_its_lifetime(monkeypatch):
    import asyncio
    from space import main
    stopped = []
    async def verify():
        started = asyncio.Event()
        async def job():
            started.set()
            try:
                await asyncio.Future()
            finally:
                stopped.append(True)
        monkeypatch.setattr(space_surface, 'start_surface_snapshot_job', job)
        monkeypatch.setattr(main.metrics_collector, 'start', lambda: None)
        monkeypatch.setattr(main.metrics_collector, 'stop', lambda: None)
        async with main.lifespan(main.app):
            await asyncio.wait_for(started.wait(), 1)
        assert stopped == [True]
    asyncio.run(verify())


def test_completed_world_residency_scan_never_loads_geometry_blobs(db, monkeypatch):
    from sqlalchemy import event
    from space import models
    world = models.SpaceWorld(seed=42, width_chunks=64, length_chunks=64, zone_size_chunks=32)
    db.add(world)
    db.flush()
    for x in range(2):
        for z in range(2):
            db.add(models.SpaceSurfaceZoneSnapshot(world_id=world.id, zone_x=x, zone_z=z,
                schema_version=7, samples_per_chunk_axis=16, terrain_generator_version=1,
                uncompressed_size=1, content_hash=b'x'*32, payload=b'large-geometry',
                lod_payload=b'large-mip-ladder', lod_manifest=[]))
    db.commit()
    selected = []
    def capture(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith('SELECT') and 'space_surface_zone_snapshots' in statement:
            selected.append(statement.split('FROM')[0])
    engine = db.get_bind()
    event.listen(engine, 'before_cursor_execute', capture)
    monkeypatch.setattr(space_surface, 'SessionLocal', lambda: db)
    try:
        assert space_surface.generate_next_surface_zone() is False
    finally:
        event.remove(engine, 'before_cursor_execute', capture)
    assert len(selected) == 2
    assert all('payload' not in statement and 'lod_manifest' not in statement for statement in selected)
