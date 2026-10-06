"""Claim individual surface zones without holding world locks during generation."""
from alembic import op
import sqlalchemy as sa

revision = 'space_0012'
down_revision = 'space_0011'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'space_surface_generation_leases',
        sa.Column('world_id', sa.Uuid(as_uuid=False), sa.ForeignKey('worlds.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('zone_x', sa.SmallInteger(), primary_key=True),
        sa.Column('zone_z', sa.SmallInteger(), primary_key=True),
        sa.Column('token', sa.String(36), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    )


def downgrade():
    op.drop_table('space_surface_generation_leases')
