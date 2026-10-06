"""Public agent instructions and authenticated, self-only position discovery."""
import datetime as dt
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from config import settings
from rate_limit import limiter, get_authenticated_or_remote_address
from routers import space, space_entities as entities
from space import models
from space.database import get_db
from space.worlds import configured_worlds, default_world_spec, find_world_spec, world_identity, world_display_name

router = APIRouter(prefix="/space/api/v2", tags=["space-agent"])
public_router = APIRouter(prefix="/space/agent", tags=["space-agent-docs"])
DOCS_DIR = Path(__file__).resolve().parent.parent / "space" / "agent"
POSITION_STALE_AFTER_SECONDS = 30


@router.get("/agent/authorization")
@limiter.limit(space.SPACE_PUBLIC_STATUS_RATE_LIMIT)
def get_agent_authorization(request: Request, response: Response):
    """Public discovery only; the account service owns consent and credential issuance."""
    response.headers["Cache-Control"] = "no-store"
    base = (settings.SPACE_ACCOUNT_PUBLIC_API_URL or settings.SPACE_ACCOUNT_API_URL).rstrip("/")
    parsed = urlsplit(base)
    if (not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment
        or parsed.path not in ("", "/")
        or not (parsed.scheme == "https" or (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}))):
        raise HTTPException(503, detail={"code": "AGENT_AUTHORIZATION_NOT_CONFIGURED"},
                            headers={"Cache-Control": "no-store"})
    return {
        "authorization_endpoint": f"{base}/space/api/v2/agent-authorizations/requests",
        "token_endpoint": f"{base}/space/api/v2/agent-authorizations/token",
    }


class PlayerPosition(BaseModel):
    x_cm: int
    y_cm: int
    z_cm: int


class PlayerPositionResponse(BaseModel):
    world_id: str
    world_slug: str | None
    world_name: str
    position: PlayerPosition
    yaw_q15: int
    pitch_q15: int
    updated_at: dt.datetime
    age_seconds: float
    stale: bool
    stale_after_seconds: int
    source: str = "checkpoint"


class WorldDescriptor(BaseModel):
    id: str
    slug: str | None
    name: str
    is_default: bool
    aliases: list[str]
    joined: bool
    position_available: bool
    seed: int
    terrain_generator_version: int
    width_cm: int
    height_cm: int
    length_cm: int


class WorldListResponse(BaseModel):
    default_world_id: str
    worlds: list[WorldDescriptor]


def _selected_world_id(db: Session, selector: str | None, creator: entities.EntityCreator) -> str:
    spec = find_world_spec(selector)
    if spec:
        return spec.id
    # Development-only selectors remain unavailable even if old rows exist.
    if find_world_spec(selector, include_unavailable=True):
        raise HTTPException(404, detail={"code": "WORLD_NOT_FOUND"})
    try:
        world_id = str(uuid.UUID(selector or ""))
    except ValueError:
        raise HTTPException(404, detail={"code": "WORLD_NOT_FOUND"}) from None
    membership = db.get(models.SpaceWorldPlayerProfile, (world_id, creator.user.id))
    if membership is None:
        raise HTTPException(404, detail={"code": "WORLD_NOT_FOUND"})
    return world_id


def _world_descriptor(db: Session, world_id: str, creator: entities.EntityCreator):
    spec = find_world_spec(world_id)
    world = db.get(models.SpaceWorld, world_id)
    if world is None and spec is None:
        raise HTTPException(404, detail={"code": "WORLD_NOT_FOUND"})
    membership = db.get(models.SpaceWorldPlayerProfile, (world_id, creator.user.id))
    snapshot = db.get(models.SpacePlayerSnapshot, (world_id, creator.user.id)) if membership else None
    name = world_display_name(world) if world else spec.name
    return {
        "id": world_id, **world_identity(world_id),
        "name": name,
        "aliases": ["default"] if spec and spec.is_default else [],
        "joined": membership is not None,
        "position_available": bool(world and snapshot and snapshot.updated_at
                                   and space._decode_player_snapshot(snapshot, world)),
        "seed": world.seed if world else spec.seed,
        "terrain_generator_version": world.terrain_generator_version if world else spec.terrain_generator_version,
        "width_cm": (world.width_chunks if world else 1024) * space.SPACE_CHUNK_SIZE * 100,
        "height_cm": space.SPACE_WORLD_HEIGHT * 100,
        "length_cm": (world.length_chunks if world else 128) * space.SPACE_CHUNK_SIZE * 100,
    }


@router.get("/worlds", response_model=WorldListResponse)
@limiter.limit(entities.SPACE_ENTITY_RATE_LIMIT, key_func=get_authenticated_or_remote_address)
def list_my_worlds(request: Request, response: Response, db: Session = Depends(get_db),
                   creator: entities.EntityCreator = Depends(entities._entity_creator)):
    """Discover available named worlds and existing custom-world memberships without joining."""
    response.headers["Cache-Control"] = "no-store"
    available = [world.id for world in configured_worlds()]
    configured = {world.id for world in configured_worlds(include_unavailable=True)}
    memberships = db.query(models.SpaceWorldPlayerProfile).filter_by(user_id=creator.user.id).all()
    available.extend(str(row.world_id) for row in memberships if str(row.world_id) not in configured)
    result = {"default_world_id": default_world_spec().id,
              "worlds": [_world_descriptor(db, world_id, creator) for world_id in available]}
    db.commit()
    return result


@router.get("/worlds/{world_selector}", response_model=WorldDescriptor)
@limiter.limit(entities.SPACE_ENTITY_RATE_LIMIT, key_func=get_authenticated_or_remote_address)
def get_world(request: Request, response: Response, world_selector: str,
              db: Session = Depends(get_db), creator: entities.EntityCreator = Depends(entities._entity_creator)):
    response.headers["Cache-Control"] = "no-store"
    world_id = _selected_world_id(db, world_selector, creator)
    result = _world_descriptor(db, world_id, creator)
    db.commit()
    return result


@router.post("/worlds/{world_selector}/join", response_model=WorldDescriptor)
@limiter.limit(space.SPACE_BOOTSTRAP_RATE_LIMIT, key_func=get_authenticated_or_remote_address)
def join_world(request: Request, response: Response, world_selector: str,
               db: Session = Depends(get_db), creator: entities.EntityCreator = Depends(entities._entity_creator)):
    """Idempotently join a named world for an authorized build, without spawning or saving a pose."""
    response.headers["Cache-Control"] = "no-store"
    world_id = _selected_world_id(db, world_selector, creator)
    spec = find_world_spec(world_id)
    world = space._get_or_create_bootstrap_world(db, world_id) if spec else db.get(models.SpaceWorld, world_id)
    space._get_or_create_player_profile(db, world, creator.user)
    result = _world_descriptor(db, world_id, creator)
    db.commit()
    return result


def _own_position(db: Session, world_id: str, creator: entities.EntityCreator):
    # The world and membership checks remain identical to external creation.
    # Never accept a caller-supplied player ID or generate a bootstrap pose.
    world = space._require_world_membership(db, world_id, creator.user)
    snapshot = db.query(models.SpacePlayerSnapshot).filter_by(
        world_id=world.id, user_id=creator.user.id,
    ).first()
    position = space._decode_player_snapshot(snapshot, world)
    if position is None or snapshot.updated_at is None:
        raise HTTPException(404, detail={
            "code": "PLAYER_POSITION_UNAVAILABLE",
            "message": "No saved position is available in this world. Choose placement coordinates in this world.",
            "world_id": str(world.id),
        }, headers={"Cache-Control": "no-store"})
    updated_at = snapshot.updated_at
    if updated_at.tzinfo is None:
        updated_at = updated_at.replace(tzinfo=dt.timezone.utc)
    now = dt.datetime.now(dt.timezone.utc)
    delta = (now - updated_at).total_seconds()
    # Future-dated checkpoints are not trustworthy evidence of a fresh pose.
    stale = delta < -5 or delta > POSITION_STALE_AFTER_SECONDS
    result = {
        "world_id": str(world.id),
        "world_slug": world_identity(str(world.id))["slug"], "world_name": world_display_name(world),
        "position": {axis: position[axis] for axis in ("x_cm", "y_cm", "z_cm")},
        "yaw_q15": position["yaw_q15"], "pitch_q15": position["pitch_q15"],
        "updated_at": updated_at, "age_seconds": round(max(0, delta), 3),
        "stale": stale, "stale_after_seconds": POSITION_STALE_AFTER_SECONDS,
        "source": "checkpoint",
    }
    # Persist API-key last_used_at and release the shared world lock promptly.
    db.commit()
    return result


@router.get("/players/me/position", response_model=PlayerPositionResponse)
@limiter.limit(entities.SPACE_ENTITY_RATE_LIMIT, key_func=get_authenticated_or_remote_address)
def get_my_position(request: Request, response: Response,
        requested_world: str | None = Query(None, alias="world", max_length=128),
        db: Session = Depends(get_db),
        creator: entities.EntityCreator = Depends(entities._entity_creator)):
    """Read the credential owner's saved position in the selected world (Nature by default).

    Accepts a player login token or an existing Space API key with
    space:entity:create. Does not join a world or invent an initial position.
    """
    response.headers["Cache-Control"] = "no-store"
    return _own_position(db, _selected_world_id(db, requested_world, creator), creator)


@router.get("/worlds/{world_id}/players/me/position", response_model=PlayerPositionResponse)
@limiter.limit(entities.SPACE_ENTITY_RATE_LIMIT, key_func=get_authenticated_or_remote_address)
def get_my_world_position(request: Request, response: Response, world_id: str,
        db: Session = Depends(get_db),
        creator: entities.EntityCreator = Depends(entities._entity_creator)):
    """Read only the credential owner's saved position in a world they have joined."""
    response.headers["Cache-Control"] = "no-store"
    return _own_position(db, _selected_world_id(db, world_id, creator), creator)


PUBLIC_FILES = {
    "SKILL.md": ("SKILL.md", "text/markdown"),
    "spaceAPI.md": ("spaceAPI.md", "text/markdown"),
    "entityAPI.md": ("entityAPI.md", "text/markdown"),
    "entityMessaging.md": ("entityMessaging.md", "text/markdown"),
    "worlds.md": ("worlds.md", "text/markdown"),
    "references/inventory.proto": ("references/inventory.proto", "text/plain"),
    "references/space_api.proto": ("references/space_api.proto", "text/plain"),
    "references/entity-create.md": ("references/entity-create.md", "text/markdown"),
}


@public_router.get("/{document:path}", response_class=FileResponse)
@limiter.limit(space.SPACE_PUBLIC_STATUS_RATE_LIMIT)
def get_agent_document(request: Request, document: str):
    """Serve a fixed public documentation allowlist without account authentication."""
    if document == "references/script-api-v2.md":
        return RedirectResponse("/space/agent/entityAPI.md", status_code=308)
    entry = PUBLIC_FILES.get(document)
    if entry is None:
        raise HTTPException(404, detail={"code": "AGENT_DOCUMENT_NOT_FOUND"})
    relative, media_type = entry
    return FileResponse(DOCS_DIR / relative, media_type=media_type, headers={
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
    })
