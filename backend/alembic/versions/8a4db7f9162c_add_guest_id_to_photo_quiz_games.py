"""add guest_id to photo quiz games

Revision ID: 8a4db7f9162c
Revises: f2c7d8e9a0b1
Create Date: 2026-06-17 17:08:32.641000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "8a4db7f9162c"
down_revision: Union[str, Sequence[str], None] = "f2c7d8e9a0b1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "photo_quiz_games",
        sa.Column("player1_guest_id", sa.String(64), nullable=True),
    )
    op.add_column(
        "photo_quiz_games",
        sa.Column("player2_guest_id", sa.String(64), nullable=True),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("photo_quiz_games", "player2_guest_id")
    op.drop_column("photo_quiz_games", "player1_guest_id")
