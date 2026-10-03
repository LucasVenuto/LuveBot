"""The rules hook of each Bot (ADR-003): install it in the profile, read whether it is live, refuse work when it is not.

Hermes loads a plugin PER PROFILE (spike T3.0c), so every Bot needs the LuveBot root plugin (`hermes-plugin/`, plugin
name `luvebot-hook`) installed and enabled in its own profile. The only writes to Hermes are the two public functions of
the dashboard's plugin installer, called inside `config_write_scope(<bot>)` (the same scope the profile routes use):

  dashboard_install_plugin(identifier, force, enable=True, ref)  hermes_cli/plugins_cmd_install.py#L560
  activate_plugin_now (called by it): loads the plugin in the running gateway over its control socket

The source and the revision are fixed on the server (never taken from the browser): this repository's own
`hermes-plugin/` folder at the commit of the clone, or, for the test harness, the git repository named by the
operator's `LUVEBOT_HOOK_SOURCE` environment variable. Nothing here edits a Hermes file, spawns a process or opens a port.
"""
import os
import re
import time
from pathlib import Path
from urllib.parse import urlparse

from . import hook_store
from .api_errors import PluginError
from .audit import ActionDenied
from .rules import HookState, builtin_rules, compile_hook_table

PLUGIN_NAME = 'luvebot-hook'
SUBDIR = 'hermes-plugin'
STATUSES = ('absent', 'pending_reload', 'live', 'disabled_pending_restart')
_SHA = re.compile(r'[0-9a-f]{40}')


class HookError(Exception):
    """A step of the install failed. `code` is ours; no text from Hermes is ever carried."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


class HookRefused(PluginError, ActionDenied):
    """New work refused because the Bot's hook is not live: recorded as denied in the audit (D-015 B-3)."""


def _git_head(repo):
    """Full commit SHA of a checkout, read from .git without running git."""
    git = Path(repo) / '.git'
    if git.is_file():  # a worktree: "gitdir: <path>"
        text = git.read_text().strip()
        if not text.startswith('gitdir:'):
            return None
        git = (Path(repo) / text[7:].strip()).resolve()
    try:
        head = (git / 'HEAD').read_text().strip()
        if _SHA.fullmatch(head):
            return head
        if not head.startswith('ref: '):
            return None
        ref = head[5:].strip()
        if '..' in ref.split('/'):
            return None
        loose = git / ref
        if loose.is_file():
            value = loose.read_text().strip()
            return value if _SHA.fullmatch(value) else None
        for line in (git / 'packed-refs').read_text().splitlines():
            if line.endswith(' ' + ref) and _SHA.fullmatch(line.split(' ', 1)[0]):
                return line.split(' ', 1)[0]
    except OSError:
        return None
    return None


def _source_repo():
    """The repository the hook is installed from: this clone, or LUVEBOT_HOOK_SOURCE (a file:// path)."""
    override = os.environ.get('LUVEBOT_HOOK_SOURCE', '').strip()
    if override:
        parsed = urlparse(override)
        if parsed.scheme != 'file' or not parsed.path.startswith('/'):
            raise HookError('source_invalid')
        return Path(parsed.path)
    return Path(__file__).resolve().parents[1]


_SHIPPED = re.compile(r'^PLUGIN_VERSION = "([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4})"$', re.M)


def latest_version():
    """The hook version this LuveBot ships (PLUGIN_VERSION of hermes-plugin/__init__.py in the install source), read as TEXT: the
    dashboard never imports the hook. A Bot whose hook reports an older version is offered the update. None when unreadable."""
    try:
        found = _SHIPPED.search((_source_repo() / SUBDIR / '__init__.py').read_text())
    except (OSError, HookError, UnicodeDecodeError):
        return None
    return found.group(1) if found else None


def source():
    """(identifier, ref) for dashboard_install_plugin, fixed on the server."""
    repo = _source_repo()
    if not (repo / SUBDIR / 'plugin.yaml').is_file():
        raise HookError('source_missing')
    ref = _git_head(repo)
    if ref is None:
        raise HookError('source_unpinned')
    return f'file://{repo}#{SUBDIR}', ref


def compile_expected():
    """The table every Bot's hook must run. Today: the five built-in families (user rules arrive with the rules API)."""
    return compile_hook_table(builtin_rules(), version=1, toolset_tools={}, mcp_server_tools={})


def profile_home(profile):
    from hermes_cli.profiles import get_profile_dir
    return Path(get_profile_dir(profile))


def _enabled(home):
    from pm.plugins_state import read_home_selection
    try:
        config = read_home_selection(home) or {}
    except (ValueError, OSError):
        return False
    plugins = config.get('plugins') or {}
    enabled, disabled = plugins.get('enabled') or [], plugins.get('disabled') or []
    return PLUGIN_NAME in enabled and PLUGIN_NAME not in disabled


def hook_state(path, profile, *, now=None):
    """The four states of ADR-003 section 5, DERIVED on every read from: the plugin folder, the profile's
    `plugins.enabled`, and the heartbeat rows written by gateway processes (never by the dashboard's own copy)."""
    now = time.time() if now is None else now
    home = profile_home(profile)
    installed = (home / 'plugins' / PLUGIN_NAME / 'plugin.yaml').is_file()
    enabled = _enabled(home)
    gateway = [b for b in hook_store.beats(path, profile) if b['serves_api']]
    recent = [b for b in gateway if now - b['ts'] <= hook_store.HEARTBEAT_TTL]
    expected = hook_store.table_digest(path, profile) or compile_expected().digest  # what LuveBot last applied to this Bot
    if recent and not enabled:
        status = 'disabled_pending_restart'
    elif not (installed and enabled):
        status = 'absent'
    elif recent and recent[0]['table_digest'] == expected:
        status = 'live'
    else:
        status = 'pending_reload'
    beat = recent[0] if recent else (gateway[0] if gateway else None)
    return {'status': status, 'version': beat['plugin_version'] if beat else None,
            'heartbeat_age_s': round(now - beat['ts'], 1) if beat else None,
            'table_digest': beat['table_digest'] if beat else None}


def seal_state(path, profile, *, now=None):
    """The engine's HookState for compute_seal (ADR-003 B-5): `registered` needs the folder AND the profile's
    `plugins.enabled`, not only a heartbeat, because disabling in Hermes takes effect only after a restart."""
    now = time.time() if now is None else now
    home = profile_home(profile)
    registered = (home / 'plugins' / PLUGIN_NAME / 'plugin.yaml').is_file() and _enabled(home)
    gateway = [b for b in hook_store.beats(path, profile) if b['serves_api']]
    beat = gateway[0] if gateway else None
    return HookState(registered, None if beat is None else max(0.0, now - beat['ts']), None if beat is None else beat['table_digest'],
                     None if beat is None else beat['plugin_version'], None if beat is None else beat.get('surface_digest'))


def hook_gate(path, profile):
    """D-015 B-3: no new work on a Bot whose hook is not live while a restrictive rule exists (the built-ins always do)."""
    state = hook_state(path, profile)
    if state['status'] in ('live', 'disabled_pending_restart'):
        return
    if state['status'] == 'pending_reload':
        raise HookRefused('hook_not_live', 'The LuveBot rules are not loaded for this Bot yet; wait for its gateway to load them '
                          'or restart the gateway, then try again.', 409, {'hook': state['status']})
    raise HookRefused('hook_not_live', 'The LuveBot rules are not installed for this Bot; install them from the Bot first.',
                      409, {'hook': state['status']})


def _installed_revision():
    try:
        from hermes_cli import plugins_cmd
        entry = plugins_cmd._read_install_metadata().get(PLUGIN_NAME)
        return entry.get('revision') if isinstance(entry, dict) else None
    except Exception:
        return None  # unknown revision: the install is simply repeated with force


def install_hook(path, profile):
    """Idempotent. Store the table, then install + enable + load the plugin in this profile. Returns
    {changed, gateway_reloaded, restart_required}; raises HookError(code) with a static code on any failure."""
    from hermes_cli.plugins_cmd import dashboard_set_agent_plugin_enabled
    from hermes_cli.plugins_cmd_install import dashboard_install_plugin
    from hermes_cli.web_routers._common import config_write_scope
    identifier, ref = source()
    try:
        from . import live_state, rules_service  # lazy: both import this module
        tools, mcp = live_state.expansion_maps(profile)
        rules_service.apply_table(path, profile, tools, mcp)  # builtins + the human-activated rules that apply to this Bot
        home = profile_home(profile)
        with config_write_scope(profile):
            present = (home / 'plugins' / PLUGIN_NAME / 'plugin.yaml').is_file()
            if present and _installed_revision() == ref:
                if _enabled(home):
                    return {'changed': False, 'gateway_reloaded': None, 'restart_required': False}
                result = dashboard_set_agent_plugin_enabled(PLUGIN_NAME, enabled=True)
                code = 'hook_enable_failed'
            else:
                result = dashboard_install_plugin(identifier, force=present, enable=True, ref=ref)
                code = 'hook_scan_blocked' if isinstance(result, dict) and result.get('scan_blocked') else 'hook_install_failed'
    except HookError:
        raise
    except Exception:
        raise HookError('hook_install_failed') from None
    if not isinstance(result, dict) or result.get('ok') is not True:
        raise HookError(code)
    return {'changed': True, 'gateway_reloaded': bool(result.get('gateway_reloaded')),
            'restart_required': bool(result.get('restart_required'))}


def verify_installed(profile):
    """ADR-003 3.2 step 2: the plugin folder exists and its name is in THIS profile's plugins.enabled."""
    home = profile_home(profile)
    if not ((home / 'plugins' / PLUGIN_NAME / 'plugin.yaml').is_file() and _enabled(home)):
        raise HookError('hook_verify_failed')
    return True


def forget(path, profile):
    """A deleted Bot leaves no hook rows behind."""
    conn = hook_store.connect(path)
    try:
        for table in ('hook_tables', 'hook_heartbeat', 'hook_events'):
            conn.execute(f'DELETE FROM {table} WHERE profile=?', (profile,))
        conn.commit()
    finally:
        conn.close()
