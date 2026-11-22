import json
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from random import Random
from threading import Barrier, Event

import pytest

from fastapi.testclient import TestClient

from app.accounts import Accounts
from app.config import Settings
from app.main import create_app
from app.domain import memberships, normalize_records
from app.generator_data import append_generated_incident, make_incident, publish_shift_frame


def test_generation_is_opt_in_idempotent_and_appends_to_live_json(tmp_path, monkeypatch):
    monkeypatch.setattr("app.store.RUNTIME", tmp_path)
    source = tmp_path / "incidents.json"
    original = [{"id": "EXISTING", "header": "Исходная запись", "custom": {"keep": [1, 2]}}]
    source.write_text(json.dumps(original), encoding="utf-8")
    settings = Settings(_env_file=None, incidents_file=str(source), accounts_db=tmp_path / "accounts.db",
                        watch_polling=True, llm_api_key=None)
    creds = {"login": "tester", "password": "test-generator-password"}
    Accounts(settings.accounts_path).create(creds["login"], "Тест", "coordinator", creds["password"])
    # A long first interval verifies delayed start and immediate stop. On the next
    # start expire exactly two intervals, then leave the next timer pending.
    waits = []
    first_timer, third_timer = Event(), Event()

    def interval(low, high):
        waits.append((low, high))
        if len(waits) == 1:
            first_timer.set()
        if len(waits) == 4:
            third_timer.set()
        return 0 if len(waits) in (2, 3) else 60

    monkeypatch.setattr("app.generator.randint", interval)
    def read():
        return json.loads(source.read_text(encoding="utf-8-sig"))

    with TestClient(create_app(settings)) as client:
        api = "/api/generator"
        def toggle(enabled):
            return client.post(api, json={"enabled": enabled})

        assert client.get(api).status_code == 401
        assert toggle(True).status_code == toggle(False).status_code == 401
        assert client.post("/api/auth/login", json=creds).status_code == 200
        assert client.get(api).json()["enabled"] is False
        assert toggle(True).json()["enabled"] is True
        assert first_timer.wait(2)
        assert toggle(True).json()["enabled"] is True
        assert client.get(api).json()["enabled"] is True
        assert read() == original
        assert toggle(False).json()["enabled"] is False
        assert len(waits) == 1 and read() == original

        # An external editor adds a record before the next tick. It must survive.
        existing = original + [{"id": "MANUAL", "header": "Добавлено вручную"}]
        source.write_text(json.dumps(existing), encoding="utf-8")
        assert toggle(True).json()["enabled"] is True
        assert third_timer.wait(3), "two generated incidents should trigger two fresh intervals"
        assert toggle(False).json()["enabled"] is False
        assert toggle(False).json()["enabled"] is False
        assert client.get(api).json()["enabled"] is False
        assert waits == [(25, 60)] * 4
        rows = read()
        assert rows[:2] == existing and len(rows) == 4
        assert len({row["id"] for row in rows}) == 4
        assert {i["id"] for i in client.get("/api/incidents").json()["incidents"]} == {row["id"] for row in rows}
    assert read() == rows


def test_critical_arrivals_are_rare_in_actual_dashboard_groups():
    rng = Random(22026)
    now = datetime(2026, 11, 22, 9, tzinfo=UTC)
    priorities, groups = Counter(), Counter()
    for _ in range(1000):
        row = make_incident([], now, rng)
        item = normalize_records([row])[row["id"]]
        assert not item.diagnostics
        drawn = memberships(item, now)
        assert drawn  # even ordinary arrivals are visible in a dashboard queue
        assert ("critical" in drawn) == (item.priorityId == 4)
        assert ("high" in drawn) == (item.priorityId == 3)
        groups.update(drawn)
        priorities[item.priorityId] += 1
    assert set(priorities) == {1, 2, 3, 4}
    assert priorities[1] + priorities[2] > 650
    assert 0 < groups["critical"] < 60 and groups["high"] > 3 * groups["critical"]


def test_shift_frame_and_generated_arrival_do_not_overwrite_each_other(tmp_path):
    source = tmp_path / "incidents.json"
    before = {"id": "SCRIPTED", "header": "До"}
    after = {**before, "header": "После"}
    publish_shift_frame(source, [before])
    initial_id = append_generated_incident(source)
    start = Barrier(2)

    def together(fn, *args):
        start.wait(timeout=3)
        return fn(*args)

    with ThreadPoolExecutor(max_workers=2) as pool:
        new_incident = pool.submit(together, append_generated_incident, source)
        next_frame = pool.submit(together, publish_shift_frame, source, [after])
        next_frame.result(5)
        new_id = new_incident.result(5)
    rows = json.loads(source.read_text(encoding="utf-8"))
    assert rows[0] == after and len(rows) == 3
    assert {row["id"] for row in rows[1:]} == {initial_id, new_id}


def test_invalid_source_is_not_replaced(tmp_path):
    source = tmp_path / "incidents.json"
    broken = b'[{"id":'
    source.write_bytes(broken)
    with pytest.raises(ValueError):
        append_generated_incident(source)
    assert source.read_bytes() == broken
