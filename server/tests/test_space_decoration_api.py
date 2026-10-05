import base64
import hashlib
import uuid

import pytest

from space import models
from space.inventory_codec import encode_inventory_resource
from tests.test_space_entities import _entity
from tests.test_space_entity_configuration import configured, edit, command


def request(ops, revision=1, component='root'):
    return edit(revision, [{'id': component, 'decoration_ops': ops}])


def test_decoration_crud_preserves_physics_and_merges_partial_updates(client, db, configured):
    url, keys, _ = configured
    headers = keys['basic']
    before = client.get(url+'/configuration', headers=headers).json()['definition']
    payload = request([{'op': 'upsert', 'id': 'trim', 'position': [2, 1, 0],
                        'scale': [2, 0.1, 1], 'color': 0xFF0000, 'materialId': 1}])
    first = client.patch(url+'/configuration', headers=headers, json=payload)
    assert first.status_code == 200, first.text
    assert first.json()['revision'] == 2
    assert client.patch(url+'/configuration', headers=headers, json=payload).json() == first.json()
    assert client.patch(url+'/configuration', headers=headers, json=request([
        {'op': 'upsert', 'id': 'trim', 'position': [0, 0, 0], 'rotation': [0, 0, 0, -1]},
    ], 2)).status_code == 200
    after = client.get(url+'/configuration', headers=headers).json()['definition']
    assert after['root'].pop('decorations') == [
        {'id': 'trim', 'scale': [2, 0.1, 1], 'color': 0xFF0000, 'materialId': 1}]
    assert after == before
    entity = db.query(models.SpaceWorldEntity).one()
    assert bytes(entity.content_digest) == hashlib.sha256(bytes(entity.definition)).digest()
    assert entity.size_bytes == len(entity.definition)
    assert client.patch(url+'/configuration', headers=headers, json=request([
        {'op': 'remove', 'id': 'trim'}], 3)).status_code == 200
    assert not client.get(url+'/configuration', headers=headers).json()['definition']['root'].get('decorations')


@pytest.mark.parametrize('ops', [
    [], [{'op': 'remove', 'id': 'missing'}],
    [{'op': 'upsert', 'id': 'bad space'}],
    [{'op': 'upsert', 'id': 'trim', 'scale': [0, 1, 1]}],
    [{'op': 'upsert', 'id': 'trim', 'scale': [1, 1, 257]}],
    [{'op': 'upsert', 'id': 'trim', 'position': [513, 0, 0]}],
    [{'op': 'upsert', 'id': 'trim', 'position': [True, 0, 0]}],
    [{'op': 'upsert', 'id': 'trim', 'rotation': [0, 0, 0, 0]}],
    [{'op': 'upsert', 'id': 'trim', 'color': True}],
    [{'op': 'upsert', 'id': 'trim', 'color': 0x1000000}],
    [{'op': 'upsert', 'id': 'trim', 'materialId': 2}],
    [{'op': 'upsert', 'id': 'trim', 'scale': None}],
    [{'op': 'upsert', 'id': 'trim', 'unknown': 1}],
    [{'op': 'remove', 'id': 'trim', 'position': [0, 0, 0]}],
    [{'op': 'upsert', 'id': 'trim'}, {'op': 'remove', 'id': 'trim'}],
])
def test_decoration_invalid_requests_are_atomic(client, db, configured, ops):
    url, keys, _ = configured
    entity = db.query(models.SpaceWorldEntity).one()
    before = bytes(entity.definition)
    payload = request(ops)
    payload['components'][0]['body'] = {'mass': 99}
    response = client.patch(url+'/configuration', headers=keys['full'], json=payload)
    assert response.status_code == 422, response.text
    db.refresh(entity)
    assert entity.revision == 1 and bytes(entity.definition) == before


def test_decoration_revision_running_hosted_and_occupancy_guards(client, db, configured):
    import datetime
    url, keys, owner = configured
    headers = keys['full']
    payload = request([{'op': 'upsert', 'id': 'trim'}])
    conflict = client.patch(url+'/configuration', headers=headers, json={**payload, 'expected_revision': 5})
    assert conflict.json()['detail']['code'] == 'ENTITY_REVISION_CONFLICT'
    assert client.put(url+'/run-state', headers=headers, json=command('running', 1)).status_code == 200
    running = client.patch(url+'/configuration', headers=headers, json={**payload, 'expected_revision': 2})
    assert running.json()['detail']['code'] == 'ENTITY_MUST_BE_STOPPED'
    assert client.put(url+'/run-state', headers=headers, json=command('stopped', 2)).status_code == 200
    entity = db.query(models.SpaceWorldEntity).one()
    entity.execution_mode = 'hosted'
    db.commit()
    hosted = client.patch(url+'/configuration', headers=headers, json={**payload, 'expected_revision': 3})
    assert hosted.json()['detail']['code'] == 'ENTITY_HOSTED_EDIT_FORBIDDEN'
    entity.execution_mode = 'browser'
    entity.execution_instance_id = str(uuid.uuid4())
    entity.execution_user_id = owner.id
    entity.execution_lease_expires_at = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=1)
    db.commit()
    occupied = client.patch(url+'/configuration', headers=headers, json={**payload, 'expected_revision': 3})
    assert occupied.json()['detail']['code'] == 'ENTITY_OCCUPIED'


def test_component_local_ids_and_entity_wide_decoration_limit(client, db, configured):
    url, keys, _ = configured
    headers = keys['full']
    definition = _entity()
    definition['root']['decorations'] = [{'id': f'd{i}', 'color': 1} for i in range(1023)]
    definition['root']['children'] = [{
        'id': 'arm', 'body': {'type': 'kinematic'}, 'blocks': [], 'children': [],
        'decorations': [{'id': 'd0', 'color': 2}],
    }]
    created = client.post(url.rsplit('/', 1)[0], headers=headers, json={
        'operation_id': str(uuid.uuid4()),
        'definition_base64': base64.b64encode(encode_inventory_resource('entity', definition)).decode(),
        'position': {'x_cm': 100, 'y_cm': 3200, 'z_cm': 100},
    })
    assert created.status_code == 201, created.text
    url = url.rsplit('/', 1)[0]+'/'+created.json()['id']
    rejected = client.patch(url+'/configuration', headers=headers, json=request([
        {'op': 'upsert', 'id': 'extra'}], component='arm'))
    assert rejected.status_code == 422
    assert client.get(url+'/configuration', headers=headers).json()['entity']['revision'] == 1
    payload = edit(1, [
        {'id': 'arm', 'decoration_ops': [{'op': 'upsert', 'id': 'extra', 'color': 3}]},
        {'id': 'root', 'decoration_ops': [{'op': 'remove', 'id': 'd1'}]},
    ])
    assert client.patch(url+'/configuration', headers=headers, json=payload).status_code == 200
    after = client.get(url+'/configuration', headers=headers).json()['definition']['root']
    assert next(d for d in after['decorations'] if d['id'] == 'd0')['color'] == 1
    assert after['children'][0]['decorations'] == [{'id': 'd0', 'color': 2}, {'id': 'extra', 'color': 3}]


def test_aggregate_operation_limit(client, configured):
    url, keys, _ = configured
    ops = [{'op': 'upsert', 'id': f'd{i}'} for i in range(600)]
    result = client.patch(url+'/configuration', headers=keys['full'], json=edit(1, [
        {'id': 'root', 'decoration_ops': ops}, {'id': 'arm', 'decoration_ops': ops},
    ]))
    assert result.status_code == 422 and '1024' in result.text
