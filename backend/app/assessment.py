import re
from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints

from .domain import COORDINATOR_STATES, COORDINATORS


SUMMARY_PROMPT = (
    "Прочитай заголовок, оба описания и решение конкретного incident. Верни JSON на русском: "
    "situation — что произошло и на какой стадии работа; impact — подтверждённое влияние на пользователей "
    "или сервис, с масштабом, если он известен. Если влияние неизвестно, скажи об этом. "
    "check — одна полезная проверка для координатора: укажи, что именно сравнить или запросить "
    "и по какому наблюдаемому признаку оценить результат. Предложи проверку на той же группе объектов, "
    "для которой описан сбой. Учитывай уже выполненные проверки и подтверждённые исправные функции. "
    "При Research проверь гипотезу о причине или повторении; при Resolved/Closed опирайся на результат "
    "и укажи признак повторения. Если профильная команда назначена, адресуй ей проверку. "
    "Для активного сбоя учти приоритет и дедлайн: при minutesUntilDeadline < 0 укажи просрочку "
    "на момент снимка положительной длительностью. "
    "На каждое поле отведи одно-два коротких предложения. Избегай повторения одних фактов "
    "в разных полях. Без Markdown, заголовков внутри полей и перечня реквизитов. Различай факты и предположения. "
    "Назначения предлагай только в полях candidate и rationale. Когда передан routingExamples, "
    "сопоставь симптомы, продукт и сервис с примерами назначений. Если есть обоснованный выбор, "
    "верни в candidate номер примера (целое число от 1), а в rationale — одно конкретное сходство, "
    "объясняющее выбор команды. Пользователь увидит ссылку на карточку: не упоминай порядковый "
    "номер примера в тексте. Пример показывает назначение, но не доказывает общую причину. "
    "При слабом сходстве или отсутствии routingExamples верни candidate: null и rationale: null. "
    "Отдельно сравни симптомы текущего инцидента с pastCases, если список передан. Только при конкретном "
    "совпадении наблюдаемого сбоя выбери один случай. В resolvedCase верни объект с number из pastCases "
    "и двумя короткими дословными непрерывными цитатами: currentQuote из заголовка или описания incident, "
    "pastQuote из заголовка или описания выбранного случая (каждая до 180 символов). Цитируй сам симптом. "
    "Общие продукт, сервис, команда, шаблон регистрации или слово «сбой» не свидетельствуют о сходстве. "
    "Если подходящего случая нет, верни resolvedCase: null. Не переноси причину и решение из истории в оценку "
    "текущего инцидента."
)

ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1600)]


class SummaryNotes(BaseModel):
    situation: ShortText
    impact: ShortText
    check: ShortText


class ModelAssessment(SummaryNotes):
    candidate: int | None = Field(default=None, strict=True)
    rationale: ShortText | None = None
    # Optional evidence is validated separately; a bad citation must not discard the summary.
    resolvedCase: object | None = None


class RoutingAdvice(BaseModel):
    team: str | None = None
    exampleId: str | None = None
    reason: str


class IncidentAssessment(SummaryNotes):
    routing: RoutingAdvice | None = None

    def as_text(self) -> str:
        paragraphs = [self.situation, f"Влияние: {self.impact}"]
        if self.routing:
            team = f"{self.routing.team}. " if self.routing.team else ""
            paragraphs.append(f"Рекомендация по команде: {team}{self.routing.reason}")
        paragraphs.append(f"Что проверить: {self.check}")
        return "\n\n".join(paragraphs)


def specialist(row: dict) -> str | None:
    team = (row.get("assignedGroupName") or "").strip()
    if team.casefold() in {"", "?", "—", "-", "не назначена", "не указана", COORDINATORS.casefold()}:
        return None
    return team


def routing_examples(row: dict, records: list[dict]) -> list[dict] | None:
    """None means no handoff is needed; an empty list means no supporting record was found."""
    if row["stateEnum"] not in COORDINATOR_STATES or specialist(row):
        return None

    def words(*values) -> set[str]:
        return set(re.findall(r"[^\W_]{4,}", " ".join(v or "" for v in values).casefold()))

    symptoms = words(row.get("header"), row.get("description"), row.get("shortDescription"),
                     row.get("service"), row.get("productName"))
    ranked = []
    for other in records:
        team = specialist(other)
        if other["id"] == row["id"] or not team:
            continue
        matches = []
        for name, identifier in (("service", "serviceId"), ("productName", "productId")):
            same_id = row.get(identifier) and row[identifier] == other.get(identifier)
            label = (row.get(name) or "").strip().casefold()
            matches.append(bool(same_id or (label and label == (other.get(name) or "").strip().casefold())))
        vocabulary = words(other.get("header"), other.get("service"), other.get("productName"), team)
        overlap = symptoms & vocabulary
        if any(matches) or len(overlap) >= 2:
            score = (*matches, len(overlap) / max(1, len(vocabulary)))
            ranked.append((score, other))
    ranked.sort(key=lambda pair: pair[1]["id"])
    ranked.sort(key=lambda pair: pair[0], reverse=True)
    examples = []
    seen = set()
    for _, other in ranked:
        team = specialist(other)
        if team in seen:
            continue
        seen.add(team)
        examples.append({"number": len(examples) + 1, "id": other["id"], "team": team,
                         "product": (other.get("productName") or "")[:160],
                         "service": (other.get("service") or "")[:160],
                         "symptom": (other.get("header") or "")[:200]})
        if len(examples) == 6:
            break
    return examples


def assemble_assessment(notes: ModelAssessment, examples: list[dict] | None) -> IncidentAssessment:
    routing = None
    if examples is not None:
        if notes.candidate and 1 <= notes.candidate <= len(examples) and notes.rationale:
            selected = examples[notes.candidate - 1]
            routing = RoutingAdvice(team=selected["team"], exampleId=selected["id"], reason=notes.rationale)
        else:
            routing = RoutingAdvice(reason="По текущим записям уверенно выбрать команду не удалось. Уточните владельца затронутого сервиса.")
    return IncidentAssessment(**notes.model_dump(include={"situation", "impact", "check"}), routing=routing)
