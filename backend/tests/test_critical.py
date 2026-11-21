from datetime import UTC, datetime, timedelta

import pytest

from app.domain import COORDINATORS, classify, critical_from, normalize_records, transitions


DEADLINE = datetime(2026, 11, 21, 12, tzinfo=UTC)
STEP = timedelta(microseconds=1)


def incidents(**fields):
    return normalize_records([{
        "id": "H", "stateEnum": "Assigned", "priorityId": 3,
        "submitDate": "2026-11-21T14:00:00+03:00", "deadline": DEADLINE.isoformat(),
        "assignedGroupName": COORDINATORS, **fields,
    }])


@pytest.mark.parametrize(("hours", "lead_minutes"), [(1, 15), (4, 60), (48, 60)])
def test_high_priority_enters_at_quarter_capped_at_one_hour(hours, lead_minutes):
    items = incidents(submitDate=(DEADLINE - timedelta(hours=hours)).isoformat())
    threshold = DEADLINE - timedelta(minutes=lead_minutes)
    assert critical_from(items["H"]) == threshold
    assert classify(items, threshold - STEP)["critical"] == []
    groups = classify(items, threshold)
    assert groups["critical"] == groups["high"] == groups["assigned"] == ["H"]
    assert classify(items, DEADLINE + STEP)["critical"] == ["H"]


@pytest.mark.parametrize("start", [None, "invalid", DEADLINE.isoformat(), (DEADLINE + STEP).isoformat()])
def test_missing_or_unusable_start_escalates_on_deadline(start):
    items = incidents(submitDate=start)
    assert critical_from(items["H"]) == DEADLINE
    assert classify(items, DEADLINE - STEP)["critical"] == []
    assert classify(items, DEADLINE)["critical"] == ["H"]


@pytest.mark.parametrize("deadline", [None, "invalid"])
def test_only_highest_priority_escalates_without_deadline(deadline):
    high = incidents(deadline=deadline)
    assert critical_from(high["H"]) is None
    assert classify(high, DEADLINE)["critical"] == []
    highest = incidents(priorityId=4, deadline=deadline)
    assert classify(highest, DEADLINE)["critical"] == ["H"]


@pytest.mark.parametrize(("state", "priority"), [
    ("Research", 3), ("Resolved", 4), ("Closed", 4), ("Assigned", 1), ("WorkInProgress", 2),
])
def test_overdue_alone_does_not_escalate(state, priority):
    assert classify(incidents(stateEnum=state, priorityId=priority), DEADLINE + STEP)["critical"] == []


def test_notifications_only_on_entry_even_as_time_or_deadline_changes():
    items = incidents(stateEnum="WorkInProgress")
    threshold = DEADLINE - timedelta(minutes=15)
    first = list(transitions(items, items, now=threshold, previous_now=threshold - STEP))
    assert [event[:2] for event in first] == [("H", "critical")]
    assert not list(transitions(items, items, now=DEADLINE + STEP, previous_now=threshold))
    extended = incidents(stateEnum="WorkInProgress", deadline=(DEADLINE + timedelta(hours=4)).isoformat())
    assert not list(transitions(items, extended, now=DEADLINE, previous_now=threshold))
    assert [event[:2] for event in transitions(extended, items, now=DEADLINE)] == [("H", "critical")]
