"""Persistent, incident-scoped history of observed changes and coordinator comments."""

import json
import sqlite3
from contextlib import closing
from uuid import uuid4


FIELDS = ("header", "stateEnum", "priorityId", "productName", "service", "assignedGroupName",
          "assignedEmployee", "deadline", "submitDate", "lastAssignmentToTeamDateTime",
          "completionDate", "description", "shortDescription", "solution")


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
            """)

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
