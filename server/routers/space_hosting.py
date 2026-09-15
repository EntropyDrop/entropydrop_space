"""Explicit, budgeted entity hosting; ordinary run-state requests never buy time."""
import datetime as dt
import hashlib
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import StrictBool, StrictInt
from sqlalchemy.orm import Session

from space import models
from config import settings
from space.database import get_db
from rate_limit import limiter
from routers.space import _require_world_membership
from routers.space_entities import (
    EntityCreator, StrictEntityModel, _entity_creator,
    _reset_entity_runtime_snapshot, _lock_entity_quota_scope,
    _require_execution_holder,
)
from space.inventory_codec import decode_inventory_resource
from space.hosting_cores import MAX_HOSTING_CORES, CORE_LEASE_SECONDS, reserve_core, capacity, clear_core

def require_hosting_enabled():
    if not settings.SPACE_HOSTING_ENABLED:
        raise HTTPException(503, detail={"code": "HOSTING_DISABLED", "message": "Entity hosting is not available."})


router = APIRouter(prefix="/space/api/v2/worlds/{world_id}/entities", tags=["space-hosting"])
HOUR_MS = 3_600_000
MAX_HOSTED_PER_WORLD = MAX_HOSTING_CORES
MAX_HOSTED_BLOCKS = 512
MAX_HOSTED_COMPONENTS = 8
HOSTING_RADIUS_CHUNKS = 2


def utc(value):
    return value.replace(tzinfo=dt.timezone.utc) if value and value.tzinfo is None else value


def status(entity, *, now=None, user_id=None, worker_available=True):
    now = now or dt.datetime.now(dt.timezone.utc)
    recent = entity.hosting_last_tick_at and (now - utc(entity.hosting_last_tick_at)).total_seconds() < 15
    return {
        "entity_id": str(entity.id), "world_id": str(entity.world_id),
        "name": entity.name,
        "position": {"x_cm": entity.position_x_cm, "y_cm": entity.position_y_cm, "z_cm": entity.position_z_cm},
        # Outside the hosting anchor's +/-32m activity bounds, avoiding arrival
        # inside a moving collider. Client wraps X/Z and preloads edited terrain.
        "teleport_position": {"x_cm": (entity.hosting_anchor or [entity.position_x_cm])[0] + 3500,
                              "y_cm": max(200, min(25400, entity.position_y_cm + 200)), "z_cm": entity.position_z_cm},
        "can_manage": user_id == entity.execution_user_id,
        "core_id": entity.hosting_core_id if entity.hosting_enabled else None,
        "revision": entity.revision, "execution_epoch": entity.execution_epoch,
        "execution_mode": entity.execution_mode,
        "enabled": entity.hosting_enabled,
        "state": ("unavailable" if not worker_available else "running" if recent else "starting") if entity.hosting_enabled else "paused",
        "reason": entity.hosting_reason,
        "error": entity.hosting_error,
        "credits_per_hour": 1,
        "remaining_ms": entity.hosting_remaining_ms,
        "budget_remaining_credits": entity.hosting_budget_remaining,
        "billed_hours": entity.hosting_billed_hours,
        "last_tick_at": utc(entity.hosting_last_tick_at).isoformat() if entity.hosting_last_tick_at else None,
        "activity_radius_chunks": HOSTING_RADIUS_CHUNKS,
    }


def validate_hosted_definition(definition):
    _, portable = decode_inventory_resource(bytes(definition))
    nodes, blocks = 0, 0
    def visit(node):
        nonlocal nodes, blocks
        nodes += 1
        blocks += len(node.get("blocks", []))
        for field in ("pivot", "localPosition"):
            if any(abs(v) > 16 for v in node.get(field, [])):
                raise HTTPException(422, detail={"code": "HOSTING_ENTITY_BOUNDS_LIMIT"})
        if any(abs(block.get(axis, 0)) > 16 for block in node.get("blocks", []) for axis in ("dx", "dy", "dz")):
            raise HTTPException(422, detail={"code": "HOSTING_ENTITY_BOUNDS_LIMIT"})
        for child in node.get("children", []):
            visit(child)
    visit(portable["root"])
    if nodes > MAX_HOSTED_COMPONENTS or blocks > MAX_HOSTED_BLOCKS:
        raise HTTPException(422, detail={"code": "HOSTING_ENTITY_TOO_COMPLEX",
                                        "max_components": MAX_HOSTED_COMPONENTS,
                                        "max_blocks": MAX_HOSTED_BLOCKS})


class HostingRequest(StrictEntityModel):
    operation_id: uuid.UUID
    enabled: StrictBool
    release_to_browser: StrictBool = False
    # Maximum NEW credits this operation authorizes. Existing prepaid time survives pause.
    max_credits: StrictInt = 1
    expected_execution_epoch: StrictInt | None = None


def authorized_entity(db, world_id, entity_id, creator):
    world = _require_world_membership(db, world_id, creator.user)
    _lock_entity_quota_scope(db, world, creator.user)
    entity = db.query(models.SpaceWorldEntity).filter_by(world_id=world_id, id=entity_id).with_for_update().first()
    if entity is None:
        raise HTTPException(404, detail={"code": "WORLD_ENTITY_NOT_FOUND"})
    return world, entity


@router.get('/hosting/list')
@limiter.limit('60/minute')
def list_hosting(request: Request, world_id: uuid.UUID, db: Session = Depends(get_db),
                 creator: EntityCreator = Depends(_entity_creator)):
    world = _require_world_membership(db, str(world_id), creator.user)
    now = dt.datetime.now(dt.timezone.utc)
    worker = db.get(models.SpaceHostingWorker, str(world.id))
    available = bool(settings.SPACE_HOSTING_ENABLED and worker and utc(worker.lease_expires_at) > now and worker.core_cpu_ids)
    entities = db.query(models.SpaceWorldEntity).filter_by(world_id=world.id,
        execution_user_id=creator.user.id, execution_mode='hosted').order_by(
        models.SpaceWorldEntity.hosting_enabled.desc(), models.SpaceWorldEntity.updated_at.desc()).limit(256).all()
    result = {'enabled': settings.SPACE_HOSTING_ENABLED, 'worker_available': available,
              'capacity': capacity(db, worker if available else None, now=now),
              'items': [status(entity, now=now, user_id=creator.user.id, worker_available=available) for entity in entities]}
    db.commit()
    return result


@router.put("/{entity_id}/hosting")
@limiter.limit("60/minute")
def set_hosting(request: Request, world_id: uuid.UUID, entity_id: uuid.UUID, payload: HostingRequest,
                db: Session = Depends(get_db), creator: EntityCreator = Depends(_entity_creator)):
    world_id, entity_id = str(world_id), str(entity_id)
    world, entity = authorized_entity(db, world_id, entity_id, creator)
    if payload.enabled:
        require_hosting_enabled()
    if not 0 <= payload.max_credits <= 168:
        raise HTTPException(422, detail={"code": "HOSTING_BUDGET_INVALID", "max_credits": 168})
    if payload.expected_execution_epoch is not None and payload.expected_execution_epoch < 0:
        raise HTTPException(422, detail={"code": "HOSTING_EPOCH_INVALID"})
    if payload.enabled and payload.release_to_browser:
        raise HTTPException(422, detail={"code": "HOSTING_RELEASE_REQUIRES_PAUSE"})
    # Preserve replay compatibility with receipts created before epoch fencing
    # was added; default/null is not part of those older request digests.
    digest_payload = payload.model_dump(mode="json", exclude={'expected_execution_epoch'}
        if payload.expected_execution_epoch is None else set())
    digest = hashlib.sha256(json.dumps({**digest_payload, "entity_id": entity_id,
                                       "owner": creator.user.id}, sort_keys=True).encode()).digest()
    previous = db.get(models.SpaceHostingOperation, (world_id, str(payload.operation_id)))
    if previous:
        if bytes(previous.request_digest) != digest:
            raise HTTPException(409, detail={"code": "ENTITY_OPERATION_ID_REUSED"})
        return previous.result
    if payload.expected_execution_epoch is not None and payload.expected_execution_epoch != entity.execution_epoch:
        raise HTTPException(409, detail={'code': 'HOSTING_STATE_CHANGED',
            'message': 'Entity execution changed. Refresh and try again.'})
    # Hosting cannot take over another browser endpoint's live calculation.
    # Stop/release that endpoint before changing execution mode.
    _require_execution_holder(entity, None, None, creator.user.id)
    if entity.hosting_enabled and entity.execution_user_id != creator.user.id:
        raise HTTPException(409, detail={"code": "ENTITY_OCCUPIED",
            "message": "This entity is occupied by another account's hosting execution."})
    now = dt.datetime.now(dt.timezone.utc)
    if payload.enabled:
        if world.status != 1:
            raise HTTPException(409, detail={"code": "HOSTING_WORLD_INACTIVE"})
        worker = db.get(models.SpaceHostingWorker, world_id)
        if not worker or utc(worker.lease_expires_at) <= now:
            raise HTTPException(503, detail={"code": "HOSTING_WORKER_UNAVAILABLE"})
        validate_hosted_definition(entity.definition)
        if not entity.hosting_remaining_ms and (payload.max_credits == 0 or creator.user.credits < 1):
            raise HTTPException(402, detail={"code": "HOSTING_CREDITS_REQUIRED"})
        core = reserve_core(db, entity, worker, now=now)
        entity.hosting_core_id = core.id
        entity.execution_mode = "hosted"
        entity.execution_user_id = creator.user.id
        entity.hosting_anchor = entity.hosting_anchor or [entity.position_x_cm, entity.position_z_cm]
        entity.hosting_reason = None
        entity.hosting_error = None
        entity.hosting_last_tick_at = None
        entity.hosting_budget_remaining = payload.max_credits
    else:
        entity.hosting_reason = "user_paused"
        entity.hosting_budget_remaining = 0
        # Do not reuse a running CPU until the worker has killed/waited for its
        # process. Pending (never-started) reservations can be released now.
        core = db.query(models.SpaceHostingCore).filter_by(id=entity.hosting_core_id).with_for_update().first() if entity.hosting_core_id is not None else None
        if (core and str(core.world_id) == world_id and str(core.entity_id) == entity_id
                and core.execution_epoch == entity.execution_epoch and core.executor_instance_id is None):
            clear_core(core)
        entity.hosting_core_id = None
        if payload.release_to_browser:
            entity.execution_mode = "browser"
            entity.execution_user_id = None
            entity.hosting_anchor = None
    from space.billing import authorize
    authorize(db, creator, entity, payload)
    entity.hosting_enabled = payload.enabled
    entity.desired_run_state = "running" if payload.enabled else "stopped"
    entity.execution_instance_id = None
    entity.execution_lease_expires_at = None
    entity.execution_epoch += 1
    if payload.enabled:
        core.execution_epoch = entity.execution_epoch
        core.lease_expires_at = now + dt.timedelta(seconds=CORE_LEASE_SECONDS)
    else:
        _kind, canonical = decode_inventory_resource(bytes(entity.definition))
        # Hosting Stop, like browser Stop, restores defaults at the last
        # committed root pose and invalidates in-flight results.
        holder = entity.execution_user_id
        _reset_entity_runtime_snapshot(entity, world, canonical)
        if not payload.release_to_browser:
            entity.execution_user_id = holder
    entity.revision += 1
    entity.updated_at = now
    result = status(entity, now=now, user_id=creator.user.id)
    db.add(models.SpaceHostingOperation(world_id=world_id, operation_id=str(payload.operation_id),
                                        request_digest=digest, result=result))
    db.commit()
    return result


@router.get("/{entity_id}/hosting")
@limiter.limit("120/minute")
def get_hosting(request: Request, world_id: uuid.UUID, entity_id: uuid.UUID,
                db: Session = Depends(get_db), creator: EntityCreator = Depends(_entity_creator)):
    _, entity = authorized_entity(db, str(world_id), str(entity_id), creator)
    worker = db.get(models.SpaceHostingWorker, str(world_id))
    available = bool(settings.SPACE_HOSTING_ENABLED and worker and utc(worker.lease_expires_at) > dt.datetime.now(dt.timezone.utc) and worker.core_cpu_ids)
    result = status(entity, user_id=creator.user.id, worker_available=available)
    snapshot = json.loads(entity.snapshot) if entity.snapshot else {}
    result["position"] = {"x_cm": entity.position_x_cm, "y_cm": entity.position_y_cm, "z_cm": entity.position_z_cm}
    result["logs"] = snapshot.get("scriptLogs", [])[-100:]
    result["script_error"] = snapshot.get("scriptError")
    result["tick_count"] = snapshot.get("tickCount", 0)
    db.commit()  # persist API key last-used metadata
    return result
