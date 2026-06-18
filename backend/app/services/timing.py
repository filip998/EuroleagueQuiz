from __future__ import annotations

import re
import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Iterator


@dataclass
class PhaseTiming:
    name: str
    count: int = 0
    total_ms: float = 0.0
    min_ms: float | None = None
    max_ms: float | None = None

    def add(self, duration_ms: float) -> None:
        self.count += 1
        self.total_ms += duration_ms
        self.min_ms = duration_ms if self.min_ms is None else min(self.min_ms, duration_ms)
        self.max_ms = duration_ms if self.max_ms is None else max(self.max_ms, duration_ms)

    def as_dict(self) -> dict[str, float | int | str | None]:
        return {
            "name": self.name,
            "count": self.count,
            "total_ms": round(self.total_ms, 3),
            "min_ms": round(self.min_ms, 3) if self.min_ms is not None else None,
            "max_ms": round(self.max_ms, 3) if self.max_ms is not None else None,
        }


@dataclass
class TimingRecorder:
    name: str
    attributes: dict[str, Any] = field(default_factory=dict)
    phases: dict[str, PhaseTiming] = field(default_factory=dict)
    metrics: dict[str, int | float | str | bool | None] = field(default_factory=dict)
    _started_ns: int = field(default_factory=time.perf_counter_ns)

    def phase(self, name: str) -> _ActivePhase:
        return _ActivePhase(self, name)

    def add_phase(self, name: str, duration_ms: float) -> None:
        self.phases.setdefault(name, PhaseTiming(name)).add(duration_ms)

    def set_metric(self, name: str, value: int | float | str | bool | None) -> None:
        self.metrics[name] = value

    @property
    def total_ms(self) -> float:
        return (time.perf_counter_ns() - self._started_ns) / 1_000_000

    def summary(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "total_ms": round(self.total_ms, 3),
            "attributes": dict(self.attributes),
            "metrics": dict(self.metrics),
            "phases": [phase.as_dict() for phase in self.phases.values()],
        }

    def server_timing_header(self) -> str:
        metrics = [
            f"{_server_timing_token(phase.name)};dur={phase.total_ms:.3f}"
            + (f';desc="count={phase.count}"' if phase.count > 1 else "")
            for phase in self.phases.values()
        ]
        for name, value in self.metrics.items():
            metrics.append(f'{_server_timing_token(name)};desc="{_escape_desc(value)}"')
        return ", ".join(metrics)


class _ActivePhase:
    def __init__(self, recorder: TimingRecorder, name: str):
        self._recorder = recorder
        self._name = name
        self._started_ns: int | None = None

    def __enter__(self) -> None:
        self._started_ns = time.perf_counter_ns()
        return None

    def __exit__(self, exc_type, exc, tb) -> bool:
        if self._started_ns is not None:
            duration_ms = (time.perf_counter_ns() - self._started_ns) / 1_000_000
            self._recorder.add_phase(self._name, duration_ms)
        return False


class _NoopPhase:
    def __enter__(self) -> None:
        return None

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False


_NOOP_PHASE = _NoopPhase()
_ACTIVE_TIMING: ContextVar[TimingRecorder | None] = ContextVar(
    "active_timing",
    default=None,
)
_SERVER_TIMING_TOKEN_RE = re.compile(r"[^A-Za-z0-9!#$%&'*+.^_`|~-]+")
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")


def current_timing() -> TimingRecorder | None:
    return _ACTIVE_TIMING.get()


def timed_phase(name: str) -> _ActivePhase | _NoopPhase:
    recorder = _ACTIVE_TIMING.get()
    if recorder is None:
        return _NOOP_PHASE
    return recorder.phase(name)


def set_timing_metric(name: str, value: int | float | str | bool | None) -> None:
    recorder = _ACTIVE_TIMING.get()
    if recorder is not None:
        recorder.set_metric(name, value)


@contextmanager
def activate_timing(
    name: str,
    *,
    enabled: bool,
    attributes: dict[str, Any] | None = None,
) -> Iterator[TimingRecorder | None]:
    if not enabled:
        yield None
        return

    recorder = TimingRecorder(name=name, attributes=attributes or {})
    token = _ACTIVE_TIMING.set(recorder)
    try:
        yield recorder
    finally:
        _ACTIVE_TIMING.reset(token)


def _server_timing_token(name: str) -> str:
    token = _SERVER_TIMING_TOKEN_RE.sub("_", name.replace(".", "_"))
    return token.strip("_") or "timing"


def _escape_desc(value: Any) -> str:
    cleaned = _CONTROL_CHAR_RE.sub(" ", str(value))
    return cleaned.replace("\\", "\\\\").replace('"', '\\"')
