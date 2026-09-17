"""Precomputed coarse surface levels; existing fine snapshots remain readable."""
from alembic import op
import sqlalchemy as sa

revision = 'space_0008'
down_revision = 'space_0007'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('space_surface_zone_snapshots', sa.Column('lod_manifest', sa.JSON(), nullable=True))
    op.add_column('space_surface_zone_snapshots', sa.Column('lod_payload', sa.LargeBinary(), nullable=True))


def downgrade():
    op.drop_column('space_surface_zone_snapshots', 'lod_payload')
    op.drop_column('space_surface_zone_snapshots', 'lod_manifest')
