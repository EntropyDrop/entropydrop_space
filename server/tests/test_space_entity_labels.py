import base64
import datetime
import uuid

from space.auth import get_current_user
from space.main import app
from space.models import SpaceWorldEntity
from space.inventory_codec import encode_inventory_resource
from tests.test_space_entities import _entity, _user


def test_entity_labels_expose_verified_executor_name_only_with_live_browser_lease(client, db):
    owner = _user(db, 'label-owner')
    owner.username = 'Alice'
    observer = _user(db, 'label-viewer')
    db.commit()
    app.dependency_overrides[get_current_user] = lambda: owner
    world_id = client.post('/space/api/v2/bootstrap').json()['world']['id']
    base = f'/space/api/v2/worlds/{world_id}/entities'
    created = client.post(base, json={
        'operation_id': str(uuid.uuid4()),
        'definition_base64': base64.b64encode(encode_inventory_resource('entity', _entity('Label walker'))).decode(),
        'position': {'x_cm': 1000, 'y_cm': 2000, 'z_cm': 1000}, 'desired_run_state': 'running',
    })
    assert created.status_code == 201, created.text
    entity_id = created.json()['id']
    assert created.json()['owner_name'] == 'Alice'
    assert created.json()['executor_name'] is None
    lease = client.put(base + '/execution-leases', json={'instance_id': str(uuid.uuid4()), 'entity_ids': [entity_id]})
    assert lease.status_code == 200, lease.text
    app.dependency_overrides[get_current_user] = lambda: observer
    client.post('/space/api/v2/bootstrap')
    query = '?center_x_cm=1000&center_z_cm=1000&radius_cm=2000'
    listed = client.get(base + query).json()['items'][0]
    assert listed['name'] == 'Label walker'
    assert listed['owner_name'] == listed['executor_name'] == 'Alice'
    assert listed['execution_lease_expires_at']
    assert 'execution_instance_id' not in listed  # never publish lease proof
    entity = db.get(SpaceWorldEntity, (world_id, entity_id))
    entity.execution_lease_expires_at = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=1)
    db.commit()
    listed = client.get(base + query).json()['items'][0]
    assert listed['executor_name'] is None and listed['execution_lease_expires_at'] is None
    entity.execution_lease_expires_at = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=12)
    entity.execution_mode = 'hosted'
    entity.hosting_enabled = True
    db.commit()
    listed = client.get(base + query).json()['items'][0]
    assert listed['execution_mode'] == 'hosted' and listed['hosting_enabled'] is True
    assert listed['executor_name'] is None and listed['execution_lease_expires_at'] is None
