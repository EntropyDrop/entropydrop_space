"""Terrain decorations: bound to standard voxels, removed with them, carried by BlockSets."""
import math
import uuid

import pytest

from routers import space
from space import models
from space.auth import get_current_user
from space.decorations import normalize_anchored_decorations, normalize_terrain_decoration
from space.inventory_codec import InventoryCodecError, decode_inventory_resource, encode_inventory_resource
from space.main import app
from routers.space_market import validate_inventory_resource_payload
from tests.test_space import _user
from tests.test_space_external import body, post, setup


def _world(client, db, name="space-decorator"):
    user = _user(db, name, None)
    app.dependency_overrides[get_current_user] = lambda: user
    return client.post("/space/api/v2/bootstrap").json()["world"]["id"]


def _batch(client, world_id, *mutations):
    return client.post(f"/space/api/v2/worlds/{world_id}/terrain-edits/batches", json={
        "batch_id": str(uuid.uuid4()), "mutations": list(mutations),
    })


def _block(x=100, y=50, z=100, block=1):
    return {"kind": "set_standard", "x": x, "y": y, "z": z, "block": block, "color": 0x123456}


def _decoration(identifier="d_trim", x=100, y=50, z=100, **fields):
    return {"kind": "set_decoration", "id": identifier, "x": x, "y": y, "z": z, "color": 0xABCDEF, **fields}


def test_decorations_are_stored_in_the_anchor_chunk_and_listed(client, db):
    world_id = _world(client, db)
    result = _batch(client, world_id, _block(), _decoration(position=[0, 0.75, 0], scale=[2, 0.5, 1], material=1))
    assert result.status_code == 200, result.text
    assert result.json()["effective_changes"] == 2
    chunk = client.get(f"/space/api/v2/worlds/{world_id}/terrain-edits").json()["chunks"][0]
    assert chunk["decorations"] == [{
        "id": "d_trim", "x": 100, "y": 50, "z": 100, "color": 0xABCDEF, "material": 1,
        "position": [0.0, 0.75, 0.0], "scale": [2.0, 0.5, 1.0],
    }]
    unchanged = _batch(client, world_id, _decoration(position=[0, 0.75, 0], scale=[2, 0.5, 1], material=1))
    assert unchanged.json()["effective_changes"] == 0


def test_removing_the_standard_voxel_removes_its_decorations_only(client, db):
    world_id = _world(client, db, "space-decor-cascade")
    assert _batch(client, world_id, _block(), _block(x=101), _decoration("d_a"), _decoration("d_b"),
                  _decoration("d_c", x=101)).status_code == 200
    removed = _batch(client, world_id, _block(block=0))
    assert removed.status_code == 200, removed.text
    assert removed.json()["effective_changes"] == 3
    chunk = client.get(f"/space/api/v2/worlds/{world_id}/terrain-edits").json()["chunks"][0]
    assert [value["id"] for value in chunk["decorations"]] == ["d_c"]
    # A later voxel at the same cell does not resurrect removed decorations.
    assert _batch(client, world_id, _block()).status_code == 200
    chunk = client.get(f"/space/api/v2/worlds/{world_id}/terrain-edits").json()["chunks"][0]
    assert [value["id"] for value in chunk["decorations"]] == ["d_c"]


def test_decoration_rejects_an_authored_air_anchor_and_full_chunks(client, db, monkeypatch):
    world_id = _world(client, db, "space-decor-reject")
    assert _batch(client, world_id, _block(block=0)).status_code == 200
    empty = _batch(client, world_id, _decoration())
    assert empty.status_code == 409
    assert empty.json()["detail"]["code"] == "TERRAIN_DECORATION_ANCHOR_EMPTY"
    monkeypatch.setattr(space, "MAX_TERRAIN_DECORATIONS_PER_CHUNK", 1)
    assert _batch(client, world_id, _block(x=101), _decoration("d_one", x=101)).status_code == 200
    full = _batch(client, world_id, _decoration("d_two", x=101))
    assert full.status_code == 409
    assert full.json()["detail"]["code"] == "TERRAIN_DECORATION_LIMIT"
    # Updating an existing id does not need a free slot.
    assert _batch(client, world_id, _decoration("d_one", x=101, color=1)).status_code == 200


@pytest.mark.parametrize("fields", [
    {"position": [0, 17, 0]}, {"scale": [16.5, 1, 1]}, {"rotation": [0, 0, 0, 2]}, {"id": "bad id"},
])
def test_invalid_decorations_are_rejected_without_mutation(client, db, fields):
    world_id = _world(client, db, "space-decor-invalid")
    result = _batch(client, world_id, _block(), _decoration(**fields))
    assert result.status_code == 422
    assert db.query(models.SpaceTerrainMutationBatch).count() == 0


def test_remove_decoration_is_idempotent(client, db):
    world_id = _world(client, db, "space-decor-remove")
    assert _batch(client, world_id, _block(), _decoration()).status_code == 200
    remove = {"kind": "remove_decoration", "id": "d_trim", "x": 100, "y": 50, "z": 100}
    assert _batch(client, world_id, remove).json()["effective_changes"] == 1
    assert _batch(client, world_id, remove).json()["effective_changes"] == 0
    chunk = client.get(f"/space/api/v2/worlds/{world_id}/terrain-edits").json()["chunks"][0]
    assert chunk["decorations"] == []


def test_chunks_without_decorations_keep_their_previous_overlay_bytes(client, db):
    world_id = _world(client, db, "space-decor-hash")
    assert _batch(client, world_id, _block()).status_code == 200
    row = db.query(models.SpaceChunkSnapshot).one()
    legacy = space._encode_chunk_overlay({"standard": [[100, 50, 100, 1, 0x123456]], "micro": []})
    assert bytes(row.content_hash) == legacy[1]


def _blockset(decorations):
    return {"type": "space-blockset", "version": 8, "name": "Signs",
            "blocks": [{"dx": 0, "dy": 0, "dz": 0, "block": 1, "color": 1},
                       {"dx": 1, "dy": 0, "dz": 0, "mx": 1, "my": 2, "mz": 3, "block": 1, "color": 2}],
            "decorations": decorations}


def test_blockset_decorations_round_trip_canonically():
    resource = _blockset([
        {"dx": 0, "dy": 0, "dz": 0, "color": 5, "position": [0, 0.5, 0], "materialId": 1},
        {"dx": 0, "dy": 0, "dz": 0, "color": 3, "rotation": [0, 0, 0, -1]},
    ])
    kind, decoded = decode_inventory_resource(encode_inventory_resource("blockset", resource))
    assert kind == "blockset"
    assert decoded["decorations"] == [
        {"dx": 0, "dy": 0, "dz": 0, "color": 3},
        {"dx": 0, "dy": 0, "dz": 0, "color": 5, "materialId": 1, "position": [0.0, 0.5, 0.0]},
    ]
    assert encode_inventory_resource("blockset", decoded) == encode_inventory_resource("blockset", resource)
    canonical = validate_inventory_resource_payload("blockset", decoded)
    assert len(canonical["decorations"]) == 2


@pytest.mark.parametrize("anchor", [{"dx": 1, "dy": 0, "dz": 0}, {"dx": 5, "dy": 0, "dz": 0}])
def test_blockset_decorations_must_sit_on_a_standard_voxel(anchor):
    with pytest.raises(InventoryCodecError):
        encode_inventory_resource("blockset", _blockset([{**anchor, "color": 1}]))
    with pytest.raises(ValueError):
        normalize_anchored_decorations([{**anchor, "color": 1}], _blockset([])["blocks"])


def test_terrain_decoration_normalization_uses_terrain_field_names():
    assert normalize_terrain_decoration({"id": "d", "x": 1, "y": 2, "z": 3, "color": 4, "materialId": 1}) == {
        "id": "d", "x": 1, "y": 2, "z": 3, "color": 4, "material": 1,
    }


@pytest.mark.parametrize("turn", [0, 1, 2, 3])
def test_blockset_build_stamps_rotated_decorations_on_their_voxels(client, db, turn):
    _, world, headers, _ = setup(client, db)
    blocks = [{"dx": 0, "dy": 0, "dz": 0, "block": 1, "color": 1}, {"dx": 2, "dy": 0, "dz": 0, "block": 1, "color": 1}]
    decorations = [{"dx": 2, "dy": 0, "dz": 0, "color": 7, "position": [0.5, 0, 0], "scale": [0.25, 1, 1]}]
    resource = {"type": "space-blockset", "version": 8, "name": "Sign", "blocks": blocks, "decorations": decorations}
    payload = body(yaw_quarter_turns=turn)
    import base64
    payload["definition_base64"] = base64.b64encode(encode_inventory_resource("blockset", resource)).decode()
    result = post(client, world, headers, payload)
    assert result.status_code == 201, result.text
    overlays = [space._decode_chunk_overlay(row) for row in db.query(models.SpaceChunkSnapshot).all()]
    standard = {tuple(edit[:3]) for overlay in overlays for edit in overlay["standard"] if edit[3]}
    [placed] = [value for overlay in overlays for value in overlay["decorations"]]
    assert (placed["x"], placed["y"], placed["z"]) in standard
    # The decoration centre rotates with the voxel geometry about the build origin.
    angle = turn * math.pi / 2
    local = (2.5 + 0.5, 0.5, 0.5)
    expected = (160 + local[0] * math.cos(angle) + local[2] * math.sin(angle), 50 + local[1],
                160 - local[0] * math.sin(angle) + local[2] * math.cos(angle))
    center = [placed[axis] + 0.5 + placed.get("position", [0, 0, 0])[index] for index, axis in enumerate("xyz")]
    assert center == pytest.approx(expected)
