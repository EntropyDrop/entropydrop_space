import base64
from difflib import unified_diff
import hashlib
import json
import uuid

import pytest
from space.auth import get_current_user
from space.main import app
from space import models
from space.inventory_codec import encode_inventory_resource
from routers.space_entities import _apply_unified_script_patch
from tests.test_space_entities import _entity, _user


@pytest.fixture
def configured(client, db):
    owner = _user(db, 'config-owner')
    app.dependency_overrides[get_current_user] = lambda: owner
    world = client.post('/space/api/v2/bootstrap').json()['world']['id']
    headers = {}
    for name, scopes in {
        'basic': ['space:entity:create'],
        'edit': ['space:entity:create', 'space:entity:edit'],
        'full': ['space:entity:create', 'space:entity:edit', 'space:entity:run'],
    }.items():
        from tests.conftest import mock_account_key
        key = mock_account_key(owner, scopes)
        headers[name] = {'Authorization': 'Bearer ' + key['api_key']}
    created = client.post(f'/space/api/v2/worlds/{world}/entities', headers=headers['full'], json={
        'operation_id': str(uuid.uuid4()),
        'definition_base64': base64.b64encode(encode_inventory_resource('entity', _entity())).decode(),
        'position': {'x_cm': 100, 'y_cm': 3200, 'z_cm': 100},
    })
    assert created.status_code == 201, created.text
    return f'/space/api/v2/worlds/{world}/entities/{created.json()["id"]}', headers, owner


def command(state, revision):
    return {'operation_id': str(uuid.uuid4()), 'desired_run_state': state, 'expected_revision': revision}


def edit(revision, components=None):
    return {'operation_id': str(uuid.uuid4()), 'expected_revision': revision, 'components': components or [
        {'id': 'root', 'script': 'self.state.changed = true;', 'body': {'mass': 82, 'useGravity': False}},
    ]}


@pytest.mark.parametrize(('source', 'updated'), [
    ('a\nb\nc\n', 'a\nB\nc\n'),
    ('a\nb\nc\nd\ne\n', 'a\nB\nc\nd\nE\n'),
    ('', 'a\n'),
    ('a\n', ''),
    ('a\nb\n', 'x\na\nb\ny\n'),
])
def test_strict_script_patch_applies_generated_unified_diffs(source, updated):
    patch = ''.join(unified_diff(
        source.splitlines(keepends=True),
        updated.splitlines(keepends=True),
        fromfile='before',
        tofile='after',
    ))
    assert _apply_unified_script_patch(source, patch) == updated


def test_strict_script_patch_rejects_git_metadata():
    with pytest.raises(ValueError, match='hunk header'):
        _apply_unified_script_patch('a\n', 'diff --git a/script b/script\n')


def test_legacy_keys_can_edit_code_defaults_and_control_execution(client, db, configured):
    url, keys, _owner = configured
    before = client.get(url+'/configuration', headers=keys['basic'])
    assert before.status_code == 200, before.text
    assert 'no-store' in before.headers['cache-control']
    assert before.json()['definition']['root']['body']['useGravity'] is True
    patch = edit(1)
    changed = client.patch(url+'/configuration', headers=keys['basic'], json=patch)
    assert changed.status_code == 200, changed.text
    assert changed.json()['revision'] == 2
    definition = client.get(url+'/configuration', headers=keys['full']).json()['definition']
    assert definition['root']['script'] == patch['components'][0]['script']
    assert definition['root']['body']['mass'] == 82
    assert definition['root']['body']['useGravity'] is False
    assert definition['root']['blocks'] == before.json()['definition']['root']['blocks']
    assert client.patch(url+'/configuration', headers=keys['full'], json=edit(1)).json()['detail']['code'] == 'ENTITY_REVISION_CONFLICT'
    assert client.patch(url+'/configuration', headers=keys['full'], json=patch).json() == changed.json()
    start = command('running', 2)
    started = client.put(url+'/run-state', headers=keys['edit'], json=start)
    assert started.status_code == 200, started.text
    blocked = client.patch(url+'/configuration', headers=keys['full'], json=edit(3))
    assert blocked.status_code == 409
    assert blocked.json()['detail']['code'] == 'ENTITY_MUST_BE_STOPPED'
    stopped = client.put(url+'/run-state', headers=keys['basic'], json=command('stopped', 3))
    assert stopped.status_code == 200, stopped.text
    # Delayed retries return their original acknowledgement without undoing Stop.
    assert client.put(url+'/run-state', headers=keys['full'], json=start).json() == started.json()
    assert client.patch(url+'/configuration', headers=keys['full'], json=patch).json() == changed.json()
    latest = client.get(url+'/configuration', headers=keys['full']).json()['entity']
    assert latest['revision'] == 4 and latest['desired_run_state'] == 'stopped'
    reused = client.put(url+'/run-state', headers=keys['full'], json={**start, 'desired_run_state': 'stopped'})
    assert reused.status_code == 409 and reused.json()['detail']['code'] == 'ENTITY_OPERATION_ID_REUSED'
    patch['components'][0]['script'] = ''
    assert client.patch(url+'/configuration', headers=keys['full'], json=patch).status_code == 409
    cleared = client.patch(url+'/configuration', headers=keys['full'], json=edit(4, [{'id': 'root', 'script': ''}]))
    assert cleared.status_code == 200, cleared.text
    assert client.get(url+'/configuration', headers=keys['full']).json()['definition']['root']['script'] == ''


def test_configuration_applies_script_diff_and_voxel_operations_atomically(client, db, configured):
    url, keys, _ = configured
    original_script = 'self.setLocalSpin([0,1,0], 2);'
    script_patch = (
        '@@ -1 +1 @@\n'
        '-self.setLocalSpin([0,1,0], 2);\n'
        '\\ No newline at end of file\n'
        '+self.setLocalSpin([0,1,0], 3);\n'
        '\\ No newline at end of file\n'
    )
    request = {
        'operation_id': str(uuid.uuid4()),
        'expected_revision': 1,
        'components': [{
            'id': 'root',
            'script_patch': {
                'format': 'unified',
                'base_sha256': hashlib.sha256(original_script.encode()).hexdigest(),
                'patch': script_patch,
            },
            'voxel_ops': [
                {
                    'op': 'upsert', 'dx': 0, 'dy': 0, 'dz': 0,
                    'is_micro': False, 'color_rgb': 0x112233, 'material_id': 1,
                },
                {
                    'op': 'upsert', 'dx': 1, 'dy': 0, 'dz': 0,
                    'is_micro': True, 'micro_x': 2, 'micro_y': 3, 'micro_z': 4,
                    'color_rgb': 0x445566,
                },
            ],
        }],
    }
    changed = client.patch(url+'/configuration', headers=keys['full'], json=request)
    assert changed.status_code == 200, changed.text
    assert changed.json()['revision'] == 2
    # The durable receipt makes a delayed replay harmless.
    assert client.patch(url+'/configuration', headers=keys['full'], json=request).json() == changed.json()

    definition = client.get(url+'/configuration', headers=keys['full']).json()['definition']
    assert definition['root']['script'] == 'self.setLocalSpin([0,1,0], 3);'
    assert definition['root']['blocks'] == [
        {'dx': 0, 'dy': 0, 'dz': 0, 'block': 1, 'color': 0x112233, 'material_id': 1},
        {'dx': 1, 'dy': 0, 'dz': 0, 'block': 1, 'color': 0x445566, 'mx': 2, 'my': 3, 'mz': 4},
    ]

    removed = client.patch(url+'/configuration', headers=keys['full'], json={
        'operation_id': str(uuid.uuid4()),
        'expected_revision': 2,
        'components': [{
            'id': 'root',
            'voxel_ops': [
                {
                    'op': 'upsert', 'dx': 0, 'dy': 0, 'dz': 0,
                    'is_micro': False, 'color_rgb': 0xAABBCC,
                },
                {
                    'op': 'remove', 'dx': 1, 'dy': 0, 'dz': 0,
                    'is_micro': True, 'micro_x': 2, 'micro_y': 3, 'micro_z': 4,
                },
            ],
        }],
    })
    assert removed.status_code == 200, removed.text
    assert removed.json()['revision'] == 3
    blocks = client.get(url+'/configuration', headers=keys['full']).json()['definition']['root']['blocks']
    assert blocks == [{
        'dx': 0, 'dy': 0, 'dz': 0, 'block': 1,
        'color': 0xAABBCC, 'material_id': 1,
    }]


def test_semantic_patch_conflicts_and_failures_do_not_write(client, db, configured):
    url, keys, _ = configured
    original_script = 'self.setLocalSpin([0,1,0], 2);'
    valid_diff = (
        '@@ -1 +1 @@\n'
        '-self.setLocalSpin([0,1,0], 2);\n'
        '\\ No newline at end of file\n'
        '+self.setLocalSpin([0,1,0], 3);\n'
        '\\ No newline at end of file\n'
    )

    wrong_base = client.patch(url+'/configuration', headers=keys['full'], json={
        'operation_id': str(uuid.uuid4()), 'expected_revision': 1,
        'components': [{'id': 'root', 'script_patch': {
            'format': 'unified', 'base_sha256': '0' * 64, 'patch': valid_diff,
        }}],
    })
    assert wrong_base.status_code == 409
    assert wrong_base.json()['detail']['code'] == 'ENTITY_SCRIPT_BASE_CONFLICT'

    invalid_diff = client.patch(url+'/configuration', headers=keys['full'], json={
        'operation_id': str(uuid.uuid4()), 'expected_revision': 1,
        'components': [{'id': 'root', 'script_patch': {
            'format': 'unified',
            'base_sha256': hashlib.sha256(original_script.encode()).hexdigest(),
            'patch': '@@ -1 +1 @@\n-not the current script\n+replacement\n',
        }}],
    })
    assert invalid_diff.status_code == 422
    assert invalid_diff.json()['detail']['code'] == 'ENTITY_SCRIPT_PATCH_INVALID'

    missing_voxel = client.patch(url+'/configuration', headers=keys['full'], json={
        'operation_id': str(uuid.uuid4()), 'expected_revision': 1,
        'components': [{'id': 'root', 'voxel_ops': [{
            'op': 'remove', 'dx': 9, 'dy': 9, 'dz': 9, 'is_micro': False,
        }]}],
    })
    assert missing_voxel.status_code == 422
    assert missing_voxel.json()['detail']['code'] == 'ENTITY_VOXEL_NOT_FOUND'

    overlapping_scale = client.patch(url+'/configuration', headers=keys['full'], json={
        'operation_id': str(uuid.uuid4()), 'expected_revision': 1,
        'components': [{'id': 'root', 'voxel_ops': [{
            'op': 'upsert', 'dx': 0, 'dy': 0, 'dz': 0, 'is_micro': True,
            'micro_x': 0, 'micro_y': 0, 'micro_z': 0, 'color_rgb': 0xFFFFFF,
        }]}],
    })
    assert overlapping_scale.status_code == 422
    assert overlapping_scale.json()['detail']['code'] == 'ENTITY_DEFINITION_INVALID'

    entity = db.query(models.SpaceWorldEntity).one()
    assert entity.revision == 1
    definition = client.get(url+'/configuration', headers=keys['full']).json()['definition']
    assert definition['root']['script'] == original_script
    assert definition['root']['blocks'] == [
        {'dx': 0, 'dy': 0, 'dz': 0, 'block': 1, 'color': 0xF2A93B},
    ]


@pytest.mark.parametrize('components', [
    [{'id': 'root', 'script': None}], [{'id': 'root', 'body': {}}],
    [{'id': 'root', 'body': {'mass': 0}}], [{'id': 'root', 'body': {'useGravity': 'false'}}],
    [{'id': 'root', 'owner_user_id': 'other'}], [{'id': 'absent', 'script': ''}],
    [{'id': 'root', 'body': {'friction': 2}}], [{'id': 'root', 'script': '🚀'*65536}],
    [{'id': 'root', 'script': ''}, {'id': 'root', 'script': 'oops'}],
    [{'id': 'root', 'script': '', 'script_patch': {
        'format': 'unified', 'base_sha256': '0'*64, 'patch': '@@ -0,0 +0,0 @@\n',
    }}],
    [{'id': 'root', 'voxel_ops': [{
        'op': 'upsert', 'dx': 0, 'dy': 0, 'dz': 0, 'is_micro': True, 'color_rgb': 0,
    }]}],
    [{'id': 'root', 'voxel_ops': [
        {'op': 'remove', 'dx': 0, 'dy': 0, 'dz': 0, 'is_micro': False},
        {'op': 'upsert', 'dx': 0, 'dy': 0, 'dz': 0, 'is_micro': False, 'color_rgb': 0},
    ]}],
])
def test_configuration_validation_is_atomic(client, db, configured, components):
    url, keys, _ = configured
    result = client.patch(url+'/configuration', headers=keys['full'], json=edit(1, components))
    assert result.status_code == 422, result.text
    assert db.query(models.SpaceWorldEntity).one().revision == 1
    assert db.query(models.SpaceEntityOperation).count() == 0




def test_stop_and_edit_discard_runtime_overrides_but_preserve_placement(client, db, configured):
    url, keys, owner = configured
    entity = db.query(models.SpaceWorldEntity).one()
    snapshot = {'position': [1, 32, 1], 'constructorOrigin': [0.5, 31.5, 0.5],
                'quaternion': [0, 0.6, 0, 0.8], 'localCenter': [0.5, 0.5, 0.5],
                'states': {'root': {'old': True}}, 'velocity': [5, 10, 15],
                'bodies': [{'id': 'root', 'mass': 999}], 'scriptRuntime': 99}
    entity.snapshot = json.dumps(snapshot).encode()
    entity.snapshot_digest = hashlib.sha256(entity.snapshot).digest()
    entity.snapshot_size_bytes = len(entity.snapshot)
    entity.execution_instance_id = str(uuid.uuid4())
    entity.execution_epoch = 7
    entity.desired_run_state = 'running'
    db.commit()
    stopped = client.put(url+'/run-state', headers=keys['basic'], json=command('stopped', 1))
    assert stopped.status_code == 200, stopped.text
    db.refresh(entity)
    reset = json.loads(entity.snapshot)
    assert reset['position'] == snapshot['position'] and reset['quaternion'] == snapshot['quaternion']
    assert reset['states'] == {} and reset['resetRuntime'] is True
    assert 'mass' not in reset['bodies'][0] and 'velocity' not in reset
    assert entity.execution_instance_id is None and entity.execution_epoch == 8
    assert client.patch(url+'/configuration', headers=keys['full'], json=edit(2)).status_code == 200
    # The old browser's save cannot restore old code/state after a remote edit.
    app.dependency_overrides[get_current_user] = lambda: owner
    stale = client.put(url+'/checkpoint', json={
        'operation_id': str(uuid.uuid4()), 'expected_revision': 1, 'snapshot': snapshot,
        'position': {'x_cm': 100, 'y_cm': 3200, 'z_cm': 100}, 'desired_run_state': 'running',
    })
    assert stale.status_code == 409 and stale.json()['detail']['code'] == 'ENTITY_REVISION_CONFLICT'


def test_edit_reuses_entity_storage_and_write_quotas(client, db, configured, monkeypatch):
    from routers import space_entities
    url, keys, _ = configured
    entity = db.query(models.SpaceWorldEntity).one()
    before = bytes(entity.definition)
    monkeypatch.setattr(space_entities, 'SPACE_ENTITY_MAX_TOTAL_BYTES_PER_OWNER', entity.size_bytes)
    result = client.patch(url+'/configuration', headers=keys['full'], json=edit(1, [{'id': 'root', 'script': 'x'*1000}]))
    assert result.status_code == 429, result.text
    db.refresh(entity)
    assert bytes(entity.definition) == before and entity.revision == 1
    monkeypatch.setattr(space_entities, 'SPACE_ENTITY_MAX_TOTAL_BYTES_PER_OWNER', 10000000)
    monkeypatch.setattr(space_entities, 'SPACE_ENTITY_CHECKPOINT_MINUTE_BYTES', 1)
    result = client.patch(url+'/configuration', headers=keys['full'], json=edit(1))
    assert result.status_code == 429 and result.json()['detail']['code'] == 'WORLD_ENTITY_CHECKPOINT_QUOTA_REACHED'
