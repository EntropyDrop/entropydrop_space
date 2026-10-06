import hashlib
import json
import uuid

import pytest

from space import models, release_check
from space.inventory_codec import encode_inventory_resource, inventory_content_digest


@pytest.fixture
def entity(db):
    spec = release_check.configured_worlds()[0]
    owner = models.User(id='release-owner', username='release-owner')
    world = models.SpaceWorld(id=spec.id, name=spec.name, seed=spec.seed,
                              terrain_generator_version=spec.terrain_generator_version)
    db.add_all([owner, world])
    db.flush()
    portable = {'type': 'space-entity', 'version': 8, 'root': {
        'id': 'root', 'name': 'Named entity', 'body': {'type': 'dynamic'},
        'blocks': [{'dx': 0, 'dy': 0, 'dz': 0, 'block': 1, 'color': 0x123456}],
        'children': [], 'seats': [],
    }, 'constraints': []}
    definition = encode_inventory_resource('entity', portable)
    snapshot = json.dumps({'position': [1, 2, 3]}).encode()
    row = models.SpaceWorldEntity(
        world_id=world.id, owner_user_id=owner.id, name='Named entity',
        definition=definition, content_digest=hashlib.sha256(definition).digest(),
        size_bytes=len(definition), snapshot=snapshot, snapshot_size_bytes=len(snapshot),
        snapshot_digest=hashlib.sha256(snapshot).digest(),
        position_x_cm=100, position_y_cm=200, position_z_cm=300,
        create_operation_id=str(uuid.uuid4()), create_request_digest=b'r' * 32,
    )
    db.add(row)
    db.commit()
    return row, portable


def check(db):
    return release_check.check_data(db, ['nature', 'copper-metropolis', 'aether-archipelago'])


def test_checks_existing_entities_without_writing_or_provisioning_worlds(db, entity):
    row, _ = entity
    before = (row.definition, row.snapshot, row.revision, row.updated_at)
    assert check(db) == {'worlds_verified': ['nature', 'copper-metropolis', 'aether-archipelago'], 'entity_downloads_verified': 1}
    assert db.query(models.SpaceWorld).count() == 1
    assert not db.dirty and not db.new and not db.deleted
    assert (row.definition, row.snapshot, row.revision, row.updated_at) == before


def test_name_free_migration_digest_is_rejected_even_when_service_can_start(db, entity):
    row, portable = entity
    row.content_digest = inventory_content_digest('entity', portable)
    db.commit()
    with pytest.raises(RuntimeError, match='invalid download metadata'):
        check(db)


@pytest.mark.parametrize('damage', ['schema', 'size', 'protobuf', 'kind', 'snapshot_digest', 'snapshot_size',
                                  'snapshot_json', 'missing_snapshot'])
def test_rejects_incomplete_or_unreadable_downloads(db, entity, damage):
    row, _ = entity
    if damage == 'schema':
        row.schema_version = 7
    elif damage == 'size':
        row.size_bytes += 1
    elif damage in ('protobuf', 'kind'):
        row.definition = b'invalid protobuf' if damage == 'protobuf' else encode_inventory_resource(
            'blockset', {'type': 'space-blockset', 'version': 8, 'name': 'wrong kind',
                         'blocks': [{'dx': 0, 'dy': 0, 'dz': 0, 'block': 1, 'color': 0x123456}]})
        row.content_digest = hashlib.sha256(row.definition).digest()
        row.size_bytes = len(row.definition)
    elif damage == 'snapshot_digest':
        row.snapshot_digest = b'x' * 32
    elif damage == 'snapshot_size':
        row.snapshot_size_bytes += 1
    elif damage == 'snapshot_json':
        row.snapshot = b'[]'
        row.snapshot_digest = hashlib.sha256(row.snapshot).digest()
        row.snapshot_size_bytes = len(row.snapshot)
    else:
        row.snapshot = None
    db.commit()
    with pytest.raises(RuntimeError):
        check(db)


def test_unpublished_copper_blocks_release_before_bootstrap_can_fail(db, monkeypatch):
    specs = release_check.configured_worlds()
    monkeypatch.setattr(release_check, 'configured_worlds', lambda: specs[:1])
    with pytest.raises(RuntimeError, match='unavailable: copper-metropolis'):
        check(db)


def test_unpublished_aether_blocks_release(db, monkeypatch):
    specs = tuple(spec for spec in release_check.configured_worlds() if spec.slug != 'aether-archipelago')
    monkeypatch.setattr(release_check, 'configured_worlds', lambda: specs)
    with pytest.raises(RuntimeError, match='unavailable: aether-archipelago'):
        check(db)


def test_unprovisioned_worlds_are_valid_without_creating_production_data(db):
    assert check(db)['entity_downloads_verified'] == 0
    assert db.query(models.SpaceWorld).count() == 0


@pytest.mark.parametrize('field', ['seed', 'terrain_generator_version', 'status'])
def test_stored_world_mismatch_blocks_release(db, entity, field):
    world = db.query(models.SpaceWorld).one()
    setattr(world, field, getattr(world, field) + 1)
    db.commit()
    with pytest.raises(RuntimeError, match='does not match stored data: nature'):
        check(db)
