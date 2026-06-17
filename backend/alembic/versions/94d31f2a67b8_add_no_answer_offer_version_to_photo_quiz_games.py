"""add no-answer offer version to photo quiz games

Revision ID: 94d31f2a67b8
Revises: 8a4db7f9162c
Create Date: 2026-06-17 21:35:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "94d31f2a67b8"
down_revision: Union[str, Sequence[str], None] = "8a4db7f9162c"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "photo_quiz_games",
        sa.Column(
            "no_answer_offer_version",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("photo_quiz_games", "no_answer_offer_version")
