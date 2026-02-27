"""change higher_lower values to float

Revision ID: a7b16a38b68c
Revises: 37371260409a
Create Date: 2026-02-28 00:21:40.272985

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a7b16a38b68c'
down_revision: Union[str, Sequence[str], None] = '37371260409a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table('higher_lower_games') as batch_op:
        batch_op.alter_column('left_value',
                   existing_type=sa.INTEGER(),
                   type_=sa.Float(),
                   existing_nullable=True)
        batch_op.alter_column('right_value',
                   existing_type=sa.INTEGER(),
                   type_=sa.Float(),
                   existing_nullable=True)


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('higher_lower_games') as batch_op:
        batch_op.alter_column('right_value',
                   existing_type=sa.Float(),
                   type_=sa.INTEGER(),
                   existing_nullable=True)
        batch_op.alter_column('left_value',
                   existing_type=sa.Float(),
                   type_=sa.INTEGER(),
                   existing_nullable=True)
