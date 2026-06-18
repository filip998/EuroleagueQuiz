"""rename roster guess to guess the list

Revision ID: f6a7b8c9d0e1
Revises: e1f2a3b4c5d6
Create Date: 2026-06-18 20:45:00.000000

"""

from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "f6a7b8c9d0e1"
down_revision: Union[str, Sequence[str], None] = "e1f2a3b4c5d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_index("ix_roster_guess_games_join_code", table_name="roster_guess_games")
    op.drop_index(
        "ix_roster_guess_games_matchmaking_pool",
        table_name="roster_guess_games",
    )

    op.rename_table("roster_guess_games", "guess_the_list_games")
    op.rename_table("roster_guess_rounds", "guess_the_list_rounds")
    op.rename_table("roster_guess_slots", "guess_the_list_slots")

    op.create_index(
        "ix_guess_the_list_games_join_code",
        "guess_the_list_games",
        ["join_code"],
        unique=True,
    )
    op.create_index(
        "ix_guess_the_list_games_matchmaking_pool",
        "guess_the_list_games",
        ["is_race", "is_public", "status", "preset", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        "ix_guess_the_list_games_matchmaking_pool",
        table_name="guess_the_list_games",
    )
    op.drop_index(
        "ix_guess_the_list_games_join_code",
        table_name="guess_the_list_games",
    )

    op.rename_table("guess_the_list_slots", "roster_guess_slots")
    op.rename_table("guess_the_list_rounds", "roster_guess_rounds")
    op.rename_table("guess_the_list_games", "roster_guess_games")

    op.create_index(
        "ix_roster_guess_games_join_code",
        "roster_guess_games",
        ["join_code"],
        unique=True,
    )
    op.create_index(
        "ix_roster_guess_games_matchmaking_pool",
        "roster_guess_games",
        ["is_race", "is_public", "status", "preset", "created_at"],
        unique=False,
    )
