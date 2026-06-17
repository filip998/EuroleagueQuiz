from logging.config import fileConfig

from sqlalchemy import create_engine
from sqlalchemy import pool

from alembic import context

from app.auth_database import Base, sqlite_connect_args
from app.config import settings
import app.models.user  # noqa: F401 - registers auth models

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata
AUTH_VERSION_TABLE = "alembic_auth_version"


def auth_database_url() -> str:
    return settings.auth_database_url


def set_config_database_url(url: str) -> None:
    config.set_main_option("sqlalchemy.url", url.replace("%", "%%"))


def run_migrations_offline() -> None:
    url = auth_database_url()
    set_config_database_url(url)
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        version_table=AUTH_VERSION_TABLE,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    url = auth_database_url()
    set_config_database_url(url)
    connectable = create_engine(
        url,
        connect_args=sqlite_connect_args(url),
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            version_table=AUTH_VERSION_TABLE,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
