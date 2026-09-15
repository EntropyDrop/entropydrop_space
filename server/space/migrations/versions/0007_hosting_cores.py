"""Fixed 128-core hosting pool and per-entity process reservations."""
from alembic import op
import sqlalchemy as sa

revision = 'space_0007'
down_revision = 'space_0006'
branch_labels = None
depends_on = None


def upgrade():
    table = op.create_table('space_hosting_cores',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('world_id', sa.Uuid(as_uuid=False), nullable=True),
        sa.Column('entity_id', sa.Uuid(as_uuid=False), nullable=True),
        sa.Column('cpu_id', sa.Integer(), nullable=True),
        sa.Column('execution_epoch', sa.BigInteger(), nullable=False, server_default='0'),
        sa.Column('executor_instance_id', sa.Uuid(as_uuid=False), nullable=True),
        sa.Column('lease_expires_at', sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint('id BETWEEN 0 AND 127', name='ck_space_hosting_core_id'),
        sa.UniqueConstraint('world_id', 'entity_id', name='uq_space_hosting_core_entity'))
    op.bulk_insert(table, [{'id': index} for index in range(128)])
    with op.batch_alter_table('space_world_entities') as batch:
        batch.add_column(sa.Column('hosting_core_id', sa.Integer(), nullable=True))
        batch.create_foreign_key('fk_space_entity_hosting_core', 'space_hosting_cores', ['hosting_core_id'], ['id'], ondelete='RESTRICT')
    with op.batch_alter_table('space_hosting_workers') as batch:
        batch.add_column(sa.Column('core_cpu_ids', sa.JSON(), nullable=False, server_default='[]'))
    # Upgrade only while the old worker is stopped. Preserve prepaid time, but
    # require explicit reactivation on a worker that advertises dedicated cores.
    op.execute(sa.text("UPDATE space_world_entities SET hosting_enabled = false, "
        "desired_run_state = 'stopped', hosting_budget_remaining = 0, hosting_reason = 'core_pool_upgrade', "
        "execution_epoch = execution_epoch + 1, revision = revision + 1 WHERE hosting_enabled"))


def downgrade():
    if op.get_bind().execute(sa.text('SELECT COUNT(*) FROM space_hosting_cores WHERE entity_id IS NOT NULL')).scalar():
        raise RuntimeError('Stop hosting and drain core reservations before downgrading.')
    with op.batch_alter_table('space_hosting_workers') as batch:
        batch.drop_column('core_cpu_ids')
    with op.batch_alter_table('space_world_entities') as batch:
        batch.drop_constraint('fk_space_entity_hosting_core', type_='foreignkey')
        batch.drop_column('hosting_core_id')
    op.drop_table('space_hosting_cores')
