"""Run with python -m space.hosting_worker beside the API, never inside an HTTP request.

One fenced coordinator per world, with a separate pinned process per entity.
Simulation runs outside database transactions; results
are committed only if the observed actor/static-scene revision still matches. Purchased
milliseconds, snapshots, terrain events and credit logs commit or roll back together.
"""
import asyncio
import base64
import datetime as dt
import json
import logging
import os
from pathlib import Path
import time
import uuid

from fastapi import HTTPException
from sqlalchemy import and_, or_

from space.voxel_grid import MICRO_DIVISIONS
from space import models
from config import settings
from space.database import SessionLocal
from routers import space as terrain
from routers.space_entities import _decode_entity_definition, _encode_snapshot, EntityPosition, _enforce_entity_storage_quota
from routers.space_hosting import HOUR_MS, utc, validate_hosted_definition
from space.hosting_cores import CORE_LEASE_SECONDS, MAX_HOSTING_CORES, available_cpu_ids, initialize_core_pool, clear_core

log = logging.getLogger(__name__)
LEASE_SECONDS = 15
STEP_MS = 1000
MAX_MESSAGE = 32 * 1024 * 1024


def now():
    return dt.datetime.now(dt.timezone.utc)


def requested_world_ids():
    requested = [value.strip() for value in os.getenv("SPACE_HOSTING_WORLD_IDS", "").split(",") if value.strip()]
    if not requested:
        requested = [settings.SPACE_DEFAULT_WORLD_ID]
    if (settings.ENVIRONMENT.lower() in {"dev", "development", "test", "testing"}
            and settings.SPACE_COPPER_METROPOLIS_WORLD_ID not in requested):
        requested.append(settings.SPACE_COPPER_METROPOLIS_WORLD_ID)
    return requested


def pause(entity, reason):
    entity.hosting_enabled = False
    entity.hosting_core_id = None
    entity.hosting_reason = reason
    entity.desired_run_state = "stopped"
    entity.revision += 1


def charge_time(db, entity, user, elapsed_ms):
    """Caller owns world/entity/user locks; only committed runtime consumes time."""
    if not settings.SPACE_HOSTING_ENABLED:
        raise RuntimeError("Entity hosting is disabled")
    if not isinstance(elapsed_ms, int) or not 0 < elapsed_ms <= STEP_MS or elapsed_ms % 50:
        raise ValueError("invalid hosted duration")
    from space.billing import consume
    return consume(db, entity, elapsed_ms)


def region_chunks(entity, world, margin=3):
    x, z = entity.hosting_anchor
    cx, cz = x // 1600, z // 1600
    return {((cx + dx) % world.width_chunks, (cz + dz) % world.length_chunks)
            for dx in range(-margin, margin + 1) for dz in range(-margin, margin + 1)}


def scene_rows(db, world_id, chunks):
    filters = [and_(models.SpaceWorldEntity.position_x_cm >= cx * 1600,
                    models.SpaceWorldEntity.position_x_cm < (cx + 1) * 1600,
                    models.SpaceWorldEntity.position_z_cm >= cz * 1600,
                    models.SpaceWorldEntity.position_z_cm < (cz + 1) * 1600) for cx, cz in sorted(chunks)]
    return db.query(models.SpaceWorldEntity).filter(
        models.SpaceWorldEntity.world_id == world_id, or_(*filters)
    ).order_by(models.SpaceWorldEntity.id).limit(37).all()


def fingerprint(rows, actors=None):
    # Independently simulated neighbours are collision replicas. Their routine
    # pose commits must not invalidate/starve every other core in the same area.
    # Static edits and the actor's own revision remain transactional fences.
    return [(str(e.id), bytes(e.content_digest).hex() if actors is not None
             and str(e.id) not in actors and e.desired_run_state == 'running'
             else int(e.revision)) for e in rows]


def terrain_revision(db, world_id):
    stream = db.get(models.SpaceWorldEventStream, world_id)
    return int(stream.last_event_id) if stream else 0


def prepare(db, world_id, instance_id, entity_id=None, cpu_ids=None):
    if not settings.SPACE_HOSTING_ENABLED:
        return None
    world = db.query(models.SpaceWorld).filter_by(id=world_id).with_for_update().first()
    if not world or world.status != 1:
        return None
    instant = now()
    lease = db.get(models.SpaceHostingWorker, world_id)
    if lease and lease.instance_id != instance_id and utc(lease.lease_expires_at) > instant:
        return None
    if not lease:
        lease = models.SpaceHostingWorker(world_id=world_id, instance_id=instance_id, epoch=1)
        db.add(lease)
    elif lease.instance_id != instance_id or utc(lease.lease_expires_at) <= instant:
        lease.instance_id = instance_id
        lease.epoch += 1
    lease.lease_expires_at = instant + dt.timedelta(seconds=LEASE_SECONDS)
    if cpu_ids is not None:
        lease.core_cpu_ids = list(cpu_ids[:MAX_HOSTING_CORES])
    query = db.query(models.SpaceWorldEntity).filter_by(world_id=world_id, hosting_enabled=True)
    if entity_id is not None:
        query = query.filter_by(id=entity_id)
    active = query.order_by(models.SpaceWorldEntity.id).limit(1).all()
    funded = []
    for entity in active:
        core = db.get(models.SpaceHostingCore, entity.hosting_core_id) if entity.hosting_core_id is not None else None
        if (not core or str(core.entity_id) != str(entity.id) or str(core.world_id) != world_id
                or core.execution_epoch != entity.execution_epoch
                or core.id >= len(lease.core_cpu_ids) or core.cpu_id != lease.core_cpu_ids[core.id]):
            pause(entity, 'hosting_core_unavailable')
            continue
        core.executor_instance_id = instance_id
        core.lease_expires_at = instant + dt.timedelta(seconds=CORE_LEASE_SECONDS)
        if entity.execution_lease_expires_at and utc(entity.execution_lease_expires_at) > instant:
            continue
        membership = db.get(models.SpaceWorldPlayerProfile, (world_id, entity.execution_user_id))
        if membership is None:
            pause(entity, "world_membership_required")
        elif entity.hosting_remaining_ms == 0 and entity.hosting_budget_remaining < 1:
            pause(entity, "budget_exhausted")
        else:
            if entity.hosting_remaining_ms == 0:
                from space.billing import ready_grant
                if ready_grant(db, entity) is None:
                    continue
            funded.append(entity)
    if not funded:
        db.commit()
        return None
    chunks = set().union(*(region_chunks(e, world) for e in funded))
    rows = scene_rows(db, world_id, chunks)
    scene_valid = True
    try:
        for entity in rows:
            validate_hosted_definition(entity.definition)
    except HTTPException:
        scene_valid = False
    if len(rows) > 36 or not scene_valid:
        for entity in funded:
            pause(entity, "hosting_scene_limit")
        db.commit()
        return None
    by_chunk = {(r.chunk_x, r.chunk_z): r for r in db.query(models.SpaceChunkSnapshot).filter(
        models.SpaceChunkSnapshot.world_id == world_id,
        or_(*[and_(models.SpaceChunkSnapshot.chunk_x == cx, models.SpaceChunkSnapshot.chunk_z == cz) for cx, cz in sorted(chunks)])
    ).all()}
    running = {str(e.id) for e in funded}
    duration_ms = min([STEP_MS] + [int(e.hosting_remaining_ms) for e in funded if e.hosting_remaining_ms > 0])
    payload = {"world_id": world_id, "seed": world.seed,
        "terrain_generator_version": world.terrain_generator_version,
        "steps": duration_ms // 50,
        "epoch": lease.epoch, "terrain_revision": terrain_revision(db, world_id),
        "scene_revision": fingerprint(rows, running),
        "core_id": funded[0].hosting_core_id,
        "execution_epoch": funded[0].execution_epoch,
        "entities": [{"id": str(e.id), "running": str(e.id) in running,
            "definition_base64": base64.b64encode(e.definition).decode(),
            "snapshot": json.loads(e.snapshot) if e.snapshot else None,
            "position": [e.position_x_cm / 100, e.position_y_cm / 100, e.position_z_cm / 100],
            "anchor": [v / 100 for v in e.hosting_anchor] if e.hosting_anchor else None,
            "yaw_quarter_turns": e.yaw_quarter_turns} for e in rows],
        "chunks": [{"chunk_x": cx, "chunk_z": cz, "revision": by_chunk[(cx, cz)].revision if (cx, cz) in by_chunk else 0,
            **terrain._decode_chunk_overlay(by_chunk.get((cx, cz)))} for cx, cz in sorted(chunks)]}
    db.commit()
    return payload


def commit_result(db, world_id, instance_id, payload, result):
    if not settings.SPACE_HOSTING_ENABLED:
        return False
    world = db.query(models.SpaceWorld).filter_by(id=world_id).with_for_update().first()
    lease = db.get(models.SpaceHostingWorker, world_id)
    if not world or world.status != 1 or not lease or lease.instance_id != instance_id or lease.epoch != payload["epoch"] or utc(lease.lease_expires_at) <= now():
        return False
    chunks = {(c["chunk_x"], c["chunk_z"]) for c in payload["chunks"]}
    rows = scene_rows(db, world_id, chunks)
    by_id = {str(e.id): e for e in rows}
    expected = {e["id"] for e in payload["entities"] if e["running"]}
    if fingerprint(rows, expected) != payload["scene_revision"] or terrain_revision(db, world_id) != payload["terrain_revision"]:
        return False
    core = db.get(models.SpaceHostingCore, payload['core_id'])
    if (not core or core.executor_instance_id != instance_id or core.execution_epoch != payload['execution_epoch']
            or str(core.entity_id) not in expected or utc(core.lease_expires_at) <= now()):
        return False
    if result.get("error"):
        result = {"faults": [{"id": eid, "reason": "runtime_error", "message": str(result['error'])[:500]} for eid in expected]}
    if result.get("faults"):
        for fault in result["faults"]:
            if fault["id"] not in expected:
                raise ValueError("invalid fault entity")
            pause(by_id[fault["id"]], fault["reason"][:80])
            by_id[fault["id"]].hosting_error = str(fault.get("message", fault["reason"]))[:500]
        db.commit()
        return True
    if {e["id"] for e in result.get("entities", [])} != expected or len(result["entities"]) != len(expected):
        raise ValueError("invalid runtime result entities")
    owners = sorted({user_id for eid in expected for user_id in
                     (by_id[eid].owner_user_id, by_id[eid].execution_user_id) if user_id})
    users = {u.id: u for u in db.query(models.User).filter(models.User.id.in_(owners)).order_by(models.User.id).populate_existing().all()}
    # Re-check prepaid grants under the world/entity lock before accepting results.
    for eid in sorted(expected):
        entity = by_id[eid]
        if not entity.hosting_enabled:
            return False
        if db.get(models.SpaceWorldPlayerProfile, (world_id, entity.execution_user_id)) is None:
            pause(entity, "world_membership_required")
            db.commit()
            return False
        if entity.hosting_remaining_ms < payload["steps"] * 50:
            from space.billing import ready_grant
            if entity.hosting_budget_remaining < 1 or ready_grant(db, entity) is None:
                return False
    mutations = result.get("mutations", [])
    if len(mutations) > 256:
        raise ValueError("hosting mutation limit")
    for item in result["entities"]:
        entity = by_id[item["id"]]
        if not isinstance(item["elapsed_ms"], int) or not 0 < item["elapsed_ms"] <= payload["steps"] * 50 or item["elapsed_ms"] % 50:
            raise ValueError("invalid elapsed time")
        definition, digest, _ = _decode_entity_definition(item["definition_base64"])
        validate_hosted_definition(definition)
        snapshot = item["snapshot"]
        x, y, z = snapshot["position"]
        position = EntityPosition(x_cm=round(x * 100) % (world.width_chunks * 1600),
                                  y_cm=round(y * 100), z_cm=round(z * 100) % (world.length_chunks * 1600))
        encoded, snapshot_digest = _encode_snapshot(snapshot, world, position)
        _enforce_entity_storage_quota(db, world, users[entity.owner_user_id],
            incoming_bytes=len(definition) + len(encoded), replaced_bytes=entity.size_bytes + entity.snapshot_size_bytes)
        entity.definition, entity.content_digest, entity.size_bytes = definition, digest, len(definition)
        entity.snapshot, entity.snapshot_digest, entity.snapshot_size_bytes = encoded, snapshot_digest, len(encoded)
        entity.position_x_cm, entity.position_y_cm, entity.position_z_cm = position.x_cm, position.y_cm, position.z_cm
        entity.hosting_last_tick_at = now()
        entity.hosting_reason = None
        entity.hosting_error = None
        entity.revision += 1
        entity.updated_at = now()
        charge_time(db, entity, users[entity.execution_user_id], item["elapsed_ms"])
        if item.get("stopped"):
            pause(entity, "script_stopped")
        elif entity.hosting_remaining_ms == 0 and entity.hosting_budget_remaining == 0:
            pause(entity, "budget_exhausted")
        db.flush()  # the next entity's aggregate storage check includes this update
    grouped = {}
    for raw_mutation in mutations:
        mutation = dict(raw_mutation)
        eid = mutation.pop("actor_entity_id")
        if eid not in expected:
            raise ValueError("invalid mutation actor")
        # Commands may only touch the originating entity's reserved neighbourhood.
        allowed = region_chunks(by_id[eid], world)
        x = mutation.get("x", mutation.get("mx", 0) // MICRO_DIVISIONS)
        z = mutation.get("z", mutation.get("mz", 0) // MICRO_DIVISIONS)
        if (x // 16, z // 16) not in allowed:
            raise ValueError("hosting mutation area limit")
        grouped.setdefault(by_id[eid].execution_user_id, []).append(mutation)
    db.flush()
    for owner_id, edits in sorted(grouped.items()):
        terrain._apply_terrain_mutation_batch(None, uuid.UUID(world_id),
            terrain.TerrainMutationBatchRequest(batch_id=uuid.uuid4(), mutations=edits), db, users[owner_id],
            hosted_chunks=chunks, commit=False)
    lease.lease_expires_at = now() + dt.timedelta(seconds=LEASE_SECONDS)
    trajectories = [{"entity_id": item["id"], "execution_epoch": by_id[item["id"]].execution_epoch,
                     "revision": by_id[item["id"]].revision, "poses": item["poses"],
                     "first_sequence": max(0, round(item["snapshot"].get("totalRuntime", 0)*20) - len(item["poses"]) + 1)}
                    for item in result["entities"] if item.get("poses") and by_id[item["id"]].hosting_enabled]
    db.commit()
    if trajectories:
        from routers.space_realtime import publish_hosted_trajectory
        for trajectory in trajectories:
            try:
                publish_hosted_trajectory(world_id, trajectory)
            except Exception:
                log.warning("Committed hosted trajectory could not be published", exc_info=True)
    if mutations:
        from routers.space_realtime import realtime_hub
        realtime_hub.notify_terrain_from_thread(world_id, terrain_revision(db, world_id))
    return True


class NodeRuntime:
    def __init__(self, cpu_id=None):
        self.process = None
        self.cpu_id = cpu_id

    async def close(self):
        if self.process and self.process.returncode is None:
            self.process.kill()
            await self.process.wait()
        self.process = None

    async def step(self, payload):
        if not self.process or self.process.returncode is not None:
            entry = os.getenv("SPACE_HOSTING_RUNTIME_PATH", str(Path(__file__).resolve().parent /
                "runtime/dist/hosting-runtime.mjs"))
            if not Path(entry).is_file():
                raise RuntimeError("hosting runtime is not built; run npm ci and npm run build in space/runtime")
            self.process = await asyncio.create_subprocess_exec(os.getenv("SPACE_HOSTING_NODE", "node"),
                "--max-old-space-size=256", entry, stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, limit=MAX_MESSAGE,
                # Do not forward database/payment/cloud credentials to the simulation process.
                env={k: v for k, v in os.environ.items() if k in {"PATH", "SYSTEMROOT", "TMPDIR"}})
            if self.cpu_id is not None and hasattr(os, 'sched_setaffinity'):
                try:
                    # Bind before sending guest code/input; no unsafe preexec
                    # callback in this multi-threaded coordinator.
                    os.sched_setaffinity(self.process.pid, {self.cpu_id})
                except OSError:
                    await self.close()
                    raise RuntimeError('hosting_core_affinity_failed') from None
        message = json.dumps(payload, separators=(",", ":")).encode() + b"\n"
        if len(message) > MAX_MESSAGE:
            raise ValueError("hosting input too large")
        self.process.stdin.write(message)
        await self.process.stdin.drain()
        response = await self.process.stdout.readline()
        if not response:
            raise RuntimeError("hosting runtime exited")
        return json.loads(response)


class EntityRuntimePool:
    def __init__(self):
        self.runtimes = {}

    async def close(self):
        await asyncio.gather(*(runtime.close() for _epoch, runtime in self.runtimes.values()))
        self.runtimes.clear()

    async def get(self, entity_id, epoch, cpu_id):
        current = self.runtimes.get(entity_id)
        if current and (current[0] != epoch or current[1].cpu_id != cpu_id):
            await current[1].close()
            self.runtimes.pop(entity_id)
        if entity_id not in self.runtimes:
            if len(self.runtimes) >= MAX_HOSTING_CORES:
                raise RuntimeError('hosting_core_capacity_exceeded')
            self.runtimes[entity_id] = (epoch, NodeRuntime(cpu_id))
        return self.runtimes[entity_id][1]


def world_jobs(db, world_id, instance_id, cpu_ids):
    # Acquire/renew coordinator authority even with no funded entities.
    world = db.query(models.SpaceWorld).filter_by(id=world_id).with_for_update().first()
    if not world or world.status != 1 or not settings.SPACE_HOSTING_ENABLED:
        return []
    instant = now()
    worker = db.get(models.SpaceHostingWorker, world_id)
    if worker and worker.instance_id != instance_id and utc(worker.lease_expires_at) > instant:
        return None
    if worker is None:
        worker = models.SpaceHostingWorker(world_id=world_id, instance_id=instance_id, epoch=1)
        db.add(worker)
    elif worker.instance_id != instance_id or utc(worker.lease_expires_at) <= instant:
        worker.instance_id = instance_id
        worker.epoch += 1
    worker.lease_expires_at = instant + dt.timedelta(seconds=LEASE_SECONDS)
    cpu_ids = cpu_ids[:MAX_HOSTING_CORES]
    worker.core_cpu_ids = list(cpu_ids)
    m, c = models.SpaceWorldEntity, models.SpaceHostingCore
    rows = db.query(m.id, m.execution_epoch, m.hosting_core_id, c.cpu_id,
        c.execution_epoch.label('core_epoch'), c.entity_id.label('core_entity_id')).outerjoin(
        c, m.hosting_core_id == c.id).filter(m.world_id == world_id, m.hosting_enabled.is_(True)).limit(MAX_HOSTING_CORES).all()
    jobs = []
    for row in rows:
        if (row.hosting_core_id is None or row.core_entity_id != row.id
                or row.core_epoch != row.execution_epoch or row.hosting_core_id >= len(cpu_ids)
                or row.cpu_id != cpu_ids[row.hosting_core_id]):
            pause(db.get(m, (world_id, row.id)), 'hosting_core_unavailable')
            continue
        jobs.append((str(row.id), row.execution_epoch, row.hosting_core_id, row.cpu_id))
    if jobs:
        db.query(c).filter(c.world_id == world_id, c.id.in_([job[2] for job in jobs])).update(
            {c.lease_expires_at: instant + dt.timedelta(seconds=CORE_LEASE_SECONDS)}, synchronize_session=False)
    db.commit()
    return jobs


def release_drained_cores(db, world_id, instance_id, live_ids):
    world = db.query(models.SpaceWorld).filter_by(id=world_id).with_for_update().first()
    if not world:
        return
    worker = db.get(models.SpaceHostingWorker, world_id)
    if not worker or worker.instance_id != instance_id or utc(worker.lease_expires_at) <= now():
        return
    for core in db.query(models.SpaceHostingCore).filter_by(world_id=world_id).with_for_update().all():
        entity = db.get(models.SpaceWorldEntity, (world_id, core.entity_id)) if core.entity_id else None
        safe = core.executor_instance_id in (None, instance_id) or (core.lease_expires_at and utc(core.lease_expires_at) <= now())
        if safe and str(core.entity_id) not in live_ids and (not entity or not entity.hosting_enabled
                or entity.hosting_core_id != core.id or entity.execution_epoch != core.execution_epoch):
            clear_core(core)
    db.commit()


async def run_world(world_id, cpu_ids=None):
    instance_id = str(uuid.uuid4())
    cpu_ids = available_cpu_ids() if cpu_ids is None else cpu_ids
    pool = EntityRuntimePool()

    async def run_entity(entity_id, epoch, core_id, cpu_id):
        started = time.monotonic()
        payload = None
        runtime = await pool.get(entity_id, epoch, cpu_id)
        try:
            def read():
                with SessionLocal() as db:
                    return prepare(db, world_id, instance_id, entity_id, cpu_ids)
            payload = await asyncio.to_thread(read)
            if payload:
                result = await asyncio.wait_for(runtime.step(payload), timeout=10)
                def commit():
                    with SessionLocal() as db:
                        return commit_result(db, world_id, instance_id, payload, result)
                await asyncio.to_thread(commit)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            await runtime.close()
            log.exception('Hosted entity %s failed', entity_id)
            if payload:
                def fail():
                    with SessionLocal() as db:
                        commit_result(db, world_id, instance_id, payload, {'faults': [
                            {'id': entity_id, 'reason': str(error)[:80] or 'runtime_error'}]})
                await asyncio.to_thread(fail)
        await asyncio.sleep(max(0.05, (payload['steps'] * 0.05 if payload else 1) - (time.monotonic() - started)))

    tasks = {}

    async def stop_tasks():
        for task in tasks.values():
            task.cancel()
        await asyncio.gather(*tasks.values(), return_exceptions=True)
        tasks.clear()
        await pool.close()

    try:
        while True:
            def read_jobs():
                with SessionLocal() as db:
                    return world_jobs(db, world_id, instance_id, cpu_ids)
            try:
                jobs = await asyncio.to_thread(read_jobs)
            except Exception:
                # Lose compute authority conservatively during DB trouble;
                # keep this coordinator alive so an outage can recover.
                log.exception('Hosting coordinator could not renew its lease')
                await stop_tasks()
                await asyncio.sleep(1)
                continue
            if jobs is None:  # Another live coordinator owns the world.
                await stop_tasks()
                await asyncio.sleep(1)
                continue
            live = {entity_id for entity_id, _epoch, _core_id, _cpu_id in jobs}
            for entity_id in list(pool.runtimes):
                if entity_id not in live:
                    task = tasks.pop(entity_id, None)
                    if task and not task.done():
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
                    await pool.runtimes.pop(entity_id)[1].close()
            def drain():
                with SessionLocal() as db:
                    release_drained_cores(db, world_id, instance_id, live)
            try:
                await asyncio.to_thread(drain)
            except Exception:
                log.exception('Hosting coordinator could not drain stopped cores')
                await stop_tasks()
                await asyncio.sleep(1)
                continue
            for job in jobs:
                task = tasks.get(job[0])
                if task is None or task.done():
                    if task and not task.cancelled() and task.exception():
                        log.error('Hosted task failed: %s', task.exception())
                    tasks[job[0]] = asyncio.create_task(run_entity(*job))
            await asyncio.sleep(0.25)
    finally:
        await stop_tasks()


async def main():
    if not settings.SPACE_HOSTING_ENABLED:
        raise RuntimeError("Entity hosting is disabled; enable SPACE_HOSTING_ENABLED only after deployment validation")
    cpu_ids = available_cpu_ids()
    if not cpu_ids:
        raise RuntimeError('No dedicated CPU cores are available for hosting')
    probe = NodeRuntime(cpu_ids[0])
    try:
        if not (await asyncio.wait_for(probe.step({'probe': True}), timeout=10)).get('ready'):
            raise RuntimeError('Hosting runtime probe failed')
    finally:
        await probe.close()
    # One global CPU pool, shared by all world coordinators in this process.
    requested = requested_world_ids()
    with SessionLocal() as db:
        initialize_core_pool(db)
        db.commit()
        ids = [str(w.id) for w in db.query(models.SpaceWorld).filter(
            models.SpaceWorld.status == 1, models.SpaceWorld.id.in_([str(uuid.UUID(s.strip())) for s in requested])
        ).limit(4).all()]
    if not ids:
        raise RuntimeError("Bootstrap a Space world before starting the hosting worker")
    jobs = [run_world(world_id, cpu_ids) for world_id in ids]
    from space.billing import run as run_billing
    jobs.append(run_billing(ids))
    await asyncio.gather(*jobs)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
