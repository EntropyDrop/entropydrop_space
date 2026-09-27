"""Ephemeral, bounded messages between running Space entities."""
import asyncio
import contextlib
import datetime as dt
import hashlib
import json
import logging
import re
import secrets
import time
import uuid
from collections.abc import Callable

import jwt
import msgpack
from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from redis.asyncio import Redis as AsyncRedis
from sqlalchemy.orm import Session
from starlette.responses import JSONResponse

from config import settings
from rate_limit import get_authenticated_or_remote_address, limiter
from routers import space as space_api
from routers.space_entities import EntityCreator, _entity_creator, _utc
from routers.space_realtime import _allowed_origins, _consume_ticket_once, _is_production, _ticket_redis
from space import models
from space import auth
from space.database import SessionLocal, get_db


logger = logging.getLogger(__name__)
router = APIRouter(tags=["space-entity-messages"])

MAX_PAYLOAD_BYTES = 4096
MAX_TYPE_BYTES = 16
ENTITY_MESSAGE_RATE = 20
ENTITY_MESSAGE_WINDOW_MS = 1000
ENTITY_MESSAGE_TICKET_TTL_SECONDS = 30
ENTITY_MESSAGE_PRESENCE_TTL_SECONDS = 30
ENTITY_MESSAGE_PRESENCE_REFRESH_SECONDS = 10
ENTITY_MESSAGE_PROTOCOL = "space-entity-messages-v1"
ENTITY_MESSAGE_IDEMPOTENCY_PENDING_SECONDS = 300
ENTITY_MESSAGE_IDEMPOTENCY_RESULT_SECONDS = 300
_TYPE_RE = re.compile(r"^[a-z][a-z0-9._-]{0,15}$", re.ASCII)
_IDEMPOTENCY_KEY_RE = re.compile(r"^[A-Za-z0-9._:-]{1,80}$", re.ASCII)


_RATE_LIMIT_LUA = """
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = window
  if #oldest >= 2 then retry = math.max(1, tonumber(oldest[2]) + window - now) end
  return {0, retry}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window * 2)
return {1, 0}
"""

_PRESENCE_REFRESH_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
"""

_PRESENCE_ACTIVATE_LUA = """
local key = KEYS[1]
local old = redis.call('GET', key)
if not old then
  redis.call('SET', key, ARGV[1], 'EX', ARGV[2], 'NX')
  return 1
end
local old_epoch = string.match(old, '^(%d+)%.')
if old_epoch and tonumber(old_epoch) ~= tonumber(ARGV[3]) then
  redis.call('SET', key, ARGV[1], 'EX', ARGV[2])
  return 1
end
return 0
"""

_PRESENCE_DELETE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""

_IDEMPOTENCY_FINISH_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
end
return 0
"""


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _entity_is_running(entity: models.SpaceWorldEntity | None, *, now: dt.datetime | None = None) -> bool:
    if entity is None or entity.desired_run_state != "running":
        return False
    now = now or _now()
    if entity.execution_mode == "hosted":
        last_tick = _utc(entity.hosting_last_tick_at)
        return bool(
            entity.hosting_enabled
            and last_tick is not None
            and (now - last_tick).total_seconds() <= 15
        )
    expiry = _utc(entity.execution_lease_expires_at)
    return bool(entity.execution_instance_id and expiry is not None and expiry > now)


def _presence_key(world_id: str, entity_id: str) -> str:
    return f"space:entity-messages:{world_id}:{entity_id}:presence"


def _message_channel(world_id: str, entity_id: str, execution_epoch: int) -> str:
    return f"space:entity-messages:{world_id}:{entity_id}:{int(execution_epoch)}:inbox"


def _active_browser_source_or_error(
    db: Session,
    world_id: str,
    source_id: str,
    user_id: str,
    execution_instance_id: str,
    execution_epoch: int,
) -> models.SpaceWorldEntity:
    source = db.get(models.SpaceWorldEntity, (world_id, source_id))
    if not _entity_is_running(source):
        raise HTTPException(409, detail={"code": "ENTITY_NOT_ACTIVE"})
    assert source is not None
    if source.execution_user_id != user_id:
        raise HTTPException(403, detail={"code": "ENTITY_EXECUTION_REQUIRED"})
    if (
        source.execution_mode != "browser"
        or str(source.execution_instance_id or "") != execution_instance_id
        or int(source.execution_epoch or 0) != execution_epoch
    ):
        raise HTTPException(409, detail={"code": "ENTITY_EXECUTION_NOT_ACTIVE"})
    return source


def _browser_source_is_active(
    world_id: str,
    source_id: str,
    user_id: str,
    execution_instance_id: str,
    execution_epoch: int,
) -> bool:
    db = SessionLocal()
    try:
        try:
            _active_browser_source_or_error(
                db, world_id, source_id, user_id, execution_instance_id, execution_epoch,
            )
            return True
        except HTTPException:
            return False
    finally:
        db.close()


def _validate_message_type(message_type: str, encoding: str) -> None:
    if not isinstance(message_type, str) or not message_type.isascii() or not _TYPE_RE.fullmatch(message_type):
        raise HTTPException(400, detail={"code": "ENTITY_MESSAGE_TYPE_INVALID", "max_bytes": MAX_TYPE_BYTES})
    if encoding not in ("utf8", "protobuf"):
        raise HTTPException(415, detail={"code": "ENTITY_MESSAGE_ENCODING_UNSUPPORTED"})
    if message_type == "chat" and encoding != "utf8":
        raise HTTPException(400, detail={"code": "ENTITY_CHAT_REQUIRES_UTF8"})
    if encoding == "protobuf" and re.search(r"\.v[1-9][0-9]*$", message_type) is None:
        raise HTTPException(400, detail={"code": "ENTITY_PROTOBUF_TYPE_VERSION_REQUIRED"})


def _execution_identity_from_request(request: Request) -> tuple[str, int]:
    instance_header = request.headers.get("entity-execution-instance", "")
    epoch_header = request.headers.get("entity-execution-epoch", "")
    try:
        execution_instance_id = str(uuid.UUID(instance_header))
        execution_epoch = int(epoch_header)
        if execution_epoch < 1 or str(execution_epoch) != epoch_header:
            raise ValueError
        return execution_instance_id, execution_epoch
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, detail={"code": "ENTITY_MESSAGE_EXECUTION_IDENTITY_INVALID"}) from exc


def _ticket_for_entity(
    world_id: str,
    entity_id: str,
    user_id: str,
    execution_instance_id: str,
    execution_epoch: int,
) -> str:
    now = _now()
    return jwt.encode(
        {
            "sub": user_id,
            "world_id": world_id,
            "entity_id": entity_id,
            "execution_instance_id": execution_instance_id,
            "execution_epoch": execution_epoch,
            "type": "space-entity-message",
            "jti": secrets.token_urlsafe(18),
            "iat": now,
            "exp": now + dt.timedelta(seconds=ENTITY_MESSAGE_TICKET_TTL_SECONDS),
        },
        settings.SPACE_JOIN_TICKET_SECRET,
        algorithm="HS256",
    )


def _decode_entity_ticket(ticket: str) -> dict:
    try:
        payload = jwt.decode(ticket, settings.SPACE_JOIN_TICKET_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(401, detail={"code": "ENTITY_MESSAGE_TICKET_INVALID"}) from exc
    if (
        payload.get("type") != "space-entity-message"
        or not payload.get("sub")
        or not payload.get("world_id")
        or not payload.get("entity_id")
        or not payload.get("execution_instance_id")
        or not payload.get("jti")
        or not isinstance(payload.get("execution_epoch"), int)
    ):
        raise HTTPException(401, detail={"code": "ENTITY_MESSAGE_TICKET_INVALID"})
    return payload


def _authenticate_entity_ticket(ticket: str) -> dict:
    payload = _decode_entity_ticket(ticket)
    if _is_production():
        try:
            consumed = bool(_ticket_redis.set(
                f"space:realtime:ticket-used:{payload['jti']}",
                b"1",
                ex=ENTITY_MESSAGE_TICKET_TTL_SECONDS * 2,
                nx=True,
            ))
        except Exception as exc:
            logger.exception("Redis is required to consume entity message tickets")
            raise HTTPException(503, detail={"code": "ENTITY_MESSAGE_SERVICE_UNAVAILABLE"}) from exc
    else:
        consumed = _consume_ticket_once(str(payload["jti"]))
    if not consumed:
        raise HTTPException(401, detail={"code": "ENTITY_MESSAGE_TICKET_ALREADY_USED"})
    db = SessionLocal()
    try:
        entity = db.get(
            models.SpaceWorldEntity,
            (str(payload["world_id"]), str(payload["entity_id"])),
        )
        if (
            not _entity_is_running(entity)
            or entity is None
            or entity.execution_user_id != str(payload["sub"])
            or str(entity.execution_instance_id or "") != str(payload["execution_instance_id"])
            or int(entity.execution_epoch or 0) != int(payload["execution_epoch"])
        ):
            raise HTTPException(403, detail={"code": "ENTITY_EXECUTION_NOT_ACTIVE"})
        return payload
    finally:
        db.close()


class EntityMessageHub:
    def __init__(self) -> None:
        self.redis = AsyncRedis.from_url(
            settings.REDIS_URL,
            health_check_interval=20,
            socket_timeout=2,
            socket_connect_timeout=2,
            retry_on_timeout=True,
        )

    async def activate(self, world_id: str, entity_id: str, connection_id: str, execution_epoch: int) -> bool:
        result = await self.redis.eval(
            _PRESENCE_ACTIVATE_LUA,
            1,
            _presence_key(world_id, entity_id),
            connection_id,
            ENTITY_MESSAGE_PRESENCE_TTL_SECONDS,
            execution_epoch,
        )
        return bool(result)

    async def refresh(self, world_id: str, entity_id: str, connection_id: str) -> bool:
        result = await self.redis.eval(
            _PRESENCE_REFRESH_LUA,
            1,
            _presence_key(world_id, entity_id),
            connection_id,
            ENTITY_MESSAGE_PRESENCE_TTL_SECONDS,
        )
        return bool(result)

    async def deactivate(self, world_id: str, entity_id: str, connection_id: str) -> None:
        await self.redis.eval(
            _PRESENCE_DELETE_LUA,
            1,
            _presence_key(world_id, entity_id),
            connection_id,
        )

    async def route(self, world_id: str, target_id: str, target_epoch: int, payload: dict) -> bool:
        presence_key = _presence_key(world_id, target_id)
        connection_id = await self.redis.get(presence_key)
        if connection_id is None:
            return False
        connection_id = connection_id.decode() if isinstance(connection_id, bytes) else str(connection_id)
        epoch_prefix, separator, _random_id = connection_id.partition(".")
        if not separator or not epoch_prefix.isdigit() or int(epoch_prefix) != target_epoch:
            await self.redis.eval(_PRESENCE_DELETE_LUA, 1, presence_key, connection_id)
            return False
        subscribers = await self.redis.publish(
            _message_channel(world_id, target_id, target_epoch),
            msgpack.packb(payload, use_bin_type=True),
        )
        if subscribers:
            return True
        await self.redis.eval(_PRESENCE_DELETE_LUA, 1, presence_key, connection_id)
        return False


entity_message_hub = EntityMessageHub()


@router.post(
    "/space/api/v2/worlds/{world_id}/entities/{source_id}/messages/{target_id}/{message_type}/{encoding}",
    status_code=202,
)
@limiter.limit("1200/minute; 50000/hour", key_func=get_authenticated_or_remote_address)
async def send_entity_message(
    request: Request,
    world_id: uuid.UUID,
    source_id: uuid.UUID,
    target_id: uuid.UUID,
    message_type: str,
    encoding: str,
    db: Session = Depends(get_db),
    creator: EntityCreator = Depends(_entity_creator),
):
    world = space_api._require_world_membership(db, str(world_id), creator.user)
    execution_instance_id, execution_epoch = _execution_identity_from_request(request)
    _active_browser_source_or_error(
        db, str(world.id), str(source_id), creator.user.id,
        execution_instance_id, execution_epoch,
    )

    _validate_message_type(message_type, encoding)
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/octet-stream":
        raise HTTPException(415, detail={"code": "ENTITY_MESSAGE_CONTENT_TYPE_REQUIRED"})
    idempotency_key = request.headers.get("idempotency-key")
    if idempotency_key is None:
        raise HTTPException(400, detail={"code": "ENTITY_MESSAGE_IDEMPOTENCY_KEY_REQUIRED"})
    if not _IDEMPOTENCY_KEY_RE.fullmatch(idempotency_key):
        raise HTTPException(400, detail={"code": "ENTITY_MESSAGE_IDEMPOTENCY_KEY_INVALID"})

    content_length = request.headers.get("content-length")
    if content_length:
        try:
            declared_length = int(content_length)
            if declared_length < 0:
                raise ValueError
            if declared_length > MAX_PAYLOAD_BYTES:
                raise HTTPException(413, detail={"code": "ENTITY_MESSAGE_TOO_LARGE", "limit_bytes": MAX_PAYLOAD_BYTES})
        except ValueError as exc:
            raise HTTPException(400, detail={"code": "CONTENT_LENGTH_INVALID"}) from exc
    chunks: list[bytes] = []
    byte_count = 0
    async for chunk in request.stream():
        byte_count += len(chunk)
        if byte_count > MAX_PAYLOAD_BYTES:
            raise HTTPException(413, detail={"code": "ENTITY_MESSAGE_TOO_LARGE", "limit_bytes": MAX_PAYLOAD_BYTES})
        chunks.append(chunk)
    payload = b"".join(chunks)
    if encoding == "utf8":
        try:
            payload.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise HTTPException(400, detail={"code": "ENTITY_MESSAGE_UTF8_INVALID"}) from exc

    if not await asyncio.to_thread(
        _browser_source_is_active,
        str(world.id), str(source_id), creator.user.id,
        execution_instance_id, execution_epoch,
    ):
        raise HTTPException(409, detail={"code": "ENTITY_EXECUTION_NOT_ACTIVE"})

    fingerprint = _message_fingerprint(str(target_id), message_type, encoding, payload)
    pending, replay = await asyncio.to_thread(
        _begin_idempotent_send,
        str(world.id), str(source_id), idempotency_key, fingerprint,
    )
    if replay is not None:
        return JSONResponse(status_code=202 if replay["status"] == "routed" else 200, content=replay)
    try:
        result = await _route_entity_message(
            str(world.id), str(source_id), str(target_id), message_type, encoding, payload,
            source_is_active=lambda: _browser_source_is_active(
                str(world.id), str(source_id), creator.user.id,
                execution_instance_id, execution_epoch,
            ),
        )
    except Exception:
        if pending:
            await asyncio.to_thread(
                _release_idempotent_send,
                str(world.id), str(source_id), idempotency_key, pending,
            )
        raise
    await asyncio.to_thread(
        _finish_idempotent_send,
        str(world.id), str(source_id), idempotency_key, fingerprint, pending, result,
    )
    return JSONResponse(status_code=202 if result["status"] == "routed" else 200, content=result)


def _check_entity_rate_limit(world_id: str, source_id: str) -> tuple[bool, int]:
    now_ms = int(time.time() * 1000)
    result = _ticket_redis.eval(
        _RATE_LIMIT_LUA,
        1,
        f"space:entity-messages:{world_id}:{source_id}:rate",
        now_ms,
        ENTITY_MESSAGE_WINDOW_MS,
        ENTITY_MESSAGE_RATE,
        secrets.token_urlsafe(12),
    )
    if not isinstance(result, (list, tuple)) or len(result) < 2:
        raise RuntimeError("Redis returned an invalid entity message rate result")
    return bool(int(result[0])), max(0, int(result[1]))


def _idempotency_redis_key(world_id: str, source_id: str, idempotency_key: str) -> str:
    digest = hashlib.sha256(idempotency_key.encode("ascii")).hexdigest()
    return f"space:entity-messages:{world_id}:{source_id}:idempotency:{digest}"


def _message_fingerprint(target_id: str, message_type: str, encoding: str, payload: bytes) -> str:
    digest = hashlib.sha256()
    for value in (target_id, message_type, encoding):
        digest.update(value.encode("ascii"))
        digest.update(b"\0")
    digest.update(payload)
    return digest.hexdigest()


def _begin_idempotent_send(
    world_id: str,
    source_id: str,
    idempotency_key: str,
    fingerprint: str,
) -> tuple[str, dict | None]:
    redis_key = _idempotency_redis_key(world_id, source_id, idempotency_key)
    pending = ""
    raw = None
    for _attempt in range(2):
        token = secrets.token_urlsafe(18)
        pending = json.dumps(
            {"state": "pending", "fingerprint": fingerprint, "token": token},
            separators=(",", ":"), sort_keys=True,
        )
        try:
            created = _ticket_redis.set(
                redis_key, pending.encode("utf-8"),
                ex=ENTITY_MESSAGE_IDEMPOTENCY_PENDING_SECONDS, nx=True,
            )
            raw = None if created else _ticket_redis.get(redis_key)
        except Exception as exc:
            logger.exception("Redis is required for entity message idempotency")
            raise HTTPException(503, detail={"code": "ENTITY_MESSAGE_SERVICE_UNAVAILABLE"}) from exc
        if created:
            return pending, None
        if raw is not None:
            break
    if raw is None:
        raise HTTPException(503, detail={"code": "ENTITY_MESSAGE_SERVICE_UNAVAILABLE"})
    try:
        current = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else str(raw))
    except (TypeError, ValueError) as exc:
        raise HTTPException(503, detail={"code": "ENTITY_MESSAGE_SERVICE_UNAVAILABLE"}) from exc
    if current.get("fingerprint") != fingerprint:
        raise HTTPException(409, detail={"code": "ENTITY_MESSAGE_IDEMPOTENCY_CONFLICT"})
    if current.get("state") == "result" and isinstance(current.get("result"), dict):
        return "", current["result"]
    raise HTTPException(
        409,
        detail={"code": "ENTITY_MESSAGE_SEND_IN_PROGRESS"},
        headers={"Retry-After": "1"},
    )


def _finish_idempotent_send(
    world_id: str,
    source_id: str,
    idempotency_key: str,
    fingerprint: str,
    pending: str,
    result: dict,
) -> None:
    final = json.dumps(
        {"state": "result", "fingerprint": fingerprint, "result": result},
        separators=(",", ":"), sort_keys=True,
    )
    try:
        stored = _ticket_redis.eval(
            _IDEMPOTENCY_FINISH_LUA,
            1,
            _idempotency_redis_key(world_id, source_id, idempotency_key),
            pending,
            final,
            ENTITY_MESSAGE_IDEMPOTENCY_RESULT_SECONDS,
        )
    except Exception as exc:
        logger.exception("Entity message idempotency result could not be stored")
        raise HTTPException(503, detail={"code": "ENTITY_MESSAGE_SERVICE_UNAVAILABLE"}) from exc
    if not stored:
        raise HTTPException(409, detail={"code": "ENTITY_MESSAGE_IDEMPOTENCY_EXPIRED"})


def _release_idempotent_send(world_id: str, source_id: str, idempotency_key: str, pending: str) -> None:
    try:
        _ticket_redis.eval(
            _PRESENCE_DELETE_LUA,
            1,
            _idempotency_redis_key(world_id, source_id, idempotency_key),
            pending,
        )
    except Exception:
        logger.warning("Entity message idempotency reservation could not be released", exc_info=True)


def _normalize_entity_message_payload(payload, encoding: str) -> bytes:
    if encoding == "utf8":
        if isinstance(payload, str):
            body = payload.encode("utf-8")
        elif isinstance(payload, bytes):
            body = payload
            try:
                body.decode("utf-8", errors="strict")
            except UnicodeDecodeError as exc:
                raise HTTPException(400, detail={"code": "ENTITY_MESSAGE_UTF8_INVALID"}) from exc
        else:
            raise HTTPException(400, detail={"code": "ENTITY_MESSAGE_PAYLOAD_INVALID"})
        if len(body) > MAX_PAYLOAD_BYTES:
            raise HTTPException(413, detail={"code": "ENTITY_MESSAGE_TOO_LARGE", "limit_bytes": MAX_PAYLOAD_BYTES})
        return body
    if encoding == "protobuf":
        if isinstance(payload, bytes):
            body = payload
        elif isinstance(payload, list) and all(type(byte) is int and 0 <= byte <= 255 for byte in payload):
            body = bytes(payload)
        else:
            raise HTTPException(400, detail={"code": "ENTITY_MESSAGE_PAYLOAD_INVALID"})
        if len(body) > MAX_PAYLOAD_BYTES:
            raise HTTPException(413, detail={"code": "ENTITY_MESSAGE_TOO_LARGE", "limit_bytes": MAX_PAYLOAD_BYTES})
        return body
    raise HTTPException(415, detail={"code": "ENTITY_MESSAGE_ENCODING_UNSUPPORTED"})


def _target_execution_epoch(world_id: str, target_id: str) -> int | None:
    db = SessionLocal()
    try:
        target = db.get(models.SpaceWorldEntity, (world_id, target_id))
        return int(target.execution_epoch or 0) if _entity_is_running(target) else None
    finally:
        db.close()


def _hosted_source_is_active(world_id: str, source_id: str, execution_epoch: int) -> bool:
    db = SessionLocal()
    try:
        source = db.get(models.SpaceWorldEntity, (world_id, source_id))
        return bool(
            source is not None
            and source.execution_mode == "hosted"
            and int(source.execution_epoch or 0) == int(execution_epoch)
            and _entity_is_running(source)
        )
    finally:
        db.close()


async def _route_entity_message(
    world_id: str,
    source_id: str,
    target_id: str,
    message_type: str,
    encoding: str,
    payload,
    *,
    source_is_active: Callable[[], bool] | None = None,
    inactive_source_is_error: bool = True,
) -> dict:
    _validate_message_type(message_type, encoding)
    body = _normalize_entity_message_payload(payload, encoding)

    try:
        allowed, retry_after_ms = await asyncio.to_thread(_check_entity_rate_limit, world_id, source_id)
    except Exception as exc:
        logger.exception("Redis is required for entity message rate limits")
        raise HTTPException(503, detail={"code": "ENTITY_MESSAGE_SERVICE_UNAVAILABLE"}) from exc
    if not allowed:
        retry_after = max(1, (retry_after_ms + 999) // 1000)
        raise HTTPException(
            429,
            detail={"code": "ENTITY_MESSAGE_RATE_LIMITED", "limit_per_second": ENTITY_MESSAGE_RATE},
            headers={"Retry-After": str(retry_after)},
        )

    message_id = str(uuid.uuid4())
    target_epoch = await asyncio.to_thread(_target_execution_epoch, world_id, target_id)
    if target_epoch is None:
        return {"message_id": message_id, "status": "dropped", "reason": "target_inactive"}
    if source_is_active is not None and not await asyncio.to_thread(source_is_active):
        if inactive_source_is_error:
            raise HTTPException(409, detail={"code": "ENTITY_EXECUTION_NOT_ACTIVE"})
        return {"message_id": message_id, "status": "dropped", "reason": "source_inactive"}
    try:
        routed = await entity_message_hub.route(
            world_id, target_id, target_epoch,
            {
                "type": "entity_message",
                "message_id": message_id,
                "source_id": source_id,
                "target_id": target_id,
                "target_execution_epoch": target_epoch,
                "message_type": message_type,
                "encoding": encoding,
                "payload": body,
            },
        )
    except Exception as exc:
        logger.exception("Entity message routing is unavailable")
        raise HTTPException(503, detail={"code": "ENTITY_MESSAGE_SERVICE_UNAVAILABLE"}) from exc
    return {
        "message_id": message_id,
        "status": "routed" if routed else "dropped",
        **({} if routed else {"reason": "target_inactive"}),
    }


async def send_hosted_entity_message(
    world_id: str,
    source_id: str,
    execution_epoch: int,
    target_id: str,
    message_type: str,
    encoding: str,
    payload,
    idempotency_key: str | None = None,
) -> dict:
    """Route a send command emitted by the trusted hosted AssemblyScript/WASM runtime."""
    if not await asyncio.to_thread(_hosted_source_is_active, world_id, source_id, execution_epoch):
        return {"status": "dropped", "reason": "source_inactive"}
    body = _normalize_entity_message_payload(payload, encoding)
    pending = ""
    fingerprint = ""
    if idempotency_key:
        if not _IDEMPOTENCY_KEY_RE.fullmatch(idempotency_key):
            raise HTTPException(400, detail={"code": "ENTITY_MESSAGE_IDEMPOTENCY_KEY_INVALID"})
        fingerprint = _message_fingerprint(target_id, message_type, encoding, body)
        pending, replay = await asyncio.to_thread(
            _begin_idempotent_send, world_id, source_id, idempotency_key, fingerprint,
        )
        if replay is not None:
            return replay
    try:
        result = await _route_entity_message(
            world_id, source_id, target_id, message_type, encoding, body,
            source_is_active=lambda: _hosted_source_is_active(world_id, source_id, execution_epoch),
            inactive_source_is_error=False,
        )
    except Exception:
        if idempotency_key and pending:
            await asyncio.to_thread(
                _release_idempotent_send, world_id, source_id, idempotency_key, pending,
            )
        raise
    if idempotency_key:
        await asyncio.to_thread(
            _finish_idempotent_send,
            world_id, source_id, idempotency_key, fingerprint, pending, result,
        )
    return result


@router.post("/space/api/v2/worlds/{world_id}/entities/{entity_id}/message-ticket")
@limiter.limit("30/minute; 300/hour", key_func=get_authenticated_or_remote_address)
def create_entity_message_ticket(
    request: Request,
    world_id: uuid.UUID,
    entity_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    world = space_api._require_world_membership(db, str(world_id), current_user)
    execution_instance_id, execution_epoch = _execution_identity_from_request(request)
    entity = _active_browser_source_or_error(
        db, str(world.id), str(entity_id), current_user.id,
        execution_instance_id, execution_epoch,
    )
    websocket_url = settings.SPACE_WS_URL.rstrip("/")
    if websocket_url.endswith("/space/ws/v2"):
        websocket_url = websocket_url[:-len("/space/ws/v2")]
    websocket_url += "/space/ws/v2/entity-messages"
    return JSONResponse(headers={"Cache-Control": "no-store"}, content={
        "ticket": _ticket_for_entity(
            str(world.id), str(entity.id), current_user.id,
            execution_instance_id, execution_epoch,
        ),
        "websocket_url": websocket_url,
        "expires_in_seconds": ENTITY_MESSAGE_TICKET_TTL_SECONDS,
        "protocol": ENTITY_MESSAGE_PROTOCOL,
    })


async def _receive_ws_frame(websocket: WebSocket, timeout: float | None = None) -> bytes:
    receive = websocket.receive()
    message = await asyncio.wait_for(receive, timeout=timeout) if timeout else await receive
    if message["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(message.get("code", 1000))
    data = message.get("bytes")
    if data is None:
        raise ValueError("Entity message WebSocket accepts binary frames only")
    if len(data) > 1024:
        raise ValueError("Entity message control frame is too large")
    return data


def _entity_ticket_still_active(identity: dict) -> bool:
    db = SessionLocal()
    try:
        entity = db.get(
            models.SpaceWorldEntity,
            (str(identity["world_id"]), str(identity["entity_id"])),
        )
        return bool(
            _entity_is_running(entity)
            and entity is not None
            and entity.execution_user_id == str(identity["sub"])
            and str(entity.execution_instance_id or "") == str(identity["execution_instance_id"])
            and int(entity.execution_epoch or 0) == int(identity["execution_epoch"])
        )
    finally:
        db.close()


@router.websocket("/space/ws/v2/entity-messages")
async def entity_message_socket(websocket: WebSocket):
    origin = websocket.headers.get("origin")
    if origin not in _allowed_origins() and (_is_production() or origin is not None):
        await websocket.close(code=4403, reason="Origin is not allowed")
        return
    if ENTITY_MESSAGE_PROTOCOL not in websocket.scope.get("subprotocols", []):
        await websocket.close(code=4406, reason="Unsupported entity message protocol")
        return

    await websocket.accept(subprotocol=ENTITY_MESSAGE_PROTOCOL)
    connection_id = "pending"
    identity = None
    pubsub = None
    receive_task = None
    pubsub_task = None
    try:
        raw_hello = await _receive_ws_frame(websocket, timeout=5)
        try:
            hello = msgpack.unpackb(raw_hello, raw=False, strict_map_key=False)
        except (ValueError, msgpack.UnpackException):
            await websocket.close(code=4400, reason="Invalid entity message hello")
            return
        if not isinstance(hello, dict) or hello.get("type") != "hello" or not isinstance(hello.get("ticket"), str):
            await websocket.close(code=4401, reason="A valid entity message ticket is required")
            return
        identity = await asyncio.to_thread(_authenticate_entity_ticket, hello["ticket"])
        world_id, entity_id = str(identity["world_id"]), str(identity["entity_id"])
        connection_id = f"{int(identity['execution_epoch'])}.{secrets.token_urlsafe(16)}"
        pubsub = entity_message_hub.redis.pubsub()
        await pubsub.subscribe(_message_channel(
            world_id, entity_id, int(identity["execution_epoch"]),
        ))
        if not await entity_message_hub.activate(
            world_id, entity_id, connection_id, int(identity["execution_epoch"]),
        ):
            await websocket.close(code=4409, reason="Entity message connection already active")
            return

        await websocket.send_bytes(msgpack.packb({
            "type": "ready",
            "protocol": ENTITY_MESSAGE_PROTOCOL,
            "entity_id": entity_id,
            "message_rate_per_second": ENTITY_MESSAGE_RATE,
            "max_payload_bytes": MAX_PAYLOAD_BYTES,
        }, use_bin_type=True))

        receive_task = asyncio.create_task(websocket.receive())
        pubsub_task = asyncio.create_task(pubsub.get_message(ignore_subscribe_messages=True, timeout=10))
        last_active_check = time.monotonic()
        ping_window_started_at = time.monotonic()
        ping_count = 0
        while True:
            done, _pending = await asyncio.wait(
                {receive_task, pubsub_task},
                timeout=11,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done:
                raise WebSocketDisconnect(1001)
            if receive_task in done:
                incoming = receive_task.result()
                if incoming["type"] == "websocket.disconnect":
                    raise WebSocketDisconnect(incoming.get("code", 1000))
                raw = incoming.get("bytes")
                if raw is None or len(raw) > 1024:
                    await websocket.close(code=4400, reason="Invalid entity message control frame")
                    return
                try:
                    control = msgpack.unpackb(raw, raw=False, strict_map_key=False)
                except (ValueError, msgpack.UnpackException):
                    await websocket.close(code=4400, reason="Invalid entity message control frame")
                    return
                if not isinstance(control, dict) or control.get("type") != "ping":
                    await websocket.close(code=4400, reason="Unknown entity message control frame")
                    return
                now = time.monotonic()
                if now - ping_window_started_at >= 1:
                    ping_window_started_at = now
                    ping_count = 0
                ping_count += 1
                if ping_count > ENTITY_MESSAGE_RATE:
                    await websocket.close(code=4408, reason="Entity message control rate exceeded")
                    return
                await websocket.send_bytes(msgpack.packb({"type": "pong"}, use_bin_type=True))
                receive_task = asyncio.create_task(websocket.receive())

            if pubsub_task in done:
                item = pubsub_task.result()
                if item and isinstance(item.get("data"), bytes):
                    await websocket.send_bytes(item["data"])
                if time.monotonic() - last_active_check >= ENTITY_MESSAGE_PRESENCE_REFRESH_SECONDS:
                    active = await asyncio.to_thread(_entity_ticket_still_active, identity)
                    if not active:
                        await websocket.close(code=4408, reason="Entity execution is no longer active")
                        return
                    if not await entity_message_hub.refresh(world_id, entity_id, connection_id):
                        await websocket.close(code=4408, reason="Entity message connection expired")
                        return
                    last_active_check = time.monotonic()
                pubsub_task = asyncio.create_task(pubsub.get_message(ignore_subscribe_messages=True, timeout=10))
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except HTTPException as exc:
        with contextlib.suppress(Exception):
            await websocket.close(code=4401, reason=str(exc.detail))
    except Exception:
        logger.exception("Entity message WebSocket failed")
        with contextlib.suppress(Exception):
            await websocket.close(code=1011, reason="Entity message server error")
    finally:
        for task in (receive_task, pubsub_task):
            if task is not None and not task.done():
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
        if pubsub is not None:
            with contextlib.suppress(Exception):
                await pubsub.aclose()
        if identity is not None:
            with contextlib.suppress(Exception):
                await entity_message_hub.deactivate(
                    str(identity["world_id"]), str(identity["entity_id"]), connection_id,
                )
