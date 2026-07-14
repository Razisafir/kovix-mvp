"""
KOVIX :: SQLite Persistence
=============================
Cross-run history layer. STATE.md remains the in-flight source of truth per
PAUL; kovix.db is the durable archive you can query later.

Schema:
    runs             - one row per PAUL loop invocation
    milestones       - one row per milestone in a run
    healing_events   - one row per diagnostic attempt
    events           - one row per streamed event

Thread-safety: every call opens its own connection (SQLite handles file
locking); safe to call from the FastAPI worker thread while the loop runs
on a worker thread.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

DEFAULT_DB_PATH: Path = Path(__file__).resolve().parent / "kovix.db"
_schema_lock = threading.Lock()


# --------------------------------------------------------------------------- #
# Connection + schema bootstrap
# --------------------------------------------------------------------------- #

SCHEMA_SQL: str = """
CREATE TABLE IF NOT EXISTS runs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at        TEXT NOT NULL,
    finished_at       TEXT,
    vibe              TEXT NOT NULL,
    goal              TEXT,
    verdict           TEXT,
    passed            INTEGER,
    failed            INTEGER,
    total_milestones  INTEGER,
    provider          TEXT,
    model             TEXT,
    spec_retries      INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS milestones (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id                  INTEGER NOT NULL,
    milestone_id            TEXT NOT NULL,
    name                    TEXT,
    filename                TEXT,
    returncode              INTEGER,
    all_criteria_passed     INTEGER,
    criteria_json           TEXT,
    FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS healing_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        INTEGER NOT NULL,
    milestone_id  TEXT,
    attempt       INTEGER,
    classification TEXT,
    reasoning     TEXT,
    action        TEXT,
    FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        INTEGER NOT NULL,
    phase         TEXT,
    message       TEXT,
    status        TEXT,
    timestamp     TEXT,
    payload_json  TEXT,
    FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_run_id     ON events(run_id);
CREATE INDEX IF NOT EXISTS idx_milestones_run_id ON milestones(run_id);
CREATE INDEX IF NOT EXISTS idx_healing_run_id    ON healing_events(run_id);
"""


def _connect(db_path: Path = DEFAULT_DB_PATH) -> sqlite3.Connection:
    conn: sqlite3.Connection = sqlite3.connect(
        str(db_path), timeout=10.0, isolation_level=None
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_db(db_path: Path = DEFAULT_DB_PATH) -> None:
    """Idempotent schema bootstrap. Safe to call on every startup."""
    with _schema_lock:
        with _connect(db_path) as conn:
            conn.executescript(SCHEMA_SQL)


# --------------------------------------------------------------------------- #
# Run lifecycle
# --------------------------------------------------------------------------- #

def start_run(
    vibe: str,
    provider: str,
    model: str,
    db_path: Path = DEFAULT_DB_PATH,
) -> int:
    """Insert a new run row and return its id."""
    init_db(db_path)
    with _connect(db_path) as conn:
        cur = conn.execute(
            """INSERT INTO runs (started_at, vibe, provider, model)
               VALUES (?, ?, ?, ?)""",
            (_utc_now(), vibe, provider, model),
        )
        return int(cur.lastrowid)


def finish_run(
    run_id: int,
    goal: str,
    verdict: str,
    passed: int,
    failed: int,
    total_milestones: int,
    spec_retries: int = 0,
    db_path: Path = DEFAULT_DB_PATH,
) -> None:
    with _connect(db_path) as conn:
        conn.execute(
            """UPDATE runs SET
                 finished_at = ?,
                 goal = ?,
                 verdict = ?,
                 passed = ?,
                 failed = ?,
                 total_milestones = ?,
                 spec_retries = ?
               WHERE id = ?""",
            (_utc_now(), goal, verdict, passed, failed, total_milestones,
             spec_retries, run_id),
        )


# --------------------------------------------------------------------------- #
# Per-row inserters
# --------------------------------------------------------------------------- #

def insert_event(
    run_id: int,
    phase: str,
    message: str,
    status: str,
    timestamp: str,
    payload: Optional[Dict[str, Any]] = None,
    db_path: Path = DEFAULT_DB_PATH,
) -> None:
    with _connect(db_path) as conn:
        conn.execute(
            """INSERT INTO events
                 (run_id, phase, message, status, timestamp, payload_json)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (run_id, phase, message, status, timestamp,
             json.dumps(payload, ensure_ascii=False) if payload else None),
        )


def insert_milestone(
    run_id: int,
    milestone_id: str,
    name: str,
    filename: str,
    returncode: int,
    all_criteria_passed: bool,
    criteria: List[Dict[str, Any]],
    db_path: Path = DEFAULT_DB_PATH,
) -> None:
    with _connect(db_path) as conn:
        conn.execute(
            """INSERT INTO milestones
                 (run_id, milestone_id, name, filename, returncode,
                  all_criteria_passed, criteria_json)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (run_id, milestone_id, name, filename, returncode,
             1 if all_criteria_passed else 0,
             json.dumps(criteria, ensure_ascii=False)),
        )


def insert_healing_event(
    run_id: int,
    milestone_id: str,
    attempt: int,
    classification: str,
    reasoning: str,
    action: str,
    db_path: Path = DEFAULT_DB_PATH,
) -> None:
    with _connect(db_path) as conn:
        conn.execute(
            """INSERT INTO healing_events
                 (run_id, milestone_id, attempt, classification,
                  reasoning, action)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (run_id, milestone_id, attempt, classification, reasoning, action),
        )


# --------------------------------------------------------------------------- #
# Read models
# --------------------------------------------------------------------------- #

def list_runs(limit: int = 50, db_path: Path = DEFAULT_DB_PATH) -> List[Dict[str, Any]]:
    """Return the most recent runs (no event detail)."""
    init_db(db_path)
    with _connect(db_path) as conn:
        rows = conn.execute(
            """SELECT id, started_at, finished_at, vibe, goal, verdict,
                      passed, failed, total_milestones, provider, model,
                      spec_retries
               FROM runs ORDER BY id DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_run_detail(run_id: int, db_path: Path = DEFAULT_DB_PATH) -> Optional[Dict[str, Any]]:
    """Return a run with its milestones, healing_events, and events."""
    init_db(db_path)
    with _connect(db_path) as conn:
        run_row = conn.execute(
            """SELECT id, started_at, finished_at, vibe, goal, verdict,
                      passed, failed, total_milestones, provider, model,
                      spec_retries
               FROM runs WHERE id = ?""",
            (run_id,),
        ).fetchone()
        if run_row is None:
            return None
        run: Dict[str, Any] = dict(run_row)
        run["milestones"] = [dict(r) for r in conn.execute(
            """SELECT milestone_id, name, filename, returncode,
                      all_criteria_passed, criteria_json
               FROM milestones WHERE run_id = ? ORDER BY id""",
            (run_id,),
        ).fetchall()]
        run["healing_events"] = [dict(r) for r in conn.execute(
            """SELECT milestone_id, attempt, classification, reasoning, action
               FROM healing_events WHERE run_id = ? ORDER BY id""",
            (run_id,),
        ).fetchall()]
        run["events"] = [dict(r) for r in conn.execute(
            """SELECT phase, message, status, timestamp, payload_json
               FROM events WHERE run_id = ? ORDER BY id""",
            (run_id,),
        ).fetchall()]
        return run


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
