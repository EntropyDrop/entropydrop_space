"""Admit unified Item resources while retaining legacy market objects."""
from alembic import op

revision = "space_0010"
down_revision = "space_0009"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("space_market_resources") as batch:
        batch.drop_constraint("ck_space_market_resource_kind", type_="check")
        batch.create_check_constraint(
            "ck_space_market_resource_kind", "kind IN ('item', 'blockset', 'entity', 'colorset')"
        )


def downgrade():
    raise RuntimeError("Unified Item resources require the updated market contract; restore the pre-release backup")
