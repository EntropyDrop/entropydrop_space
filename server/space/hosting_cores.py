"""Dedicated physical CPU selection and durable, global hosting reservations."""
import datetime as dt
import os
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import or_
from space import models

MAX_HOSTING_CORES = 128
CORE_LEASE_SECONDS = 25  # Longer than world lease + bounded IPC timeout (15 + 10).


def utc(value):
    return value.replace(tzinfo=dt.timezone.utc) if value and value.tzinfo is None else value


def cpu_quota_limits():
    """Honor both cgroup versions, including systemd/ancestor limits."""
    locations = {(Path('/sys/fs/cgroup'), Path('/sys/fs/cgroup'), 2),
                 (Path('/sys/fs/cgroup/cpu'), Path('/sys/fs/cgroup/cpu'), 1),
                 (Path('/sys/fs/cgroup/cpu,cpuacct'), Path('/sys/fs/cgroup/cpu,cpuacct'), 1)}
    try:
        for line in Path('/proc/self/cgroup').read_text().splitlines():
            _identifier, controllers, relative = line.split(':', 2)
            tail = Path(relative.lstrip('/'))
            if '..' in tail.parts:
                continue  # Some container namespaces report an outside parent.
            if not controllers:
                root = Path('/sys/fs/cgroup')
                locations.add((root, root / tail, 2))
            elif 'cpu' in controllers.split(','):
                for name in ('cpu', 'cpu,cpuacct'):
                    root = Path('/sys/fs/cgroup') / name
                    locations.add((root, root / tail, 1))
    except (OSError, ValueError):
        pass
    limits = []
    for root, current, version in locations:
        while True:
            try:
                if version == 2:
                    quota, period = current.joinpath('cpu.max').read_text().split()
                    if quota != 'max':
                        limits.append(max(0, int(quota) // int(period)))
                else:
                    quota = int(current.joinpath('cpu.cfs_quota_us').read_text())
                    period = int(current.joinpath('cpu.cfs_period_us').read_text())
                    if quota >= 0:
                        limits.append(max(0, quota // period))
            except (OSError, ValueError, ZeroDivisionError):
                pass
            if current == root:
                break
            current = current.parent
    return limits


def available_cpu_ids():
    allowed = sorted(os.sched_getaffinity(0)) if hasattr(os, 'sched_getaffinity') else list(range(os.cpu_count() or 1))
    # SMT siblings are one physical core, not two independent hosting cores.
    selected, seen = [], set()
    for cpu in allowed:
        topology = Path(f'/sys/devices/system/cpu/cpu{cpu}/topology')
        try:
            identity = (topology.joinpath('physical_package_id').read_text().strip(),
                        topology.joinpath('core_id').read_text().strip())
        except OSError:
            identity = ('cpu', cpu)  # Non-Linux development has no hard affinity.
        if identity not in seen:
            selected.append(cpu)
            seen.add(identity)
    # Respect container CPU-time quotas as well as its cpuset.
    quotas = cpu_quota_limits()
    if quotas:
        selected = selected[:min(quotas)]
    return selected[:MAX_HOSTING_CORES]


def initialize_core_pool(db):
    """For bootstrap/tests; production migration creates the same fixed rows."""
    existing = {row[0] for row in db.query(models.SpaceHostingCore.id).all()}
    db.add_all(models.SpaceHostingCore(id=index) for index in range(MAX_HOSTING_CORES) if index not in existing)
    db.flush()


def clear_core(core):
    core.world_id = core.entity_id = core.cpu_id = core.executor_instance_id = core.lease_expires_at = None
    core.execution_epoch += 1


def capacity(db, worker, *, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    ids = worker.core_cpu_ids[:MAX_HOSTING_CORES] if worker and utc(worker.lease_expires_at) > now else []
    used = db.query(models.SpaceHostingCore).filter(models.SpaceHostingCore.id < len(ids),
        models.SpaceHostingCore.entity_id.isnot(None), models.SpaceHostingCore.lease_expires_at > now).count()
    return {'limit': MAX_HOSTING_CORES, 'total': len(ids), 'used': used, 'available': max(0, len(ids) - used)}


def reserve_core(db, entity, worker, *, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    ids = worker.core_cpu_ids[:MAX_HOSTING_CORES]
    if not ids:
        raise HTTPException(503, detail={'code': 'HOSTING_CORE_UNAVAILABLE',
            'message': 'No dedicated hosting cores are available on this server.', 'limit': MAX_HOSTING_CORES})
    current = db.query(models.SpaceHostingCore).filter_by(world_id=entity.world_id, entity_id=entity.id).with_for_update().first()
    if current is not None:
        if current.id >= len(ids) or current.cpu_id != ids[current.id]:
            raise HTTPException(503, detail={'code': 'HOSTING_CORE_UNAVAILABLE',
                'message': 'The assigned core is being drained. Try again shortly.'})
        return current
    core = db.query(models.SpaceHostingCore).filter(models.SpaceHostingCore.id < len(ids),
        or_(models.SpaceHostingCore.entity_id.is_(None), models.SpaceHostingCore.lease_expires_at <= now)
    ).order_by(models.SpaceHostingCore.id).with_for_update(skip_locked=True).first()
    if core is None:
        raise HTTPException(429, detail={'code': 'HOSTING_CORES_FULL',
            'message': 'All hosting cores are busy. Stop a hosted entity or try again later.', **capacity(db, worker, now=now)})
    core.world_id, core.entity_id, core.cpu_id = entity.world_id, entity.id, ids[core.id]
    core.executor_instance_id = None
    core.lease_expires_at = now + dt.timedelta(seconds=CORE_LEASE_SECONDS)
    return core
