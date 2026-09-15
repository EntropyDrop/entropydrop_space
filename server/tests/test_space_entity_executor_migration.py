import importlib

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


def test_executor_migration_preserves_existing_creator_leases_and_hosting(monkeypatch):
    migration = importlib.import_module('space.migrations.versions.0006_entity_executor')
    engine = sa.create_engine('sqlite:///:memory:')
    metadata = sa.MetaData()
    accounts = sa.Table('space_accounts', metadata, sa.Column('id', sa.String(16), primary_key=True))
    entities = sa.Table('space_world_entities', metadata,
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('owner_user_id', sa.String(16), nullable=False),
        sa.Column('execution_instance_id', sa.String(36)),
        sa.Column('execution_lease_expires_at', sa.DateTime),
        sa.Column('execution_epoch', sa.Integer, nullable=False),
        sa.Column('execution_mode', sa.String(16), nullable=False))
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(accounts.insert(), [{'id': 'author'}, {'id': 'operator'}])
        connection.execute(entities.insert(), [
            {'id': 1, 'owner_user_id': 'author', 'execution_instance_id': 'lease', 'execution_epoch': 3, 'execution_mode': 'browser'},
            {'id': 2, 'owner_user_id': 'author', 'execution_instance_id': None, 'execution_epoch': 4, 'execution_mode': 'hosted'},
            {'id': 3, 'owner_user_id': 'author', 'execution_instance_id': None, 'execution_epoch': 5, 'execution_mode': 'browser'},
        ])
        monkeypatch.setattr(migration, 'op', Operations(MigrationContext.configure(connection)))
        migration.upgrade()
        rows = connection.execute(sa.text('SELECT execution_user_id FROM space_world_entities ORDER BY id')).scalars().all()
        assert rows == ['author', 'author', None]
        assert sa.inspect(connection).get_foreign_keys('space_world_entities')[0]['referred_table'] == 'space_accounts'
        connection.execute(sa.text("UPDATE space_world_entities SET execution_user_id = 'operator' WHERE id = 1"))
        migration.downgrade()
        row = connection.execute(sa.text('SELECT execution_instance_id, execution_epoch FROM space_world_entities WHERE id = 1')).one()
        assert row == (None, 4), 'old release must not mistake a non-creator holder for its creator'
        assert 'execution_user_id' not in {column['name'] for column in sa.inspect(connection).get_columns('space_world_entities')}
    engine.dispose()
