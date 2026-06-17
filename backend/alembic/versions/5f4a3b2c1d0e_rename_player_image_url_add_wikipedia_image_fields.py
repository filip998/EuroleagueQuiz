"""rename player image url add wikipedia image fields

Revision ID: 5f4a3b2c1d0e
Revises: 2b7c8d9e0f1a
Create Date: 2026-06-17 14:10:15.005000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "5f4a3b2c1d0e"
down_revision: Union[str, Sequence[str], None] = "2b7c8d9e0f1a"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("players") as batch_op:
        batch_op.alter_column(
            "image_url",
            existing_type=sa.String(),
            existing_nullable=True,
            new_column_name="euroleague_image_url",
        )
        batch_op.add_column(sa.Column("wikipedia_url", sa.String(), nullable=True))
        batch_op.add_column(
            sa.Column("wikipedia_image_url", sa.String(), nullable=True)
        )
        batch_op.add_column(
            sa.Column("wikipedia_image_checked_at", sa.DateTime(), nullable=True)
        )

    op.execute(
        """
        UPDATE players
        SET wikipedia_url = (
            SELECT player_career_source_mappings.source_player_url
            FROM player_career_source_mappings
            WHERE player_career_source_mappings.player_id = players.id
              AND player_career_source_mappings.source_name = 'wikipedia'
              AND player_career_source_mappings.source_player_url IS NOT NULL
              AND player_career_source_mappings.source_player_url <> ''
        )
        WHERE EXISTS (
            SELECT 1
            FROM player_career_source_mappings
            WHERE player_career_source_mappings.player_id = players.id
              AND player_career_source_mappings.source_name = 'wikipedia'
              AND player_career_source_mappings.source_player_url IS NOT NULL
              AND player_career_source_mappings.source_player_url <> ''
        )
        """
    )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("players") as batch_op:
        batch_op.drop_column("wikipedia_image_checked_at")
        batch_op.drop_column("wikipedia_image_url")
        batch_op.drop_column("wikipedia_url")
        batch_op.alter_column(
            "euroleague_image_url",
            existing_type=sa.String(),
            existing_nullable=True,
            new_column_name="image_url",
        )
