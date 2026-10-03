"""The Hermes side of Phase 4: cron jobs, their run history and the sessions' cost (contract v0.2 sections 1, 3, 5, 6).

Every function runs IN the dashboard process and goes through Hermes's own code, never through its files (invariant 4):
  hermes_cli/web_server_cron.py  `_call_cron_for_profile` / `_mutate_cron_for_profile` (profile-scoped store + scheduler reconcile)
  cron/jobs.py                   list_jobs, get_job, pause_job(reason), resume_job, trigger_job, update_job, remove_job
  hermes_state_portability.py    `SessionDB.list_cron_job_runs(job_id, limit, offset)` (the dashboard route reads offset 0 only)
These helpers are private to Hermes (underscore), so `available()` probes them (invariant 9) and callers answer
`capability_missing` instead of guessing when they are not there.
"""
CRON_FUNCS = ("_call_cron_for_profile", "_mutate_cron_for_profile")


def available():
    """-> (ok, missing list). Imports lazily so a test process without Hermes can still load this module."""
    missing = []
    try:
        from hermes_cli import web_server_cron
        missing += [n for n in CRON_FUNCS if not hasattr(web_server_cron, n)]
    except Exception:
        missing += list(CRON_FUNCS)
    try:
        from hermes_cli import web_server_sessions
        if not hasattr(web_server_sessions, "_open_session_db_for_profile"):
            missing.append("_open_session_db_for_profile")
    except Exception:
        missing.append("_open_session_db_for_profile")
    return not missing, missing


def _cron():
    from hermes_cli import web_server_cron
    return web_server_cron


class HermesCron:
    """Cron jobs of one profile at a time. Synchronous: call it from the threadpool."""

    def list_jobs(self, bot):
        return list(_cron()._call_cron_for_profile(bot, "list_jobs", True) or [])

    def get(self, bot, job_id):
        return _cron()._call_cron_for_profile(bot, "get_job", job_id)

    def pause(self, bot, job_id, reason):
        return _cron()._mutate_cron_for_profile(bot, "pause_job", job_id, reason=reason)

    def resume(self, bot, job_id):
        return _cron()._mutate_cron_for_profile(bot, "resume_job", job_id)

    def trigger(self, bot, job_id):
        return _cron()._mutate_cron_for_profile(bot, "trigger_job", job_id)

    def remove(self, bot, job_id):
        return _cron()._mutate_cron_for_profile(bot, "remove_job", job_id)

    def update(self, bot, job_id, updates):
        return _cron()._mutate_cron_for_profile(bot, "update_job", job_id, updates)

    def create(self, bot, **fields):
        return _cron()._mutate_cron_for_profile(bot, "create_job", **fields)


def _session_db(bot):
    from hermes_cli.web_server_sessions import _open_session_db_for_profile
    return _open_session_db_for_profile(bot, read_only=True)


def job_runs(bot, job_id, limit, offset):
    """Run sessions of one job, newest first, by offset: the history the dashboard route cuts at 100 rows from offset 0."""
    db = _session_db(bot)
    try:
        return db.list_cron_job_runs(job_id, limit=limit, offset=offset)
    finally:
        db.close()


def user_prompts(bot, session_ids, digest, per_session=50):
    """{digest(text): first 400 characters} of the person's messages in those sessions, `digest` being RunIndex.prompt_digest
    (keyed). Read-only, from Hermes's own store: LuveBot keeps no message text; a run's title is the message its digest names."""
    if not session_ids:
        return {}
    db = _session_db(bot)
    try:
        marks = ",".join("?" for _ in session_ids)
        rows = db._read_rows(
            f"SELECT content FROM messages WHERE role = 'user' AND session_id IN ({marks}) AND length(content) <= 60000 "
            f"ORDER BY id DESC LIMIT ?", (*session_ids, per_session * len(session_ids)))
        return {digest(r["content"]): r["content"][:400] for r in rows if isinstance(r["content"], str)}
    finally:
        db.close()


def sessions_for_cost(bot, since):
    """Sessions that may still be costing money: started since `since` (epoch) or still open. Read-only.
    -> [{id, source, model, started_at, ended_at, actual_usd, estimated_usd, cost_status, input_tokens, output_tokens}]"""
    db = _session_db(bot)
    try:
        rows = db._read_rows(
            "SELECT id, source, model, started_at, ended_at, actual_cost_usd, estimated_cost_usd, cost_status, input_tokens, output_tokens "
            "FROM sessions WHERE started_at >= ? OR ended_at IS NULL", (since,))
        return [{"id": r["id"], "source": r["source"], "model": r["model"], "started_at": r["started_at"], "ended_at": r["ended_at"],
                 "actual_usd": r["actual_cost_usd"], "estimated_usd": r["estimated_cost_usd"], "cost_status": r["cost_status"],
                 "input_tokens": r["input_tokens"], "output_tokens": r["output_tokens"]} for r in rows]
    finally:
        db.close()


def fire(bot, job_id):
    """Run ONE job now, off-tick, the way the dashboard's own "run" does (never forced: a paused job is refused before this)."""
    return _cron()._fire_cron_job_for_profile(bot, job_id, force=False)


def cron_sessions(bot, since):
    """Sessions of cron runs since `since` (epoch), newest first, read-only, for the Activity list."""
    db = _session_db(bot)
    try:
        rows = db._read_rows(
            "SELECT id, title, started_at, ended_at, actual_cost_usd, estimated_cost_usd FROM sessions WHERE source='cron' AND "
            "(started_at >= ? OR ended_at IS NULL) ORDER BY started_at DESC LIMIT 500", (since,))
        return [{"id": r["id"], "title": r["title"], "started_at": r["started_at"], "ended_at": r["ended_at"],
                 "actual_usd": r["actual_cost_usd"], "estimated_usd": r["estimated_cost_usd"]} for r in rows]
    finally:
        db.close()


def kanban_tasks(bot):
    """Kanban tasks assigned to a Bot (the dashboard's own board reader), as plain dicts."""
    from contextlib import closing
    from hermes_cli import kanban_db
    from plugins.kanban.dashboard import plugin_api as kanban
    with kanban._board_conn(None) as (_board, conn):
        return [{"id": t.id, "title": t.title, "assignee": t.assignee, "created_by": t.created_by, "status": t.status,
                 "started_at": t.started_at, "completed_at": t.completed_at} for t in kanban_db.list_tasks(conn, assignee=bot)]


# ---- Kanban actions (contract v0.2 section 2): in process, through Hermes's own kanban_db, never from the browser ----------
def _kanban():
    from hermes_cli import kanban_db
    from plugins.kanban.dashboard import plugin_api as kanban
    return kanban_db, kanban


def kanban_task(task_id):
    """-> {id, assignee, status, current_run_id, created_by} or None."""
    kanban_db, kanban = _kanban()
    with kanban._board_conn(None) as (_board, conn):
        task = kanban_db.get_task(conn, task_id)
        return None if task is None else {"id": task.id, "assignee": task.assignee, "status": task.status,
                                          "current_run_id": task.current_run_id, "created_by": task.created_by}


def kanban_comment(task_id, author, body):
    kanban_db, kanban = _kanban()
    with kanban._board_conn(None) as (_board, conn):
        return kanban_db.add_comment(conn, task_id, author=author, body=body)


def kanban_reassign(task_id, profile, reclaim_first, reason):
    kanban_db, kanban = _kanban()
    with kanban._board_conn(None) as (_board, conn):
        return bool(kanban_db.reassign_task(conn, task_id, profile, reclaim_first=bool(reclaim_first), reason=reason))


def kanban_reclaim(task_id, reason):
    """Terminate the in-flight run of a task (the dashboard's POST /runs/{id}/terminate does exactly this)."""
    kanban_db, kanban = _kanban()
    with kanban._board_conn(None) as (_board, conn):
        return bool(kanban_db.reclaim_task(conn, task_id, reason=reason))


# ---- handoffs (contract v0.3 section 4): Kanban tasks created in process with a chosen creator ---------------------------
def kanban_create(*, title, body, assignee, created_by, triage, idempotency_key, priority=0, skills=None):
    """`kanban_db.create_task` with `created_by` = the origin Bot (the dashboard route hardcodes "dashboard"). -> task id."""
    kanban_db, kanban = _kanban()
    with kanban._board_conn(None) as (_board, conn):
        return kanban_db.create_task(conn, title=title, body=body, assignee=assignee, created_by=created_by, triage=triage,
                                     idempotency_key=idempotency_key, priority=priority, skills=skills)


def kanban_promote(task_id):
    """triage -> ready, the way the dashboard's drag does. -> bool."""
    kanban_db, kanban = _kanban()
    with kanban._board_conn(None) as (_board, conn):
        return bool(kanban._drag_to(conn, task_id, "ready"))


def kanban_archive(task_id):
    kanban_db, kanban = _kanban()
    with kanban._board_conn(None) as (_board, conn):
        return bool(kanban_db.archive_task(conn, task_id))


def kanban_handoff_tasks():
    """Tasks whose creator is a profile name (not the dashboard): [{id, title, assignee, created_by, status, created_at}]."""
    kanban_db, kanban = _kanban()
    with kanban._board_conn(None) as (_board, conn):
        return [{"id": t.id, "title": t.title, "assignee": t.assignee, "created_by": t.created_by, "status": t.status, "created_at": t.created_at}
                for t in kanban_db.list_tasks(conn, include_archived=True)]


def sessions_search(bot, q, limit, include_rooms):
    """Hermes's own FTS5 search for one profile (hermes_cli/web_routers/sessions.py search_sessions), in process."""
    import asyncio
    from hermes_cli.web_routers.sessions import search_sessions
    result = asyncio.run(search_sessions(q=q, limit=limit, profile=bot, source=None, sources=None,
                                         exclude_sources=None if include_rooms else "bot_room"))
    return result.get("results") or []
