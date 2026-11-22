"""Retrieve past incidents for the summary and ground the selected analogy in both records."""

import re

from pydantic import BaseModel, Field, ValidationError

from .domain import HISTORY


class SimilarCase(BaseModel):
    incidentId: str
    header: str
    match: str
    team: str | None
    solution: str


class Evidence(BaseModel):
    number: int = Field(strict=True, ge=1)
    currentQuote: str = Field(min_length=4, max_length=220)
    pastQuote: str = Field(min_length=4, max_length=220)


def symptoms(record: dict, limit: int = 600) -> dict[str, str]:
    return {field: (record.get(field) or "")[:limit]
            for field in ("header", "shortDescription", "description")}


def terms(text: str) -> set[str]:
    return set(re.findall(r"[^\W_]{3,}", text.casefold().replace("ё", "е")))


def past_cases(current: dict, incidents: list[dict], as_of: str) -> list[dict]:
    # The store normalizes timestamps to UTC with equal precision.
    if not current.get("submitDate"):
        return []
    cutoff = min(current["submitDate"], as_of)
    current_symptoms = symptoms(current)
    if not any(current_symptoms.values()):
        return []
    names = ("productName", "service")
    current_terms = terms(" ".join(current_symptoms.values()))
    heading_terms = terms(current_symptoms["header"])
    ranked = []
    for old in incidents:
        completed = old.get("completionDate")
        solution = (old.get("solution") or "").strip()
        if (old["id"] == current["id"] or old["stateEnum"] not in HISTORY or not completed
                or completed >= cutoff or (old.get("submitDate") or "") > completed
                or solution.casefold() in {"", "-", "—", "?", "нет", "не указано"}):
            continue
        old_symptoms = symptoms(old)
        if not any(old_symptoms.values()):
            continue
        shared_context = sum(bool(current.get(key)) and current[key].casefold() == (old.get(key) or "").casefold()
                             for key in names)
        old_terms = terms(" ".join(old_symptoms.values()))
        overlap = len(current_terms & old_terms)
        if not shared_context and overlap < 2:
            continue
        # Prefer shared symptoms over a shared product with different problems.
        heading_overlap = len(heading_terms & terms(old_symptoms["header"]))
        similarity = overlap / max(1, len(current_terms | old_terms))
        score = (min(heading_overlap, 3) + similarity * 2 + shared_context * 0.5, completed, old["id"])
        ranked.append((score, old))
    ranked.sort(key=lambda pair: pair[0], reverse=True)
    return [old for _, old in ranked[:4]]


def grounded_case(choice: object, current: dict, candidates: list[dict]) -> SimilarCase | None:
    try:
        evidence = Evidence.model_validate(choice)
    except ValidationError:
        return None
    if evidence.number > len(candidates):
        return None
    old = candidates[evidence.number - 1]
    quotes = []
    for record, quote, limit in ((current, evidence.currentQuote, 1800), (old, evidence.pastQuote, 600)):
        quote = quote.strip()
        labels = terms((record.get("productName") or "") + " " + (record.get("service") or ""))
        generic = {"сбой", "ошибка", "отказ", "проблема", "аномалия", "неисправность", "проблемы"}
        if not terms(quote) - labels - generic or not any(quote in value for value in symptoms(record, limit).values()):
            return None
        quotes.append(quote)
    current_quote, past_quote = quotes
    match = (f"В обоих описаниях — «{current_quote}»." if current_quote == past_quote
             else f"Сейчас — «{current_quote}». В прошлом случае — «{past_quote}».")
    team = (old.get("assignedGroupName") or "").strip()
    if team.casefold() in {"", "?", "—", "-", "не указана", "не назначена"}:
        team = None
    return SimilarCase(incidentId=old["id"], header=old.get("header") or old["id"], match=match,
                       team=team, solution=old["solution"].strip())
