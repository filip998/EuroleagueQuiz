"""replace wikidata career source tables

Revision ID: 2b7c8d9e0f1a
Revises: 9c1a2b3d4e5f
Create Date: 2026-06-10 10:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "2b7c8d9e0f1a"
down_revision: Union[str, Sequence[str], None] = "9c1a2b3d4e5f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.execute(
        "UPDATE career_data_revisions "
        "SET is_active = 0, threshold_passed = 0, status = 'stale_source_replaced'"
    )
    op.drop_index(op.f("ix_player_career_stints_wikidata_team_qid"), table_name="player_career_stints")
    op.drop_index(op.f("ix_player_career_stints_wikidata_player_qid"), table_name="player_career_stints")
    op.drop_index(op.f("ix_player_career_stints_player_id"), table_name="player_career_stints")
    op.drop_index(op.f("ix_player_career_stints_include_in_quiz"), table_name="player_career_stints")
    op.drop_table("player_career_stints")
    op.drop_index(op.f("ix_player_wikidata_mappings_wikidata_qid"), table_name="player_wikidata_mappings")
    op.drop_index(op.f("ix_player_wikidata_mappings_status"), table_name="player_wikidata_mappings")
    op.drop_table("player_wikidata_mappings")

    op.create_table(
        "player_career_source_mappings",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("player_id", sa.Integer(), nullable=False),
        sa.Column("source_name", sa.String(), nullable=False),
        sa.Column("source_player_key", sa.String(), nullable=True),
        sa.Column("source_player_label", sa.String(), nullable=True),
        sa.Column("source_player_url", sa.String(), nullable=True),
        sa.Column("source_revision_id", sa.String(), nullable=True),
        sa.Column("source_birth_date", sa.Date(), nullable=True),
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
        op.f("ix_player_career_source_mappings_source_name"),
        "player_career_source_mappings",
        ["source_name"],
        unique=False,
    )
    op.create_index(
        op.f("ix_player_career_source_mappings_source_player_key"),
        "player_career_source_mappings",
        ["source_player_key"],
        unique=False,
    )
    op.create_index(
        op.f("ix_player_career_source_mappings_status"),
        "player_career_source_mappings",
        ["status"],
        unique=False,
    )

    op.create_table(
        "player_career_stints",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("mapping_id", sa.Integer(), nullable=False),
        sa.Column("player_id", sa.Integer(), nullable=False),
        sa.Column("sequence_index", sa.Integer(), nullable=False),
        sa.Column("source_name", sa.String(), nullable=False),
        sa.Column("source_player_key", sa.String(), nullable=True),
        sa.Column("source_team_key", sa.String(), nullable=False),
        sa.Column("source_team_label", sa.String(), nullable=False),
        sa.Column("source_team_url", sa.String(), nullable=True),
        sa.Column("source_row_key", sa.String(), nullable=True),
        sa.Column("local_team_id", sa.Integer(), nullable=True),
        sa.Column("raw_start", sa.String(), nullable=True),
        sa.Column("raw_end", sa.String(), nullable=True),
        sa.Column("start_season", sa.String(), nullable=True),
        sa.Column("end_season", sa.String(), nullable=True),
        sa.Column("start_season_year", sa.Integer(), nullable=True),
        sa.Column("end_season_year", sa.Integer(), nullable=True),
        sa.Column("is_current", sa.Boolean(), nullable=False),
        sa.Column("is_loan", sa.Boolean(), nullable=False),
        sa.Column("include_in_quiz", sa.Boolean(), nullable=False),
        sa.Column("exclusion_reason", sa.String(), nullable=True),
        sa.Column("source_retrieved_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["local_team_id"], ["teams.id"]),
        sa.ForeignKeyConstraint(["mapping_id"], ["player_career_source_mappings.id"]),
        sa.ForeignKeyConstraint(["player_id"], ["players.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("mapping_id", "sequence_index", name="uq_career_stint_order"),
    )
    op.create_index(op.f("ix_player_career_stints_include_in_quiz"), "player_career_stints", ["include_in_quiz"], unique=False)
    op.create_index(op.f("ix_player_career_stints_player_id"), "player_career_stints", ["player_id"], unique=False)
    op.create_index(op.f("ix_player_career_stints_source_name"), "player_career_stints", ["source_name"], unique=False)
    op.create_index(op.f("ix_player_career_stints_source_player_key"), "player_career_stints", ["source_player_key"], unique=False)
    op.create_index(op.f("ix_player_career_stints_source_team_key"), "player_career_stints", ["source_team_key"], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_player_career_stints_source_team_key"), table_name="player_career_stints")
    op.drop_index(op.f("ix_player_career_stints_source_player_key"), table_name="player_career_stints")
    op.drop_index(op.f("ix_player_career_stints_source_name"), table_name="player_career_stints")
    op.drop_index(op.f("ix_player_career_stints_player_id"), table_name="player_career_stints")
    op.drop_index(op.f("ix_player_career_stints_include_in_quiz"), table_name="player_career_stints")
    op.drop_table("player_career_stints")
    op.drop_index(op.f("ix_player_career_source_mappings_status"), table_name="player_career_source_mappings")
    op.drop_index(op.f("ix_player_career_source_mappings_source_player_key"), table_name="player_career_source_mappings")
    op.drop_index(op.f("ix_player_career_source_mappings_source_name"), table_name="player_career_source_mappings")
    op.drop_table("player_career_source_mappings")

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
    op.create_index(op.f("ix_player_wikidata_mappings_status"), "player_wikidata_mappings", ["status"], unique=False)
    op.create_index(op.f("ix_player_wikidata_mappings_wikidata_qid"), "player_wikidata_mappings", ["wikidata_qid"], unique=False)

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
    op.create_index(op.f("ix_player_career_stints_include_in_quiz"), "player_career_stints", ["include_in_quiz"], unique=False)
    op.create_index(op.f("ix_player_career_stints_player_id"), "player_career_stints", ["player_id"], unique=False)
    op.create_index(op.f("ix_player_career_stints_wikidata_player_qid"), "player_career_stints", ["wikidata_player_qid"], unique=False)
    op.create_index(op.f("ix_player_career_stints_wikidata_team_qid"), "player_career_stints", ["wikidata_team_qid"], unique=False)
