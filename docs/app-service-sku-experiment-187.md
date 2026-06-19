# App Service SKU experiment for issue #187

| Field | Value |
| --- | --- |
| Captured | 2026-06-18 UTC |
| App | `euroleague-quiz-backend-app` |
| Plan | `euroleague-quiz-plan` in `euroleague-quiz-rg` |
| Region | Austria East (`austriaeast`) |
| Subscription used for measurement | `1da9f61a-0317-4368-bc96-d2371dc650a1` |

## Recommendation

Stay on **Basic B1** for now.

The post-fix TicTacToe board-selection work is already small on production
(`board_axis_selection` averaged about 3-6 ms in `Server-Timing`), and neither
B2 nor S1 produced a consistent end-to-end latency or concurrency improvement in
this run. B2 improved one move p90 sample, but it was slower on median create,
median move, concurrent create wall time, and the unrelated read measured beside
five concurrent creates. S1 was also slower in this sample and costs much more.

S1's Standard-tier features, especially deployment slots and autoscale, remain
useful future options, but they do not justify this latency-only upgrade. Do not
scale out this app yet: SQLite content/auth storage and realtime game state are
still single-instance/process-local concerns.

## Production prerequisite notes

- Latest `main` deploy workflow observed before measurement: GitHub Actions run
  `27794613526`, head SHA `579e6a224e93fb9b62f2f9558102ac2dd66c5de4`,
  completed successfully at `2026-06-18T23:04:37Z`.
- The plan started and ended at SKU `B1`, capacity `1`.
- `Always On` was unexpectedly `false` before the experiment. It was enabled
  before baseline capture because #185 made Always On the intended production
  state, and it was left enabled afterward.
- `ELQ_TICTACTOE_TIMING_ENABLED` was absent before the experiment. It was set to
  `true` temporarily to expose safe TicTacToe `Server-Timing` headers, then
  removed again after measurement.
- Azure Monitor autoscale settings in the resource group were empty before and
  after the S1 run.

## Methodology

Each SKU was measured against the production HTTP API at
`https://euroleague-quiz-backend-app.azurewebsites.net` with one App Service
worker. The guarded measurement shell restored B1/capacity 1 and the original
timing setting on exit.

Per SKU:

1. Wait for the API and TicTacToe create route to respond after any restart or
   SKU change, then run warm-up creates.
2. Capture 15 warm `POST /quiz/tictactoe/games` single-player create requests.
3. Capture 15 move requests. Setup creates were outside the timed move sample:
   the script created solo boards until a team/team cell appeared, resolved a
   valid player through `/quiz/tictactoe/players/autocomplete`, then timed only
   `POST /quiz/tictactoe/games/{id}/moves`.
4. Capture one concurrent run with five simultaneous game creates plus one
   unrelated `GET /players/?limit=1` read.

The measurements are small-sample, public-internet production checks, so they
should be treated as directional rather than a statistically rigorous load test.

## Results

All durations are milliseconds. `p90` is from 15 sequential samples for create
and move, and from five samples for concurrent creates.

| SKU | Workers | Warm create median / p90 / max | Move median / p90 / max | 5-create wall | Concurrent create median / p90 | Unrelated read |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| B1 | 1 | 214.820 / 290.135 / 296.903 | 188.518 / 293.043 / 339.080 | 789.775 | 595.886 / 788.779 | 239.434 |
| B2 | 1 | 257.413 / 277.486 / 282.643 | 200.592 / 218.192 / 220.211 | 1349.058 | 836.356 / 1348.336 | 432.809 |
| S1 | 1 | 294.775 / 429.496 / 618.081 | 202.422 / 279.598 / 356.745 | 1715.306 | 1049.556 / 1714.480 | 786.055 |

Representative average `Server-Timing` phase durations:

| SKU | Create `board_axis_selection` | Create `db_commit` | Move `move_player_matches_cell` | Move `db_commit` |
| --- | ---: | ---: | ---: | ---: |
| B1 | 5.303 | 114.645 | 0.026 | 90.294 |
| B2 | 3.291 | 151.119 | 0.031 | 93.043 |
| S1 | 5.747 | 144.403 | 0.304 | 84.790 |

## Cost comparison

Pricing came from the Azure Retail Prices API for `armRegionName=austriaeast`,
Linux App Service consumption meters, multiplied by 730 hours/month. Prices can
change; these were the API values at measurement time.

| SKU | Linux meter price | Approx. monthly | Delta vs B1 |
| --- | ---: | ---: | ---: |
| B1 | USD 0.01802/hour | USD 13.15/month | - |
| B2 | USD 0.03604/hour | USD 26.31/month | +USD 13.15/month |
| S1 | USD 0.12350/hour | USD 90.16/month | +USD 77.00/month |

The temporary experiment ran for minutes on B2/S1, so its pro-rated incremental
cost is negligible. The table above is the relevant monthly adoption trade-off.

## Decision

Keep production on **B1 with Always On enabled**. The current bottleneck is no
longer board generation, and the measured B2/S1 runs did not justify their
monthly deltas. Revisit S1 separately only if deployment slots or Standard-tier
operational features become a priority. Revisit higher compute only after the
future multi-worker/Postgres/realtime-state work makes scale-out safe.
