"""Append synthetic incidents to a working JSON snapshot, preserving source records."""

from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
import json
import os
from pathlib import Path
import random
import tempfile
import time
from uuid import uuid4

from .demo_data import write_records
from .domain import COORDINATORS, PRIORITY_LABELS, STATE_LABELS, normalize_records, utc_string

ORIGIN = "auto-generated"
# Arrival mix; the normal SLA rules may escalate an active high-priority case later.
PRIORITY_WEIGHTS = (25, 50, 22, 3)

# Product, service, response team, and a symptom for each ascending severity.
SCENARIOS = (
    ("Платежи", "Зачисление на лицевой счёт", "Расчёты и взаиморасчёты", (
        "В чеке пополнения не указан способ оплаты", "Чеки за пополнение появляются в истории с задержкой",
        "Часть подтверждённых пополнений не зачисляется на баланс", "Остановилось зачисление всех подтверждённых платежей")),
    ("Личный кабинет", "Подтверждение входа", "Платформа идентификации", (
        "Форма входа дублирует подсказку под полем кода", "После повторного запроса приходят два кода входа",
        "Коды входа части абонентов приходят после истечения срока", "Абоненты не могут войти ни через приложение, ни через сайт")),
    ("Домашний интернет", "Доступ по оптической сети", "Сеть фиксированного доступа", (
        "В кабинете поздно обновляется модель домашнего роутера", "Диагностика линии показывает устаревшие показания",
        "У абонентов одного узла прерывается соединение", "Несколько узлов доступа одновременно потеряли связь с агрегацией")),
    ("Мобильная связь", "Регистрация в пакетной сети", "Эксплуатация пакетного ядра", (
        "В отчёте о сессиях не отображается тип сети", "Статистика сессий поступает с задержкой",
        "В одном районе отклоняется часть новых сессий", "Регистрация в пакетной сети недоступна в нескольких районах")),
    ("Видеосвязь", "Записи конференций", "Платформа видеосвязи", (
        "У готовой записи не появилась миниатюра", "Ссылка на запись появляется с задержкой",
        "Новые записи конференций остаются в обработке", "Запись остановилась во всех активных конференциях")),
    ("Корпоративная сеть", "Межофисные каналы", "Эксплуатация транспортной сети", (
        "В отчёте по каналу не отображается имя площадки", "График загрузки межофисного канала перестал обновляться",
        "Между двумя площадками теряется часть пакетов", "Основной и резервный каналы между площадками недоступны")),
)


def make_incident(rows: list[dict], now: datetime, rng=random) -> dict:
    priority = rng.choices((1, 2, 3, 4), weights=PRIORITY_WEIGHTS, k=1)[0]
    recent = {row.get("header") for row in rows[-4:]}
    choices = [s for s in SCENARIOS if s[3][priority - 1] not in recent]
    product, service, team, symptoms = rng.choice(choices or SCENARIOS)
    symptom = symptoms[priority - 1]
    # Ordinary arrivals need triage; higher-priority arrivals can already have an owner.
    triage = priority <= 2 or rng.random() < 0.2
    state = "Assigned" if triage else "WorkInProgress"
    bounds = {1: (360, 720), 2: (180, 360), 3: (90, 180), 4: (20, 60)}
    ids = {str(row["id"]) for row in rows}
    # Random identity also survives an explicit reset of the source file; never
    # recycle a serial that might already have read receipts or assignment history.
    systems = {str(row.get("sysId")) for row in rows}
    while True:
        system_id = uuid4()
        incident_id = f"INC-{system_id.int % (10 ** 15):015d}"
        if incident_id not in ids and str(system_id) not in systems:
            break
    stamp = utc_string(now)
    return {"id": incident_id, "sysId": str(system_id), "dataOrigin": ORIGIN, "header": symptom,
            "shortDescription": symptom, "description": f"{symptom}. Проверка сервиса «{service}» зарегистрировала отклонение.",
            "productName": product, "service": service, "priorityId": priority, "priority": PRIORITY_LABELS[priority],
            "stateEnum": state, "stateId": 0 if triage else 2, "state": STATE_LABELS[state],
            "assignedGroupName": COORDINATORS if triage else team, "assignedEmployee": None,
            "submitDate": stamp, "lastAssignmentToTeamDateTime": stamp,
            "deadline": utc_string(now + timedelta(minutes=rng.randint(*bounds[priority])))}


@contextmanager
def _source_lock(path: Path):
    # The sidecar stays put: replacing the JSON must not change the lock's identity.
    with path.with_name(f".{path.name}.lock").open("a+b") as lock:
        if os.name == "nt":
            import msvcrt
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def _update_source(path, transform, *, allow_missing=False):
    with _source_lock(path):
        for attempt in range(3):
            try:
                before = path.read_bytes()
            except FileNotFoundError:
                if not allow_missing:
                    raise
                before = None
            rows = json.loads(before.decode("utf-8-sig")) if before is not None else []
            normalize_records(rows)
            updated, result = transform(rows)
            normalize_records(updated)
            temp = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as handle:
                    temp = Path(handle.name)
                    json.dump(updated, handle, ensure_ascii=False, indent=2, allow_nan=False)
                    handle.write("\n")
                # Detect edits by tools that do not take the producer lock.
                try:
                    current = path.read_bytes()
                except FileNotFoundError:
                    current = None
                if current != before:
                    continue
                if current is not None and os.name != "nt":
                    temp.chmod(path.stat().st_mode & 0o777)
                try:
                    os.replace(temp, path)
                except PermissionError as exc:
                    # A reader can briefly block replacement on Windows. Re-read
                    # the source before retrying so any intervening edit is kept.
                    if getattr(exc, "winerror", None) not in {5, 32} or attempt == 2:
                        raise
                    time.sleep(0.05 * (attempt + 1))
                    continue
                return result
            finally:
                if temp is not None:
                    temp.unlink(missing_ok=True)
        raise ValueError("Файл инцидентов изменяется другим процессом. Повторите позже.")


def append_generated_incident(path: Path) -> str:
    def append(rows):
        row = make_incident(rows, datetime.now(UTC))
        return [*rows, row], row["id"]
    return _update_source(Path(path), append)


def publish_shift_frame(path: Path, frame: list[dict], *, reset: bool = False) -> None:
    """Start a fresh shift, then retain live arrivals between timeline events."""
    if reset:
        normalize_records(frame)
        with _source_lock(path):
            write_records(path, frame)
        return

    def merge(rows):
        return [*frame, *(row for row in rows if row.get("dataOrigin") == ORIGIN)], None
    _update_source(path, merge, allow_missing=True)
