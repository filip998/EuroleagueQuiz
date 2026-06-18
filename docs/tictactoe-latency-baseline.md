# TicTacToe latency baseline

Issue: #181  
Captured: 2026-06-18 on local macOS development hardware  
Database: tracked content DB (`backend/data/euroleague.db`)

## Benchmark command

```bash
cd backend
.venv/bin/python benchmarks/tictactoe_latency.py --concurrency 5 --repeats 5 --json
```

## Board generation baseline

| Measurement | Duration |
| --- | ---: |
| Cold board generation | 53.079 ms |
| Warm board generation min | 16.098 ms |
| Warm board generation mean | 29.426 ms |
| Warm board generation max | 45.224 ms |

Warm runs: `42.538, 25.026, 18.242, 16.098, 45.224 ms`.

## Concurrent board generation baseline

The benchmark starts 5 board-generation tasks and one unrelated
`count(players.id)` read at the same barrier with one SQLAlchemy session per
worker.

| Task | Duration |
| --- | ---: |
| Wall time | 209.720 ms |
| Board #1 | 134.636 ms |
| Board #2 | 201.542 ms |
| Board #3 | 209.071 ms |
| Board #4 | 124.336 ms |
| Board #5 | 199.334 ms |
| Unrelated read (`count(players.id)=3718`) | 1.777 ms |

## Representative create and move timings

Measured against a temporary copy of `backend/data/euroleague.db` with
`ELQ_TICTACTOE_TIMING_ENABLED=true`, so game creation/move writes did not touch
the tracked database.

Create `Server-Timing`:

```text
board_reference_data;dur=24.866, board_axis_selection;dur=22.758, db_commit;dur=0.698, response_state_serialization;dur=3.663, response_serialization;dur=0.054, board_axis_selection_attempts;desc="4", http_status_code;desc="200"
```

Representative correct move `Server-Timing`:

```text
move_player_matches_cell;dur=0.763, db_commit;dur=0.470, response_state_serialization;dur=1.645, response_serialization;dur=0.049, http_status_code;desc="200"
```
