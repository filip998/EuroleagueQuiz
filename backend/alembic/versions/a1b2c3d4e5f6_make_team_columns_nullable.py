"""make team columns nullable in rounds

Revision ID: a1b2c3d4e5f6
Revises: 3343ba02291a
Create Date: 2026-02-24 21:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = '3343ba02291a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Make row_team_id_* and col_team_id_* nullable for generic axes."""
    with op.batch_alter_table('quiz_ttt_rounds') as batch_op:
        batch_op.alter_column('row_team_id_1', existing_type=sa.Integer(), nullable=True)
        batch_op.alter_column('row_team_id_2', existing_type=sa.Integer(), nullable=True)
        batch_op.alter_column('row_team_id_3', existing_type=sa.Integer(), nullable=True)
        batch_op.alter_column('col_team_id_1', existing_type=sa.Integer(), nullable=True)
        batch_op.alter_column('col_team_id_2', existing_type=sa.Integer(), nullable=True)
        batch_op.alter_column('col_team_id_3', existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    """Revert columns to NOT NULL."""
    with op.batch_alter_table('quiz_ttt_rounds') as batch_op:
        batch_op.alter_column('row_team_id_1', existing_type=sa.Integer(), nullable=False)
        batch_op.alter_column('row_team_id_2', existing_type=sa.Integer(), nullable=False)
        batch_op.alter_column('row_team_id_3', existing_type=sa.Integer(), nullable=False)
        batch_op.alter_column('col_team_id_1', existing_type=sa.Integer(), nullable=False)
        batch_op.alter_column('col_team_id_2', existing_type=sa.Integer(), nullable=False)
        batch_op.alter_column('col_team_id_3', existing_type=sa.Integer(), nullable=False)
