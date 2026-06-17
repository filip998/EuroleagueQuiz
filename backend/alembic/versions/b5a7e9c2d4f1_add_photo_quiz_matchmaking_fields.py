"""add photo quiz matchmaking fields

Revision ID: b5a7e9c2d4f1
Revises: 94d31f2a67b8
Create Date: 2026-06-17 19:20:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "b5a7e9c2d4f1"
down_revision: Union[str, Sequence[str], None] = "94d31f2a67b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "photo_quiz_games",
        sa.Column("is_public", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.add_column(
        "photo_quiz_games",
        sa.Column("preset", sa.String(length=128), nullable=True),
    )
    op.create_index(
        "ix_photo_quiz_games_matchmaking_pool",
        "photo_quiz_games",
        ["is_public", "status", "preset", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_photo_quiz_games_matchmaking_pool", table_name="photo_quiz_games")
    op.drop_column("photo_quiz_games", "preset")
    op.drop_column("photo_quiz_games", "is_public")
