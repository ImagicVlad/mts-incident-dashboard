import json
from unittest.mock import Mock

import httpx
import pytest

from app.ai import AIService, ChatInput, Message, OFF_TOPIC_REPLY, chat_context
from app.config import Settings


def incident(number, product=None, service=None, title=None):
    return {"id": f"INC-{number}", "stateEnum": "Assigned", "productName": product,
            "service": service, "header": title}


@pytest.fixture
def shift():
    # The two matching pairs are outside the normal chat's first eight results.
    records = [incident(i) for i in range(100, 110)] + [
        incident(201, "Платежи", "Шлюз", "Задержка подтверждения операций шлюзом"),
        incident(202, "Платежи", "Шлюз", "Задержка подтверждения операций ночью"),
        incident(301, "Видеосвязь", "Запись", "Пропускаются кадры при экспорте"),
        incident(302, "Видеосвязь", "Запись", "Пропускаются кадры в видеозаписи"),
    ]
    return {"epoch": "shift", "snapshotVersion": 4, "serverTime": "2030-01-01T12:00:00Z",
            "sourceStatus": "ok", "hasSnapshot": True, "incidents": records, "counts": {},
            "deadlineOrder": [], "groups": dict.fromkeys(("critical", "assigned", "high", "review", "history"), [])}


def context(shift, question):
    return chat_context(shift, [Message(role="user", content=question)])


def test_general_question_finds_evidence_beyond_shortlist(shift):
    data = context(shift, "А в целом есть у нас связанные инциденты?")
    assert all(int(row["id"].split("-")[1]) < 200 for row in data["selection"])
    pairs = {frozenset(candidate["ids"]) for candidate in data["relatedCandidates"]}
    assert frozenset(("INC-201", "INC-202")) in pairs
    assert frozenset(("INC-301", "INC-302")) in pairs
    assert all(len(pair) == 2 for pair in pairs)
    assert len(pairs) == len(data["relatedCandidates"])
    assert all(candidate["evidence"] for candidate in data["relatedCandidates"])


def test_named_incident_scopes_candidates_but_ordinary_question_is_unchanged(shift):
    data = context(shift, "Есть похожие инциденты на INC-301?")
    assert data["relatedCandidates"]
    assert all("INC-301" in candidate["ids"] for candidate in data["relatedCandidates"])
    assert context(shift, "Связаны ли INC-201 и INC-301?")["relatedCandidates"] == []
    assert "relatedCandidates" not in context(shift, "Какой ближайший срок?")


def test_missing_evidence_produces_empty_candidate_list(shift):
    shift["incidents"] = [incident(100), incident(101, "Платежи"), incident(102, "Платежи")]
    assert context(shift, "Какие инциденты могут быть связаны?")["relatedCandidates"] == []


@pytest.mark.parametrize("scope,selected", [("shift", [1, 1, 999]), ("shift", [999]), ("off_topic", [1])])
async def test_model_can_select_only_grounded_pairs(shift, scope, selected):
    question = "Какие инциденты могут быть связаны с INC-201?"

    def provider(request):
        payload = json.loads(request.content)
        data = json.loads(payload["messages"][1]["content"])
        assert set(data["relatedCandidates"][0]["ids"]) == {"INC-201", "INC-202"}
        reply = {"scope": scope, "answer": "INC-999 якобы подтверждён", "related": selected}
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(reply)}}]})

    settings = Settings(_env_file=None, llm_api_key="test-key")
    async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
        service = AIService(settings, Mock(snapshot=lambda: shift), client)
        result = await service.chat(ChatInput(messages=[Message(role="user", content=question)]))
    assert "INC-999" not in result.answer
    if scope == "off_topic":
        assert result.answer == OFF_TOPIC_REPLY
    elif 1 in selected:
        assert "INC-201" in result.answer and "INC-202" in result.answer
        assert any(word in result.answer.lower() for word in ("возмож", "гипотез", "предпол", "провер"))
    else:
        assert "INC-202" not in result.answer and result.answer.strip()


async def test_direct_question_with_legacy_reply_shows_candidates(shift):
    def provider(request):
        old_reply = {"scope": "shift", "answer": "Поле связей не передано."}
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(old_reply)}}]})

    settings = Settings(_env_file=None, llm_api_key="test-key")
    async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
        service = AIService(settings, Mock(snapshot=lambda: shift), client)
        result = await service.chat(ChatInput(messages=[
            Message(role="user", content="А в целом есть у нас связанные инциденты?")]))
    assert "INC-201" in result.answer and "INC-202" in result.answer
    assert "Поле связей" not in result.answer
