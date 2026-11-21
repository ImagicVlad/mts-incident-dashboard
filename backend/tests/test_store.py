import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.domain import COORDINATORS, Incident, Snapshot, classify, normalize_records
from app.store import Store


def row(id_="INC-01", **values):
    return {"id": id_, "stateEnum": "Assigned", "stateId": 0, "state": "Назначен",
            "priorityId": 2, "priority": "Средний", **values}


def save(path, rows):
    # Replacement, as performed by many editors and import jobs.
    staging = path.with_suffix(".staging")
    staging.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    staging.replace(path)


def test_source_normalization_and_missing_values():
    number = 9000000000000000123
    items = normalize_records([row(
        sysId=number, serviceId=number, productId=number,
        deadline="2026-08-09T20:01:02.123456+03:00", waitingExitDate="0001-01-01T00:00:00",
        isNeedUp=None, solution="Описание шага", productUrl=None, newAttribute={"enabled": True},
    )])
    item = items["INC-01"]
    assert isinstance(item, Incident)
    assert item.sysId == item.productId == item.serviceId == str(number)
    assert item.deadline == "2026-08-09T17:01:02.123456Z"
    assert item.waitingExitDate is None and item.isNeedUp is None
    assert item.stateEnum == "Assigned" and not item.diagnostics
    boolean = normalize_records([row("N", isNeedUp=False), row("Y", isNeedUp=True)])
    assert boolean["N"].isNeedUp is False and boolean["Y"].isNeedUp is True


def test_status_precedence_fallback_and_unknown_values():
    items = normalize_records([
        row("R", stateEnum="Research", stateId=7, state="Завершен", completionDate="2026-01-02T00:00:00Z"),
        row("7", stateEnum=None, stateId=7, state="Завершен"),
        row("10", stateEnum=None, stateId=10, state="Закрыт"),
        row("20", stateEnum=None, stateId=20, state="Исследование ситуации"),
        row("X", stateEnum="Paused", stateId=99, state="На паузе", priorityId="experimental"),
    ])
    assert [items[id_].stateEnum for id_ in ("R", "7", "10", "20", "X")] == [
        "Research", "Resolved", "Closed", "Research", "Paused",
    ]
    assert len(items["R"].diagnostics) == 2
    assert items["X"].sourcePriorityId == "experimental"
    assert items["X"].priorityId is None and items["X"].diagnostics
    assert all("X" not in group for group in classify(items).values())


@pytest.mark.parametrize("rows", [None, {}, [row(), row()], [row("A", sysId="1"), row("B", sysId=1)], [{}]])
def test_invalid_export(rows):
    with pytest.raises(ValueError):
        normalize_records(rows)


def test_independent_groups_and_history():
    items = normalize_records([
        row("C", priorityId=4, assignedGroupName=COORDINATORS),
        row("H", priorityId=3, assignedGroupName=None),
        row("R", stateEnum="Research", completionDate="2026-01-02T00:00:00Z", assignedGroupName=COORDINATORS),
        row("S", stateEnum="Resolved", priorityId=4, assignedGroupName=COORDINATORS),
    ])
    assert classify(items) == {"critical": ["C"], "assigned": ["C", "R"], "high": ["H"],
                               "review": ["R"], "history": ["S"]}


def test_external_link_requires_valid_template_and_encodes_ids():
    source = [row("INC /1", sysId=1234512345123456789)]
    result = normalize_records(source, "https://example.org/view/{sysId}?n={id}")["INC /1"]
    assert result.itsmUrl == "https://example.org/view/1234512345123456789?n=INC%20%2F1"
    for template in ("", "file:///notes/{id}", "https://{id}.invalid/", "https://example.org/{bad}"):
        assert normalize_records(source, template)["INC /1"].itsmUrl is None


def test_nearby_deadlines_sort_chronologically_with_null_last():
    items = normalize_records([
        row("A", priorityId=4, deadline="2027-01-01T00:00:00.123Z"),
        row("B", priorityId=4, deadline="2027-01-01T00:00:00Z"),
        row("C", priorityId=4),
    ])
    assert classify(items)["critical"] == ["B", "A", "C"]


def test_events_content_comparison_and_recovery(tmp_path):
    async def scenario():
        source = tmp_path / "incidents.json"
        store = Store(source, False)
        await store.reload()
        unavailable = store.snapshot()
        assert unavailable["sourceStatus"] == "error" and not unavailable["hasSnapshot"]
        rows = [row("C", priorityId=2), row("S", priorityId=4)]
        save(source, rows)
        await store.reload()
        first = store.snapshot()
        Snapshot.model_validate(first)
        assert first["sourceStatus"] == "ok" and first["hasSnapshot"] and first["notifications"] == []

        rows[0].update(priorityId=4, assignedGroupName=COORDINATORS)
        save(source, rows)
        await store.reload()
        before = store.snapshot()
        assert {n["kind"] for n in before["notifications"]} == {"critical", "assigned"}
        assert len({n["eventId"] for n in before["notifications"]}) == 2
        save(source, [dict(reversed(record.items())) for record in reversed(rows)])
        source.write_text(" \n" + source.read_text(encoding="utf-8"), encoding="utf-8")
        await store.reload()
        assert store.snapshot()["snapshotVersion"] == before["snapshotVersion"]
        assert store.snapshot()["notifications"] == before["notifications"]

        rows[0]["deadline"] = "2027-01-11T06:15:30Z"
        save(source, rows)
        await store.reload()
        deadline = store.snapshot()
        assert deadline["snapshotVersion"] > before["snapshotVersion"]
        assert deadline["notifications"] == before["notifications"]

        source.write_text("[{", encoding="utf-8")
        await store.reload()
        error = store.snapshot()
        assert error["sourceStatus"] == "error" and error["hasSnapshot"]
        assert error["incidents"] == deadline["incidents"] and error["dataUpdatedAt"] == deadline["dataUpdatedAt"]
        save(source, rows)
        await store.reload()
        restored = store.snapshot()
        assert restored["sourceStatus"] == "ok" and restored["notifications"] == before["notifications"]
        assert restored["dataUpdatedAt"] == deadline["dataUpdatedAt"]

        rows[0].update(stateEnum="Resolved", priorityId=2)
        save(source, rows[:1])  # Disappearance of the other critical incident isn't a solution.
        await store.reload()
        settled = store.snapshot()
        assert settled["counts"]["history"] == 1 and settled["counts"]["critical"] == 0
        assert settled["notifications"][0]["kind"] == "resolved"
        assert all(n["incidentId"] == "C" for n in settled["notifications"])
        assert settled["epoch"] == first["epoch"]
        assert Store(source, False).epoch != store.epoch

        rows[0].update(stateEnum="Research")
        save(source, rows[:1])
        await store.reload()
        research = store.snapshot()
        assert research["groups"]["review"] == research["groups"]["assigned"] == ["C"]
        assert research["notifications"][0]["kind"] == "assigned"

        rows[0].update(stateEnum="WorkInProgress", priorityId=4)
        save(source, rows[:1])
        await store.reload()
        assert store.snapshot()["notifications"][0]["kind"] == "critical"
        rows[0].update(stateEnum="Research", priorityId=2)
        save(source, rows[:1])
        await store.reload()
        assert store.snapshot()["notifications"][0]["kind"] == "resolved"

    asyncio.run(scenario())


def test_watch_atomic_replace_broadcast_and_reconnect(tmp_path: Path):
    async def scenario():
        source = tmp_path / "incidents.json"
        save(source, [row("A")])
        store = Store(source, demo=True, polling=True)
        await store.start()
        client_a, client_b = store.subscribe(), store.subscribe()
        try:
            start_a, start_b = await asyncio.gather(anext(client_a), anext(client_b))
            assert start_a["snapshotVersion"] == start_b["snapshotVersion"]
            save(source, [row("A", priorityId=4)])
            a, b = await asyncio.wait_for(asyncio.gather(anext(client_a), anext(client_b)), 6)
            assert a["groups"]["critical"] == b["groups"]["critical"] == ["A"]
            assert a["notifications"] == b["notifications"]
            await client_b.aclose()
            source.write_bytes(b"[")
            failure = await asyncio.wait_for(anext(client_a), 6)
            assert failure["sourceStatus"] == "error" and failure["incidents"] == a["incidents"]
            save(source, [])
            recovery = await asyncio.wait_for(anext(client_a), 6)
            assert recovery["sourceStatus"] == "ok" and recovery["incidents"] == []
            client_b = store.subscribe()
            reconnected = await anext(client_b)
            assert reconnected["snapshotVersion"] == recovery["snapshotVersion"]
            assert reconnected["notifications"] == b["notifications"]
        finally:
            await client_a.aclose()
            await client_b.aclose()
            await store.stop()

    asyncio.run(scenario())


def test_watch_recovers_when_source_directory_appears_after_start(tmp_path):
    async def scenario():
        source = tmp_path / "incoming" / "incidents.json"
        store = Store(source, demo=False)
        await store.start()
        updates = store.subscribe()
        try:
            assert (await anext(updates))["hasSnapshot"] is False
            await asyncio.sleep(0.1)
            source.parent.mkdir()
            save(source, [row()])
            available = await asyncio.wait_for(anext(updates), timeout=6)
            assert available["sourceStatus"] == "ok" and available["hasSnapshot"]
            assert available["notifications"] == []
        finally:
            await updates.aclose()
            await store.stop()

    asyncio.run(scenario())


@pytest.mark.parametrize("broken_source", [False, True])
async def test_clock_escalates_once_on_last_valid_snapshot(tmp_path, monkeypatch, broken_source):
    clock = datetime(2030, 1, 1, 12, tzinfo=UTC)
    monkeypatch.setattr("app.store.utc_now", lambda: clock)
    source = tmp_path / "incidents.json"
    data = [row("H", priorityId=3, submitDate=clock.isoformat(),
                deadline=(clock + timedelta(hours=4)).isoformat())]
    save(source, data)
    store = Store(source, demo=True, polling=True)
    await store.start()
    updates = store.subscribe()
    try:
        initial = await anext(updates)
        assert initial["groups"]["high"] == ["H"] and initial["groups"]["critical"] == []
        previous = initial
        if broken_source:
            source.write_text("[", encoding="utf-8")
            previous = await asyncio.wait_for(anext(updates), 6)
            assert previous["sourceStatus"] == "error"

        clock += timedelta(hours=3)
        escalated = await asyncio.wait_for(anext(updates), 6)
        assert escalated["groups"]["critical"] == ["H"] and escalated["groups"]["high"] == []
        assert escalated["counts"]["critical"] == 1 and escalated["counts"]["high"] == 0
        assert escalated["snapshotVersion"] == previous["snapshotVersion"] + 1
        assert escalated["loadedAt"] == escalated["dataUpdatedAt"] == initial["loadedAt"]
        assert escalated["sourceStatus"] == previous["sourceStatus"]
        assert [(n["incidentId"], n["kind"]) for n in escalated["notifications"]] == [("H", "critical")]

        clock += timedelta(hours=1)
        save(source, data)
        await store.reload()
        restored = store.snapshot()
        assert restored["sourceStatus"] == "ok"
        assert restored["snapshotVersion"] == escalated["snapshotVersion"] + int(broken_source)
        assert restored["notifications"] == escalated["notifications"]
    finally:
        await updates.aclose()
        await store.stop()
