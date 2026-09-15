import base64
import datetime as dt
import uuid

import msgpack
import pytest

from space.auth import get_current_user
from space.main import app
from space.models import SpaceWorldEntity
from space.inventory_codec import encode_inventory_resource
from space.entity_pose import authorize_entity_poses, parse_entity_pose, parse_hosted_trajectory
from routers.space_realtime import _unpack_message
from tests.test_space_entities import _user, _entity


def test_world_operations_are_equal_but_execution_account_is_not_creator(client, db):
    author, world, base, entity = setup_entity(client, db)
    url = f'{base}/{entity["id"]}'
    stopped = client.put(url + '/run-state', json={
        'operation_id': str(uuid.uuid4()), 'desired_run_state': 'stopped',
    }).json()
    operator = _user(db, 'equal-operator')
    app.dependency_overrides[get_current_user] = lambda: operator
    assert client.post('/space/api/v2/bootstrap').status_code == 200
    record = client.get(url).json()
    assert record['can_control'] and record['can_edit']
    assert client.get(url + '/configuration').status_code == 200
    edited = client.patch(url + '/configuration', json={
        'operation_id': str(uuid.uuid4()), 'expected_revision': stopped['revision'],
        'components': [{'id': 'root', 'name': 'Shared entity', 'script': ''}],
    })
    assert edited.status_code == 200, edited.text
    checkpoint = client.put(url + '/checkpoint', json={
        'operation_id': str(uuid.uuid4()), 'expected_revision': edited.json()['revision'],
        'position': entity['position'], 'desired_run_state': 'stopped',
        'snapshot': {'position': [1, 20, 1], 'constructorOrigin': [1, 20, 1], 'quaternion': [0, 0, 0, 1]},
    })
    assert checkpoint.status_code == 200, checkpoint.text
    instance = str(uuid.uuid4())
    running = start(client, base, checkpoint.json(), instance)
    row = db.get(SpaceWorldEntity, (world, entity['id']))
    assert row.owner_user_id == author.id, 'execution must not transfer creator attribution'
    assert row.execution_user_id == operator.id
    assert running['owner_name'] == author.username
    assert running['execution_user_id'] == operator.id
    assert running['executor_name'] == operator.username
    candidate = {**parse_entity_pose(pose(entity, instance, running['execution_epoch'])), 'user_id': operator.id}
    assert authorize_entity_poses(db, world, [candidate])
    app.dependency_overrides[get_current_user] = lambda: author
    assert client.get(url).json()['executor_name'] == operator.username
    listed = client.get(base, params={'center_x_cm': 100, 'center_z_cm': 100, 'radius_cm': 1000}).json()['items']
    assert listed[0]['executor_name'] == operator.username
    proof = {'execution_instance_id': instance, 'execution_epoch': running['execution_epoch']}
    # Even knowing another account's endpoint capability is not authorization.
    for state in ('running', 'stopped'):
        rejected = client.put(url + '/run-state', json={
            'operation_id': str(uuid.uuid4()), 'desired_run_state': state, **proof,
        })
        assert rejected.status_code == 409 and rejected.json()['detail']['code'] == 'ENTITY_OCCUPIED'
    assert client.delete(url, headers={'X-Space-Execution-Instance': instance,
        'X-Space-Execution-Epoch': str(running['execution_epoch'])}).status_code == 409
    assert not authorize_entity_poses(db, world, [{**candidate, 'user_id': author.id}])
    denied = client.put(base + '/execution-leases', json={'instance_id': instance,
        'entity_ids': [entity['id']]}).json()['items'][0]
    assert not denied['granted']
    unauthorized_checkpoint = client.put(url + '/checkpoint', json={
        'operation_id': str(uuid.uuid4()), 'expected_revision': running['revision'],
        'position': entity['position'], 'desired_run_state': 'running',
        'snapshot': {'position': [1, 20, 1], 'constructorOrigin': [1, 20, 1], 'quaternion': [0, 0, 0, 1]}, **proof,
    })
    assert unauthorized_checkpoint.status_code == 409
    app.dependency_overrides[get_current_user] = lambda: operator
    stopped = client.put(url + '/run-state', json={
        'operation_id': str(uuid.uuid4()), 'desired_run_state': 'stopped', **proof,
    })
    assert stopped.status_code == 200, stopped.text
    assert row.execution_user_id is None and row.execution_instance_id is None
    app.dependency_overrides[get_current_user] = lambda: author
    assert client.patch(url + '/configuration', json={
        'operation_id': str(uuid.uuid4()), 'expected_revision': stopped.json()['revision'],
        'components': [{'id': 'root', 'name': 'Edited again'}],
    }).status_code == 200
    app.dependency_overrides[get_current_user] = lambda: operator
    assert client.delete(url).status_code == 200


def test_any_member_can_recover_expired_execution_without_creator_permissions(client, db):
    author, world, base, entity = setup_entity(client, db)
    instance = str(uuid.uuid4())
    running = start(client, base, entity, instance)
    row = db.get(SpaceWorldEntity, (world, entity['id']))
    row.execution_lease_expires_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)
    db.commit()
    operator = _user(db, 'recover-operator')
    app.dependency_overrides[get_current_user] = lambda: operator
    client.post('/space/api/v2/bootstrap')
    granted = client.put(base + '/execution-leases', json={
        'instance_id': instance, 'entity_ids': [entity['id']],
    }).json()['items'][0]
    assert granted['granted'] and granted['execution_epoch'] > running['execution_epoch']
    assert granted['executor_name'] == operator.username
    assert row.owner_user_id == author.id and row.execution_user_id == operator.id


def test_running_capacity_counts_actual_operator_and_batch_claims_fail_without_stealing(client, db, monkeypatch):
    from routers import space_entities
    author, world, base, first = setup_entity(client, db)
    second = client.post(base, json={
        'operation_id': str(uuid.uuid4()), 'position': first['position'],
        'definition_base64': base64.b64encode(encode_inventory_resource('entity', _entity())).decode(),
    }).json()
    for entity in (first, second):
        entity.update(client.put(f'{base}/{entity["id"]}/run-state', json={
            'operation_id': str(uuid.uuid4()), 'desired_run_state': 'stopped',
        }).json())
    operator = _user(db, 'capacity-player')
    app.dependency_overrides[get_current_user] = lambda: operator
    client.post('/space/api/v2/bootstrap')
    monkeypatch.setattr(space_entities, 'SPACE_ENTITY_MAX_RUNNING_PER_OWNER', 1)
    instance = str(uuid.uuid4())
    running = start(client, base, first, instance)
    denied = client.put(f'{base}/{second["id"]}/run-state', json={
        'operation_id': str(uuid.uuid4()), 'desired_run_state': 'running',
        'execution_instance_id': instance,
    })
    assert denied.status_code == 429 and denied.json()['detail']['code'] == 'WORLD_ENTITY_RUNNING_OWNER_QUOTA_REACHED'
    usage = client.get(f'/space/api/v2/worlds/{world}/api-usage').json()['quotas']
    assert usage['entities']['used'] == 0 and usage['running_entities']['used'] == 1
    app.dependency_overrides[get_current_user] = lambda: author
    start(client, base, second, str(uuid.uuid4()))
    row = db.get(SpaceWorldEntity, (world, second['id']))
    row.execution_lease_expires_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)
    db.commit()
    app.dependency_overrides[get_current_user] = lambda: operator
    leases = client.put(base + '/execution-leases', json={'instance_id': instance,
        'entity_ids': [first['id'], second['id']]}).json()['items']
    assert leases[0]['granted'] and leases[0]['execution_epoch'] == running['execution_epoch']
    assert not leases[1]['granted'] and row.execution_user_id == author.id


def test_shared_edit_keeps_creator_storage_accounting_but_spends_actor_write_quota(client, db, monkeypatch):
    from routers import space_entities
    from space.models import SpaceUsageBucket
    author, world, base, entity = setup_entity(client, db)
    url = f'{base}/{entity["id"]}'
    stopped = client.put(url + '/run-state', json={
        'operation_id': str(uuid.uuid4()), 'desired_run_state': 'stopped',
    }).json()
    operator = _user(db, 'storage-operator')
    app.dependency_overrides[get_current_user] = lambda: operator
    client.post('/space/api/v2/bootstrap')
    monkeypatch.setattr(space_entities, 'SPACE_ENTITY_MAX_TOTAL_BYTES_PER_OWNER', entity['definition_size_bytes'] + 20)
    blocked = client.patch(url + '/configuration', json={
        'operation_id': str(uuid.uuid4()), 'expected_revision': stopped['revision'],
        'components': [{'id': 'root', 'script': 'x' * 1000}],
    })
    assert blocked.status_code == 429, blocked.text
    monkeypatch.setattr(space_entities, 'SPACE_ENTITY_MAX_TOTAL_BYTES_PER_OWNER', 10_000_000)
    changed = client.patch(url + '/configuration', json={
        'operation_id': str(uuid.uuid4()), 'expected_revision': stopped['revision'],
        'components': [{'id': 'root', 'script': ''}],
    })
    assert changed.status_code == 200, changed.text
    assert db.query(SpaceUsageBucket).filter_by(principal_id=operator.id, metric='entity_checkpoint_bytes').count() == 2


def test_hosting_is_funded_and_occupied_by_requester_not_author(client, db, monkeypatch):
    from config import settings
    from space import billing
    from space.models import SpaceHostingWorker, SpaceWorldPlayerProfile
    from space.hosting_worker import prepare
    from space.hosting_cores import initialize_core_pool
    author, world, base, entity = setup_entity(client, db)
    url = f'{base}/{entity["id"]}'
    client.put(url + '/run-state', json={'operation_id': str(uuid.uuid4()), 'desired_run_state': 'stopped'})
    operator = _user(db, 'hosting-operator')
    operator.credits = 2
    app.dependency_overrides[get_current_user] = lambda: operator
    client.post('/space/api/v2/bootstrap')
    monkeypatch.setattr(settings, 'SPACE_HOSTING_ENABLED', True)
    worker_instance = str(uuid.uuid4())
    db.add(SpaceHostingWorker(world_id=world, instance_id=worker_instance, epoch=1,
        core_cpu_ids=[0],
        lease_expires_at=dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=60)))
    initialize_core_pool(db)
    db.commit()
    payers = []
    monkeypatch.setattr(billing, 'call', lambda path, body: payers.append(body['credential']) or
                        {'id': str(uuid.uuid4()), 'user_id': operator.id})
    hosted = client.put(url + '/hosting', json={
        'operation_id': str(uuid.uuid4()), 'enabled': True, 'max_credits': 1,
    })
    assert hosted.status_code == 200, hosted.text
    row = db.get(SpaceWorldEntity, (world, entity['id']))
    assert row.owner_user_id == author.id and row.execution_user_id == operator.id
    assert payers == ['test-account-proof']
    app.dependency_overrides[get_current_user] = lambda: author
    assert client.get(url + '/hosting').status_code == 200, 'hosting status is shared world information'
    assert client.put(url + '/hosting', json={
        'operation_id': str(uuid.uuid4()), 'enabled': False,
    }).status_code == 409
    # Hosting continues with the requesting member even if the author leaves.
    db.delete(db.get(SpaceWorldPlayerProfile, (world, author.id)))
    row.hosting_remaining_ms = 1000
    db.commit()
    assert prepare(db, world, worker_instance) is not None
    app.dependency_overrides[get_current_user] = lambda: operator
    assert client.put(url + '/hosting', json={
        'operation_id': str(uuid.uuid4()), 'enabled': False, 'release_to_browser': True,
    }).status_code == 200
    assert row.execution_user_id is None


def setup_entity(client, db):
    owner = _user(db, 'execution-owner')
    app.dependency_overrides[get_current_user] = lambda: owner
    world = client.post('/space/api/v2/bootstrap').json()['world']['id']
    base = f'/space/api/v2/worlds/{world}/entities'
    entity = client.post(base, json={
        'operation_id': str(uuid.uuid4()), 'position': {'x_cm': 100, 'y_cm': 2000, 'z_cm': 100},
        'definition_base64': base64.b64encode(encode_inventory_resource('entity', _entity())).decode(),
    }).json()
    return owner, world, base, entity


def start(client, base, entity, instance):
    response = client.put(f'{base}/{entity["id"]}/run-state', json={
        'operation_id': str(uuid.uuid4()), 'expected_revision': entity['revision'],
        'desired_run_state': 'running', 'execution_instance_id': instance,
    })
    assert response.status_code == 200, response.text
    return response.json()


def test_start_acquires_atomically_and_other_tabs_cannot_stop_delete_or_restart(client, db):
    owner, world, base, entity = setup_entity(client, db)
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    running = start(client, base, entity, a)
    row = db.get(SpaceWorldEntity, (world, entity['id']))
    assert str(row.execution_instance_id) == a
    assert running['execution_epoch'] == row.execution_epoch > 0
    assert running['execution_lease_expires_at']
    assert 'execution_instance_id' not in running, 'do not expose the endpoint capability to observers'
    for proof in ({}, {'execution_instance_id': b, 'execution_epoch': row.execution_epoch},
                  {'execution_instance_id': a, 'execution_epoch': row.execution_epoch + 1}):
        for state in ('running', 'stopped'):
            rejected = client.put(f'{base}/{entity["id"]}/run-state', json={
                'operation_id': str(uuid.uuid4()), 'desired_run_state': state,
                'expected_revision': running['revision'], **proof,
            })
            assert rejected.status_code == 409, rejected.text
            assert rejected.json()['detail']['code'] == 'ENTITY_OCCUPIED'
    assert client.delete(f'{base}/{entity["id"]}').status_code == 409
    assert client.delete(f'{base}/{entity["id"]}', headers={
        'X-Space-Execution-Instance': b, 'X-Space-Execution-Epoch': str(row.execution_epoch),
    }).status_code == 409
    # An administrator's author permission also does not confer a live lease.
    admin = _user(db, 'execution-admin')
    admin.is_admin = True
    app.dependency_overrides[get_current_user] = lambda: admin
    client.post('/space/api/v2/bootstrap')
    assert client.delete(f'{base}/{entity["id"]}').status_code == 409
    app.dependency_overrides[get_current_user] = lambda: owner
    stopped = client.put(f'{base}/{entity["id"]}/run-state', json={
        'operation_id': str(uuid.uuid4()), 'desired_run_state': 'stopped',
        'expected_revision': running['revision'], 'execution_instance_id': a,
        'execution_epoch': running['execution_epoch'],
    })
    assert stopped.status_code == 200, stopped.text
    assert stopped.json()['execution_epoch'] > running['execution_epoch']
    assert row.execution_instance_id is None
    # Only one of two stale Start requests can win the stopped revision.
    winner = start(client, base, stopped.json(), b)
    loser = client.put(f'{base}/{entity["id"]}/run-state', json={
        'operation_id': str(uuid.uuid4()), 'desired_run_state': 'running',
        'expected_revision': stopped.json()['revision'], 'execution_instance_id': a,
    })
    assert loser.status_code == 409
    assert str(row.execution_instance_id) == b
    assert client.delete(f'{base}/{entity["id"]}', headers={
        'X-Space-Execution-Instance': b, 'X-Space-Execution-Epoch': str(winner['execution_epoch']),
    }).status_code == 200


def pose(entity, instance, epoch):
    return {'entity_id': entity['id'], 'instance_id': instance, 'execution_epoch': epoch,
            'sequence': 10, 'bodies': [{'id': 'root', 'position': [1, 20, 1],
            'quaternion': [0, 0, 0, 1], 'velocity': [2, 0, 0], 'angularVelocity': [0, 1, 0]}]}


def test_realtime_poses_are_fenced_by_account_endpoint_epoch_state_and_expiry(client, db):
    owner, world, base, entity = setup_entity(client, db)
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    running = start(client, base, entity, a)
    candidate = {**parse_entity_pose(pose(entity, a, running['execution_epoch'])), 'user_id': owner.id}
    accepted = authorize_entity_poses(db, world, [candidate])
    assert accepted and accepted[0]['revision'] == running['revision']
    for change in ({'user_id': 'someone-else'}, {'instance_id': b},
                   {'execution_epoch': running['execution_epoch'] + 1}):
        assert not authorize_entity_poses(db, world, [{**candidate, **change}])
    row = db.get(SpaceWorldEntity, (world, entity['id']))
    row.execution_lease_expires_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)
    db.commit()
    assert not authorize_entity_poses(db, world, [candidate])
    leases = client.put(base + '/execution-leases', json={'instance_id': b, 'entity_ids': [entity['id']]}).json()['items']
    assert leases[0]['granted'] and leases[0]['execution_epoch'] > running['execution_epoch']
    assert not authorize_entity_poses(db, world, [candidate])
    row.desired_run_state = 'stopped'
    db.commit()
    assert not authorize_entity_poses(db, world, [{**candidate, 'instance_id': b,
                                                'execution_epoch': leases[0]['execution_epoch']}])


def test_entity_pose_validation_and_size_limits():
    payload = pose({'id': str(uuid.uuid4())}, str(uuid.uuid4()), 1)
    for body_change in ({'position': [float('nan'), 0, 0]}, {'quaternion': [0, 0, 0, 0]},
                        {'velocity': [True, 0, 0]}, {'angularVelocity': [1e8, 0, 0]}):
        with pytest.raises(ValueError):
            parse_entity_pose({**payload, 'bodies': [{**payload['bodies'][0], **body_change}]})
    with pytest.raises(ValueError):
        parse_entity_pose({**payload, 'bodies': payload['bodies'] * 2})
    with pytest.raises(ValueError):
        parse_entity_pose({**payload, 'sequence': True})
    large = {**payload, 'type': 'entity_pose', 'bodies': [
        {**payload['bodies'][0], 'id': f'body-{i}'} for i in range(80)]}
    raw = msgpack.packb(large, use_bin_type=True)
    assert 4096 < len(raw) < 64 * 1024
    assert parse_entity_pose(_unpack_message(raw))
    with pytest.raises(ValueError, match='too large'):
        _unpack_message(msgpack.packb({'type': 'hello', 'ticket': 't' * 5000}))
    with pytest.raises(ValueError, match='too large'):
        _unpack_message(msgpack.packb({'type': 'entity_pose', 'data': b'x' * (64 * 1024)}))


def test_hosted_trajectory_cannot_be_published_by_a_browser(client, db):
    owner, world, base, entity = setup_entity(client, db)
    row = db.get(SpaceWorldEntity, (world, entity['id']))
    row.execution_mode = 'hosted'
    row.hosting_enabled = True
    row.desired_run_state = 'running'
    row.execution_epoch = 2
    row.hosting_last_tick_at = dt.datetime.now(dt.timezone.utc)
    db.commit()
    candidate = {**pose(entity, str(uuid.uuid4()), 2), 'user_id': owner.id}
    assert not authorize_entity_poses(db, world, [candidate])
    trajectory = parse_hosted_trajectory({'entity_id': entity['id'], 'execution_epoch': 2,
                                         'revision': row.revision, 'first_sequence': 1, 'poses': [candidate['bodies']]})
    internal = {'source': 'hosting', 'entity_id': entity['id'], 'execution_epoch': 2,
                'revision': trajectory['revision'], 'sequence': row.revision * 32, 'bodies': candidate['bodies']}
    assert authorize_entity_poses(db, world, [internal])
    row.revision += 1
    db.commit()
    assert not authorize_entity_poses(db, world, [internal]), 'a rolled back/replaced batch cannot move replicas'


def test_holder_stop_persists_current_pose_instead_of_reverting_to_a_checkpoint(client, db):
    owner, world, base, entity = setup_entity(client, db)
    instance = str(uuid.uuid4())
    running = start(client, base, entity, instance)
    stopped = client.put(f'{base}/{entity["id"]}/run-state', json={
        'operation_id': str(uuid.uuid4()), 'expected_revision': running['revision'],
        'desired_run_state': 'stopped', 'execution_instance_id': instance,
        'execution_epoch': running['execution_epoch'],
        'stop_pose': {'position': [4.5, 21.5, 7.5], 'quaternion': [0, 0, 0, 1]},
    })
    assert stopped.status_code == 200, stopped.text
    assert stopped.json()['position'] == {'x_cm': 450, 'y_cm': 2150, 'z_cm': 750}
    snapshot = client.get(f'{base}/{entity["id"]}/snapshot').json()
    assert snapshot['position'] == [4.5, 21.5, 7.5]
    assert snapshot['states'] == {} and snapshot['physicsSimulationEnabled'] is False


def test_two_live_realtime_tabs_share_presence_but_only_the_holder_can_publish_poses(client, db, monkeypatch):
    from routers import space_realtime as relay
    from tests.conftest import TestingSessionLocal
    owner, world, base, entity = setup_entity(client, db)
    instance = str(uuid.uuid4())
    running = start(client, base, entity, instance)
    identity = relay.RealtimeIdentity(world_id=world, user_id=owner.id, username=owner.username,
        player_entity_id='player', skin_url='', skin_type='strong', world_width_cm=1638400, world_length_cm=204800)
    monkeypatch.setattr(relay, '_authenticate_realtime_ticket', lambda ticket: identity)
    monkeypatch.setattr(relay, 'SessionLocal', TestingSessionLocal)
    monkeypatch.setattr(relay.settings, 'SPACE_REALTIME_REDIS_FANOUT_ENABLED', False)
    monkeypatch.setattr(relay, '_renew_admission_leases', lambda *args: None)
    monkeypatch.setattr(relay, '_persist_realtime_poses', lambda *args: None)
    released = []
    monkeypatch.setattr(relay, '_release_admission', lambda *args: released.append(args))
    hub = relay.SpaceRealtimeHub()
    monkeypatch.setattr(relay, 'realtime_hub', hub)
    def send(socket, value):
        socket.send_bytes(msgpack.packb(value, use_bin_type=True))
    def receive(socket):
        return msgpack.unpackb(socket.receive_bytes(), raw=False)
    def hello(socket):
        send(socket, {'type': 'hello', 'ticket': 'test'})
        for _ in range(10):
            value = receive(socket)
            if value['type'] == 'hello':
                assert value['entity_pose_hz'] == 20
                return
        pytest.fail('missing hello')
    def leave(socket):
        # TestClient context exit cancels the ASGI task; it is not an
        # acknowledgement that asynchronous disconnect cleanup has completed.
        # The protocol's graceful close explicitly acknowledges durable cleanup.
        send(socket, {'type': 'leave'})
        for _ in range(20):
            message = socket.receive()
            if message['type'] == 'websocket.close':
                assert message['code'] == 1000
                return
        pytest.fail('missing graceful close acknowledgement')
    # A shared portal is essential: two connections must run on the same API
    # event loop, just as real Uvicorn connections do.
    with client, client.websocket_connect('/space/ws/v2', subprotocols=['space-relay-v1']) as a:
        hello(a)
        send(a, {'type': 'pose', 'sequence': 1, 'x_cm': 100, 'y_cm': 2000, 'z_cm': 100, 'yaw_q15': 0})
        with client.websocket_connect('/space/ws/v2', subprotocols=['space-relay-v1']) as b:
            hello(b)
            assert len(hub.sessions[world]) == 2, 'a newer tab must not disconnect its existing executor'
            send(b, {'type': 'pose', 'sequence': 1, 'x_cm': 100, 'y_cm': 2000, 'z_cm': 100, 'yaw_q15': 0})
            send(b, {**pose(entity, str(uuid.uuid4()), running['execution_epoch']), 'type': 'entity_pose', 'sequence': 999})
            send(a, {**pose(entity, instance, running['execution_epoch']), 'type': 'entity_pose'})
            for _ in range(20):
                value = receive(b)
                if value['type'] == 'state':
                    assert len(value['players']) == 1, 'multiple tabs must not duplicate an account avatar'
                if value['type'] == 'entity_state':
                    assert value['items'][0]['sequence'] == 10, 'the wrong instance must not override the holder'
                    assert 'instance_id' not in value['items'][0]
                    break
            else:
                pytest.fail('no authorized entity pose reached the observer')
            leave(b)
        assert released == [], 'closing one endpoint must not release another endpoint admission'
        leave(a)
    assert len(released) == 1
