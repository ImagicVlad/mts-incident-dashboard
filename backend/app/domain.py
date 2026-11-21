"""Normalization of mentor exports and the independent coordinator queues."""

from datetime import UTC, datetime
from string import Formatter
from typing import Annotated, Any, Literal
from urllib.parse import quote, urlsplit

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationError


COORDINATORS = "КЦ ИТ Координаторы Массовых Инцидентов"
OPEN = frozenset({"Assigned", "WorkInProgress"})
HISTORY = frozenset({"Resolved", "Closed"})
COORDINATOR_STATES = OPEN | {"Research"}
CRITICAL_PRIORITY = 4
HIGH_PRIORITY = 3
STATE_CODES = {0: "Assigned", 2: "WorkInProgress", 7: "Resolved", 10: "Closed", 20: "Research"}
STATE_LABELS = {
    "Assigned": "Назначен", "WorkInProgress": "Выполняется", "Resolved": "Завершен",
    "Closed": "Закрыт", "Research": "Исследование ситуации",
}
PRIORITY_LABELS = {1: "Низкий", 2: "Средний", 3: "Высокий", 4: "Наивысший"}
GROUPS = ("critical", "assigned", "high", "review", "history")


def string_id(value: Any) -> str:
    if type(value) not in (str, int) or not str(value).strip():
        raise ValueError("Ожидается непустой идентификатор.")
    return str(value)


Identifier = Annotated[str, BeforeValidator(string_id)]


class RawIncident(BaseModel):
    """Observed fields needed by the app. Additional source fields are tolerated."""
    model_config = ConfigDict(extra="ignore")
    id: Identifier
    sysId: Identifier | None = None
    productId: Identifier | None = None
    productMasterId: Identifier | None = None
    serviceId: Identifier | None = None
    header: str | None = None
    productName: str | None = None
    service: str | None = None
    description: str | None = None
    shortDescription: str | None = None
    assignedGroupName: str | None = None
    assignedEmployee: str | None = None
    submitDate: str | None = None
    deadline: str | None = None
    completionDate: str | None = None
    lastAssignmentToTeamDateTime: str | None = None
    waitingExitDate: str | None = None
    stateEnum: str | None = None
    state: str | None = None
    stateId: int | str | None = None
    priorityId: int | str | None = None
    priority: str | None = None
    solution: str | None = None
    isNeedUp: bool | None = None
    isReason: bool | None = None
    isEffect: bool | None = None


class Incident(RawIncident):
    stateEnum: str
    priorityId: int | None
    sourceStateEnum: str | None
    sourcePriorityId: int | str | None
    itsmUrl: str | None
    diagnostics: list[str]


class Notification(BaseModel):
    eventId: str
    incidentId: str
    kind: Literal["critical", "assigned", "resolved"]
    label: str
    time: str


class Snapshot(BaseModel):
    epoch: str
    snapshotVersion: int
    serverTime: str
    loadedAt: str | None
    dataUpdatedAt: str | None
    sourceStatus: Literal["ok", "error"]
    sourceError: str | None
    hasSnapshot: bool
    demoMode: bool
    incidents: list[Incident]
    groups: dict[str, list[str]]
    counts: dict[str, int]
    notifications: list[Notification]
    diagnostics: list[str] = Field(default_factory=list)


def utc_string(value: datetime) -> str:
    # Equal precision keeps lexical ordering chronological within the same second.
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def normalize_date(value: str | None, field: str, diagnostics: list[str]) -> str | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
        if parsed.year == 1:
            return None
        if parsed.tzinfo is None:
            diagnostics.append(f"{field}: часовой пояс отсутствует, принят UTC.")
            parsed = parsed.replace(tzinfo=UTC)
        return utc_string(parsed)
    except (ValueError, OverflowError):
        diagnostics.append(f"{field}: некорректная дата.")
        return None


def itsm_link(template: str, record: RawIncident) -> str | None:
    if not template:
        return None
    try:
        values = {"id": record.id, "sysId": record.sysId}
        fields = set()
        for _, key, spec, conversion in Formatter().parse(template):
            if key is None:
                continue
            if key not in values or not values[key] or spec or conversion:
                return None
            fields.add(key)
        # Substitutions belong in a path, query or fragment, never in a host.
        origin = urlsplit(template)
        if not fields or origin.scheme not in {"http", "https"} or not origin.hostname:
            return None
        if "{" in origin.netloc or "}" in origin.netloc or origin.username or origin.password:
            return None
        if "\\" in template or any(ord(c) < 32 for c in template):
            return None
        return template.format(**{k: quote(values[k], safe="") for k in fields})
    except ValueError:
        return None


def numeric_code(value: int | str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def normalize(raw: RawIncident, template: str = "") -> Incident:
    issues = []
    inferred = STATE_CODES.get(numeric_code(raw.stateId))
    if raw.stateEnum in STATE_LABELS:
        state = raw.stateEnum
        if raw.stateId is not None and inferred != state:
            issues.append(f"stateEnum={state} расходится с stateId={raw.stateId}.")
    else:
        state = inferred or raw.stateEnum or "Unknown"
        issues.append(f"stateEnum={raw.stateEnum or 'не указан'}, stateId={raw.stateId}.")
    if raw.state and state in STATE_LABELS:
        if raw.state.casefold().replace("ё", "е") != STATE_LABELS[state].casefold():
            issues.append(f"Подпись статуса «{raw.state}» расходится с {state}.")
    code = numeric_code(raw.priorityId)
    if code not in PRIORITY_LABELS:
        issues.append(f"Неизвестный код приоритета: {raw.priorityId}.")
    elif raw.priority and raw.priority.casefold() != PRIORITY_LABELS[code].casefold():
        issues.append(f"Подпись приоритета «{raw.priority}» расходится с кодом {code}.")
    data = raw.model_dump()
    for field in ("submitDate", "deadline", "completionDate", "lastAssignmentToTeamDateTime", "waitingExitDate"):
        data[field] = normalize_date(data[field], field, issues)
    data.update(stateEnum=state, sourceStateEnum=raw.stateEnum, priorityId=code,
                sourcePriorityId=raw.priorityId, diagnostics=issues, itsmUrl=itsm_link(template, raw))
    return Incident(**data)


def normalize_records(rows: Any, template: str = "") -> dict[str, Incident]:
    if not isinstance(rows, list):
        raise ValueError("Корневой элемент JSON должен быть массивом инцидентов.")
    records = {}
    systems = set()
    for index, row in enumerate(rows, 1):
        try:
            raw = RawIncident.model_validate(row)
        except ValidationError as exc:
            field = ".".join(map(str, exc.errors(include_input=False)[0]["loc"]))
            raise ValueError(f"Запись {index}: некорректное поле {field or '(запись)'}.") from exc
        if raw.id in records:
            raise ValueError(f"Запись {index}: повторяется id.")
        if raw.sysId is not None and raw.sysId in systems:
            raise ValueError(f"Запись {index}: повторяется sysId.")
        records[raw.id] = normalize(raw, template)
        systems.add(raw.sysId)
    return records


def memberships(item: Incident) -> set[str]:
    groups = set()
    if item.stateEnum in OPEN:
        if item.priorityId == CRITICAL_PRIORITY:
            groups.add("critical")
        if item.priorityId == HIGH_PRIORITY:
            groups.add("high")
    if item.stateEnum in COORDINATOR_STATES and item.assignedGroupName == COORDINATORS:
        groups.add("assigned")
    if item.stateEnum == "Research":
        groups.add("review")
    if item.stateEnum in HISTORY:
        groups.add("history")
    return groups


def classify(items: dict[str, Incident]) -> dict[str, list[str]]:
    groups = {key: [] for key in GROUPS}
    for item in items.values():
        for group in memberships(item):
            groups[group].append(item.id)
    for key, ids in groups.items():
        # Nulls last, then deterministic ordering even when deadlines match.
        if key == "history":
            ids.sort()
            ids.sort(key=lambda id_: items[id_].completionDate or "", reverse=True)
        else:
            ids.sort(key=lambda id_: (items[id_].deadline is None, items[id_].deadline or "", id_))
    return groups


def transitions(before: dict[str, Incident], after: dict[str, Incident]):
    for id_, item in sorted(after.items()):
        previous = memberships(before[id_]) if id_ in before else set()
        current = memberships(item)
        if "critical" in current - previous:
            yield id_, "critical", "Новый критический инцидент"
        if "assigned" in current - previous:
            yield id_, "assigned", "Назначен на координаторов"
        if "critical" in previous and item.stateEnum in HISTORY | {"Research"}:
            yield id_, "resolved", "Критический инцидент устранён"
