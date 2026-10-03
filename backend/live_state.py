"""The LiveState of ONE Bot, read from Hermes through its own readers (ADR-002 3.2), for `rules.compute_seal` and `simulate`.

Nothing here writes. Every field is picked by name, so no MCP header or env value, no key and no full config can reach the
UI (invariant 1). What cannot be read honestly is left unknown so the engine reports it instead of assuming it is fine:

* surfaces: `api_server` only when the Bot's API Server answers; `cron`; every channel the gateway reports connected for this
  profile; and `room`, always (there is no reader of room membership yet, so a toolset rule must also hold for the room policy).
* platform toolsets: `api_server` from `GET /p/<bot>/v1/toolsets` (what the running server uses, NOT the dashboard's CLI view
  of `GET /api/tools/toolsets`), every other platform from `_get_platform_tools` under the Bot's own scope.
* MCP: enabled / trust / include / exclude from the Bot's config; `tool_names` (RAW names) only when Hermes's schema cache is a
  FULL list, i.e. the server has no include/exclude filter (the cache holds only registered tools, so with a filter the raw
  names that were filtered out are unknowable and M3 stays unverified).
* room policy: Hermes's own `execution_policy_mapping` (what a room turn really runs with).
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import time

from . import approval_surface, hook, rules
from .hermes_api import ApiClient
from .hermes_client import HermesError

SOUL_BEGIN, SOUL_END = '<!-- luvebot:rules:begin -->', '<!-- luvebot:rules:end -->'


def _strings(value):
    return tuple(v for v in value if isinstance(v, str)) if isinstance(value, (list, tuple)) else ()


def _trust(cfg):
    """Missing = full trust (Hermes); the documented values are full / untrusted; anything else is treated as untrusted."""
    raw = cfg.get('trust')
    if raw is None or (isinstance(raw, str) and raw.strip().lower() in ('full', 'trusted', '')):
        return 'trusted'
    return 'untrusted'


def _tool_filter(cfg):
    """(include|None, exclude) from `tools:` which may be a mapping or a plain list of allowed names."""
    tools = cfg.get('tools')
    if isinstance(tools, dict):
        include = tools.get('include')
        return (None if include is None else _strings(include if isinstance(include, (list, tuple)) else [include])), _strings(tools.get('exclude'))
    if isinstance(tools, (list, tuple)):
        return _strings(tools), ()
    return None, ()


def _cached_raw_names(name, cfg):
    """Raw tool names from the schema cache, only when the cache can be the full list (no include / exclude)."""
    include, exclude = _tool_filter(cfg)
    if include is not None or exclude:
        return None
    try:
        from tools.mcp_schema_cache import config_fingerprint, get_cached_entry, tools_from_cache_entry
        entry = get_cached_entry(name, config_fingerprint(cfg))
        if entry is None:
            return None
        return tuple(sorted({t['name'] for t in tools_from_cache_entry(entry) if isinstance(t, dict) and isinstance(t.get('name'), str)}))
    except Exception:
        return None


def expansion_maps(bot):
    """({toolset: tool names}, {mcp server: registered tool names}) for compile_hook_table. Best effort: a toolset or server that
    cannot be expanded is reported by the compiler (`unknown_toolset`), never silently dropped."""
    from hermes_cli.mcp_config import _get_mcp_servers
    from hermes_cli.tools_config import _get_effective_configurable_toolsets
    from hermes_cli.web_server_profiles import _config_profile_scope
    from toolsets import resolve_toolset
    toolset_tools, mcp_tools = {}, {}
    with _config_profile_scope(bot):
        for name, _label, _desc in _get_effective_configurable_toolsets():
            try:
                toolset_tools[name] = tuple(sorted(set(resolve_toolset(name))))
            except Exception:
                pass
        try:
            servers = _get_mcp_servers()
        except Exception:
            servers = {}
        for name, cfg in servers.items():
            raw = _cached_raw_names(name, cfg) if isinstance(cfg, dict) else None
            if raw is not None:
                mcp_tools[name] = tuple(hook_name(name, r) for r in raw)
    return toolset_tools, mcp_tools


def hook_name(server, raw):
    return rules.hermes_mcp_name(server, raw)


def read(path, bot, *, status=None, now=None):
    """-> (LiveState, toolset_tools, mcp_server_tools). `status` is the result of Hermes's `get_status(profile=bot)` (async,
    so the route awaits it); without it no channel surface is claimed."""
    from hermes_cli.config import load_config
    from hermes_cli.mcp_config import _get_mcp_servers
    from hermes_cli.tools_config import _get_platform_tools
    from hermes_cli.web_server_profiles import _config_profile_scope
    from tools.mcp_tool_common import mcp_server_enabled
    now = time.time() if now is None else now
    toolset_tools, mcp_tools = expansion_maps(bot)

    surfaces, platform_tools = [], []
    try:
        code, payload = ApiClient(bot).call('GET', '/v1/toolsets', timeout=5)
    except HermesError:
        code, payload = 0, None
    if code == 200 and payload and isinstance(payload.get('data'), list):
        enabled = frozenset(t['name'] for t in payload['data'] if isinstance(t, dict) and t.get('enabled') is True and isinstance(t.get('name'), str))
        surfaces.append('api_server')
        platform_tools.append(rules.PlatformTools('api_server', enabled))
    channels = []
    platforms = (status or {}).get('gateway_platforms') if isinstance(status, dict) else None
    if isinstance(platforms, dict):
        channels = sorted(k for k, v in platforms.items() if isinstance(k, str) and k != 'api_server' and isinstance(v, dict) and v.get('state') == 'connected')

    with _config_profile_scope(bot):
        config = load_config()
        for platform in ['cron', *channels]:
            surfaces.append(platform)  # listed even when unreadable: the engine then reports it as uncovered, never assumes it
            try:
                platform_tools.append(rules.PlatformTools(platform, frozenset(_get_platform_tools(config, platform))))
            except Exception:
                pass
        approvals = config.get('approvals') if isinstance(config.get('approvals'), dict) else {}
        security = (config.get('security') or {}).get('approval') if isinstance((config.get('security') or {}).get('approval'), dict) else {}
        allowlist = frozenset(_strings(config.get('command_allowlist')))
        backend = ((config.get('terminal') or {}).get('backend') if isinstance(config.get('terminal'), dict) else None) or 'local'
        mcp_config = _get_mcp_servers()
        servers = []
        for name, cfg in sorted(mcp_config.items()):
            if not isinstance(cfg, dict):
                continue
            include, exclude = _tool_filter(cfg)
            servers.append(rules.McpServerState(name, bool(mcp_server_enabled(cfg)), _trust(cfg), include, exclude, _cached_raw_names(name, cfg)))
        room_policy = None
        try:
            from gateway.hosted_room_execution_policy import execution_policy_mapping
            policy = execution_policy_mapping(target_profile=bot)
            room_policy = rules.RoomPolicyState(frozenset(policy.get('enabled_toolsets') or ()), str(policy.get('approval_mode') or ''))
        except Exception:
            room_policy = None
    surfaces.append('room')
    soul = _soul(bot)
    state = rules.LiveState(
        profile=bot, surfaces=tuple(dict.fromkeys(surfaces)), platform_tools=tuple(platform_tools), mcp=tuple(servers),
        approvals=rules.ApprovalsState(
            mode=str(approvals.get('mode') or 'manual'), deny=_strings(approvals.get('deny')),
            cron_mode=str(approvals.get('cron_mode') or 'deny'), unattended_mode=str(approvals.get('unattended_mode') or 'deny'),
            timeout=int(approvals.get('timeout') or 60) if isinstance(approvals.get('timeout') or 60, (int, float)) else 60,
            transport=str(security.get('transport') or ''), transport_fallback=(str(security['transport_fallback']) if security.get('transport_fallback') else None),
            allowlist=allowlist),
        hook=hook.seal_state(path, bot, now=now), soul=soul, room_policy=room_policy, terminal_backend=str(backend), read_at=now,
        approval_surface=approval_surface.seal_state(path, bot))
    return state, toolset_tools, mcp_tools


def _soul(bot):
    """SoulState from the Bot's SOUL.md through Hermes's own reader; the managed block is present only if both markers are."""
    try:
        from hermes_cli.web_routers.profiles import get_profile_soul
        with ThreadPoolExecutor(1) as pool:  # a fresh thread: no event loop of the caller is running there
            content = pool.submit(asyncio.run, get_profile_soul(bot)).result().get('content') or ''
    except Exception:
        content = ''
    start, end = content.find(SOUL_BEGIN), content.find(SOUL_END)
    if 0 <= start < end:
        block = content[start:end + len(SOUL_END)]
        return rules.SoulState(True, hashlib.sha256(block.encode('utf-8')).hexdigest())
    return rules.SoulState(False, None)
