from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any


@dataclass(frozen=True)
class RaceRoundTimerDelay:
    seconds: float
    round_number: int


def normalize_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def parse_utc_datetime(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return normalize_utc(parsed)


def reveal_window_starts_at(
    completed_at: datetime | None,
    *,
    reveal_seconds: int,
    now: datetime | None = None,
) -> datetime | None:
    if completed_at is None:
        return None
    starts_at = normalize_utc(completed_at) + timedelta(seconds=reveal_seconds)
    now_utc = normalize_utc(now or datetime.now(timezone.utc))
    return starts_at if now_utc < starts_at else None


def public_round_timer_delay_seconds_from_state(
    game_state: dict[str, Any],
    *,
    round_seconds: int,
    now: datetime | None = None,
) -> RaceRoundTimerDelay | None:
    if round_seconds <= 0:
        return None
    if (
        game_state.get("mode") != "online_friend"
        or game_state.get("status") != "active"
        or not game_state.get("is_public")
    ):
        return None

    current_round = game_state.get("current_round")
    if not isinstance(current_round, dict) or current_round.get("status") != "active":
        return None

    round_number = game_state.get("round_number")
    if not isinstance(round_number, int) or isinstance(round_number, bool):
        return None

    delay_seconds = float(round_seconds)
    latest_completed_round = game_state.get("latest_completed_round")
    next_round_starts_at = (
        latest_completed_round.get("next_round_starts_at")
        if isinstance(latest_completed_round, dict)
        else None
    )
    starts_at = parse_utc_datetime(next_round_starts_at)
    if starts_at is not None:
        now_utc = normalize_utc(now or datetime.now(timezone.utc))
        if now_utc < starts_at:
            delay_seconds += max((starts_at - now_utc).total_seconds(), 0.0)

    return RaceRoundTimerDelay(seconds=delay_seconds, round_number=round_number)
