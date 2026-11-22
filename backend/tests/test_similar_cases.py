import json
from types import SimpleNamespace

import httpx
import pytest

from app.ai import AIService
from app.config import Settings
from app.similar_cases import grounded_case, past_cases


CURRENT = {"id": "today", "stateEnum": "WorkInProgress", "submitDate": "2026-01-05T09:00:00Z",
           "header": "Вход", "description": "Код доступа приходит после истечения срока.",
           "productName": "Кабинет"}
PAST = {"id": "old", "stateEnum": "Closed", "submitDate": "2026-01-02T14:00:00Z",
        "completionDate": "2026-01-02T22:00:00Z", "header": "Просроченные коды",
        "shortDescription": "Код доступа приходит с опозданием.", "productName": "Кабинет",
        "assignedGroupName": "Доставка сообщений", "solution": "Сняли блокировку очереди сообщений."}
NOW = "2026-01-05T11:00:00Z"
CHOICE = {"number": 1, "currentQuote": CURRENT["description"], "pastQuote": PAST["shortDescription"]}


@pytest.mark.parametrize("change", [
    {"id": "today"}, {"stateEnum": "Research"}, {"stateEnum": "Assigned"},
    {"completionDate": None}, {"completionDate": CURRENT["submitDate"]},
    {"completionDate": "2026-01-06T00:00:00Z"}, {"submitDate": "2026-01-04T11:00:00Z"},
    {"solution": " "},
])
def test_only_previously_resolved_with_recorded_solution(change):
    assert past_cases(CURRENT, [PAST | change], NOW) == []


@pytest.mark.parametrize("choice", [
    None, {"number": "1"}, CHOICE | {"number": 3}, CHOICE | {"currentQuote": "Выдуманный симптом"},
    CHOICE | {"pastQuote": "Нет в прошлом описании"},
])
def test_missing_or_unsupported_evidence_omits_suggestion(choice):
    assert grounded_case(choice, CURRENT, [PAST]) is None


def test_mention_of_product_alone_does_not_prove_similarity():
    past = PAST | {"header": "Кабинет"}
    assert grounded_case(CHOICE | {"pastQuote": "Кабинет"}, CURRENT, [past]) is None


@pytest.mark.asyncio
async def test_summary_uses_one_request_and_source_facts_even_with_assigned_team():
    current = CURRENT | {"assignedGroupName": "Авторизация"}
    snapshot = {"hasSnapshot": True, "serverTime": NOW, "epoch": "e", "snapshotVersion": 3,
                "sourceStatus": "ok", "incidents": [current, PAST]}
    calls = []

    def provider(request):
        payload = json.loads(request.content)
        calls.append(payload)
        context = json.loads(payload["messages"][1]["content"])
        assert "routingExamples" not in context
        assert len(context["pastCases"]) == 1
        assert "solution" not in context["pastCases"][0]
        notes = {"situation": "Задержка авторизации.", "impact": "Доступ ограничен.", "check": "Сверить очередь.",
                 "resolvedCase": CHOICE | {"team": "Придуманная команда", "solution": "Придуманное решение"}}
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(notes)}}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
        service = AIService(Settings(_env_file=None, llm_api_key="test"), SimpleNamespace(snapshot=lambda: snapshot), client)
        result = await service.summary(current["id"])
        assert await service.summary(current["id"]) == result
    assert len(calls) == 1
    case = result.similarCase
    assert case.incidentId == PAST["id"] and case.header == PAST["header"]
    assert case.team == PAST["assignedGroupName"] and case.solution == PAST["solution"]
    assert CHOICE["currentQuote"] in case.match and CHOICE["pastQuote"] in case.match
