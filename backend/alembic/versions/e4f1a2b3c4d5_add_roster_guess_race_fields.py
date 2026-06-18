"""add roster guess race fields

Revision ID: e4f1a2b3c4d5
Revises: b5a7e9c2d4f1
Create Date: 2026-06-18 03:10:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "e4f1a2b3c4d5"
down_revision: Union[str, Sequence[str], None] = "b5a7e9c2d4f1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "roster_guess_games",
        sa.Column(
            "game_type",
            sa.String(),
            server_default="classic",
            nullable=False,
        ),
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
        sa.Column("round_seconds", sa.Integer(), nullable=True),
    )
    op.add_column(
        "roster_guess_games",
        sa.Column("reveal_seconds", sa.Integer(), nullable=True),
    )
    op.add_column(
        "roster_guess_rounds",
        sa.Column("completed_at", sa.DateTime(), nullable=True),
    )
    op.create_index(
        "ix_roster_guess_games_matchmaking_pool",
        "roster_guess_games",
        ["is_public", "status", "preset", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        "ix_roster_guess_games_matchmaking_pool",
        table_name="roster_guess_games",
    )
    op.drop_column("roster_guess_rounds", "completed_at")
    op.drop_column("roster_guess_games", "reveal_seconds")
    op.drop_column("roster_guess_games", "round_seconds")
    op.drop_column("roster_guess_games", "preset")
    op.drop_column("roster_guess_games", "is_public")
    op.drop_column("roster_guess_games", "game_type")
