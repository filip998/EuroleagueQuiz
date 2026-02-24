# EuroLeague Quiz

Web application for quizzes and knowledge games focused on **EuroLeague Basketball** (from 2000 onward).

## Project Structure

```
backend/   — Python/FastAPI API server, data ingestion, SQLAlchemy models
frontend/  — React (Vite) UI
```

## Backend

### Setup

```bash
cd backend
pip install -e .
alembic upgrade head
```

### Run API Server

```bash
cd backend
uvicorn app.main:app --reload
```

### Run Data Ingestion

```bash
cd backend
python -m ingestion.ingest --start-season 2000 --end-season 2025
```

### API Docs

Once the server is running, visit `http://localhost:8000/docs` for the interactive API documentation.

## Frontend

### Setup

```bash
cd frontend
npm install
```

### Run Dev Server

```bash
cd frontend
npm run dev
```

Opens at `http://localhost:5173`.

## TicTacToe Quiz Game API (v1)

Implemented under `/quiz/tictactoe/*`:
- `POST /quiz/tictactoe/games` — create game (`single_player`, `local_two_player`; `online_friend` currently returns 501)
- `GET /quiz/tictactoe/games/{game_id}` — fetch current game + board state
- `POST /quiz/tictactoe/games/{game_id}/moves` — submit answer for a cell
- `POST /quiz/tictactoe/games/{game_id}/draw-offer` — offer draw (turn ends)
- `POST /quiz/tictactoe/games/{game_id}/draw-response` — accept/decline draw
- `GET /quiz/tictactoe/players/autocomplete` — player name autocomplete (optional two-club filter)

Current v1 ability type is **club intersection only**: a move is valid when the selected player has played for both clubs defined by the chosen row and column.
