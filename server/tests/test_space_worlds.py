import base64
import datetime as dt
import uuid

import pytest

from config import settings
from routers import space
from space import models
from space.inventory_codec import encode_inventory_resource
from tests.conftest import mock_account_key
from tests.test_space_agent import save_position
from tests.test_space_entities import _entity, _user
from tests.test_space_external import body as blockset_body


def connection(db):
    owner = _user(db, 'world-agent')
    key = mock_account_key(owner, [])
    return owner, {'Authorization': 'Bearer ' + key['api_key']}


def join(client, headers, selector):
    response = client.post(f'/space/api/v2/worlds/{selector}/join', headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_catalog_requires_authentication(client):
    assert client.get('/space/api/v2/worlds').status_code == 401
    assert client.get('/space/api/v2/worlds/nature').status_code == 401
    assert client.post('/space/api/v2/worlds/nature/join').status_code == 401


def test_discovery_resolves_names_without_creating_worlds_or_memberships(client, db):
    _, headers = connection(db)
    response = client.get('/space/api/v2/worlds', headers=headers)
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    catalog = response.json()
    assert catalog['default_world_id'] == settings.SPACE_DEFAULT_WORLD_ID
    worlds = {world['slug']: world for world in catalog['worlds']}
    assert worlds['nature']['name'] == 'Nature'
    assert worlds['nature']['aliases'] == ['default']
    assert worlds['nature']['is_default'] is True
    copper = worlds['copper-metropolis']
    assert copper['name'] == 'Copper Metropolis'
    assert copper['joined'] is False and copper['position_available'] is False
    assert (copper['width_cm'], copper['height_cm'], copper['length_cm']) == (1638400, 25600, 204800)
    for selector in ['Copper-Metropolis', copper['id']]:
        assert client.get(f'/space/api/v2/worlds/{selector}', headers=headers).json() == copper
    assert db.query(models.SpaceWorld).count() == 0
    assert db.query(models.SpaceWorldPlayerProfile).count() == 0


def test_api_key_join_is_idempotent_and_does_not_invent_a_player_position(client, db):
    owner, headers = connection(db)
    copper = join(client, headers, 'copper-metropolis')
    assert copper['joined'] is True and copper['position_available'] is False
    assert join(client, headers, copper['id']) == copper
    assert db.query(models.SpaceWorldPlayerProfile).filter_by(user_id=owner.id).count() == 1
    assert db.query(models.SpacePlayerSnapshot).count() == 0
    unavailable = client.get('/space/api/v2/players/me/position?world=copper-metropolis', headers=headers)
    assert unavailable.status_code == 404
    assert unavailable.json()['detail']['code'] == 'PLAYER_POSITION_UNAVAILABLE'


def test_selected_positions_never_fall_back_to_a_different_world(client, db):
    owner, headers = connection(db)
    nature, copper = (join(client, headers, name) for name in ['nature', 'copper-metropolis'])
    save_position(db, owner.id, nature['id'])
    assert client.get('/space/api/v2/players/me/position?world=copper-metropolis', headers=headers).status_code == 404
    position = save_position(db, owner.id, copper['id'], age=7200)
    position['x_cm'] = 820000
    snapshot = db.get(models.SpacePlayerSnapshot, (copper['id'], owner.id))
    snapshot.state = space._encode_player_snapshot(position)
    snapshot.updated_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)
    db.commit()
    for path in [f"/worlds/{copper['id']}/players/me/position", '/worlds/copper-metropolis/players/me/position',
                 '/players/me/position?world=copper-metropolis']:
        response = client.get('/space/api/v2' + path, headers=headers)
        assert response.status_code == 200, response.text
        pose = response.json()
        assert pose['world_id'] == copper['id'] and pose['world_slug'] == 'copper-metropolis'
        assert pose['world_name'] == 'Copper Metropolis' and pose['position']['x_cm'] == 820000
        assert pose['stale'] is True
    for selector in ['', '?world=nature', '?world=default']:
        pose = client.get('/space/api/v2/players/me/position' + selector, headers=headers).json()
        assert pose['world_id'] == nature['id'] and pose['position']['x_cm'] == 744710


def test_membership_is_required_until_explicit_join(client, db):
    _, headers = connection(db)
    space._get_or_create_bootstrap_world(db, 'copper-metropolis')
    response = client.get('/space/api/v2/players/me/position?world=copper-metropolis', headers=headers)
    assert response.status_code == 403
    assert response.json()['detail']['code'] == 'WORLD_MEMBERSHIP_REQUIRED'
    assert db.query(models.SpaceWorldPlayerProfile).count() == 0


@pytest.mark.parametrize('selector', ['missing-world', str(uuid.uuid4())])
def test_unknown_world_never_joins_or_falls_back(client, db, selector):
    _, headers = connection(db)
    for path, method in [(f'/worlds/{selector}', 'get'), (f'/worlds/{selector}/join', 'post'),
                         (f'/players/me/position?world={selector}', 'get')]:
        response = getattr(client, method)('/space/api/v2' + path, headers=headers)
        assert response.status_code == 404
        assert response.json()['detail']['code'] == 'WORLD_NOT_FOUND'
    assert db.query(models.SpaceWorld).count() == 0
    assert db.query(models.SpaceWorldPlayerProfile).count() == 0


def test_development_worlds_remain_unavailable_in_production_even_with_old_membership(client, db, monkeypatch):
    _, headers = connection(db)
    copper = join(client, headers, 'copper-metropolis')
    monkeypatch.setattr(settings, 'ENVIRONMENT', 'production')
    catalog = client.get('/space/api/v2/worlds', headers=headers).json()
    assert [world['slug'] for world in catalog['worlds']] == ['nature']
    for selector in ['copper-metropolis', copper['id']]:
        assert client.get(f'/space/api/v2/worlds/{selector}', headers=headers).status_code == 404
        assert client.post(f'/space/api/v2/worlds/{selector}/join', headers=headers).status_code == 404
        assert client.get(f'/space/api/v2/players/me/position?world={selector}', headers=headers).status_code == 404


def test_entities_and_blocksets_are_isolated_between_worlds_with_same_operation_and_coordinates(client, db):
    _, headers = connection(db)
    nature, copper = (join(client, headers, name) for name in ['nature', 'copper-metropolis'])
    payload = {'operation_id': str(uuid.uuid4()), 'desired_run_state': 'stopped',
               'definition_base64': base64.b64encode(encode_inventory_resource('entity', _entity())).decode(),
               'position': {'x_cm': 16000, 'y_cm': 22000, 'z_cm': 16000}, 'yaw_quarter_turns': 0}
    entity_ids = []
    build = blockset_body()
    for world in [nature, copper]:
        prefix = f"/space/api/v2/worlds/{world['id']}"
        created = client.post(prefix + '/entities', json=payload, headers=headers)
        assert created.status_code == 201, created.text
        entity_ids.append(created.json()['id'])
        assert client.post(prefix + '/entities', json=payload, headers=headers).json() == created.json()
        built = client.post(prefix + '/blocksets/build', json=build, headers=headers)
        assert built.status_code == 201, built.text
        usage = client.get(prefix + '/api-usage', headers=headers).json()
        assert usage['world_id'] == world['id'] and usage['quotas']['entities']['used'] == 1
    assert entity_ids[0] != entity_ids[1]
    wrong = client.get(f"/space/api/v2/worlds/{copper['id']}/entities/{entity_ids[0]}/configuration", headers=headers)
    assert wrong.status_code == 404
    assert {row.world_id for row in db.query(models.SpaceChunkSnapshot).all()} == {nature['id'], copper['id']}
    assert db.query(models.SpaceWorldEntity).count() == 2
    assert db.query(models.SpacePlayerSnapshot).count() == 0


def test_nature_alias_retains_existing_default_world_and_preserves_custom_names(client, db):
    _, headers = connection(db)
    world = models.SpaceWorld(id=settings.SPACE_DEFAULT_WORLD_ID, name='EntropyDrop Space', seed=42)
    db.add(world)
    db.commit()
    selected = join(client, headers, 'default')
    assert selected['id'] == settings.SPACE_DEFAULT_WORLD_ID and selected['name'] == 'Nature'
    assert selected['slug'] == 'nature' and selected['seed'] == 42
    world.name = 'Our nature world'
    db.commit()
    assert join(client, headers, 'nature')['name'] == 'Our nature world'
    assert db.query(models.SpaceWorld).count() == 1


def test_catalog_only_exposes_custom_worlds_the_account_has_joined(client, db):
    owner, headers = connection(db)
    joined, private = str(uuid.uuid4()), str(uuid.uuid4())
    db.add_all([models.SpaceWorld(id=joined, name='Existing world', seed=42),
                models.SpaceWorld(id=private, name='Private world', seed=99)])
    db.add(models.SpaceWorldPlayerProfile(world_id=joined, user_id=owner.id))
    db.commit()
    catalog = client.get('/space/api/v2/worlds', headers=headers).json()['worlds']
    custom = next(world for world in catalog if world['id'] == joined)
    assert custom['slug'] is None and custom['joined'] is True
    assert all(world['id'] != private for world in catalog)
    assert client.get(f'/space/api/v2/worlds/{private}', headers=headers).status_code == 404
    assert client.post(f'/space/api/v2/worlds/{private}/join', headers=headers).status_code == 404
