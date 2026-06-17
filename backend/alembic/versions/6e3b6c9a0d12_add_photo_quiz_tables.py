"""add photo quiz tables

Revision ID: 6e3b6c9a0d12
Revises: 5f4a3b2c1d0e
Create Date: 2026-06-17 14:32:06.137000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "6e3b6c9a0d12"
down_revision: Union[str, Sequence[str], None] = "5f4a3b2c1d0e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "photo_quiz_games",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("mode", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("join_code", sa.String(length=6), nullable=True),
        sa.Column("target_wins", sa.Integer(), nullable=False),
        sa.Column("wrong_guess_visibility", sa.String(), nullable=False),
        sa.Column("player1_name", sa.String(), nullable=True),
        sa.Column("player2_name", sa.String(), nullable=True),
        sa.Column("player1_score", sa.Integer(), nullable=False),
        sa.Column("player2_score", sa.Integer(), nullable=False),
        sa.Column("round_number", sa.Integer(), nullable=False),
        sa.Column("winner_player", sa.Integer(), nullable=True),
        sa.Column("pending_no_answer_from", sa.Integer(), nullable=True),
        sa.Column("pending_no_answer_to", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_photo_quiz_games_join_code"),
        "photo_quiz_games",
        ["join_code"],
        unique=True,
    )
    op.create_table(
        "photo_quiz_rounds",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("game_id", sa.Integer(), nullable=False),
        sa.Column("round_number", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("answer_player_id", sa.Integer(), nullable=False),
        sa.Column("solo_token_id", sa.Integer(), nullable=True),
        sa.Column("winner_player", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["answer_player_id"], ["players.id"]),
        sa.ForeignKeyConstraint(["game_id"], ["photo_quiz_games.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("game_id", "round_number", name="uq_photo_quiz_round"),
    )
    op.create_index(
        op.f("ix_photo_quiz_rounds_solo_token_id"),
        "photo_quiz_rounds",
        ["solo_token_id"],
        unique=True,
    )
    op.create_table(
        "photo_quiz_guesses",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("round_id", sa.Integer(), nullable=False),
        sa.Column("player_number", sa.Integer(), nullable=False),
        sa.Column("guessed_player_id", sa.Integer(), nullable=False),
        sa.Column("is_correct", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["guessed_player_id"], ["players.id"]),
        sa.ForeignKeyConstraint(["round_id"], ["photo_quiz_rounds.id"]),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("photo_quiz_guesses")
    op.drop_index(
        op.f("ix_photo_quiz_rounds_solo_token_id"),
        table_name="photo_quiz_rounds",
    )
    op.drop_table("photo_quiz_rounds")
    op.drop_index(op.f("ix_photo_quiz_games_join_code"), table_name="photo_quiz_games")
    op.drop_table("photo_quiz_games")
