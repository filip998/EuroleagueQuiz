from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from typing import Any, Callable

from sqlalchemy import create_engine, func
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.models import Player
from app.services import tictactoe as ttt_service


def main() -> None:
    args = _parse_args()
    result = asyncio.run(
        run_benchmark(
            database_url=args.database_url,
            concurrency=args.concurrency,
            repeats=args.repeats,
        )
    )
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        _print_text(result)


async def run_benchmark(
    *,
    database_url: str,
    concurrency: int,
    repeats: int,
) -> dict[str, Any]:
    cold_ms = _cold_board_generation_ms(database_url)

    engine, session_factory = _session_factory(database_url)
    try:
        _warm_board_cache(session_factory)
        warm_runs = [
            _time_board_generation(session_factory)["duration_ms"]
            for _ in range(repeats)
        ]
        concurrent = await _run_concurrent_generation(
            session_factory,
            concurrency=concurrency,
        )
    finally:
        engine.dispose()

    return {
        "database_url": _redacted_database_url(database_url),
        "cold_board_generation_ms": round(cold_ms, 3),
        "warm_board_generation_ms": {
            "runs": [round(value, 3) for value in warm_runs],
            "min": round(min(warm_runs), 3),
            "mean": round(statistics.fmean(warm_runs), 3),
            "max": round(max(warm_runs), 3),
        },
        "concurrent_board_generations": concurrent,
    }


def _cold_board_generation_ms(database_url: str) -> float:
    engine, session_factory = _session_factory(database_url)
    try:
        return _time_board_generation(session_factory)["duration_ms"]
    finally:
        engine.dispose()


def _warm_board_cache(session_factory: Callable) -> None:
    with session_factory() as db:
        ttt_service.warm_board_cache(db)


async def _run_concurrent_generation(
    session_factory: Callable,
    *,
    concurrency: int,
) -> dict[str, Any]:
    task_count = concurrency + 1
    started_at_ns: dict[str, int] = {}
    barrier = Barrier(
        task_count,
        action=lambda: started_at_ns.setdefault("value", time.perf_counter_ns()),
    )

    loop = asyncio.get_running_loop()
    with ThreadPoolExecutor(max_workers=task_count) as executor:
        futures = [
            loop.run_in_executor(
                executor,
                _timed_board_generation_task,
                session_factory,
                barrier,
                index,
            )
            for index in range(1, concurrency + 1)
        ]
        futures.append(
            loop.run_in_executor(
                executor,
                _timed_unrelated_read_task,
                session_factory,
                barrier,
            )
        )
        tasks = await asyncio.gather(*futures)

    started_ns = started_at_ns["value"]
    finished_ns = max(task["finished_at_ns"] for task in tasks)
    for task in tasks:
        task.pop("finished_at_ns", None)

    board_tasks = [task for task in tasks if task["kind"] == "board_generation"]
    unrelated_read = next(task for task in tasks if task["kind"] == "unrelated_read")
    return {
        "concurrency": concurrency,
        "wall_time_ms": round((finished_ns - started_ns) / 1_000_000, 3),
        "board_generation_ms": [
            {
                "index": task["index"],
                "duration_ms": round(task["duration_ms"], 3),
            }
            for task in sorted(board_tasks, key=lambda item: item["index"])
        ],
        "unrelated_read": {
            "query": unrelated_read["query"],
            "duration_ms": round(unrelated_read["duration_ms"], 3),
            "result_count": unrelated_read["result_count"],
        },
    }


def _timed_board_generation_task(
    session_factory: Callable,
    barrier: Barrier,
    index: int,
) -> dict[str, Any]:
    barrier.wait()
    result = _time_board_generation(session_factory)
    return {
        "kind": "board_generation",
        "index": index,
        **result,
    }


def _timed_unrelated_read_task(
    session_factory: Callable,
    barrier: Barrier,
) -> dict[str, Any]:
    barrier.wait()
    started_ns = time.perf_counter_ns()
    with session_factory() as db:
        result_count = db.query(func.count(Player.id)).scalar() or 0
    finished_ns = time.perf_counter_ns()
    return {
        "kind": "unrelated_read",
        "query": "count(players.id)",
        "result_count": int(result_count),
        "duration_ms": (finished_ns - started_ns) / 1_000_000,
        "finished_at_ns": finished_ns,
    }


def _time_board_generation(session_factory: Callable) -> dict[str, float]:
    started_ns = time.perf_counter_ns()
    with session_factory() as db:
        ttt_service._select_board_axes(db)
    finished_ns = time.perf_counter_ns()
    return {
        "duration_ms": (finished_ns - started_ns) / 1_000_000,
        "finished_at_ns": finished_ns,
    }


def _session_factory(database_url: str):
    engine = create_engine(
        database_url,
        connect_args={"check_same_thread": False} if "sqlite" in database_url else {},
    )
    return engine, sessionmaker(autocommit=False, autoflush=False, bind=engine)


def _print_text(result: dict[str, Any]) -> None:
    warm = result["warm_board_generation_ms"]
    concurrent = result["concurrent_board_generations"]
    print("TicTacToe latency benchmark")
    print(f"database_url: {result['database_url']}")
    print(f"cold board generation: {result['cold_board_generation_ms']:.3f} ms")
    print(
        "warm board generation: "
        f"min={warm['min']:.3f} ms mean={warm['mean']:.3f} ms "
        f"max={warm['max']:.3f} ms runs={warm['runs']}"
    )
    print(
        "concurrent board generations: "
        f"n={concurrent['concurrency']} wall={concurrent['wall_time_ms']:.3f} ms"
    )
    for item in concurrent["board_generation_ms"]:
        print(f"  board #{item['index']}: {item['duration_ms']:.3f} ms")
    read = concurrent["unrelated_read"]
    print(
        f"  unrelated read ({read['query']}={read['result_count']}): "
        f"{read['duration_ms']:.3f} ms"
    )


def _parse_args():
    parser = argparse.ArgumentParser(
        description="Benchmark TicTacToe board generation latency.",
    )
    parser.add_argument(
        "--database-url",
        default=settings.database_url,
        help="SQLAlchemy database URL. Defaults to ELQ_DATABASE_URL/settings.",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=5,
        help="Concurrent board generations to run; must be at least 5.",
    )
    parser.add_argument(
        "--repeats",
        type=int,
        default=5,
        help="Warm board-generation repetitions.",
    )
    parser.add_argument("--json", action="store_true", help="Print JSON output.")
    args = parser.parse_args()
    if args.concurrency < 5:
        parser.error("--concurrency must be at least 5")
    if args.repeats < 1:
        parser.error("--repeats must be at least 1")
    return args


def _redacted_database_url(database_url: str) -> str:
    if "@" not in database_url or "://" not in database_url:
        return database_url
    scheme, rest = database_url.split("://", 1)
    return f"{scheme}://<redacted>@{rest.split('@', 1)[1]}"


if __name__ == "__main__":
    main()
