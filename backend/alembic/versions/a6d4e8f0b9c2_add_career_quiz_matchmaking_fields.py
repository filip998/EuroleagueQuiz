"""add career quiz matchmaking fields

Revision ID: a6d4e8f0b9c2
Revises: 7a4b9c2d1e6f
Create Date: 2026-06-18 04:55:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "a6d4e8f0b9c2"
down_revision: Union[str, Sequence[str], None] = "7a4b9c2d1e6f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "career_quiz_games",
        sa.Column("is_public", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.add_column(
        "career_quiz_games",
        sa.Column("preset", sa.String(length=128), nullable=True),
    )
    op.create_index(
        "ix_career_quiz_games_matchmaking_pool",
        "career_quiz_games",
        ["is_public", "status", "preset", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        "ix_career_quiz_games_matchmaking_pool",
        table_name="career_quiz_games",
    )
    op.drop_column("career_quiz_games", "preset")
    op.drop_column("career_quiz_games", "is_public")
