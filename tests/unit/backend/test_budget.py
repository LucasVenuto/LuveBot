"""Budget safety on real SQLite, including a synchronized 20-thread mutation."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import os
import sqlite3
import threading

import pytest

from backend.audit import AuditLog, AuditUnavailable
from backend.budget import Budget, BudgetExceeded, BudgetUnavailable, MAX_CENTS


class Clock:
    now = datetime(2026, 1, 31, 12, tzinfo=timezone.utc)

    def __call__(self):
        return self.now


@pytest.fixture
def budget(tmp_path):
    clock = Clock()
    result = Budget(tmp_path / "private" / "luvebot.db", clock=clock, stop_percent=100)
    result.heartbeat()
    return result


def cap(budget, cents, *, scope="bot", ref="alpha", period="day"):
    budget.set_limit(scope, ref, period, cents, actor="human")


def test_parallel_starts_20_threads_respect_small_cap(budget, monkeypatch):
    cap(budget, 50)
    start, reads = threading.Barrier(20), threading.Barrier(20)
    original_decision = budget._decision

    def synchronized_decision(conn, *args, **kwargs):
        result = original_decision(conn, *args, **kwargs)
        # Without an explicit transaction, synchronize stale reads before writes.
        # With BEGIN IMMEDIATE the protected read cannot overlap another writer.
        if not conn.in_transaction:
            reads.wait(timeout=10)
        return result

    monkeypatch.setattr(budget, "_decision", synchronized_decision)
    if os.environ.get("LUVE_BUDGET_MUTATE_BEGIN") == "1":
        class MissingBegin(sqlite3.Connection):
            def execute(self, sql, parameters=()):
                if sql == "BEGIN IMMEDIATE":
                    return super().execute("SELECT 1")
                return super().execute(sql, parameters)

        def connect_without_begin():
            conn = sqlite3.connect(budget.path, timeout=10, factory=MissingBegin)
            conn.row_factory = sqlite3.Row
            return conn
        monkeypatch.setattr(budget, "_connect", connect_without_begin)

    def attempt(_):
        start.wait(timeout=10)
        try:
            return budget.reserve("alpha", 10)
        except BudgetExceeded:
            return None

    with ThreadPoolExecutor(max_workers=20) as pool:
        accepted = [r for r in pool.map(attempt, range(20)) if r is not None]
    assert len(accepted) == 5
    with sqlite3.connect(budget.path) as conn:
        assert conn.execute("SELECT SUM(estimate) FROM budget_reservations WHERE status='open'").fetchone()[0] == 50
    assert budget.audit.verify()["ok"] is True


def test_global_reservations_compete_across_bots(budget):
    cap(budget, 20, scope="global", ref=None)
    budget.reserve("alpha", 15)
    with pytest.raises(BudgetExceeded):
        budget.reserve("beta", 6)
    budget.reserve("beta", 5)
    assert budget.check_new_run("gamma")["allowed"] is False


def test_all_scopes_and_both_periods_compose(budget):
    cap(budget, 100, scope="global", ref=None, period="day")
    cap(budget, 80, scope="global", ref=None, period="month")
    cap(budget, 70)
    cap(budget, 60, period="month")
    cap(budget, 50, scope="routine", ref="daily")
    cap(budget, 40, scope="routine", ref="daily", period="month")
    with pytest.raises(BudgetExceeded):
        budget.reserve("alpha", 41, routine="daily")
    token = budget.reserve("alpha", 40, routine="daily")
    result = budget.commit(token, 40)
    assert result["breaches"][0]["scope"] == "routine"
    assert budget.check_new_run("alpha", routine="daily")["allowed"] is False
    assert budget.check_new_run("beta")["allowed"] is True


def test_commit_actual_releases_estimate_and_is_idempotent(budget):
    cap(budget, 100)
    token = budget.reserve("alpha", 80)
    budget.commit(token, 20)
    budget.commit(token, 20)
    budget.reserve("alpha", 80)
    with pytest.raises(ValueError, match="different actual"):
        budget.commit(token, 21)
    with sqlite3.connect(budget.path) as conn:
        assert conn.execute("SELECT SUM(cents) FROM budget_spend").fetchone()[0] == 20


def test_commit_race_counts_expense_once(budget):
    cap(budget, 100)
    token = budget.reserve("alpha", 10)
    with ThreadPoolExecutor(max_workers=20) as pool:
        results = list(pool.map(lambda _: budget.commit(token, 10), range(20)))
    assert all(result["allowed"] for result in results)
    with sqlite3.connect(budget.path) as conn:
        assert conn.execute("SELECT COUNT(*),SUM(cents) FROM budget_spend").fetchone() == (1, 10)


def test_overshoot_returns_exact_pause_plan_and_human_resume(budget):
    cap(budget, 100)
    token = budget.reserve("alpha", 10)
    result = budget.commit(token, 120)
    expected = {"bot": "alpha", "steps": ["pause_cron_jobs", "engage_estop", "stop_active_runs",
                                          "refuse_new_runs", "alert"], "requires_human_resume": True}
    assert result["plan"] == expected
    assert budget.on_breach("alpha") == expected
    assert budget.check_new_run("alpha")["allowed"] is False
    assert budget.resume("alpha", actor="human", human=True)["allowed"] is False
    cap(budget, 200)
    assert budget.check_new_run("alpha")["reason"] == "bot_paused"
    assert budget.resume("alpha", actor="human", human=True)["allowed"] is True


@pytest.mark.parametrize("human,origin", [(False, "ui"), (1, "ui"), (True, "agent"), (True, "system")])
def test_resume_and_limit_changes_require_human(budget, human, origin):
    budget.on_breach("alpha")
    with pytest.raises(ValueError, match="human"):
        budget.resume("alpha", actor="agent", origin=origin, human=human)
    with pytest.raises(ValueError, match="human"):
        budget.set_limit("bot", "alpha", "day", 100, actor="agent", origin=origin, human=human)
    assert budget.check_new_run("alpha")["reason"] == "bot_paused"


def test_alerts_50_80_100_once_per_period_even_after_limit_change(budget):
    cap(budget, 100)
    cap(budget, 100, period="month")
    for index, (amount, threshold) in enumerate(((50, 50), (30, 80), (20, 100))):
        result = budget.record_spend(f"cost{index}", "alpha", amount)
        assert [(a["period"], a["threshold"]) for a in result["alerts"]] == [("day", threshold), ("month", threshold)]
        assert budget.check_new_run("alpha")["alerts"] == []
        assert budget.record_spend(f"cost{index}", "alpha", amount)["alerts"] == []
    cap(budget, 50)
    assert budget.check_new_run("alpha")["alerts"] == []


def test_global_breach_returns_plans_for_all_known_bots(budget):
    cap(budget, 100, scope="global", ref=None)
    budget.reserve("alpha", 10)
    budget.reserve("beta", 10)
    cap(budget, 200, ref="gamma")
    result = budget.record_spend("outside", "alpha", 100)
    assert [p["bot"] for p in result["plans"]] == ["alpha", "beta", "gamma"]
    assert budget.check_new_run("beta")["reason"] == "bot_paused"


def test_day_month_rollover_use_injected_timezone(budget):
    budget.tz = timezone(timedelta(hours=-3))
    budget.clock.now = datetime(2026, 2, 1, 2, 59, tzinfo=timezone.utc)
    budget.heartbeat()
    cap(budget, 100)
    cap(budget, 100, period="month")
    result = budget.record_spend("jan", "alpha", 50)
    assert {a["period_key"] for a in result["alerts"]} == {"2026-01-31", "2026-01"}
    budget.clock.now += timedelta(minutes=1)
    budget.heartbeat()
    result = budget.record_spend("feb", "alpha", 50)
    assert {a["period_key"] for a in result["alerts"]} == {"2026-02-01", "2026-02"}
    assert budget.check_new_run("alpha")["allowed"] is True


def test_day_rollover_does_not_reset_month_total_or_auto_resume(budget):
    budget.clock.now = datetime(2026, 1, 30, 12, tzinfo=timezone.utc)
    budget.heartbeat()
    cap(budget, 50)
    cap(budget, 70, period="month")
    budget.record_spend("day1", "alpha", 50)
    budget.clock.now = datetime(2026, 1, 31, 12, tzinfo=timezone.utc)
    budget.heartbeat()
    assert budget.check_new_run("alpha")["reason"] == "bot_paused"
    assert budget.resume("alpha", actor="human", human=True)["allowed"] is True
    with pytest.raises(BudgetExceeded):
        budget.reserve("alpha", 21)
    budget.reserve("alpha", 20)


def test_open_reservations_survive_rollover_and_actual_uses_commit_period(budget):
    cap(budget, 50)
    token = budget.reserve("alpha", 40)
    budget.clock.now += timedelta(days=1)
    budget.heartbeat()
    with pytest.raises(BudgetExceeded):
        budget.reserve("alpha", 11)
    budget.commit(token, 20)
    with sqlite3.connect(budget.path) as conn:
        assert conn.execute("SELECT day,month FROM budget_spend").fetchone() == ("2026-02-01", "2026-02")
    budget.reserve("alpha", 30)


@pytest.mark.parametrize("scope,ref", [("global", None), ("bot", "alpha"), ("routine", "daily")])
def test_zero_cap_blocks_even_zero_estimate(budget, scope, ref):
    cap(budget, 0, scope=scope, ref=ref)
    with pytest.raises(BudgetExceeded):
        budget.reserve("alpha", 0, routine="daily")
    assert budget.check_new_run("alpha", routine="daily")["allowed"] is False
    with sqlite3.connect(budget.path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM budget_reservations").fetchone()[0] == 0


@pytest.mark.parametrize("value", [-1, MAX_CENTS + 1, 1.0, True, "10", None, 10**100])
def test_invalid_cent_values_rejected_before_effect(budget, value):
    with pytest.raises(ValueError, match="cents"):
        cap(budget, value)
    with pytest.raises(ValueError, match="cents"):
        budget.reserve("alpha", value)
    with pytest.raises(ValueError, match="cents"):
        budget.commit("unknown", value)
    with pytest.raises(ValueError, match="cents"):
        budget.record_spend("external", "alpha", value)


def test_default_margin_stops_at_90_percent(budget):
    budget.stop_percent = 90
    cap(budget, 100)
    with pytest.raises(BudgetExceeded):
        budget.reserve("alpha", 91)
    token = budget.reserve("alpha", 90)
    result = budget.commit(token, 90)
    assert result["allowed"] is False
    assert [a["threshold"] for a in result["alerts"]] == [50, 80]
    assert result["plan"] is not None


def test_missing_stale_and_future_watcher_fail_closed(budget):
    with sqlite3.connect(budget.path) as conn:
        conn.execute("DELETE FROM budget_watcher")
    assert budget.check_new_run("alpha")["reason"] == "watcher_stale"
    budget.heartbeat()
    budget.clock.now += timedelta(seconds=301)
    with pytest.raises(BudgetExceeded, match="watcher_stale"):
        budget.reserve("alpha", 1)
    budget.heartbeat()
    assert budget.check_new_run("alpha")["allowed"] is True
    budget.clock.now -= timedelta(seconds=1)
    assert budget.check_new_run("alpha")["allowed"] is False


def test_all_limit_changes_use_audit_and_fail_closed(budget):
    cap(budget, 10)
    cap(budget, 20)
    events = budget.audit.page(actions=["budget.limit.set"])["events"]
    assert [e["detail"] for e in reversed(events)] == ["intent", "result"] * 2
    assert all(e["actor"] == "human" and e["digest"] for e in events)
    with sqlite3.connect(budget.path) as conn:
        conn.execute("CREATE TRIGGER failed_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'no audit'); END")
    with pytest.raises(AuditUnavailable):
        cap(budget, 999)
    with sqlite3.connect(budget.path) as conn:
        assert conn.execute("SELECT cents FROM budget_limits").fetchone()[0] == 20


def test_persistence_same_database_and_expense_idempotency(budget):
    cap(budget, 100)
    token = budget.reserve("alpha", 20)
    reopened = Budget(budget.path, clock=budget.clock, stop_percent=100)
    reopened.commit(token, 10)
    reopened.record_spend("outside", "alpha", 50)
    assert reopened.record_spend("outside", "alpha", 50)["alerts"] == []
    with pytest.raises(ValueError, match="different data"):
        reopened.record_spend("outside", "beta", 50)
    with sqlite3.connect(budget.path) as conn:
        assert conn.execute("SELECT SUM(cents) FROM budget_spend").fetchone()[0] == 60
    assert reopened.audit.verify()["ok"] is True


def test_locked_budget_state_never_allows_new_work(budget):
    budget.timeout = 0.01
    budget.audit.timeout = 0.01
    with sqlite3.connect(budget.path) as locker:
        locker.execute("BEGIN IMMEDIATE")
        with pytest.raises(AuditUnavailable):
            budget.reserve("alpha", 1)
    with sqlite3.connect(budget.path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM budget_reservations").fetchone()[0] == 0


def test_unreadable_budget_tables_fail_closed_after_intent(budget):
    with sqlite3.connect(budget.path) as conn:
        conn.execute("DROP TABLE budget_limits")
    with pytest.raises(BudgetUnavailable):
        budget.check_new_run("alpha")
    assert budget.audit.verify()["ok"] is True
    assert budget.audit.page(actions=["budget.check"])["events"][0]["outcome"] == "error"


def test_allowed_reservation_does_not_consume_alerts(budget):
    budget.record_spend("outside", "alpha", 50)
    cap(budget, 100)
    budget.reserve("alpha", 1)
    assert [alert["threshold"] for alert in budget.check_new_run("alpha")["alerts"]] == [50]


def test_routine_breach_returns_plans_for_affected_bots(budget):
    cap(budget, 100, scope="routine", ref="shared")
    budget.reserve("alpha", 10, routine="shared")
    budget.reserve("beta", 10, routine="shared")
    result = budget.record_spend("outside", "alpha", 100, routine="shared")
    assert [plan["bot"] for plan in result["plans"]] == ["alpha", "beta"]


def test_resume_preserves_new_alerts_and_named_timezone(tmp_path):
    clock = Clock()
    budget = Budget(tmp_path / "private" / "luvebot.db", clock=clock, tz="America/Sao_Paulo", stop_percent=100)
    budget.heartbeat()
    budget.record_spend("expense", "alpha", 50)
    budget.on_breach("alpha")
    cap(budget, 100)
    result = budget.resume("alpha", actor="human", human=True)
    assert result["allowed"] is True
    assert [alert["threshold"] for alert in result["alerts"]] == [50]


@pytest.mark.parametrize("scope,ref,period", [("model", "alpha", "day"), ("bot", "alpha", "year"),
                                           ("global", "alpha", "day"), ("routine", "../evil", "day")])
def test_bad_scope_or_identifier_rejected(budget, scope, ref, period):
    with pytest.raises(ValueError):
        budget.set_limit(scope, ref, period, 100, actor="human")


def test_unknown_reservation_rejected_and_audited(budget):
    with pytest.raises(ValueError, match="unknown reservation"):
        budget.commit("missing", 10)
    assert budget.audit.page(actions=["budget.commit"])["events"][0]["outcome"] == "error"
