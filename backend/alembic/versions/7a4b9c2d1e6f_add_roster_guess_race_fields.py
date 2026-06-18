"""add roster guess race fields

Revision ID: 7a4b9c2d1e6f
Revises: b5a7e9c2d4f1
Create Date: 2026-06-18 02:05:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "7a4b9c2d1e6f"
down_revision: Union[str, Sequence[str], None] = "b5a7e9c2d4f1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "roster_guess_games",
        sa.Column("is_race", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.add_column(
        "roster_guess_games",
        sa.Column("is_public", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.add_column(
        "roster_guess_games",
        sa.Column("preset", sa.String(length=128), nullable=True),
    )
    op.add_column(
        "roster_guess_games",
        sa.Column("race_round_seconds", sa.Integer(), nullable=True),
    )
    op.add_column(
        "roster_guess_games",
        sa.Column("race_reveal_seconds", sa.Integer(), nullable=True),
    )
    op.add_column(
        "roster_guess_rounds",
        sa.Column("completed_at", sa.DateTime(), nullable=True),
    )
    op.create_index(
        "ix_roster_guess_games_matchmaking_pool",
        "roster_guess_games",
        ["is_race", "is_public", "status", "preset", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        "ix_roster_guess_games_matchmaking_pool",
        table_name="roster_guess_games",
    )
    op.drop_column("roster_guess_rounds", "completed_at")
    op.drop_column("roster_guess_games", "race_reveal_seconds")
    op.drop_column("roster_guess_games", "race_round_seconds")
    op.drop_column("roster_guess_games", "preset")
    op.drop_column("roster_guess_games", "is_public")
    op.drop_column("roster_guess_games", "is_race")
