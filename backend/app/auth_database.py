from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import settings


def sqlite_connect_args(database_url: str) -> dict[str, bool]:
    return {"check_same_thread": False} if database_url.startswith("sqlite") else {}


engine = create_engine(
    settings.auth_database_url,
    connect_args=sqlite_connect_args(settings.auth_database_url),
    echo=False,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_auth_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
