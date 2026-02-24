"""add join_code to quiz_ttt_games

Revision ID: 4b7e2c1d9f03
Revises: 0f0a3e88a6c3
Create Date: 2026-02-24 15:45:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "4b7e2c1d9f03"
down_revision: Union[str, Sequence[str], None] = "0f0a3e88a6c3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("quiz_ttt_games", sa.Column("join_code", sa.String(6), nullable=True))
    op.create_index("ix_quiz_ttt_games_join_code", "quiz_ttt_games", ["join_code"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_quiz_ttt_games_join_code", table_name="quiz_ttt_games")
    op.drop_column("quiz_ttt_games", "join_code")
