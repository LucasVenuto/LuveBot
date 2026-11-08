"""T7.B1 mutation runner (contract v0.4). Host stdlib only; the repository is never modified.

For each mutation: one deliberate defect in ONE real file, mounted read-only over the repository plugin; Hermes is recreated,
ONE test of the mutation's suite (test_v04, test_mascot, test_pages, test_activity_title, e2e/test_mobile_approval) runs, and it must FAIL on an assertion. The unmutated suite must be green first.
The harness is shared: the run refuses to start while any pytest runs in the container.

  python3 tests/harness/mutate_v04.py [names...]       all by default
  python3 tests/harness/mutate_v04.py --check-only     anchors and syntax only, no Docker
  LUVEBOT_COMPOSE_OVERRIDE=<file.yml>                  an extra compose file (e.g. a worktree mounted as the plugin)
  BASELINE_K='not <test>'                              baseline without a test that is red on purpose
"""
import argparse
import ast
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

CONTROLS, PLUGIN, BOTS, META = 'backend/bot_controls.py', 'dashboard/plugin_api.py', 'backend/bots.py', 'backend/bot_meta.py'
SUITES = ('test_v04.py', 'test_mascot.py', 'test_pages.py', 'test_activity_title.py', 'test_person_display.py')
MUTATIONS = {  # name: (file, test, [(old, new)], suite=test_v04.py)
    'b1_no_redaction': (CONTROLS, 'test_history_redacted', [
        ("    raw = as_shown(text, redact).encode('utf-8')", "    raw = text.encode('utf-8')")]),
    'b2_mark_moves_back': (CONTROLS, 'test_unread_moves_forward_only', [
        ('        if new <= old:\n            return False', '        if new == old:\n            return False')]),
    'b3_disengage_under_root': (CONTROLS, 'test_pause_scope', [
        ("        if root_state() is not None:\n            raise RunRefused('paused_all'", "        if False:\n            raise RunRefused('paused_all'")]),
    'b3_no_work_gate': (CONTROLS, 'test_pause_blocks_luvebot_work', [
        ("    if pause_state(path, bot)['paused']:", '    if False:')]),
    'b3_loopback_resumes': (PLUGIN, 'test_pause_loopback', [
        ('    actor = _budget_actor(request, raises=resume)', '    actor = _budget_actor(request, raises=False)')]),
    'b4_twice': (PLUGIN, 'test_intro_is_server_built_once', [
        ("    if view['state'] != 'none' and not body.get('force'):", '    if False:'),
        ("            if stored.get('intro_run_id') and not body.get('force'):\n                return None",
         "            if False:\n                return None")]),
    'b4_budget_after_session': (PLUGIN, 'test_intro_is_server_built_once', [
        ('            budget_gate(budget, meta.path, name)  # bot_paused (ours, ESTOP or budget)', '            pass  # bot_paused (ours, ESTOP or budget)')]),
    'b6_block_dropped': (CONTROLS, 'test_soul_block_preserved', [
        ('    if not block:\n        return content', '    if True:\n        return content')]),
    'b7_sessions_ignored': (BOTS, 'test_status_sources', [
        ("    sessions = [s for s in live.get('recent_sessions') or [] if s.get('is_active')]", '    sessions = []')]),
    'b7_failure_hidden': (CONTROLS, 'test_status_sources', [
        ('        value = ([], True)', '        value = ([], False)')]),
    'inv5_effect_before_audit': (PLUGIN, 'test_audit_first', [
        ("    await run_in_threadpool(audit.act, actor, 'bot.description.update'",
         "    await run_in_threadpool(bot_controls.update_description, name, text)\n    await run_in_threadpool(audit.act, actor, 'bot.description.update'")]),
    # GET /bots performance (Maestro 15:29): independent reads together; the display pause read outside the global lock
    'perf_live_serial': (PLUGIN, 'test_seven_bots', [
        ("""    checked, sources, pause, routine_results, paused, hook_view, waiting, surface = await asyncio.gather(
        _open_runs_checked(index, name),
        run_in_threadpool(bot_controls.recent_sources, name),
        run_in_threadpool(lambda: bot_controls.pause_state(path, name, consistent=False)),
        run_in_threadpool(_routine_results, path, name),
        run_in_threadpool(_paused_view, path, name),
        run_in_threadpool(_hook_view, path, name, True),
        run_in_threadpool(_waiting_view, path, name),
        run_in_threadpool(_approval_surface, path, name))""",
         """    checked = await _open_runs_checked(index, name)
    sources = await run_in_threadpool(bot_controls.recent_sources, name)
    pause = await run_in_threadpool(lambda: bot_controls.pause_state(path, name, consistent=False))
    routine_results = await run_in_threadpool(_routine_results, path, name)
    paused = await run_in_threadpool(_paused_view, path, name)
    hook_view = await run_in_threadpool(_hook_view, path, name, True)
    waiting = await run_in_threadpool(_waiting_view, path, name)
    surface = await run_in_threadpool(_approval_surface, path, name)""")], 'test_bots_perf.py'),
    # ADR-008: the write-ahead log is turned on once per process (dbfile.configure); never turning it on must turn the harness red
    'wal_never_on': ('backend/dbfile.py', 'test_the_database_runs_in_wal_and_health_says_so', [
        ('        if mode != "wal":\n            mode = str(conn.execute("PRAGMA journal_mode=WAL").fetchone()[0]).lower()\n', '')], 'test_wal.py'),
    'perf_pause_locked': (CONTROLS, 'test_the_display_read_of_the_pause', [
        ('    with LOCK if consistent else contextlib.nullcontext():', '    with LOCK:')], 'test_bots_perf.py'),
    # T12: Markdown platform hint and the workspace download
    # b3: a deny reason is delivered only with proof the model read it, and it is really sent
    'b3_delivered_without_pending': ('backend/approvals_native.py', 'test_delivered_only_when_the_run_ended_with_nothing_pending', [
        ("        elif payload.get('pending_steer'):\n            state = 'not_delivered'", "        elif False:\n            state = 'not_delivered'")],
        'test_b3_deny_reason.py'),
    # the B3_QUICK race: "completed with nothing pending" taken as proof (the version before the transcript check)
    'b3_no_proof_needed': ('backend/approvals_native.py', 'test_delivered_only_when_the_run_ended_with_nothing_pending', [
        ("            state = 'delivered' if request_id in proven else 'unknown'", "            state = 'delivered'")], 'test_b3_deny_reason.py'),
    'b3_command_in_steer': (PLUGIN, 'test_the_steer_carries_nothing_from_the_agent', [
        ("    text = approvals_native.deny_steer_text(reason, nonce)", "    text = approvals_native.deny_steer_text(f'\"{row[\"command_redacted\"]}\" {reason}', nonce)")],
        'test_b3_deny_reason.py'),
    'b3_no_steer': (PLUGIN, 'test_a_deny_reason_reaches_the_model', [
        ("            accepted = approvals_native.steer_reason(row['bot'], row['run_id'], text)", "            accepted = False")],
        'test_b3_deny_reason.py'),
    # b4: a subagent's delivery row (role user) must never come out as the person's message
    'b4_delivery_as_person': (CONTROLS, 'test_b4', [
        ("    if row.get('display_kind') in ('steer', 'failed_turn', 'hidden', DELEGATION_DELIVERY):",
         "    if row.get('display_kind') in ('steer', 'failed_turn', 'hidden'):")], 'test_b4_delegation_delivery.py'),
    # RT20: smart mode must break the seal of an ask by command
    'rt20_smart_ignored': ('backend/rules.py', 'test_rt20_smart_mode_breaks_the_seal', [
        ('    if a.mode == "smart":\n        if rule.match.commands:', '    if a.mode == "smart":\n        if False:')], 'test_rules_api.py'),
    # red team gaps (docs/redteam/2026-10-02.md): G5.1 the run-bound route forgets the draft of "always allow"
    'g5_1_run_route_drops_draft': ('dashboard/plugin_api.py', 'test_g5_1_always_allow_through_the_run_bound_route', [
        ("    fields = approvals.validate_resolution(await _json_body(request), with_request_id=True)\n",
         "    fields = {**approvals.validate_resolution(await _json_body(request), with_request_id=True), 'draft': None}\n")], 'test_approvals.py'),
    # G2.1: the session answer carries a profile's .env (the browser receives it; the walk must find it)
    'g2_1_session_leaks_env': ('dashboard/plugin_api.py', 'test_g2_1_no_secret_reaches_the_browser', [
        ("    return {'csrf': _csrf_for(credential), 'actor': actor, 'auth_mode': mode}\n",
         "    return {'csrf': _csrf_for(credential), 'actor': actor, 'auth_mode': mode, 'diag': (__import__('hermes_cli.web_server_profiles', "
         "fromlist=['x']).get_process_hermes_home() / 'profiles/vendas/.env').read_text()}\n")], '../e2e/test_gate2.py'),
    # the approval TTL: back to the fixed 300 s, so a Bot set to wait longer sees its requests expire before Hermes gives up
    'approval_ttl_fixed': ('backend/approvals.py', 'test_a_request_waits_as_long_as_hermes_does_for_that_bot', [
        ("now, now + ttl(bot), 'pending'", "now, now + TTL, 'pending'")], 'test_approvals.py'),
    # G4.2: the observer never reports a decision as out of band
    'g4_2_nothing_out_of_band': ('backend/approvals.py', 'test_g4_2_a_native_decision_with_the_profile_key', [
        ("    return not any(r['status'] in _CLAIMED", "    return False and not any(r['status'] in _CLAIMED")], 'test_approvals.py'),
    # G7.2: a Bot's cap counts against every Bot, so another Bot's routine is paused too
    'g7_2_cap_leaks_to_other_bots': ('backend/budget.py', 'test_rt7_a_loop_that_blows_the_cap', [
        ('            if scope == "bot" and ref != bot or scope == "routine" and ref != routine:',
         '            if scope == "routine" and ref != routine:')], 'test_phase4.py'),
    # G11.1: the destination's hook stops evaluating the origin's table for a dispatched worker
    'g11_1_origin_not_evaluated': ('hermes-plugin/__init__.py', 'test_g11_1_a_dispatched_worker_is_blocked', [
        ("            verdict = _worse(own, _origin_verdict(profile, tool_name, command, facts))",
         "            verdict = own")], 'test_phase5.py'),
    # G11.2: the room check of a handoff reads only its origin
    'g11_2_destination_unchecked': ('backend/handoffs.py', 'test_a_handoff_in_a_room_needs_both_bots', [
        ('    if origin not in bots or destination not in bots:', '    if origin not in bots:')], 'test_phase5.py'),
    # ADR-002 4.4 (RT21): with approvals off, an ask of LuveBot must be blocked, never approved by nobody
    'strict_ask_off': ('hermes-plugin/__init__.py', 'test_a_real_run_with_approvals_off', [
        ('            bypassed = _approvals_bypassed() if action == "approve" else None', '            bypassed = None')],
        'test_strict_ask.py'),
    # Free mode (hook 0.4.0): the free row is ignored (a free Bot is asked again), or it swallows the Handback / Block verdicts too
    'free_ignored': ('hermes-plugin/__init__.py', 'test_a_free_bot_runs_the_command', [
        ('if own.action == "approve" and _free(profile):', 'if False:')], 'test_free_mode.py'),
    'free_swallows_blocks': ('hermes-plugin/__init__.py', 'test_a_free_bot_is_still_stopped', [
        ('if own.action == "approve" and _free(profile):', 'if _free(profile):')], 'test_free_mode.py'),
    # Invariant 9 (F2): the gate put back on Hermes's stale `__release_date__` (it reads 2026.9.24 on every Hermes since the baseline)
    'gate_by_release_date': (PLUGIN, 'test_the_stale_release_constant_decides_nothing', [
        ("    return hermes_compat.gate(*await run_in_threadpool(hermes_compat.read))",
         "    import hermes_cli\n    return None if str(getattr(hermes_cli, '__release_date__', '')) >= '2026.9.24' else 'hermes_unsupported'")],
        'test_baseline.py'),
    # ADR-006 D2: a plugin host must be refused, not served: the guard of the entry taken out
    'entry_guard_removed': ('dashboard/plugin_entry.py', 'test_a_plugin_host_gets_only_409', [
        ('if os.environ.get("HERMES_PLUGIN_HOST_PROCESS") == "1" or "hermes_cli.web_server" not in sys.modules:', 'if False:')],
        'test_plugin_entry_host.py'),
    # ADR-006 D2b: a selector on another profile is answered instead of refused
    'profile_param_unchecked': (PLUGIN, 'test_a_foreign_profile_param_is_a_400', [
        ("                    if value not in ('', 'current') and not hermes_compat.profile_param_ok(",
         "                    if False and not hermes_compat.profile_param_ok(")], 'test_profile_param.py'),
    # F2-2: only the host variable decides again (fails open if Hermes renames it)
    'entry_guard_not_positive': ('dashboard/plugin_entry.py', 'test_a_plugin_host_gets_only_409', [
        (' or "hermes_cli.web_server" not in sys.modules:', ':')], 'test_plugin_entry_host.py'),
    # Pages in the hint (CEO 2026-10-03): the absolute folder, and refreshed before each turn
    't12_pages_relative': (CONTROLS, 'test_the_hint_names_the_absolute_pages_folder', [
        ("    return MARKDOWN_HINT + ' ' + PAGES_HINT.format(folder=os.path.join(root, 'pages'))",
         "    return MARKDOWN_HINT + ' ' + PAGES_HINT.format(folder='pages')")], 'test_markdown_hint.py'),
    't12_pages_no_refresh': (PLUGIN, 'test_the_hint_names_the_absolute_pages_folder', [
        ("    await run_in_threadpool(_refresh_hint, name, audit, actor)\n\n    new_session = fields['session_id'] is None",
         "\n    new_session = fields['session_id'] is None")], 'test_markdown_hint.py'),
    't12_hint_overwrites_user': (CONTROLS, 'test_a_hint_the_owner_wrote', [
        ("        if current not in (None, {}, '') and not ours:", '        if False:')], 'test_markdown_hint.py'),
    't12_dl_inline': (PLUGIN, 'test_download_route', [
        ("'Content-Disposition': \"attachment; filename*=UTF-8''\"", "'Content-Disposition': \"inline; filename*=UTF-8''\"")], 'test_files.py'),
    't12_dl_as_html': (PLUGIN, 'test_download_route', [
        ("return Response(data, media_type='application/octet-stream', headers={",
         "return Response(data, media_type='text/html', headers={")], 'test_files.py'),
    't12_dl_not_audited': (PLUGIN, 'test_download_route', [
        ("    filename, data = await run_in_threadpool(audit.act, actor, action,",
         "    filename, data = await run_in_threadpool(lambda *a, **k: a[4](), actor, action,")], 'test_files.py'),
    'b_view_audited_as_download': (PLUGIN, 'test_view_purpose', [
        ("    action = pages.file_action(purpose)\n", "    action = 'file.download'\n")], 'test_files.py'),
    # contract v0.6 Part D: time to answer approvals
    'd_profile_dropped': (CONTROLS, 'test_approval_timeout_real', [
        ("ConfigUpdate(config={'approvals': {'timeout': seconds}}, profile=bot), profile=bot)",
         "ConfigUpdate(config={'approvals': {'timeout': seconds}}))")], 'test_approval_timeout_real.py'),
    'd_float_accepted': (CONTROLS, 'test_approval_timeout_real', [
        ('    if type(seconds) is not int or seconds not in APPROVAL_TIMEOUTS:', '    if seconds not in APPROVAL_TIMEOUTS:')],
        'test_approval_timeout_real.py'),
    'd_answer_from_the_body': (CONTROLS, 'test_approval_timeout_real', [
        ('    if effective != seconds:\n', '    if False:\n')], 'test_approval_timeout_real.py'),
    'd_no_csrf': (PLUGIN, 'test_approval_timeout_real', [
        ('    _require_csrf(request, credential)\n    name = await _existing(bot)\n    seconds = bot_controls.validate_approval_timeout',
         '    name = await _existing(bot)\n    seconds = bot_controls.validate_approval_timeout')], 'test_approval_timeout_real.py'),
    'd_new_bot_without_1h': (BOTS, 'test_new_bot_waits_an_hour', [
        ("    steps.append(('approval_timeout', lambda: approval_timeout_update(name, NEW_BOT_APPROVAL_TIMEOUT)))\n", '')],
        'test_approval_timeout_real.py'),
    # contract v0.6 Part A: skills per Bot
    'a_enable_in_loopback': (PLUGIN, 'test_skills_enable_needs_a_person', [
        ('    if enabled:\n        _human(request)  # 403 loopback_not_human\n', '')], 'test_skills.py'),
    'a_description_unredacted': ('backend/skills.py', 'test_skills_state_is_real', [
        ("redact(str(entry.get('description') or ''))[:DESCRIPTION_MAX]", "str(entry.get('description') or '')[:DESCRIPTION_MAX]")],
        'test_skills.py'),
    'a_hermes_enabled_everywhere': ('backend/skills.py', 'test_skills_state_is_real', [
        ("**{p: name not in off[p] for p in platforms}", "**{p: bool(skill.get('enabled')) for p in platforms}")], 'test_skills.py'),
    'a_profile_dropped': ('backend/skills.py', 'test_skills_state_is_real', [
        ("SkillToggle(name=skill, enabled=enabled, profile=bot), profile=bot)", "SkillToggle(name=skill, enabled=enabled))")],
        'test_skills.py'),
    # contract v0.6 Part C: files in a room
    'c_no_csrf_before_body': (PLUGIN, 'test_room_files_csrf_first', [
        ('    _require_csrf(request, credential)  # before the body: a multipart body is never parsed without it\n', '')],
        'test_room_files.py'),
    'c_copy_to_every_member': (PLUGIN, 'test_room_files_only_to_recipients', [
        ('            roots = await run_in_threadpool(room_files.workspaces, targets)',
         '            roots = await run_in_threadpool(room_files.workspaces, members)')], 'test_room_files.py'),
    'c_chips_from_the_text': ('backend/room_files.py', 'test_room_files_only_to_recipients', [
        ("        if event.get('kind') == 'message.user' and event.get('event_id') in sends:",
         "        if event.get('kind') == 'message.user' and '[Anexo:' in str(event.get('payload')):")], 'test_room_files.py'),
    # cross review F2 (invariant 1): the handoff's task title, which a Bot can write, redacted on every route
    'f2_title_raw': (PLUGIN, 'test_handoff_title_is_redacted_on_every_route', [
        ('    return handoffs.live_view(row, task, _REDACT)', '    return handoffs.live_view(row, task, lambda text: text)')],
        'test_handoff_title_redacted.py'),
    # contract v0.8 section 9: a hidden Bot pauses nothing and still notifies
    'p_hidden_skipped_in_inbox': (PLUGIN, 'test_a_hidden_bot_still_runs', [
        ("    return {'approvals': await run_in_threadpool(_with_page_diffs, items), 'next_cursor': nxt}",
         "    hidden = {n for n, r in meta.all().items() if r['hidden']}\n    return {'approvals': [i for i in await run_in_threadpool(_with_page_diffs, items) if i['bot'] not in hidden], 'next_cursor': nxt}")],
        'test_bot_order.py'),
    # T8.3d (contract v0 section 14, A-53/A-54)
    't83d_any_mascot': (META, 'test_an_unknown_mascot', [
        ('            if not isinstance(value, str) or value not in MASCOT_IDS:', '            if not isinstance(value, str):')], 'test_mascot.py'),
    # v0.11 2.2 (AV-3): 'image' is a kind again, accepted only for an id that exists and is the writer's; the mutation is "an id that does not exist is accepted"
    't83d_image_accepted': (META, 'test_an_unknown_mascot', [
        ("            if current != {'kind': 'image', 'value': value} and not (owns is not None and owns(value)):\n                raise _unknown_image()", "            pass")], 'test_mascot.py'),
    # Crie seu Luve B1: a recipe off the lists must be refused on both routes
    # Crie seu Luve B2: the person's face needs CSRF (refused before any audit row)
    'me_no_csrf': (PLUGIN, 'test_no_csrf_no_change', [
        ("    actor, credential, _mode = _identity(request)\n    _require_csrf(request, credential)\n    body = await _json_body(request)\n    audit, meta = await run_in_threadpool(_stores)\n    changes = await run_in_threadpool(lambda: validate_person(",
         "    actor, credential, _mode = _identity(request)\n    body = await _json_body(request)\n    audit, meta = await run_in_threadpool(_stores)\n    changes = await run_in_threadpool(lambda: validate_person(")], 'test_person_display.py'),
    'luve_any_value': (META, 'test_a_luve_recipe_off_the_lists', [
        ("            if not is_luve(value):\n                raise _bad('avatar')", "            pass")], 'test_mascot.py'),
    # T9.5b: Pages inside plugin_api.py / runs.py / bot_controls.py (contract v0.5 8.1 tests 11, 12/18, 13)
    'p11_no_rescan': (PLUGIN, 'test_11_bot_updated', [
        ('found = await _page_updates(index.path, bot, run_id, index, final=not wrote)', 'found = []')], 'test_pages.py'),
    'p12_client_note': ('backend/runs.py', 'test_12_18', [
        ("{'input', 'session_id', 'instructions', 'idempotency_key', 'page'}",
         "{'input', 'session_id', 'instructions', 'idempotency_key', 'page', 'note'}")], 'test_pages.py'),
    'p18_note_in_history': (CONTROLS, 'test_12_18', [
        ("if role == 'user' and isinstance(content, str) and content.startswith('[luvebot:page]'):", 'if False:')], 'test_pages.py'),
    'p13_no_csrf': (PLUGIN, 'test_13_page_routes', [
        ('_require_csrf(request, credential)  # page writes are allowed in loopback', 'pass  # page writes are allowed in loopback')],
        'test_pages.py'),
    # T11.0 (Vitral): activity titles
    'title_includes_note': ('backend/activity.py', 'test_a_run_about_a_page', [
        ('    if text.startswith("[luvebot:page]"):', '    if False:')], 'test_activity_title.py'),
    'title_unkeyed_digest': ('backend/runs.py', 'test_the_digest_is_keyed', [
        ("        return hmac.new(self._key, data, hashlib.sha256).hexdigest()",   # keyed_digest, which prompt_digest calls (ADR-005)
         "        return hashlib.sha256(data).hexdigest()")], 'test_activity_title.py'),
    'title_english_fallback': ('backend/activity.py', 'test_fallbacks', [
        ('task.get("title") or None, origin,', 'task.get("title") or "Task", origin,')], 'test_activity_title.py'),
    # Gate 5 on the phone (tests/e2e/test_mobile_approval.py): the decision is recorded and answered as delivered, but never reaches
    # Hermes; the run must not go on, so the approve case turns red
    'mobile_approval_not_delivered': (PLUGIN, 'test_approve_on_the_phone', [
        ('approvals.resolve(meta.path, approvals_native.decide, human, request_id',
         'approvals.resolve(meta.path, lambda bot, run_id, choice, request_id: True, human, request_id')], '../e2e/test_mobile_approval.py'),
    # The pause by inactivity through the running watcher (test_inactivity_real.py) and a question with no choices answered by text (test_clarify_text.py), plus the
    # `can_ask` gate (test_can_ask.py). Each runs ONE test of its suite; the unmutated suite must be green first.
    'inactivity_deadline_ignored': ('backend/inactivity.py', 'test_after_the_deadline_the_routines_of_every_bot_pause_and_only_a_person_resumes_them', [
        ('    if now - max(seen or 0, set_at) <= days * 86400:\n        return 0', '    if False:\n        return 0')], 'test_inactivity_real.py'),
    'inactivity_resume_undoes_the_cap': ('backend/inactivity.py', 'test_retomar_does_not_undo_the_pause_of_the_cap_and_comes_back_once_it_is_lifted', [
        ('        if is_paused(path, bot):\n            return True', '        if False:\n            return True'),
        ('    except (PluginError, BudgetUnavailable):\n        return True', '    except (PluginError, BudgetUnavailable):\n        return False')], 'test_inactivity_real.py'),
    'clarify_text_blank_accepted': ('backend/canonical.py', 'test_a_question_without_choices_is_answered_by_text_and_only_by_a_person', [
        ('not isinstance(answer, str) or not answer.strip() or len(answer) > MAX_ANSWER', 'not isinstance(answer, str) or len(answer) > MAX_ANSWER')], 'test_clarify_text.py'),
    'clarify_text_audited': (PLUGIN, 'test_a_question_without_choices_is_answered_by_text_and_only_by_a_person', [
        ("'answer_hmac': digest, 'answer_len': len(fields['answer'])}", "'answer_hmac': digest, 'answer_len': len(fields['answer']), 'answer': fields['answer'][:30]}")], 'test_clarify_text.py'),
    'can_ask_without_the_authority_flag': ('backend/live_state.py', 'test_without_the_session_authority_the_field_is_absent', [
        ('        allowed = bool((authority or canonical.authority)(bot))\n', '        allowed = True\n')], 'test_can_ask.py'),
}


def mutate(source, edits):
    for old, new in edits:
        if source.count(old) != 1:
            raise RuntimeError('Mutation anchor must occur exactly once: ' + repr(old))
        source = source.replace(old, new)
    ast.parse(source)
    return source


def idle(compose):
    volume = '/System/Volumes/Data' if Path('/System/Volumes/Data').exists() else '/'
    least = float(os.environ.get('MIN_FREE_GIB', '4.5'))                      # the Docker lane's guard; the native lane (about 1.6 GiB of scratch, no images) sets a lower floor, said in its run script
    if shutil.disk_usage(volume).free < least * 2 ** 30:
        raise RuntimeError(f'Less than {least:g} GiB free on disk: stopped before touching the harness.')
    top = subprocess.run(compose + ['top'], check=True, capture_output=True, text=True).stdout
    if re.search(r'\bpytest\b', top):
        raise RuntimeError('Shared harness busy: a pytest is running. Nothing was changed.')


def recreate(compose):
    subprocess.run(compose + ['up', '-d', '--force-recreate', 'hermes'], check=True)
    for _ in range(120):  # the dashboard answers and the entrypoint finished its fixtures (as mutate_phase4.py)
        probe = subprocess.run(compose + ['exec', '-T', 'hermes', 'python', '-c',
                                          "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:9119/api/status',timeout=2);"
                                          "assert os.path.exists('/fixtures/ports-after.json')"], capture_output=True)
        if probe.returncode == 0:
            break
        subprocess.run(['sleep', '2'])
    subprocess.run(['sleep', '35'])  # the multiplexed gateway serves every profile


def pytest(compose, log, basetemp, suite, *selector):
    with log.open('w') as out:
        return subprocess.run(compose + ['exec', '-T', 'hermes', 'python', '-m', 'pytest', '-c', '/dev/null', '-v', '-s',
                                         '/root/.hermes/plugins/luvebot/tests/invariants/' + suite, *selector,
                                         '-p', 'no:cacheprovider', '--basetemp=' + basetemp], stdout=out, stderr=subprocess.STDOUT).returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('names', nargs='*')
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    chosen = args.names or list(MUTATIONS)
    if set(chosen) - set(MUTATIONS):
        parser.error('unknown mutation')
    harness = Path(__file__).resolve().parent
    repo = harness.parents[1]
    sources = {name: mutate((repo / MUTATIONS[name][0]).read_text(), MUTATIONS[name][2]) for name in chosen}
    if args.check_only:
        print(f'{len(sources)} mutations: anchors unique, syntax valid; Docker not called')
        return
    base = ['docker', 'compose', '-f', str(harness / 'compose.yaml')]
    if os.environ.get('LUVEBOT_COMPOSE_OVERRIDE'):  # e.g. mount a worktree instead of the shared repository
        base += ['-f', os.environ['LUVEBOT_COMPOSE_OVERRIDE']]
    evidence = Path(os.environ.get('HARNESS_STATE', '/tmp/luvebot-harness')) / 'evidence' / 't7b1'
    evidence.mkdir(parents=True, exist_ok=True)
    for suite in sorted({MUTATIONS[name][3] if len(MUTATIONS[name]) > 3 else SUITES[0] for name in chosen}):
        idle(base)
        keep = ['-k', os.environ['BASELINE_K']] if os.environ.get('BASELINE_K') else []  # e.g. leave out a test known red
        if pytest(base, evidence / ('baseline-' + Path(suite).name + '.txt'), '/tmp/t7b1-baseline', suite, *keep):
            raise RuntimeError(f'Baseline {suite} not green; no mutation applied. See {evidence}')
    with tempfile.TemporaryDirectory(prefix='luvebot-v04-') as folder:
        try:
            for name in chosen:
                path, test, _, *suite = MUTATIONS[name]
                source = Path(folder) / (name + '.py')
                source.write_text(sources[name])
                override = Path(folder) / (name + '.json')
                override.write_text(json.dumps({'services': {'hermes': {'volumes': [f'{source}:/root/.hermes/plugins/luvebot/{path}:ro']}}}))
                compose = base + ['-f', str(override)]
                idle(base)
                recreate(compose)
                log = evidence / (name + '.txt')
                code = pytest(compose, log, '/tmp/t7b1-' + name, suite[0] if suite else SUITES[0], '-k', test)
                output = log.read_text()
                if code != 1 or not re.search(r'\b[1-9]\d* failed\b', output) or re.search(r'\bERROR\b', output):
                    raise RuntimeError(f'Mutation {name} did not fail {test} on an assertion; see {log}')
                print(f'{name}: {test} RED (pytest exit 1)', flush=True)
        finally:
            recreate(base)
            print('Overlay dropped; the read-only repository plugin is back', flush=True)


if __name__ == '__main__':
    main()
