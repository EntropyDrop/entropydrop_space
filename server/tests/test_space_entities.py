import hashlib
import math
import uuid
import datetime
import base64

from space.auth import get_current_user
from space.main import app
from space.models import SpaceWorldEntity, User
from routers import space_entities
from space.inventory_codec import decode_inventory_resource, encode_inventory_resource


def _user(db, user_id: str):
    user = User(id=user_id, username=user_id, skin_url='https://cdn.entropydrop.com/skin.png')
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _entity(name="External Walker"):
    return {
        "type": "space-entity",
        "version": 7,
        "root": {
            "name": name,
            "id": "root",
            "anchorRotation": [0, 0, math.sqrt(0.5), math.sqrt(0.5)],
            "body": {"type": "dynamic", "useGravity": True},
            "blocks": [{"dx": 0, "dy": 0, "dz": 0, "block": 1, "color": 0xF2A93B}],
            "script": "self.setLocalSpin([0,1,0], 2);",
            "seats": [],
            "children": [],
        },
        "constraints": [],
    }


def _create_api_key(client, *, allow_run: bool = False) -> tuple[str, str]:
    scopes = ["space:entity:create"]
    if allow_run:
        scopes.append("space:entity:run")
    from tests.conftest import mock_account_key
    owner = app.dependency_overrides[get_current_user]()
    key = mock_account_key(owner, scopes)
    return key["id"], key["api_key"]








def test_browser_entities_are_backend_snapshotted_updated_and_hard_deleted(client, db):
    owner = _user(db, "browser-owner")
    other = _user(db, "browser-other")
    app.dependency_overrides[get_current_user] = lambda: owner
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    definition = encode_inventory_resource("entity", _entity("Browser Builder"))
    snapshot = {
        "constructorOrigin": [12, 20, 34],
        "position": [12.5, 20.5, 34.5],
        "quaternion": [0, 0, 0, 1],
        "velocity": [0, 0, 0],
        "angularVelocity": [0, 0, 0],
        "physicsSimulationEnabled": False,
        "scriptStatus": "stopped",
    }
    create_body = {
        "operation_id": str(uuid.uuid4()),
        "definition_base64": base64.b64encode(definition).decode(),
        "snapshot": snapshot,
        "position": {"x_cm": 1250, "y_cm": 2050, "z_cm": 3450},
        "desired_run_state": "stopped",
    }
    created = client.post(
        f"/space/api/v2/worlds/{world_id}/entities/browser",
        json=create_body,
    )
    repeated = client.post(
        f"/space/api/v2/worlds/{world_id}/entities/browser",
        json=create_body,
    )
    assert created.status_code == 201, created.text
    record = created.json()
    assert repeated.status_code == 201
    assert repeated.json()["id"] == record["id"]
    assert "source_kind" not in record
    assert "source_resource_id" not in record
    assert record["can_edit"] is True
    assert record["snapshot_size_bytes"] > 0
    assert db.query(SpaceWorldEntity).count() == 1

    downloaded = client.get(
        f"/space/api/v2/worlds/{world_id}/entities/{record['id']}/snapshot"
    )
    assert downloaded.status_code == 200
    assert downloaded.json() == snapshot
    assert hashlib.sha256(downloaded.content).hexdigest() == record["snapshot_digest"]

    moved_snapshot = {**snapshot, "position": [13.5, 21.5, 35.5]}
    updated = client.put(
        f"/space/api/v2/worlds/{world_id}/entities/{record['id']}/checkpoint",
        json={
            "operation_id": str(uuid.uuid4()),
            "expected_revision": 1,
            "snapshot": moved_snapshot,
            "position": {"x_cm": 1350, "y_cm": 2150, "z_cm": 3550},
            "desired_run_state": "stopped",
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["revision"] == 2
    assert updated.json()["position"]["x_cm"] == 1350

    app.dependency_overrides[get_current_user] = lambda: other
    assert client.post("/space/api/v2/bootstrap").status_code == 200
    forbidden = client.delete(
        f"/space/api/v2/worlds/{world_id}/entities/{record['id']}"
    )
    assert forbidden.status_code == 403

    app.dependency_overrides[get_current_user] = lambda: owner
    deleted = client.delete(
        f"/space/api/v2/worlds/{world_id}/entities/{record['id']}"
    )
    assert deleted.json() == {"deleted": True, "entity_id": record["id"]}
    assert db.query(SpaceWorldEntity).count() == 0


def test_browser_entity_build_height_is_checked_only_for_new_definitions(client, db):
    owner = _user(db, "browser-build-height-owner")
    app.dependency_overrides[get_current_user] = lambda: owner
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]

    def snapshot_at(y: float):
        return {
            "constructorOrigin": [1, y, 1],
            "position": [1, y, 1],
            "quaternion": [0, 0, 0, 1],
            "velocity": [0, 0, 0],
            "angularVelocity": [0, 0, 0],
            "physicsSimulationEnabled": False,
            "scriptStatus": "stopped",
        }

    crossing = _entity("Crossing ceiling")
    crossing["root"]["blocks"][0]["dy"] = 1
    crossing_definition = base64.b64encode(
        encode_inventory_resource("entity", crossing)
    ).decode()
    rejected_create = client.post(
        f"/space/api/v2/worlds/{world_id}/entities/browser",
        json={
            "operation_id": str(uuid.uuid4()),
            "definition_base64": crossing_definition,
            "snapshot": snapshot_at(255),
            "position": {"x_cm": 100, "y_cm": 25500, "z_cm": 100},
            "desired_run_state": "stopped",
        },
    )
    assert rejected_create.status_code == 422
    assert rejected_create.json()["detail"]["code"] == "ENTITY_POSITION_OUT_OF_BOUNDS"

    definition = base64.b64encode(
        encode_inventory_resource("entity", _entity("Movable entity"))
    ).decode()
    created = client.post(
        f"/space/api/v2/worlds/{world_id}/entities/browser",
        json={
            "operation_id": str(uuid.uuid4()),
            "definition_base64": definition,
            "snapshot": snapshot_at(20),
            "position": {"x_cm": 100, "y_cm": 2000, "z_cm": 100},
            "desired_run_state": "stopped",
        },
    )
    assert created.status_code == 201, created.text
    record = created.json()

    rejected_replacement = client.put(
        f"/space/api/v2/worlds/{world_id}/entities/{record['id']}/checkpoint",
        json={
            "operation_id": str(uuid.uuid4()),
            "expected_revision": 1,
            "definition_base64": crossing_definition,
            "snapshot": snapshot_at(255),
            "position": {"x_cm": 100, "y_cm": 25500, "z_cm": 100},
            "desired_run_state": "stopped",
        },
    )
    assert rejected_replacement.status_code == 422
    assert rejected_replacement.json()["detail"]["code"] == "ENTITY_POSITION_OUT_OF_BOUNDS"

    moved_without_replacement = client.put(
        f"/space/api/v2/worlds/{world_id}/entities/{record['id']}/checkpoint",
        json={
            "operation_id": str(uuid.uuid4()),
            "expected_revision": 1,
            "snapshot": snapshot_at(300),
            "position": {"x_cm": 100, "y_cm": 30000, "z_cm": 100},
            "desired_run_state": "stopped",
        },
    )
    assert moved_without_replacement.status_code == 200, moved_without_replacement.text
    assert moved_without_replacement.json()["position"]["y_cm"] == 30000




def test_world_entity_running_quota_is_enforced_on_create(client, db, monkeypatch):
    owner = _user(db, "entity-running-owner")
    app.dependency_overrides[get_current_user] = lambda: owner
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    _key_id, api_key = _create_api_key(client, allow_run=True)
    definition = encode_inventory_resource("entity", _entity("Running Entity"))
    monkeypatch.setattr(space_entities, "SPACE_ENTITY_MAX_RUNNING_PER_OWNER", 1)
    headers = {"Authorization": f"Bearer {api_key}"}

    def create(operation_id: str, x_cm: int):
        return client.post(
            f"/space/api/v2/worlds/{world_id}/entities",
            headers=headers,
            json={
                "operation_id": operation_id,
                "definition_base64": base64.b64encode(definition).decode(),
                "position": {"x_cm": x_cm, "y_cm": 3200, "z_cm": 100},
                "desired_run_state": "running",
            },
        )

    first = create(str(uuid.uuid4()), 100)
    blocked = create(str(uuid.uuid4()), 1700)

    assert first.status_code == 201, first.text
    assert blocked.status_code == 429
    assert blocked.json()["detail"] == {
        "code": "WORLD_ENTITY_RUNNING_OWNER_QUOTA_REACHED",
        "message": "Too many entities are already running for this account.",
        "limit": 1,
    }
    assert db.query(SpaceWorldEntity).count() == 1


def test_world_entity_checkpoint_budget_is_idempotent(client, db, monkeypatch):
    owner = _user(db, "entity-checkpoint-owner")
    app.dependency_overrides[get_current_user] = lambda: owner
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    definition = encode_inventory_resource("entity", _entity("Checkpoint Entity"))
    snapshot = {
        "constructorOrigin": [12, 20, 34],
        "position": [12.5, 20.5, 34.5],
        "quaternion": [0, 0, 0, 1],
        "velocity": [0, 0, 0],
        "angularVelocity": [0, 0, 0],
        "physicsSimulationEnabled": False,
        "scriptStatus": "stopped",
    }
    created = client.post(
        f"/space/api/v2/worlds/{world_id}/entities/browser",
        json={
            "operation_id": str(uuid.uuid4()),
            "definition_base64": base64.b64encode(definition).decode(),
            "snapshot": snapshot,
            "position": {"x_cm": 1250, "y_cm": 2050, "z_cm": 3450},
            "desired_run_state": "stopped",
        },
    )
    assert created.status_code == 201, created.text
    record = created.json()
    monkeypatch.setattr(
        space_entities,
        "SPACE_ENTITY_CHECKPOINT_MINUTE_BYTES",
        record["snapshot_size_bytes"],
    )
    monkeypatch.setattr(
        space_entities,
        "SPACE_ENTITY_CHECKPOINT_DAILY_BYTES",
        record["snapshot_size_bytes"],
    )
    checkpoint_body = {
        "operation_id": str(uuid.uuid4()),
        "expected_revision": 1,
        "snapshot": snapshot,
        "position": {"x_cm": 1250, "y_cm": 2050, "z_cm": 3450},
        "desired_run_state": "stopped",
    }

    first = client.put(
        f"/space/api/v2/worlds/{world_id}/entities/{record['id']}/checkpoint",
        json=checkpoint_body,
    )
    duplicate = client.put(
        f"/space/api/v2/worlds/{world_id}/entities/{record['id']}/checkpoint",
        json=checkpoint_body,
    )
    blocked = client.put(
        f"/space/api/v2/worlds/{world_id}/entities/{record['id']}/checkpoint",
        json={**checkpoint_body, "operation_id": str(uuid.uuid4()), "expected_revision": 2},
    )

    assert first.status_code == 200, first.text
    assert first.json()["revision"] == 2
    assert duplicate.status_code == 200
    assert duplicate.json()["revision"] == 2
    assert blocked.status_code == 429
    assert blocked.json()["detail"]["code"] == "WORLD_ENTITY_CHECKPOINT_QUOTA_REACHED"
    stored = db.query(SpaceWorldEntity).filter_by(id=record["id"]).one()
    assert stored.revision == 2


def test_external_create_accepts_binary_protobuf_envelope(client, db):
    from space.contracts import space_api_pb2

    owner = _user(db, "envelope-owner")
    app.dependency_overrides[get_current_user] = lambda: owner
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    _key_id, api_key = _create_api_key(client)

    definition = encode_inventory_resource("entity", _entity("Envelope Bot"))
    envelope = space_api_pb2.CreateEntityRequest(
        operation_id=str(uuid.uuid4()),
        definition=definition,
        position=space_api_pb2.PositionCm(x_cm=100, y_cm=3200, z_cm=100),
        desired_run_state=space_api_pb2.ENTITY_RUN_STATE_STOPPED,
    )
    response = client.post(
        f"/space/api/v2/worlds/{world_id}/entities",
        content=envelope.SerializeToString(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/x-protobuf",
        },
    )
    assert response.status_code == 201, response.text
    stored = db.query(SpaceWorldEntity).filter_by(id=response.json()["id"]).one()
    assert stored.definition == definition
    assert stored.schema_version == 7


def test_binary_protobuf_envelope_rejects_invalid_definition(client, db):
    from space.contracts import space_api_pb2

    owner = _user(db, "envelope-invalid-owner")
    app.dependency_overrides[get_current_user] = lambda: owner
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    _key_id, api_key = _create_api_key(client)

    envelope = space_api_pb2.CreateEntityRequest(
        operation_id=str(uuid.uuid4()),
        definition=b"not-an-inventory-resource",
        position=space_api_pb2.PositionCm(x_cm=100, y_cm=3200, z_cm=100),
    )
    response = client.post(
        f"/space/api/v2/worlds/{world_id}/entities",
        content=envelope.SerializeToString(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/x-protobuf",
        },
    )
    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "ENTITY_DEFINITION_INVALID"


def test_binary_protobuf_envelope_returns_422_for_model_validation(client, db):
    from space.contracts import space_api_pb2

    owner = _user(db, "envelope-validation-owner")
    app.dependency_overrides[get_current_user] = lambda: owner
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    _key_id, api_key = _create_api_key(client)
    definition = encode_inventory_resource("entity", _entity("Invalid envelope"))
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/x-protobuf",
    }

    for envelope in (
        space_api_pb2.CreateEntityRequest(
            operation_id=str(uuid.uuid4()),
            definition=definition,
            position=space_api_pb2.PositionCm(x_cm=100, y_cm=3200, z_cm=100),
            yaw_quarter_turns=4,
        ),
        space_api_pb2.CreateEntityRequest(
            operation_id=str(uuid.uuid4()),
            definition=definition,
            position=space_api_pb2.PositionCm(x_cm=100, y_cm=1_000_001, z_cm=100),
        ),
    ):
        response = client.post(
            f"/space/api/v2/worlds/{world_id}/entities",
            content=envelope.SerializeToString(),
            headers=headers,
        )
        assert response.status_code == 422, response.text

    assert db.query(SpaceWorldEntity).count() == 0


def test_binary_protobuf_envelope_rejects_unknown_run_state(client, db):
    from space.contracts import space_api_pb2

    owner = _user(db, "envelope-run-state-owner")
    app.dependency_overrides[get_current_user] = lambda: owner
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    _key_id, api_key = _create_api_key(client)
    envelope = space_api_pb2.CreateEntityRequest(
        operation_id=str(uuid.uuid4()),
        definition=encode_inventory_resource("entity", _entity("Unknown state")),
        position=space_api_pb2.PositionCm(x_cm=100, y_cm=3200, z_cm=100),
        desired_run_state=2,
    )

    response = client.post(
        f"/space/api/v2/worlds/{world_id}/entities",
        content=envelope.SerializeToString(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/x-protobuf",
        },
    )

    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "ENTITY_RUN_STATE_INVALID"
    assert db.query(SpaceWorldEntity).count() == 0


def test_browser_checkpoint_requires_the_current_execution_instance_and_epoch(client, db):
    owner = _user(db, 'lease-checkpoint-owner')
    app.dependency_overrides[get_current_user] = lambda: owner
    world = client.post('/space/api/v2/bootstrap').json()['world']['id']
    base = f'/space/api/v2/worlds/{world}/entities'
    position = {'x_cm': 1250, 'y_cm': 2050, 'z_cm': 3450}
    snapshot = {'position': [12.5, 20.5, 34.5], 'quaternion': [0, 0, 0, 1],
                'constructorOrigin': [12, 20, 34],
                'physicsSimulationEnabled': True, 'scriptStatus': 'running'}
    response = client.post(base + '/browser', json={
        'operation_id': str(uuid.uuid4()), 'position': position, 'snapshot': snapshot,
        'desired_run_state': 'running',
        'definition_base64': base64.b64encode(encode_inventory_resource('entity', _entity())).decode(),
    })
    assert response.status_code == 201, response.text
    entity = response.json()
    first_id, second_id = str(uuid.uuid4()), str(uuid.uuid4())
    def claim(instance):
        return client.put(base + '/execution-leases', json={
            'instance_id': instance, 'entity_ids': [entity['id']],
        }).json()['items'][0]
    first = claim(first_id)
    assert first['granted'] and not claim(second_id)['granted']
    checkpoint = {'operation_id': str(uuid.uuid4()), 'expected_revision': entity['revision'],
                  'position': position, 'snapshot': snapshot, 'desired_run_state': 'stopped'}
    url = base + '/' + entity['id'] + '/checkpoint'
    for proof in ({}, {'execution_instance_id': second_id, 'execution_epoch': first['execution_epoch']},
                  {'execution_instance_id': first_id, 'execution_epoch': first['execution_epoch'] + 1}):
        rejected = client.put(url, json={**checkpoint, **proof})
        assert rejected.status_code == 409, rejected.text
        assert rejected.json()['detail']['code'] == 'ENTITY_EXECUTION_LEASE_REQUIRED'
    row = db.get(SpaceWorldEntity, (world, entity['id']))
    row.execution_lease_expires_at = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=1)
    db.commit()
    old_proof = {'execution_instance_id': first_id, 'execution_epoch': first['execution_epoch']}
    assert client.put(url, json={**checkpoint, **old_proof}).status_code == 409
    second = claim(second_id)
    assert second['granted'] and second['execution_epoch'] > first['execution_epoch']
    assert client.put(url, json={**checkpoint, **old_proof}).status_code == 409

    # Exercise the binary envelope actually used by browser autosaves.
    import json
    from space.contracts import space_api_pb2
    envelope = space_api_pb2.CheckpointEntityRequest(
        operation_id=checkpoint['operation_id'], expected_revision=1,
        position=space_api_pb2.PositionCm(**position),
        snapshot_json=json.dumps(snapshot).encode(), desired_run_state=space_api_pb2.ENTITY_RUN_STATE_STOPPED,
        execution_instance_id=second_id, execution_epoch=second['execution_epoch'],
    )
    accepted = client.put(url, content=envelope.SerializeToString(), headers={'Content-Type': 'application/x-protobuf'})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()['desired_run_state'] == 'stopped'
    replay = client.put(url, content=envelope.SerializeToString(), headers={'Content-Type': 'application/x-protobuf'})
    assert replay.status_code == 200 and replay.json()['revision'] == 2
    edited = client.put(url, json={**checkpoint, 'operation_id': str(uuid.uuid4()), 'expected_revision': 2})
    assert edited.status_code == 200, 'stopped construction edits do not need a runtime lease'
