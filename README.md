# EuroLeague Quiz — Data Platform

Web application for quizzes and knowledge games focused on **EuroLeague Basketball** (from 2000 onward).

## Phase 1: Data Platform

Collects and structures all EuroLeague historical data from the official API.

### Data Sources
- Official EuroLeague API (`api-live.euroleague.net`) via the `euroleague-api` Python package
- Player bios, game metadata, box scores, season stats

### Tech Stack
- **Backend**: Python + FastAPI
- **ORM**: SQLAlchemy (SQLite, PostgreSQL-ready)
- **Migrations**: Alembic

### Setup

```bash
pip install -e .
```

### Run API Server

```bash
uvicorn app.main:app --reload
```

### Run Data Ingestion

```bash
python -m ingestion.ingest --start-season 2000 --end-season 2025
```

### API Docs

Once the server is running, visit `http://localhost:8000/docs` for the interactive API documentation.
