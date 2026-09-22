import asyncio
import base64
import datetime as dt
import importlib
from contextlib import nullcontext
import uuid

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi import HTTPException

from config import settings
from space import billing, models
from space.auth import get_current_user
from space.main import app
from space.hosting_cores import initialize_core_pool, reserve_core, capacity, available_cpu_ids
from space.hosting_worker import (prepare, commit_result, world_jobs, release_drained_cores,
                                  requested_world_ids, EntityRuntimePool, NodeRuntime)
from space.inventory_codec import encode_inventory_resource
from tests.test_space_entities import _entity, _user


INSTANCE = str(uuid.uuid4())


def test_development_worker_always_hosts_development_worlds(monkeypatch):
    monkeypatch.setattr(settings, 'ENVIRONMENT', 'development')
    monkeypatch.setenv('SPACE_HOSTING_WORLD_IDS', settings.SPACE_DEFAULT_WORLD_ID)
    assert requested_world_ids() == [
        settings.SPACE_DEFAULT_WORLD_ID,
        settings.SPACE_COPPER_METROPOLIS_WORLD_ID,
        settings.SPACE_AETHER_ARCHIPELAGO_WORLD_ID,
        settings.SPACE_COLOSSUS_HARBOR_WORLD_ID,
        settings.SPACE_TITAN_CANYON_WORLD_ID,
        settings.SPACE_ASTRAL_FOUNDRY_WORLD_ID,
        settings.SPACE_BRUTALIST_DUSK_WORLD_ID,
        settings.SPACE_MIXED_WORLD_ID,
    ]


def setup(client, db, monkeypatch, cpu_ids=(2, 4)):
    actor = _user(db, 'hosting-core-user')
    actor.credits = 10
    app.dependency_overrides[get_current_user] = lambda: actor
    world = client.post('/space/api/v2/bootstrap').json()['world']['id']
    base = f'/space/api/v2/worlds/{world}/entities'
    monkeypatch.setattr(settings, 'SPACE_HOSTING_ENABLED', True)
    initialize_core_pool(db)
    db.add(models.SpaceHostingWorker(world_id=world, instance_id=INSTANCE, epoch=1,
        core_cpu_ids=list(cpu_ids), lease_expires_at=dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=60)))
    db.commit()
    calls = []
    def account_call(path, body):
        calls.append((path, body))
        return {'id': str(uuid.uuid4()), 'user_id': actor.id}
    monkeypatch.setattr(billing, 'call', account_call)
    return actor, world, base, calls


def new_entity(client, base, name='Core walker', x=100):
    response = client.post(base + '/browser', json={
        'operation_id': str(uuid.uuid4()), 'position': {'x_cm': x, 'y_cm': 2000, 'z_cm': 100},
        'desired_run_state': 'stopped',
        'snapshot': {'position': [x / 100, 20, 1], 'constructorOrigin': [x / 100, 20, 1],
            'quaternion': [0, 0, 0, 1], 'scriptStatus': 'stopped'},
        'definition_base64': base64.b64encode(encode_inventory_resource('entity', _entity(name))).decode(),
    })
    assert response.status_code == 201, response.text
    return response.json()


def host(client, base, entity, **extra):
    return client.put(f'{base}/{entity["id"]}/hosting', json={
        'operation_id': str(uuid.uuid4()), 'enabled': True, 'max_credits': 1, **extra})


def test_unique_cores_capacity_failure_and_owned_hud_outside_aoi(client, db, monkeypatch):
    actor, world, base, calls = setup(client, db, monkeypatch)
    entities = [new_entity(client, base, f'Walker {i}', 100 + i * 50_000) for i in range(3)]
    for i, entity in enumerate(entities[:2]):
        response = host(client, base, entity, expected_execution_epoch=0)
        assert response.status_code == 200, response.text
        assert response.json()['core_id'] == i
        assert response.json()['can_manage'] is True
        assert client.get(f'{base}/{entity["id"]}').json()['hosting_core_id'] == i
    rejected = host(client, base, entities[2])
    assert rejected.status_code == 429 and rejected.json()['detail']['code'] == 'HOSTING_CORES_FULL'
    assert rejected.json()['detail']['total'] == 2
    assert len(calls) == 2, 'capacity refusal must not authorize more credit spending'
    listed = client.get(base + '/hosting/list')
    assert listed.status_code == 200, listed.text
    assert listed.json()['capacity'] == {'limit': 128, 'total': 2, 'used': 2, 'available': 0}
    assert {item['entity_id'] for item in listed.json()['items']} == {e['id'] for e in entities[:2]}
    assert listed.json()['items'][0]['teleport_position']['x_cm'] > 0
    observer = _user(db, 'hosting-observer')
    app.dependency_overrides[get_current_user] = lambda: observer
    client.post('/space/api/v2/bootstrap')
    assert client.get(base + '/hosting/list').json()['items'] == []
    assert client.get(f'{base}/{entities[0]["id"]}/hosting').json()['can_manage'] is False
    assert client.put(f'{base}/{entities[0]["id"]}/hosting', json={
        'operation_id': str(uuid.uuid4()), 'enabled': False, 'release_to_browser': True}).status_code == 409


def test_early_stop_preserves_prepaid_and_drains_started_core_without_account_rpc(client, db, monkeypatch):
    actor, world, base, calls = setup(client, db, monkeypatch, (2,))
    entity = new_entity(client, base)
    second = new_entity(client, base, 'Second')
    request = {'operation_id': str(uuid.uuid4()), 'enabled': True, 'max_credits': 2, 'expected_execution_epoch': 0}
    url = f'{base}/{entity["id"]}/hosting'
    result = client.put(url, json=request)
    assert result.status_code == 200, result.text
    row = db.get(models.SpaceWorldEntity, (world, entity['id']))
    row.hosting_remaining_ms = 12_000
    db.commit()
    payload = prepare(db, world, INSTANCE, entity['id'], [2])
    assert payload is not None and payload['core_id'] == 0
    authorization_id = row.hosting_authorization_id
    monkeypatch.setattr(settings, 'SPACE_HOSTING_ENABLED', False)
    monkeypatch.setattr(billing, 'call', lambda *_: pytest.fail('Stop must not depend on account RPC availability'))
    stopped = client.put(url, json={'operation_id': str(uuid.uuid4()), 'enabled': False,
        'release_to_browser': True, 'max_credits': 0, 'expected_execution_epoch': row.execution_epoch})
    assert stopped.status_code == 200, stopped.text
    assert stopped.json()['remaining_ms'] == 12_000 and stopped.json()['core_id'] is None
    assert stopped.json()['execution_mode'] == 'browser'
    assert db.get(models.SpaceHostingAuthorization, authorization_id).revoked is True
    assert db.get(models.SpaceHostingCore, 0).entity_id == entity['id'], 'running process must drain before CPU reuse'
    monkeypatch.setattr(settings, 'SPACE_HOSTING_ENABLED', True)
    assert commit_result(db, world, INSTANCE, payload, {'error': 'late result'}) is False
    assert host(client, base, second).status_code == 429
    db.rollback()
    # Caller has now closed/waited for its process; only its coordinator can free it.
    release_drained_cores(db, world, str(uuid.uuid4()), set())
    assert db.get(models.SpaceHostingCore, 0).entity_id == entity['id']
    db.rollback()
    release_drained_cores(db, world, INSTANCE, set())
    assert db.get(models.SpaceHostingCore, 0).entity_id is None
    replay = client.put(url, json=request)
    assert replay.status_code == 200 and replay.json() == result.json()
    assert row.hosting_enabled is False, 'replaying Start must not restart a stopped entity'


def test_stopping_expired_old_entity_does_not_clear_a_reassigned_pending_core(client, db, monkeypatch):
    actor, world, base, calls = setup(client, db, monkeypatch, (2,))
    old = new_entity(client, base)
    fresh = new_entity(client, base, 'New occupant')
    assert host(client, base, old).status_code == 200
    core = db.get(models.SpaceHostingCore, 0)
    core.lease_expires_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)
    db.commit()
    assert host(client, base, fresh).status_code == 200
    assert client.put(f'{base}/{old["id"]}/hosting', json={
        'operation_id': str(uuid.uuid4()), 'enabled': False, 'release_to_browser': True}).status_code == 200
    assert core.entity_id == fresh['id'] and core.cpu_id == 2
    jobs = world_jobs(db, world, INSTANCE, [2])
    assert len(jobs) == 1 and jobs[0][0] == fresh['id']


def test_feature_worker_credits_and_stale_epoch_refusals_allocate_nothing(client, db, monkeypatch):
    actor, world, base, calls = setup(client, db, monkeypatch)
    entity = new_entity(client, base)
    monkeypatch.setattr(settings, 'SPACE_HOSTING_ENABLED', False)
    assert host(client, base, entity).json()['detail']['code'] == 'HOSTING_DISABLED'
    monkeypatch.setattr(settings, 'SPACE_HOSTING_ENABLED', True)
    worker = db.get(models.SpaceHostingWorker, world)
    worker.lease_expires_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)
    db.commit()
    assert host(client, base, entity).json()['detail']['code'] == 'HOSTING_WORKER_UNAVAILABLE'
    worker.lease_expires_at = dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=60)
    db.commit()
    actor.credits = 0
    assert host(client, base, entity).json()['detail']['code'] == 'HOSTING_CREDITS_REQUIRED'
    actor.credits = 10
    assert host(client, base, entity, expected_execution_epoch=99).json()['detail']['code'] == 'HOSTING_STATE_CHANGED'
    assert calls == [] and capacity(db, worker)['used'] == 0
    worker.core_cpu_ids = []
    db.commit()
    assert host(client, base, entity).json()['detail']['code'] == 'HOSTING_CORE_UNAVAILABLE'


def test_pool_is_global_across_worlds_and_never_allocates_more_than_128(db):
    initialize_core_pool(db)
    worker = models.SpaceHostingWorker(core_cpu_ids=list(range(160)),
        lease_expires_at=dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=60))
    world_ids = [str(uuid.uuid4()), str(uuid.uuid4())]
    for i in range(128):
        entity = models.SpaceWorldEntity(id=str(uuid.uuid4()), world_id=world_ids[i % 2])
        core = reserve_core(db, entity, worker)
        core.execution_epoch = 1
        db.flush()
        assert core.id == i and core.cpu_id == i
    with pytest.raises(HTTPException) as error:
        reserve_core(db, models.SpaceWorldEntity(id=str(uuid.uuid4()), world_id=world_ids[0]), worker)
    assert error.value.status_code == 429
    assert db.query(models.SpaceHostingCore).count() == 128


def test_runtime_pool_has_separate_processes_and_closes_old_epoch_before_replacement():
    async def run():
        pool = EntityRuntimePool()
        try:
            first, second = await pool.get('a', 1, None), await pool.get('b', 1, None)
            await asyncio.gather(first.step({'probe': True}), second.step({'probe': True}))
            old_process = first.process
            assert first.process.pid != second.process.pid
            assert await pool.get('a', 1, None) is first
            replacement = await pool.get('a', 2, None)
            assert replacement is not first and old_process.returncode is not None
        finally:
            await pool.close()
        assert second.process is None
    asyncio.run(run())


def test_nearby_hosted_entities_can_commit_independently_without_pose_starvation(client, db, monkeypatch):
    actor, world, base, calls = setup(client, db, monkeypatch)
    entities = [new_entity(client, base, f'Independent {i}', 100 + i * 100) for i in range(2)]
    for entity in entities:
        assert host(client, base, entity).status_code == 200
        db.get(models.SpaceWorldEntity, (world, entity['id'])).hosting_remaining_ms = 12_000
    db.commit()
    payloads = [prepare(db, world, INSTANCE, entity['id'], [2, 4]) for entity in entities]
    for entity, payload in zip(entities, payloads):
        result = {'entities': [{'id': entity['id'], 'elapsed_ms': 50,
            'definition_base64': base64.b64encode(db.get(models.SpaceWorldEntity, (world, entity['id'])).definition).decode(),
            'snapshot': {'position': [entity['position']['x_cm'] / 100, 20, 1],
                'constructorOrigin': [entity['position']['x_cm'] / 100, 20, 1], 'quaternion': [0, 0, 0, 1]}}]}
        assert commit_result(db, world, INSTANCE, payload, result) is True
    assert all(db.get(models.SpaceWorldEntity, (world, entity['id'])).hosting_remaining_ms == 11_950 for entity in entities)


def test_ready_hour_is_consumed_once_and_early_stop_keeps_pending_capture(client, db, monkeypatch):
    actor, world, base, calls = setup(client, db, monkeypatch)
    entity = new_entity(client, base)
    assert host(client, base, entity).status_code == 200
    row = db.get(models.SpaceWorldEntity, (world, entity['id']))
    grant = models.SpaceHostingGrant(id=str(uuid.uuid4()), world_id=world, entity_id=entity['id'],
        authorization_id=row.hosting_authorization_id, state='ready')
    db.add(grant)
    db.commit()
    payload = prepare(db, world, INSTANCE, entity['id'], [2, 4])
    async def simulate():
        runtime = NodeRuntime()
        try:
            return await runtime.step(payload)
        finally:
            await runtime.close()
    result = asyncio.run(simulate())
    assert not result.get('error') and not result.get('faults'), result
    assert commit_result(db, world, INSTANCE, payload, result) is True
    assert row.hosting_remaining_ms == 3_599_000 and row.hosting_budget_remaining == 0
    assert grant.state == 'consumed' and grant.settlement == 'capture'
    assert commit_result(db, world, INSTANCE, payload, result) is False, 'same paid tick cannot be committed twice'
    unused = models.SpaceHostingGrant(id=str(uuid.uuid4()), world_id=world, entity_id=entity['id'],
        authorization_id=row.hosting_authorization_id, state='ready')
    db.add(unused)
    db.commit()
    stopped = client.put(f'{base}/{entity["id"]}/hosting', json={'operation_id': str(uuid.uuid4()),
        'enabled': False, 'max_credits': 0, 'release_to_browser': True})
    assert stopped.status_code == 200, stopped.text
    assert stopped.json()['remaining_ms'] == 3_599_000
    assert unused.state == 'cancelled' and unused.settlement == 'release'
    assert grant.state == 'consumed' and grant.settlement == 'capture', 'Stop cannot undo an already consumed hour'


def test_affinity_failure_kills_and_waits_before_any_guest_input(monkeypatch):
    import space.hosting_worker as worker
    actions = []
    class Process:
        pid, returncode = 123, None
        def kill(self):
            actions.append('kill')
        async def wait(self):
            actions.append('wait')
            self.returncode = -9
    async def spawn(*args, **kwargs):
        return Process()
    def bind(*args):
        actions.append('bind')
        raise OSError('permission denied')
    monkeypatch.setattr(worker.asyncio, 'create_subprocess_exec', spawn)
    monkeypatch.setattr(worker.os, 'sched_setaffinity', bind, raising=False)
    async def run():
        runtime = NodeRuntime(2)
        with pytest.raises(RuntimeError, match='affinity_failed'):
            await runtime.step({'guest': 'must not execute'})
        assert runtime.process is None
    asyncio.run(run())
    assert actions == ['bind', 'kill', 'wait']


def test_coordinator_closes_running_process_before_releasing_stopped_core(monkeypatch):
    import space.hosting_worker as worker
    actions, tick = [], [0]
    class Runtime:
        def __init__(self, cpu_id):
            self.cpu_id = cpu_id
        async def step(self, payload):
            actions.append('running')
            await asyncio.Future()  # Represents an in-flight child IPC.
        async def close(self):
            actions.append('killed and waited')
    def jobs(*args):
        tick[0] += 1
        if tick[0] == 1:
            return [('actor', 1, 0, 2)]
        if tick[0] == 2:
            return []
        raise asyncio.CancelledError()
    def release(_db, _world, _instance, live):
        if not live:
            assert actions == ['running', 'killed and waited']
            actions.append('released')
    monkeypatch.setattr(worker, 'NodeRuntime', Runtime)
    monkeypatch.setattr(worker, 'SessionLocal', lambda: nullcontext(object()))
    monkeypatch.setattr(worker, 'world_jobs', jobs)
    monkeypatch.setattr(worker, 'prepare', lambda *args: {'steps': 20})
    monkeypatch.setattr(worker, 'release_drained_cores', release)
    async def run():
        with pytest.raises(asyncio.CancelledError):
            await worker.run_world('world', [2])
    asyncio.run(run())
    assert actions == ['running', 'killed and waited', 'released']


def test_cpu_detection_honors_cpuset_physical_siblings_and_quota(monkeypatch):
    import space.hosting_cores as cores
    monkeypatch.setattr(cores.os, 'sched_getaffinity', lambda _: {2, 4, 6, 8}, raising=False)
    def read(path):
        value = str(path)
        if value.endswith('cpu.max'):
            return '200000 100000'
        if value.endswith('physical_package_id'):
            return '0'
        if value.endswith('core_id'):
            return '0' if 'cpu2/' in value or 'cpu4/' in value else value.split('cpu')[-1].split('/')[0]
        raise OSError()
    monkeypatch.setattr(cores.Path, 'read_text', read)
    assert available_cpu_ids() == [2, 6]


def test_cpu_detection_honors_v1_nested_quota_and_ancestor_limit(monkeypatch):
    import space.hosting_cores as cores
    monkeypatch.setattr(cores.os, 'sched_getaffinity', lambda _: set(range(8)), raising=False)
    values = {'/proc/self/cgroup': '2:cpu,cpuacct:/service/worker',
        '/sys/fs/cgroup/cpu/service/cpu.cfs_quota_us': '200000',
        '/sys/fs/cgroup/cpu/service/cpu.cfs_period_us': '100000',
        '/sys/fs/cgroup/cpu/service/worker/cpu.cfs_quota_us': '400000',
        '/sys/fs/cgroup/cpu/service/worker/cpu.cfs_period_us': '100000'}
    def read(path):
        if str(path) not in values:
            raise OSError()
        return values[str(path)]
    monkeypatch.setattr(cores.Path, 'read_text', read)
    assert available_cpu_ids() == [0, 1]


def test_migration_creates_fixed_pool_preserves_prepaid_and_refuses_active_downgrade(monkeypatch):
    migration = importlib.import_module('space.migrations.versions.0007_hosting_cores')
    engine = sa.create_engine('sqlite:///:memory:')
    metadata = sa.MetaData()
    entities = sa.Table('space_world_entities', metadata, sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('hosting_enabled', sa.Boolean, nullable=False), sa.Column('desired_run_state', sa.String),
        sa.Column('hosting_remaining_ms', sa.Integer), sa.Column('hosting_budget_remaining', sa.Integer),
        sa.Column('hosting_reason', sa.String), sa.Column('execution_epoch', sa.Integer), sa.Column('revision', sa.Integer))
    sa.Table('space_hosting_workers', metadata, sa.Column('id', sa.Integer, primary_key=True))
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(entities.insert(), {'id': 1, 'hosting_enabled': True, 'desired_run_state': 'running',
            'hosting_remaining_ms': 5000, 'hosting_budget_remaining': 2, 'execution_epoch': 3, 'revision': 4})
        monkeypatch.setattr(migration, 'op', Operations(MigrationContext.configure(connection)))
        migration.upgrade()
        assert connection.execute(sa.text('SELECT COUNT(*) FROM space_hosting_cores')).scalar() == 128
        row = connection.execute(sa.text('SELECT hosting_enabled, hosting_remaining_ms, hosting_budget_remaining, '
            'execution_epoch, revision FROM space_world_entities')).one()
        assert row == (False, 5000, 0, 4, 5)
        connection.execute(sa.text('UPDATE space_hosting_cores SET entity_id = :id WHERE id = 0'), {'id': uuid.uuid4().hex})
        with pytest.raises(RuntimeError, match='drain'):
            migration.downgrade()
        connection.execute(sa.text('UPDATE space_hosting_cores SET entity_id = NULL WHERE id = 0'))
        migration.downgrade()
        assert 'space_hosting_cores' not in sa.inspect(connection).get_table_names()
    engine.dispose()
