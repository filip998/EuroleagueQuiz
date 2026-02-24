import time
import logging

logger = logging.getLogger(__name__)


class RateLimiter:
    def __init__(self, min_interval: float = 1.0):
        self.min_interval = min_interval
        self._last_call = 0.0

    def wait(self):
        elapsed = time.time() - self._last_call
        if elapsed < self.min_interval:
            time.sleep(self.min_interval - elapsed)
        self._last_call = time.time()


def parse_minutes(minutes_str: str) -> int:
    """Parse 'MM:SS' format to total seconds."""
    if not minutes_str or minutes_str == "DNP":
        return 0
    try:
        parts = minutes_str.split(":")
        return int(parts[0]) * 60 + int(parts[1])
    except (ValueError, IndexError):
        return 0


def parse_player_name(name_str: str):
    """Parse 'LAST, FIRST' format. Returns (first_name, last_name)."""
    if not name_str:
        return None, None
    parts = name_str.split(", ", 1)
    if len(parts) == 2:
        return parts[1].strip(), parts[0].strip()
    return None, name_str.strip()
