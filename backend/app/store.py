"""Single-process snapshot store. All publications run on the API event loop."""

import asyncio
import json
import os
from hashlib import sha256
from collections import deque
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from watchfiles import awatch

from .demo_data import RUNTIME, atomic_write
from .domain import OPEN, Incident, classify, critical_from, deadline_order, memberships, normalize_records, transitions, utc_string


def utc_now() -> datetime:
    return datetime.now(UTC)


def signature(stat: os.stat_result) -> tuple[int, int, int, int]:
    return stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


class AssignmentConflict(ValueError):
    pass


class Store:
    def __init__(self, path: Path, demo: bool, polling: bool = False, itsm_url_template: str = ""):
        self.path = Path(path).resolve()
        source_key = sha256(os.fsencode(self.path)).hexdigest()
        self.assignments_file = RUNTIME / f"assignments-{source_key}.json"
        self.demo = demo
        self.polling = polling
        self.template = itsm_url_template
        self.epoch = uuid4().hex
        self._version = 0
        self._items: dict[str, Incident] = {}
        self._groups = classify({})
        self._classified_at: datetime | None = None
        self._next_clock_event: datetime | None = None
        self._breached_ids: set[str] = set()
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
        now = utc_now()
        return {
            "epoch": self.epoch,
            "snapshotVersion": self._version,
            "serverTime": utc_string(now),
            "loadedAt": self._loaded_at,
            "dataUpdatedAt": self._updated_at,
            "sourceStatus": "error" if self._error else "ok",
            "sourceError": self._error,
            "hasSnapshot": self._loaded_at is not None,
            "demoMode": self.demo,
            "incidents": self._rows,
            "deadlineOrder": deadline_order(self._items, now),
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
        items = normalize_records(rows, self.template)
        try:
            saved = json.loads(self.assignments_file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            saved = {}
        saved_count = len(saved)
        for id_, entry in list(saved.items()):
            row = items.get(id_)
            if row is None or "assigned" not in memberships(row) or self._assignment_key(row) != entry["source"]:
                del saved[id_]
            else:
                items[id_] = row.model_copy(update=entry["changes"])
        if len(saved) != saved_count:
            atomic_write(self.assignments_file, json.dumps(saved, ensure_ascii=False))
        return items, stamp, saved

    @staticmethod
    def _assignment_key(row):
        return [row.sysId, row.submitDate, row.assignedGroupName, row.assignedEmployee, row.lastAssignmentToTeamDateTime]

    async def assign(self, id_, team, employee, expected_employee, expected_time):
        async with self._lock:
            items, stamp, saved = await asyncio.to_thread(self._read)
            item = items.get(id_)
            if not item or "assigned" not in memberships(item) or (item.assignedEmployee, item.lastAssignmentToTeamDateTime) != (expected_employee, expected_time):
                raise AssignmentConflict("Назначение уже изменилось. Проверьте карточку.")
            if team == item.assignedGroupName:
                raise AssignmentConflict("Выберите профильную команду для передачи.")
            if not any(row.assignedGroupName == team and (employee is None or row.assignedEmployee == employee)
                       for row in items.values()):
                raise AssignmentConflict("Проверьте команду и исполнителя.")
            changes = dict(assignedGroupName=team, assignedEmployee=employee,
                           lastAssignmentToTeamDateTime=utc_string(utc_now()))
            saved[id_] = {"source": saved.get(id_, {}).get("source", self._assignment_key(item)), "changes": changes}
            await asyncio.to_thread(atomic_write, self.assignments_file, json.dumps(saved, ensure_ascii=False))
            items[id_] = item.model_copy(update=changes)
            self._signature = stamp
            self._accept(items)
            return items[id_]

    async def reload(self) -> None:
        async with self._lock:
            for delay in (0, 0.12, 0.32):
                if delay:
                    await asyncio.sleep(delay)
                try:
                    items, stamp, _ = await asyncio.to_thread(self._read)
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

    def _regroup(self, items: dict[str, Incident], at: datetime) -> None:
        initial = self._classified_at is None
        events = [] if initial else list(transitions(self._items, items, now=at, previous_now=self._classified_at))
        thresholds = []
        for item in items.values():
            critical_at = critical_from(item)
            if critical_at and critical_at > at:
                thresholds.append(critical_at)
            if item.stateEnum not in OPEN or not item.deadline:
                continue
            deadline = datetime.fromisoformat(item.deadline)
            if deadline > at:
                thresholds.append(deadline)
            elif item.id not in self._breached_ids:
                self._breached_ids.add(item.id)
                if not initial:
                    events.append((item.id, "overdue", "Нарушен срок SLA"))
        for index, (id_, kind, label) in enumerate(events):
            self._events.appendleft({
                "eventId": f"{self.epoch}-{self._version + 1}-{index}",
                "incidentId": id_, "kind": kind, "label": label, "time": utc_string(at),
            })
        self._groups = classify(items, now=at)
        self._next_clock_event = min(thresholds, default=None)
        self._classified_at = at

    def _refresh_clock(self) -> None:
        at = utc_now()
        if self._next_clock_event is not None and at >= self._next_clock_event:
            self._regroup(self._items, at)
            self._publish()

    def _accept(self, items: dict[str, Incident]) -> None:
        initial = self._loaded_at is None
        changed = initial or self._items != items
        recovery = self._error is not None
        if not (changed or recovery):
            return
        at = utc_now()
        time = utc_string(at)
        self._regroup(items, at)
        if changed:
            self._items = items
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
                    self._refresh_clock()
            except (OSError, RuntimeError):
                # Retry the parent as well, e.g. when a mount only appears after startup.
                await self.reload()
                self._refresh_clock()
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
