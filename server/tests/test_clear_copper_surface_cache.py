import pytest

from space import models
from tools.clear_copper_surface_cache import clear_copper_surface_cache


def test_clear_copper_cache_preserves_authored_chunks_and_other_worlds(db):
    copper = models.SpaceWorld(seed=20260922, terrain_generator_version=2)
    nature = models.SpaceWorld(seed=42, terrain_generator_version=1)
    db.add_all([copper, nature])
    db.flush()
    for world in (copper, nature):
        db.add(models.SpaceSurfaceZoneSnapshot(world_id=world.id, zone_x=16, zone_z=2,
            terrain_generator_version=world.terrain_generator_version, uncompressed_size=1,
            content_hash=b'x' * 32, payload=b'x'))
    edit = models.SpaceChunkSnapshot(world_id=copper.id, chunk_x=512, chunk_z=64,
        revision=8, last_event_id=27, codec=0, uncompressed_size=1,
        content_hash=b'e' * 32, payload=b'e')
    db.add(edit)
    db.commit()

    preview = clear_copper_surface_cache(db, 'development', copper.id, dry_run=True)
    assert preview['snapshots'] == 1
    assert db.query(models.SpaceSurfaceZoneSnapshot).count() == 2
    result = clear_copper_surface_cache(db, 'development', copper.id)
    assert result['snapshots'] == 1
    assert db.query(models.SpaceSurfaceZoneSnapshot).one().world_id == nature.id
    preserved = db.query(models.SpaceChunkSnapshot).one()
    assert (preserved.revision, preserved.last_event_id, preserved.payload) == (8, 27, b'e')
    assert db.query(models.SpaceWorld).count() == 2


@pytest.mark.parametrize('environment,version', [('production', 2), ('staging', 2), ('development', 1)])
def test_clear_copper_cache_rejects_wrong_environment_or_world(db, environment, version):
    world = models.SpaceWorld(seed=42, terrain_generator_version=version)
    db.add(world)
    db.commit()
    with pytest.raises(RuntimeError):
        clear_copper_surface_cache(db, environment, world.id)
