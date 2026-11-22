"""Publish the defense shift to its dedicated private JSON file."""

import argparse
from contextlib import contextmanager
from datetime import UTC, datetime
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.demo_data import DATE_FIELDS
from app.generator_data import publish_shift_frame
from app.domain import normalize_records

ORIGIN = "defense-scenario"
ANCHOR = datetime(2026, 1, 5, 9, tzinfo=UTC)
MENTOR = ROOT / "data/local/character_problems.json"
SCENARIO = ROOT / "data/defense"
OUTPUT = ROOT / "data/local/defense/character_problems.json"


def read_array(path):
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, list):
        raise ValueError(f"{path.name}: ожидается массив JSON.")
    return value


def shift_dates(fields, start):
    result = fields.copy()
    for name in (*DATE_FIELDS, "waitingExitDate"):
        if name not in fields or fields[name] is None:
            continue
        try:
            date = datetime.fromisoformat(fields[name])
            if name == "waitingExitDate" and date.year == 1:
                continue
            if date.tzinfo is None:
                raise ValueError
            result[name] = (start + (date - ANCHOR)).isoformat().replace("+00:00", "Z")
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError(f"Некорректная сценарная дата {name}. Ожидается ISO 8601 с часовым поясом.") from exc
    return result


def build_frames(mentor, initial, timeline, start):
    """Validate every snapshot before the first publication; keep source fields intact."""
    if not initial or not all(isinstance(row, dict) for row in initial):
        raise ValueError("В shift.json нужен непустой список сценарных записей.")
    normalize_records(mentor)
    authored_fields = set(initial[0])
    base_ids = {str(row["id"]) for row in mentor}
    authored = {}

    def add(row):
        if not isinstance(row, dict) or row.keys() != authored_fields or row.get("dataOrigin") != ORIGIN:
            raise ValueError("Неполная сценарная запись или неверное значение dataOrigin.")
        key = row.get("id")
        if not isinstance(key, str) or not key.strip() or not row.get("sysId"):
            raise ValueError("Сценарной записи нужны строковый id и непустой sysId.")
        if key in authored or key in base_ids:
            raise ValueError(f"Повтор номера инцидента {key}.")
        authored[key] = shift_dates(row, start)

    def frame():
        rows = [*mentor, *authored.values()]
        normalized = normalize_records(rows)
        for key in authored:
            if normalized[key].diagnostics:
                raise ValueError(f"{key}: {' '.join(normalized[key].diagnostics)}")
        return rows

    for row in initial:
        add(row)
    frames = [(0, frame())]
    for index, event in enumerate(timeline, 1):
        if not isinstance(event, dict):
            raise ValueError(f"Событие {index}: ожидается объект.")
        offset = event.get("afterSeconds")
        if type(offset) is not int or offset < frames[-1][0]:
            raise ValueError(f"Событие {index}: afterSeconds должен быть целым в порядке возрастания.")
        if event.keys() == {"afterSeconds", "new"}:
            add(event["new"])
        elif event.keys() == {"afterSeconds", "id", "changes"}:
            key, changes = event["id"], event["changes"]
            if not isinstance(key, str) or key not in authored:
                raise ValueError(f"Событие {index}: изменять можно только существующий сценарный инцидент.")
            if not isinstance(changes, dict) or not changes or changes.keys() - (authored_fields - {"id", "sysId", "dataOrigin"}):
                raise ValueError(f"Событие {index}: недопустимые поля в changes.")
            authored[key] = authored[key] | shift_dates(changes, start)
        else:
            raise ValueError(f"Событие {index}: задайте new либо id и changes.")
        rows = frame()
        if frames[-1][0] == offset:
            frames[-1] = (offset, rows)
        else:
            frames.append((offset, rows))
    return frames


@contextmanager
def published_by_one_process(directory):
    directory.mkdir(parents=True, exist_ok=True)
    # OS locks survive neither a normal exit nor a killed producer. Keep the file
    # itself so two producers can never lock different versions of the inode.
    with (directory / ".shift.lock").open("a+b") as lock:
        lock.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ValueError("Рабочий файл уже занят другой сменой.") from exc
        except OSError as exc:
            if os.name == "nt" and exc.errno == 13:  # Windows lock violation
                raise ValueError("Рабочий файл уже занят другой сменой.") from exc
            raise
        yield


def publish(mode, scenario_only):
    with published_by_one_process(OUTPUT.parent):
        if not scenario_only and not MENTOR.is_file():
            raise ValueError(f"Нужна выгрузка ментора {MENTOR}. Для отдельного сценария укажите --scenario-only.")
        mentor = [] if scenario_only else read_array(MENTOR)
        initial = read_array(SCENARIO / "shift.json")
        timeline = read_array(SCENARIO / "timeline.json")
        start = datetime.now(UTC).replace(microsecond=0)
        clock = time.monotonic()
        frames = build_frames(mentor, initial, timeline, start)
        if mode == "prepare":
            frames = frames[:1]
        for index, (offset, rows) in enumerate(frames):
            time.sleep(max(0, clock + offset - time.monotonic()))
            publish_shift_frame(OUTPUT, rows, reset=index == 0)
            print(f"+{offset} с | выгрузка ментора: {len(mentor)}, сценарий: {len(rows) - len(mentor)} | {OUTPUT}", flush=True)


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("mode", choices=("prepare", "run"), help="Подготовить начальный снимок или запустить смену")
    cli.add_argument("--scenario-only", action="store_true", help="Запустить только авторские записи, без выгрузки ментора")
    args = cli.parse_args()
    try:
        publish(args.mode, args.scenario_only)
    except KeyboardInterrupt:
        cli.exit(130, "Смена остановлена. Последний опубликованный снимок сохранён.\n")
    except (OSError, ValueError) as exc:
        cli.exit(1, f"{exc}\n")
