"""add guess the list round generators

Revision ID: 9d2f4a6b8c10
Revises: f6a7b8c9d0e1
Create Date: 2026-06-18 23:30:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "9d2f4a6b8c10"
down_revision: Union[str, Sequence[str], None] = "f6a7b8c9d0e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "guess_the_list_games",
        sa.Column(
            "category_type",
            sa.String(length=64),
            server_default="roster",
            nullable=False,
        ),
    )

    with op.batch_alter_table("guess_the_list_rounds") as batch_op:
        batch_op.add_column(
            sa.Column(
                "category_type",
                sa.String(length=64),
                server_default="roster",
                nullable=False,
            )
        )
        batch_op.add_column(sa.Column("metric", sa.String(length=32), nullable=True))
        batch_op.add_column(sa.Column("scope_label", sa.String(), nullable=True))
        batch_op.alter_column(
            "team_id",
            existing_type=sa.Integer(),
            existing_nullable=False,
            nullable=True,
        )
        batch_op.alter_column(
            "season_id",
            existing_type=sa.Integer(),
            existing_nullable=False,
            nullable=True,
        )
        batch_op.alter_column(
            "team_code",
            existing_type=sa.String(),
            existing_nullable=False,
            nullable=True,
        )
        batch_op.alter_column(
            "team_name",
            existing_type=sa.String(),
            existing_nullable=False,
            nullable=True,
        )
        batch_op.alter_column(
            "season_year",
            existing_type=sa.Integer(),
            existing_nullable=False,
            nullable=True,
        )

    with op.batch_alter_table("guess_the_list_slots") as batch_op:
        batch_op.alter_column(
            "player_season_team_id",
            existing_type=sa.Integer(),
            existing_nullable=False,
            nullable=True,
        )
        batch_op.add_column(sa.Column("rank", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("stat_value", sa.Float(), nullable=True))
        batch_op.add_column(sa.Column("stat_value_label", sa.String(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("guess_the_list_slots") as batch_op:
        batch_op.drop_column("stat_value_label")
        batch_op.drop_column("stat_value")
        batch_op.drop_column("rank")
        batch_op.alter_column(
            "player_season_team_id",
            existing_type=sa.Integer(),
            existing_nullable=True,
            nullable=False,
        )

    with op.batch_alter_table("guess_the_list_rounds") as batch_op:
        batch_op.alter_column(
            "season_year",
            existing_type=sa.Integer(),
            existing_nullable=True,
            nullable=False,
        )
        batch_op.alter_column(
            "team_name",
            existing_type=sa.String(),
            existing_nullable=True,
            nullable=False,
        )
        batch_op.alter_column(
            "team_code",
            existing_type=sa.String(),
            existing_nullable=True,
            nullable=False,
        )
        batch_op.alter_column(
            "season_id",
            existing_type=sa.Integer(),
            existing_nullable=True,
            nullable=False,
        )
        batch_op.alter_column(
            "team_id",
            existing_type=sa.Integer(),
            existing_nullable=True,
            nullable=False,
        )
        batch_op.drop_column("scope_label")
        batch_op.drop_column("metric")
        batch_op.drop_column("category_type")

    op.drop_column("guess_the_list_games", "category_type")
