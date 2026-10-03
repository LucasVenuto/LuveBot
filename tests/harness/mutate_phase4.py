"""Host-stdlib mutation runner for Phase 4 (T4.5): one deliberate defect in the real backend or plugin per run, mounted over the
read-only repository plugin; Hermes is recreated, ONE test runs, and it must FAIL. The repository itself is never modified.

  skip_pause        the executor does not pause the Bot's cron jobs                     -> red team 7
  new_runs_allowed  budget_gate lets a run start for a paused Bot                       -> red team 7
  resume_job_open   resuming a job ignores the budget pause                             -> red team 7
  no_alert          a breach raises no alert                                            -> red team 7
  paused_no_plan    a paused Bot whose cause is gone gets no plan: a job resumed behind
                    our back stays resumed                                              -> red team 7
  resume_all        budget resume lifts every paused job, not only ours                 -> red team 7
  test_paused       "run a test" is forwarded for a paused routine (Hermes resumes it)  -> trigger on a paused job
  client_dict       PATCH forwards the client dict                                      -> no client dict
  history_cap       the run history stops at 100                                        -> unlimited history
  loopback_raises   loopback may resume a Bot                                           -> loopback is not a human
  T4.6 (test_activity_actions.py):
  stop_unconfirmed  the stop answers with a status Hermes never reported                -> a stop is confirmed by Hermes
  context_author    the comment is signed as the dashboard, not as the person           -> context is authored by a person
  redirect_no_gate  a task can be handed to a paused Bot                                -> invariant 7 on redirect
  context_run_open  a run item silently accepts context                                 -> says what is missing
"""
import json
import os
from pathlib import Path
import subprocess

harness = Path(__file__).resolve().parent
repo = harness.parents[1]
state = Path(os.environ.get('HARNESS_STATE', '/tmp/luvebot-harness'))
evidence = state / 'evidence'
evidence.mkdir(parents=True, exist_ok=True)
overlay_dir = Path('/tmp/luvebot-t45-mutations')
overlay_dir.mkdir(exist_ok=True)
base = ['docker', 'compose', '-f', str(harness / 'compose.yaml')]
if os.environ.get('LUVEBOT_COMPOSE_OVERRIDE'):  # e.g. a worktree mounted as the plugin
    base += ['-f', os.environ['LUVEBOT_COMPOSE_OVERRIDE']]
RT7 = 'rt7_a_loop'
EXECUTOR, RUNS, PLUGIN, HANDOFFS = 'backend/executor.py', 'backend/runs.py', 'dashboard/plugin_api.py', 'backend/handoffs.py'
mutations = {
    'skip_pause': (RT7, [(EXECUTOR, '                if job.get("enabled") is False or state == "paused":', '                if True:')]),
    'new_runs_allowed': (RT7, [(RUNS, "    decision = budget.check_new_run(bot)\n    if decision['allowed']:\n        return", "    return")]),
    'resume_job_open': (RT7, [(PLUGIN, "        if is_paused(meta.path, bot):  # invariant 7: resuming a job must not undo the pause\n            raise PluginError('bot_paused', 'This Bot is paused by its budget; only a person can resume it.', 409)\n        _start_gate(budget, meta.path, bot, job['id'])  # also refuses when the budget cannot be verified (S02)\n", "")]),
    'no_alert': (RT7, [(EXECUTOR, '        self.alert(decision)\n', '')]),
    'paused_no_plan': (RT7, [('backend/budget.py', '"plan": self._plan(bot) if paused else None,', '"plan": None,')]),
    'resume_all': (RT7, [(EXECUTOR, 'if job is not None and job.get("state") == "paused" and job.get("paused_reason") == REASON:', 'if job is not None and job.get("state") == "paused":'),
                         (EXECUTOR, 'ours = [r[0] for r in conn.execute("SELECT job_id FROM budget_exec_jobs WHERE bot=?", (bot,))]', 'ours = [j["id"] for j in self.cron.list_jobs(bot)]')]),
    'test_paused': ('paused_routine_cannot_be_tested', [(PLUGIN, "        if job.get('state') == 'paused' or job.get('enabled') is False:", "        if False:")]),
    'client_dict': ('no_client_dict', [(PLUGIN, "    updates = routines.validate_patch(await _json_body(request))", "    updates = await _json_body(request)")]),
    'history_cap': ('history_has_no_limit', [(PLUGIN, "'next_cursor': str(offset + limit) if len(rows) > limit else None,", "'next_cursor': str(offset + limit) if len(rows) > limit and offset + limit < 100 else None,")]),
    'loopback_raises': ('loopback_cannot_raise', [(PLUGIN, "    actor = _budget_actor(request, raises=True)\n    name = validate_profile(bot)", "    actor = _budget_actor(request, raises=False)\n    name = validate_profile(bot)")]),
    'stop_unconfirmed': ('stop_is_confirmed_by_what_hermes', [(PLUGIN, "    last = None\n    for _ in range(attempts):", "    return 'cancelled'\n    last = None\n    for _ in range(attempts):")], 'test_activity_actions.py'),
    'context_author': ('context_reaches_the_task', [(PLUGIN, "_quiet_value(hermes_cron.kanban_comment, native, 'luvebot:' + actor, body)", "_quiet_value(hermes_cron.kanban_comment, native, 'dashboard', body)")], 'test_activity_actions.py'),
    'redirect_no_gate': ('redirect_hands_the_task_over', [(PLUGIN, "        decision = budget.check_new_run(target)  # invariant 7: work is not handed to a paused or capped Bot\n        if not decision['allowed']:\n            raise _budget_refusal(decision)\n", "")], 'test_activity_actions.py'),
    'context_run_open': ('context_for_a_run_or_a_routine', [(PLUGIN, "    if item_kind == 'run':\n        raise PluginError('capability_missing', 'Sending context", "    if False:\n        raise PluginError('capability_missing', 'Sending context")], 'test_activity_actions.py'),
    'rt10_precheck': ('test_rt10_a_message', [('backend/rooms.py', '    if unknown:\n        raise PluginError("not_a_member"', '    if False:\n        raise PluginError("not_a_member"')], 'test_phase5.py'),
    'room_budget_gate': ('test_the_send_is_gated', [(PLUGIN, '        await _gate_targets(audit, meta, targets)\n', '')], 'test_phase5.py'),
    'room_cost_confirm': ('test_the_send_is_gated', [('backend/rooms.py', '    return len(targets) > 1', '    return False')], 'test_phase5.py'),
    'actor_in_body': ('test_the_actor_is_server_side', [('backend/rooms.py', '    _strict(body, {"text", "event_id", "thread_id", "confirm_cost"}, {"text", "event_id"})', '    _strict(body, {"text", "event_id", "thread_id", "confirm_cost", "actor"}, {"text", "event_id"})')], 'test_phase5.py'),
    'rt11_origin': ('test_rt11_a_handoff_is_bounded', [('backend/handoffs.py', 'for side, bot in (("origin", origin), ("destination", destination)):', 'for side, bot in (("origin", destination), ("destination", destination)):')], 'test_phase5.py'),
    'hr3_inheritance': ('test_rt11_the_worker', [('hermes-plugin/__init__.py', '    return inherited if inherited is not None and order[inherited.action] > order[own.action] else own', '    return own')], 'test_phase5.py'),
    'unrecorded_silent': ('test_a_handoff_shows_in', [(HANDOFFS, '        if not recorded:\n            audit.act("system", "handoff.unrecorded"', '        if False:\n            audit.act("system", "handoff.unrecorded"')], 'test_phase5.py'),
    's01_resume_routine_cap': ('test_s01', [(PLUGIN, "    capped = await run_in_threadpool(lambda: budget.routines_over_cap() & {j.get('id') for j in _cron.list_jobs(name)})\n", "    capped = set()\n")], 'test_phase47.py'),
    's02_create_routine': ('test_s02', [(PLUGIN, "        if start:\n            _start_gate(Budget(meta.path, audit=audit), meta.path, name)  # S02: an active routine is work that will start\n", "")], 'test_phase47.py'),
    's02_promote': ('test_s02', [(PLUGIN, "        _start_gate(budget, meta.path, row['to_bot'])  # S02: promoting is the moment the task becomes dispatchable\n", "")], 'test_phase47.py'),
    's02_retry': ('test_s02', [(PLUGIN, "    await _gate_targets(audit, meta, rooms.members_view(state['room']))  # S02: a retry runs the task again, for whoever it belongs to\n", "")], 'test_phase47.py'),
    's02_stale_resume': ('test_s02', [(PLUGIN, "    if decision['reason'] == 'watcher_stale' and not has_limits(path):\n        return", "    if decision['reason'] == 'watcher_stale':\n        return")], 'test_phase47.py'),
    's03_cap_now': ('test_s03', [(PLUGIN, "    await run_in_threadpool(_evaluate_budget, budget, executor, await _names())  # a cap below what was already spent pauses now\n", "")], 'test_phase47.py'),
    's04_origin_table': ('test_s04', [(PLUGIN, "        _verify_handoff_enforcement(meta.path, fields['from'], fields['to'])\n        task_id = hermes_cron.kanban_create(", "        task_id = hermes_cron.kanban_create(")], 'test_phase47.py'),
    's04_origin_unverifiable': ('test_s04', [('hermes-plugin/__init__.py', "            if profile_exists(origin):", "            if False:")], 'test_phase47.py'),
    's05_create': ('test_s05', [(PLUGIN, "    actor = _human(request).id  # S05: handing work to a Bot is a person's decision (403 loopback_not_human in loopback)\n", "    actor, credential, _mode = _identity(request)\n    _require_csrf(request, credential)\n")], 'test_phase47.py'),
    's05_promote': ('test_s05', [(PLUGIN, "    actor = _human(request).id  # S05: only a person lifts a handoff that waits for review (not the loopback token)\n", "    actor, credential, _mode = _identity(request)\n    _require_csrf(request, credential)\n")], 'test_phase47.py'),
    's06_redaction': ('test_s06', [(PLUGIN, "return JSONResponse(_redact_deep({'routines': chunk,", "return JSONResponse(({'routines': chunk,")], 'test_phase47.py'),
    's07_room_filter': ('test_s07', [(PLUGIN, "                listed = [r for r in listed if {m['bot'] for m in rooms.members_view(r)} & set(names)]", "                pass")], 'test_phase47.py'),
    's08_no_stop': ('test_s08', [(PLUGIN, "        return [r['run_id'] for r in self.index.open_runs(bot)]", "        return []")], 'test_phase47.py'),
    's09_ingest': ('test_s09', [(PLUGIN, "        handoffs.ingest(meta.path, audit, names, hermes_cron.kanban_handoff_tasks)  # S09: not on a GET\n", "")], 'test_phase47.py'),
    's09_sync': ('test_s09', [(PLUGIN, "        handoffs.sync(meta.path, audit, hermes_cron.kanban_task)\n", "")], 'test_phase47.py'),
}
only = os.environ.get('ONLY')
# every anchor first, before Docker: a stale one stops here, never halfway through the run (red team F3)
stale = [(name, old[:60]) for name, (test, edits, *rest) in mutations.items() for relative, old, new in edits
         if (repo / relative).read_text().count(old) != 1]
if stale:
    raise SystemExit('Stale mutation anchors (each must occur exactly once): ' + repr(stale))
if os.environ.get('CHECK_ONLY'):
    raise SystemExit(f'{len(mutations)} mutations: every anchor occurs once; Docker not called')
ok = False
try:
    for name, (test, edits, *rest) in mutations.items():
        suite = rest[0] if rest else 'test_phase4.py'
        if only and name not in only.split(','):
            continue
        texts, mounts = {}, []
        for relative, old, new in edits:
            text = texts.setdefault(relative, (repo / relative).read_text())
            assert text.count(old) == 1, (name, old)
            texts[relative] = text.replace(old, new)
        for index, (relative, text) in enumerate(texts.items()):
            source = overlay_dir / f'{name}-{index}.py'
            source.write_text(text)
            mounts.append(f'{source}:/root/.hermes/plugins/luvebot/{relative}:ro')
        override = overlay_dir / (name + '.yaml')
        override.write_text(json.dumps({'services': {'hermes': {'volumes': mounts}}}))
        compose = base + ['-f', str(override)]
        subprocess.run(compose + ['up', '-d', '--force-recreate', 'hermes'], check=True)
        # readiness: the dashboard answers and the entrypoint finished its fixtures
        for _ in range(120):
            probe = subprocess.run(compose + ['exec', '-T', 'hermes', 'python', '-c',
                                              "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:9119/api/status',timeout=2);assert os.path.exists('/fixtures/ports-after.json')"],
                                   capture_output=True)
            if probe.returncode == 0:
                break
            subprocess.run(['sleep', '2'])
        subprocess.run(['sleep', '35'])
        target = evidence / ('mutation-phase4-' + name + '.txt')
        with target.open('w') as output:
            result = subprocess.run(compose + ['exec', '-T', 'hermes', 'python', '-m', 'pytest', '-c', '/dev/null', '-s', '-v',
                '/root/.hermes/plugins/luvebot/tests/invariants/' + suite, '-k', test, '-p', 'no:cacheprovider',
                '--basetemp=/tmp/t45-mutation-' + name], stdout=output, stderr=subprocess.STDOUT)
        text = target.read_text()
        if result.returncode != 1 or ' failed' not in text or 'ERROR' in text:
            raise RuntimeError('Mutation did not fail the intended test: ' + name)
        print(name + ': intended test red (pytest exit 1)', flush=True)
    ok = True
finally:
    subprocess.run(base + ['up', '-d', '--force-recreate', 'hermes'], check=True)  # drop the overlay
if ok:
    print('Mutations red; the read-only repository plugin restored', flush=True)
