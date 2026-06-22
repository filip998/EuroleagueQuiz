"""add all euroleague awards

Revision ID: d7a8e9f0c1b2
Revises: 9d2f4a6b8c10
Create Date: 2026-06-22 17:15:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "d7a8e9f0c1b2"
down_revision: Union[str, Sequence[str], None] = "9d2f4a6b8c10"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "award_data_revisions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("award_key", sa.String(length=64), nullable=False),
        sa.Column("source_name", sa.String(), nullable=False),
        sa.Column("source_url", sa.String(), nullable=False),
        sa.Column("source_revision_id", sa.String(), nullable=True),
        sa.Column("source_retrieved_at", sa.DateTime(), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("enabled_metric", sa.String(length=32), nullable=True),
        sa.Column("eligible_row_count", sa.Integer(), nullable=False),
        sa.Column("accepted_row_count", sa.Integer(), nullable=False),
        sa.Column("eligible_round_count", sa.Integer(), nullable=False),
        sa.Column("threshold_round_count", sa.Integer(), nullable=False),
        sa.Column("threshold_passed", sa.Boolean(), nullable=False),
        sa.Column("report_path", sa.String(), nullable=True),
        sa.Column("report_hash", sa.String(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_award_data_revisions_award_key",
        "award_data_revisions",
        ["award_key"],
    )
    op.create_index(
        "ix_award_data_revisions_is_active",
        "award_data_revisions",
        ["is_active"],
    )
    op.create_index(
        "ix_award_data_revisions_key_active",
        "award_data_revisions",
        ["award_key", "is_active"],
    )
    op.create_index(
        "ix_award_data_revisions_source_name",
        "award_data_revisions",
        ["source_name"],
    )
    op.create_index(
        "ix_award_data_revisions_source_revision_id",
        "award_data_revisions",
        ["source_revision_id"],
    )
    op.create_index(
        "ix_award_data_revisions_status",
        "award_data_revisions",
        ["status"],
    )

    op.create_table(
        "player_award_selections",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("revision_id", sa.Integer(), nullable=False),
        sa.Column("award_key", sa.String(length=64), nullable=False),
        sa.Column("award_metric", sa.String(length=32), nullable=False),
        sa.Column("season_id", sa.Integer(), nullable=True),
        sa.Column("season_year", sa.Integer(), nullable=False),
        sa.Column("source_row_key", sa.String(), nullable=False),
        sa.Column("source_order", sa.Integer(), nullable=False),
        sa.Column("source_position", sa.String(), nullable=True),
        sa.Column("source_player_label", sa.String(), nullable=False),
        sa.Column("source_player_url", sa.String(), nullable=True),
        sa.Column("local_player_id", sa.Integer(), nullable=True),
        sa.Column("source_team_label", sa.String(), nullable=True),
        sa.Column("source_team_url", sa.String(), nullable=True),
        sa.Column("local_team_id", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("match_method", sa.String(), nullable=True),
        sa.Column("reviewed", sa.Boolean(), nullable=False),
        sa.Column("review_note", sa.Text(), nullable=True),
        sa.Column("candidate_count", sa.Integer(), nullable=False),
        sa.Column("candidates_json", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["local_player_id"], ["players.id"]),
        sa.ForeignKeyConstraint(["local_team_id"], ["teams.id"]),
        sa.ForeignKeyConstraint(
            ["revision_id"],
            ["award_data_revisions.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["season_id"], ["seasons.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "revision_id",
            "award_key",
            "award_metric",
            "season_year",
            "source_row_key",
            name="uq_player_award_selection_source_row",
        ),
    )
    op.create_index(
        "ix_player_award_selections_award_key",
        "player_award_selections",
        ["award_key"],
    )
    op.create_index(
        "ix_player_award_selections_award_metric",
        "player_award_selections",
        ["award_metric"],
    )
    op.create_index(
        "ix_player_award_selections_lookup",
        "player_award_selections",
        ["award_key", "award_metric", "season_year", "status"],
    )
    op.create_index(
        "ix_player_award_selections_local_player_id",
        "player_award_selections",
        ["local_player_id"],
    )
    op.create_index(
        "ix_player_award_selections_local_team_id",
        "player_award_selections",
        ["local_team_id"],
    )
    op.create_index(
        "ix_player_award_selections_revision_id",
        "player_award_selections",
        ["revision_id"],
    )
    op.create_index(
        "ix_player_award_selections_season_id",
        "player_award_selections",
        ["season_id"],
    )
    op.create_index(
        "ix_player_award_selections_season_year",
        "player_award_selections",
        ["season_year"],
    )
    op.create_index(
        "ix_player_award_selections_status",
        "player_award_selections",
        ["status"],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_player_award_selections_status", table_name="player_award_selections")
    op.drop_index(
        "ix_player_award_selections_season_year",
        table_name="player_award_selections",
    )
    op.drop_index("ix_player_award_selections_season_id", table_name="player_award_selections")
    op.drop_index("ix_player_award_selections_revision_id", table_name="player_award_selections")
    op.drop_index(
        "ix_player_award_selections_local_team_id",
        table_name="player_award_selections",
    )
    op.drop_index(
        "ix_player_award_selections_local_player_id",
        table_name="player_award_selections",
    )
    op.drop_index("ix_player_award_selections_lookup", table_name="player_award_selections")
    op.drop_index(
        "ix_player_award_selections_award_metric",
        table_name="player_award_selections",
    )
    op.drop_index("ix_player_award_selections_award_key", table_name="player_award_selections")
    op.drop_table("player_award_selections")

    op.drop_index("ix_award_data_revisions_status", table_name="award_data_revisions")
    op.drop_index(
        "ix_award_data_revisions_source_revision_id",
        table_name="award_data_revisions",
    )
    op.drop_index("ix_award_data_revisions_source_name", table_name="award_data_revisions")
    op.drop_index("ix_award_data_revisions_key_active", table_name="award_data_revisions")
    op.drop_index("ix_award_data_revisions_is_active", table_name="award_data_revisions")
    op.drop_index("ix_award_data_revisions_award_key", table_name="award_data_revisions")
    op.drop_table("award_data_revisions")
