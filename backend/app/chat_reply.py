"""Resolve a model's display request against the captured incident snapshot."""
import json
import re
from datetime import datetime, timedelta
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from .assessment import specialist
from .domain import OPEN


CHAT_PROMPT = """
Ответь JSON-объектом {view, scope, text, ids, includeRelations}. Пользователь видит обычный текст и отдельные
строки записей, которые сервер сам заполняет из JSON. text — прямой ответ на русском без
Markdown, HTML и перечней ID. Не перечисляй реквизиты, уже видимые в строках.
view: count — сколько записей; nearest — ближайший предстоящий срок; overview — обзор смены;
list — перечень; relations — поиск возможной связи; detail — подробности конкретной записи;
text — любой другой вопрос. Для detail дай содержательный ответ по описанию, решению и стадии.
scope: all — вся выборка; critical, high, assigned, review, history — очереди; overdue — активные
просроченные; selected — только записи, отобранные тобой по более узкому вопросу.
Для count, list или nearest без ограничений используй all. Для обзора используй all.
Для полной очереди укажи её scope, сервер возьмёт все записи, даже за пределами selection.
ids — массив точных номеров из снимка в порядке релевантности для selected, detail и text.
Для detail включи запрошенную запись. Для relations без ограничений используй all, для
проверки конкретных записей — selected и их номера. Связи и объяснения вычисляет сервер.
В overview или list ставь includeRelations=true только если сопоставление записей полезно для вопроса.
В count, nearest, relations сервер сам формирует фактический вывод. Не суммируй размеры
пересекающихся очередей. Учитывай предыдущие реплики для уточняющих вопросов.
"""

GROUP_NAMES = {"critical": "Критические", "high": "Высокий приоритет", "assigned": "На координаторах",
               "review": "Исследование", "history": "История решённых"}


class ModelReply(BaseModel):
    view: Literal["count", "nearest", "overview", "list", "relations", "detail", "text"]
    scope: Literal["all", "critical", "high", "assigned", "review", "history", "overdue", "selected"] = "all"
    text: str = ""
    ids: list[str] = Field(default_factory=list)
    includeRelations: bool = False


class Relation(BaseModel):
    ids: list[str]
    reason: str


class ChatContent(BaseModel):
    answer: str
    incidents: list[str] = Field(default_factory=list)
    relations: list[Relation] = Field(default_factory=list)
    total: int | None = None
    metric: Literal["sla", "status"] = "sla"


def possible_relations(rows: list[dict], focus: set[str]) -> list[Relation]:
    # Compare only nearby starts, then rank disjoint pairs by evidence and time gap.
    timed = sorted(((datetime.fromisoformat(r["submitDate"]), r) for r in rows if r.get("submitDate")),
                   key=lambda pair: (pair[0], pair[1]["id"]))
    candidates = []
    for i, (start, a) in enumerate(timed):
        for j in range(i + 1, len(timed)):
            end, b = timed[j]
            gap = end - start
            if gap > timedelta(hours=1):
                break
            ids = (a["id"], b["id"])
            if focus and focus.isdisjoint(ids):
                continue
            service = (a.get("service") or "").strip()
            if a.get("serviceId") and b.get("serviceId"):
                same = a["serviceId"] == b["serviceId"]
            else:
                same = service and service.casefold() == (b.get("service") or "").strip().casefold()
                if a.get("productName") and b.get("productName") and a["productName"] != b["productName"]:
                    same = False
            if same:
                evidence = f"Указан один сервис «{service}»" if service else "Совпадает идентификатор сервиса"
            elif (a.get("productName") and a["productName"] == b.get("productName")
                  and specialist(a) and specialist(a) == specialist(b)):
                shared_symptom = any(a.get(k) == b.get(k) and len((a.get(k) or "").split()) >= 3
                                     for k in ("header", "shortDescription"))
                if not shared_symptom:
                    continue
                evidence = "Совпадают продукт, профильная команда и формулировка проблемы"
            else:
                continue
            minutes = int(gap.total_seconds() // 60)
            interval = f"интервал между записями — {minutes} мин" if minutes else "разница во времени меньше минуты"
            candidates.append((not same, gap, ids, f"{evidence}, {interval}."))
    used = set()
    groups = []
    for _, _, ids, reason in sorted(candidates):
        if used.isdisjoint(ids):
            groups.append(Relation(ids=list(ids), reason=reason))
            used.update(ids)
            if len(groups) == 3:
                break
    return groups


def plain_reply(text: str, known: dict[str, dict]) -> tuple[str, list[str]]:
    """Keep prose, extract bare ID lists, and discard unsupported incident references."""
    known_keys = {key.casefold(): key for key in known}
    alternatives = [re.escape(key) for key in sorted(known, key=len, reverse=True)]
    alternatives.append(r"(?:INC[-_]?\d[\w-]*|[a-z]+[-_]\d[\w-]*|(?:INC|DEMO)-[\w-]+)")
    pattern = re.compile(r"(?<![\w-])(?:" + "|".join(alternatives) + r")(?![\w-])", re.I)
    ids = []
    lines = []
    for line in text.splitlines():
        matches = list(pattern.finditer(line))
        ids.extend(known_keys[m[0].casefold()] for m in matches if m[0].casefold() in known_keys)
        if any(m[0].casefold() not in known_keys for m in matches):
            continue
        if matches and not re.search(r"[^\W\d_]", pattern.sub("", line)):
            continue
        if len(matches) > 1:
            tail = pattern.sub("", line[matches[0].start():])
            if not re.search(r"[^\W\d_]", re.sub(r"\b(?:и|или)\b", "", tail, flags=re.I)):
                line = line[:matches[0].start()].rstrip(" :—-*")
        lines.append(pattern.sub(lambda m: known_keys[m[0].casefold()], line))
    return "\n".join(lines).strip(), list(dict.fromkeys(ids))


def chat_content(raw: str, snapshot: dict) -> ChatContent:
    rows = {row["id"]: row for row in snapshot["incidents"]}
    groups = snapshot["groups"]
    now = datetime.fromisoformat(snapshot["serverTime"])
    due = {key: datetime.fromisoformat(row["deadline"]) for key, row in rows.items()
           if row["stateEnum"] in OPEN and row.get("deadline")}
    overdue = [key for key in sorted(due, key=due.get) if due[key] < now]
    raw = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", raw, flags=re.I).strip()
    try:
        data = json.loads(raw)
    except ValueError:
        data = None
    try:
        plan = ModelReply.model_validate(data)
    except ValidationError:
        # Never dump a broken JSON envelope into the conversation.
        fallback = data.get("text", data.get("answer", "")) if isinstance(data, dict) else raw
        if not isinstance(fallback, str) or fallback.lstrip().startswith(("{", "[")):
            fallback = ""
        text, ids = plain_reply(fallback, rows)
        return ChatContent(answer=text or ("Записи из ответа:" if ids else "Не удалось разобрать ответ. Уточните вопрос."),
                           incidents=ids, total=len(ids) if ids else None)

    text, mentioned = plain_reply(plan.text, rows)
    selected = list(dict.fromkeys(i for i in [*plan.ids, *mentioned] if i in rows))
    if plan.scope == "selected":
        scope = selected
    elif plan.scope == "overdue":
        scope = overdue
    elif plan.scope in groups:
        scope = groups[plan.scope]
    else:
        ordered = [i for group in GROUP_NAMES for i in groups[group]]
        scope = list(dict.fromkeys(ordered + list(rows)))

    if plan.view == "count":
        if plan.scope == "all":
            distribution = ", ".join(f"«{name}» — {len(groups[k])}" for k, name in GROUP_NAMES.items())
            text = f"Всего уникальных инцидентов: {len(rows)}. По категориям: {distribution}. Категории могут пересекаться."
        else:
            label = GROUP_NAMES.get(plan.scope, "Просроченные" if plan.scope == "overdue" else "По запросу")
            text = f"{label}: {len(scope)}."
        return ChatContent(answer=text, total=len(scope))
    if plan.view == "nearest":
        upcoming = [i for i in scope if i in due and due[i] >= now]
        nearest = [min(upcoming, key=due.get)] if upcoming else []
        text = "Первым истекает срок у этого инцидента." if nearest else "В выборке нет активного инцидента с предстоящим сроком."
        late = sum(i in due and due[i] < now for i in scope)
        if late:
            text += f" Уже просрочено: {late}."
        return ChatContent(answer=text, incidents=nearest, total=len(nearest))
    if plan.view == "relations":
        candidates = list(rows.values()) if plan.scope == "selected" and len(selected) == 1 else [rows[i] for i in scope]
        relations = possible_relations(candidates, set(selected) if plan.scope == "selected" else set())
        text = ("Есть записи, которые стоит проверить вместе. Общая причина пока не подтверждена."
                if relations else "В выбранных записях недостаточно совпадений, чтобы предположить связь.")
        return ChatContent(answer=text, relations=relations)
    if plan.view == "overview":
        if plan.scope == "all":
            history = set(groups["history"])
            scope = [i for i in scope if i not in history]
        relations = possible_relations([rows[i] for i in scope], set()) if plan.includeRelations else []
        return ChatContent(answer=text or f"На контроле: {len(scope)}.", incidents=scope, total=len(scope), relations=relations)
    if plan.view == "list":
        label = GROUP_NAMES.get(plan.scope, "Подходящие инциденты")
        intro = f"{label}: {len(scope)}." if scope else "По запросу нет инцидентов."
        relations = possible_relations([rows[i] for i in scope], set()) if plan.includeRelations else []
        return ChatContent(answer=intro, incidents=scope, total=len(scope), relations=relations,
                           metric="status" if plan.scope == "assigned" else "sla")
    return ChatContent(answer=text or ("Подходящие записи:" if selected else "В снимке недостаточно данных для ответа."),
                       incidents=selected)
