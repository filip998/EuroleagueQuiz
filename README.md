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

## TicTacToe Quiz Game API (v1)

Implemented under `/quiz/tictactoe/*`:
- `POST /quiz/tictactoe/games` — create game (`single_player`, `local_two_player`; `online_friend` currently returns 501)
- `GET /quiz/tictactoe/games/{game_id}` — fetch current game + board state
- `POST /quiz/tictactoe/games/{game_id}/moves` — submit answer for a cell
- `POST /quiz/tictactoe/games/{game_id}/draw-offer` — offer draw (turn ends)
- `POST /quiz/tictactoe/games/{game_id}/draw-response` — accept/decline draw
- `GET /quiz/tictactoe/players/autocomplete` — player name autocomplete (optional two-club filter)

Current v1 ability type is **club intersection only**: a move is valid when the selected player has played for both clubs defined by the chosen row and column.
