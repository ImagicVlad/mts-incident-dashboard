"""One opt-in incident generator for the lifetime of an API process."""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from random import randint


logger = logging.getLogger(__name__)


class IncidentGenerator:
    def __init__(self, append: Callable[[], Awaitable[None]],
                 check_source: Callable[[], Awaitable[None]]):
        self._append = append
        self._check_source = check_source
        self._lock = asyncio.Lock()
        self._stop = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    @property
    def enabled(self) -> bool:
        return self._task is not None and not self._task.done() and not self._stop.is_set()

    async def set_enabled(self, enabled: bool) -> None:
        async with self._lock:
            if enabled and not self.enabled:
                await self._check_source()
                self._stop.clear()
                self._task = asyncio.create_task(self._run(), name="incident-generator")
            elif not enabled and self._task is not None:
                # Wake a pending timer immediately, but finish any write already in flight.
                self._stop.set()
                await self._task
                self._task = None

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=randint(25, 60))
                return
            except TimeoutError:
                if self._stop.is_set():
                    return
            try:
                await self._append()
            except (OSError, ValueError, RecursionError):
                # The source can be temporarily invalid or being replaced by another writer.
                logger.warning("Incident generation skipped: source unavailable or changed")
