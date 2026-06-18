"""add ttt stat milestone eligibility

Revision ID: e1f2a3b4c5d6
Revises: a6d4e8f0b9c2
Create Date: 2026-06-18 16:15:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "e1f2a3b4c5d6"
down_revision: Union[str, Sequence[str], None] = "a6d4e8f0b9c2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "quiz_ttt_stat_milestone_players",
        sa.Column("milestone_key", sa.String(length=64), nullable=False),
        sa.Column("player_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["player_id"], ["players.id"]),
        sa.PrimaryKeyConstraint(
            "milestone_key",
            "player_id",
            name="pk_quiz_ttt_stat_milestone_players",
        ),
    )
    op.create_index(
        "ix_quiz_ttt_stat_milestone_players_player_id",
        "quiz_ttt_stat_milestone_players",
        ["player_id"],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        "ix_quiz_ttt_stat_milestone_players_player_id",
        table_name="quiz_ttt_stat_milestone_players",
    )
    op.drop_table("quiz_ttt_stat_milestone_players")
