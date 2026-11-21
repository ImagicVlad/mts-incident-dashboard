"""Resolve a model's display request against the captured incident snapshot."""
import json
import re
from datetime import datetime, timedelta
from typing import Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, ValidationError

from .domain import OPEN


CHAT_PROMPT = """
Ты — собеседник и помощник дежурного координатора МТС. Отвечай по-русски. Для приветствия, «Как дела?»,
общего разговора или объяснения понятия просто ответь человеку. Не превращай беседу в сводку смены.
У тебя есть функция lookup_incidents. САМ вызывай её для любого вопроса о фактическом состоянии смены:
записей в сообщении пользователя быть не должно, их прочитает функция. Никогда не проси пользователя вызвать её.
Ниже описан запрос к функции. text — необязательное краткое введение, например «Этими инцидентами занимаются:».
lookup_incidents возвращает актуальные результаты, не придумывай числа и ID. Не выдавай внутренние имена полей.
Если спрашивают, какие именно инциденты в категории — возвращай сам перечень (display=list, scope этой категории).
Кто решает, кто занимается — display=owners. Эти вопросы требуют строк каждой записи, одного числа недостаточно.
Только «сколько» требует подсчёта. «Какие из них» применяет фильтр к предыдущему перечню, сохраняя строки.
Для общего вопроса о рабочей обстановке (какие вообще есть проблемы, какие задачи в целом) запрашивай
operation=overview. Для точного числа — operation=count и scope. Идентификаторы полей функции:
scope: all (по умолчанию), active (Assigned и WorkInProgress), critical, high, assigned, review,
history, previous (точный упорядоченный результат последнего предметного ответа).
ids: точные ID для отбора; position: порядковый номер с единицы в previous, например для «второй»;
search: буквальный фрагмент названия, продукта, команды или описания; overdue: true — только активные с нарушенным SLA.
operation: overview (рабочая обстановка, все четыре очереди), count (точное число), nearest (ближайший ещё не наступивший срок), relations (проверить связь).
display: list — запрошенный перечень, owners — кто отвечает, priority — только запрос порядка действий,
ids — пользователь просил исключительно номера, text — без карточек. При запросе перечня с числом N задай limit=N,
при явном «покажи все» задай showAll=true. Число результатов по умолчанию не ограничено.
withRelations=true — если вместе с перечнем нужны связи, allRelations=true — если явно просят все связи.
analyze=true — получить факты и затем подробно ответить о записи, причинах, сравнении или дать рекомендации.
Для вопроса «почему они связаны» анализируй записи предыдущей пары. Для ответа об отдельных записях
по данным используй query, не угадывай. Для действий используй display=priority и анализ.
Если запрос однозначно продолжает перечень, используй previous. При неоднозначности уточни словами.
Поле text — собственный естественный ответ или введение к запрошенному перечню. В нём можно поставить
{count} для проверенного размера выборки. Вычисления выполняет сервер. Не перечисляй ID вместо ответа.
"""

ANALYSIS_PROMPT = """
Ответь на последний вопрос своими словами на русском. Ты получил результат запроса к актуальным данным.
JSON {"text":"ответ"}. Отвечай по существу, сохраняй смысл истории. Только подтверждённые ID и факты
из selection, groups, counts и relations. null означает отсутствие сведений. Для ссылки упомяни ID,
интерфейс добавит название. Не выдумывай названий. Различай наблюдение, предположение и действие.
Про порядок действий объясни, за какую запись взяться, почему (влияние, оставшееся время, передача),
что проверить дальше. Владелец и исполнитель — разные поля. Research — разбор причин уже устранённого сбоя.
Если вопрос о связях, обоснуй гипотезу симптомами обеих записей и предложи проверку. Если нет кандидатов,
скажи, чего не хватает. Не утверждай общую причину. Избегай повторения карточек и служебных меток.
"""

OVERVIEW_PROMPT = """
Ответь на последний вопрос одним небольшим абзацем, 2–3 предложения. JSON {"text":"ответ"}.
Опиши, чем заняться смене, по четырём очередям из workload, включая пустые. Очереди пересекаются.
Счётчики рассчитаны сервером. Клиенту нужен смысл происходящего. При необходимости приведи один пример.
Не перечисляй записи, названия технических полей и сведения, о которых пользователь не спрашивал.
"""

GROUP_NAMES = {"critical": "Критические", "high": "Высокий приоритет", "assigned": "На координаторах",
               "review": "Исследование", "history": "История решённых"}

Display = Literal["text", "list", "owners", "priority", "ids"]


class Query(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scope: Literal["all", "active", "critical", "high", "assigned", "review", "history", "previous"] = "all"
    ids: list[str] | None = None
    position: int | None = Field(default=None, ge=1)
    search: str = ""
    overdue: bool = False
    operation: Literal["count", "nearest", "relations", "overview"] | None = Field(default=None, description="Оставь пустым для списков, ответственных, подробностей и рекомендаций. count только для вопроса о числе; overview только для общей обстановки по всем очередям.")
    display: Display = Field(default="text", description="Какие записи? list. Кто отвечает (команда или человек)? owners. Что делать первым? priority. Объяснение одной проблемы или общий обзор? text.")
    limit: int | None = Field(default=None, ge=1)
    showAll: bool = False
    withRelations: bool = False
    allRelations: bool = False
    analyze: bool = False


class ChatPlan(BaseModel):
    text: str = Field(default="", validation_alias=AliasChoices("text", "answer"))
    query: Query | None = None


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
    display: Display = "text"
    references: list[str] = Field(default_factory=list)
    showAll: bool = False


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
NETWORK_PATH = re.compile(r"\b(?:агрегаци\w*|межузлов\w*|vpn[- ]канал\w*|маршрутизатор\w*)", re.I)
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


def _mentions_network_path(row: dict) -> bool:
    description = " ".join(row.get(k) or "" for k in ("header", "shortDescription", "description"))
    return bool(NETWORK_PATH.search(description))


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
            same_product = bool(a.get("productName") and a["productName"] == b.get("productName"))
            path_evidence = any("сетевого трафика" in reason for reason in common) and _mentions_network_path(a) and _mentions_network_path(b)
            if not (len(common) > 1 or same_service or same_product or path_evidence):
                continue
            candidates.append((-len(common), not same_service, not path_evidence, gap, ids, min(common)))
    ranked = sorted(candidates)
    return [Relation(ids=list(ids), reason=reason) for *_, ids, reason in (ranked if show_all else ranked[:1])]


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
        if any(m[0].casefold() not in known_keys for m in matches):
            continue
        ids.extend(known_keys[m[0].casefold()] for m in matches)
        if matches and not re.search(r"[^\W\d_]", pattern.sub("", line)):
            continue
        if len(matches) > 1:
            tail = pattern.sub("", line[matches[0].start():])
            if not re.search(r"[^\W\d_]", re.sub(r"\b(?:и|или)\b", "", tail, flags=re.I)):
                line = line[:matches[0].start()].rstrip(" :—-*")
        lines.append(pattern.sub(lambda m: known_keys[m[0].casefold()], line))
    return "\n".join(lines).strip(), list(dict.fromkeys(ids))


def read_plan(raw: str) -> ChatPlan:
    raw = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", raw, flags=re.I).strip()
    if not raw.startswith(("{", "[")):
        return ChatPlan(text=raw)
    try:
        return ChatPlan.model_validate_json(raw)
    except ValidationError:
        try:
            data = json.loads(raw)
        except ValueError:
            data = {}
        if isinstance(data, dict) and "query" in data:
            raise
        prose = data.get("text", data.get("answer")) if isinstance(data, dict) else None
        return ChatPlan(text=prose if isinstance(prose, str) else "")


def prose_answer(text: str, rows: dict[str, dict]) -> ChatContent:
    prose, refs = plain_reply(text, rows)
    # Give standalone references a verified title. Keep prose intact when the title is already present.
    for key in refs:
        title = rows[key].get("header")
        if title and key in prose and title.casefold() not in prose.casefold():
            prose = re.sub(r"(?<![\w-])" + re.escape(key) + r"(?![\w-])",
                           lambda _: f"«{title}» ({key})", prose, count=1)
    bare = [key for key in refs if key not in prose]
    return ChatContent(answer=prose or ("Вот эти записи." if bare else "Уточните, пожалуйста, вопрос."),
                       references=refs, incidents=bare, display="list" if bare else "text")


def select_records(query: Query, snapshot: dict, previous: list[str]) -> tuple[list[str], int]:
    rows = {r["id"]: r for r in snapshot["incidents"]}
    active = {key for key, row in rows.items() if row["stateEnum"] in OPEN}
    now = datetime.fromisoformat(snapshot["serverTime"])
    due = {key: datetime.fromisoformat(rows[key]["deadline"]) for key in active if rows[key].get("deadline")}
    groups = snapshot["groups"]
    if query.scope == "previous" or query.position is not None:
        ids = previous
    elif query.scope in groups:
        ids = groups[query.scope]
    else:
        ids = [key for key in rows if query.scope != "active" or key in active]
    if query.position is not None:
        ids = ids[query.position - 1:query.position]
    if query.ids is not None:
        allowed = set(ids)
        canonical = {key.casefold(): key for key in allowed}
        ids = [canonical[key.casefold()] for key in query.ids if key.casefold() in canonical]
    ids = list(dict.fromkeys(key for key in ids if key in rows))
    if query.search.strip():
        needle = query.search.strip().casefold()
        fields = ("header", "productName", "assignedGroupName", "assignedEmployee", "service", "shortDescription", "description")
        ids = [key for key in ids if any(needle in (rows[key].get(f) or "").casefold() for f in fields)]
    if query.overdue:
        ids = [key for key in ids if key in due and due[key] < now]
    if query.operation == "nearest":
        ids = sorted((key for key in ids if key in due and due[key] >= now), key=due.get)[:1]
    if query.display == "priority":
        critical, assigned = set(groups["critical"]), set(groups["assigned"])
        ids = [key for key in ids if key in active or key in assigned]
        ids.sort(key=lambda key: (key not in critical, key not in due or due[key] >= now, key not in active,
                                  -(rows[key].get("priorityId") or 0), key not in assigned,
                                  key not in due, due.get(key), key))
    return ids[:query.limit], len(ids)


def query_answer(plan: ChatPlan, snapshot: dict, previous: list[str]) -> ChatContent:
    query = plan.query
    rows = {r["id"]: r for r in snapshot["incidents"]}
    if query is None:
        return prose_answer(plan.text, rows)
    ids, total = select_records(query, snapshot, previous)
    if (query.scope == "previous" or query.position is not None) and not previous:
        return ChatContent(answer="Какой перечень вы имеете в виду? Уточните категорию или номер инцидента.")
    if query.position is not None and query.position > len(previous):
        return ChatContent(answer="В предыдущем перечне нет записи под таким номером. Уточните номер или название.")
    text = plain_reply(plan.text.replace("{count}", str(total)), rows)[0]
    if query.operation == "overview" and query.display == "text":
        ongoing = {key for key, row in rows.items() if row["stateEnum"] in OPEN or row["stateEnum"] == "Research"}
        return ChatContent(answer="", total=len(ongoing))
    if query.operation == "count" and query.display == "text":
        label = ("Просроченных в выборке" if query.overdue else GROUP_NAMES.get(
            query.scope, "Активных инцидентов" if query.scope == "active" else "Инцидентов в выборке"))
        return ChatContent(answer=text if "{count}" in plan.text and text else f"{label}: {total}.",
                           references=ids, total=total)
    if query.display == "ids":
        return ChatContent(answer="\n".join(ids) or "Подходящих инцидентов нет.", references=ids, total=total, display="ids")
    if not ids:
        return ChatContent(answer=("Предстоящих сроков у активных инцидентов в этой выборке нет."
                                   if query.operation == "nearest" else "Подходящих записей в текущих данных нет."), total=0)
    relations = []
    if query.withRelations or query.operation == "relations":
        single = len(ids) == 1 and (query.ids or query.scope == "previous")
        candidates = list(rows.values()) if single else [rows[key] for key in ids]
        relations = possible_relations(candidates, set(ids) if single else set(), query.allRelations)
    if query.operation == "relations":
        refs = list(dict.fromkeys(key for pair in relations for key in pair.ids))
        return ChatContent(answer=(text or "Эти записи стоит проверить вместе.") if relations else
                           "Общих технических признаков недостаточно, чтобы предположить связь.",
                           references=refs, relations=relations, total=total)
    display = "list" if query.operation == "nearest" else query.display
    cards = ids if display in ("list", "owners", "priority") else []
    stats = {query.scope: total} if display == "list" and query.scope in snapshot["groups"] and query.operation != "nearest" else {}
    return ChatContent(answer=text or ("Ближайший предстоящий срок." if query.operation == "nearest" else ""),
                       incidents=cards, references=ids, total=total, display=display, relations=relations,
                       stats=stats, showAll=query.showAll, metric="sla" if query.operation == "nearest" else "auto")
