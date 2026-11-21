"""Resolve a model's display request against the captured incident snapshot."""
import json
import re
from datetime import datetime, timedelta
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from .domain import OPEN


CHAT_PROMPT = """
Ответь JSON-объектом {view, scope, text, ids, includeRelations, allRelations}. Пользователь видит обычный текст и отдельные
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
«Что требует внимания в первую очередь?» — overview, scope=all. «Какие сейчас критические?» —
list, scope=critical. «Какие инциденты на координаторах?» — list, scope=assigned.
Если вместе с обзором спрашивают о связях, используй overview и includeRelations=true.
Для отдельного вопроса о связях используй relations. allRelations=true только при явной просьбе
показать все связи. Для обычного запроса очереди не добавляй связи.
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
    allRelations: bool = False


class Relation(BaseModel):
    ids: list[str]
    reason: str


class ChatContent(BaseModel):
    answer: str
    incidents: list[str] = Field(default_factory=list)
    relations: list[Relation] = Field(default_factory=list)
    total: int | None = None
    metric: Literal["auto", "sla", "status"] = "auto"
    stats: dict[str, int] = Field(default_factory=dict)


# Positive observations of the same failure family. A shared service or team alone is too weak.
SYMPTOMS = {
    "В обеих записях нарушена передача сетевого трафика. Стоит сопоставить затронутые участки сети.":
        r"\b(?:потер(?:и|я|ю|ь) пакетов|трафик проходит с потерями|потерял[аи]? связь с|без внешней связности)\b",
    "В обоих случаях устройства не получили сетевой адрес. Стоит сравнить журналы выдачи адресов.":
        r"\b(?:не получ(?:ают|или|али|ает) (?:ip[- ]?)?адрес|исчерпани\w* пула адресов)\b",
    "В обоих описаниях задерживается доставка кода входа. Стоит проверить время прохождения сообщений.":
        r"\b(?:код (?:для входа|подтверждения) приходит (?:после|с задержкой)|задерж\w* доставк\w* (?:смс[- ]?)?код\w*)\b",
    "Обе записи указывают на повторное начисление. Стоит сверить затронутые операции.":
        r"\b(?:двойно\w* начислен\w*|повторн\w* начислен\w*|начисления [^.]{0,24}дважды)\b",
}
SIGNALS = [(reason, re.compile(pattern, re.I)) for reason, pattern in SYMPTOMS.items()]
FAILURE = re.compile(r"\b(?:недоступ\w*|теря\w*|прерва\w*|потер\w*|дублир\w*|завис\w*|ист[её]к\w*|отказ\w*|таймаут\w*)\b", re.I)
UNCONFIRMED = re.compile(r"\b(?:нет|без|исключены|отсутствуют|не выявлены|не обнаружены|"
                         r"проверить|проверяется|возможны|подозрение на)\s*$", re.I)
DENIED = re.compile(r"\s+(?:нет|отсутствуют|исключены|не (?:выявлены|обнаружены|подтвердились|наблюдаются))\b", re.I)


def _signals(row: dict) -> set[str]:
    observed = set()
    # Repeated, specific reports of a failure can also point to a symptom outside the catalogue.
    title = " ".join((row.get("header") or "").strip(" .").split())
    if (len(re.findall(r"[^\W\d_]{3,}", title)) >= 5 and FAILURE.search(title)
            and not re.search(r"\b(?:нет|подозрение|проверить|возмож\w*|без|не (?:выяв\w*|обнаруж\w*|подтверж\w*))\b", title, re.I)):
        observed.add(f"В обеих карточках описан один симптом — «{title.casefold()}». Стоит сверить затронутые операции.")
    for key in ("header", "shortDescription", "description"):
        for clause in re.split(r"[.!?;\n]|,\s*(?:но|однако)\s+", row.get(key) or ""):
            for reason, pattern in SIGNALS:
                match = pattern.search(clause)
                if match and not (UNCONFIRMED.search(clause[:match.start()]) or DENIED.match(clause[match.end():])):
                    observed.add(reason)
    return observed


def possible_relations(rows: list[dict], focus: set[str], show_all: bool = False) -> list[Relation]:
    timed = sorted(((datetime.fromisoformat(r["submitDate"]), r, signs) for r in rows
                    if r.get("submitDate") and (signs := _signals(r))), key=lambda pair: (pair[0], pair[1]["id"]))
    candidates = []
    for i, (start, a, first_signs) in enumerate(timed):
        for j in range(i + 1, len(timed)):
            end, b, second_signs = timed[j]
            gap = end - start
            if gap > timedelta(hours=1):
                break
            ids = (a["id"], b["id"])
            common = first_signs & second_signs
            if not common or (focus and focus.isdisjoint(ids)):
                continue
            service_key = "serviceId" if a.get("serviceId") and b.get("serviceId") else "service"
            same_service = bool(a.get(service_key) and a[service_key] == b.get(service_key))
            candidates.append((-len(common), not same_service, gap, ids, min(common)))
    ranked = sorted(candidates)
    return [Relation(ids=list(ids), reason=reason) for _, _, _, ids, reason in (ranked if show_all else ranked[:1])]


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
            text = f"Всего уникальных инцидентов: {len(rows)}."
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
        return ChatContent(answer=text, incidents=nearest, total=len(nearest), metric="sla")
    if plan.view == "relations":
        candidates = list(rows.values()) if plan.scope == "selected" and len(selected) == 1 else [rows[i] for i in scope]
        relations = possible_relations(candidates, set(selected) if plan.scope == "selected" else set(), plan.allRelations)
        text = ("Есть записи, которые стоит проверить вместе."
                if relations else "В выбранных записях недостаточно совпадений, чтобы предположить связь.")
        return ChatContent(answer=text, relations=relations)
    if plan.view == "overview":
        if plan.scope == "all":
            history = set(groups["history"])
            critical = set(groups["critical"])
            waiting = [i for i in groups["assigned"] if i not in critical]
            scope = list(dict.fromkeys(groups["critical"][:1] + waiting[:1] + groups["critical"]
                                       + groups["assigned"] + [i for i in scope if i not in history]))
            n = len(rows)
            noun = "инцидентов" if 11 <= n % 100 <= 14 else {1: "инцидент", 2: "инцидента", 3: "инцидента", 4: "инцидента"}.get(n % 10, "инцидентов")
            text = f"В снимке {n} {noun}."
            if groups["critical"] and groups["assigned"]:
                text += " Сейчас в фокусе — критические и назначенные координаторам."
            elif groups["critical"]:
                text += " В первую очередь проверьте критические."
            elif groups["assigned"]:
                text += " В первую очередь проверьте очередь координаторов."
            else:
                text += " Критических и назначенных координаторам сейчас нет."
        relations = possible_relations([rows[i] for i in scope], set(), plan.allRelations) if plan.includeRelations else []
        stats = ({k: len(groups[k]) for k in ("critical", "assigned")} if plan.scope == "all"
                 else {plan.scope: len(scope)} if plan.scope in groups else {})
        return ChatContent(answer=text or f"На контроле: {len(scope)}.", incidents=scope, total=len(scope), relations=relations, stats=stats)
    if plan.view == "list":
        label = GROUP_NAMES.get(plan.scope, "Подходящие инциденты")
        intro = f"{label}: {len(scope)}." if scope else "По запросу нет инцидентов."
        relations = possible_relations([rows[i] for i in scope], set(), plan.allRelations) if plan.includeRelations else []
        if scope and plan.scope in groups:
            intro = f"Очередь «{label}»."
        return ChatContent(answer=intro, incidents=scope, total=len(scope), relations=relations,
                           stats={plan.scope: len(scope)} if plan.scope in groups else {},
                           metric="status" if plan.scope == "assigned" else "auto")
    if plan.view == "detail" and selected:
        row = rows[selected[0]]
        text = text or row.get("description") or row.get("header") or "Описание отсутствует."
        if row["id"] not in text:
            text = f'{row["id"]} — {text}'
        return ChatContent(answer=text)
    return ChatContent(answer=text or ("Подходящие записи:" if selected else "В снимке недостаточно данных для ответа."),
                       incidents=selected)
