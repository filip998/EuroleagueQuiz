from datetime import datetime, timedelta, timezone

import pytest

from app.services.race_rounds import (
    normalize_utc,
    parse_utc_datetime,
    public_round_timer_delay_seconds_from_state,
    reveal_window_starts_at,
)


def test_parse_utc_datetime_accepts_z_naive_and_offset_values():
    assert parse_utc_datetime("2026-06-18T12:00:00Z") == datetime(
        2026, 6, 18, 12, 0, tzinfo=timezone.utc
    )
    assert parse_utc_datetime("2026-06-18T12:00:00") == datetime(
        2026, 6, 18, 12, 0, tzinfo=timezone.utc
    )
    assert parse_utc_datetime("2026-06-18T14:30:00+02:30") == datetime(
        2026, 6, 18, 12, 0, tzinfo=timezone.utc
    )


@pytest.mark.parametrize("value", [None, "", "not-a-date", 42, True])
def test_parse_utc_datetime_returns_none_for_invalid_values(value):
    assert parse_utc_datetime(value) is None


def test_normalize_utc_preserves_naive_as_utc_and_converts_offsets():
    assert normalize_utc(datetime(2026, 6, 18, 12, 0)) == datetime(
        2026, 6, 18, 12, 0, tzinfo=timezone.utc
    )
    assert normalize_utc(
        datetime(2026, 6, 18, 14, 0, tzinfo=timezone(timedelta(hours=2)))
    ) == datetime(2026, 6, 18, 12, 0, tzinfo=timezone.utc)


def test_reveal_window_starts_at_returns_deadline_only_before_it_elapsed():
    completed_at = datetime(2026, 6, 18, 12, 0, tzinfo=timezone.utc)
    starts_at = completed_at + timedelta(seconds=3)

    assert (
        reveal_window_starts_at(
            completed_at,
            reveal_seconds=3,
            now=starts_at - timedelta(microseconds=1),
        )
        == starts_at
    )
    assert (
        reveal_window_starts_at(completed_at, reveal_seconds=3, now=starts_at)
        is None
    )
    assert (
        reveal_window_starts_at(
            completed_at,
            reveal_seconds=3,
            now=starts_at + timedelta(microseconds=1),
        )
        is None
    )
    assert reveal_window_starts_at(None, reveal_seconds=3, now=starts_at) is None


def test_public_round_timer_delay_from_state_returns_base_clock_for_eligible_state():
    timer_delay = public_round_timer_delay_seconds_from_state(
        _eligible_state(),
        round_seconds=60,
        now=datetime(2026, 6, 18, 12, 0, tzinfo=timezone.utc),
    )

    assert timer_delay is not None
    assert timer_delay.seconds == 60.0
    assert timer_delay.round_number == 2


def test_public_round_timer_delay_from_state_adds_remaining_reveal_countdown():
    now = datetime(2026, 6, 18, 12, 0, tzinfo=timezone.utc)
    timer_delay = public_round_timer_delay_seconds_from_state(
        _eligible_state(
            latest_completed_round={
                "next_round_starts_at": (now + timedelta(seconds=2.5)).isoformat()
            }
        ),
        round_seconds=60,
        now=now,
    )

    assert timer_delay is not None
    assert timer_delay.seconds == 62.5
    assert timer_delay.round_number == 2


@pytest.mark.parametrize(
    "next_round_starts_at",
    ["not-a-date", "2026-06-18T11:59:59+00:00", None],
)
def test_public_round_timer_delay_from_state_keeps_base_clock_for_invalid_or_elapsed_reveal(
    next_round_starts_at,
):
    timer_delay = public_round_timer_delay_seconds_from_state(
        _eligible_state(
            latest_completed_round={"next_round_starts_at": next_round_starts_at}
        ),
        round_seconds=60,
        now=datetime(2026, 6, 18, 12, 0, tzinfo=timezone.utc),
    )

    assert timer_delay is not None
    assert timer_delay.seconds == 60.0
    assert timer_delay.round_number == 2


@pytest.mark.parametrize(
    "state_patch",
    [
        {"mode": "single_player"},
        {"status": "finished"},
        {"is_public": False},
        {"current_round": None},
        {"current_round": {"status": "completed"}},
        {"round_number": None},
        {"round_number": True},
    ],
)
def test_public_round_timer_delay_from_state_returns_none_for_ineligible_states(
    state_patch,
):
    state = _eligible_state()
    state.update(state_patch)

    assert (
        public_round_timer_delay_seconds_from_state(
            state,
            round_seconds=60,
            now=datetime(2026, 6, 18, 12, 0, tzinfo=timezone.utc),
        )
        is None
    )


def test_public_round_timer_delay_from_state_returns_none_for_nonpositive_round_clock():
    assert (
        public_round_timer_delay_seconds_from_state(_eligible_state(), round_seconds=0)
        is None
    )


def _eligible_state(**overrides):
    state = {
        "mode": "online_friend",
        "status": "active",
        "is_public": True,
        "preset": "standard",
        "round_number": 2,
        "current_round": {"round_number": 2, "status": "active"},
        "latest_completed_round": None,
    }
    state.update(overrides)
    return state
