"""add guest_id to quiz games

Revision ID: b99776a43365
Revises: 5f4a3b2c1d0e
Create Date: 2026-06-17 14:09:53.676579

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b99776a43365'
down_revision: Union[str, Sequence[str], None] = '5f4a3b2c1d0e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    for table in ("quiz_ttt_games", "roster_guess_games", "career_quiz_games"):
        op.add_column(table, sa.Column("player1_guest_id", sa.String(64), nullable=True))
        op.add_column(table, sa.Column("player2_guest_id", sa.String(64), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    for table in ("quiz_ttt_games", "roster_guess_games", "career_quiz_games"):
        op.drop_column(table, "player2_guest_id")
        op.drop_column(table, "player1_guest_id")
