"""The budget executor (contract v0.2 section 5, invariant 7): applies what `Budget` decided, through official Hermes paths only.

`Budget` returns a plan and applies nothing; this module does, step by step, each step audited (`budget.executor.step`),
idempotent, and applied again on every watcher pass while the Bot sits in `budget_pauses`: `Budget.evaluate` returns the plan of
any paused Bot, even after its cause is gone, so a job somebody resumed in the Hermes dashboard is paused again (S03).
Everything that touches Hermes is injected (`cron`, `stop_runs`), so the logic is tested alone and again against the real Hermes
in the harness.

* pause_cron_jobs  every enabled job of the Bot is paused with reason `luvebot:budget` (A-27: the reason is how resume knows
                   which jobs are ours; a job a person paused keeps its own reason and is never resumed by us).
* stop_active_runs the injected `stop_runs(bot)` (the v0 stop service for runs in `run_index`).
* refuse_new_runs not a write: every LuveBot entry that starts work asks `Budget.check_new_run` first (runs.budget_gate).
* engage_estop    always `skipped` (A-34): Hermes `disengage()` also removes the FLEET-ROOT sentinel, so LuveBot could not undo
                   what it engaged without editing Hermes files itself (invariant 4), and invariant 7 does not depend on it.
* alert           an audit row per threshold (`budget.alert`).
"""
import sqlite3
import time

REASON = "luvebot:budget"
SCHEMA = """
CREATE TABLE IF NOT EXISTS budget_exec_jobs (bot TEXT NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY(bot, job_id));
CREATE TABLE IF NOT EXISTS budget_exec_state (bot TEXT PRIMARY KEY, since REAL NOT NULL, estop_noted INTEGER NOT NULL DEFAULT 0);
"""
_TERMINAL = {"completed", "error"}


class Executor:
    def __init__(self, path, budget, audit, cron, runs, *, clock=time.time):
        """`runs`: `.open(bot) -> [run ids]` and `.stop(bot, run_id) -> bool` (True only when Hermes confirms the run ended)."""
        self.path, self.budget, self.audit, self.cron, self.runs, self.clock = path, budget, audit, cron, runs, clock
        conn = self._connect()
        conn.close()

    def _connect(self):
        conn = sqlite3.connect(self.path, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.executescript(SCHEMA)
        return conn

    def _step(self, bot, step, payload, fn):
        return self.audit.act("system", "budget.executor.step", bot, "system", fn, bot=bot, payload={"step": step, **payload})

    def paused_bots(self):
        conn = self._connect()
        try:
            return [r[0] for r in conn.execute("SELECT bot FROM budget_pauses ORDER BY bot")]
        except sqlite3.OperationalError:
            return []
        finally:
            conn.close()

    def since(self, bot):
        conn = self._connect()
        try:
            row = conn.execute("SELECT since FROM budget_exec_state WHERE bot=?", (bot,)).fetchone()
            return row[0] if row else None
        finally:
            conn.close()

    def apply(self, bot):
        """Bring one paused Bot to the state invariant 7 asks for. -> {paused: [job ids], stopped: int, failed: [step names]}."""
        out = {"paused": [], "stopped": 0, "failed": []}
        conn = self._connect()
        try:
            conn.execute("INSERT OR IGNORE INTO budget_exec_state (bot, since) VALUES(?,?)", (bot, self.clock()))
            conn.commit()
            noted = conn.execute("SELECT estop_noted FROM budget_exec_state WHERE bot=?", (bot,)).fetchone()[0]
            try:
                jobs = self.cron.list_jobs(bot)
            except Exception:
                jobs = None
                out["failed"].append("pause_cron_jobs")
            for job in jobs or []:
                job_id, state = job.get("id"), job.get("state")
                if not job_id or state in _TERMINAL:
                    continue
                if job.get("enabled") is False or state == "paused":
                    if job.get("paused_reason") == REASON:
                        conn.execute("INSERT OR IGNORE INTO budget_exec_jobs VALUES(?,?)", (bot, job_id))  # ours already
                        conn.commit()  # no write transaction stays open while the audit log writes
                    continue
                try:
                    self._step(bot, "pause_cron_job", {"job": job_id}, lambda j=job_id: self.cron.pause(bot, j, REASON))
                    conn.execute("INSERT OR IGNORE INTO budget_exec_jobs VALUES(?,?)", (bot, job_id))
                    conn.commit()
                    out["paused"].append(job_id)
                except Exception:
                    out["failed"].append("pause_cron_job:" + str(job_id))
            conn.commit()
            try:
                open_runs = list(self.runs.open(bot))
            except Exception:
                open_runs = []
                out["failed"].append("stop_active_runs")
            for run_id in open_runs:
                # S08: the attempt is on the audit log BEFORE the call, and it counts as applied only when Hermes confirms the end
                try:
                    confirmed = self._step(bot, "stop_run", {"run": run_id}, lambda r=run_id: self.runs.stop(bot, r))
                except Exception:
                    confirmed = False
                if confirmed:
                    out["stopped"] += 1
                else:
                    out["failed"].append("stop_run:" + str(run_id))  # the plan stays pending; the next tick tries again
            if not noted:
                self._step(bot, "engage_estop", {"result": "skipped", "why": "disengage is not profile-scoped (A-34)"}, lambda: None)
                conn.execute("UPDATE budget_exec_state SET estop_noted=1 WHERE bot=?", (bot,))
                conn.commit()
        finally:
            conn.close()
        return out

    def alert(self, decision):
        """One audit row per threshold crossed (the Budget hands each alert out exactly once)."""
        for item in decision.get("alerts") or []:
            target = item.get("ref") or "global"
            self.audit.act("system", "budget.alert", target, "system", lambda: None,
                           bot=item.get("ref") if item.get("scope") == "bot" else None,
                           payload={k: item.get(k) for k in ("scope", "ref", "period", "threshold", "cap", "spent")})

    def handle(self, decision):
        """A decision from the watcher: alerts, and an immediate apply for every Bot its plan names."""
        self.alert(decision)
        bots = {p["bot"] for p in decision.get("plans") or []} | ({decision["plan"]["bot"]} if decision.get("plan") else set())
        return {bot: self.apply(bot) for bot in sorted(bots)}

    def resume(self, bot):
        """After `Budget.resume` lifted the pause: resume ONLY the jobs this executor paused and that still carry its reason."""
        if bot in self.paused_bots():
            return {"resumed": [], "kept": []}
        conn = self._connect()
        done, kept = [], []
        try:
            ours = [r[0] for r in conn.execute("SELECT job_id FROM budget_exec_jobs WHERE bot=?", (bot,))]
            try:
                current = {j.get("id"): j for j in self.cron.list_jobs(bot)}
            except Exception:
                return {"resumed": [], "kept": ours}  # keep the ledger; a later call retries
            try:
                capped = self.budget.routines_over_cap()  # S01: a routine whose own cap is still reached is not given back
            except Exception:
                capped = set(ours)
            for job_id in ours:
                job = current.get(job_id)
                if job_id in capped:
                    kept.append(job_id)
                    continue  # stays paused and stays in the ledger: a later resume tries again
                if job is not None and job.get("state") == "paused" and job.get("paused_reason") == REASON:
                    self._step(bot, "resume_cron_job", {"job": job_id}, lambda j=job_id: self.cron.resume(bot, j))
                    done.append(job_id)
                else:
                    kept.append(job_id)
                conn.execute("DELETE FROM budget_exec_jobs WHERE bot=? AND job_id=?", (bot, job_id))
                conn.commit()
            conn.execute("DELETE FROM budget_exec_state WHERE bot=?", (bot,))
            conn.commit()
        finally:
            conn.close()
        return {"resumed": done, "kept": kept}
