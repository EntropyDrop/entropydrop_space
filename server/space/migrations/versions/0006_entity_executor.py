"""Separate entity creator attribution from the execution holder account."""
from alembic import op
import sqlalchemy as sa

revision = 'space_0006'
down_revision = 'space_0005'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('space_world_entities') as batch:
        batch.add_column(sa.Column('execution_user_id', sa.String(16), nullable=True))
        batch.create_foreign_key('fk_space_entity_execution_user', 'space_accounts',
                                 ['execution_user_id'], ['id'], ondelete='RESTRICT')
    # Earlier releases allowed only the creator to claim or purchase hosting.
    op.execute(sa.text("UPDATE space_world_entities SET execution_user_id = owner_user_id "
                       "WHERE execution_instance_id IS NOT NULL OR execution_mode = 'hosted'"))


def downgrade():
    if op.get_bind().execute(sa.text("SELECT COUNT(*) FROM space_world_entities "
            "WHERE execution_mode = 'hosted' AND execution_user_id <> owner_user_id")).scalar():
        raise RuntimeError('Release non-creator hosting to browser mode before downgrading.')
    # The old authorization model cannot safely interpret another user's lease.
    op.execute(sa.text("UPDATE space_world_entities SET execution_instance_id = NULL, "
                       "execution_lease_expires_at = NULL, execution_epoch = execution_epoch + 1 "
                       "WHERE execution_user_id IS NOT NULL AND execution_user_id <> owner_user_id"))
    with op.batch_alter_table('space_world_entities') as batch:
        batch.drop_constraint('fk_space_entity_execution_user', type_='foreignkey')
        batch.drop_column('execution_user_id')
