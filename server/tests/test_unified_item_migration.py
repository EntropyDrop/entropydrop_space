import importlib

from alembic.migration import MigrationContext
from alembic.operations import Operations
import pytest
import sqlalchemy as sa


def test_item_migration_preserves_legacy_objects_and_expands_kind_constraint(monkeypatch):
    migration = importlib.import_module('space.migrations.versions.0010_unified_items')
    engine = sa.create_engine('sqlite:///:memory:')
    metadata = sa.MetaData()
    resources = sa.Table('space_market_resources', metadata,
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('kind', sa.String(16), nullable=False),
        sa.Column('digest', sa.String(64), nullable=False),
        sa.Column('object_key', sa.String(256), nullable=False),
        sa.CheckConstraint("kind IN ('blockset', 'entity', 'colorset')",
            name='ck_space_market_resource_kind'))
    metadata.create_all(engine)
    with engine.begin() as connection:
        original = [
            {'id': index, 'kind': kind, 'digest': f'digest-{kind}', 'object_key': f'market/{kind}.edpb'}
            for index, kind in enumerate(('blockset', 'entity', 'colorset'), 1)
        ]
        connection.execute(resources.insert(), original)
        monkeypatch.setattr(migration, 'op', Operations(MigrationContext.configure(connection)))
        migration.upgrade()
        preserved = connection.execute(sa.select(resources).order_by(resources.c.id)).mappings().all()
        assert [dict(row) for row in preserved] == original
        connection.execute(resources.insert(),
            {'id': 4, 'kind': 'item', 'digest': 'new-item', 'object_key': 'market/item.edpb'})
        with pytest.raises(sa.exc.IntegrityError):
            with connection.begin_nested():
                connection.execute(resources.insert(),
                    {'id': 5, 'kind': 'unknown', 'digest': 'invalid', 'object_key': 'invalid'})
        assert connection.execute(sa.select(sa.func.count()).select_from(resources)).scalar_one() == 4
    engine.dispose()
