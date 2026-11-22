"""Persistent, incident-scoped history of observed changes and coordinator comments."""

import json
import sqlite3
from contextlib import closing
from uuid import uuid4


FIELDS = ("header", "stateEnum", "priorityId", "productName", "service", "assignedGroupName",
          "assignedEmployee", "deadline", "submitDate", "lastAssignmentToTeamDateTime",
          "completionDate", "description", "shortDescription", "solution")

FEED_LIMIT = 100


class ActivityLog:
    def __init__(self, path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(path)) as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS observed (incident TEXT PRIMARY KEY, fields TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS activity (
                    seq INTEGER PRIMARY KEY, incident TEXT NOT NULL, id TEXT NOT NULL,
                    time TEXT NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
                    UNIQUE (incident, id)
                );
                CREATE INDEX IF NOT EXISTS incident_timeline ON activity(incident, seq);
                CREATE TABLE IF NOT EXISTS notifications (
                    seq INTEGER PRIMARY KEY, eventId TEXT NOT NULL UNIQUE, incidentId TEXT NOT NULL,
                    kind TEXT NOT NULL, label TEXT NOT NULL, time TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS notified_overdue (incidentId TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS reader_baselines (login TEXT PRIMARY KEY, seq INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS incident_reads (
                    login TEXT NOT NULL, incident TEXT NOT NULL, PRIMARY KEY(login, incident)
                );
                CREATE INDEX IF NOT EXISTS first_observations ON activity(seq) WHERE kind='first';
            """)

    def unread(self, login):
        with closing(sqlite3.connect(self.path)) as db, db:
            # The first usable snapshot for this coordinator is their starting point.
            db.execute("""INSERT OR IGNORE INTO reader_baselines(login, seq)
                          SELECT ?, COALESCE(MAX(seq), 0) FROM activity""", (login,))
            rows = db.execute("""SELECT a.incident FROM activity a
                JOIN reader_baselines b ON b.login=? AND a.seq>b.seq
                WHERE a.kind='first' AND NOT EXISTS (
                    SELECT 1 FROM incident_reads r WHERE r.login=b.login AND r.incident=a.incident
                ) ORDER BY a.seq""", (login,))
            return [row[0] for row in rows]

    def mark_read(self, login, incident):
        with closing(sqlite3.connect(self.path)) as db, db:
            # The source may remove the record while its already-open detail page acknowledges it.
            if not db.execute("SELECT 1 FROM observed WHERE incident=?", (incident,)).fetchone():
                raise KeyError(incident)
            result = db.execute("INSERT OR IGNORE INTO incident_reads(login, incident) VALUES(?,?)",
                                (login, incident))
            return result.rowcount == 1

    def load_feed(self):
        with closing(sqlite3.connect(self.path)) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute("""SELECT eventId, incidentId, kind, label, time
                                 FROM notifications ORDER BY seq DESC LIMIT ?""", (FEED_LIMIT,))
            events = [dict(row) for row in rows]
            overdue = {row[0] for row in db.execute("SELECT incidentId FROM notified_overdue")}
        return events, overdue

    def append_notifications(self, events):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.executemany("""INSERT INTO notifications(eventId, incidentId, kind, label, time)
                              VALUES (:eventId, :incidentId, :kind, :label, :time)""", events)
            db.executemany("INSERT OR IGNORE INTO notified_overdue VALUES (?)",
                           ((event["incidentId"],) for event in events if event["kind"] == "overdue"))
            db.execute("""DELETE FROM notifications WHERE seq < (
                          SELECT seq FROM notifications ORDER BY seq DESC LIMIT 1 OFFSET ?)""",
                       (FEED_LIMIT - 1,))

    def observe(self, items, time, assigned_id=None, author=None):
        with closing(sqlite3.connect(self.path)) as db, db:
            for item in items:
                current = {key: getattr(item, key) for key in FIELDS}
                row = db.execute("SELECT fields FROM observed WHERE incident=?", (item.id,)).fetchone()
                previous = json.loads(row[0]) if row else {}
                if row and current == previous:
                    continue
                changes = [{"field": key, "before": previous.get(key), "after": value}
                           for key, value in current.items() if row and previous.get(key) != value]
                db.execute("INSERT INTO activity(incident,id,time,author,kind,body) VALUES(?,?,?,?,?,?)",
                           (item.id, uuid4().hex, time, author if item.id == assigned_id else "Источник",
                            "change" if row else "first", json.dumps(changes, ensure_ascii=False)))
                db.execute("INSERT OR REPLACE INTO observed VALUES(?,?)",
                           (item.id, json.dumps(current, ensure_ascii=False)))

    def comment(self, incident, id_, time, author, text):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("INSERT OR IGNORE INTO activity(incident,id,time,author,kind,body) VALUES(?,?,?,?,?,?)",
                       (incident, id_, time, author, "comment", json.dumps(text, ensure_ascii=False)))

    def page(self, incident, before):
        with closing(sqlite3.connect(self.path)) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute("""SELECT seq,id,time,author,kind,body FROM activity
                WHERE incident=? AND seq<? ORDER BY seq DESC LIMIT 31""",
                (incident, before if before is not None else 2**63-1)).fetchall()
        entries = [{**dict(row), "body": json.loads(row["body"])} for row in rows[:30]]
        return {"entries": entries, "next": entries[-1]["seq"] if len(rows)>30 else None}
