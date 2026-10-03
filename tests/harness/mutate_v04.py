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
SUITES = ('test_v04.py', 'test_mascot.py', 'test_pages.py', 'test_activity_title.py')
MUTATIONS = {  # name: (file, test, [(old, new)], suite=test_v04.py)
    'b1_no_redaction': (CONTROLS, 'test_history_redacted', [
        ("    raw = redact(text).encode('utf-8')", "    raw = text.encode('utf-8')")]),
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
        ("""    checked, sources, pause, routine_results, paused, hook_view = await asyncio.gather(
        _open_runs_checked(index, name),
        run_in_threadpool(bot_controls.recent_sources, name),
        run_in_threadpool(lambda: bot_controls.pause_state(path, name, consistent=False)),
        run_in_threadpool(_routine_results, path, name),
        run_in_threadpool(_paused_view, path, name),
        run_in_threadpool(_hook_view, path, name))""",
         """    checked = await _open_runs_checked(index, name)
    sources = await run_in_threadpool(bot_controls.recent_sources, name)
    pause = await run_in_threadpool(lambda: bot_controls.pause_state(path, name, consistent=False))
    routine_results = await run_in_threadpool(_routine_results, path, name)
    paused = await run_in_threadpool(_paused_view, path, name)
    hook_view = await run_in_threadpool(_hook_view, path, name)""")], 'test_bots_perf.py'),
    'perf_pause_locked': (CONTROLS, 'test_the_display_read_of_the_pause', [
        ('    with LOCK if consistent else contextlib.nullcontext():', '    with LOCK:')], 'test_bots_perf.py'),
    # T12: Markdown platform hint and the workspace download
    # b3: a deny reason is delivered only when the run ended with nothing pending, and it is really sent
    'b3_delivered_without_pending': ('backend/approvals_native.py', 'test_delivered_only_when_the_run_ended_with_nothing_pending', [
        ("        state = 'not_delivered' if payload.get('pending_steer') else 'delivered'", "        state = 'delivered'")], 'test_b3_deny_reason.py'),
    'b3_any_end_delivers': ('backend/approvals_native.py', 'test_delivered_only_when_the_run_ended_with_nothing_pending', [
        ("    if payload.get('status') != 'completed':\n        state = 'unknown'", "    if False:\n        state = 'unknown'")], 'test_b3_deny_reason.py'),
    'b3_command_in_steer': (PLUGIN, 'test_the_steer_carries_nothing_from_the_agent', [
        ("    text = f'[luvebot:deny] A pessoa negou a ação que você acabou de pedir e disse: {reason}'",
         "    text = f'[luvebot:deny] A pessoa negou \"{row[\"command_redacted\"]}\" e disse: {reason}'")], 'test_b3_deny_reason.py'),
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
    # G4.2: the observer never reports a decision as out of band
    'g4_2_nothing_out_of_band': ('backend/approvals.py', 'test_g4_2_a_native_decision_with_the_profile_key', [
        ("    return not any(r['status'] in _CLAIMED", "    return False and not any(r['status'] in _CLAIMED")], 'test_approvals.py'),
    # G7.2: a Bot's cap counts against every Bot, so another Bot's routine is paused too
    'g7_2_cap_leaks_to_other_bots': ('backend/budget.py', 'test_rt7_a_loop_that_blows_the_cap', [
        ('            if scope == "bot" and ref != bot or scope == "routine" and ref != routine:',
         '            if scope == "routine" and ref != routine:')], 'test_phase4.py'),
    # G11.1: the destination's hook stops evaluating the origin's table for a dispatched worker
    'g11_1_origin_not_evaluated': ('hermes-plugin/__init__.py', 'test_g11_1_a_dispatched_worker_is_blocked', [
        ("            verdict = _worse(hook_verdict(_table(profile), tool=tool_name, command=command), _origin_verdict(profile, tool_name, command))",
         "            verdict = hook_verdict(_table(profile), tool=tool_name, command=command)")], 'test_phase5.py'),
    # G11.2: the room check of a handoff reads only its origin
    'g11_2_destination_unchecked': ('backend/handoffs.py', 'test_a_handoff_in_a_room_needs_both_bots', [
        ('    if origin not in bots or destination not in bots:', '    if origin not in bots:')], 'test_phase5.py'),
    # ADR-002 4.4 (RT21): with approvals off, an ask of LuveBot must be blocked, never approved by nobody
    'strict_ask_off': ('hermes-plugin/__init__.py', 'test_a_real_run_with_approvals_off', [
        ('            bypassed = _approvals_bypassed() if action == "approve" else None', '            bypassed = None')],
        'test_strict_ask.py'),
    # Pages in the hint (CEO 2026-10-03): the absolute folder, and refreshed before each turn
    't12_pages_relative': (CONTROLS, 'test_the_hint_names_the_absolute_pages_folder', [
        ("    return MARKDOWN_HINT + ' ' + PAGES_HINT.format(folder=os.path.join(root, 'pages'))",
         "    return MARKDOWN_HINT + ' ' + PAGES_HINT.format(folder='pages')")], 'test_markdown_hint.py'),
    't12_pages_no_refresh': (PLUGIN, 'test_the_hint_names_the_absolute_pages_folder', [
        ("    await run_in_threadpool(_refresh_hint, name, audit, actor)\n\n    def effect():\n        hook.hook_gate(meta.path, name)  # D-015 B-3: no new work",
         "\n    def effect():\n        hook.hook_gate(meta.path, name)  # D-015 B-3: no new work")], 'test_markdown_hint.py'),
    't12_hint_overwrites_user': (CONTROLS, 'test_a_hint_the_owner_wrote', [
        ("        if current not in (None, {}, '') and not ours:", '        if False:')], 'test_markdown_hint.py'),
    't12_dl_inline': (PLUGIN, 'test_download_route', [
        ("'Content-Disposition': \"attachment; filename*=UTF-8''\"", "'Content-Disposition': \"inline; filename*=UTF-8''\"")], 'test_files.py'),
    't12_dl_as_html': (PLUGIN, 'test_download_route', [
        ("return Response(data, media_type='application/octet-stream', headers={",
         "return Response(data, media_type='text/html', headers={")], 'test_files.py'),
    't12_dl_not_audited': (PLUGIN, 'test_download_route', [
        ("    filename, data = await run_in_threadpool(audit.act, actor, 'file.download',",
         "    filename, data = await run_in_threadpool(lambda *a, **k: a[4](), actor, 'file.download',")], 'test_files.py'),
    # T8.3d (contract v0 section 14, A-53/A-54)
    't83d_any_mascot': (META, 'test_an_unknown_mascot', [
        ('            if not isinstance(value, str) or value not in MASCOT_IDS:', '            if not isinstance(value, str):')], 'test_mascot.py'),
    't83d_image_accepted': (META, 'test_an_unknown_mascot', [
        ("avatar['kind'] not in ('emoji', 'initials', 'mascot')", "avatar['kind'] not in ('emoji', 'initials', 'mascot', 'image')")], 'test_mascot.py'),
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
    if shutil.disk_usage(volume).free < 4.5 * 2 ** 30:
        raise RuntimeError('Less than 4.5 GiB free on disk: stopped before touching the harness.')
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
