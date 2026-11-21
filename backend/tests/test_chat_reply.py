from datetime import UTC, datetime, timedelta

import pytest

from app.chat_reply import ChatPlan, Query, query_answer, read_plan
from app.domain import COORDINATORS, classify, normalize_records


@pytest.fixture
def snap():
    now = datetime(2026, 1, 7, 10, tzinfo=UTC)
    def stamp(minutes):
        return (now + timedelta(minutes=minutes)).isoformat()
    rows = [{"id": f"INC-{i:03}", "header": f"Задержка операций {i}", "stateEnum": "Assigned",
             "priorityId": 4, "productName": "Платежи", "service": f"Сервис {i}",
             "submitDate": stamp(-40 + i), "deadline": stamp(i - 2)} for i in range(1, 14)]
    rows[0]["assignedGroupName"] = COORDINATORS
    rows[1]["service"] = rows[0]["service"]
    rows[2]["stateEnum"] = "Research"
    records = normalize_records(rows)
    groups = classify(records, now)
    return {"incidents": [r.model_dump() for r in records.values()], "groups": groups, "serverTime": stamp(0)}


def reply(snap, operation=None, *, previous=(), text="", **kwargs):
    plan = ChatPlan(text=text, query=Query(operation=operation, **kwargs))
    return query_answer(plan, snap, list(previous))


def test_records_are_complete_and_scoped_to_the_question(snap):
    critical = reply(snap, scope="critical", display="list", text="Вот критические инциденты.")
    assert critical.incidents == snap["groups"]["critical"] and critical.total == 12
    assert critical.answer == "Вот критические инциденты." and not critical.relations
    owners = reply(snap, scope="previous", previous=critical.references, display="owners")
    assert owners.display == "owners" and owners.incidents == critical.incidents
    late = reply(snap, scope="previous", previous=owners.references, overdue=True, display="list")
    assert late.incidents == ["INC-001"]
    second = reply(snap, scope="previous", position=2, previous=owners.references)
    assert second.references == owners.references[1:2]
    assert not reply(snap, scope="previous", position=2, previous=late.references).references
    assert not reply(snap, scope="previous", display="owners").references
    assert reply(snap, "count", scope="active").total == 12
    assert reply(snap, "count", scope="all").total == 13
    assert reply(snap, "nearest").incidents == ["INC-002"]
    assert not reply(snap, "nearest", scope="assigned").incidents
    assert reply(snap, scope="critical", display="ids").answer.splitlines() == critical.incidents
    limited = reply(snap, scope="critical", display="list", limit=3)
    assert limited.total == 12 and limited.incidents == critical.incidents[:3]
    assert reply(snap, scope="assigned", display="list", showAll=True).showAll
    assert not reply(snap, "overview").incidents


def test_related_pairs_need_evidence(snap):
    assert not reply(snap, "relations").relations  # Same service and nearby starts are insufficient.
    snap["incidents"][0]["description"] = "Мониторинг фиксирует потери пакетов."
    snap["incidents"][1]["shortDescription"] = "Узел потерял связь с агрегацией."
    snap["incidents"][3]["description"] = "Потери пакетов не обнаружены."
    snap["incidents"][4]["description"] = "Трафик проходит без потерь пакетов."
    snap["incidents"][5]["description"] = "Инженер предлагает проверить потери пакетов."
    related = reply(snap, "relations")
    assert len(related.relations) == 1 and not related.incidents
    pair = related.relations[0]
    assert pair.ids == ["INC-001", "INC-002"] and "сетевого трафика" in pair.reason
    assert reply(snap, display="priority", withRelations=True).relations == [pair]
    assert not reply(snap, "overview").relations
    assert not reply(snap, "relations", ids=["INC-004"]).relations
    assert not reply(snap, "relations", ids=["INC-005"]).relations
    assert not reply(snap, "relations", ids=["INC-006"]).relations
    snap["incidents"][1].update({"service":"Другой сервис", "serviceId":None, "productName":"Другой продукт"})
    assert not reply(snap, "relations").relations  # A generic symptom alone does not connect unrelated services.
    snap["incidents"][1]["submitDate"] = "2025-01-07T10:00:00Z"
    assert not reply(snap, "relations").relations  # Same priority and status are insufficient.


def test_relations_rank_evidence_and_expand_only_on_request(snap):
    for row in snap["incidents"][:3]:
        row["description"] = "Терминалы не получают адрес."
    best = reply(snap, "relations").relations
    assert len(best) == 1 and best[0].ids == ["INC-001", "INC-002"]
    all_pairs = reply(snap, "relations", allRelations=True).relations
    assert len(all_pairs) == 3 and all_pairs[0] == best[0]
    assert reply(snap, "relations", ids=["INC-002", "INC-003"]).relations[0].ids == ["INC-002", "INC-003"]


def test_action_order_uses_real_deadlines_and_excludes_resolved_work(snap):
    result = reply(snap, display="priority")
    assert result.incidents[0] == "INC-001"
    assert "INC-003" not in result.incidents
    assert len(set(result.incidents)) == len(result.incidents)


def test_plain_answers_and_invalid_ids(snap):
    def answer(raw):
        return query_answer(read_plan(raw), snap, [])
    assert answer('{"answer":"Всё хорошо!"}').answer == "Всё хорошо!"
    greeting = answer("Спасибо, что спросили!")
    assert greeting.answer == "Спасибо, что спросили!" and not greeting.incidents
    fallback = answer("Проверьте очередь.\n- INC-001\n- INC-002\n- INC-0019")
    assert fallback.answer == "Проверьте очередь." and fallback.incidents == ["INC-001", "INC-002"]
    assert not answer('{"text":').answer.startswith("{")
    assert "Задержка операций 1" in answer("Проверьте INC-001.").answer
    assert "INC-0019" not in answer("Передайте INC-0019 инженеру.").answer
