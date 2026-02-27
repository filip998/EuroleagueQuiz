# Higher or Lower — Implementation Plan

## Phase 1: Backend Foundation

### 1.1 Database Models
- Create `HigherLowerGame` model (game session tracking)
- Create `HigherLowerScore` model (leaderboard entries)
- Create Alembic migration

### 1.2 Service Layer (`backend/app/services/higher_lower.py`)
- Player eligibility query (20+ career games, season range filter)
- Stat computation per category (aggregate within season range)
- Pair generation algorithm (random but balanced — avoid trivially obvious gaps)
- Category selection (random from tier)
- Answer validation logic
- High score / leaderboard logic

### 1.3 API Router (`backend/app/routers/higher_lower.py`)
- `POST /games` — create game, return first pair
- `POST /games/{game_id}/answer` — submit answer, return result + next pair
- `GET /leaderboard/{tier}` — top 10 per tier
- Mount in `app/main.py`

### 1.4 Schemas (`backend/app/schemas/higher_lower.py`)
- Request/response Pydantic models

### 1.5 Backend Tests
- Test game creation, answer flow, streak tracking, leaderboard

## Phase 2: Frontend

### 2.1 Setup Screen (`frontend/src/HigherLowerSetup.jsx`)
- Tier selector (Easy / Medium / Hard)
- Season range dropdowns
- Nickname input
- Leaderboard display (per selected tier)
- Start button

### 2.2 Game Board (`frontend/src/HigherLowerBoard.jsx`)
- Two player cards (name + flag)
- Category label
- Three answer buttons (Left / Same / Right)
- Streak counter
- Result reveal animation
- Game over screen with stats + leaderboard position

### 2.3 API Integration (`frontend/src/api.js`)
- Add Higher or Lower API functions

### 2.4 Home Page
- Add Higher or Lower as a game option on the home screen

## Phase 3: Polish

### 3.1 Pair Quality
- Tune pair generation to avoid trivially obvious comparisons
- Ensure "Same" answers are possible but not too frequent

### 3.2 Testing & Build
- Run backend tests
- Run frontend build
- Manual testing of full flow

## Files to Create
- `backend/app/models/higher_lower.py`
- `backend/app/schemas/higher_lower.py`
- `backend/app/services/higher_lower.py`
- `backend/app/routers/higher_lower.py`
- `backend/alembic/versions/xxx_add_higher_lower.py` (auto-generated)
- `frontend/src/HigherLowerSetup.jsx`
- `frontend/src/HigherLowerBoard.jsx`

## Files to Modify
- `backend/app/models/__init__.py` — export new models
- `backend/app/main.py` — mount new router
- `frontend/src/api.js` — add API functions
- `frontend/src/App.jsx` — add game to home page
