from copy import deepcopy
import math
import subprocess
from pathlib import Path

import pytest
from routers.space_market import validate_inventory_resource_payload, entity_resource_metrics
from space.inventory_codec import encode_inventory_resource, decode_inventory_resource, inventory_content_digest
from space.decorations import normalize_decoration


def entity():
    return {"type": "space-entity", "version": 8, "root": {
        "id": "base", "body": {"type": "dynamic"}, "blocks": [{"dx": 0, "dy": 0, "dz": 0, "color": 1}],
        "children": [], "seats": [], "decorations": [
            {"id": "z", "color": 0, "position": [-0.0, 0, 0], "scale": [1, 1, 1], "rotation": [0, 0, 0, -1]},
            {"id": "trim", "color": 0x112233, "position": [4, 1, 0], "scale": [2, 0.1, 1],
             "rotation": [0, math.sin(0.2), 0, math.cos(0.2)], "materialId": 1},
        ],
    }, "constraints": []}


def test_decoration_codec_cross_language_and_canonical_defaults():
    source = entity()
    encoded = encode_inventory_resource("entity", source)
    kind, restored = decode_inventory_resource(encoded)
    assert encode_inventory_resource(kind, restored) == encoded
    assert restored["root"]["decorations"][1] == {"id": "z", "color": 0}
    source["root"]["decorations"][1]["rotation"] = [-v for v in source["root"]["decorations"][1]["rotation"]]
    assert encode_inventory_resource("entity", source) == encoded
    root = Path(__file__).resolve().parents[2]
    code = "import {decodeInventoryResource,encodeInventoryResource} from './engine/src/storage/InventoryProtobuf.ts'; const data=decodeInventoryResource(Buffer.from(process.argv[1],'hex'),'entity').portable; process.stdout.write(Buffer.from(encodeInventoryResource('entity',data)).toString('hex'));"
    actual = subprocess.check_output(["node", "--input-type=module", "-e", code, encoded.hex()], cwd=root, text=True)
    assert actual == encoded.hex()


@pytest.mark.parametrize("patch", [{"id": ""}, {"scale": [0, 1, 1]}, {"scale": [-1, 1, 1]},
    {"rotation": [0, 0, 0, 0]}, {"rotation": [0, 2, 0, 1]}, {"position": [float("inf"), 0, 0]},
    {"materialId": 2}, {"color": 0x1000000}])
def test_decoration_validation_rejects_malformed_data(patch):
    source = entity()
    source["root"]["decorations"][0].update(patch)
    with pytest.raises(ValueError):
        validate_inventory_resource_payload("entity", source)


def test_decoration_limits_ownership_and_content_digest():
    source = entity()
    canonical = validate_inventory_resource_payload("entity", source)
    assert entity_resource_metrics(canonical) == (1, 1, 0)
    moved = deepcopy(canonical)
    moved["root"]["decorations"][0]["position"] = [5, 1, 0]
    assert inventory_content_digest("entity", moved) != inventory_content_digest("entity", canonical)
    source["root"]["decorations"] = [{"id": f"d{i}", "color": 0} for i in range(1024)]
    validate_inventory_resource_payload("entity", source)
    source["root"]["children"] = [{"id": "arm", "body": {"type": "kinematic"}, "blocks": [],
        "decorations": [{"id": "d0", "color": 0}]}]
    with pytest.raises(ValueError, match="1024 decorations"):
        validate_inventory_resource_payload("entity", source)
    source["root"]["decorations"] = [{"id": "d0", "color": 0}]
    validate_inventory_resource_payload("entity", source)
    source["root"]["decorations"] *= 2
    with pytest.raises(ValueError, match="unique"):
        validate_inventory_resource_payload("entity", source)


def test_browser_decoration_definition_survives_create_and_checkpoint(client, db):
    import base64
    import uuid
    from space.auth import get_current_user
    from space.main import app
    from tests.test_space_entities import _user

    owner = _user(db, "decoration-builder")
    app.dependency_overrides[get_current_user] = lambda: owner
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    source = entity()
    snapshot = {"constructorOrigin": [12, 20, 34], "position": [12.5, 20.5, 34.5],
        "quaternion": [0, 0, 0, 1], "velocity": [0, 0, 0], "angularVelocity": [0, 0, 0],
        "physicsSimulationEnabled": False, "scriptStatus": "stopped"}
    pose = {"x_cm": 1250, "y_cm": 2050, "z_cm": 3450}
    created = client.post(f"/space/api/v2/worlds/{world_id}/entities/browser", json={
        "operation_id": str(uuid.uuid4()), "definition_base64": base64.b64encode(encode_inventory_resource("entity", source)).decode(),
        "snapshot": snapshot, "position": pose, "desired_run_state": "stopped"})
    assert created.status_code == 201, created.text
    record = created.json()
    source["root"]["decorations"][1]["scale"] = [3, 0.25, 2]
    updated = client.put(f"/space/api/v2/worlds/{world_id}/entities/{record['id']}/checkpoint", json={
        "operation_id": str(uuid.uuid4()), "expected_revision": record["revision"],
        "definition_base64": base64.b64encode(encode_inventory_resource("entity", source)).decode(),
        "snapshot": snapshot, "position": pose, "desired_run_state": "stopped"})
    assert updated.status_code == 200, updated.text
    downloaded = client.get(f"/space/api/v2/worlds/{world_id}/entities/{record['id']}/definition")
    assert downloaded.status_code == 200, downloaded.text
    kind, restored = decode_inventory_resource(downloaded.content)
    assert kind == "entity"
    assert restored["root"]["decorations"][0]["scale"] == [3, 0.25, 2]
