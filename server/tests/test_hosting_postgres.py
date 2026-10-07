"""Real lock regression: expensive hosted encoding must allow independent writers."""
import base64
import datetime as dt
import hashlib
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from config import settings
from space import models, hosting_worker as worker
from space.inventory_codec import encode_inventory_resource
from routers.space import _require_world_membership
from tests.test_space_entities import _entity
from tests.test_surface_postgres import postgres


@pytest.mark.parametrize('phase', ['prepare', 'invalid_prepare', 'result'])
def test_hosted_payload_work_releases_world_lock_and_fences_new_edits(postgres, monkeypatch, phase):
    engine, world_id = postgres
    entity_id, instance_id = str(uuid.uuid4()), str(uuid.uuid4())
    definition = encode_inventory_resource('entity', _entity('Hosted lock test'))
    monkeypatch.setattr(settings, 'SPACE_HOSTING_ENABLED', True)
    with Session(engine) as db:
        db.add(models.SpaceHostingCore(id=0, world_id=world_id, entity_id=entity_id, cpu_id=2, execution_epoch=1))
        db.flush()
        db.add(models.SpaceWorldEntity(world_id=world_id, id=entity_id, owner_user_id='lock-user',
            execution_user_id='lock-user', name='Hosted', definition=definition, size_bytes=len(definition),
            content_digest=hashlib.sha256(definition).digest(), position_x_cm=100, position_y_cm=2000,
            position_z_cm=100, create_operation_id=str(uuid.uuid4()), create_request_digest=b'r' * 32,
            execution_mode='hosted', hosting_enabled=True, hosting_core_id=0, hosting_anchor=[100, 100],
            hosting_remaining_ms=12_000, execution_epoch=1))
        db.add(models.SpaceHostingWorker(world_id=world_id, instance_id=instance_id, epoch=1, core_cpu_ids=[2],
            lease_expires_at=dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=60)))
        db.commit()
        payload = worker.prepare(db, world_id, instance_id, entity_id, [2]) if phase == 'result' else None
    entered, release = threading.Event(), threading.Event()
    validate = worker.validate_hosted_definition
    def slow_validation(value):
        entered.set()
        assert release.wait(timeout=10)
        if phase == 'invalid_prepare':
            raise HTTPException(422, detail='invalid old scene')
        return validate(value)
    monkeypatch.setattr(worker, 'validate_hosted_definition', slow_validation)
    def run():
        with Session(engine) as db:
            if phase != 'result':
                return worker.prepare(db, world_id, instance_id, entity_id, [2])
            result = {'entities': [{'id': entity_id, 'elapsed_ms': 50,
                'definition_base64': base64.b64encode(definition).decode(),
                'snapshot': {'position': [1, 20, 1], 'constructorOrigin': [1, 20, 1], 'quaternion': [0, 0, 0, 1]}}]}
            return worker.commit_result(db, world_id, instance_id, payload, result)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(run)
        try:
            assert entered.wait(timeout=10)
            with Session(engine) as writer:
                writer.execute(text("SET LOCAL lock_timeout = '300ms'"))
                _require_world_membership(writer, world_id, SimpleNamespace(id='lock-user'), for_update=True)
                entity = writer.get(models.SpaceWorldEntity, (world_id, entity_id))
                entity.revision += 1
                writer.commit()
        finally:
            release.set()
        result = pending.result(timeout=10)
    with Session(engine) as db:
        entity = db.get(models.SpaceWorldEntity, (world_id, entity_id))
        assert entity.hosting_enabled and entity.hosting_remaining_ms == 12_000
        if phase == 'result':
            assert result is False
        elif phase == 'invalid_prepare':
            assert result is None
        else:
            assert worker.commit_result(db, world_id, instance_id, result, {'error': 'late runtime'}) is False
