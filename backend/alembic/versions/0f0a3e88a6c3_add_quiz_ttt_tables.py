"""add quiz ttt tables

Revision ID: 0f0a3e88a6c3
Revises: 321668000356
Create Date: 2026-02-24 14:10:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "0f0a3e88a6c3"
down_revision: Union[str, Sequence[str], None] = "321668000356"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "quiz_ttt_games",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("mode", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("target_wins", sa.Integer(), nullable=False),
        sa.Column("turn_seconds", sa.Integer(), nullable=True),
        sa.Column("player1_name", sa.String(), nullable=True),
        sa.Column("player2_name", sa.String(), nullable=True),
        sa.Column("player1_score", sa.Integer(), nullable=False),
        sa.Column("player2_score", sa.Integer(), nullable=False),
        sa.Column("current_player", sa.Integer(), nullable=False),
        sa.Column("round_number", sa.Integer(), nullable=False),
        sa.Column("pending_draw_from", sa.Integer(), nullable=True),
        sa.Column("pending_draw_to", sa.Integer(), nullable=True),
        sa.Column("winner_player", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "quiz_ttt_rounds",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("game_id", sa.Integer(), nullable=False),
        sa.Column("round_number", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("row_team_id_1", sa.Integer(), nullable=False),
        sa.Column("row_team_id_2", sa.Integer(), nullable=False),
        sa.Column("row_team_id_3", sa.Integer(), nullable=False),
        sa.Column("col_team_id_1", sa.Integer(), nullable=False),
        sa.Column("col_team_id_2", sa.Integer(), nullable=False),
        sa.Column("col_team_id_3", sa.Integer(), nullable=False),
        sa.Column("started_by_player", sa.Integer(), nullable=False),
        sa.Column("winner_player", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["col_team_id_1"], ["teams.id"]),
        sa.ForeignKeyConstraint(["col_team_id_2"], ["teams.id"]),
        sa.ForeignKeyConstraint(["col_team_id_3"], ["teams.id"]),
        sa.ForeignKeyConstraint(["game_id"], ["quiz_ttt_games.id"]),
        sa.ForeignKeyConstraint(["row_team_id_1"], ["teams.id"]),
        sa.ForeignKeyConstraint(["row_team_id_2"], ["teams.id"]),
        sa.ForeignKeyConstraint(["row_team_id_3"], ["teams.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("game_id", "round_number", name="uq_quiz_ttt_round"),
    )
    op.create_table(
        "quiz_ttt_cells",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("round_id", sa.Integer(), nullable=False),
        sa.Column("row_index", sa.Integer(), nullable=False),
        sa.Column("col_index", sa.Integer(), nullable=False),
        sa.Column("claimed_by_player", sa.Integer(), nullable=True),
        sa.Column("claimed_player_id", sa.Integer(), nullable=True),
        sa.Column("claimed_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["claimed_player_id"], ["players.id"]),
        sa.ForeignKeyConstraint(["round_id"], ["quiz_ttt_rounds.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("round_id", "row_index", "col_index", name="uq_quiz_ttt_cell"),
    )


def downgrade() -> None:
    op.drop_table("quiz_ttt_cells")
    op.drop_table("quiz_ttt_rounds")
    op.drop_table("quiz_ttt_games")
