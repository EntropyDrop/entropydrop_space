"""Ephemeral, fenced entity poses. These never write snapshots or entity code."""
import datetime as dt
import math
import uuid

from space import models
from routers.space_entities import _utc

MAX_ENTITY_POSE_BYTES = 64 * 1024
MAX_SESSION_ENTITY_POSES = 16


def parse_entity_pose(payload):
    for key in ("entity_id", "instance_id"):
        if not isinstance(payload.get(key), str):
            raise ValueError("Invalid entity pose identity")
        uuid.UUID(payload[key])
    for key, minimum in (("execution_epoch", 1), ("sequence", 0)):
        if type(payload.get(key)) is not int or not minimum <= payload[key] <= 2**53 - 1:
            raise ValueError("Invalid entity pose generation/sequence")
    bodies = payload.get("bodies")
    if not isinstance(bodies, list) or not 1 <= len(bodies) <= 128:
        raise ValueError("Invalid entity body poses")
    ids = set()
    for body in bodies:
        if not isinstance(body, dict) or not isinstance(body.get("id"), str):
            raise ValueError("Invalid entity body identity")
        if not 1 <= len(body["id"]) <= 128 or body["id"] in ids:
            raise ValueError("Invalid/duplicate entity body identity")
        ids.add(body["id"])
        if "collisionEnabled" in body and type(body["collisionEnabled"]) is not bool:
            raise ValueError("Invalid body collision flag")
        for key, length, bound in (("position", 3, 1e7), ("quaternion", 4, 1),
                                   ("velocity", 3, 1e4), ("angularVelocity", 3, 1e4)):
            values = body.get(key)
            if (not isinstance(values, list) or len(values) != length
                    or any(type(v) not in (float, int) or not math.isfinite(v) or abs(v) > bound for v in values)):
                raise ValueError("Invalid entity pose vector")
        if abs(sum(v * v for v in body["quaternion"]) - 1) > 0.01:
            raise ValueError("Invalid entity pose quaternion")
    root_position = bodies[0]["position"]
    if not -1000 <= root_position[1] <= 10000:
        raise ValueError("Entity pose height is out of bounds")
    if any(any(abs(v - origin) > 256 for v, origin in zip(body["position"], root_position)) for body in bodies):
        raise ValueError("Entity pose extent is out of bounds")
    # Strip arbitrary client-supplied metadata; authority comes only from DB.
    return {key: payload[key] for key in ("entity_id", "instance_id", "execution_epoch", "sequence", "bodies")}


def authorize_entity_poses(db, world_id, candidates, *, now=None):
    """One narrow database read per world tick, not per entity/packet.

    Rechecking the live lease fences Stop, expiry and takeover immediately, even
    across API workers. Redis events are not treated as client authority.
    """
    if not candidates:
        return []
    now = now or dt.datetime.now(dt.timezone.utc)
    m = models.SpaceWorldEntity
    rows = db.query(m.id, m.execution_user_id, m.execution_mode, m.desired_run_state,
                    m.execution_instance_id, m.execution_epoch, m.execution_lease_expires_at,
                    m.revision, m.content_digest, m.hosting_enabled, m.hosting_last_tick_at).filter(
        m.world_id == world_id, m.id.in_({c["entity_id"] for c in candidates})).all()
    by_id = {str(row.id): row for row in rows}
    result = []
    for candidate in candidates:
        row = by_id.get(candidate["entity_id"])
        if candidate.get("source") == "hosting":
            last_tick = _utc(row.hosting_last_tick_at) if row else None
            if (row and row.execution_mode == "hosted" and row.hosting_enabled
                    and row.desired_run_state == "running" and row.execution_epoch == candidate["execution_epoch"]
                    and row.revision == candidate["revision"] and last_tick and (now - last_tick).total_seconds() < 15):
                result.append({**candidate, "definition_digest": bytes(row.content_digest).hex(),
                               "lease_expires_at": (last_tick + dt.timedelta(seconds=15)).isoformat()})
            continue
        expiry = _utc(row.execution_lease_expires_at) if row else None
        if (row is None or row.execution_mode != "browser" or row.desired_run_state != "running"
                or row.execution_user_id != candidate["user_id"]
                or str(row.execution_instance_id or "") != candidate["instance_id"]
                or row.execution_epoch != candidate["execution_epoch"] or expiry is None or expiry <= now):
            continue
        result.append({**candidate, "revision": row.revision,
                       "definition_digest": bytes(row.content_digest).hex(),
                       "lease_expires_at": expiry.isoformat()})
    return result


def parse_hosted_trajectory(payload):
    if type(payload.get("revision")) is not int or not 1 <= payload["revision"] <= (2**53 - 1) // 32:
        raise ValueError("Invalid hosted trajectory revision")
    if type(payload.get("first_sequence")) is not int or not 0 <= payload["first_sequence"] <= 2**53 - 21:
        raise ValueError("Invalid hosted trajectory clock")
    poses = payload.get("poses")
    if not isinstance(poses, list) or not 1 <= len(poses) <= 20:
        raise ValueError("Invalid hosted trajectory length")
    for bodies in poses:
        parse_entity_pose({"entity_id": payload["entity_id"], "instance_id": str(uuid.UUID(int=0)),
                           "execution_epoch": payload["execution_epoch"], "sequence": 0, "bodies": bodies})
        if len(bodies) > 8:
            raise ValueError("Hosted trajectory body limit")
    return {key: payload[key] for key in ("entity_id", "execution_epoch", "revision", "first_sequence", "poses")}
