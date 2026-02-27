# Higher or Lower — Game Design Document

## Overview

A solo quiz game where the player is shown two EuroLeague players side by side and must guess which one has the higher stat value (or if they're the same). Each correct answer extends the streak; one wrong answer ends the game. The goal is to achieve the longest streak possible.

## Core Loop

1. Player selects a **difficulty tier** and a **season range**
2. Two player cards appear: **Left** vs **Right** (name + nationality flag, stats hidden)
3. A stat category label is shown (e.g., "Career Total Points")
4. Player clicks **Left**, **Right**, or **Same**
5. Both stat values are revealed with a brief animation
6. If correct → streak counter increases, two new players appear
7. If wrong → game over, show final streak, prompt to save score

## Presentation

- **Two cards side by side** — classic style, not sliding
- Each card shows: **Player name** + **nationality flag**
- Both stat values are **hidden** until the player answers (pure knowledge test)
- After answering: both values revealed immediately with a brief animation
- Three buttons between/below the cards: **← Left** | **Same** | **Right →**
- Streak counter visible at all times

## Difficulty Tiers

### Easy
Stats that most fans would know or can intuit:
| Category | Source | Notes |
|----------|--------|-------|
| Height (cm) | `players.height_cm` | Direct attribute |
| Age (years) | `players.birth_date` | Computed from birth date |
| EuroLeague seasons played | `COUNT(DISTINCT player_season_teams.season_id)` | Within range filter |
| EuroLeague teams played for | `COUNT(DISTINCT player_season_teams.team_id)` | Within range filter |

### Medium
Requires basketball knowledge:
| Category | Source | Notes |
|----------|--------|-------|
| Total points | `SUM(player_season_stats.points)` | Across seasons in range |
| Total assists | `SUM(player_season_stats.assists)` | Across seasons in range |
| Total rebounds | `SUM(player_season_stats.rebounds_offensive + rebounds_defensive)` | Across seasons in range |
| Total games played | `SUM(player_season_stats.games_played)` | Across seasons in range |
| Best single-season PIR | `MAX(player_season_stats.pir)` | Best season within range |

### Hard
Deep stats, harder to guess:
| Category | Source | Notes |
|----------|--------|-------|
| Career 3-pointers made | `SUM(player_season_stats.three_points_made)` | Across seasons in range |
| Single-game career-high points | `MAX(game_player_stats.points)` | Games within range |
| Total steals | `SUM(player_season_stats.steals)` | Across seasons in range |
| Total blocks | `SUM(player_season_stats.blocks_favour)` | Across seasons in range |
| Total turnovers | `SUM(player_season_stats.turnovers)` | Across seasons in range |

## Player Eligibility

- Player must have **at least 20 career games played** (total across all seasons)
- Player must have played **at least 1 season within the selected season range**
- Stats are **filtered to only count within the selected season range**
- For "Height" and "Age" categories, all eligible players can appear (no stats needed)

## Season Range Filter

- Selector on the setup screen: **Start season** and **End season** dropdowns
- Default: full range (2003–2025)
- Affects two things:
  1. Which players appear (must have a `player_season_teams` record in range)
  2. Stat values (only aggregate stats from seasons within the range)

## Scoring & High Scores

- **Streak-based**: each correct answer = +1 to streak
- One wrong answer = game over
- **Nickname**: entered once on first play, stored in localStorage + backend
- **High scores stored per difficulty tier** in the backend database
- **Global leaderboard**: top 10 streaks per tier, visible from the setup screen

## Solo Only

- No multiplayer modes
- No timer
- No rounds/match structure — just an endless streak

## Game Over Screen

- Show final streak count
- Show personal best (and whether this is a new record)
- Show position on global leaderboard (if applicable)
- "Play Again" button (same tier) + "Change Tier" button (back to setup)

## Technical Architecture

### Backend

**New API endpoints** (mounted under `/api/higher-lower/`):

1. `POST /games` — Create a new game session
   - Request: `{ tier, season_range_start, season_range_end, nickname }`
   - Response: `{ game_id, first_pair: { left: {name, nationality, flag}, right: {name, nationality, flag}, category, category_label } }`

2. `POST /games/{game_id}/answer` — Submit an answer
   - Request: `{ choice: "left" | "right" | "same" }`
   - Response: `{ correct, left_value, right_value, streak, next_pair: {...} | null }`
   - If wrong: `{ correct: false, left_value, right_value, final_streak, is_personal_best, leaderboard_position }`

3. `GET /leaderboard/{tier}` — Get top 10 for a tier
   - Response: `{ entries: [{ nickname, streak, played_at }] }`

**New database models:**
- `HigherLowerGame` — game session (id, tier, season range, nickname, streak, status, created_at)
- `HigherLowerScore` — high scores (id, nickname, tier, streak, played_at)

**New service module:** `backend/app/services/higher_lower.py`
- Pre-compute eligible players + stats for the session
- Generate random pairs with the correct stat values
- Ensure pairs are "interesting" (avoid trivially obvious comparisons when possible)

### Frontend

**New components:**
- `HigherLowerSetup.jsx` — tier selector, season range, nickname input, leaderboard view
- `HigherLowerBoard.jsx` — the game board with two cards, buttons, streak counter, result reveal

**Accessed from the home page** alongside TicTacToe and Roster Guess.

### Pair Generation Strategy

To keep the game interesting:
- Avoid huge stat gaps (e.g., 800 career points vs 5) — prefer pairs within a reasonable range
- Occasionally include a "trick" pair where the lesser-known player has the higher stat
- For "Same" to be viable, include some ties (especially for height, age, seasons played)
- Never repeat the same pair in a single game session
