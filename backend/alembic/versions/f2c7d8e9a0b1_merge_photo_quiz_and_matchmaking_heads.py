"""merge photo quiz and matchmaking heads

Revision ID: f2c7d8e9a0b1
Revises: 6e3b6c9a0d12, d4f2b8c9a1e0
Create Date: 2026-06-17 15:20:57.418000

"""

from typing import Sequence, Union


# revision identifiers, used by Alembic.
revision: str = "f2c7d8e9a0b1"
down_revision: Union[str, Sequence[str], None] = (
    "6e3b6c9a0d12",
    "d4f2b8c9a1e0",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""


def downgrade() -> None:
    """Downgrade schema."""
