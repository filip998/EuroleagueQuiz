from app.services.timing import (
    activate_timing,
    current_timing,
    set_timing_metric,
    timed_phase,
)


def test_timed_phase_is_noop_without_active_recorder():
    with timed_phase("unrecorded"):
        pass

    assert current_timing() is None


def test_timing_recorder_aggregates_repeated_phases_and_metrics():
    with activate_timing("test.request", enabled=True) as recorder:
        with timed_phase("phase.one"):
            pass
        with timed_phase("phase.one"):
            pass
        set_timing_metric("axis.attempts", 3)
        set_timing_metric("unsafe.desc", 'line\nbreak"slash\\')

    assert current_timing() is None
    assert recorder is not None
    phase = recorder.phases["phase.one"]
    assert phase.count == 2
    assert phase.total_ms >= 0
    assert recorder.metrics["axis.attempts"] == 3

    header = recorder.server_timing_header()
    assert "phase_one;dur=" in header
    assert 'phase_one;dur=' in header and 'desc="count=2"' in header
    assert 'axis_attempts;desc="3"' in header
    assert 'unsafe_desc;desc="line break\\"slash\\\\"' in header


def test_activate_timing_disabled_does_not_replace_outer_recorder():
    with activate_timing("outer", enabled=True) as outer:
        with activate_timing("disabled", enabled=False) as disabled:
            assert disabled is None
            assert current_timing() is outer

    assert current_timing() is None
