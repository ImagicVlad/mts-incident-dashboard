"""Single-process snapshot store. All publications run on the API event loop."""

import asyncio
import json
import os
from collections import deque
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from watchfiles import awatch

from .domain import Incident, classify, normalize_records, transitions, utc_string


def now() -> str:
    return utc_string(datetime.now(UTC))


def signature(stat: os.stat_result) -> tuple[int, int, int, int]:
    return stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


class Store:
    def __init__(self, path: Path, demo: bool, polling: bool = False, itsm_url_template: str = ""):
        self.path = Path(path).resolve()
        self.demo = demo
        self.polling = polling
        self.template = itsm_url_template
        self.epoch = uuid4().hex
        self._version = 0
        self._items: dict[str, Incident] = {}
        self._groups = classify({})
        self._rows: list[dict] = []
        self._diagnostics: list[str] = []
        self._events: deque[dict] = deque(maxlen=100)
        self._loaded_at: str | None = None
        self._updated_at: str | None = None
        self._error: str | None = "Данные ещё не загружены."
        self._signature = None
        self._changed: set[asyncio.Event] = set()
        self._stopping = asyncio.Event()
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None

    def snapshot(self) -> dict:
        return {
            "epoch": self.epoch,
            "snapshotVersion": self._version,
            "serverTime": now(),
            "loadedAt": self._loaded_at,
            "dataUpdatedAt": self._updated_at,
            "sourceStatus": "error" if self._error else "ok",
            "sourceError": self._error,
            "hasSnapshot": self._loaded_at is not None,
            "demoMode": self.demo,
            "incidents": self._rows,
            "groups": self._groups,
            "counts": {key: len(ids) for key, ids in self._groups.items()},
            "notifications": list(self._events),
            "diagnostics": self._diagnostics,
        }

    async def subscribe(self) -> AsyncIterator[dict]:
        # A single flag per connection coalesces publications for slow clients.
        changed = asyncio.Event()
        self._changed.add(changed)
        try:
            while not self._stopping.is_set():
                changed.clear()
                yield self.snapshot()
                await changed.wait()
        finally:
            self._changed.discard(changed)

    def _publish(self) -> None:
        self._version += 1
        for changed in self._changed:
            changed.set()

    def _read(self):
        with self.path.open("r", encoding="utf-8-sig") as source:
            stamp = signature(os.fstat(source.fileno()))
            rows = json.load(source)
        return normalize_records(rows, self.template), stamp

    async def reload(self) -> None:
        async with self._lock:
            for delay in (0, 0.12, 0.32):
                if delay:
                    await asyncio.sleep(delay)
                try:
                    items, stamp = await asyncio.to_thread(self._read)
                except FileNotFoundError:
                    error = "Файл инцидентов не найден."
                except (json.JSONDecodeError, UnicodeError, RecursionError):
                    error = "Не удалось прочитать JSON. Проверьте формат и кодировку UTF-8."
                except OSError:
                    error = "Нет доступа к файлу инцидентов."
                except ValueError as exc:
                    error = str(exc)
                else:
                    self._signature = stamp
                    self._accept(items)
                    return
            self._signature = self._file_signature()
            if error != self._error:
                self._error = error
                self._publish()

    def _accept(self, items: dict[str, Incident]) -> None:
        initial = self._loaded_at is None
        changed = initial or self._items != items
        recovery = self._error is not None
        if not (changed or recovery):
            return
        time = now()
        if changed:
            if not initial:
                for index, (id_, kind, label) in enumerate(transitions(self._items, items)):
                    self._events.appendleft({
                        "eventId": f"{self.epoch}-{self._version + 1}-{index}",
                        "incidentId": id_, "kind": kind, "label": label, "time": time,
                    })
            self._items = items
            self._groups = classify(items)
            self._rows = [items[key].model_dump(mode="json") for key in sorted(items)]
            self._diagnostics = [f"{row['id']}: {note}" for row in self._rows for note in row["diagnostics"]]
            self._updated_at = time
        self._loaded_at = time
        self._error = None
        self._publish()

    def _file_signature(self):
        try:
            return signature(self.path.stat())
        except OSError:
            return None

    async def _watch(self) -> None:
        while not self._stopping.is_set():
            try:
                async for changes in awatch(
                    self.path.parent, recursive=False, watch_filter=None,
                    force_polling=True if self.polling else None,
                    debounce=180, step=50, rust_timeout=1000, yield_on_timeout=True,
                    stop_event=self._stopping,
                ):
                    relevant = any(Path(name) == self.path for _, name in changes)
                    # Also covers the gap between initial read and watcher registration.
                    if relevant or self._file_signature() != self._signature or self._error:
                        await self.reload()
            except (OSError, RuntimeError):
                # Retry the parent as well, e.g. when a mount only appears after startup.
                await self.reload()
                try:
                    await asyncio.wait_for(self._stopping.wait(), timeout=1)
                except TimeoutError:
                    pass

    async def start(self) -> None:
        if self._task is None:
            self._stopping.clear()
            await self.reload()
            self._task = asyncio.create_task(self._watch(), name="incident-source")

    async def stop(self) -> None:
        self._stopping.set()
        for changed in self._changed:
            changed.set()
        if self._task is not None:
            await self._task
            self._task = None
