---
name: Run Backend
description: Start the EuroLeague Quiz backend API server with Python venv
---

# Run Backend

Start the FastAPI backend server for local development.

## Steps

```bash
cd backend
```

If the virtual environment doesn't exist yet, create it:
```bash
python -m venv .venv
```

Activate the virtual environment:
```bash
# Windows
.venv\Scripts\activate

# Linux/Mac
source .venv/bin/activate
```

Install dependencies (first time or after changes):
```bash
pip install -e ".[dev]" --quiet
```

Apply database migrations:
```bash
alembic upgrade head
```

Start the server:
```bash
uvicorn app.main:app --reload
```

The API will be available at http://localhost:8000 with interactive docs at http://localhost:8000/docs.

Alternatively, use the startup script from the project root:
```bash
scripts\start-backend.bat
```
