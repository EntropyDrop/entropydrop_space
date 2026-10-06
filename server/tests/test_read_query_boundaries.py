import hashlib
import uuid

from sqlalchemy import event
from sqlalchemy.dialects import postgresql

from space.auth import get_current_user
from space.main import app
from space import models
from routers.space import _require_world_membership
from tests.test_space_entities import _user


def test_membership_reads_do_not_request_world_locks_but_mutations_do(db):
    owner = _user(db, 'read-owner')
    world = models.SpaceWorld(seed=1)
    db.add(world)
    db.flush()
    world_id = world.id
    db.add(models.SpaceWorldPlayerProfile(world_id=world_id, user_id=owner.id))
    db.commit()
    statements = []
    def capture(state):
        statements.append(str(state.statement.compile(dialect=postgresql.dialect())))
    event.listen(db, 'do_orm_execute', capture)
    try:
        _require_world_membership(db, world_id, owner)
        assert not any('FOR UPDATE' in query for query in statements)
        statements.clear()
        _require_world_membership(db, world_id, owner, for_update=True)
        assert any('FROM worlds' in query and 'FOR UPDATE' in query for query in statements)
    finally:
        event.remove(db, 'do_orm_execute', capture)


def test_aoi_selects_metadata_without_blob_fetches_or_per_entity_queries(client, db):
    owner = _user(db, 'aoi-owner')
    app.dependency_overrides[get_current_user] = lambda: owner
    world_id = client.post('/space/api/v2/bootstrap').json()['world']['id']
    for index in range(6):
        snapshot = b'{"state": 1}' if index % 2 else None
        db.add(models.SpaceWorldEntity(world_id=world_id, id=str(uuid.uuid4()), owner_user_id=owner.id,
            name=f'Entity {index}', schema_version=8, definition=b'x' * 1024 * 1024,
            content_digest=b'd' * 32, size_bytes=1024 * 1024, snapshot=snapshot,
            snapshot_digest=hashlib.sha256(snapshot).digest() if snapshot else None,
            snapshot_size_bytes=len(snapshot or b''), position_x_cm=1000 + index,
            position_y_cm=2000, position_z_cm=1000, create_operation_id=str(uuid.uuid4()),
            create_request_digest=b'r' * 32))
    db.commit()
    db.expire_all()
    queries = []
    def capture(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith('SELECT') and 'FROM space_world_entities' in statement:
            queries.append(statement)
    engine = db.get_bind()
    event.listen(engine, 'before_cursor_execute', capture)
    try:
        result = client.get(f'/space/api/v2/worlds/{world_id}/entities', params={
            'center_x_cm': 1000, 'center_z_cm': 1000, 'radius_cm': 2000,
        })
    finally:
        event.remove(engine, 'before_cursor_execute', capture)
    assert result.status_code == 200, result.text
    assert len(result.json()['items']) == 6
    assert sum(item['snapshot_url'] is not None for item in result.json()['items']) == 3
    assert len(queries) == 1
    projection = queries[0].split('FROM')[0]
    assert 'space_world_entities.definition' not in projection
    assert 'space_world_entities.snapshot AS' not in projection
    assert 'space_world_entities.snapshot IS NOT NULL' in projection
