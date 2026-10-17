import asyncio
import datetime as dt
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from routers import space_entity_messages as messages


class AsyncRouteRedis:
    def __init__(self):
        self.channel = None

    async def get(self, _key):
        return b"2.current"

    async def publish(self, channel, _payload):
        self.channel = channel
        return 1

    async def eval(self, *_args):
        return 1


class IdempotencyRedis:
    def __init__(self):
        self.values = {}

    def set(self, key, value, ex=None, nx=False):
        if nx and key in self.values:
            return False
        self.values[key] = value
        return True

    def get(self, key):
        return self.values.get(key)

    def eval(self, script, _keys, key, expected, *args):
        current = self.values.get(key)
        expected_bytes = expected.encode() if isinstance(expected, str) else expected
        if current != expected_bytes:
            return 0
        if script == messages._IDEMPOTENCY_FINISH_LUA:
            final, _ttl = args
            self.values[key] = final.encode() if isinstance(final, str) else final
        else:
            self.values.pop(key, None)
        return 1


def test_message_channels_are_execution_epoch_fenced():
    hub = messages.EntityMessageHub.__new__(messages.EntityMessageHub)
    hub.redis = AsyncRouteRedis()
    routed = asyncio.run(hub.route("world", "target", 2, {"type": "entity_message"}))
    assert routed is True
    assert hub.redis.channel == messages._message_channel("world", "target", 2)
    assert hub.redis.channel != messages._message_channel("world", "target", 1)


def test_browser_source_requires_the_exact_live_execution_endpoint():
    now = dt.datetime.now(dt.timezone.utc)
    source = SimpleNamespace(
        desired_run_state="running",
        execution_mode="browser",
        execution_user_id="user",
        execution_instance_id="instance",
        execution_epoch=4,
        execution_lease_expires_at=now + dt.timedelta(seconds=10),
    )
    db = SimpleNamespace(get=lambda *_args: source)
    assert messages._active_browser_source_or_error(
        db, "world", "source", "user", "instance", 4,
    ) is source
    with pytest.raises(HTTPException) as wrong_instance:
        messages._active_browser_source_or_error(
            db, "world", "source", "user", "other", 4,
        )
    assert wrong_instance.value.status_code == 409
    source.desired_run_state = "stopped"
    with pytest.raises(HTTPException) as stopped:
        messages._active_browser_source_or_error(
            db, "world", "source", "user", "instance", 4,
        )
    assert stopped.value.detail["code"] == "ENTITY_NOT_ACTIVE"


def test_protobuf_types_require_an_explicit_schema_version():
    messages._validate_message_type("radar.v1", "protobuf")
    with pytest.raises(HTTPException) as unversioned:
        messages._validate_message_type("radar", "protobuf")
    assert unversioned.value.detail["code"] == "ENTITY_PROTOBUF_TYPE_VERSION_REQUIRED"
    with pytest.raises(HTTPException):
        messages._validate_message_type("chat", "protobuf")


def test_route_rechecks_source_immediately_before_publish(monkeypatch):
    routed = []

    class Hub:
        async def route(self, *_args):
            routed.append(True)
            return True

    monkeypatch.setattr(messages, "entity_message_hub", Hub())
    monkeypatch.setattr(messages, "_check_entity_rate_limit", lambda *_args: (True, 0))
    monkeypatch.setattr(messages, "_target_execution_epoch", lambda *_args: 7)

    with pytest.raises(HTTPException) as stopped:
        asyncio.run(messages._route_entity_message(
            "world", "source", "target", "chat", "utf8", "hello",
            source_is_active=lambda: False,
        ))
    assert stopped.value.detail["code"] == "ENTITY_EXECUTION_NOT_ACTIVE"
    assert routed == []

    dropped = asyncio.run(messages._route_entity_message(
        "world", "source", "target", "chat", "utf8", "hello",
        source_is_active=lambda: False,
        inactive_source_is_error=False,
    ))
    assert dropped["status"] == "dropped"
    assert dropped["reason"] == "source_inactive"
    assert routed == []


def test_idempotency_replays_the_original_result_and_rejects_key_reuse(monkeypatch):
    redis = IdempotencyRedis()
    monkeypatch.setattr(messages, "_ticket_redis", redis)
    fingerprint = messages._message_fingerprint("target", "chat", "utf8", b"hello")
    pending, replay = messages._begin_idempotent_send("world", "source", "operation:1", fingerprint)
    assert pending and replay is None
    result = {"message_id": "message-1", "status": "routed"}
    messages._finish_idempotent_send(
        "world", "source", "operation:1", fingerprint, pending, result,
    )
    _pending, replay = messages._begin_idempotent_send(
        "world", "source", "operation:1", fingerprint,
    )
    assert replay == result
    different = messages._message_fingerprint("target", "chat", "utf8", b"different")
    with pytest.raises(HTTPException) as conflict:
        messages._begin_idempotent_send("world", "source", "operation:1", different)
    assert conflict.value.detail["code"] == "ENTITY_MESSAGE_IDEMPOTENCY_CONFLICT"


def clicked_block(**overrides):
    return {"eventId": "click-1", "entityId": "untrusted", "playerId": "untrusted", "nodeId": "door",
            "kind": "decoration", "position": [1, 2, 3], "size": None, "decorationId": "handle",
            "point": [4, 5, 6], "localPoint": [1, 2, 3.5], **overrides}


def test_native_click_validation_stamps_actor_and_target_and_supports_all_kinds():
    value = messages.normalize_clicked_block(clicked_block(), "target", "visitor")
    assert value["entityId"] == "target"
    assert value["playerId"] == "visitor"
    assert value["decorationId"] == "handle"
    for kind, size in (("standard", 1), ("micro", 0.125)):
        assert messages.normalize_clicked_block(clicked_block(kind=kind, size=size, decorationId=None), "target", "visitor")["size"] == size
    for fields in ({"point": [float("nan"), 1, 2]}, {"point": [1, 2]}, {"size": 1},
                   {"kind": "unknown"}, {"nodeId": ""}, {"decorationId": ""}, {"point": [True, 1, 2]}, {"point": [10**400, 1, 2]}):
        with pytest.raises(HTTPException) as invalid:
            messages.normalize_clicked_block(clicked_block(**fields), "target", "visitor")
        assert invalid.value.detail["code"] == "ENTITY_CLICK_INVALID"


def test_native_click_routes_to_current_executor_with_per_player_limit_and_no_source_entity(monkeypatch):
    routed, limited = [], []

    class Hub:
        async def route(self, *args):
            routed.append(args)
            return True

    monkeypatch.setattr(messages, "entity_message_hub", Hub())
    monkeypatch.setattr(messages, "_check_entity_rate_limit", lambda *args: (limited.append(args) or True, 0))
    monkeypatch.setattr(messages, "_target_execution_epoch", lambda *_args: 9)
    click = messages.normalize_clicked_block(clicked_block(), "target", "visitor")
    result = asyncio.run(messages._route_entity_message("world", "visitor", "target", "clicked_block", "utf8", json.dumps(click), native_click=click, expected_target_epoch=9))
    assert result == {"message_id": "click-1", "status": "routed"}
    assert limited == [("world", "player:visitor")]
    assert routed[0][:3] == ("world", "target", 9)
    assert routed[0][3]["clicked_block"] is True
    assert json.loads(routed[0][3]["payload"])["playerId"] == "visitor"
    stale = asyncio.run(messages._route_entity_message("world", "visitor", "target", "clicked_block", "utf8", json.dumps(click), native_click=click, expected_target_epoch=8))
    assert stale == {"message_id": "click-1", "status": "dropped", "reason": "target_epoch_changed"}
    assert len(routed) == 1, 'a delayed click must not be upgraded to the current execution epoch'
    monkeypatch.setattr(messages, "_target_execution_epoch", lambda *_args: None)
    result = asyncio.run(messages._route_entity_message("world", "visitor", "target", "clicked_block", "utf8", json.dumps(click), native_click=click, expected_target_epoch=9))
    assert result["status"] == "dropped"
    assert len(routed) == 1


def test_click_authorization_requires_world_membership_and_releases_transaction(monkeypatch):
    calls = []
    user = SimpleNamespace(id="visitor")
    db = SimpleNamespace(rollback=lambda: calls.append("rollback"))
    def membership(database, world_id, actor):
        assert (database, world_id, actor) == (db, "world", user)
        calls.append("membership")
        return SimpleNamespace(id="world")
    monkeypatch.setattr(messages.space_api, "_require_world_membership", membership)
    assert messages._authorize_player_click(db, "world", user) == ("world", "visitor")
    assert calls == ["membership", "rollback"]


def test_player_click_http_route_stamps_identity_and_replays_without_double_delivery(client, db, monkeypatch):
    import uuid
    from space.auth import get_current_user
    from space.main import app
    from tests.test_space_entities import _user

    actor = _user(db, "click-visitor")
    app.dependency_overrides[get_current_user] = lambda: actor
    world_id = client.post("/space/api/v2/bootstrap").json()["world"]["id"]
    target = str(uuid.uuid4())
    routed = []

    class Hub:
        async def route(self, *args):
            routed.append(args)
            return True

    monkeypatch.setattr(messages, "_ticket_redis", IdempotencyRedis())
    monkeypatch.setattr(messages, "entity_message_hub", Hub())
    monkeypatch.setattr(messages, "_check_entity_rate_limit", lambda *_args: (True, 0))
    monkeypatch.setattr(messages, "_target_execution_epoch", lambda *_args: 5)
    url = f"/space/api/v2/worlds/{world_id}/entities/{target}/clicked-block"
    headers = {"Idempotency-Key": "click-1", "Entity-Target-Execution-Epoch": "5"}
    first = client.post(url, json=clicked_block(), headers=headers)
    assert first.status_code == 202, first.text
    assert client.post(url, json=clicked_block(), headers=headers).json() == first.json()
    assert len(routed) == 1
    record = json.loads(routed[0][3]["payload"])
    assert record["playerId"] == actor.id
    assert record["entityId"] == target
    assert client.post(url, json=clicked_block(position=[3, 2, 1]), headers=headers).status_code == 409
    assert client.post(url, json=clicked_block(), headers={**headers, "Entity-Target-Execution-Epoch": "6"}).status_code == 409
    for epoch in ("", "0", "-1", "1.5", "9007199254740992"):
        invalid = client.post(url, json=clicked_block(), headers={**headers, "Entity-Target-Execution-Epoch": epoch})
        assert invalid.status_code == 400
        assert invalid.json()["detail"]["code"] == "ENTITY_CLICK_EXECUTION_EPOCH_INVALID"
    assert client.post(url, json=clicked_block(), headers={"Idempotency-Key": "wrong"}).status_code == 400
    assert client.post(url, content=b"{" * 4097).status_code == 413
    assert len(routed) == 1


def test_native_click_identity_limits_match_javascript_utf16_units():
    astral = chr(0x1F600)
    assert messages.normalize_clicked_block(clicked_block(nodeId=astral * 64, decorationId=astral * 64), "target", "visitor")
    for field in ("nodeId", "decorationId"):
        with pytest.raises(HTTPException) as invalid:
            messages.normalize_clicked_block(clicked_block(**{field: astral * 65}), "target", "visitor")
        assert invalid.value.detail["code"] == "ENTITY_CLICK_INVALID"
