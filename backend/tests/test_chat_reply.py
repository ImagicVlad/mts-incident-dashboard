import json
from datetime import UTC, datetime, timedelta

import pytest

from app.chat_reply import chat_content
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


def reply(snap, view, **kwargs):
    return chat_content(json.dumps({"view": view, **kwargs}), snap)


def test_full_queues_counts_and_upcoming_deadline(snap):
    result = reply(snap, "list", scope="critical", ids=["INC-001", "INC-999999"])
    assert result.incidents == snap["groups"]["critical"] and result.total == 12
    assert reply(snap, "list", scope="all").total == 13
    overview = reply(snap, "overview")
    assert overview.incidents[0] == "INC-001" and len(set(overview.incidents)) == overview.total == 13
    count = reply(snap, "count")
    assert count.total == 13 and not count.incidents and "13" in count.answer
    assert overview.stats == {"critical": 12, "assigned": 1}
    assert result.stats == {"critical": 12} and not result.relations
    assert reply(snap, "nearest").incidents == ["INC-002"]
    assert "просрочено: 1" in reply(snap, "nearest").answer
    assert not reply(snap, "nearest", scope="assigned").incidents
    assigned = reply(snap, "list", scope="assigned")
    assert assigned.metric == "status" and assigned.incidents == ["INC-001"]


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
    assert reply(snap, "overview", includeRelations=True).relations == [pair]
    assert not reply(snap, "overview").relations
    assert not reply(snap, "relations", scope="selected", ids=["INC-004"]).relations
    assert not reply(snap, "relations", scope="selected", ids=["INC-005"]).relations
    assert not reply(snap, "relations", scope="selected", ids=["INC-006"]).relations
    snap["incidents"][1]["submitDate"] = "2025-01-07T10:00:00Z"
    assert not reply(snap, "relations").relations  # Same priority and status are insufficient.


def test_relations_rank_evidence_and_expand_only_on_request(snap):
    for row in snap["incidents"][:3]:
        row["description"] = "Терминалы не получают адрес."
    best = reply(snap, "relations").relations
    assert len(best) == 1 and best[0].ids == ["INC-001", "INC-002"]
    all_pairs = reply(snap, "relations", allRelations=True).relations
    assert len(all_pairs) == 3 and all_pairs[0] == best[0]
    assert reply(snap, "relations", scope="selected", ids=["INC-002", "INC-003"]).relations[0].ids == ["INC-002", "INC-003"]


def test_focus_shows_one_distinct_waiting_incident_before_the_rest(snap):
    snap["groups"]["assigned"].append("INC-003")
    result = reply(snap, "overview")
    assert result.incidents[:2] == ["INC-001", "INC-003"]
    assert len(set(result.incidents)) == len(result.incidents)


def test_plain_text_unknown_ids_and_broken_envelope(snap):
    fallback = chat_content("Проверьте очередь.\n- INC-001\n- INC-002\n- INC-0019", snap)
    assert fallback.answer == "Проверьте очередь." and fallback.incidents == ["INC-001", "INC-002"]
    assert chat_content("Критические: INC-001, INC-002", snap).answer == "Критические"
    assert not chat_content('{"text":', snap).answer.startswith("{")
    detail = reply(snap, "detail", ids=["INC-001", "INC-0019", "INC-001"], text="У INC-001 задержка операций.")
    assert not detail.incidents and "INC-001" in detail.answer and "задержка операций" in detail.answer
    assert reply(snap, "text", text="Смена началась.").incidents == []
    invalid = reply(snap, "text", text="Передайте INC-0019 инженеру.")
    assert "INC-0019" not in invalid.answer and not invalid.incidents
