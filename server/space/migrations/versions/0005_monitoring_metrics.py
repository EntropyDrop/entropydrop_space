"""Add space_monitoring_metrics table.

Revision ID: space_0005
Revises: space_0004
Create Date: 2026-09-14
"""
from alembic import op
import sqlalchemy as sa

revision = 'space_0005'
down_revision = 'space_0004'
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if 'space_monitoring_metrics' not in inspector.get_table_names():
        op.create_table(
            'space_monitoring_metrics',
            sa.Column('minute_bucket', sa.BigInteger(), primary_key=True, nullable=False),
            sa.Column('timestamp', sa.DateTime(timezone=True), nullable=False, index=True),
            sa.Column('online_users', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('cpu_percent', sa.Float(), nullable=False, server_default='0.0'),
            sa.Column('memory_percent', sa.Float(), nullable=False, server_default='0.0'),
            sa.Column('memory_used_mb', sa.Float(), nullable=False, server_default='0.0'),
            sa.Column('memory_total_mb', sa.Float(), nullable=False, server_default='0.0'),
            sa.Column('load_1m', sa.Float(), nullable=False, server_default='0.0'),
            sa.Column('avg_latency_ms', sa.Float(), nullable=True),
            sa.Column('latency_samples', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        )


def downgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if 'space_monitoring_metrics' in inspector.get_table_names():
        op.drop_table('space_monitoring_metrics')
