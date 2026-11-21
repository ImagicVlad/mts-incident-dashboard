from copy import deepcopy
from datetime import UTC, datetime, timedelta
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import defense_shift as shift
from app.domain import classify, normalize_records


def inputs():
    initial = [{
        "id": "INC-1", "sysId": "9123456789012345678", "dataOrigin": shift.ORIGIN,
        "submitDate": "2026-01-05T08:30:00Z", "deadline": "2026-01-05T09:30:00Z",
        "waitingExitDate": "0001-01-01T00:00:00", "priorityId": 3,
        "stateEnum": "Assigned", "stateId": 0, "state": "Назначен", "externalField": None,
    }]
    mentor = [{
        "id": "FIXTURE", "sysId": 9007199254741017, "submitDate": "2025-01-01T12:45:00+03:00",
        "externalField": {"passThrough": True},
    }]
    new = dict(initial[0], id="INC-2", sysId="9123456789012345679", submitDate="2026-01-05T09:01:00Z")
    timeline = [
        {"afterSeconds": 30, "id": "INC-1", "changes": {"deadline": "2026-01-05T13:20:00+03:00"}},
        {"afterSeconds": 60, "new": new},
    ]
    return mentor, initial, timeline


START = datetime(2030, 12, 31, 23, 30, tzinfo=UTC)


def test_defense_frames_preserve_source_and_shift_authored_timestamps():
    mentor, initial, timeline = inputs()
    original = deepcopy((mentor, initial, timeline))
    first, second, last = shift.build_frames(mentor, initial, timeline, START)
    assert [first[0], second[0], last[0]] == [0, 30, 60]
    assert [len(first[1]), len(second[1]), len(last[1])] == [2, 2, 3]
    for _, rows in (first, second, last):
        assert rows[0] == original[0][0]
        assert rows[1]["waitingExitDate"] == "0001-01-01T00:00:00"
        assert rows[1]["sysId"] == initial[0]["sysId"]
        assert rows[1]["submitDate"] == "2030-12-31T23:00:00Z"
    assert first[1][1]["deadline"] == "2031-01-01T00:00:00Z"
    assert second[1][1]["deadline"] == "2031-01-01T00:50:00Z"
    assert last[1][2]["submitDate"] == "2030-12-31T23:31:00Z"
    assert (mentor, initial, timeline) == original


@pytest.mark.parametrize("change", [
    {"new": {"id": "INC-1"}}, {"id": "unknown", "changes": {"priorityId": 4}},
    {"id": "FIXTURE", "changes": {"priorityId": 4}}, {"id": "INC-1", "changes": {"sysId": "05"}},
    {"id": "INC-1", "changes": {"deadline": "invalid"}}, {"id": "INC-1", "changes": {"typo": 1}},
])
def test_defense_rejects_bad_event(change):
    mentor, initial, events = inputs()
    with pytest.raises(ValueError):
        shift.build_frames(mentor, initial, [*events, {"afterSeconds": 65, **change}], START)


def test_defense_rejects_duplicate_identity_and_time_reversal():
    mentor, initial, events = inputs()
    for duplicate in ({"id": "FIXTURE"}, {"id": "INC-1"}, {"sysId": mentor[0]["sysId"]}):
        event = {"afterSeconds": 90, "new": dict(events[-1]["new"], **duplicate)}
        with pytest.raises(ValueError):
            shift.build_frames(mentor, initial, [event], START)
    with pytest.raises(ValueError):
        shift.build_frames(mentor, initial, list(reversed(events)), START)


def test_private_snapshot_and_exclusive_producer(tmp_path, monkeypatch):
    mentor, initial, events = inputs()
    source = tmp_path / "export.json"
    output = tmp_path / "private" / "shift.json"
    monkeypatch.setattr(shift, "SCENARIO", tmp_path)
    monkeypatch.setattr(shift, "MENTOR", source)
    monkeypatch.setattr(shift, "OUTPUT", output)
    (tmp_path / "shift.json").write_text(json.dumps(initial))
    timeline = tmp_path / "timeline.json"
    timeline.write_text(json.dumps(events))
    with pytest.raises(ValueError, match="ментора"):
        shift.publish("prepare", False)
    shift.publish("prepare", True)
    assert len(json.loads(output.read_bytes())) == 1
    source.write_text(json.dumps(mentor))
    shift.publish("prepare", False)
    old = output.read_bytes()
    assert json.loads(old)[0] == mentor[0]
    with shift.published_by_one_process(output.parent), pytest.raises(ValueError, match="занят"):
        shift.publish("prepare", True)
    timeline.write_text(json.dumps([{"afterSeconds": 2, "new": {}}]))
    with pytest.raises(ValueError):
        shift.publish("run", False)
    assert output.read_bytes() == old
    assert json.loads(source.read_bytes()) == mentor


def test_published_shift_covers_defense_cases_and_export_shape():
    expected_fields = set("""
        id sysId header description shortDescription incType state stateEnum stateId stateReason stateReasonId
        submitDate deadline completionDate lastAssignmentToTeamDateTime waitingExitDate
        assignedGroupName assignedEmployee assignedEmployeeLogin initiatorName initiatorLogin
        isEffect isReason isDouble isMaster isRootIncident isNeedUp
        priority priorityId impact impactId urgency urgencyId serviceType serviceTypeId
        productName productId productMasterId productUrl service serviceId scenarioName
        eliminationType eliminationTypeId receivingChannel solution
    """.split())
    mentor = [dict(inputs()[0][0], stateEnum="Assigned", stateId=0, state="Назначен", priorityId=1)]
    original = deepcopy(mentor)
    initial = shift.read_array(shift.SCENARIO / "shift.json")
    timeline = shift.read_array(shift.SCENARIO / "timeline.json")
    snapshots = dict(shift.build_frames(mentor, initial, timeline, START))
    assert len(snapshots[0]) == len(initial) + 1
    assert len(snapshots[max(snapshots)]) > len(snapshots[0])
    for offset, rows in snapshots.items():
        assert rows[:len(mentor)] == original
        normalized = normalize_records(rows)
        assert all(not item.diagnostics for item in normalized.values())
        groups = classify(normalized, START + timedelta(seconds=offset))
        assert all(groups[name] for name in ("critical", "high", "assigned", "review", "history"))
        for authored in rows[len(mentor):]:
            assert set(authored) == expected_fields | {"dataOrigin"}
            assert authored["dataOrigin"] == "defense-scenario"
            assert all(isinstance(authored[key], str) for key in ("id", "sysId", "serviceId", "productId"))

    def queues_at(offset):
        latest = max(second for second in snapshots if second <= offset)
        return classify(normalize_records(snapshots[latest]), START + timedelta(seconds=offset))

    key = "INC-900001"
    assert key in queues_at(44)["high"]
    assert key not in queues_at(44)["critical"]
    assert key in queues_at(45)["critical"]
    assert key not in queues_at(45)["high"]
    assert key in queues_at(160)["review"]
    assert key not in queues_at(160)["critical"]
    assert "INC-900006" in queues_at(315)["history"]
