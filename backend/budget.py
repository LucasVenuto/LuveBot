"""Integer-cent budget decisions only; a separate executor applies Hermes plans."""

from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import re
import sqlite3
import uuid
from zoneinfo import ZoneInfo

from . import dbfile
from .audit import ActionDenied, AuditLog


MAX_CENTS = 10**12
SCHEMA = """
CREATE TABLE IF NOT EXISTS budget_limits (
 scope TEXT NOT NULL, ref TEXT NOT NULL, period TEXT NOT NULL, cents INTEGER NOT NULL,
 PRIMARY KEY(scope, ref, period));
CREATE TABLE IF NOT EXISTS budget_reservations (
 id TEXT PRIMARY KEY, bot TEXT NOT NULL, routine TEXT, estimate INTEGER NOT NULL,
 actual INTEGER, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS budget_spend (
 id TEXT PRIMARY KEY, bot TEXT NOT NULL, routine TEXT, cents INTEGER NOT NULL,
 day TEXT NOT NULL, month TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS budget_alerts (
 scope TEXT NOT NULL, ref TEXT NOT NULL, period TEXT NOT NULL, period_key TEXT NOT NULL,
 threshold INTEGER NOT NULL, PRIMARY KEY(scope, ref, period, period_key, threshold));
CREATE TABLE IF NOT EXISTS budget_pauses (bot TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS budget_watcher (id INTEGER PRIMARY KEY CHECK(id=1), ts TEXT NOT NULL);
"""


class BudgetUnavailable(RuntimeError):
    def __init__(self):
        super().__init__("budget_unavailable")


def _budget_read(path, sql, args=()):
    """Read-only look at the Budget's own tables (backend/budget.py owns the writes). Invariant 7 fails closed: a table that does not
    exist yet means nothing was ever paused or capped (False), but any other database error (locked past the timeout, malformed,
    unreadable) raises BudgetUnavailable (503 budget_unavailable), never a False that would let work start."""
    try:
        conn = sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=5)
        try:
            return conn.execute(sql, args).fetchone() is not None
        finally:
            conn.close()
    except sqlite3.OperationalError as error:
        if str(error).startswith('no such table'):
            return False
        raise BudgetUnavailable() from None
    except sqlite3.Error as error:
        if dbfile.damaged(error):
            raise  # a damaged luvebot.db: luvebot_db_unavailable (SafeRoute); the gates refuse all the same
        raise BudgetUnavailable() from None


def is_paused(path, bot):
    return _budget_read(path, 'SELECT 1 FROM budget_pauses WHERE bot=?', (bot,))


def has_limits(path):
    return _budget_read(path, 'SELECT 1 FROM budget_limits LIMIT 1')


class BudgetExceeded(ActionDenied):
    def __init__(self, decision):
        super().__init__(decision["reason"])
        self.decision = decision


def _cents(value):
    if type(value) is not int or not 0 <= value <= MAX_CENTS:
        raise ValueError("invalid cents")
    return value


def _name(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", value):
        raise ValueError("invalid budget identifier")
    return value


class Budget:
    def __init__(self, path=None, *, audit=None, clock=None, tz="UTC", stop_percent=90,
                 watcher_max_age=300, timeout=5):
        if type(stop_percent) is not int or not 1 <= stop_percent <= 100:
            raise ValueError("invalid stop percent")
        if type(watcher_max_age) is not int or watcher_max_age < 1:
            raise ValueError("invalid watcher age")
        self.path = Path(path or Path.home() / ".hermes/luvebot/luvebot.db")
        self.audit = audit or AuditLog(self.path)
        if Path(self.audit.path).resolve() != self.path.resolve():
            raise ValueError("audit and budget must share a database")
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.tz = ZoneInfo(tz) if isinstance(tz, str) else tz
        self.stop_percent = stop_percent
        self.watcher_max_age = watcher_max_age
        self.timeout = timeout
        with self._transaction() as conn:
            for statement in SCHEMA.split(";"):
                if statement.strip():
                    conn.execute(statement)

    def _connect(self):
        conn = sqlite3.connect(self.path, timeout=self.timeout)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA recursive_triggers=ON")
        conn.execute("PRAGMA synchronous=FULL")
        return conn

    @contextmanager
    def _transaction(self):
        conn = None
        try:
            conn = self._connect()
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except (sqlite3.Error, OSError) as error:
            if dbfile.damaged(error):
                raise  # a damaged luvebot.db: luvebot_db_unavailable (SafeRoute), never "budget unavailable"
            raise BudgetUnavailable() from None
        finally:
            if conn is not None:
                conn.close()

    def _now(self):
        now = self.clock()
        if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("budget clock must be timezone aware")
        return now.astimezone(self.tz)

    @staticmethod
    def _human(actor, origin, human):
        kind = origin if isinstance(origin, str) else origin.get("kind") if isinstance(origin, dict) else None
        if human is not True or kind != "ui":
            raise ValueError("authenticated human required")
        if not isinstance(actor, str) or not actor:
            raise ValueError("authenticated human required")

    def set_limit(self, scope, ref, period, cents, *, actor, origin="ui", human=True):
        self._human(actor, origin, human)
        if scope not in ("global", "bot", "routine") or period not in ("day", "month"):
            raise ValueError("invalid budget scope or period")
        if scope == "global":
            if ref is not None:
                raise ValueError("global ref must be null")
            ref = ""
        else:
            _name(ref)
        _cents(cents)

        def change():
            with self._transaction() as conn:
                conn.execute("INSERT INTO budget_limits VALUES(?,?,?,?) ON CONFLICT(scope,ref,period) "
                             "DO UPDATE SET cents=excluded.cents", (scope, ref, period, cents))
        return self.audit.act(actor, "budget.limit.set", ref or "global", origin, change,
                              bot=ref if scope == "bot" else None,
                              payload={"scope": scope, "period": period, "cents": cents})

    def heartbeat(self):
        """Caller asserts that it just consumed a complete, current cost snapshot."""
        def change():
            with self._transaction() as conn:
                conn.execute("INSERT INTO budget_watcher VALUES(1,?) ON CONFLICT(id) DO UPDATE SET ts=excluded.ts",
                             (self._now().isoformat(),))
        return self.audit.act("system", "budget.heartbeat", None, "system", change)

    @staticmethod
    def _plan(bot):
        return {"bot": bot, "steps": ["pause_cron_jobs", "engage_estop", "stop_active_runs",
                                      "refuse_new_runs", "alert"], "requires_human_resume": True}

    def _decision(self, conn, bot, routine=None, estimate=0, *, watcher=True, emit_alerts=True):
        now = self._now()
        periods = {"day": now.strftime("%Y-%m-%d"), "month": now.strftime("%Y-%m")}
        alerts, breaches, capacity = [], [], []
        for limit in conn.execute("SELECT * FROM budget_limits ORDER BY scope, ref, period").fetchall():
            scope, ref, period, cap = limit["scope"], limit["ref"], limit["period"], limit["cents"]
            if scope == "bot" and ref != bot or scope == "routine" and ref != routine:
                continue
            where, args = ("1=1", []) if scope == "global" else (f"{scope if scope == 'bot' else 'routine'}=?", [ref])
            spent = conn.execute(f"SELECT COALESCE(SUM(cents),0) FROM budget_spend WHERE {where} AND {period}=?",
                                 args + [periods[period]]).fetchone()[0]
            held = conn.execute(f"SELECT COALESCE(SUM(estimate),0) FROM budget_reservations WHERE {where} AND status='open'",
                                args).fetchone()[0]
            reason = {"scope": scope, "ref": ref or None, "period": period, "period_key": periods[period],
                      "cap": cap, "spent": spent, "reserved": held}
            for threshold in ((100,) if cap == 0 else (50, 80, 100)):
                if emit_alerts and spent * 100 >= cap * threshold:
                    inserted = conn.execute("INSERT OR IGNORE INTO budget_alerts VALUES(?,?,?,?,?)",
                                            (scope, ref, period, periods[period], threshold)).rowcount
                    if inserted:
                        alerts.append(dict(reason, threshold=threshold))
            if spent * 100 >= cap * self.stop_percent:
                breaches.append(reason)
            if cap == 0 or (spent + held) * 100 >= cap * self.stop_percent or (spent + held + estimate) * 100 > cap * self.stop_percent:
                capacity.append(reason)
        affected = {bot} if breaches else set()
        if breaches:
            conn.execute("INSERT OR IGNORE INTO budget_pauses VALUES(?)", (bot,))
            if any(item["scope"] == "global" for item in breaches):
                affected.update(row[0] for row in conn.execute(
                    "SELECT bot FROM budget_reservations UNION SELECT bot FROM budget_spend "
                    "UNION SELECT ref FROM budget_limits WHERE scope='bot'"))
            for item in breaches:
                if item["scope"] == "routine":
                    affected.update(row[0] for row in conn.execute(
                        "SELECT bot FROM budget_reservations WHERE routine=? UNION SELECT bot FROM budget_spend WHERE routine=?",
                        (item["ref"], item["ref"])))
            conn.executemany("INSERT OR IGNORE INTO budget_pauses VALUES(?)", [(name,) for name in affected])
        paused = conn.execute("SELECT 1 FROM budget_pauses WHERE bot=?", (bot,)).fetchone() is not None
        last = conn.execute("SELECT ts FROM budget_watcher WHERE id=1").fetchone()
        age = (now.astimezone(timezone.utc) - datetime.fromisoformat(last[0]).astimezone(timezone.utc)).total_seconds() if last else None
        stale = age is None or age < 0 or age > self.watcher_max_age
        reason = "bot_paused" if paused else "budget_exceeded" if capacity else "watcher_stale" if watcher and stale else None
        return {"allowed": reason is None, "reason": reason, "breaches": breaches, "alerts": alerts,
                "plan": self._plan(bot) if paused else None,
                "plans": [self._plan(name) for name in sorted(affected)], "watcher_stale": stale}

    def check_new_run(self, bot, *, routine=None):
        _name(bot)
        if routine is not None:
            _name(routine)
        def check():
            with self._transaction() as conn:
                return self._decision(conn, bot, routine)
        return self.audit.act("system", "budget.check", bot, "system", check, bot=bot)

    def reserve(self, bot, estimate, *, routine=None):
        _name(bot)
        _cents(estimate)
        if routine is not None:
            _name(routine)
        def reserve():
            with self._transaction() as conn:
                # This API returns only a token. Leave notifications for the
                # next check/commit/ingestion so an allowed reserve cannot eat them.
                decision = self._decision(conn, bot, routine, estimate, emit_alerts=False)
                token = uuid.uuid4().hex
                if decision["allowed"]:
                    conn.execute("INSERT INTO budget_reservations VALUES(?,?,?,?,NULL,'open')",
                                 (token, bot, routine, estimate))
            if not decision["allowed"]:
                raise BudgetExceeded(decision)
            return token
        return self.audit.act("system", "budget.reserve", bot, "system", reserve, bot=bot)

    def commit(self, reservation, actual):
        _name(reservation)
        _cents(actual)
        def commit():
            with self._transaction() as conn:
                row = conn.execute("SELECT * FROM budget_reservations WHERE id=?", (reservation,)).fetchone()
                if row is None:
                    raise ValueError("unknown reservation")
                if row["status"] == "committed":
                    if row["actual"] != actual:
                        raise ValueError("reservation already committed with different actual")
                else:
                    now = self._now()
                    conn.execute("UPDATE budget_reservations SET status='committed',actual=? WHERE id=?", (actual, reservation))
                    conn.execute("INSERT INTO budget_spend VALUES(?,?,?,?,?,?)",
                                 (reservation, row["bot"], row["routine"], actual, now.strftime("%Y-%m-%d"), now.strftime("%Y-%m")))
                return self._decision(conn, row["bot"], row["routine"], watcher=False)
        return self.audit.act("system", "budget.commit", reservation, "system", commit)

    def record_spend(self, event_id, bot, actual, *, routine=None):
        """Ingest a unique incremental expense from outside LuveBot; never a cumulative total."""
        _name(event_id)
        _name(bot)
        _cents(actual)
        if routine is not None:
            _name(routine)
        event_id = "external." + event_id
        def record():
            with self._transaction() as conn:
                existing = conn.execute("SELECT * FROM budget_spend WHERE id=?", (event_id,)).fetchone()
                if existing:
                    if (existing["bot"], existing["routine"], existing["cents"]) != (bot, routine, actual):
                        raise ValueError("expense id reused with different data")
                else:
                    now = self._now()
                    conn.execute("INSERT INTO budget_spend VALUES(?,?,?,?,?,?)",
                                 (event_id, bot, routine, actual, now.strftime("%Y-%m-%d"), now.strftime("%Y-%m")))
                return self._decision(conn, bot, routine, watcher=False)
        return self.audit.act("system", "budget.spend", bot, "system", record, bot=bot)

    def on_breach(self, bot):
        _name(bot)
        def pause():
            with self._transaction() as conn:
                conn.execute("INSERT OR IGNORE INTO budget_pauses VALUES(?)", (bot,))
                return self._plan(bot)
        return self.audit.act("system", "budget.breach", bot, "system", pause, bot=bot)

    def resume(self, bot, *, actor, origin="ui", human):
        self._human(actor, origin, human)
        _name(bot)
        def resume():
            with self._transaction() as conn:
                decision = self._decision(conn, bot)
                if not decision["breaches"] and not decision["watcher_stale"]:
                    conn.execute("DELETE FROM budget_pauses WHERE bot=?", (bot,))
                    rechecked = self._decision(conn, bot)
                    rechecked["alerts"] = decision["alerts"] + rechecked["alerts"]
                    decision = rechecked
                return decision
        return self.audit.act(actor, "budget.resume", bot, origin, resume, bot=bot)

    # ---- additions of T4.5 (contract v0.2 section 4, A-28): read and removal, nothing else changes above ----
    def delete_limit(self, scope, ref, period, *, actor, origin="ui", human=True):
        """Remove a cap (human only, audited). The pause that a breach already created stays until a human resumes."""
        self._human(actor, origin, human)
        if scope not in ("global", "bot", "routine") or period not in ("day", "month"):
            raise ValueError("invalid budget scope or period")
        if scope == "global":
            if ref is not None:
                raise ValueError("global ref must be null")
            ref = ""
        else:
            _name(ref)

        def change():
            with self._transaction() as conn:
                return conn.execute("DELETE FROM budget_limits WHERE scope=? AND ref=? AND period=?", (scope, ref, period)).rowcount
        return self.audit.act(actor, "budget.limit.delete", ref or "global", origin, change,
                              bot=ref if scope == "bot" else None, payload={"scope": scope, "period": period})

    def snapshot(self):
        """Read-only view for the Costs screen: caps with spend, holds and percent, paused Bots, the watcher and recent alerts."""
        with self._transaction() as conn:
            now = self._now()
            periods = {"day": now.strftime("%Y-%m-%d"), "month": now.strftime("%Y-%m")}
            limits = []
            for limit in conn.execute("SELECT * FROM budget_limits ORDER BY scope, ref, period").fetchall():
                scope, ref, period, cap = limit["scope"], limit["ref"], limit["period"], limit["cents"]
                where, args = ("1=1", []) if scope == "global" else (f"{scope if scope == 'bot' else 'routine'}=?", [ref])
                spent = conn.execute(f"SELECT COALESCE(SUM(cents),0) FROM budget_spend WHERE {where} AND {period}=?",
                                     args + [periods[period]]).fetchone()[0]
                held = conn.execute(f"SELECT COALESCE(SUM(estimate),0) FROM budget_reservations WHERE {where} AND status='open'",
                                    args).fetchone()[0]
                limits.append({"scope": scope, "ref": ref or None, "period": period, "cents": cap, "spent_cents": spent,
                               "reserved_cents": held, "percent": None if cap == 0 else round(spent * 100 / cap, 1)})
            paused = [row[0] for row in conn.execute("SELECT bot FROM budget_pauses ORDER BY bot")]
            last = conn.execute("SELECT ts FROM budget_watcher WHERE id=1").fetchone()
            age = (now.astimezone(timezone.utc) - datetime.fromisoformat(last[0]).astimezone(timezone.utc)).total_seconds() if last else None
            alerts = [dict(row) for row in conn.execute(
                "SELECT scope, ref, period, period_key, threshold FROM budget_alerts ORDER BY rowid DESC LIMIT 50")]
            return {"limits": limits, "paused": paused,
                    "watcher": {"last_at": last[0] if last else None, "age_s": age,
                                "stale": age is None or age < 0 or age > self.watcher_max_age},
                    "alerts": alerts}

    def routine_spend(self, period="month"):
        """{routine id: spent cents} for the current day or month: the number a Routine shows next to its cap."""
        if period not in ("day", "month"):
            raise ValueError("invalid budget period")
        with self._transaction() as conn:
            key = self._now().strftime("%Y-%m-%d" if period == "day" else "%Y-%m")
            return {row[0]: row[1] for row in conn.execute(
                f"SELECT routine, SUM(cents) FROM budget_spend WHERE routine IS NOT NULL AND {period}=? GROUP BY routine", (key,))}

    # ---- additions of T4.7 (S01, S03) ----------------------------------------------------------------------------------
    def evaluate(self, bot, *, routine=None):
        """The same decision `check_new_run` takes, without the two audit rows: for the periodic pass that looks at EVERY Bot
        and routine, whether or not new spend arrived. A breach it finds records the pause, as `check_new_run` does."""
        _name(bot)
        if routine is not None:
            _name(routine)
        with self._transaction() as conn:
            return self._decision(conn, bot, routine, watcher=False)

    def routines_over_cap(self):
        """Routine ids whose own cap is at the stop line now. A Bot's resume must not give these back (S01)."""
        with self._transaction() as conn:
            now = self._now()
            periods = {"day": now.strftime("%Y-%m-%d"), "month": now.strftime("%Y-%m")}
            over = set()
            for limit in conn.execute("SELECT * FROM budget_limits WHERE scope='routine'").fetchall():
                spent = conn.execute(f"SELECT COALESCE(SUM(cents),0) FROM budget_spend WHERE routine=? AND {limit['period']}=?",
                                     (limit["ref"], periods[limit["period"]])).fetchone()[0]
                if spent * 100 >= limit["cents"] * self.stop_percent:
                    over.add(limit["ref"])
            return over
