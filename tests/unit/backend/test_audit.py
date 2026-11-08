"""T32–T35 against real SQLite; mutation switch removes a real trigger."""

from concurrent.futures import ThreadPoolExecutor
import csv
import hashlib
import io
import json
import os
import sqlite3
import stat

import pytest

from backend.audit import ActionDenied, AuditLog, AuditUnavailable, COLUMNS, GENESIS


@pytest.fixture
def audit(tmp_path):
    log = AuditLog(tmp_path / "private" / "luvebot.db", timeout=0.05)
    if os.environ.get("LUVE_AUDIT_MUTATE_DELETE") == "1":
        with sqlite3.connect(log.path) as conn:
            conn.execute("DROP TRIGGER audit_no_delete")
    return log


def seed(audit, count=1):
    for _ in range(count):
        audit.act("human", "run.stop", "run_1", {"kind": "ui", "ref": "req_1"}, lambda: None,
                  bot="vendas")


def rows(audit):
    with sqlite3.connect(audit.path) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute("SELECT * FROM audit_log ORDER BY id")]


def test_exact_schema_and_independent_canonical_hash(audit):
    seed(audit, 2)
    with sqlite3.connect(audit.path) as conn:
        assert [row[1] for row in conn.execute("PRAGMA table_info(audit_log)")] == list(COLUMNS)
        assert "AUTOINCREMENT" in conn.execute("SELECT sql FROM sqlite_master WHERE name='audit_log'").fetchone()[0]
    previous = GENESIS
    for record in rows(audit):
        assert record["prev_hash"] == previous
        canonical = json.dumps({key: value for key, value in record.items() if key not in ("hash", "prev_hash")},
                               sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        assert record["hash"] == hashlib.sha256((previous + canonical).encode()).hexdigest()
        previous = record["hash"]
    assert audit.verify() == {"ok": True, "rows": 4, "first_break": None}


def test_immutable_update(audit):
    seed(audit)
    with sqlite3.connect(audit.path) as conn, pytest.raises(sqlite3.IntegrityError, match="append-only"):
        conn.execute("UPDATE audit_log SET actor='attacker' WHERE id=1")
    assert rows(audit)[0]["actor"] == "human"


def test_immutable_delete(audit):
    seed(audit)
    with sqlite3.connect(audit.path) as conn, pytest.raises(sqlite3.IntegrityError, match="append-only"):
        conn.execute("DELETE FROM audit_log WHERE id=1")
    assert len(rows(audit)) == 2


@pytest.mark.parametrize("recursive", [0, 1])
@pytest.mark.parametrize("statement", ["INSERT OR REPLACE", "REPLACE"])
def test_immutable_replace_even_external_connection(audit, recursive, statement):
    seed(audit)
    before = rows(audit)
    with sqlite3.connect(audit.path) as conn:
        conn.execute(f"PRAGMA recursive_triggers={recursive}")
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            conn.execute(f"{statement} INTO audit_log SELECT * FROM audit_log WHERE id=1")
    assert rows(audit) == before


def test_store_enables_recursive_triggers(audit):
    conn = audit._connect()
    try:
        assert conn.execute("PRAGMA recursive_triggers").fetchone()[0] == 1
    finally:
        conn.close()


@pytest.mark.parametrize("column,value", [("actor", "attacker"), ("detail", "modified"),
                                         ("digest", "f" * 64), ("hash", "0" * 64),
                                         ("prev_hash", "0" * 64)])
def test_chain_detects_external_edit_without_triggers(audit, column, value):
    seed(audit, 2)
    with sqlite3.connect(audit.path) as external:
        external.execute("DROP TRIGGER audit_no_update")
        external.execute(f"UPDATE audit_log SET {column}=? WHERE id=3", (value,))
    assert audit.verify() == {"ok": False, "rows": 3, "first_break": 3}
    assert audit.page()["chain"]["ok"] is False
    assert audit.page()["chain"]["checked_through"] == 2


def test_chain_detects_nontext_field_corruption(audit):
    seed(audit)
    with sqlite3.connect(audit.path) as external:
        external.execute("DROP TRIGGER audit_no_update")
        external.execute("UPDATE audit_log SET actor=? WHERE id=1", (b"binary tampering",))
    assert audit.verify() == {"ok": False, "rows": 1, "first_break": 1}


@pytest.mark.parametrize("deleted,first_break", [(1, 1), (2, 2), (4, 4)])
def test_chain_detects_external_deletion_including_tail(audit, deleted, first_break):
    seed(audit, 2)
    with sqlite3.connect(audit.path) as external:
        external.execute("DROP TRIGGER audit_no_delete")
        external.execute("DELETE FROM audit_log WHERE id=?", (deleted,))
    result = audit.verify()
    assert result["ok"] is False
    assert result["first_break"] == first_break


def test_empty_and_reopen(audit):
    assert audit.verify() == {"ok": True, "rows": 0, "first_break": None}
    seed(audit)
    reopened = AuditLog(audit.path)
    seed(reopened)
    assert reopened.verify() == {"ok": True, "rows": 4, "first_break": None}


def test_act_commits_intent_before_effect_and_preserves_return(audit):
    sentinel = object()

    def effect():
        event, = rows(audit)
        assert (event["actor"], event["action"], event["target"], event["origin_kind"], event["bot"]) == (
            "human", "run.stop", "run_1", "ui", "vendas")
        assert event["detail"] == "intent"
        assert event["ts"].endswith("Z")
        return sentinel

    assert audit.act("human", "run.stop", "run_1", "ui", effect, bot="vendas") is sentinel
    first, second = rows(audit)
    assert first["origin_ref"] == second["origin_ref"]
    assert (second["detail"], second["outcome"]) == ("result", "ok")


@pytest.mark.parametrize("error,outcome", [(RuntimeError("private upstream body"), "error"),
                                         (ActionDenied("private denial reason"), "denied"),
                                         (KeyboardInterrupt("cancelled"), "error")])
def test_act_records_error_and_reraises_original(audit, error, outcome):
    def effect():
        raise error

    with pytest.raises(type(error)) as raised:
        audit.act("human", "run.stop", "run_1", "ui", effect)
    assert raised.value is error
    assert [(row["detail"], row["outcome"]) for row in rows(audit)] == [("intent", "ok"), ("result", outcome)]
    assert str(error).encode() not in audit.path.read_bytes()
    assert audit.verify()["ok"] is True


def test_failed_intent_write_never_calls_effect(audit):
    effects = []
    with sqlite3.connect(audit.path) as conn:
        conn.execute("CREATE TRIGGER disk_failure BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'private upstream'); END")
    with pytest.raises(AuditUnavailable, match="^audit_unavailable$"):
        audit.act("human", "run.stop", None, "ui", lambda: effects.append("ran"))
    assert effects == []
    assert rows(audit) == []


def test_async_callback_is_not_reported_as_completed(audit):
    effects = []

    async def effect():
        effects.append("ran")

    with pytest.raises(TypeError, match="synchronous callback"):
        audit.act("human", "run.stop", None, "ui", effect)
    assert effects == []
    assert [row["outcome"] for row in rows(audit)] == ["ok", "error"]


def test_locked_database_fails_closed(audit):
    effects = []
    with sqlite3.connect(audit.path) as locker:
        locker.execute("BEGIN IMMEDIATE")
        with pytest.raises(AuditUnavailable):
            audit.act("human", "run.stop", None, "ui", lambda: effects.append("ran"))
    assert effects == []


def test_failed_result_write_keeps_durable_intent(audit):
    effects = []

    def effect():
        effects.append("ran")
        with sqlite3.connect(audit.path) as conn:
            conn.execute("CREATE TRIGGER result_failure BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'no space'); END")

    with pytest.raises(AuditUnavailable):
        audit.act("human", "run.stop", None, "ui", effect)
    assert effects == ["ran"]
    assert [row["detail"] for row in rows(audit)] == ["intent"]


def test_no_secret_or_message_body_in_database(tmp_path):
    secrets = ("CANARY_API_92b8", "CANARY_ENV_78ef", "SESSION_TOKEN_9ccd")
    audit = AuditLog(tmp_path / "private" / "audit.db", secrets=secrets)
    body = "Full private message that must never be stored " + " ".join(secrets)
    with pytest.raises(RuntimeError):
        audit.act(secrets[0], "chat.send", secrets[1], {"kind": "ui", "ref": secrets[2]},
                  lambda: (_ for _ in ()).throw(RuntimeError(body)), bot=secrets[0], payload={"message": body})
    audit.act("human", "chat.send", "session_1", "ui", lambda: {"body": body}, payload=body)
    stored = rows(audit)
    assert stored[0]["actor"] == "[REDACTED]"
    assert stored[0]["target"] == "[REDACTED]"
    expected = hashlib.sha256(json.dumps({"message": body}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert stored[0]["digest"] == expected
    for file in audit.path.parent.iterdir():
        for sensitive in (*secrets, body):
            assert sensitive.encode() not in file.read_bytes()
    assert audit.verify()["ok"] is True


def test_identifier_gate_rejects_message_bodies(audit):
    effects = []
    with pytest.raises(ValueError, match="identifier"):
        audit.act("human", "chat.send", "the full message body", "ui", lambda: effects.append("ran"))
    assert effects == []
    assert rows(audit) == []


def test_injected_redactor_and_failure_are_before_write(tmp_path):
    audit = AuditLog(tmp_path / "private" / "audit.db", redact=lambda text: text.replace("opaque_secret", "[REDACTED]"))
    audit.act("human", "run.stop", "opaque_secret", "ui", lambda: None)
    assert b"opaque_secret" not in audit.path.read_bytes()

    def broken_redactor(text):
        raise RuntimeError("private secret")

    audit.redact = broken_redactor
    with pytest.raises(AuditUnavailable):
        seed(audit)
    assert len(rows(audit)) == 2


def test_permissions_created_and_existing_permissions_hardened(audit):
    assert stat.S_IMODE(audit.path.stat().st_mode) == 0o600
    assert stat.S_IMODE(audit.path.parent.stat().st_mode) == 0o700
    os.chmod(audit.path, 0o644)
    os.chmod(audit.path.parent, 0o755)
    AuditLog(audit.path)
    seed(audit)
    assert stat.S_IMODE(audit.path.stat().st_mode) == 0o600
    assert stat.S_IMODE(audit.path.parent.stat().st_mode) == 0o700


def test_symlink_database_is_refused(tmp_path):
    target = tmp_path / "target"
    target.write_text("do not overwrite")
    folder = tmp_path / "private"
    folder.mkdir()
    (folder / "audit.db").symlink_to(target)
    with pytest.raises(AuditUnavailable):
        AuditLog(folder / "audit.db")
    assert target.read_text() == "do not overwrite"


def test_parallel_actions_form_one_valid_chain(audit):
    audit.timeout = 5
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: seed(audit), range(12)))
    assert audit.verify() == {"ok": True, "rows": 24, "first_break": None}


def test_cursor_is_stable_under_new_writes(audit):
    seed(audit, 4)
    first = audit.page(limit=3)
    assert [e["id"] for e in first["events"]] == [8, 7, 6]
    seed(audit)
    collected = first["events"]
    cursor = first["next_cursor"]
    while cursor:
        page = audit.page(limit=3, cursor=cursor)
        collected += page["events"]
        cursor = page["next_cursor"]
    assert [e["id"] for e in collected] == list(range(8, 0, -1))


@pytest.mark.parametrize("format", ["json", "csv"])
def test_export_all_pages_and_audits_export(audit, format):
    seed(audit, 4)
    exported, cursor = [], None
    while True:
        result = audit.export(format, actor="human", origin="ui", limit=3, cursor=cursor, actions=["run.stop"])
        records = json.loads(result["content"]) if format == "json" else list(csv.DictReader(io.StringIO(result["content"])))
        exported.extend(int(row["id"]) for row in records)
        cursor = result["next_cursor"]
        if cursor is None:
            break
    assert exported == list(range(8, 0, -1))
    exports = [r for r in rows(audit) if r["action"] == "audit.export"]
    assert len(exports) == 6
    assert [r["detail"] for r in exports] == ["intent", "result"] * 3
    assert audit.verify()["ok"] is True


def test_export_unfiltered_does_not_loop_over_its_own_new_events(audit):
    seed(audit, 2)
    first = audit.export("json", actor="human", origin="ui", limit=1)
    ids = [event["id"] for event in json.loads(first["content"])]
    cursor = first["next_cursor"]
    for _ in range(5):
        if cursor is None:
            break
        page = audit.export("json", actor="human", origin="ui", limit=1, cursor=cursor)
        ids.extend(event["id"] for event in json.loads(page["content"]))
        cursor = page["next_cursor"]
    assert cursor is None
    assert ids == [5, 4, 3, 2, 1]


def test_filters_use_parameters_and_csv_formula_is_neutralized(audit):
    seed(audit)
    audit.act("@operator", "bot.create", "bot_2", "system", lambda: None, bot="sales")
    assert len(audit.page(bot="vendas", actor="human", actions=["run.stop"], outcome="ok", q="intent")["events"]) == 1
    timestamp = rows(audit)[0]["ts"]
    assert [e["id"] for e in audit.page(from_ts=timestamp, to_ts=timestamp)["events"]] == [1]
    assert audit.page(q="' OR 1=1 --")["events"] == []
    result = audit.export("csv", actor="human", origin="ui", bot="sales")
    assert all(row["actor"] == "'@operator" for row in csv.DictReader(io.StringIO(result["content"])))


@pytest.mark.parametrize("kwargs", [{"limit": 0}, {"limit": 201}, {"limit": True}, {"cursor": "bad"},
                                    {"cursor": "bnVsbA=="}])
def test_bad_pagination_is_rejected(audit, kwargs):
    with pytest.raises(ValueError):
        audit.page(**kwargs)


def test_a_transient_disk_io_error_is_retried_but_nothing_else_is(audit, monkeypatch):
    """S-env: SQLITE_IOERR happens now and then on a loaded container disk. The append is one transaction, so a rollback and a
    second try is safe; a lock, a trigger refusal or any other failure still fails closed on the first attempt."""
    real, calls = AuditLog._connect, []

    def flaky(failures, error):
        def connect(self):
            calls.append(1)
            if len(calls) <= failures:
                raise error
            return real(self)
        return connect

    monkeypatch.setattr(AuditLog, "_connect", flaky(2, sqlite3.OperationalError("disk I/O error")))
    seed(audit)
    assert len(calls) == 4 and len(rows(audit)) == 2                      # intent: two failures then the row; result: first try; each once
    calls.clear()
    monkeypatch.setattr(AuditLog, "_connect", flaky(99, sqlite3.OperationalError("disk I/O error")))
    with pytest.raises(AuditUnavailable):
        seed(audit)
    assert len(calls) == 4 and len(rows(audit)) == 2                      # bounded: three retries and a last try, then closed
    for error in (sqlite3.OperationalError("database is locked"), sqlite3.IntegrityError("audit_log is append-only")):
        calls.clear()
        monkeypatch.setattr(AuditLog, "_connect", flaky(99, error))
        with pytest.raises(AuditUnavailable):
            seed(audit)
        assert len(calls) == 1, error                                      # no retry: that would hide a lock or a tamper refusal
    assert len(rows(audit)) == 2
