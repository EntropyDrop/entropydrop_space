import datetime as dt
import re
import uuid
from urllib.parse import urljoin, urlsplit

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from space import auth
from space import models
from space.main import app
from config import settings
from routers import space, space_agent, space_entities
from tests.test_space_external import setup


def save_position(db, user_id, world_id, *, age=1, state=None):
    position = {"x_cm": 744710, "y_cm": 1500, "z_cm": 55290,
                "yaw_q15": -12345, "pitch_q15": 678}
    snapshot = models.SpacePlayerSnapshot(world_id=world_id, user_id=user_id,
        revision=1, last_event_id=0, state_version=1,
        state=state if state is not None else space._encode_player_snapshot(position),
        updated_at=dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=age))
    db.add(snapshot)
    db.commit()
    return position






@pytest.mark.parametrize('age', [31, 7200, -60])
def test_stale_or_future_pose_is_explicit(client, db, age):
    owner, world, headers, _ = setup(client, db)
    save_position(db, owner.id, world, age=age)
    body = client.get('/space/api/v2/players/me/position', headers=headers).json()
    assert body['stale'] is True
    assert body['stale_after_seconds'] == 30
    assert body['age_seconds'] >= 0


@pytest.mark.parametrize('state', [None, b'not-json', b'{"position":{}}'])
def test_missing_or_corrupt_pose_never_spawns_or_returns_someone_else(client, db, state):
    owner, world, headers, _ = setup(client, db)
    if state is not None:
        save_position(db, owner.id, world, state=state)
    from tests.test_space_entities import _user
    other = _user(db, 'another-player')
    save_position(db, other.id, world)
    response = client.get('/space/api/v2/players/me/position?user_id=another-player', headers=headers)
    assert response.status_code == 404
    assert response.json()['detail']['code'] == 'PLAYER_POSITION_UNAVAILABLE'
    assert response.headers['cache-control'] == 'no-store'
    assert db.query(models.SpacePlayerSnapshot).filter_by(user_id=owner.id).count() == int(state is not None)




def test_public_markdown_links_work_without_auth_and_do_not_expose_files(client):
    def no_auth():
        raise AssertionError('Public docs must not authenticate')
    app.dependency_overrides[space_entities._entity_creator] = no_auth
    app.dependency_overrides[auth.get_current_user] = no_auth
    for name, (_, content_type) in space_agent.PUBLIC_FILES.items():
        response = client.get('/space/agent/' + name)
        assert response.status_code == 200
        assert response.headers['content-type'].startswith(content_type)
        assert response.headers['x-content-type-options'] == 'nosniff'
        assert response.headers['cache-control'].startswith('public')
        assert len(response.content) > 100
    for name, (_, content_type) in space_agent.PUBLIC_FILES.items():
        if content_type != 'text/markdown':
            continue
        url = '/space/agent/' + name
        document = client.get(url).text
        assert '[spaceAPI](' in document and '[entityAPI](' in document
        for target in re.findall(r'\]\(<?([^)>]+)>?\)', document):
            resolved = urlsplit(urljoin(url, target)).path
            if not target.startswith(('http:', 'https:')):
                assert resolved.startswith('/space/agent/'), (url, target)
                assert client.get(resolved).status_code == 200, (url, target)
    legacy = client.get('/space/agent/references/script-api-v2.md', follow_redirects=False)
    assert legacy.status_code == 308
    assert legacy.headers['location'] == '/space/agent/entityAPI.md'
    assert client.get(legacy.headers['location']).text.startswith('# entityAPI V2')
    for name in ['.env', 'references/../../.env', '%2e%2e%2f.env', 'references/private.py', 'missing.md']:
        assert client.get('/space/agent/' + name).status_code == 404

    entity_create = client.get('/space/agent/references/entity-create.md').text
    assert 'color_rgb=0xE58024' in entity_create
    assert 'color=0xE58024' not in entity_create


def test_standalone_identity_uses_remote_key_owner(client, db, monkeypatch):
    owner, world, headers, _ = setup(client, db)
    save_position(db, owner.id, world)
    calls = []
    def identity(db, credential, *, allow_api_key):
        calls.append((credential, allow_api_key))
        return owner, ['space:entity:create']
    app.dependency_overrides.pop(space_entities._entity_creator)
    monkeypatch.setattr(settings, 'SPACE_STANDALONE', True)
    monkeypatch.setattr(space_entities.auth, 'resolve_identity', identity, raising=False)
    response = client.get('/space/api/v2/players/me/position', headers=headers)
    assert response.status_code == 200
    assert calls == [(headers['Authorization'].removeprefix('Bearer '), True)]
