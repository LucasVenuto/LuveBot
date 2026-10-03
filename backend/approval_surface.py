"""D-025: where a person approves what the hook asks about, per Bot. `luvebot` (the default: S1, every approval in LuveBot) or
`channel`: also in the private Telegram chat of a person named here (the hook checks the chat, the user and the gateway's
policy on every call; see hermes-plugin/__init__.py _channel_approval). Storage is hook_store's `approval_surface` table, the
one the hook reads; this module validates, reads Hermes's allow-all policy, and says whether the hook applies the setting.
"""
import os
import time

from . import hook, hook_store
from .api_errors import PluginError
from .rules import ApprovalSurfaceState

ALLOW_ALL_NAMES = ("GATEWAY_ALLOW_ALL_USERS", "TELEGRAM_ALLOW_ALL_USERS")
CHANNEL_SURFACE_VERSION = (0, 3, 0)


def _on(value):
    return str(value or "").strip().lower() not in ("", "false", "0", "no")


def _telegram_sections(config):
    """Every place a Telegram section can live (gateway/config_loader.py platform_section: top level, gateway.platforms,
    platforms). All are read, not only the one Hermes picks: a wildcard in any of them counts (stricter, never looser)."""
    gateway = config.get("gateway") if isinstance(config.get("gateway"), dict) else {}
    for holder in (config, gateway.get("platforms"), config.get("platforms")):
        section = holder.get("telegram") if isinstance(holder, dict) else None
        if isinstance(section, dict):
            yield section


def allow_all(bot):
    """-> (on, reason). The gateway lets every sender in when (gateway/authz_mixin.py, the telegram adapter):
    * GATEWAY_ALLOW_ALL_USERS / TELEGRAM_ALLOW_ALL_USERS is on, in the profile's scope or the process;
    * TELEGRAM_ALLOWED_USERS / GATEWAY_ALLOWED_USERS holds the `*` wildcard (alone, in a comma list or a JSON list);
    * config.yaml has `allow_all_users` (bridged to GATEWAY_ALLOW_ALL_USERS, gateway/config_loader.py), or a Telegram section with
      `*` in `allow_from` or `extra.allow_from` (the adapter's own allowlist).
    Anything that cannot be read counts as on (fail closed)."""
    try:
        from agent.secret_scope import get_secret
        from hermes_cli.config import load_config
        from hermes_cli.web_server_profiles import _config_profile_scope
        with _config_profile_scope(bot):
            for name in ALLOW_ALL_NAMES:
                if _on(os.environ.get(name, "")) or _on(get_secret(name, "") or ""):
                    return True, name
            for name in hook_store.ALLOW_LISTS:
                if hook_store.has_wildcard(os.environ.get(name, "")) or hook_store.has_wildcard(get_secret(name, "") or ""):
                    return True, name
            config = load_config()
        gateway = config.get("gateway") if isinstance(config.get("gateway"), dict) else {}
        if any(v is not None and _on(v) for v in (config.get("allow_all_users"), gateway.get("allow_all_users"))):
            return True, "allow_all_users"
        for section in _telegram_sections(config):
            extra = section.get("extra") if isinstance(section.get("extra"), dict) else {}
            if hook_store.has_wildcard(section.get("allow_from")) or hook_store.has_wildcard(extra.get("allow_from")):
                return True, "allow_from"
        return False, None
    except Exception:
        return True, "unreadable"


def parse(body):
    """PUT body -> (mode, approvers sorted). 422 invalid_field for anything else."""
    if not isinstance(body, dict) or "mode" not in body or set(body) - {"mode", "approvers"}:
        raise PluginError("invalid_field", 'Send {"mode": "luvebot" | "channel", "approvers": ["telegram:<id>", ...]}.', 422)
    mode, approvers = body["mode"], body.get("approvers", [])
    if mode not in hook_store.SURFACE_MODES:
        raise PluginError("invalid_field", "mode must be luvebot or channel.", 422, {"details": {"field": "mode"}})
    if not isinstance(approvers, list) or not all(isinstance(a, str) for a in approvers):
        raise PluginError("invalid_field", "approvers must be a list of strings.", 422, {"details": {"field": "approvers"}})
    if not hook_store.valid_surface(mode, approvers) or len(set(approvers)) != len(approvers):
        raise PluginError("invalid_field", 'Each approver is "telegram:<numeric user id>", at most 20, no repeats; channel needs at least one.',
                          422, {"details": {"field": "approvers"}})
    return mode, sorted(approvers)


def loosens(current, mode, approvers):
    """True when the change lets more approvals reach a chat: turning `channel` on, or naming someone new while on it."""
    return mode == "channel" and (current["mode"] != "channel" or bool(set(approvers) - set(current["approvers"])))


def _version(text):
    parts = str(text or "").split(".")
    return tuple(int(p) for p in parts) if len(parts) == 3 and all(p.isascii() and p.isdigit() for p in parts) else None


def applied_reason(surface, state):
    """Why the live hook does or does not run this very setting yet:
    'hook_not_live' (not installed and enabled, or no recent gateway heartbeat), 'hook_outdated' (older than this setting needs:
    0.3.0 for `channel`, 0.2.0 for `luvebot`), 'pending' (a hook that can apply it has not reported this configuration's digest
    yet: normal for a few seconds after saving, the hook reports it within CHECK_EVERY), or 'applied'."""
    if not (state.registered and state.heartbeat_age_s is not None and state.heartbeat_age_s <= hook_store.HEARTBEAT_TTL):
        return "hook_not_live"
    version = _version(state.plugin_version)
    if version is None or version < (CHANNEL_SURFACE_VERSION if surface["mode"] == "channel" else (0, 2, 0)):
        return "hook_outdated"
    if surface["mode"] == "channel" and state.surface_digest != surface["digest"]:
        return "pending"
    return "applied"


def view(path, bot):
    """What GET returns. `applied`: the live hook runs this very setting; `applied_reason` says why not (applied_reason)."""
    surface = hook_store.read_surface(path, bot)
    on, reason = allow_all(bot) if surface["mode"] == "channel" else (False, None)
    state = hook.seal_state(path, bot)
    why = applied_reason(surface, state)
    return {"bot": bot, "mode": surface["mode"], "approvers": surface["approvers"], "platforms": list(hook_store.CHANNEL_APPROVAL_PLATFORMS),
            "allow_all": on, "allow_all_reason": reason, "applied": why == "applied", "applied_reason": why,
            "hook_version": state.plugin_version, "hook_latest_version": hook.latest_version(),
            "updated_at": surface["updated_at"], "updated_by": surface["updated_by"]}


def view_after_save(path, bot, *, timeout=6.0, every=0.5):
    """The view right after a PUT: a hook that can apply the new setting reports it within seconds, so wait (bounded) while it is
    only 'pending' instead of answering "not applied" for a setting that is about to be. Never waits on another reason."""
    deadline = time.monotonic() + timeout
    while True:
        current = view(path, bot)
        if current["applied_reason"] != "pending" or time.monotonic() >= deadline:
            return current
        time.sleep(every)


def seal_state(path, bot):
    """The engine's ApprovalSurfaceState. `allow_all` is read only when it matters (mode `channel`)."""
    surface = hook_store.read_surface(path, bot)
    on = allow_all(bot)[0] if surface["mode"] == "channel" else False
    return ApprovalSurfaceState(surface["mode"], tuple(surface["approvers"]), surface["digest"], on)
