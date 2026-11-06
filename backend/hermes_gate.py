"""Dry-run of Hermes's OWN approval gate for the rules simulator (contract F6.3): "what would Hermes do with this command?".

The simulator proves our rules; this proves the other half: Hermes's hardline floor, the Bot's `approvals.deny` globs, its
`command_allowlist` and the dangerous-command patterns, in the order the real gate applies them. Source: `hermes_cli.approvals_test.
evaluate_command(command, env_type)` (v0.22.2, `hermes approvals test`), called IN process inside the Bot's config scope, so a Bot other than
the dashboard's own reads its own `approvals.*` and its own allowlist (tools/approval.py `_permanent_set`: one set per profile home). It
runs nothing, asks nobody, writes no file and reads no state.db. It does ONE thing to memory: `evaluate_command` first calls Hermes's
`load_permanent_allowlist`, which RELOADS the Bot's permanent allowlist (`command_allowlist`) from its config copy on disk into this
process's set for that scope, replacing it (`load_permanent`: clear, then update). Memory only; it fails to the safe side (an unreadable
list is an empty one). The harness proves that two Bots never cross and that a real "Always" granted while dry-runs run still reaches the
config; if that ever fails, the plan B is `evaluate_command` in a subprocess.

Only a shell command is evaluated (tool `terminal`): `execute_code` text is Python, and the smart judge is another path.
What it cannot see is said in `caveats`, never left out: a session's `/yolo` and the gateway process's `--yolo` live in other processes
(the dashboard's own frozen flag is the only one evaluate_command reads), and for a docker backend it assumes no host mounts. When the
Bot's `approvals.mode` is `off` (our LiveState, not Hermes's text) an `allow` means "approvals are switched off", not "nothing matched".
The command is capped (Hermes's detectors are regular expressions over the person's text and a stuck thread cannot be killed) and is never
logged and never returned: this module does not log at all.
Nothing Hermes wrote as free text leaves (`detail`, `normalized_variants`): only the verdict, as a code, and the matched rule.
"""
import threading

VERDICTS = {'allow': 'allow', 'ask-approval': 'ask', 'hardline-deny': 'hardline_deny', 'user-deny': 'user_deny'}
SHELL_TOOLS = ('terminal',)
MAX_COMMAND = 4096  # characters sent to Hermes (our own engine takes 16384, rules.MAX_COMMAND)
# Review 2, F13: the detectors are regular expressions over a person's text, run IN this process, and a thread stuck in one cannot be killed. A
# pathological command that sticks one would, repeated, take every thread of the dashboard's pool. So at most MAX_CONCURRENT run at once; a call that
# cannot get a slot within SLOT_WAIT seconds says it cannot check (`unreadable`) instead of piling up behind them. A stuck detector then costs the
# dry-run of the simulator (until the dashboard restarts), never the dashboard. The plan B stays the subprocess named above.
MAX_CONCURRENT = 2
SLOT_WAIT = 1.0
_slots = threading.BoundedSemaphore(MAX_CONCURRENT)


def applies(tool, command):
    return tool in SHELL_TOOLS and isinstance(command, str) and bool(command.strip())


def dry_run(bot, command, env_type, *, redact, approvals_mode=None, scope=None, evaluate=None, slot_wait=None):
    """-> {'available': True, 'verdict', 'rule', 'env_type', 'caveats'} or {'available': False, 'reason'}. Never raises.
    `approvals_mode` is the Bot's `approvals.mode` from our LiveState; `scope` and `evaluate` are the seams for a process without Hermes."""
    if len(command) > MAX_COMMAND:
        return {'available': False, 'reason': 'command_too_long'}
    try:
        if evaluate is None:
            from hermes_cli.approvals_test import evaluate_command as evaluate  # absent before the module existed: ImportError
    except ImportError:
        return {'available': False, 'reason': 'hermes_without_dry_run'}
    if not _slots.acquire(timeout=SLOT_WAIT if slot_wait is None else slot_wait):
        return {'available': False, 'reason': 'unreadable'}   # the detectors are all busy (or stuck): not queued behind them
    try:
        if scope is None:
            from hermes_cli.web_server_profiles import _config_profile_scope as scope
        with scope(bot):
            result = evaluate(command, env_type)
        verdict = VERDICTS[result['verdict']]  # a verdict this code does not know is not guessed at
        rule = redact(str(result.get('rule') or ''))[:160] or None
    except Exception:  # noqa: BLE001  (the class may name a path or carry the command: nothing of it is returned)
        return {'available': False, 'reason': 'unreadable'}
    finally:
        _slots.release()
    env = str(env_type or 'local')[:32]
    return {'available': True, 'verdict': verdict, 'rule': rule, 'env_type': env,
            'caveats': ['session_yolo_not_seen'] + (['approvals_off'] if verdict == 'allow' and approvals_mode == 'off' else [])
                       + (['docker_host_access_not_seen'] if env == 'docker' else [])}
