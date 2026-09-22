import datetime
import struct
import time
import uuid

import msgpack
import pytest
from sqlalchemy.orm import sessionmaker
from starlette.websockets import WebSocketDisconnect

from space.auth import get_current_user
from space.main import app
from rate_limit import limiter
from routers import space as space_router
from routers import space_realtime
from space.models import (
    SpaceChunkSnapshot,
    SpacePlayerSnapshot,
    SpaceTerrainMutationBatch,
    SpaceUsageBucket,
    SpaceWorld,
    SpaceWorldPlayerProfile,
    SpaceSurfaceZoneSnapshot,
    User,
)
import space_surface


def _user(db, user_id: str, skin_url: str | None):
    user = User(id=user_id, username='Space Tester', skin_url=skin_url, skin_type='slim')
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def test_space_ping_returns_ok_without_authentication(client):
    response = client.get("/space/api/v2/ping")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_space_ping_is_exempt_from_rate_limit(client):
    for _ in range(70):
        response = client.get("/space/api/v2/ping")
        assert response.status_code == 200


def test_space_public_status_reports_only_recent_aggregate_presence(client, db):
    empty = client.get("/space/api/v2/status")
    assert empty.status_code == 200
    assert empty.json()["online_players"] == 0
    assert empty.json()["max_online_players"] == 32
    assert empty.json()["presence_window_seconds"] == 30
    assert empty.headers["cache-control"] == "public, max-age=5, stale-while-revalidate=10"
    assert "players" not in empty.json()

    user = _user(db, "space-status-001", "https://cdn.entropydrop.com/skins/status.png")
    app.dependency_overrides[get_current_user] = lambda: user
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    saved = client.put(
        f"/space/api/v2/worlds/{world_id}/players/me/position",
        json={"x_cm": 100, "y_cm": 3200, "z_cm": 100, "yaw_q15": 0},
    )
    assert saved.status_code == 200
    app.dependency_overrides.pop(get_current_user)

    active = client.get("/space/api/v2/status")
    assert active.status_code == 200
    assert active.json()["world_id"] == world_id
    assert active.json()["online_players"] == 1
    assert "user_id" not in active.text

    snapshot = db.query(SpacePlayerSnapshot).filter_by(
        world_id=world_id,
        user_id=user.id,
    ).one()
    snapshot.updated_at = (
        datetime.datetime.now(datetime.timezone.utc)
        - datetime.timedelta(seconds=space_router.SPACE_ONLINE_PRESENCE_SECONDS + 1)
    )
    db.commit()

    stale = client.get("/space/api/v2/status")
    assert stale.status_code == 200
    assert stale.json()["online_players"] == 0


def test_space_realtime_rate_limit_policy_matches_long_lived_sessions():
    heartbeat_endpoint = (
        f"{space_router.space_heartbeat.__module__}."
        f"{space_router.space_heartbeat.__name__}"
    )
    assert heartbeat_endpoint not in limiter._exempt_routes
    assert "minute" in space_router.SPACE_HEARTBEAT_RATE_LIMIT.lower()
    assert "hour" in space_router.SPACE_HEARTBEAT_RATE_LIMIT.lower()
    assert "day" in space_router.SPACE_HEARTBEAT_RATE_LIMIT.lower()
    assert "day" not in space_router.SPACE_POSITION_RATE_LIMIT.lower()
    assert "minute" in space_router.SPACE_POSITION_RATE_LIMIT.lower()
    assert "hour" in space_router.SPACE_POSITION_RATE_LIMIT.lower()


def test_space_bootstrap_requires_shared_login(client):
    response = client.post(
        "/space/api/v2/bootstrap",
        headers={"Origin": "http://localhost:5173"},
    )
    assert response.status_code in (401, 403)
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_space_bootstrap_allows_user_without_skin(client, db):
    user = _user(db, "space-no-skin", None)
    app.dependency_overrides[get_current_user] = lambda: user

    response = client.post("/space/api/v2/bootstrap")

    assert response.status_code == 200
    assert response.json()["player"]["skin_url"] is None
    assert response.json()["player"]["skin_type"] == "strong"
    assert db.query(SpaceWorldPlayerProfile).count() == 1


def test_development_bootstrap_creates_the_copper_metropolis_world(client, db):
    user = _user(db, "copper-city-user", None)
    app.dependency_overrides[get_current_user] = lambda: user

    response = client.post("/space/api/v2/bootstrap?world=copper-metropolis")

    assert response.status_code == 200
    payload = response.json()
    assert payload["world"] == {
        "id": space_router.settings.SPACE_COPPER_METROPOLIS_WORLD_ID,
        "name": "Copper Metropolis",
        "seed": space_router.settings.SPACE_COPPER_METROPOLIS_WORLD_SEED,
        "terrain_generator_version": 2,
        "terrain_revision": 0,
        "surface_snapshot_url": (
            "/space/api/v2/worlds/"
            f"{space_router.settings.SPACE_COPPER_METROPOLIS_WORLD_ID}/surface-zones"
        ),
    }
    assert payload["player"]["start_y_cm"] == 15000
    assert 817600 <= payload["player"]["start_x_cm"] <= 820800
    assert 100800 <= payload["player"]["start_z_cm"] <= 104000
    assert db.query(SpaceWorldPlayerProfile).filter_by(
        world_id=space_router.settings.SPACE_COPPER_METROPOLIS_WORLD_ID,
        user_id=user.id,
    ).count() == 1


def test_bootstrap_rejects_unknown_world_alias(client, db):
    user = _user(db, "unknown-world-user", None)
    app.dependency_overrides[get_current_user] = lambda: user
    response = client.post("/space/api/v2/bootstrap?world=not-a-world")
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "WORLD_NOT_FOUND"


def test_space_bootstrap_returns_ephemeral_world_wide_random_start_without_persisting_it(
    client, db, monkeypatch
):
    skin_url = "https://cdn.entropydrop.com/skins/immutable-player.png"
    user = _user(db, "space-user-001", skin_url)
    app.dependency_overrides[get_current_user] = lambda: user
    starts = iter([
        {"x_cm": 0, "y_cm": 3200, "z_cm": 204799, "yaw_q15": -32767},
        {"x_cm": 1638399, "y_cm": 3200, "z_cm": 0, "yaw_q15": 32767},
    ])
    monkeypatch.setattr(space_router, "_random_initial_position", lambda _world: next(starts))

    first = client.post("/space/api/v2/bootstrap")
    second = client.post("/space/api/v2/bootstrap")

    assert first.status_code == 200
    assert second.status_code == 200
    first_data = first.json()
    second_data = second.json()
    assert first_data["max_online_players"] == 32
    assert first_data["queue_enabled"] is True
    assert first_data["world"]["terrain_generator_version"] == 1
    assert first_data["world"]["surface_snapshot_url"].endswith(
        f'/worlds/{first_data["world"]["id"]}/surface-zones'
    )
    assert first_data["player"]["user_id"] == user.id
    assert first_data["player"]["is_admin"] is False
    assert first_data["player"]["skin_url"] == skin_url
    assert first_data["player"]["skin_type"] == "slim"
    assert first_data["player"]["player_entity_id"] == second_data["player"]["player_entity_id"]
    assert first_data["player"]["resumed"] is False
    assert second_data["player"]["resumed"] is False
    assert {
        "x_cm": first_data["player"]["start_x_cm"],
        "y_cm": first_data["player"]["start_y_cm"],
        "z_cm": first_data["player"]["start_z_cm"],
        "yaw_q15": first_data["player"]["start_yaw_q15"],
    } == {"x_cm": 0, "y_cm": 3200, "z_cm": 204799, "yaw_q15": -32767}
    assert {
        "x_cm": second_data["player"]["start_x_cm"],
        "y_cm": second_data["player"]["start_y_cm"],
        "z_cm": second_data["player"]["start_z_cm"],
        "yaw_q15": second_data["player"]["start_yaw_q15"],
    } == {"x_cm": 1638399, "y_cm": 3200, "z_cm": 0, "yaw_q15": 32767}
    assert db.query(SpaceWorldPlayerProfile).count() == 1
    assert db.query(SpacePlayerSnapshot).count() == 0
    assert not any(column.name.startswith("spawn_") for column in SpaceWorldPlayerProfile.__table__.columns)


def test_space_random_start_covers_both_wrapped_world_seams(monkeypatch):
    world = SpaceWorld(width_chunks=1024, length_chunks=128)
    requested_bounds = []

    def last_value(bound):
        requested_bounds.append(bound)
        return bound - 1

    monkeypatch.setattr(space_router.secrets, "randbelow", last_value)
    assert space_router._random_initial_position(world) == {
        "x_cm": 1638399,
        "y_cm": 3200,
        "z_cm": 204799,
        "yaw_q15": 32767,
    }
    assert requested_bounds == [1638400, 204800, 65535]

    monkeypatch.setattr(space_router.secrets, "randbelow", lambda _bound: 0)
    assert space_router._random_initial_position(world) == {
        "x_cm": 0,
        "y_cm": 3200,
        "z_cm": 0,
        "yaw_q15": -32767,
    }


def test_space_admission_queues_fifo_supports_cancel_and_promotes(client, db, monkeypatch):
    def redis_unavailable(*_args, **_kwargs):
        raise RuntimeError("redis unavailable in admission test")

    monkeypatch.setattr(space_realtime._ticket_redis, "eval", redis_unavailable)
    space_realtime._fallback_admission.reset()

    first_user = _user(db, "space-queue-01", "https://cdn.entropydrop.com/skins/queue-1.png")
    second_user = _user(db, "space-queue-02", "https://cdn.entropydrop.com/skins/queue-2.png")
    third_user = _user(db, "space-queue-03", "https://cdn.entropydrop.com/skins/queue-3.png")

    app.dependency_overrides[get_current_user] = lambda: first_user
    bootstrap = client.post("/space/api/v2/bootstrap").json()
    world_id = bootstrap["world"]["id"]
    world = db.query(SpaceWorld).filter(SpaceWorld.id == world_id).one()
    world.max_online_players = 1
    db.commit()

    first = client.post(f"/space/api/v2/worlds/{world_id}/admission")
    assert first.json() == {"state": "admitted", "position": None, "poll_after_ms": 2000}
    previous_expiry = time.time() + 1
    space_realtime._fallback_admission.worlds[world_id]["active"][first_user.id] = previous_expiry
    renewed = client.post(f"/space/api/v2/worlds/{world_id}/admission")
    assert renewed.json()["state"] == "admitted"
    assert (
        space_realtime._fallback_admission.worlds[world_id]["active"][first_user.id]
        > previous_expiry + 30
    )

    app.dependency_overrides[get_current_user] = lambda: second_user
    assert client.post("/space/api/v2/bootstrap").status_code == 200
    second = client.post(f"/space/api/v2/worlds/{world_id}/admission")
    assert second.json() == {"state": "queued", "position": 1, "poll_after_ms": 2000}
    blocked_ticket = client.post(f"/space/api/v2/worlds/{world_id}/join-ticket")
    assert blocked_ticket.status_code == 409
    assert blocked_ticket.json()["detail"] == {"code": "SPACE_QUEUE_WAIT", "position": 1}

    app.dependency_overrides[get_current_user] = lambda: third_user
    assert client.post("/space/api/v2/bootstrap").status_code == 200
    third = client.post(f"/space/api/v2/worlds/{world_id}/admission")
    assert third.json()["position"] == 2
    cancelled = client.delete(f"/space/api/v2/worlds/{world_id}/admission")
    assert cancelled.json()["state"] == "cancelled"

    space_realtime._release_admission(world_id, first_user.id)
    app.dependency_overrides[get_current_user] = lambda: second_user
    promoted = client.post(f"/space/api/v2/worlds/{world_id}/admission")
    assert promoted.json() == {"state": "admitted", "position": None, "poll_after_ms": 2000}


def test_space_realtime_ticket_and_binary_pose_stream(client, db, monkeypatch):
    alice = _user(db, "space-ws-alice", None)
    bob = _user(db, "space-ws-bob", "https://cdn.entropydrop.com/skins/bob.png")

    app.dependency_overrides[get_current_user] = lambda: alice
    alice_bootstrap = client.post("/space/api/v2/bootstrap").json()
    world_id = alice_bootstrap["world"]["id"]
    alice_ticket = client.post(f"/space/api/v2/worlds/{world_id}/join-ticket")
    app.dependency_overrides[get_current_user] = lambda: bob
    client.post("/space/api/v2/bootstrap")
    bob_ticket = client.post(f"/space/api/v2/worlds/{world_id}/join-ticket")

    assert alice_ticket.status_code == 200
    assert bob_ticket.status_code == 200
    assert alice_ticket.json()["expires_in_seconds"] == 30
    assert alice_ticket.json()["websocket_url"].endswith("/space/ws/v2")

    realtime_session_factory = sessionmaker(
        autocommit=False,
        autoflush=False,
        bind=db.get_bind(),
    )
    monkeypatch.setattr(space_realtime, "SessionLocal", realtime_session_factory)
    monkeypatch.setattr(space_realtime.settings, "SPACE_REALTIME_REDIS_FANOUT_ENABLED", False)

    websocket_options = {
        "headers": {"origin": "http://localhost:5173"},
        "subprotocols": ["space-relay-v1"],
    }
    with client.websocket_connect("/space/ws/v2", **websocket_options) as alice_socket:
        alice_socket.send_bytes(msgpack.packb({
            "type": "hello",
            "ticket": alice_ticket.json()["ticket"],
        }, use_bin_type=True))
        alice_hello = msgpack.unpackb(alice_socket.receive_bytes(), raw=False)
        assert alice_hello["type"] == "hello"
        assert alice_hello["input_hz"] == 20
        assert alice_hello["snapshot_hz"] == 10

        with client.websocket_connect("/space/ws/v2", **websocket_options) as bob_socket:
            bob_socket.send_bytes(msgpack.packb({
                "type": "hello",
                "ticket": bob_ticket.json()["ticket"],
            }, use_bin_type=True))
            assert msgpack.unpackb(bob_socket.receive_bytes(), raw=False)["type"] == "hello"

            alice_socket.send_bytes(msgpack.packb({
                "type": "pose",
                "sequence": 1,
                "x_cm": 123456,
                "y_cm": 4321,
                "z_cm": 65432,
                "yaw_q15": 1234,
                "pitch_q15": -4321,
            }, use_bin_type=True))
            bob_socket.send_bytes(msgpack.packb({
                "type": "pose",
                "sequence": 1,
                "x_cm": 123556,
                "y_cm": 4321,
                "z_cm": 65532,
                "yaw_q15": -1234,
                "pitch_q15": 4321,
            }, use_bin_type=True))

            alice_state = {"players": []}
            while {player["user_id"] for player in alice_state["players"]} != {alice.id, bob.id}:
                alice_state = msgpack.unpackb(alice_socket.receive_bytes(), raw=False)
            bob_state = {"players": []}
            while {player["user_id"] for player in bob_state["players"]} != {alice.id, bob.id}:
                bob_state = msgpack.unpackb(bob_socket.receive_bytes(), raw=False)

            assert alice_state["type"] == "state"
            assert bob_state["type"] == "state"
            alice_view = {player["user_id"]: player for player in alice_state["players"]}
            bob_view = {player["user_id"]: player for player in bob_state["players"]}
            assert alice_view[alice.id]["is_self"] is True
            assert alice_view[bob.id]["is_self"] is False
            assert bob_view[bob.id]["is_self"] is True
            assert alice_view[alice.id]["x_cm"] == 123456
            assert alice_view[alice.id]["skin_url"] == ""

            bob_socket.send_bytes(msgpack.packb({"type": "leave"}, use_bin_type=True))
            with pytest.raises(WebSocketDisconnect):
                bob_socket.receive_bytes()

        alice_socket.send_bytes(msgpack.packb({"type": "leave"}, use_bin_type=True))
        with pytest.raises(WebSocketDisconnect):
            alice_socket.receive_bytes()

    db.rollback()
    db.expire_all()
    snapshot = db.query(SpacePlayerSnapshot).filter(
        SpacePlayerSnapshot.world_id == world_id,
        SpacePlayerSnapshot.user_id == alice.id,
    ).one()
    world = db.query(SpaceWorld).filter(SpaceWorld.id == world_id).one()
    saved_position = space_router._decode_player_snapshot(
        snapshot,
        world,
    )
    assert saved_position == {
        "x_cm": 123456,
        "y_cm": 4321,
        "z_cm": 65432,
        "yaw_q15": 1234,
        "pitch_q15": -4321,
    }


def test_space_bootstrap_restores_latest_position_as_start_state(client, db):
    user = _user(db, "pos-user-001", "https://cdn.entropydrop.com/skins/position.png")
    app.dependency_overrides[get_current_user] = lambda: user
    first = client.post("/space/api/v2/bootstrap")
    first_player = first.json()["player"]
    world_id = first.json()["world"]["id"]

    assert first.status_code == 200
    assert first_player["resumed"] is False
    assert all(first_player[field] is not None for field in (
        "start_x_cm", "start_y_cm", "start_z_cm", "start_yaw_q15"
    ))

    position = {"x_cm": 123456, "y_cm": 4587, "z_cm": 65432, "yaw_q15": -12345}
    saved = client.put(
        f"/space/api/v2/worlds/{world_id}/players/me/position",
        json=position,
    )
    latest_position = {"x_cm": 123499, "y_cm": 4601, "z_cm": 65480, "yaw_q15": 2345}
    saved_latest = client.put(
        f"/space/api/v2/worlds/{world_id}/players/me/position",
        json=latest_position,
    )
    resumed = client.post("/space/api/v2/bootstrap")

    assert saved.status_code == 200
    assert saved.json()["revision"] == 1
    assert saved_latest.status_code == 200
    assert saved_latest.json()["revision"] == 2
    assert resumed.status_code == 200
    resumed_player = resumed.json()["player"]
    assert {
        "x_cm": resumed_player["start_x_cm"],
        "y_cm": resumed_player["start_y_cm"],
        "z_cm": resumed_player["start_z_cm"],
        "yaw_q15": resumed_player["start_yaw_q15"],
    } == latest_position
    assert resumed_player["resumed"] is True
    assert db.query(SpacePlayerSnapshot).count() == 1

    second_user = _user(db, "pos-user-002", "https://cdn.entropydrop.com/skins/position-2.png")
    app.dependency_overrides[get_current_user] = lambda: second_user
    second_player = client.post("/space/api/v2/bootstrap").json()["player"]
    assert second_player["resumed"] is False
    assert all(second_player[field] is not None for field in (
        "start_x_cm", "start_y_cm", "start_z_cm", "start_yaw_q15"
    ))


def test_space_position_rejects_out_of_bounds_checkpoint(client, db):
    user = _user(db, "pos-limit-001", "https://cdn.entropydrop.com/skins/position-limit.png")
    app.dependency_overrides[get_current_user] = lambda: user
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]

    response = client.put(
        f"/space/api/v2/worlds/{world_id}/players/me/position",
        json={"x_cm": -1, "y_cm": 3200, "z_cm": 100, "yaw_q15": 0},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == {"code": "PLAYER_POSITION_OUT_OF_BOUNDS"}
    assert db.query(SpacePlayerSnapshot).count() == 0


def test_space_heartbeat_exchanges_two_active_players(client, db):
    alice = _user(db, "live-alice-001", "https://cdn.entropydrop.com/skins/alice.png")
    app.dependency_overrides[get_current_user] = lambda: alice
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    alice_heartbeat = client.post(
        f"/space/api/v2/worlds/{world_id}/heartbeat",
        json={"x_cm": 10000, "y_cm": 1800, "z_cm": 10000, "yaw_q15": 100, "since_terrain_revision": 0},
    )
    assert alice_heartbeat.status_code == 200

    bob = _user(db, "live-bob-0001", "https://cdn.entropydrop.com/skins/bob.png")
    app.dependency_overrides[get_current_user] = lambda: bob
    assert client.post("/space/api/v2/bootstrap").status_code == 200
    bob_heartbeat = client.post(
        f"/space/api/v2/worlds/{world_id}/heartbeat",
        json={"x_cm": 10100, "y_cm": 1800, "z_cm": 10000, "yaw_q15": -100, "since_terrain_revision": 0},
    )

    assert bob_heartbeat.status_code == 200
    players = {player["user_id"]: player for player in bob_heartbeat.json()["players"]}
    assert set(players) == {alice.id, bob.id}
    assert players[alice.id]["is_self"] is False
    assert players[bob.id]["is_self"] is True
    assert players[alice.id]["x"] == 100.0

    terrain_only = client.post(
        f"/space/api/v2/worlds/{world_id}/heartbeat",
        json={"since_terrain_revision": 0, "include_players": False},
    )
    assert terrain_only.status_code == 200
    assert terrain_only.json()["players"] == []


def test_space_heartbeat_cursor_does_not_miss_first_edit_in_another_chunk(client, db):
    user = _user(db, "live-block-001", "https://cdn.entropydrop.com/skins/live-block.png")
    app.dependency_overrides[get_current_user] = lambda: user
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]

    first_apply = client.post(
        f"/space/api/v2/worlds/{world_id}/terrain-edits/batches",
        json={
            "batch_id": str(uuid.uuid4()),
            "mutations": [{"kind": "set_standard", "x": 1, "y": 20, "z": 1, "block": 1, "color": 1}],
        },
    )
    assert first_apply.status_code == 200
    first_poll = client.post(
        f"/space/api/v2/worlds/{world_id}/heartbeat",
        json={"since_terrain_revision": 0},
    )
    cursor = first_poll.json()["max_terrain_revision"]
    assert [(chunk["chunk_x"], chunk["chunk_z"]) for chunk in first_poll.json()["terrain_chunks"]] == [(0, 0)]

    second_apply = client.post(
        f"/space/api/v2/worlds/{world_id}/terrain-edits/batches",
        json={
            "batch_id": str(uuid.uuid4()),
            "mutations": [{"kind": "set_standard", "x": 33, "y": 20, "z": 1, "block": 1, "color": 2}],
        },
    )
    assert second_apply.status_code == 200
    second_poll = client.post(
        f"/space/api/v2/worlds/{world_id}/heartbeat",
        json={"since_terrain_revision": cursor},
    )

    assert [(chunk["chunk_x"], chunk["chunk_z"]) for chunk in second_poll.json()["terrain_chunks"]] == [(2, 0)]
    assert second_poll.json()["max_terrain_revision"] > cursor


def test_space_heartbeat_filters_incremental_chunks_to_player_aoi(client, db):
    user = _user(db, "live-aoi-0001", "https://cdn.entropydrop.com/skins/live-aoi.png")
    app.dependency_overrides[get_current_user] = lambda: user
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]

    near_apply = client.post(
        f"/space/api/v2/worlds/{world_id}/terrain-edits/batches",
        json={
            "batch_id": str(uuid.uuid4()),
            "mutations": [
                {"kind": "set_standard", "x": 1, "y": 20, "z": 1, "block": 1, "color": 1}
            ],
        },
    )
    far_apply = client.post(
        f"/space/api/v2/worlds/{world_id}/terrain-edits/batches",
        json={
            "batch_id": str(uuid.uuid4()),
            "mutations": [
                {"kind": "set_standard", "x": 10 * 16, "y": 20, "z": 1, "block": 1, "color": 2}
            ],
        },
    )
    assert near_apply.status_code == 200
    assert far_apply.status_code == 200

    poll = client.post(
        f"/space/api/v2/worlds/{world_id}/heartbeat",
        json={
            "since_terrain_revision": 0,
            "include_players": False,
            "center_chunk_x": 0,
            "center_chunk_z": 0,
            "terrain_radius_chunks": 1,
        },
    )

    assert poll.status_code == 200
    assert [(chunk["chunk_x"], chunk["chunk_z"]) for chunk in poll.json()["terrain_chunks"]] == [
        (0, 0)
    ]
    assert poll.json()["max_terrain_revision"] == near_apply.json()["terrain_revision"]


def test_space_terrain_edits_are_durable_and_visible_to_another_browser_user(client, db):
    first_user = _user(db, "space-editor-001", "https://cdn.entropydrop.com/skins/editor.png")
    app.dependency_overrides[get_current_user] = lambda: first_user
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    batch_id = str(uuid.uuid4())
    payload = {
        "batch_id": batch_id,
        "mutations": [
            {"kind": "set_standard", "x": 100, "y": 50, "z": 100, "block": 1, "color": 0x123456, "material": 1},
            {"kind": "set_standard", "x": 101, "y": 50, "z": 100, "block": 0, "color": 0xF2A93B},
            {"kind": "set_micro", "mx": 809, "my": 401, "mz": 803, "color": 0xABCDEF, "part": "tip", "material": 1},
        ],
    }

    first_apply = client.post(f"/space/api/v2/worlds/{world_id}/terrain-edits/batches", json=payload)
    duplicate_apply = client.post(f"/space/api/v2/worlds/{world_id}/terrain-edits/batches", json=payload)

    assert first_apply.status_code == 200
    assert duplicate_apply.status_code == 200
    assert duplicate_apply.json() == first_apply.json()
    assert first_apply.json()["applied"] == 3
    assert db.query(SpaceChunkSnapshot).count() == 1
    assert db.query(SpaceTerrainMutationBatch).count() == 1

    second_user = _user(db, "space-viewer-01", "https://cdn.entropydrop.com/skins/viewer.png")
    app.dependency_overrides[get_current_user] = lambda: second_user
    assert client.post("/space/api/v2/bootstrap").status_code == 200

    loaded = client.get(f"/space/api/v2/worlds/{world_id}/terrain-edits")
    assert loaded.status_code == 200
    chunks = loaded.json()["chunks"]
    assert len(chunks) == 1
    assert chunks[0]["standard"] == [
        [100, 50, 100, 1, 0x123456, 1],
        [101, 50, 100, 0, 0xF2A93B],
    ]
    assert chunks[0]["micro"] == [[809, 401, 803, 0xABCDEF, "tip", 1]]


def test_space_terrain_height_is_256_metres(client, db):
    user = _user(db, "space-height-01", "https://cdn.entropydrop.com/skins/height.png")
    app.dependency_overrides[get_current_user] = lambda: user
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]

    top = client.post(
        f"/space/api/v2/worlds/{world_id}/terrain-edits/batches",
        json={
            "batch_id": str(uuid.uuid4()),
            "mutations": [
                {"kind": "set_standard", "x": 1, "y": 255, "z": 1, "block": 1, "color": 1},
                {"kind": "set_micro", "mx": 16, "my": 2047, "mz": 16, "color": 2},
            ],
        },
    )
    assert top.status_code == 200, top.text

    for mutation in (
        {"kind": "set_standard", "x": 1, "y": 256, "z": 1, "block": 1, "color": 1},
        {"kind": "set_micro", "mx": 5, "my": 2048, "mz": 5, "color": 2},
    ):
        rejected = client.post(
            f"/space/api/v2/worlds/{world_id}/terrain-edits/batches",
            json={"batch_id": str(uuid.uuid4()), "mutations": [mutation]},
        )
        assert rejected.status_code == 422
        assert rejected.json()["detail"]["code"] == "TERRAIN_POSITION_OUT_OF_BOUNDS"


def test_space_surface_zone_snapshot_matches_browser_generator_and_serves_immutable_bytes(client, db):
    user = _user(db, "space-surface-1", "https://cdn.entropydrop.com/skins/surface.png")
    app.dependency_overrides[get_current_user] = lambda: user
    bootstrap = client.post("/space/api/v2/bootstrap").json()
    world = db.query(SpaceWorld).filter_by(id=bootstrap["world"]["id"]).one()

    generator = space_surface.TerrainSurfaceGenerator(world.seed, 16384, 2048)
    assert [generator.sample_height(x, z) for x, z in (
        (0, 0), (8192, 1024), (16382, 2046), (1234, 567)
    )] == [17, 16, 18, 15]

    row = space_surface.generate_surface_zone(db, world, 0, 0)
    assert row is not None
    assert row.uncompressed_size > 36 + 512 * 512 * 8
    assert row.schema_version == 7
    manifest = client.get(bootstrap["world"]["surface_snapshot_url"])
    assert manifest.status_code == 200
    body = manifest.json()
    assert body["samples_per_chunk_axis"] == 16
    assert body["complete"] is False
    assert [(zone["zone_x"], zone["zone_z"]) for zone in body["zones"]] == [(0, 0)]

    downloaded = client.get(body["zones"][0]["url"])
    assert downloaded.status_code == 200
    assert downloaded.content[:4] == b"EDSZ"
    assert len(downloaded.content) == row.uncompressed_size
    assert downloaded.headers["etag"] == f'"{row.content_hash.hex()}"'
    assert "immutable" in downloaded.headers["cache-control"]
    levels = body['zones'][0]['lods']
    assert [level['sample_size'] for level in levels] == [2, 4, 8, 16, 32, 64]
    for level in levels:
        coarse = client.get(level['url'])
        assert coarse.status_code == 200
        assert len(coarse.content) == level['byte_length']
        assert coarse.content[4:6] == bytes([7, level['sample_size']])
        assert coarse.headers['etag'] == f'"{level["digest"]}"'
    assert client.get(levels[-1]['url'].replace(levels[-1]['digest'], '0' * 64)).status_code == 409
    assert client.get(body['zones'][0]['url'] + '&sample_size=3').status_code == 422


def test_terrain_edits_mark_their_surface_zone_snapshot_dirty(client, db):
    user = _user(db, "space-surface-2", "https://cdn.entropydrop.com/skins/surface-dirty.png")
    app.dependency_overrides[get_current_user] = lambda: user
    bootstrap = client.post("/space/api/v2/bootstrap").json()
    world = db.query(SpaceWorld).filter_by(id=bootstrap["world"]["id"]).one()
    space_surface.generate_surface_zone(db, world, 0, 0)

    old_lod_url = client.get(bootstrap['world']['surface_snapshot_url']).json()['zones'][0]['lods'][-1]['url']

    applied = client.post(
        f'/space/api/v2/worlds/{world.id}/terrain-edits/batches',
        json={
            "batch_id": str(uuid.uuid4()),
            "mutations": [
                {"kind": "set_standard", "x": 3, "y": 255, "z": 3, "block": 1, "color": 0x123456},
            ],
        },
    )
    assert applied.status_code == 200
    row = db.query(SpaceSurfaceZoneSnapshot).filter_by(
        world_id=world.id, zone_x=0, zone_z=0
    ).one()
    assert row.dirty is True
    assert client.get(old_lod_url).status_code == 200
    assert client.get(bootstrap["world"]["surface_snapshot_url"]).json()["zones"][0]["updating"] is True

    rebuilt = space_surface.generate_surface_zone(db, world, 0, 0)
    assert rebuilt is not None
    assert rebuilt.dirty is False
    assert client.get(old_lod_url).status_code == 409
    coarse = space_surface.decode_surface_lod(rebuilt, rebuilt.lod_manifest[-1])
    # Buildings are separate vertical solids, not a 64m-wide max-height pillar.
    assert struct.unpack_from('<H', coarse, 32)[0] < 256 * space_surface.MICRO_DIVISIONS
    trailer = coarse[32 + 64 * 8:]
    chunk_count, cx, cz, revision, count = struct.unpack_from('<IBBQI', trailer)
    assert (chunk_count, cx, cz, revision) == (1, 0, 0, 1)
    boxes = list(struct.iter_unpack('<6H3B', trailer[18:18 + count * 15]))
    assert len(boxes) == count
    assert (24, 2040, 24, 8, 8, 8, 0x12, 0x34, 0x56) in boxes
    raw = space_surface.decode_surface_zone_row(rebuilt)
    assert raw[32 + 512 * 512 * 8:32 + 512 * 512 * 8 + 18 + count * 15] == trailer[:18 + count * 15]
    assert trailer[18 + count * 15:18 + count * 15 + 4] == b'VXL7'


def test_space_terrain_batch_rejects_more_than_256_mutations(client, db):
    user = _user(db, "space-limit-001", "https://cdn.entropydrop.com/skins/limit.png")
    app.dependency_overrides[get_current_user] = lambda: user
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    mutations = [
        {"kind": "set_standard", "x": index, "y": 80, "z": 20, "block": 1, "color": 0x123456}
        for index in range(257)
    ]

    response = client.post(
        f"/space/api/v2/worlds/{world_id}/terrain-edits/batches",
        json={"batch_id": str(uuid.uuid4()), "mutations": mutations},
    )

    assert response.status_code == 422
    assert db.query(SpaceChunkSnapshot).count() == 0
    assert db.query(SpaceTerrainMutationBatch).count() == 0


def test_space_terrain_quota_counts_effective_changes_once(client, db, monkeypatch):
    user = _user(db, "space-quota-001", "https://cdn.entropydrop.com/skins/quota.png")
    app.dependency_overrides[get_current_user] = lambda: user
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    monkeypatch.setattr(space_router, "SPACE_TERRAIN_HOURLY_LIMIT", 2)
    monkeypatch.setattr(space_router, "SPACE_TERRAIN_DAILY_LIMIT", 2)
    usage_url = f"/space/api/v2/worlds/{world_id}/api-usage"
    before_usage = client.get(usage_url).json()

    def apply(batch_id: str, color: int):
        return client.post(
            f"/space/api/v2/worlds/{world_id}/terrain-edits/batches",
            json={
                "batch_id": batch_id,
                "mutations": [{
                    "kind": "set_standard",
                    "x": 1,
                    "y": 80,
                    "z": 1,
                    "block": 1,
                    "color": color,
                }],
            },
        )

    first_batch_id = str(uuid.uuid4())
    first = apply(first_batch_id, 1)
    duplicate = apply(first_batch_id, 1)
    no_op = apply(str(uuid.uuid4()), 1)
    second = apply(str(uuid.uuid4()), 2)
    blocked = apply(str(uuid.uuid4()), 3)

    assert first.status_code == 200
    assert first.json()["effective_changes"] == 1
    assert first.json()["quota"]["used_today"] == 1
    assert duplicate.json() == first.json()
    assert no_op.status_code == 200
    assert no_op.json()["effective_changes"] == 0
    assert no_op.json()["quota"]["used_today"] == 1
    assert second.status_code == 200
    assert second.json()["quota"] == {
        "daily_limit": 2,
        "used_today": 2,
        "remaining_today": 0,
        "reset_at": second.json()["quota"]["reset_at"],
    }
    assert blocked.status_code == 429
    assert blocked.json()["detail"]["code"] == "TERRAIN_EDIT_QUOTA_REACHED"
    assert blocked.json()["detail"]["used"] == 2
    assert blocked.headers["retry-after"]
    after_usage = client.get(usage_url).json()
    for window in ("hour", "day"):
        assert before_usage["quotas"]["terrain"][window]["used"] == 0
        assert after_usage["quotas"]["terrain"][window]["used"] == 2
        assert after_usage["quotas"]["terrain"][window]["remaining"] == 0
    assert after_usage["credits"] == before_usage["credits"], "Manual terrain edits are free"
    loaded = client.get(f"/space/api/v2/worlds/{world_id}/terrain-edits").json()
    assert loaded["chunks"][0]["standard"] == [[1, 80, 1, 1, 2]]
    assert db.query(SpaceTerrainMutationBatch).count() == 3
    assert {
        row.scope_id
        for row in db.query(SpaceUsageBucket).filter_by(metric="terrain_effective_changes").all()
    } == {"terrain"}


def test_admin_terrain_edits_record_usage_without_enforcing_caps(client, db, monkeypatch):
    user = _user(db, "terrain-admin", "https://cdn.entropydrop.com/skins/admin.png")
    user.is_admin = True
    user.credits = 7
    app.dependency_overrides[get_current_user] = lambda: user
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    monkeypatch.setattr(space_router, "SPACE_TERRAIN_HOURLY_LIMIT", 1)
    monkeypatch.setattr(space_router, "SPACE_TERRAIN_DAILY_LIMIT", 1)
    monkeypatch.setattr(space_router, "SPACE_TERRAIN_BURST_LIMIT", 1)
    monkeypatch.setattr(space_router, "SPACE_TERRAIN_WORLD_SECOND_LIMIT", 1)
    url = f"/space/api/v2/worlds/{world_id}/terrain-edits/batches"
    body = {
        "batch_id": str(uuid.uuid4()),
        "mutations": [
            {"kind": "set_standard", "x": x, "y": 80, "z": 1, "block": 1, "color": 1}
            for x in (1, 2, 3)
        ],
    }
    first = client.post(url, json=body)
    assert first.status_code == 200, first.text
    assert first.json()["effective_changes"] == 3
    assert first.json()["quota"]["used_today"] == 3
    assert client.post(url, json=body).json() == first.json(), "Retries must not double-count"
    no_op = client.post(url, json={**body, "batch_id": str(uuid.uuid4())})
    assert no_op.status_code == 200
    assert no_op.json()["effective_changes"] == 0
    assert no_op.json()["quota"]["used_today"] == 3
    changed = client.post(url, json={
        "batch_id": str(uuid.uuid4()),
        "mutations": [{**body["mutations"][0], "color": 2}],
    })
    assert changed.status_code == 200
    assert changed.json()["quota"]["used_today"] == 4
    usage = client.get(f"/space/api/v2/worlds/{world_id}/api-usage").json()
    assert usage["admin_quota_exemptions"] is True
    assert usage["credits"] == 7
    for window in ("hour", "day"):
        assert usage["quotas"]["terrain"][window]["used"] == 4
    assert db.query(SpaceUsageBucket).filter_by(metric="terrain_submitted_mutations").count() == 0


@pytest.mark.parametrize("is_admin", [False, True])
def test_space_terrain_effective_quota_includes_implicit_micro_clears(client, db, is_admin):
    user = _user(db, "space-quota-002", "https://cdn.entropydrop.com/skins/quota-2.png")
    user.is_admin = is_admin
    app.dependency_overrides[get_current_user] = lambda: user
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    added = client.post(
        f"/space/api/v2/worlds/{world_id}/terrain-edits/batches",
        json={
            "batch_id": str(uuid.uuid4()),
            "mutations": [
                {"kind": "set_micro", "mx": 8, "my": 640, "mz": 8, "color": 1},
                {"kind": "set_micro", "mx": 9, "my": 640, "mz": 8, "color": 2},
            ],
        },
    )
    replaced = client.post(
        f"/space/api/v2/worlds/{world_id}/terrain-edits/batches",
        json={
            "batch_id": str(uuid.uuid4()),
            "mutations": [
                {"kind": "set_standard", "x": 1, "y": 80, "z": 1, "block": 1, "color": 3},
            ],
        },
    )

    assert added.status_code == 200
    assert added.json()["effective_changes"] == 2
    assert replaced.status_code == 200
    assert replaced.json()["effective_changes"] == 3
    assert replaced.json()["quota"]["used_today"] == 5


def test_space_terrain_batch_enforces_spatial_footprint(client, db, monkeypatch):
    user = _user(db, "space-scope-001", "https://cdn.entropydrop.com/skins/scope.png")
    app.dependency_overrides[get_current_user] = lambda: user
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    monkeypatch.setattr(space_router, "SPACE_TERRAIN_MAX_CHUNKS_PER_BATCH", 1)

    response = client.post(
        f"/space/api/v2/worlds/{world_id}/terrain-edits/batches",
        json={
            "batch_id": str(uuid.uuid4()),
            "mutations": [
                {"kind": "set_standard", "x": 1, "y": 80, "z": 1, "block": 1, "color": 1},
                {"kind": "set_standard", "x": 17, "y": 80, "z": 1, "block": 1, "color": 2},
            ],
        },
    )

    assert response.status_code == 413
    assert response.json()["detail"] == {
        "code": "TERRAIN_BATCH_TOO_MANY_CHUNKS",
        "message": "A terrain batch touches too many chunks.",
        "limit": 1,
        "actual": 2,
    }
    assert db.query(SpaceChunkSnapshot).count() == 0


def test_space_terrain_edits_must_stay_near_authoritative_pose(client, db):
    user = _user(db, "space-scope-002", "https://cdn.entropydrop.com/skins/scope-2.png")
    app.dependency_overrides[get_current_user] = lambda: user
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    position = client.put(
        f"/space/api/v2/worlds/{world_id}/players/me/position",
        json={"x_cm": 100, "y_cm": 3200, "z_cm": 100, "yaw_q15": 0},
    )
    assert position.status_code == 200

    response = client.post(
        f"/space/api/v2/worlds/{world_id}/terrain-edits/batches",
        json={
            "batch_id": str(uuid.uuid4()),
            "mutations": [{
                "kind": "set_standard",
                "x": (space_router.SPACE_TERRAIN_EDIT_RADIUS_CHUNKS + 2) * 16,
                "y": 80,
                "z": 1,
                "block": 1,
                "color": 1,
            }],
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "TERRAIN_EDIT_OUT_OF_RANGE"
    assert db.query(SpaceChunkSnapshot).count() == 0


def test_space_terrain_snapshot_pages_use_a_stable_chunk_cursor(client, db):
    user = _user(db, "space-pages-001", "https://cdn.entropydrop.com/skins/pages.png")
    app.dependency_overrides[get_current_user] = lambda: user
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    response = client.post(
        f"/space/api/v2/worlds/{world_id}/terrain-edits/batches",
        json={
            "batch_id": str(uuid.uuid4()),
            "mutations": [
                {"kind": "set_standard", "x": 1, "y": 80, "z": 1, "block": 1, "color": 1},
                {"kind": "set_standard", "x": 33, "y": 80, "z": 1, "block": 1, "color": 2},
            ],
        },
    )
    assert response.status_code == 200

    first = client.get(f"/space/api/v2/worlds/{world_id}/terrain-edits?limit=1").json()
    second = client.get(
        f"/space/api/v2/worlds/{world_id}/terrain-edits",
        params={"limit": 1, "cursor": first["next_cursor"]},
    ).json()

    assert [(chunk["chunk_x"], chunk["chunk_z"]) for chunk in first["chunks"]] == [(0, 0)]
    assert first["next_cursor"] == "0,0"
    assert [(chunk["chunk_x"], chunk["chunk_z"]) for chunk in second["chunks"]] == [(2, 0)]
    assert second["next_cursor"] is None


def test_space_terrain_snapshot_aoi_wraps_at_world_edges(client, db):
    user = _user(db, "space-aoi-0001", "https://cdn.entropydrop.com/skins/aoi.png")
    app.dependency_overrides[get_current_user] = lambda: user
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    response = client.post(
        f"/space/api/v2/worlds/{world_id}/terrain-edits/batches",
        json={
            "batch_id": str(uuid.uuid4()),
            "mutations": [
                {"kind": "set_standard", "x": 1, "y": 80, "z": 1, "block": 1, "color": 1},
                {"kind": "set_standard", "x": 1023 * 16, "y": 80, "z": 1, "block": 1, "color": 2},
                {"kind": "set_standard", "x": 10 * 16, "y": 80, "z": 1, "block": 1, "color": 3},
            ],
        },
    )
    assert response.status_code == 200

    loaded = client.get(
        f"/space/api/v2/worlds/{world_id}/terrain-edits",
        params={"center_chunk_x": 0, "center_chunk_z": 0, "radius_chunks": 1},
    )

    assert loaded.status_code == 200
    assert [(chunk["chunk_x"], chunk["chunk_z"]) for chunk in loaded.json()["chunks"]] == [
        (0, 0),
        (1023, 0),
    ]


def test_rectangular_terrain_aoi_wraps_and_matches_heartbeat(client, db):
    user = _user(db, "space-rect-aoi", "https://cdn.entropydrop.com/skins/aoi.png")
    app.dependency_overrides[get_current_user] = lambda: user
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    coordinates = [(0, 0), (3, 0), (0, 3), (0, 127), (1023, 127), (0, 126)]
    response = client.post(f"/space/api/v2/worlds/{world_id}/terrain-edits/batches", json={
        "batch_id": str(uuid.uuid4()),
        "mutations": [{"kind": "set_standard", "x": x * 16, "y": 80, "z": z * 16,
                       "block": 1, "color": 123} for x, z in coordinates],
    })
    assert response.status_code == 200, response.text
    params = {"center_chunk_x": 0, "center_chunk_z": 0, "radius_chunks": 3, "radius_chunks_z": 1, "limit": 1}
    loaded = []
    while True:
        response = client.get(f"/space/api/v2/worlds/{world_id}/terrain-edits", params=params)
        assert response.status_code == 200, response.text
        page = response.json()
        loaded.extend((chunk["chunk_x"], chunk["chunk_z"]) for chunk in page["chunks"])
        if not page["next_cursor"]:
            break
        params["cursor"] = page["next_cursor"]
    expected = [(0, 0), (0, 127), (3, 0), (1023, 127)]
    assert loaded == expected
    response = client.post(f"/space/api/v2/worlds/{world_id}/heartbeat", json={
        "center_chunk_x": 0, "center_chunk_z": 0, "terrain_radius_chunks": 3,
        "terrain_radius_chunks_z": 1, "include_players": False,
    })
    assert response.status_code == 200, response.text
    assert sorted((chunk["chunk_x"], chunk["chunk_z"]) for chunk in response.json()["terrain_chunks"]) == expected
    legacy = client.get(f"/space/api/v2/worlds/{world_id}/terrain-edits", params={
        "center_chunk_x": 0, "center_chunk_z": 0, "radius_chunks": 3,
    })
    assert len(legacy.json()["chunks"]) == len(coordinates), 'old callers retain square AOIs'
    incomplete = client.get(f"/space/api/v2/worlds/{world_id}/terrain-edits", params={"radius_chunks_z": 1})
    assert incomplete.status_code == 422


def test_space_chunk_snapshots_use_zstd_when_it_reduces_payload(client, db):
    user = _user(db, "space-zstd-001", "https://cdn.entropydrop.com/skins/zstd.png")
    app.dependency_overrides[get_current_user] = lambda: user
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    mutations = [
        {
            "kind": "set_standard",
            "x": index % 16,
            "y": 40 + index // 16,
            "z": 1,
            "block": 1,
            "color": 0x123456,
        }
        for index in range(192)
    ]

    applied = client.post(
        f"/space/api/v2/worlds/{world_id}/terrain-edits/batches",
        json={"batch_id": str(uuid.uuid4()), "mutations": mutations},
    )
    assert applied.status_code == 200
    snapshot = db.query(SpaceChunkSnapshot).one()
    assert snapshot.codec == space_router.SPACE_CHUNK_CODEC_ZSTD
    assert len(snapshot.payload) < snapshot.uncompressed_size

    loaded = client.get(f"/space/api/v2/worlds/{world_id}/terrain-edits").json()
    assert len(loaded["chunks"][0]["standard"]) == len(mutations)


def test_space_epoch_one_batch_receipts_are_compact_and_reject_expired_replays(client, db):
    user = _user(db, "space-dedupe-01", "https://cdn.entropydrop.com/skins/dedupe.png")
    app.dependency_overrides[get_current_user] = lambda: user
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    batch_id = str(uuid.uuid4())
    now_ms = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
    payload = {
        "batch_id": batch_id,
        "dedupe_epoch": 1,
        "created_at_ms": now_ms,
        "mutations": [
            {"kind": "set_standard", "x": 1, "y": 80, "z": 1, "block": 1, "color": 1},
        ],
    }

    first = client.post(f"/space/api/v2/worlds/{world_id}/terrain-edits/batches", json=payload)
    duplicate = client.post(f"/space/api/v2/worlds/{world_id}/terrain-edits/batches", json=payload)
    assert first.status_code == 200
    assert duplicate.json() == first.json()
    receipt = db.query(SpaceTerrainMutationBatch).filter_by(batch_id=batch_id).one()
    assert receipt.dedupe_epoch == 1
    assert receipt.client_created_at is not None
    assert "world_id" not in receipt.result
    assert "batch_id" not in receipt.result

    expired_ms = int((
        datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=31)
    ).timestamp() * 1000)
    expired = client.post(
        f"/space/api/v2/worlds/{world_id}/terrain-edits/batches",
        json={**payload, "batch_id": str(uuid.uuid4()), "created_at_ms": expired_ms},
    )
    assert expired.status_code == 409
    assert expired.json()["detail"]["code"] == "TERRAIN_BATCH_EXPIRED"


def test_space_expired_receipt_cleanup_is_bounded(client, db, monkeypatch):
    user = _user(db, "space-cleanup01", "https://cdn.entropydrop.com/skins/cleanup.png")
    app.dependency_overrides[get_current_user] = lambda: user
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    expired_at = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=31)
    db.add_all([
        SpaceTerrainMutationBatch(
            world_id=world_id,
            batch_id=str(uuid.uuid4()),
            actor_user_id=user.id,
            dedupe_epoch=1,
            client_created_at=expired_at,
            result={"applied": 1},
        )
        for _ in range(space_router.TERRAIN_RECEIPT_CLEANUP_BATCH_SIZE + 1)
    ])
    db.commit()
    monkeypatch.setattr(space_router, "_last_receipt_cleanup_at", 0.0)

    now_ms = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
    fresh = client.post(
        f"/space/api/v2/worlds/{world_id}/terrain-edits/batches",
        json={
            "batch_id": str(uuid.uuid4()),
            "dedupe_epoch": 1,
            "created_at_ms": now_ms,
            "mutations": [
                {"kind": "set_standard", "x": 1, "y": 80, "z": 1, "block": 1, "color": 1},
            ],
        },
    )

    assert fresh.status_code == 200
    assert db.query(SpaceTerrainMutationBatch).filter(
        SpaceTerrainMutationBatch.client_created_at < datetime.datetime.now(datetime.timezone.utc)
        - datetime.timedelta(days=30)
    ).count() == 1


@pytest.mark.parametrize('event_ids', [[1, 2, 3, 4, 5, 6], [1, 1, 1, 1, 2, 2]])
@pytest.mark.parametrize('limit_bytes,limit_chunks', [(6000, 512), (100000, 2)])
def test_heartbeat_pages_without_skipping_partial_events(client, db, monkeypatch, event_ids, limit_bytes, limit_chunks):
    user = _user(db, 'heartbeat-size', None)
    app.dependency_overrides[get_current_user] = lambda: user
    world = client.post('/space/api/v2/bootstrap').json()['world']['id']
    monkeypatch.setattr(space_router, 'SPACE_TERRAIN_MAX_RESPONSE_BYTES', limit_bytes)
    monkeypatch.setattr(space_router, 'SPACE_TERRAIN_MAX_RESPONSE_CHUNKS', limit_chunks)
    for cx, event in enumerate(event_ids):
        # UTF-8 names exercise actual wire bytes instead of character counts.
        overlay = {'standard': [], 'micro': [[cx * 128 + i, 0, 0, 0xffffff, 'Block 🚀' * 4] for i in range(30)]}
        payload, digest, codec, size = space_router._encode_chunk_overlay(overlay)
        db.add(SpaceChunkSnapshot(world_id=world, chunk_x=cx, chunk_z=0, revision=1, last_event_id=event,
                                 codec=codec, codec_version=1, uncompressed_size=size, content_hash=digest, payload=payload))
    db.commit()
    since, cursor, observed, pages = 0, None, [], []
    for _ in range(10):
        response = client.post(f'/space/api/v2/worlds/{world}/heartbeat', json={
            'since_terrain_revision': since, 'terrain_cursor': cursor, 'include_players': False,
            'center_chunk_x': 0, 'center_chunk_z': 0, 'terrain_radius_chunks': 32,
        })
        assert response.status_code == 200, response.text
        assert len(response.content) <= limit_bytes
        result = response.json()
        assert len(result['terrain_chunks']) <= limit_chunks
        pages.append(result)
        observed.extend(chunk['chunk_x'] for chunk in result['terrain_chunks'])
        since, cursor = result['max_terrain_revision'], result['terrain_cursor']
        if since == max(event_ids) and cursor is None:
            break
    assert observed == list(range(6)), 'every chunk must be returned exactly once'
    assert len(pages) > 1
    if event_ids[0] == event_ids[1]:
        assert pages[0]['max_terrain_revision'] == 0
        assert pages[0]['terrain_cursor'].startswith('1:')
    else:
        assert pages[0]['max_terrain_revision'] > 0
        assert pages[0]['terrain_cursor'] is None


def test_surface_upgrade_serves_last_good_legacy_snapshot_until_v7_is_ready(client, db):
    import hashlib
    import zstandard as zstd
    user = _user(db, 'space-surface-upgrade', None)
    app.dependency_overrides[get_current_user] = lambda: user
    bootstrap = client.post('/space/api/v2/bootstrap').json()
    world = db.query(SpaceWorld).filter_by(id=bootstrap['world']['id']).one()
    fine = struct.pack('<4sBBBBHHiIQI', b'EDSZ', 3, 8, 32, 5, 0, 0,
                       world.seed, world.terrain_generator_version, 0, 65536)
    fine += struct.pack('<HBBB', 136, 113, 143, 97) * 65536
    coarse = struct.pack('<4sBBBBHHiIQI', b'EDSZ', 4, 64, 32, 5, 0, 0,
                         world.seed, world.terrain_generator_version, 0, 64)
    coarse += struct.pack('<HBBB', 136, 113, 143, 97) * 64
    compressed = zstd.ZstdCompressor().compress(coarse)
    row = SpaceSurfaceZoneSnapshot(world_id=world.id, zone_x=0, zone_z=0,
        schema_version=3, samples_per_chunk_axis=8, terrain_generator_version=world.terrain_generator_version,
        uncompressed_size=len(fine), content_hash=hashlib.sha256(fine).digest(),
        payload=zstd.ZstdCompressor().compress(fine), lod_payload=compressed,
        lod_manifest=[{'sample_size':64, 'byte_length':len(coarse),
                       'digest':hashlib.sha256(coarse).hexdigest(),
                       'offset':0, 'compressed_size':len(compressed)}])
    db.add(row)
    db.commit()
    manifest = client.get(bootstrap['world']['surface_snapshot_url']).json()
    assert manifest['schema_version'] == 7
    assert manifest['complete'] is False
    assert manifest['zones'][0]['updating'] is True
    assert client.get(manifest['zones'][0]['url']).content == fine
    assert client.get(manifest['zones'][0]['lods'][0]['url']).content == coarse


@pytest.mark.parametrize('alias', ['aether-archipelago', '00000000-0000-4000-8000-000000000004'])
def test_development_aether_bootstrap(client, db, alias):
    user = _user(db, 'aether-user', None)
    app.dependency_overrides[get_current_user] = lambda: user
    response = client.post('/space/api/v2/bootstrap', params={'world': alias})
    assert response.status_code == 200
    payload = response.json()
    assert payload['world']['id'] == space_router.settings.SPACE_AETHER_ARCHIPELAGO_WORLD_ID
    assert payload['world']['name'] == 'Aether Archipelago'
    assert payload['world']['seed'] == 42
    assert payload['world']['terrain_generator_version'] == 3
    assert (payload['player']['start_x_cm'], payload['player']['start_y_cm'], payload['player']['start_z_cm']) == (819250, 18000, 102450)
    assert db.query(SpaceWorld).filter_by(id=payload['world']['id']).count() == 1


@pytest.mark.parametrize('alias', ['aether-archipelago', '00000000-0000-4000-8000-000000000004'])
def test_production_cannot_provision_aether(client, db, monkeypatch, alias):
    monkeypatch.setattr(space_router.settings, 'ENVIRONMENT', 'production')
    user = _user(db, 'aether-production-user', None)
    app.dependency_overrides[get_current_user] = lambda: user
    assert client.post('/space/api/v2/bootstrap', params={'world': alias}).status_code == 404
    assert db.query(SpaceWorld).filter_by(id=space_router.settings.SPACE_AETHER_ARCHIPELAGO_WORLD_ID).count() == 0


LAB_WORLDS = [
    ('colossus-harbor', 'COLOSSUS_HARBOR', 'Colossus Harbor', 4),
    ('titan-canyon', 'TITAN_CANYON', 'Titan Canyon', 5),
    ('astral-foundry', 'ASTRAL_FOUNDRY', 'Astral Foundry', 6),
]


@pytest.mark.parametrize('alias,key,name,version', LAB_WORLDS)
def test_development_terrain_lab_world_bootstrap(client, db, alias, key, name, version):
    user = _user(db, 'lab-world-user', None)
    app.dependency_overrides[get_current_user] = lambda: user
    world_id = getattr(space_router.settings, f'SPACE_{key}_WORLD_ID')
    for requested in [alias, world_id]:
        response = client.post('/space/api/v2/bootstrap', params={'world': requested})
        assert response.status_code == 200
        payload = response.json()
        assert payload['world']['id'] == world_id
        assert payload['world']['name'] == name
        assert payload['world']['seed'] == 42
        assert payload['world']['terrain_generator_version'] == version
        assert (payload['player']['start_x_cm'], payload['player']['start_y_cm'], payload['player']['start_z_cm']) == (819250, 22000, 102450)
    assert db.query(SpaceWorld).filter_by(id=world_id).count() == 1
    assert version in space_surface.RUNTIME_TERRAIN_GENERATORS


@pytest.mark.parametrize('alias,key,name,version', LAB_WORLDS)
def test_production_cannot_provision_terrain_lab_worlds(client, db, monkeypatch, alias, key, name, version):
    monkeypatch.setattr(space_router.settings, 'ENVIRONMENT', 'production')
    user = _user(db, 'lab-production-user', None)
    app.dependency_overrides[get_current_user] = lambda: user
    world_id = getattr(space_router.settings, f'SPACE_{key}_WORLD_ID')
    for requested in [alias, world_id]:
        assert client.post('/space/api/v2/bootstrap', params={'world': requested}).status_code == 404
    assert db.query(SpaceWorld).filter_by(id=world_id).count() == 0
