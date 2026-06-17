"""create user guest ids table

Revision ID: 20260617_0002
Revises: 20260617_0001
Create Date: 2026-06-17 23:50:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260617_0002"
down_revision: Union[str, Sequence[str], None] = "20260617_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "user_guest_ids",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("guest_id", sa.String(length=64), nullable=False),
        sa.Column("linked_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "guest_id"),
        sa.UniqueConstraint("guest_id", name="uq_user_guest_ids_guest_id"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("user_guest_ids")
