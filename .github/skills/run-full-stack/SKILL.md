---
name: Run Full Stack
description: Start both backend and frontend for local development
---

# Run Full Stack

Start both the backend API and frontend UI for local development.

## Steps

Open **two terminals** from the project root:

### Terminal 1 — Backend
```bash
scripts\start-backend.bat
```

### Terminal 2 — Frontend
```bash
scripts\start-frontend.bat
```

Then open http://localhost:5173 to use the app.

## What the scripts do

- **start-backend.bat**: Creates Python venv if missing, installs deps, runs Alembic migrations, starts uvicorn on port 8000
- **start-frontend.bat**: Installs npm deps if missing, starts Vite dev server on port 5173

## Manual equivalent

```bash
# Terminal 1
cd backend && source .venv/bin/activate && alembic upgrade head && uvicorn app.main:app --reload

# Terminal 2
cd frontend && npm run dev
```
