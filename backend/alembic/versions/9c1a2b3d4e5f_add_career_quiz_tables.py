"""add career quiz tables

Revision ID: 9c1a2b3d4e5f
Revises: 831b7794e96f
Create Date: 2026-05-24 15:10:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "9c1a2b3d4e5f"
down_revision: Union[str, Sequence[str], None] = "831b7794e96f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "career_data_revisions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("revision", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("eligible_player_count", sa.Integer(), nullable=False),
        sa.Column("threshold_player_count", sa.Integer(), nullable=False),
        sa.Column("threshold_passed", sa.Boolean(), nullable=False),
        sa.Column("report_path", sa.String(), nullable=True),
        sa.Column("report_hash", sa.String(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("revision"),
    )
    op.create_index(
        op.f("ix_career_data_revisions_is_active"),
        "career_data_revisions",
        ["is_active"],
        unique=False,
    )
    op.create_index(
        op.f("ix_career_data_revisions_revision"),
        "career_data_revisions",
        ["revision"],
        unique=True,
    )
    op.create_index(
        op.f("ix_career_data_revisions_status"),
        "career_data_revisions",
        ["status"],
        unique=False,
    )

    op.create_table(
        "player_wikidata_mappings",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("player_id", sa.Integer(), nullable=False),
        sa.Column("wikidata_qid", sa.String(), nullable=True),
        sa.Column("wikidata_label", sa.String(), nullable=True),
        sa.Column("wikidata_birth_date", sa.Date(), nullable=True),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("match_method", sa.String(), nullable=True),
        sa.Column("reviewed", sa.Boolean(), nullable=False),
        sa.Column("review_note", sa.Text(), nullable=True),
        sa.Column("candidate_count", sa.Integer(), nullable=False),
        sa.Column("candidates_json", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("last_checked_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["player_id"], ["players.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("player_id"),
    )
    op.create_index(
        op.f("ix_player_wikidata_mappings_status"),
        "player_wikidata_mappings",
        ["status"],
        unique=False,
    )
    op.create_index(
        op.f("ix_player_wikidata_mappings_wikidata_qid"),
        "player_wikidata_mappings",
        ["wikidata_qid"],
        unique=False,
    )

    op.create_table(
        "player_career_stints",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("mapping_id", sa.Integer(), nullable=False),
        sa.Column("player_id", sa.Integer(), nullable=False),
        sa.Column("sequence_index", sa.Integer(), nullable=False),
        sa.Column("wikidata_player_qid", sa.String(), nullable=False),
        sa.Column("wikidata_team_qid", sa.String(), nullable=False),
        sa.Column("wikidata_team_label", sa.String(), nullable=False),
        sa.Column("wikidata_statement_id", sa.String(), nullable=True),
        sa.Column("raw_start", sa.String(), nullable=True),
        sa.Column("raw_start_precision", sa.Integer(), nullable=True),
        sa.Column("raw_end", sa.String(), nullable=True),
        sa.Column("raw_end_precision", sa.Integer(), nullable=True),
        sa.Column("start_season", sa.String(), nullable=True),
        sa.Column("end_season", sa.String(), nullable=True),
        sa.Column("start_season_year", sa.Integer(), nullable=True),
        sa.Column("end_season_year", sa.Integer(), nullable=True),
        sa.Column("is_current", sa.Boolean(), nullable=False),
        sa.Column("is_loan", sa.Boolean(), nullable=False),
        sa.Column("include_in_quiz", sa.Boolean(), nullable=False),
        sa.Column("exclusion_reason", sa.String(), nullable=True),
        sa.Column("source_retrieved_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["mapping_id"], ["player_wikidata_mappings.id"]),
        sa.ForeignKeyConstraint(["player_id"], ["players.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("mapping_id", "sequence_index", name="uq_career_stint_order"),
    )
    op.create_index(
        op.f("ix_player_career_stints_include_in_quiz"),
        "player_career_stints",
        ["include_in_quiz"],
        unique=False,
    )
    op.create_index(
        op.f("ix_player_career_stints_player_id"),
        "player_career_stints",
        ["player_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_player_career_stints_wikidata_player_qid"),
        "player_career_stints",
        ["wikidata_player_qid"],
        unique=False,
    )
    op.create_index(
        op.f("ix_player_career_stints_wikidata_team_qid"),
        "player_career_stints",
        ["wikidata_team_qid"],
        unique=False,
    )

    op.create_table(
        "career_quiz_games",
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
    op.create_index(op.f("ix_career_quiz_games_join_code"), "career_quiz_games", ["join_code"], unique=True)
    op.create_table(
        "career_quiz_rounds",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("game_id", sa.Integer(), nullable=False),
        sa.Column("round_number", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("answer_player_id", sa.Integer(), nullable=False),
        sa.Column("winner_player", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["answer_player_id"], ["players.id"]),
        sa.ForeignKeyConstraint(["game_id"], ["career_quiz_games.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("game_id", "round_number", name="uq_career_quiz_round"),
    )
    op.create_table(
        "career_quiz_guesses",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("round_id", sa.Integer(), nullable=False),
        sa.Column("player_number", sa.Integer(), nullable=False),
        sa.Column("guessed_player_id", sa.Integer(), nullable=False),
        sa.Column("is_correct", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["guessed_player_id"], ["players.id"]),
        sa.ForeignKeyConstraint(["round_id"], ["career_quiz_rounds.id"]),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("career_quiz_guesses")
    op.drop_table("career_quiz_rounds")
    op.drop_index(op.f("ix_career_quiz_games_join_code"), table_name="career_quiz_games")
    op.drop_table("career_quiz_games")
    op.drop_index(op.f("ix_player_career_stints_wikidata_team_qid"), table_name="player_career_stints")
    op.drop_index(op.f("ix_player_career_stints_wikidata_player_qid"), table_name="player_career_stints")
    op.drop_index(op.f("ix_player_career_stints_player_id"), table_name="player_career_stints")
    op.drop_index(op.f("ix_player_career_stints_include_in_quiz"), table_name="player_career_stints")
    op.drop_table("player_career_stints")
    op.drop_index(op.f("ix_player_wikidata_mappings_wikidata_qid"), table_name="player_wikidata_mappings")
    op.drop_index(op.f("ix_player_wikidata_mappings_status"), table_name="player_wikidata_mappings")
    op.drop_table("player_wikidata_mappings")
    op.drop_index(op.f("ix_career_data_revisions_status"), table_name="career_data_revisions")
    op.drop_index(op.f("ix_career_data_revisions_revision"), table_name="career_data_revisions")
    op.drop_index(op.f("ix_career_data_revisions_is_active"), table_name="career_data_revisions")
    op.drop_table("career_data_revisions")
