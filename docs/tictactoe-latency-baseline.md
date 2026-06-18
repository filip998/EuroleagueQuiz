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

## Board-generation cache result

Issue: #182
Captured: 2026-06-18 on the same local macOS development hardware
Database: tracked content DB (`backend/data/euroleague.db`)

The benchmark now reports one cold cache build separately, then explicitly warms
the per-process board-reference cache before measuring warm board-generation
repetitions.

| Measurement | Duration |
| --- | ---: |
| Cold board-generation cache build | 230.940 ms |
| Warm board generation min | 0.670 ms |
| Warm board generation mean | 1.175 ms |
| Warm board generation max | 2.733 ms |
| Warm mean speedup vs. #181 baseline | 25.0x |

Warm runs: `0.675, 0.670, 0.878, 2.733, 0.917 ms`.

| Concurrent task | Duration |
| --- | ---: |
| Wall time | 3.812 ms |
| Board #1 | 0.436 ms |
| Board #2 | 1.449 ms |
| Board #3 | 0.455 ms |
| Board #4 | 0.572 ms |
| Board #5 | 0.278 ms |
| Unrelated read (`count(players.id)=3718`) | 3.211 ms |

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

## Game-action event-loop offload result

Issue: #184
Captured: 2026-06-19 on local macOS development hardware
Database: tracked content DB (`backend/data/euroleague.db`)

The game-action orchestration seam now runs synchronous service/database work in a
threadpool with a worker-owned SQLAlchemy session, then applies realtime
broadcast/timer effects back on the event loop after commit. The goal is fairness
under concurrency: unrelated requests can interleave instead of waiting behind a
slow synchronous game action. This does not reduce single-request CPU cost, and
raw CPU throughput is still capped by the GIL and the single-vCPU App Service
tier. Multi-process `uvicorn --workers` remains deferred because realtime
connections and timers are process-local today.

Before #184, the issue benchmark measured a normally ~100 ms unrelated read
freezing to **5654 ms** while 5 heavy board-generation actions ran on the event
loop. After #184, the existing concurrent benchmark stayed responsive with the
same concurrency shape:

| Concurrent task | Duration |
| --- | ---: |
| Wall time | 4.566 ms |
| Board #1 | 0.888 ms |
| Board #2 | 0.618 ms |
| Board #3 | 1.198 ms |
| Board #4 | 0.396 ms |
| Board #5 | 0.730 ms |
| Unrelated read (`count(players.id)=3718`) | 4.557 ms |

Warm board-generation runs were `1.000, 1.336, 0.411, 0.676, 0.146 ms`
(`mean=0.714 ms`); the cold cache build was `223.963 ms`.
