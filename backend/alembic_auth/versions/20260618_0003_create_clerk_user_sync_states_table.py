"""create clerk user sync states table

Revision ID: 20260618_0003
Revises: 20260617_0002
Create Date: 2026-06-18 00:20:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260618_0003"
down_revision: Union[str, Sequence[str], None] = "20260617_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "clerk_user_sync_states",
        sa.Column("clerk_user_key", sa.String(length=64), nullable=False),
        sa.Column("last_event_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("clerk_user_key"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("clerk_user_sync_states")
