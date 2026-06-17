"""add matchmaking fields to ttt games

Revision ID: d4f2b8c9a1e0
Revises: b99776a43365
Create Date: 2026-06-17 14:50:30.797000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "d4f2b8c9a1e0"
down_revision: Union[str, Sequence[str], None] = "b99776a43365"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "quiz_ttt_games",
        sa.Column("is_public", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.add_column(
        "quiz_ttt_games",
        sa.Column("preset", sa.String(length=128), nullable=True),
    )
    op.create_index(
        "ix_quiz_ttt_games_matchmaking_pool",
        "quiz_ttt_games",
        ["is_public", "status", "preset", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_quiz_ttt_games_matchmaking_pool", table_name="quiz_ttt_games")
    op.drop_column("quiz_ttt_games", "preset")
    op.drop_column("quiz_ttt_games", "is_public")
