import asyncio
from typing import Any


class FakeWebSocket:
    def __init__(self, *, fail_send: bool = False):
        self.accepted = False
        self.closed = False
        self.fail_send = fail_send
        self.sent: list[dict[str, Any]] = []

    async def accept(self):
        self.accepted = True

    async def send_json(self, message: dict[str, Any]):
        if self.fail_send:
            raise RuntimeError("send failed")
        self.sent.append(message)

    async def close(self):
        self.closed = True


class SleepController:
    def __init__(self):
        self.calls: list[tuple[float, asyncio.Event]] = []

    async def __call__(self, seconds: float):
        release = asyncio.Event()
        self.calls.append((seconds, release))
        await release.wait()

    async def wait_for_call(self, count: int = 1):
        for _ in range(50):
            if len(self.calls) >= count:
                return
            await asyncio.sleep(0)
        raise AssertionError(f"Expected {count} timer sleep call(s), got {len(self.calls)}")

    def release(self, index: int = 0):
        self.calls[index][1].set()


async def drain_tasks(count: int = 3):
    for _ in range(count):
        await asyncio.sleep(0)
