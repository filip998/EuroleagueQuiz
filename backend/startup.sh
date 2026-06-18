#!/bin/sh
set -eu

ensure_sqlite_dirs() {
  python - <<'PY'
import os
from pathlib import Path


def sqlite_path(url: str) -> str | None:
    prefix = "sqlite:///"
    if not url.startswith(prefix):
        return None
    path = url[len(prefix) :]
    if not path or path == ":memory:":
        return None
    return path


for name, default in (
    ("ELQ_DATABASE_URL", "sqlite:///data/euroleague.db"),
    ("ELQ_AUTH_DATABASE_URL", "sqlite:///data/users.db"),
):
    path = sqlite_path(os.environ.get(name, default))
    if path is None:
        continue
    Path(path).parent.mkdir(parents=True, exist_ok=True)
PY
}

pip install .
ensure_sqlite_dirs
alembic upgrade head
alembic -c alembic_auth.ini upgrade head

exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
