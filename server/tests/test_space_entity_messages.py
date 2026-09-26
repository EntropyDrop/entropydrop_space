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
