"""Synthetic source only. The mentor export is never read or modified here."""

import json
import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = ROOT / "data/demo/character_problems.json"
RUNTIME = ROOT / "data/runtime"
ANCHOR = datetime(2026, 1, 5, 9, tzinfo=UTC)
DATE_FIELDS = ("submitDate", "deadline", "completionDate", "lastAssignmentToTeamDateTime")


def demo_records(now: datetime) -> list[dict]:
    offset = now.astimezone(UTC).replace(microsecond=0) - ANCHOR
    records = json.loads(TEMPLATE.read_text(encoding="utf-8"))
    for record in records:
        for field in DATE_FIELDS:
            if record[field]:
                date = datetime.fromisoformat(record[field]) + offset
                record[field] = date.isoformat().replace("+00:00", "Z")
    return records


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", delete=False,
                                     dir=path.parent, suffix=".tmp") as handle:
        temp = Path(handle.name)
        handle.write(content)
    try:
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def write_records(path: Path, records: list[dict]) -> None:
    atomic_write(path, json.dumps(records, ensure_ascii=False, indent=2) + "\n")


def prepare_default_demo() -> Path:
    path = RUNTIME / "preview.json"
    write_records(path, demo_records(datetime.now(UTC)))
    return path
