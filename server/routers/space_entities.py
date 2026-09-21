import datetime
import base64
import binascii
from dataclasses import dataclass
import hashlib
import json
import math
import re
import secrets
import uuid
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, Security
from fastapi.exceptions import RequestValidationError
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from google.protobuf.message import DecodeError
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt, StrictStr, ValidationError, model_validator
from sqlalchemy import and_, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, object_session

from space import auth
from space import models
from config import settings
from space.contracts import space_api_pb2
from space.database import get_db
from rate_limit import limiter
from routers.space import (
    MAX_PLAYER_Y_CM,
    MIN_PLAYER_Y_CM,
    SPACE_CHUNK_SIZE,
    SPACE_WORLD_HEIGHT,
    _require_world_membership,
)
from routers.space_market import (
    SPACE_MARKET_GRID_DIVISIONS,
    SPACE_MARKET_MAX_BLOCKS,
    SPACE_MARKET_MAX_COORDINATE,
    entity_stopped_y_bounds,
    validate_inventory_resource_payload,
)
from space.inventory_codec import (
    SCHEMA_VERSION as INVENTORY_SCHEMA_VERSION,
    InventoryCodecError,
    decode_inventory_resource,
    encode_inventory_resource,
    inventory_resource_name,
)
from space_quota import QuotaWindow, UTC_DAY_SECONDS, reserve as reserve_quota


router = APIRouter(prefix="/space/api/v2/worlds/{world_id}/entities", tags=["space-entities"])
from space.integrations.account_contract import SPACE_API_KEY_SCOPES
entity_security = HTTPBearer(auto_error=False)

SPACE_ENTITY_RATE_LIMIT = "120/minute; 2000/hour"
SPACE_ENTITY_CREATE_RATE_LIMIT = "30/minute; 300/hour"
SPACE_ENTITY_MAX_PER_OWNER = 256
SPACE_ENTITY_MAX_DEFINITION_BYTES = 8 * 1024 * 1024
SPACE_ENTITY_MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
SPACE_ENTITY_MAX_DEFINITION_BASE64_CHARS = ((SPACE_ENTITY_MAX_DEFINITION_BYTES + 2) // 3) * 4
SPACE_ENTITY_MAX_AOI_RADIUS_CM = 64 * SPACE_CHUNK_SIZE * 100
SPACE_ENTITY_MAX_AOI_RESULTS = 256
SPACE_ENTITY_MAX_AOI_CANDIDATES = 4096
SPACE_API_KEY_MAX_PER_USER = 20
SPACE_API_KEY_PREFIX = "edapi_"
SPACE_ENTITY_EXECUTION_LEASE_SECONDS = 8
SPACE_ENTITY_SNAPSHOT_MAX_DEPTH = 20
SPACE_ENTITY_SNAPSHOT_MAX_VALUES = 100_000
SPACE_ENTITY_SNAPSHOT_MAX_CONTAINER_ITEMS = 8_192
SPACE_ENTITY_SNAPSHOT_MAX_STRING_CHARS = 65_536
SPACE_ENTITY_SNAPSHOT_FORBIDDEN_KEYS = {"__proto__"}
SPACE_ENTITY_MAX_TOTAL_BYTES_PER_OWNER = settings.SPACE_ENTITY_MAX_TOTAL_BYTES_PER_OWNER
SPACE_ENTITY_MAX_RUNNING_PER_OWNER = settings.SPACE_ENTITY_MAX_RUNNING_PER_OWNER
SPACE_ENTITY_MAX_RUNNING_PER_WORLD = settings.SPACE_ENTITY_MAX_RUNNING_PER_WORLD
SPACE_ENTITY_MAX_RUNNING_PER_CHUNK = settings.SPACE_ENTITY_MAX_RUNNING_PER_CHUNK
SPACE_ENTITY_CHECKPOINT_MINUTE_BYTES = settings.SPACE_ENTITY_CHECKPOINT_MINUTE_BYTES
SPACE_ENTITY_CHECKPOINT_DAILY_BYTES = settings.SPACE_ENTITY_CHECKPOINT_DAILY_BYTES


class StrictEntityModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EntityPosition(StrictEntityModel):
    x_cm: StrictInt
    y_cm: StrictInt = Field(ge=MIN_PLAYER_Y_CM, le=MAX_PLAYER_Y_CM)
    z_cm: StrictInt


class CreateWorldEntityRequest(StrictEntityModel):
    operation_id: uuid.UUID
    definition_base64: StrictStr = Field(
        min_length=1,
        max_length=SPACE_ENTITY_MAX_DEFINITION_BASE64_CHARS,
    )
    position: EntityPosition
    yaw_quarter_turns: StrictInt = Field(default=0, ge=0, le=3)
    desired_run_state: Literal["running", "stopped"] = "stopped"


class CreateBrowserWorldEntityRequest(StrictEntityModel):
    operation_id: uuid.UUID
    definition_base64: StrictStr = Field(
        min_length=1,
        max_length=SPACE_ENTITY_MAX_DEFINITION_BASE64_CHARS,
    )
    snapshot: dict[str, Any]
    position: EntityPosition
    desired_run_state: Literal["running", "stopped"] = "stopped"


class CheckpointBrowserWorldEntityRequest(StrictEntityModel):
    operation_id: uuid.UUID
    expected_revision: StrictInt = Field(ge=1)
    definition_base64: StrictStr | None = Field(
        default=None,
        min_length=1,
        max_length=SPACE_ENTITY_MAX_DEFINITION_BASE64_CHARS,
    )
    snapshot: dict[str, Any]
    position: EntityPosition
    desired_run_state: Literal["running", "stopped"]
    execution_instance_id: uuid.UUID | None = None
    execution_epoch: StrictInt | None = Field(default=None, ge=1)


class StopEntityPose(StrictEntityModel):
    position: list[StrictFloat | StrictInt] = Field(min_length=3, max_length=3)
    quaternion: list[StrictFloat | StrictInt] = Field(min_length=4, max_length=4)

    @model_validator(mode="after")
    def finite_pose(self):
        if (any(not math.isfinite(v) or abs(v) > 1e7 for v in self.position)
                or not MIN_PLAYER_Y_CM <= self.position[1]*100 <= MAX_PLAYER_Y_CM
                or any(not math.isfinite(v) or abs(v) > 1 for v in self.quaternion)
                or abs(sum(v*v for v in self.quaternion) - 1) > 0.01):
            raise ValueError("Invalid final entity pose")
        return self


class SetWorldEntityRunStateRequest(StrictEntityModel):
    operation_id: uuid.UUID
    desired_run_state: Literal["running", "stopped"]
    expected_revision: StrictInt | None = Field(default=None, ge=1)
    execution_instance_id: uuid.UUID | None = None
    execution_epoch: StrictInt | None = Field(default=None, ge=1)
    stop_pose: StopEntityPose | None = None


PROTOBUF_CONTENT_TYPE = "application/x-protobuf"


def parse_json_model(model_type, raw: bytes):
    """Validate a JSON request body and surface FastAPI-style 422 errors.

    Reading the body inside a dependency means Pydantic errors no longer pass
    through FastAPI's request parser, so re-raise them as validation errors.
    """
    try:
        return model_type.model_validate_json(raw)
    except ValidationError as error:
        raise RequestValidationError(error.errors()) from error


def validate_request_model(model_type, value):
    """Validate a manually decoded request with the same 422 semantics as JSON."""
    try:
        return model_type.model_validate(value)
    except ValidationError as error:
        raise RequestValidationError(error.errors()) from error


async def _protobuf_request_body(request: Request) -> bytes | None:
    """Return the raw body only for the binary resource content type.

    JSON requests keep working unchanged; `application/x-protobuf` bodies decode
    an `entropydrop.space.api.v2` envelope whose `definition` field is the raw
    canonical InventoryResource, so the resource no longer travels as a base64
    JSON string.
    """
    content_type = (request.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    if content_type != PROTOBUF_CONTENT_TYPE:
        return None
    return await request.body()


def _parse_protobuf_envelope(message_type, raw: bytes):
    envelope = message_type()
    try:
        envelope.ParseFromString(raw)
    except DecodeError as error:
        raise HTTPException(422, detail={"code": "ENTITY_PROTOBUF_INVALID"}) from error
    return envelope


def _envelope_operation_id(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError) as error:
        raise HTTPException(422, detail={"code": "ENTITY_OPERATION_ID_INVALID"}) from error


def _envelope_position(envelope) -> EntityPosition:
    if not envelope.HasField("position"):
        raise HTTPException(422, detail={"code": "ENTITY_POSITION_REQUIRED"})
    return validate_request_model(EntityPosition, {
        "x_cm": envelope.position.x_cm,
        "y_cm": envelope.position.y_cm,
        "z_cm": envelope.position.z_cm,
    })


def _envelope_run_state(value: int) -> Literal["running", "stopped"]:
    if value == space_api_pb2.ENTITY_RUN_STATE_RUNNING:
        return "running"
    if value == space_api_pb2.ENTITY_RUN_STATE_STOPPED:
        return "stopped"
    raise HTTPException(422, detail={"code": "ENTITY_RUN_STATE_INVALID"})


def _envelope_snapshot(raw: bytes) -> dict[str, Any]:
    if not raw:
        raise HTTPException(422, detail={"code": "ENTITY_SNAPSHOT_REQUIRED"})
    try:
        snapshot = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HTTPException(422, detail={"code": "ENTITY_SNAPSHOT_INVALID"}) from error
    if not isinstance(snapshot, dict):
        raise HTTPException(422, detail={"code": "ENTITY_SNAPSHOT_INVALID"})
    return snapshot


def _envelope_definition_base64(raw: bytes) -> str:
    if not raw:
        raise HTTPException(422, detail={"code": "ENTITY_DEFINITION_REQUIRED"})
    if len(raw) > SPACE_ENTITY_MAX_DEFINITION_BYTES:
        raise HTTPException(413, detail={"code": "ENTITY_DEFINITION_TOO_LARGE"})
    return base64.b64encode(raw).decode("ascii")


async def create_world_entity_request(request: Request) -> CreateWorldEntityRequest:
    raw = await _protobuf_request_body(request)
    if raw is None:
        return parse_json_model(CreateWorldEntityRequest, await request.body())
    envelope = _parse_protobuf_envelope(space_api_pb2.CreateEntityRequest, raw)
    return validate_request_model(CreateWorldEntityRequest, {
        "operation_id": _envelope_operation_id(envelope.operation_id),
        "definition_base64": _envelope_definition_base64(envelope.definition),
        "position": _envelope_position(envelope),
        "yaw_quarter_turns": envelope.yaw_quarter_turns,
        "desired_run_state": _envelope_run_state(envelope.desired_run_state),
    })


async def create_browser_world_entity_request(request: Request) -> CreateBrowserWorldEntityRequest:
    raw = await _protobuf_request_body(request)
    if raw is None:
        return parse_json_model(CreateBrowserWorldEntityRequest, await request.body())
    envelope = _parse_protobuf_envelope(space_api_pb2.CreateEntityRequest, raw)
    return validate_request_model(CreateBrowserWorldEntityRequest, {
        "operation_id": _envelope_operation_id(envelope.operation_id),
        "definition_base64": _envelope_definition_base64(envelope.definition),
        "snapshot": _envelope_snapshot(envelope.snapshot_json),
        "position": _envelope_position(envelope),
        "desired_run_state": _envelope_run_state(envelope.desired_run_state),
    })


async def checkpoint_browser_world_entity_request(request: Request) -> CheckpointBrowserWorldEntityRequest:
    raw = await _protobuf_request_body(request)
    if raw is None:
        return parse_json_model(CheckpointBrowserWorldEntityRequest, await request.body())
    envelope = _parse_protobuf_envelope(space_api_pb2.CheckpointEntityRequest, raw)
    return validate_request_model(CheckpointBrowserWorldEntityRequest, {
        "operation_id": _envelope_operation_id(envelope.operation_id),
        "expected_revision": envelope.expected_revision,
        "execution_instance_id": envelope.execution_instance_id or None,
        "execution_epoch": envelope.execution_epoch or None,
        "definition_base64": (
            _envelope_definition_base64(envelope.definition) if envelope.definition else None
        ),
        "snapshot": _envelope_snapshot(envelope.snapshot_json),
        "position": _envelope_position(envelope),
        "desired_run_state": _envelope_run_state(envelope.desired_run_state),
    })




class ComponentDefaultsPatch(StrictEntityModel):
    type: Literal["dynamic", "kinematic"] | None = None
    mass: StrictFloat | None = Field(default=None, ge=0.1, le=1e12)
    restitution: StrictFloat | None = Field(default=None, ge=0, le=1)
    friction: StrictFloat | None = Field(default=None, ge=0, le=1)
    useGravity: StrictBool | None = None
    collisionEnabled: StrictBool | None = None

    @model_validator(mode="after")
    def nonempty_nonnull(self):
        if not self.model_fields_set or any(getattr(self, key) is None for key in self.model_fields_set):
            raise ValueError("Supply at least one non-null default property")
        return self


class EntityVoxelAddress(StrictEntityModel):
    dx: StrictInt = Field(ge=-SPACE_MARKET_MAX_COORDINATE, le=SPACE_MARKET_MAX_COORDINATE)
    dy: StrictInt = Field(ge=-SPACE_MARKET_MAX_COORDINATE, le=SPACE_MARKET_MAX_COORDINATE)
    dz: StrictInt = Field(ge=-SPACE_MARKET_MAX_COORDINATE, le=SPACE_MARKET_MAX_COORDINATE)
    is_micro: StrictBool
    micro_x: StrictInt | None = Field(default=None, ge=0, lt=SPACE_MARKET_GRID_DIVISIONS)
    micro_y: StrictInt | None = Field(default=None, ge=0, lt=SPACE_MARKET_GRID_DIVISIONS)
    micro_z: StrictInt | None = Field(default=None, ge=0, lt=SPACE_MARKET_GRID_DIVISIONS)

    @model_validator(mode="after")
    def validate_scale(self):
        offsets = (self.micro_x, self.micro_y, self.micro_z)
        if self.is_micro and any(value is None for value in offsets):
            raise ValueError("micro_x, micro_y and micro_z are required for a micro voxel")
        if not self.is_micro and any(value is not None for value in offsets):
            raise ValueError("micro offsets are not allowed for a standard voxel")
        return self


class EntityVoxelUpsert(EntityVoxelAddress):
    op: Literal["upsert"]
    color_rgb: StrictInt = Field(ge=0, le=0xFFFFFF)
    material_id: StrictInt | None = Field(default=None, ge=0, le=1)


class EntityVoxelRemove(EntityVoxelAddress):
    op: Literal["remove"]


EntityVoxelOperation = Annotated[
    EntityVoxelUpsert | EntityVoxelRemove,
    Field(discriminator="op"),
]


class EntityScriptPatch(StrictEntityModel):
    format: Literal["unified"]
    base_sha256: StrictStr = Field(pattern=r"^[0-9a-f]{64}$")
    patch: StrictStr = Field(min_length=1, max_length=256 * 1024)

    @model_validator(mode="after")
    def validate_encoded_size(self):
        if len(self.patch.encode("utf-8")) > 256 * 1024:
            raise ValueError("script patch exceeds 256 KiB")
        return self


VoxelCoordinateKey = tuple[int, int, int, int | None, int | None, int | None]


def _voxel_operation_key(operation: EntityVoxelOperation) -> VoxelCoordinateKey:
    return (
        operation.dx,
        operation.dy,
        operation.dz,
        operation.micro_x if operation.is_micro else None,
        operation.micro_y if operation.is_micro else None,
        operation.micro_z if operation.is_micro else None,
    )


class EntityComponentPatch(StrictEntityModel):
    id: StrictStr = Field(min_length=1, max_length=64)
    name: StrictStr | None = Field(default=None, max_length=80)
    script: StrictStr | None = Field(default=None, max_length=65536)
    script_patch: EntityScriptPatch | None = None
    body: ComponentDefaultsPatch | None = None
    voxel_ops: list[EntityVoxelOperation] | None = Field(
        default=None,
        min_length=1,
        max_length=SPACE_MARKET_MAX_BLOCKS,
    )

    @model_validator(mode="after")
    def nonempty_nonnull(self):
        if self.model_fields_set == {"id"} or any(getattr(self, key) is None for key in self.model_fields_set):
            raise ValueError("Supply name, script, script_patch, body or voxel_ops; use an empty string to clear code")
        if "script" in self.model_fields_set and "script_patch" in self.model_fields_set:
            raise ValueError("Supply either script or script_patch, not both")
        if self.voxel_ops is not None:
            keys = [_voxel_operation_key(operation) for operation in self.voxel_ops]
            if len(set(keys)) != len(keys):
                raise ValueError("Each voxel coordinate may appear only once per component patch")
        return self


class UpdateEntityConfigurationRequest(StrictEntityModel):
    operation_id: uuid.UUID
    expected_revision: StrictInt = Field(ge=1)
    components: list[EntityComponentPatch] = Field(min_length=1, max_length=64)

    @model_validator(mode="after")
    def unique_components(self):
        if len({item.id for item in self.components}) != len(self.components):
            raise ValueError("Each component may appear only once")
        operation_count = sum(len(item.voxel_ops or ()) for item in self.components)
        if operation_count > SPACE_MARKET_MAX_BLOCKS:
            raise ValueError(f"An entity patch may contain at most {SPACE_MARKET_MAX_BLOCKS} voxel operations")
        return self


_UNIFIED_HUNK_HEADER = re.compile(
    r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$"
)
_NO_NEWLINE_MARKER = r"\ No newline at end of file"


def _without_line_ending(value: str) -> str:
    if value.endswith("\r\n"):
        return value[:-2]
    if value.endswith("\n") or value.endswith("\r"):
        return value[:-1]
    return value


def _remove_one_line_ending(value: str) -> str:
    stripped = _without_line_ending(value)
    if stripped == value:
        raise ValueError("no-newline marker follows a line that already has no line ending")
    return stripped


def _apply_unified_script_patch(source: str, patch: str) -> str:
    """Apply a strict, file-independent unified diff to one component script."""
    source_lines = source.splitlines(keepends=True)
    patch_lines = patch.splitlines(keepends=True)
    cursor = 0
    if patch_lines and _without_line_ending(patch_lines[0]).startswith("--- "):
        if len(patch_lines) < 2 or not _without_line_ending(patch_lines[1]).startswith("+++ "):
            raise ValueError("a --- file header must be followed by a +++ file header")
        cursor = 2

    result: list[str] = []
    source_cursor = 0
    hunk_count = 0
    while cursor < len(patch_lines):
        header = _without_line_ending(patch_lines[cursor])
        match = _UNIFIED_HUNK_HEADER.fullmatch(header)
        if match is None:
            raise ValueError("expected a unified diff hunk header")
        old_start = int(match.group(1))
        old_count = int(match.group(2)) if match.group(2) is not None else 1
        new_start = int(match.group(3))
        new_count = int(match.group(4)) if match.group(4) is not None else 1
        if (old_count and old_start < 1) or (new_count and new_start < 1):
            raise ValueError("non-empty unified diff ranges must start at line 1 or later")
        old_index = old_start if old_count == 0 else old_start - 1
        new_index = new_start if new_count == 0 else new_start - 1
        if old_index < source_cursor or old_index > len(source_lines):
            raise ValueError("unified diff hunks overlap or address lines outside the script")
        result.extend(source_lines[source_cursor:old_index])
        source_cursor = old_index
        if new_index != len(result):
            raise ValueError("unified diff new-file line numbers are inconsistent")

        cursor += 1
        entries: list[tuple[str, str]] = []
        while cursor < len(patch_lines):
            raw = patch_lines[cursor]
            text = _without_line_ending(raw)
            if _UNIFIED_HUNK_HEADER.fullmatch(text):
                break
            if text == _NO_NEWLINE_MARKER:
                if not entries:
                    raise ValueError("no-newline marker must follow a hunk line")
                prefix, content = entries[-1]
                entries[-1] = (prefix, _remove_one_line_ending(content))
                cursor += 1
                continue
            if not raw or raw[0] not in (" ", "+", "-"):
                raise ValueError("unified diff hunk lines must start with space, + or -")
            entries.append((raw[0], raw[1:]))
            cursor += 1

        consumed = sum(prefix in (" ", "-") for prefix, _content in entries)
        produced = sum(prefix in (" ", "+") for prefix, _content in entries)
        if consumed != old_count or produced != new_count:
            raise ValueError("unified diff hunk line counts do not match its header")
        for prefix, content in entries:
            if prefix in (" ", "-"):
                if source_cursor >= len(source_lines) or source_lines[source_cursor] != content:
                    raise ValueError("unified diff context does not match the current script")
                if prefix == " ":
                    result.append(content)
                source_cursor += 1
            else:
                result.append(content)
        hunk_count += 1

    if hunk_count == 0:
        raise ValueError("script patch must contain at least one unified diff hunk")
    result.extend(source_lines[source_cursor:])
    return "".join(result)


def _stored_voxel_key(voxel: dict[str, Any]) -> VoxelCoordinateKey:
    return (
        int(voxel["dx"]),
        int(voxel["dy"]),
        int(voxel["dz"]),
        int(voxel["mx"]) if voxel.get("mx") is not None else None,
        int(voxel["my"]) if voxel.get("my") is not None else None,
        int(voxel["mz"]) if voxel.get("mz") is not None else None,
    )


def _upserted_voxel(
    operation: EntityVoxelUpsert,
    existing: dict[str, Any] | None = None,
) -> dict[str, int]:
    voxel = {
        "dx": operation.dx,
        "dy": operation.dy,
        "dz": operation.dz,
        "block": 1,
        "color": operation.color_rgb,
    }
    material_id = operation.material_id
    if material_id is None and existing is not None:
        material_id = int(existing.get("material_id", 0))
    if material_id:
        voxel["material_id"] = material_id
    if operation.is_micro:
        # EntityVoxelAddress validation guarantees all offsets are present.
        voxel.update({
            "mx": int(operation.micro_x),  # type: ignore[arg-type]
            "my": int(operation.micro_y),  # type: ignore[arg-type]
            "mz": int(operation.micro_z),  # type: ignore[arg-type]
        })
    return voxel


class ClaimEntityExecutionLeasesRequest(StrictEntityModel):
    instance_id: uuid.UUID
    entity_ids: list[uuid.UUID] = Field(min_length=1, max_length=SPACE_ENTITY_MAX_AOI_RESULTS)


@dataclass(frozen=True)
class EntityCreator:
    user: models.User
    api_key_scopes: frozenset[str] | None = None
    credential: str | None = None


def _request_digest(payload: CreateWorldEntityRequest, definition_digest: bytes) -> bytes:
    canonical = {
        "definition_digest": definition_digest.hex(),
        "desired_run_state": payload.desired_run_state,
        "position": payload.position.model_dump(),
        "yaw_quarter_turns": payload.yaw_quarter_turns,
    }
    return hashlib.sha256(json.dumps(canonical, separators=(",", ":"), sort_keys=True).encode()).digest()


def _decode_entity_definition(encoded: str) -> tuple[bytes, bytes, dict]:
    try:
        definition = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise HTTPException(status_code=422, detail={"code": "ENTITY_DEFINITION_BASE64_INVALID"}) from error
    if not definition or len(definition) > SPACE_ENTITY_MAX_DEFINITION_BYTES:
        raise HTTPException(status_code=413, detail={
            "code": "ENTITY_DEFINITION_TOO_LARGE",
            "limit_bytes": SPACE_ENTITY_MAX_DEFINITION_BYTES,
        })
    try:
        kind, decoded = decode_inventory_resource(definition)
        if kind != "entity":
            raise ValueError("uploaded resource is not an entity")
        canonical = validate_inventory_resource_payload(kind, decoded)
        definition = encode_inventory_resource("entity", canonical)
    except (InventoryCodecError, ValueError) as error:
        raise HTTPException(status_code=422, detail={"code": "ENTITY_DEFINITION_INVALID"}) from error
    if len(definition) > SPACE_ENTITY_MAX_DEFINITION_BYTES:
        raise HTTPException(status_code=413, detail={"code": "ENTITY_DEFINITION_TOO_LARGE"})
    return definition, hashlib.sha256(definition).digest(), canonical


def _validate_snapshot_json(value: Any, *, depth: int = 0, budget: list[int] | None = None) -> None:
    if budget is None:
        budget = [SPACE_ENTITY_SNAPSHOT_MAX_VALUES]
    budget[0] -= 1
    if budget[0] < 0 or depth > SPACE_ENTITY_SNAPSHOT_MAX_DEPTH:
        raise HTTPException(status_code=422, detail={"code": "ENTITY_SNAPSHOT_TOO_COMPLEX"})
    if value is None or isinstance(value, (bool, str)):
        if isinstance(value, str) and len(value) > SPACE_ENTITY_SNAPSHOT_MAX_STRING_CHARS:
            raise HTTPException(status_code=422, detail={"code": "ENTITY_SNAPSHOT_STRING_TOO_LONG"})
        return
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if (
            (isinstance(value, float) and not math.isfinite(value))
            or abs(value) > 1_000_000_000_000
        ):
            raise HTTPException(status_code=422, detail={"code": "ENTITY_SNAPSHOT_NUMBER_INVALID"})
        return
    if isinstance(value, list):
        if len(value) > SPACE_ENTITY_SNAPSHOT_MAX_CONTAINER_ITEMS:
            raise HTTPException(status_code=422, detail={"code": "ENTITY_SNAPSHOT_TOO_COMPLEX"})
        for item in value:
            _validate_snapshot_json(item, depth=depth + 1, budget=budget)
        return
    if isinstance(value, dict):
        if len(value) > SPACE_ENTITY_SNAPSHOT_MAX_CONTAINER_ITEMS:
            raise HTTPException(status_code=422, detail={"code": "ENTITY_SNAPSHOT_TOO_COMPLEX"})
        for key, item in value.items():
            if (
                not isinstance(key, str)
                or len(key) > 256
                or key in SPACE_ENTITY_SNAPSHOT_FORBIDDEN_KEYS
            ):
                raise HTTPException(status_code=422, detail={"code": "ENTITY_SNAPSHOT_KEY_INVALID"})
            _validate_snapshot_json(item, depth=depth + 1, budget=budget)
        return
    raise HTTPException(status_code=422, detail={"code": "ENTITY_SNAPSHOT_VALUE_INVALID"})


def _snapshot_vector(snapshot: dict[str, Any], key: str, length: int) -> list[float]:
    value = snapshot.get(key)
    if (
        not isinstance(value, list)
        or len(value) != length
        or any(isinstance(part, bool) or not isinstance(part, (int, float)) for part in value)
        or any(not math.isfinite(float(part)) for part in value)
    ):
        raise HTTPException(status_code=422, detail={"code": "ENTITY_SNAPSHOT_TRANSFORM_INVALID"})
    return [float(part) for part in value]


def _encode_snapshot(
    snapshot: dict[str, Any],
    world: models.SpaceWorld,
    position: EntityPosition,
) -> tuple[bytes, bytes]:
    if "slot" in snapshot:
        raise HTTPException(status_code=422, detail={"code": "ENTITY_SNAPSHOT_DEFINITION_DUPLICATED"})
    _validate_snapshot_json(snapshot)
    snapshot_position = _snapshot_vector(snapshot, "position", 3)
    _snapshot_vector(snapshot, "constructorOrigin", 3)
    quaternion = _snapshot_vector(snapshot, "quaternion", 4)
    quaternion_norm = math.sqrt(sum(component * component for component in quaternion))
    if quaternion_norm < 0.5 or quaternion_norm > 1.5:
        raise HTTPException(status_code=422, detail={"code": "ENTITY_SNAPSHOT_TRANSFORM_INVALID"})
    for key in ("nodes", "bodies"):
        if not isinstance(snapshot.get(key, []), list) or len(snapshot.get(key, [])) > 64:
            raise HTTPException(status_code=422, detail={"code": "ENTITY_SNAPSHOT_TOO_COMPLEX"})
    if not isinstance(snapshot.get("states", {}), dict) or len(snapshot.get("states", {})) > 64:
        raise HTTPException(status_code=422, detail={"code": "ENTITY_SNAPSHOT_TOO_COMPLEX"})
    if not isinstance(snapshot.get("scriptLogs", []), list) or len(snapshot.get("scriptLogs", [])) > 100:
        raise HTTPException(status_code=422, detail={"code": "ENTITY_SNAPSHOT_TOO_COMPLEX"})
    if not isinstance(snapshot.get("nodeScriptErrors", []), list) or len(snapshot.get("nodeScriptErrors", [])) > 64:
        raise HTTPException(status_code=422, detail={"code": "ENTITY_SNAPSHOT_TOO_COMPLEX"})

    width_cm, length_cm = _world_dimensions_cm(world)
    snapshot_x_cm = round(snapshot_position[0] * 100) % width_cm
    snapshot_y_cm = round(snapshot_position[1] * 100)
    snapshot_z_cm = round(snapshot_position[2] * 100) % length_cm
    if (
        abs(snapshot_x_cm - position.x_cm) > 1
        or abs(snapshot_y_cm - position.y_cm) > 1
        or abs(snapshot_z_cm - position.z_cm) > 1
    ):
        raise HTTPException(status_code=422, detail={"code": "ENTITY_SNAPSHOT_POSITION_MISMATCH"})
    try:
        encoded = json.dumps(
            snapshot,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (OverflowError, RecursionError, TypeError, ValueError) as error:
        raise HTTPException(status_code=422, detail={"code": "ENTITY_SNAPSHOT_INVALID"}) from error
    if len(encoded) > SPACE_ENTITY_MAX_SNAPSHOT_BYTES:
        raise HTTPException(status_code=413, detail={
            "code": "ENTITY_SNAPSHOT_TOO_LARGE",
            "limit_bytes": SPACE_ENTITY_MAX_SNAPSHOT_BYTES,
        })
    return encoded, hashlib.sha256(encoded).digest()


def _browser_request_digest(
    *,
    definition_digest: bytes | None,
    snapshot_digest: bytes,
    position: EntityPosition,
    desired_run_state: str,
) -> bytes:
    canonical = {
        "definition_digest": definition_digest.hex() if definition_digest else None,
        "snapshot_digest": snapshot_digest.hex(),
        "position": position.model_dump(),
        "desired_run_state": desired_run_state,
    }
    return hashlib.sha256(json.dumps(canonical, separators=(",", ":"), sort_keys=True).encode()).digest()



def _entity_creator(
    credentials: HTTPAuthorizationCredentials | None = Security(entity_security),
    db: Session = Depends(get_db),
) -> EntityCreator:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail={"code": "ENTITY_CREATE_AUTH_REQUIRED"})
    credential = credentials.credentials
    user, raw_scopes = auth.resolve_identity(db, credential, allow_api_key=True)
    scopes = frozenset(SPACE_API_KEY_SCOPES) if raw_scopes is not None else None
    return EntityCreator(user=user, api_key_scopes=scopes, credential=credential)


def _world_dimensions_cm(world: models.SpaceWorld) -> tuple[int, int]:
    return (
        int(world.width_chunks) * SPACE_CHUNK_SIZE * 100,
        int(world.length_chunks) * SPACE_CHUNK_SIZE * 100,
    )


def _utc(value: datetime.datetime | None) -> datetime.datetime | None:
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=datetime.timezone.utc)


def _validate_position(
    world: models.SpaceWorld,
    position: EntityPosition,
    *,
    require_buildable_height: bool = False,
) -> None:
    width_cm, length_cm = _world_dimensions_cm(world)
    if not (0 <= position.x_cm < width_cm and 0 <= position.z_cm < length_cm):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "ENTITY_POSITION_OUT_OF_BOUNDS",
                "message": "Entity X/Z coordinates must be inside the wrapped world coordinate range.",
            },
        )
    if require_buildable_height and not (0 <= position.y_cm < SPACE_WORLD_HEIGHT * 100):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "ENTITY_POSITION_OUT_OF_BOUNDS",
                "message": f"New entities must be placed within build height [0,{SPACE_WORLD_HEIGHT}).",
            },
        )


def _validate_entity_build_height(position: EntityPosition, canonical: dict[str, Any]) -> None:
    minimum_y, maximum_y = entity_stopped_y_bounds(canonical)
    origin_y = position.y_cm / 100
    if origin_y + minimum_y < 0 or origin_y + maximum_y > SPACE_WORLD_HEIGHT:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "ENTITY_POSITION_OUT_OF_BOUNDS",
                "message": f"The entity must fit within build height [0,{SPACE_WORLD_HEIGHT}).",
            },
        )


def _lock_entity_quota_scope(db: Session, world: models.SpaceWorld, user: models.User) -> None:
    # Entity capacity/storage is world-scoped. Lock world first, consistently
    # with hosting commits, rather than deadlocking actor->world/world->actor.
    db.query(models.SpaceWorld).filter(models.SpaceWorld.id == world.id).with_for_update().first()


def _owned_entity_storage_bytes(db: Session, world_id: str, user_id: str) -> int:
    return int(db.query(func.coalesce(func.sum(
        models.SpaceWorldEntity.size_bytes + models.SpaceWorldEntity.snapshot_size_bytes
    ), 0)).filter(
        models.SpaceWorldEntity.world_id == world_id,
        models.SpaceWorldEntity.owner_user_id == user_id,
    ).scalar() or 0)


def _enforce_entity_storage_quota(
    db: Session,
    world: models.SpaceWorld,
    user: models.User,
    *,
    incoming_bytes: int,
    replaced_bytes: int = 0,
    storage_user_id: str | None = None,
) -> None:
    if user.is_admin:
        return
    # Shared edits replace storage attributed to the creator, not the actor's
    # unrelated entities. Write-rate allowance still belongs to the actor.
    used = _owned_entity_storage_bytes(db, str(world.id), storage_user_id or user.id)
    projected = used - max(0, int(replaced_bytes)) + max(0, int(incoming_bytes))
    if projected > SPACE_ENTITY_MAX_TOTAL_BYTES_PER_OWNER:
        raise HTTPException(status_code=429, detail={
            "code": "WORLD_ENTITY_STORAGE_QUOTA_REACHED",
            "message": "The account's world-entity storage allowance has been reached.",
            "limit_bytes": SPACE_ENTITY_MAX_TOTAL_BYTES_PER_OWNER,
            "used_bytes": used,
            "requested_bytes": max(0, int(incoming_bytes) - int(replaced_bytes)),
            "remaining_bytes": max(0, SPACE_ENTITY_MAX_TOTAL_BYTES_PER_OWNER - used),
        })


def _running_entity_query(
    db: Session,
    world_id: str,
    *,
    exclude_entity_id: str | None = None,
):
    query = db.query(models.SpaceWorldEntity).filter(
        models.SpaceWorldEntity.world_id == world_id,
        models.SpaceWorldEntity.desired_run_state == "running",
        models.SpaceWorldEntity.execution_mode == "browser",
    )
    if exclude_entity_id is not None:
        query = query.filter(models.SpaceWorldEntity.id != exclude_entity_id)
    return query


def _enforce_running_entity_quota(
    db: Session,
    world: models.SpaceWorld,
    user: models.User,
    position: EntityPosition,
    *,
    exclude_entity_id: str | None = None,
) -> None:
    if user.is_admin:
        return
    running = _running_entity_query(
        db,
        str(world.id),
        exclude_entity_id=exclude_entity_id,
    )
    owner_count = running.filter(
        func.coalesce(models.SpaceWorldEntity.execution_user_id, models.SpaceWorldEntity.owner_user_id) == user.id,
    ).count()
    if owner_count >= SPACE_ENTITY_MAX_RUNNING_PER_OWNER:
        raise HTTPException(status_code=429, detail={
            "code": "WORLD_ENTITY_RUNNING_OWNER_QUOTA_REACHED",
            "message": "Too many entities are already running for this account.",
            "limit": SPACE_ENTITY_MAX_RUNNING_PER_OWNER,
        })
    world_count = running.count()
    if world_count >= SPACE_ENTITY_MAX_RUNNING_PER_WORLD:
        raise HTTPException(status_code=429, detail={
            "code": "WORLD_ENTITY_RUNNING_WORLD_QUOTA_REACHED",
            "message": "The world has reached its running-entity capacity.",
            "limit": SPACE_ENTITY_MAX_RUNNING_PER_WORLD,
        })
    chunk_size_cm = SPACE_CHUNK_SIZE * 100
    chunk_x = position.x_cm // chunk_size_cm
    chunk_z = position.z_cm // chunk_size_cm
    chunk_count = running.filter(
        models.SpaceWorldEntity.position_x_cm >= chunk_x * chunk_size_cm,
        models.SpaceWorldEntity.position_x_cm < (chunk_x + 1) * chunk_size_cm,
        models.SpaceWorldEntity.position_z_cm >= chunk_z * chunk_size_cm,
        models.SpaceWorldEntity.position_z_cm < (chunk_z + 1) * chunk_size_cm,
    ).count()
    if chunk_count >= SPACE_ENTITY_MAX_RUNNING_PER_CHUNK:
        raise HTTPException(status_code=429, detail={
            "code": "WORLD_ENTITY_RUNNING_CHUNK_QUOTA_REACHED",
            "message": "This chunk has reached its running-entity capacity.",
            "limit": SPACE_ENTITY_MAX_RUNNING_PER_CHUNK,
            "chunk_x": chunk_x,
            "chunk_z": chunk_z,
        })


def _entity_response(entity: models.SpaceWorldEntity, current_user: models.User,
                     owner_names: dict[str, str | None] | None = None) -> dict:
    def account_name(user_id):
        if user_id == current_user.id:
            return current_user.username
        if owner_names is not None:
            return owner_names.get(user_id)
        session = object_session(entity)
        account = session.get(models.User, user_id) if session and user_id else None
        return account.username if account else None
    owner_name = account_name(entity.owner_user_id)
    expiry = _utc(entity.execution_lease_expires_at)
    browser_running = (entity.execution_mode != "hosted" and entity.desired_run_state == "running"
                       and entity.execution_instance_id is not None and expiry is not None
                       and expiry > datetime.datetime.now(datetime.timezone.utc))
    return {
        "id": str(entity.id),
        "world_id": str(entity.world_id),
        "owner_user_id": entity.owner_user_id,
        "owner_name": owner_name,
        "execution_user_id": entity.execution_user_id if browser_running or entity.execution_mode == "hosted" else None,
        "executor_name": account_name(entity.execution_user_id) if browser_running else None,
        "execution_lease_expires_at": expiry.isoformat() if browser_running else None,
        "execution_epoch": int(entity.execution_epoch or 0),
        "name": entity.name,
        "schema_version": entity.schema_version,
        "definition_digest": bytes(entity.content_digest).hex(),
        "definition_size_bytes": entity.size_bytes,
        "definition_url": (
            f"/space/api/v2/worlds/{entity.world_id}/entities/{entity.id}/definition"
            f"?digest={bytes(entity.content_digest).hex()}"
        ),
        "snapshot_digest": bytes(entity.snapshot_digest).hex() if entity.snapshot_digest else None,
        "snapshot_size_bytes": entity.snapshot_size_bytes,
        "snapshot_url": (
            f"/space/api/v2/worlds/{entity.world_id}/entities/{entity.id}/snapshot"
            f"?digest={bytes(entity.snapshot_digest).hex()}"
            if entity.snapshot is not None and entity.snapshot_digest is not None else None
        ),
        "position": {
            "x_cm": entity.position_x_cm,
            "y_cm": entity.position_y_cm,
            "z_cm": entity.position_z_cm,
        },
        "yaw_quarter_turns": entity.yaw_quarter_turns,
        "desired_run_state": entity.desired_run_state,
        "execution_mode": entity.execution_mode,
        "hosting_enabled": entity.hosting_enabled,
        "hosting_core_id": entity.hosting_core_id,
        "can_manage_hosting": entity.execution_mode == 'hosted' and entity.execution_user_id == current_user.id,
        "revision": entity.revision,
        "can_control": entity.execution_mode != "hosted",
        "can_edit": entity.execution_mode != "hosted",
        "created_at": entity.created_at.isoformat(),
        "updated_at": entity.updated_at.isoformat(),
    }


def _wrapped_intervals(center: int, radius: int, extent: int) -> list[tuple[int, int]]:
    if radius * 2 >= extent:
        return [(0, extent - 1)]
    low = center - radius
    high = center + radius
    if low < 0:
        return [(0, high), (extent + low, extent - 1)]
    if high >= extent:
        return [(low, extent - 1), (0, high - extent)]
    return [(low, high)]


def _interval_filter(column, intervals: list[tuple[int, int]]):
    predicates = [and_(column >= low, column <= high) for low, high in intervals]
    return predicates[0] if len(predicates) == 1 else or_(*predicates)


def _wrapped_delta(value: int, center: int, extent: int) -> int:
    return (value - center + extent // 2) % extent - extent // 2


@router.post("", status_code=201)
@limiter.limit(SPACE_ENTITY_CREATE_RATE_LIMIT)
def create_world_entity(
    request: Request,
    world_id: str,
    payload: CreateWorldEntityRequest = Depends(create_world_entity_request),
    db: Session = Depends(get_db),
    creator: EntityCreator = Depends(_entity_creator),
):
    current_user = creator.user
    world = _require_world_membership(db, world_id, current_user)
    _validate_position(world, payload.position, require_buildable_height=True)
    definition, definition_digest, canonical = _decode_entity_definition(payload.definition_base64)
    _validate_entity_build_height(payload.position, canonical)
    operation_id = str(payload.operation_id)
    request_digest = _request_digest(payload, definition_digest)
    existing = db.query(models.SpaceWorldEntity).filter(
        models.SpaceWorldEntity.world_id == world.id,
        models.SpaceWorldEntity.owner_user_id == current_user.id,
        models.SpaceWorldEntity.create_operation_id == operation_id,
    ).first()
    if existing is not None:
        if bytes(existing.create_request_digest) != request_digest:
            raise HTTPException(status_code=409, detail={"code": "ENTITY_OPERATION_ID_REUSED"})
        db.commit()
        return _entity_response(existing, current_user)

    # Serialize quota checks for one account so concurrent agents cannot exceed
    # the per-world ownership cap.
    _lock_entity_quota_scope(db, world, current_user)
    owned_count = db.query(models.SpaceWorldEntity).filter(
        models.SpaceWorldEntity.world_id == world.id,
        models.SpaceWorldEntity.owner_user_id == current_user.id,
    ).count()
    if owned_count >= SPACE_ENTITY_MAX_PER_OWNER:
        raise HTTPException(status_code=429, detail={
            "code": "WORLD_ENTITY_QUOTA_REACHED",
            "limit": SPACE_ENTITY_MAX_PER_OWNER,
        })
    _enforce_entity_storage_quota(
        db,
        world,
        current_user,
        incoming_bytes=len(definition),
    )
    if payload.desired_run_state == "running":
        _enforce_running_entity_quota(db, world, current_user, payload.position)

    entity = models.SpaceWorldEntity(
        world_id=world.id,
        owner_user_id=current_user.id,
        name=inventory_resource_name("entity", canonical),
        schema_version=INVENTORY_SCHEMA_VERSION,
        content_digest=definition_digest,
        definition=definition,
        size_bytes=len(definition),
        position_x_cm=payload.position.x_cm,
        position_y_cm=payload.position.y_cm,
        position_z_cm=payload.position.z_cm,
        yaw_quarter_turns=payload.yaw_quarter_turns,
        desired_run_state=payload.desired_run_state,
        revision=1,
        create_operation_id=operation_id,
        create_request_digest=request_digest,
    )
    db.add(entity)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        existing = db.query(models.SpaceWorldEntity).filter(
            models.SpaceWorldEntity.world_id == world.id,
            models.SpaceWorldEntity.owner_user_id == current_user.id,
            models.SpaceWorldEntity.create_operation_id == operation_id,
        ).first()
        if existing is not None and bytes(existing.create_request_digest) == request_digest:
            return _entity_response(existing, current_user)
        raise HTTPException(status_code=409, detail={"code": "ENTITY_CREATE_CONFLICT"}) from error
    db.refresh(entity)
    return _entity_response(entity, current_user)


@router.post("/browser", status_code=201)
@limiter.limit(SPACE_ENTITY_CREATE_RATE_LIMIT)
def create_browser_world_entity(
    request: Request,
    world_id: str,
    payload: CreateBrowserWorldEntityRequest = Depends(create_browser_world_entity_request),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Persist an entity authored in an authenticated Space browser."""
    world = _require_world_membership(db, world_id, current_user)
    _validate_position(world, payload.position, require_buildable_height=True)
    definition, definition_digest, canonical = _decode_entity_definition(payload.definition_base64)
    _validate_entity_build_height(payload.position, canonical)
    snapshot, snapshot_digest = _encode_snapshot(payload.snapshot, world, payload.position)
    operation_id = str(payload.operation_id)
    request_digest = _browser_request_digest(
        definition_digest=definition_digest,
        snapshot_digest=snapshot_digest,
        position=payload.position,
        desired_run_state=payload.desired_run_state,
    )
    existing = db.query(models.SpaceWorldEntity).filter(
        models.SpaceWorldEntity.world_id == world.id,
        models.SpaceWorldEntity.owner_user_id == current_user.id,
        models.SpaceWorldEntity.create_operation_id == operation_id,
    ).first()
    if existing is not None:
        if bytes(existing.create_request_digest) != request_digest:
            raise HTTPException(status_code=409, detail={"code": "ENTITY_OPERATION_ID_REUSED"})
        return _entity_response(existing, current_user)

    _lock_entity_quota_scope(db, world, current_user)
    owned_count = db.query(models.SpaceWorldEntity).filter(
        models.SpaceWorldEntity.world_id == world.id,
        models.SpaceWorldEntity.owner_user_id == current_user.id,
    ).count()
    if owned_count >= SPACE_ENTITY_MAX_PER_OWNER:
        raise HTTPException(status_code=429, detail={
            "code": "WORLD_ENTITY_QUOTA_REACHED",
            "limit": SPACE_ENTITY_MAX_PER_OWNER,
        })
    _enforce_entity_storage_quota(
        db,
        world,
        current_user,
        incoming_bytes=len(definition) + len(snapshot),
    )
    if payload.desired_run_state == "running":
        _enforce_running_entity_quota(db, world, current_user, payload.position)

    entity = models.SpaceWorldEntity(
        world_id=world.id,
        owner_user_id=current_user.id,
        name=inventory_resource_name("entity", canonical),
        schema_version=INVENTORY_SCHEMA_VERSION,
        content_digest=definition_digest,
        definition=definition,
        size_bytes=len(definition),
        snapshot=snapshot,
        snapshot_digest=snapshot_digest,
        snapshot_size_bytes=len(snapshot),
        position_x_cm=payload.position.x_cm,
        position_y_cm=payload.position.y_cm,
        position_z_cm=payload.position.z_cm,
        yaw_quarter_turns=0,
        desired_run_state=payload.desired_run_state,
        revision=1,
        create_operation_id=operation_id,
        create_request_digest=request_digest,
    )
    db.add(entity)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        existing = db.query(models.SpaceWorldEntity).filter(
            models.SpaceWorldEntity.world_id == world.id,
            models.SpaceWorldEntity.owner_user_id == current_user.id,
            models.SpaceWorldEntity.create_operation_id == operation_id,
        ).first()
        if existing is not None and bytes(existing.create_request_digest) == request_digest:
            return _entity_response(existing, current_user)
        raise HTTPException(status_code=409, detail={"code": "ENTITY_CREATE_CONFLICT"}) from error
    db.refresh(entity)
    return _entity_response(entity, current_user)


@router.get("")
@limiter.limit(SPACE_ENTITY_RATE_LIMIT)
def list_world_entities(
    request: Request,
    world_id: str,
    center_x_cm: int = Query(ge=0),
    center_z_cm: int = Query(ge=0),
    radius_cm: int = Query(default=32 * SPACE_CHUNK_SIZE * 100, ge=100, le=SPACE_ENTITY_MAX_AOI_RADIUS_CM),
    limit: int = Query(default=SPACE_ENTITY_MAX_AOI_RESULTS, ge=1, le=SPACE_ENTITY_MAX_AOI_RESULTS),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    world = _require_world_membership(db, world_id, current_user)
    width_cm, length_cm = _world_dimensions_cm(world)
    if center_x_cm >= width_cm or center_z_cm >= length_cm:
        raise HTTPException(status_code=422, detail={"code": "ENTITY_AOI_OUT_OF_BOUNDS"})
    candidates = db.query(models.SpaceWorldEntity).filter(
        models.SpaceWorldEntity.world_id == world.id,
        _interval_filter(
            models.SpaceWorldEntity.position_x_cm,
            _wrapped_intervals(center_x_cm, radius_cm, width_cm),
        ),
        _interval_filter(
            models.SpaceWorldEntity.position_z_cm,
            _wrapped_intervals(center_z_cm, radius_cm, length_cm),
        ),
    ).order_by(models.SpaceWorldEntity.created_at, models.SpaceWorldEntity.id).limit(
        SPACE_ENTITY_MAX_AOI_CANDIDATES + 1
    ).all()
    in_radius = []
    radius_squared = radius_cm * radius_cm
    for entity in candidates[:SPACE_ENTITY_MAX_AOI_CANDIDATES]:
        dx = _wrapped_delta(entity.position_x_cm, center_x_cm, width_cm)
        dz = _wrapped_delta(entity.position_z_cm, center_z_cm, length_cm)
        if dx * dx + dz * dz <= radius_squared:
            in_radius.append((dx * dx + dz * dz, entity))
    in_radius.sort(key=lambda item: (item[0], item[1].created_at, str(item[1].id)))
    truncated = len(candidates) > SPACE_ENTITY_MAX_AOI_CANDIDATES or len(in_radius) > limit
    # One bounded identity query for the entire AOI, not one query per label.
    owner_ids = {user_id for _distance, entity in in_radius[:limit]
                 for user_id in (entity.owner_user_id, entity.execution_user_id) if user_id}
    owner_names = dict(db.query(models.User.id, models.User.username).filter(models.User.id.in_(owner_ids)).all())
    return {
        "items": [_entity_response(entity, current_user, owner_names) for _distance, entity in in_radius[:limit]],
        "truncated": truncated,
        "limit": limit,
    }


@router.get("/{entity_id}")
@limiter.limit(SPACE_ENTITY_RATE_LIMIT)
def get_world_entity(request: Request, world_id: str, entity_id: str,
                     db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)):
    world = _require_world_membership(db, world_id, current_user)
    entity = db.query(models.SpaceWorldEntity).filter_by(world_id=world.id, id=entity_id).first()
    if entity is None:
        raise HTTPException(404, detail={"code": "WORLD_ENTITY_NOT_FOUND"})
    return _entity_response(entity, current_user)


@router.get("/{entity_id}/definition")
@limiter.limit(SPACE_ENTITY_RATE_LIMIT)
def get_world_entity_definition(
    request: Request,
    world_id: str,
    entity_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    world = _require_world_membership(db, world_id, current_user)
    entity = db.query(models.SpaceWorldEntity).filter(
        models.SpaceWorldEntity.world_id == world.id,
        models.SpaceWorldEntity.id == entity_id,
    ).first()
    if entity is None:
        raise HTTPException(status_code=404, detail={"code": "WORLD_ENTITY_NOT_FOUND"})
    definition = bytes(entity.definition)
    if len(definition) != entity.size_bytes or hashlib.sha256(definition).digest() != bytes(entity.content_digest):
        raise HTTPException(status_code=500, detail={"code": "WORLD_ENTITY_DEFINITION_CORRUPT"})
    return Response(
        content=definition,
        media_type="application/x-protobuf",
        headers={
            "Cache-Control": "private, max-age=31536000, immutable",
            "ETag": f'"{bytes(entity.content_digest).hex()}"',
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/{entity_id}/snapshot")
@limiter.limit(SPACE_ENTITY_RATE_LIMIT)
def get_world_entity_snapshot(
    request: Request,
    world_id: str,
    entity_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    world = _require_world_membership(db, world_id, current_user)
    entity = db.query(models.SpaceWorldEntity).filter(
        models.SpaceWorldEntity.world_id == world.id,
        models.SpaceWorldEntity.id == entity_id,
    ).first()
    if entity is None:
        raise HTTPException(status_code=404, detail={"code": "WORLD_ENTITY_NOT_FOUND"})
    if entity.snapshot is None or entity.snapshot_digest is None:
        raise HTTPException(status_code=404, detail={"code": "WORLD_ENTITY_SNAPSHOT_NOT_FOUND"})
    snapshot = bytes(entity.snapshot)
    if (
        len(snapshot) != entity.snapshot_size_bytes
        or hashlib.sha256(snapshot).digest() != bytes(entity.snapshot_digest)
    ):
        raise HTTPException(status_code=500, detail={"code": "WORLD_ENTITY_SNAPSHOT_CORRUPT"})
    return Response(
        content=snapshot,
        media_type="application/json",
        headers={
            "Cache-Control": "private, no-store",
            "ETag": f'"{bytes(entity.snapshot_digest).hex()}"',
            "X-Content-Type-Options": "nosniff",
        },
    )


def _world_entity_for_update(db, world, entity_id):
    entity = db.query(models.SpaceWorldEntity).filter_by(world_id=world.id, id=entity_id).with_for_update().first()
    if entity is None:
        raise HTTPException(404, detail={"code": "WORLD_ENTITY_NOT_FOUND"})
    return entity


def _operation_digest(entity, user, action, payload):
    return hashlib.sha256(json.dumps({
        "entity_id": str(entity.id), "actor_id": user.id, "action": action,
        "payload": payload.model_dump(mode="json", exclude={"operation_id"}, exclude_unset=True),
    }, sort_keys=True, separators=(",", ":")).encode()).digest()


def _replay_entity_operation(db, entity, operation_id, digest):
    receipt = db.get(models.SpaceEntityOperation, (str(entity.world_id), str(operation_id)))
    if receipt is None:
        return None
    if bytes(receipt.request_digest) != digest:
        raise HTTPException(409, detail={"code": "ENTITY_OPERATION_ID_REUSED"})
    # Return the original acknowledgement, never execute a delayed retry again.
    return receipt.result


def _commit_entity_operation(db, entity, user, operation_id, digest):
    db.flush()
    result = _entity_response(entity, user)
    db.add(models.SpaceEntityOperation(world_id=str(entity.world_id), operation_id=str(operation_id),
                                      request_digest=digest, result=result))
    db.commit()
    return result


def _reset_entity_runtime_snapshot(entity, world, canonical):
    # Keep the last saved placement, including arbitrary root orientation. Drop
    # runtime body overrides, child poses, variables, clock, errors and velocity.
    if entity.snapshot is not None:
        previous = json.loads(bytes(entity.snapshot))
        snapshot = {key: previous[key] for key in (
            "position", "quaternion", "constructorOrigin", "localCenter", "rootPivotOverride"
        ) if key in previous}
        snapshot.update({"nodes": [], "states": {}, "scriptStatus": "stopped",
                         "physicsSimulationEnabled": False, "resetRuntime": True, "bodies": [{
            "id": canonical["root"]["id"], "position": snapshot["position"],
            "quaternion": snapshot["quaternion"],
        }]})
        encoded, digest = _encode_snapshot(snapshot, world, EntityPosition(
            x_cm=entity.position_x_cm, y_cm=entity.position_y_cm, z_cm=entity.position_z_cm))
        entity.snapshot, entity.snapshot_digest = encoded, digest
        entity.snapshot_size_bytes = len(encoded)
    entity.execution_instance_id = None
    entity.execution_user_id = None
    entity.execution_lease_expires_at = None
    entity.execution_epoch = int(entity.execution_epoch or 0) + 1


def _require_execution_holder(entity, instance_id, epoch, user_id, *, now=None):
    """World members are equal; only the live holder may operate an occupied entity.

    The random instance capability is returned only to its claimant, never in
    public entity records. Expired browser leases do not block recovery.
    Hosted execution is managed through the separately authorized hosting API.
    """
    now = now or datetime.datetime.now(datetime.timezone.utc)
    expiry = _utc(entity.execution_lease_expires_at)
    if (entity.execution_mode == "browser" and entity.execution_instance_id is not None
            and expiry is not None and expiry > now):
        if (str(instance_id or "") != str(entity.execution_instance_id)
                or entity.execution_user_id != user_id
                or epoch != entity.execution_epoch):
            raise HTTPException(409, detail={"code": "ENTITY_OCCUPIED",
                "message": "This entity is occupied by another execution endpoint."})


@router.get("/{entity_id}/configuration")
@limiter.limit(SPACE_ENTITY_RATE_LIMIT)
def get_entity_configuration(request: Request, response: Response, world_id: str, entity_id: str,
                             db: Session = Depends(get_db), creator: EntityCreator = Depends(_entity_creator)):
    world = _require_world_membership(db, world_id, creator.user)
    entity = _world_entity_for_update(db, world, entity_id)
    _kind, definition = decode_inventory_resource(bytes(entity.definition))
    response.headers["Cache-Control"] = "private, no-store"
    result = {"entity": _entity_response(entity, creator.user), "definition": definition}
    db.commit()
    return result


@router.patch("/{entity_id}/configuration")
@limiter.limit(SPACE_ENTITY_RATE_LIMIT)
def update_entity_configuration(request: Request, world_id: str, entity_id: str,
                                payload: UpdateEntityConfigurationRequest,
                                db: Session = Depends(get_db), creator: EntityCreator = Depends(_entity_creator)):
    world = _require_world_membership(db, world_id, creator.user)
    _lock_entity_quota_scope(db, world, creator.user)
    entity = _world_entity_for_update(db, world, entity_id)
    digest = _operation_digest(entity, creator.user, "configuration", payload)
    replay = _replay_entity_operation(db, entity, payload.operation_id, digest)
    if replay is not None:
        return replay
    if entity.execution_mode == "hosted":
        raise HTTPException(409, detail={"code": "ENTITY_HOSTED_EDIT_FORBIDDEN"})
    if payload.expected_revision != entity.revision:
        raise HTTPException(409, detail={"code": "ENTITY_REVISION_CONFLICT", "current": _entity_response(entity, creator.user)})
    if entity.desired_run_state != "stopped":
        raise HTTPException(409, detail={
            "code": "ENTITY_MUST_BE_STOPPED",
            "message": "Stop the entity before editing code, defaults or voxels.",
        })
    _kind, definition = decode_inventory_resource(bytes(entity.definition))
    components = {}
    def visit(component):
        components[component["id"]] = component
        for child in component.get("children", []):
            visit(child)
    visit(definition["root"])
    for patch in payload.components:
        if patch.id not in components:
            raise HTTPException(422, detail={"code": "ENTITY_COMPONENT_NOT_FOUND", "component_id": patch.id})
        target = components[patch.id]
        ordinary_fields = patch.model_dump(
            exclude_unset=True,
            exclude={"id", "script_patch", "voxel_ops"},
        )
        for key, value in ordinary_fields.items():
            if key == "body":
                target["body"].update(value)
            else:
                target[key] = value
        if patch.script_patch is not None:
            current_script = target.get("script") or ""
            current_sha256 = hashlib.sha256(current_script.encode("utf-8")).hexdigest()
            if not secrets.compare_digest(current_sha256, patch.script_patch.base_sha256):
                raise HTTPException(409, detail={
                    "code": "ENTITY_SCRIPT_BASE_CONFLICT",
                    "component_id": patch.id,
                    "current_sha256": current_sha256,
                })
            try:
                target["script"] = _apply_unified_script_patch(
                    current_script,
                    patch.script_patch.patch,
                )
            except ValueError as error:
                raise HTTPException(422, detail={
                    "code": "ENTITY_SCRIPT_PATCH_INVALID",
                    "component_id": patch.id,
                    "message": str(error),
                }) from error
        if patch.voxel_ops is not None:
            voxels = {_stored_voxel_key(voxel): voxel for voxel in target.get("blocks", [])}
            for operation in patch.voxel_ops:
                key = _voxel_operation_key(operation)
                if operation.op == "remove":
                    if key not in voxels:
                        raise HTTPException(422, detail={
                            "code": "ENTITY_VOXEL_NOT_FOUND",
                            "component_id": patch.id,
                            "voxel": operation.model_dump(exclude={"op"}, exclude_none=True),
                        })
                    del voxels[key]
                else:
                    voxels[key] = _upserted_voxel(operation, voxels.get(key))
            target["blocks"] = list(voxels.values())
    try:
        canonical = validate_inventory_resource_payload("entity", definition)
        encoded = encode_inventory_resource("entity", canonical)
    except (ValueError, InventoryCodecError) as error:
        raise HTTPException(422, detail={"code": "ENTITY_DEFINITION_INVALID"}) from error
    if len(encoded) > SPACE_ENTITY_MAX_DEFINITION_BYTES:
        raise HTTPException(413, detail={"code": "ENTITY_DEFINITION_TOO_LARGE"})
    replaced_bytes = int(entity.size_bytes) + int(entity.snapshot_size_bytes or 0)
    _reset_entity_runtime_snapshot(entity, world, canonical)
    _enforce_entity_storage_quota(db, world, creator.user,
        incoming_bytes=len(encoded)+int(entity.snapshot_size_bytes or 0), replaced_bytes=replaced_bytes,
        storage_user_id=entity.owner_user_id)
    if not creator.user.is_admin:
        reserve_quota(db, principal_id=creator.user.id, scope_id=str(world.id), metric="entity_checkpoint_bytes",
                      amount=len(encoded)+int(entity.snapshot_size_bytes or 0), windows=(
                          QuotaWindow(60, SPACE_ENTITY_CHECKPOINT_MINUTE_BYTES, "minute"),
                          QuotaWindow(UTC_DAY_SECONDS, SPACE_ENTITY_CHECKPOINT_DAILY_BYTES, "utc_day")),
                      code="WORLD_ENTITY_CHECKPOINT_QUOTA_REACHED", message="Entity write allowance reached.")
    entity.definition, entity.content_digest = encoded, hashlib.sha256(encoded).digest()
    entity.size_bytes = len(encoded)
    entity.name = inventory_resource_name("entity", canonical)
    entity.revision += 1
    entity.updated_at = datetime.datetime.now(datetime.timezone.utc)
    return _commit_entity_operation(db, entity, creator.user, payload.operation_id, digest)


@router.put("/{entity_id}/checkpoint")
@limiter.limit(SPACE_ENTITY_RATE_LIMIT)
def checkpoint_browser_world_entity(
    request: Request,
    world_id: str,
    entity_id: str,
    payload: CheckpointBrowserWorldEntityRequest = Depends(checkpoint_browser_world_entity_request),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    world = _require_world_membership(db, world_id, current_user)
    _validate_position(world, payload.position)
    _lock_entity_quota_scope(db, world, current_user)
    entity = db.query(models.SpaceWorldEntity).filter(
        models.SpaceWorldEntity.world_id == world.id,
        models.SpaceWorldEntity.id == entity_id,
    ).with_for_update().first()
    if entity is None:
        raise HTTPException(status_code=404, detail={"code": "WORLD_ENTITY_NOT_FOUND"})
    if entity.execution_mode == "hosted":
        raise HTTPException(status_code=409, detail={"code": "ENTITY_HOSTED_CHECKPOINT_FORBIDDEN"})
    definition = None
    definition_digest = None
    canonical = None
    if payload.definition_base64 is not None:
        definition, definition_digest, canonical = _decode_entity_definition(payload.definition_base64)
        _validate_entity_build_height(payload.position, canonical)
    snapshot, snapshot_digest = _encode_snapshot(payload.snapshot, world, payload.position)
    request_digest = _browser_request_digest(
        definition_digest=definition_digest,
        snapshot_digest=snapshot_digest,
        position=payload.position,
        desired_run_state=payload.desired_run_state,
    )
    operation_id = str(payload.operation_id)
    if str(entity.last_checkpoint_operation_id or "") == operation_id:
        if bytes(entity.last_checkpoint_request_digest or b"") != request_digest:
            raise HTTPException(status_code=409, detail={"code": "ENTITY_OPERATION_ID_REUSED"})
        return _entity_response(entity, current_user)
    if payload.expected_revision != entity.revision:
        raise HTTPException(status_code=409, detail={
            "code": "ENTITY_REVISION_CONFLICT",
            "current": _entity_response(entity, current_user),
        })

    # Runtime publications belong to one live executor, not the creator.
    # Explicit Stop uses the run-state route.
    if entity.desired_run_state == "running" or payload.desired_run_state == "running":
        expiry = _utc(entity.execution_lease_expires_at)
        if (entity.desired_run_state != "running"
                or payload.execution_instance_id is None
                or entity.execution_user_id != current_user.id
                or str(entity.execution_instance_id or "") != str(payload.execution_instance_id)
                or entity.execution_epoch != payload.execution_epoch
                or expiry is None or expiry <= datetime.datetime.now(datetime.timezone.utc)):
            raise HTTPException(409, detail={"code": "ENTITY_EXECUTION_LEASE_REQUIRED"})
    if (definition_digest is not None and bytes(entity.content_digest) != definition_digest
            and entity.desired_run_state == "running" and payload.desired_run_state == "running"):
        raise HTTPException(409, detail={"code": "ENTITY_MUST_BE_STOPPED"})

    _enforce_entity_storage_quota(
        db,
        world,
        current_user,
        incoming_bytes=(len(definition) if definition is not None else int(entity.size_bytes)) + len(snapshot),
        replaced_bytes=int(entity.size_bytes) + int(entity.snapshot_size_bytes or 0),
        storage_user_id=entity.owner_user_id,
    )
    if payload.desired_run_state == "running":
        _enforce_running_entity_quota(
            db,
            world,
            current_user,
            payload.position,
            exclude_entity_id=str(entity.id),
        )
    checkpoint_bytes = len(snapshot) + (len(definition) if definition is not None else 0)
    if not current_user.is_admin:
        reserve_quota(
            db,
            principal_id=current_user.id,
            scope_id=str(world.id),
            metric="entity_checkpoint_bytes",
            amount=checkpoint_bytes,
            windows=(
                QuotaWindow(60, SPACE_ENTITY_CHECKPOINT_MINUTE_BYTES, "minute"),
                QuotaWindow(UTC_DAY_SECONDS, SPACE_ENTITY_CHECKPOINT_DAILY_BYTES, "utc_day"),
            ),
            code="WORLD_ENTITY_CHECKPOINT_QUOTA_REACHED",
            message="The entity checkpoint write allowance has been reached.",
        )

    if definition is not None and definition_digest is not None:
        entity.definition = definition
        entity.content_digest = definition_digest
        entity.size_bytes = len(definition)
        entity.name = inventory_resource_name("entity", canonical)
    entity.snapshot = snapshot
    entity.snapshot_digest = snapshot_digest
    entity.snapshot_size_bytes = len(snapshot)
    entity.position_x_cm = payload.position.x_cm
    entity.position_y_cm = payload.position.y_cm
    entity.position_z_cm = payload.position.z_cm
    entity.desired_run_state = payload.desired_run_state
    if payload.desired_run_state == "stopped" and entity.execution_instance_id is not None:
        entity.execution_instance_id = None
        entity.execution_user_id = None
        entity.execution_lease_expires_at = None
        entity.execution_epoch = int(entity.execution_epoch or 0) + 1
    entity.revision += 1
    entity.last_checkpoint_operation_id = operation_id
    entity.last_checkpoint_request_digest = request_digest
    entity.updated_at = datetime.datetime.now(datetime.timezone.utc)
    db.commit()
    db.refresh(entity)
    return _entity_response(entity, current_user)


@router.delete("/{entity_id}")
@limiter.limit(SPACE_ENTITY_RATE_LIMIT)
def delete_world_entity(
    request: Request,
    world_id: str,
    entity_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    world = _require_world_membership(db, world_id, current_user)
    entity = db.query(models.SpaceWorldEntity).filter(
        models.SpaceWorldEntity.world_id == world.id,
        models.SpaceWorldEntity.id == entity_id,
    ).with_for_update().first()
    if entity is None:
        raise HTTPException(status_code=404, detail={"code": "WORLD_ENTITY_NOT_FOUND"})
    raw_epoch = request.headers.get("x-space-execution-epoch", "")
    _require_execution_holder(entity, request.headers.get("x-space-execution-instance"),
                              int(raw_epoch) if raw_epoch.isdecimal() else None, current_user.id)
    if entity.execution_mode == "hosted":
        raise HTTPException(409, detail={"code": "ENTITY_HOSTED_EDIT_FORBIDDEN"})
    db.delete(entity)
    db.commit()
    return {"deleted": True, "entity_id": entity_id}


@router.put("/execution-leases")
@limiter.limit(SPACE_ENTITY_RATE_LIMIT)
def claim_world_entity_execution_leases(
    request: Request,
    world_id: str,
    payload: ClaimEntityExecutionLeasesRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    world = _require_world_membership(db, world_id, current_user)
    _lock_entity_quota_scope(db, world, current_user)
    requested_ids = [str(entity_id) for entity_id in payload.entity_ids]
    instance_id = str(payload.instance_id)
    now = datetime.datetime.now(datetime.timezone.utc)
    expires_at = now + datetime.timedelta(seconds=SPACE_ENTITY_EXECUTION_LEASE_SECONDS)
    rows = db.query(models.SpaceWorldEntity).filter(
        models.SpaceWorldEntity.world_id == world.id,
        models.SpaceWorldEntity.id.in_(requested_ids),
    ).with_for_update().all()
    by_id = {str(entity.id): entity for entity in rows}
    results = []
    for entity_id in requested_ids:
        entity = by_id.get(entity_id)
        granted = False
        epoch = 0
        if (
            entity is not None
            and entity.execution_mode == "browser"
            and entity.desired_run_state == "running"
        ):
            current_expiry = _utc(entity.execution_lease_expires_at)
            same_instance = (str(entity.execution_instance_id or "") == instance_id
                             and entity.execution_user_id == current_user.id)
            available = current_expiry is None or current_expiry <= now
            if same_instance or available:
                try:
                    _enforce_running_entity_quota(db, world, current_user, EntityPosition(
                        x_cm=entity.position_x_cm, y_cm=entity.position_y_cm, z_cm=entity.position_z_cm),
                        exclude_entity_id=entity_id)
                except HTTPException as error:
                    if error.status_code != 429:
                        raise
                    results.append({"entity_id": entity_id, "granted": False,
                                    "execution_epoch": 0, "lease_expires_at": None, "executor_name": None})
                    continue
                if not same_instance or available:
                    entity.execution_epoch = int(entity.execution_epoch or 0) + 1
                entity.execution_instance_id = instance_id
                entity.execution_user_id = current_user.id
                entity.execution_lease_expires_at = expires_at
                db.flush()
                granted = True
                epoch = entity.execution_epoch
        results.append({
            "entity_id": entity_id,
            "granted": granted,
            "execution_epoch": epoch,
            "lease_expires_at": expires_at.isoformat() if granted else None,
            "executor_name": current_user.username if granted else None,
        })
    db.commit()
    return {
        "instance_id": instance_id,
        "lease_seconds": SPACE_ENTITY_EXECUTION_LEASE_SECONDS,
        "items": results,
    }


@router.put("/{entity_id}/run-state")
@limiter.limit(SPACE_ENTITY_RATE_LIMIT)
def set_world_entity_run_state(
    request: Request,
    world_id: str,
    entity_id: str,
    payload: SetWorldEntityRunStateRequest,
    db: Session = Depends(get_db),
    creator: EntityCreator = Depends(_entity_creator),
):
    current_user = creator.user
    world = _require_world_membership(db, world_id, current_user)
    _lock_entity_quota_scope(db, world, current_user)
    entity = db.query(models.SpaceWorldEntity).filter(
        models.SpaceWorldEntity.world_id == world.id,
        models.SpaceWorldEntity.id == entity_id,
    ).with_for_update().first()
    if entity is None:
        raise HTTPException(status_code=404, detail={"code": "WORLD_ENTITY_NOT_FOUND"})
    operation_id = str(payload.operation_id)
    digest = _operation_digest(entity, current_user, "run-state", payload)
    replay = _replay_entity_operation(db, entity, operation_id, digest)
    if replay is not None:
        return replay
    _require_execution_holder(entity, payload.execution_instance_id, payload.execution_epoch, current_user.id)
    if entity.execution_mode == "hosted":
        raise HTTPException(409, detail={"code": "USE_ENTITY_HOSTING_API",
            "message": "Manage server execution through the hosting controls."})
    if payload.expected_revision is not None and payload.expected_revision != entity.revision:
        raise HTTPException(status_code=409, detail={
            "code": "ENTITY_REVISION_CONFLICT",
            "current": _entity_response(entity, current_user),
        })
    if (payload.desired_run_state == "running" and payload.execution_instance_id is not None
            and creator.api_key_scopes is not None):
        raise HTTPException(403, detail={"code": "ENTITY_EXECUTION_CLAIM_FORBIDDEN"})
    if payload.stop_pose is not None:
        if payload.desired_run_state != "stopped":
            raise HTTPException(422, detail={"code": "ENTITY_STOP_POSE_REQUIRES_STOP"})
        x, y, z = payload.stop_pose.position
        width, length = _world_dimensions_cm(world)
        final_position = EntityPosition(x_cm=round(x*100) % width, y_cm=round(y*100), z_cm=round(z*100) % length)
        previous = json.loads(bytes(entity.snapshot)) if entity.snapshot else {
            "constructorOrigin": [entity.position_x_cm/100, entity.position_y_cm/100, entity.position_z_cm/100]}
        previous.update({"position": payload.stop_pose.position, "quaternion": payload.stop_pose.quaternion})
        encoded, pose_digest = _encode_snapshot(previous, world, final_position)
        replaced_storage = int(entity.size_bytes) + int(entity.snapshot_size_bytes or 0)
        entity.snapshot, entity.snapshot_digest, entity.snapshot_size_bytes = encoded, pose_digest, len(encoded)
        entity.position_x_cm, entity.position_y_cm, entity.position_z_cm = final_position.x_cm, final_position.y_cm, final_position.z_cm
    if payload.desired_run_state == "running":
        _lock_entity_quota_scope(db, world, current_user)
        _enforce_running_entity_quota(
            db,
            world,
            current_user,
            EntityPosition(
                x_cm=entity.position_x_cm,
                y_cm=entity.position_y_cm,
                z_cm=entity.position_z_cm,
            ),
            exclude_entity_id=str(entity.id),
        )
    entity.desired_run_state = payload.desired_run_state
    if payload.desired_run_state == "running":
        entity.execution_user_id = current_user.id
    if (payload.desired_run_state == "running" and payload.execution_instance_id is not None):
        # Start and acquire are one row-locked transaction, not two racing HTTP
        # requests. An API-key start may still queue intent for an available browser.
        now = datetime.datetime.now(datetime.timezone.utc)
        if (str(entity.execution_instance_id or "") != str(payload.execution_instance_id)
                or _utc(entity.execution_lease_expires_at) is None
                or _utc(entity.execution_lease_expires_at) <= now):
            entity.execution_epoch = int(entity.execution_epoch or 0) + 1
        entity.execution_instance_id = str(payload.execution_instance_id)
        entity.execution_user_id = current_user.id
        entity.execution_lease_expires_at = now + datetime.timedelta(seconds=SPACE_ENTITY_EXECUTION_LEASE_SECONDS)
    entity.revision += 1
    if payload.desired_run_state == "stopped":
        _kind, canonical = decode_inventory_resource(bytes(entity.definition))
        _reset_entity_runtime_snapshot(entity, world, canonical)
        if payload.stop_pose is not None:
            _enforce_entity_storage_quota(db, world, current_user,
                incoming_bytes=int(entity.size_bytes) + int(entity.snapshot_size_bytes or 0),
                replaced_bytes=replaced_storage, storage_user_id=entity.owner_user_id)
    entity.last_control_operation_id = operation_id
    entity.updated_at = datetime.datetime.now(datetime.timezone.utc)
    return _commit_entity_operation(db, entity, current_user, operation_id, digest)
