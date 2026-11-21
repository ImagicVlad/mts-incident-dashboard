"""Drive one dedicated synthetic export. Run from any directory with Python 3.12+."""

import argparse
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.demo_data import RUNTIME, atomic_write, demo_records, write_records

FILE = RUNTIME / "scenario.json"
BACKUP = RUNTIME / "scenario.good"
NUMBER = "DEMO-LIVE-01"
TEAM = "КЦ ИТ Координаторы Массовых Инцидентов"
ACTIONS = ("init", "add", "assign", "deadline", "resolve", "research", "break", "restore")


def iso(value):
    return value.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def run(action: str, now: datetime):
    if action == "init":
        write_records(FILE, demo_records(now))
        BACKUP.unlink(missing_ok=True)
        return
    if action == "restore":
        if not BACKUP.is_file():
            raise ValueError("Нет сохранённой копии. Сначала выполните break.")
        atomic_write(FILE, BACKUP.read_text(encoding="utf-8"))
        BACKUP.unlink()
        return
    if not FILE.exists():
        raise ValueError("Сначала выполните init.")
    rows = json.loads(FILE.read_text(encoding="utf-8"))
    if action == "break":
        atomic_write(BACKUP, json.dumps(rows, ensure_ascii=False))
        atomic_write(FILE, '[{"id":')
        return
    item = next((row for row in rows if row["id"] == NUMBER), None)
    if action == "add":
        if item:
            raise ValueError("Тестовый инцидент уже в файле.")
        item = dict(rows[0], id=NUMBER, sysId="9912345678901234567",
                    header="Пропадают подтверждения тестовых платежей",
                    description="Демонстрационный шлюз перестал подтверждать операции.",
                    shortDescription="Задержки подтверждения операций", assignedGroupName="Демо Процессинг",
                    submitDate=iso(now), deadline=iso(now + timedelta(minutes=18)),
                    lastAssignmentToTeamDateTime=iso(now), solution=None)
        rows.append(item)
    elif not item:
        raise ValueError("Сначала выполните add.")
    elif action == "assign":
        item.update(assignedGroupName=TEAM, assignedEmployee="Антон Демо", lastAssignmentToTeamDateTime=iso(now))
    elif action == "deadline":
        item["deadline"] = iso(datetime.fromisoformat(item["deadline"]) + timedelta(minutes=35))
    elif action == "resolve":
        item.update(stateEnum="Resolved", stateId=7, state="Завершен", completionDate=iso(now),
                    priorityId=2, priority="Средний", solution="Доставка подтверждений восстановлена.")
    elif action == "research":
        item.update(stateEnum="Research", stateId=20, state="Исследование ситуации",
                    assignedGroupName=TEAM, lastAssignmentToTeamDateTime=iso(now))
    write_records(FILE, rows)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=(*ACTIONS, "walk"))
    parser.add_argument("--at", type=datetime.fromisoformat, help="Исходное время ISO 8601 с часовым поясом")
    args = parser.parse_args()
    if args.at and args.at.tzinfo is None:
        parser.error("Укажите часовой пояс для --at.")
    try:
        for step in ACTIONS if args.action == "walk" else [args.action]:
            if args.action == "walk" and step != "init":
                input(f"Enter — {step}: ")
            run(step, args.at or datetime.now(UTC))
            print(f"{step}: {FILE}")
    except (OSError, ValueError) as exc:
        parser.exit(1, str(exc) + "\n")
