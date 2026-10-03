"""LuveBot root plugin (ADR-003, ADR-002 section 6): the `pre_tool_call` hook of ONE Hermes profile.

Installed and enabled by LuveBot in each Bot's profile through Hermes's own plugin installer (never copied by hand).
It does three small things:

* on every tool call, looks the call up in the HookTable that LuveBot compiled for this profile (SQLite at the root of
  the fleet) with the pure engine `backend/rules.py`, and answers `block`, `approve` or nothing;
* FAILS CLOSED: if the engine, the database or the table cannot be read, or anything raises, it answers `approve`
  (a human decides) for every tool, and never lets an exception reach Hermes;
* S1 (proposal v0.5 2.7): an approval is asked only on LuveBot's own path or of a person on the host. In any other session
  (a messaging channel, a webhook, an unknown or unreadable surface) `approve` becomes `block`, because Hermes would turn
  it into a button in that channel, answered by whoever the channel allows, and an "Always" there would be permanent.
  Every approval key is unique per call, so no "Always" anywhere can ever approve a later call;
* D-025: a Bot set to `channel` lets the approval go to the chat ONLY in a private Telegram chat of a person LuveBot names as
  approver (never in a group, a routine, a worker or another platform, and never while the gateway lets everyone in), and
  records every such approval (asked, answered) in LuveBot's audit log;
* writes a heartbeat (at load and every 30 s) so LuveBot can show whether the hook is live, and a row for every
  block / approve it issues (tool, rule, redacted command) so the UI can say what was stopped and why.

The engine and the SQLite helpers are loaded from the LuveBot dashboard clone at `<root>/plugins/luvebot/backend`.
* is STRICT for every `approve` it answers (ADR-002 4.4): where Hermes's gate would approve it with nobody asked (session /yolo or CLI --yolo,
  `approvals.mode: off`, an unattended context in approve mode; tools/approval.py#L973-L1015), it answers `block` instead.
"""
import importlib.util
import os
import re
import sys
import threading
import time
import uuid
from pathlib import Path

PLUGIN_VERSION = "0.3.5"
BEAT_EVERY = 30.0
CHECK_EVERY = 2.0
# Where an approval may be ASKED (an allowlist: a platform Hermes adds later starts out blocked). api_server is LuveBot's own
# runs and chats; cli, tui, desktop and local are a person on the host (R1/R7). bot_room (Assumed, beyond the 2.7 list) is a
# Group Chat turn (tui_gateway/hosted_room_driver.py ROOM_SESSION_SOURCE): its approval goes to the room, with "once" and "deny"
# only (hosted_room_driver.py, the choices filter), never to a messaging channel and never "always".
LUVEBOT_SURFACES = frozenset({"api_server", "cli", "tui", "desktop", "local", "bot_room"})
_lock = threading.Lock()
_cache = {}  # profile -> (digest, HookTable)
_beating = set()  # profiles whose heartbeat THIS module (this load of the plugin) runs


def _root():
    from hermes_constants import get_default_hermes_root
    return Path(get_default_hermes_root())


def _backend():
    """The LuveBot backend package, loaded the way the dashboard plugin loads it (one copy per process)."""
    if "luvebot_backend" not in sys.modules:
        directory = _root() / "plugins" / "luvebot" / "backend"
        spec = importlib.util.spec_from_file_location("luvebot_backend", directory / "__init__.py",
                                                      submodule_search_locations=[str(directory)])
        package = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = package
        try:
            spec.loader.exec_module(package)
        except BaseException:
            sys.modules.pop(spec.name, None)
            raise
    return sys.modules["luvebot_backend"]


def _db():
    return _root() / "luvebot" / "luvebot.db"


def _table(profile):
    """The compiled HookTable of this profile, re-read only when its digest in the database changes."""
    import luvebot_backend.hook_store as store
    from luvebot_backend.rules import HookTable
    found = store.read_table(_db(), profile)
    if found is None:
        raise LookupError("no hook table for this profile")
    digest, text = found
    with _lock:
        cached = _cache.get(profile)
        if cached and cached[0] == digest:
            return cached[1]
    table = HookTable.from_json(text)  # raises RuleError("bad_table") on anything malformed
    with _lock:
        _cache[profile] = (digest, table)
    return table


def _serves_api():
    return "gateway.platforms.api_server" in sys.modules


def _beat(profile):
    import luvebot_backend.hook_store as store
    try:
        digest = _table(profile).digest
    except Exception:
        digest = None
    try:
        surface = store.read_surface(_db(), profile)["digest"]
    except Exception:
        surface = None
    store.beat(_db(), profile, os.getpid(), _serves_api(), digest, PLUGIN_VERSION, surface_digest=surface)


def _heartbeat_loop(profile, home, me=None):
    """Beat every BEAT_EVERY seconds, and at once when the stored table changes (so LuveBot sees the new digest in seconds).

    The beat belongs to THIS load of the plugin (`me`, the module object Hermes put in sys.modules): when Hermes reloads it
    (hermes_cli/plugins_loader.py _load_directory_module evicts the old module and imports a new one under the same name) or
    drops it, this loop stops, so a heartbeat never reports the version, or the liveness, of code that no longer runs."""
    import luvebot_backend.hook_store as store
    last, due = None, 0.0
    while sys.modules.get(__name__) is me:
        if not Path(home).exists():  # the profile was deleted: stop writing for it
            return
        try:
            digest = (store.table_digest(_db(), profile), store.read_surface(_db(), profile)["digest"])
            if digest != last or time.monotonic() >= due:
                _beat(profile)
                last, due = digest, time.monotonic() + BEAT_EVERY
        except Exception:
            pass
        time.sleep(CHECK_EVERY)


def _redact(text):
    try:
        from agent.redact import redact_sensitive_text
        return redact_sensitive_text(text[:500], force=True)
    except Exception:
        return None  # no redactor, no text: never store a command we could not redact


def _origin_verdict(profile, tool_name, command):
    """A handoff task carries the restrictions of its ORIGIN too (contract v0.3 4.1 point 2, A-40, red team 11).

    A dispatcher worker has HERMES_KANBAN_TASK set (tools/kanban_tools.py `_visible`). The task's `created_by` is stamped by
    Hermes itself (`_persisted_identity`), never taken from tool arguments, so it cannot be forged by prompt text. When that
    origin is another profile with a LuveBot table, the call is also evaluated against the ORIGIN's table and the worse answer
    wins. A task whose provenance cannot be read is asked about (fails closed). -> HookVerdict | None."""
    task_id = os.environ.get("HERMES_KANBAN_TASK")
    if not task_id:
        return None
    from luvebot_backend.rules import HookTable, HookVerdict, hook_verdict
    import luvebot_backend.hook_store as store
    try:
        from hermes_cli import kanban_db, kanban_db_connect
        with kanban_db_connect.connect_closing() as conn:
            task = kanban_db.get_task(conn, task_id)
        if task is None:
            raise LookupError("unknown task")
        origin = task.created_by
    except BaseException:  # noqa: BLE001
        return HookVerdict("approve", None, "luvebot:origin_unreadable", False)
    if not origin or origin == profile:
        return None
    found = store.read_table(_db(), origin)
    if found is None:
        try:  # a Bot without a compiled table is NOT a human author (S04): its restrictions cannot be checked, so ask
            from hermes_cli.profiles import profile_exists
            if profile_exists(origin):
                return HookVerdict("approve", None, f"luvebot:origin_unverifiable:{origin}", False)
        except BaseException:  # noqa: BLE001
            return HookVerdict("approve", None, "luvebot:origin_unverifiable", False)
        return None  # a human or the dashboard made it: only the destination applies
    verdict = hook_verdict(HookTable.from_json(found[1]), tool=tool_name, command=command)
    if verdict.action == "none":
        return None
    return HookVerdict(verdict.action, verdict.rule_id, f"luvebot:origin:{origin}:{verdict.message}", verdict.strict)


def _worse(own, inherited):
    """block beats approve beats none; on a tie the destination's own verdict stands."""
    order = {"none": 0, "approve": 1, "block": 2}
    return inherited if inherited is not None and order[inherited.action] > order[own.action] else own


def _channel():
    """The surface this call runs on when it is NOT one where LuveBot lets a person approve, else None.

    Hermes ROUTES an approval by the SESSION platform (tools/approval_context.py _get_session_platform, read by
    _is_gateway_approval_context). So each identity is judged on its own, never one standing in for another: the session
    platform, the session source, and the process-wide HERMES_PLATFORM override (session_is_messaging_surface reads
    `HERMES_PLATFORM or session platform`, and that `or` would let HERMES_PLATFORM=cli hide a Telegram session), plus the legacy
    HERMES_GATEWAY_SESSION flag. None only when every identity that is set is in LUVEBOT_SURFACES and, if the legacy flag is on,
    the SESSION itself names one of them (a permitted HERMES_PLATFORM alone does not clear a gateway session). Anything that cannot
    be read is a channel."""
    try:
        from gateway.session_context import get_session_env
        identities = (get_session_env("HERMES_SESSION_PLATFORM", ""), get_session_env("HERMES_SESSION_SOURCE", ""),
                      os.getenv("HERMES_PLATFORM", ""))
        normalized = [str(v or "").strip().lower() for v in identities]
        named = [i for i in normalized if i]
        outside = [i for i in named if i not in LUVEBOT_SURFACES]
        if outside:
            return outside[0] if re.fullmatch(r"[a-z0-9_-]{1,32}", outside[0]) else "unknown"
        if os.getenv("HERMES_GATEWAY_SESSION", "").strip() and not any(normalized[:2]):  # the session's own platform or source
            return "gateway"
        return None
    except BaseException:  # noqa: BLE001  (cannot tell where this runs: treat it as a channel)
        return "unknown"


def _norm(value):
    return str(value or "").strip().lower()


def _allow_all():
    """True when the gateway lets every sender in, or when that cannot be read (D-025): then no approval goes to a chat. The
    names Hermes reads (gateway/authz_mixin.py, the telegram adapter), in the profile's scope and in the process environment (the
    config.yaml bridges write there, gateway/config_loader.py and the telegram adapter's allow_from -> TELEGRAM_ALLOWED_USERS):
    an allow-all flag that is not a clear "off", or the `*` wildcard in an allowlist (alone, in a comma list or a JSON list)."""
    try:
        from agent.secret_scope import get_secret
        import luvebot_backend.hook_store as store
        for name in ("GATEWAY_ALLOW_ALL_USERS", "TELEGRAM_ALLOW_ALL_USERS"):
            for value in (os.getenv(name, ""), get_secret(name, "") or ""):
                if _norm(value) not in ("", "false", "0", "no"):
                    return True
        for name in store.ALLOW_LISTS:
            for value in (os.getenv(name, ""), get_secret(name, "") or ""):
                if store.has_wildcard(value):
                    return True
        return False
    except BaseException:  # noqa: BLE001
        return True


def _channel_approval(profile, channel):
    """D-025: True only when THIS call may be approved in its own chat: the Bot is set to `channel`, the session is a private
    Telegram chat (platform, chat type and user come from the adapter: gateway/run.py _set_session_env), not a routine (there
    Hermes would approve by itself under cron_mode: approve), the session's user is a named approver, and the gateway does not
    let everyone in. Anything else, or anything unreadable, is False: the S1 block stands."""
    try:
        import luvebot_backend.hook_store as store
        from gateway.session_context import get_session_env
        if channel not in store.CHANNEL_APPROVAL_PLATFORMS:
            return False
        source, process = _norm(get_session_env("HERMES_SESSION_SOURCE", "")), _norm(os.getenv("HERMES_PLATFORM", ""))
        if _norm(get_session_env("HERMES_SESSION_PLATFORM", "")) != channel or source not in ("", channel) or process not in ("", channel):
            return False
        if _norm(get_session_env("HERMES_CRON_SESSION", "")) not in ("", "0", "false", "no"):
            return False
        if _norm(get_session_env("HERMES_SESSION_CHAT_TYPE", "")) != "dm":
            return False
        user = str(get_session_env("HERMES_SESSION_USER_ID", "") or "").strip()
        if not re.fullmatch(r"[0-9]{1,20}", user):
            return False
        surface = store.read_surface(_db(), profile)
        if surface["mode"] != "channel" or f"{channel}:{user}" not in surface["approvers"]:
            return False
        return not _allow_all()
    except BaseException:  # noqa: BLE001
        return False


def _approval_observer(profile, phase):
    """D-025 audit: Hermes's `pre_approval_request` / `post_approval_response` (hermes_cli/plugins.py, fired in the agent's
    thread by tools/approval_gateway_wait.py) for OUR approvals answered in a chat. Who: the private chat's user (the only one who
    can press its button; Hermes does not say who pressed). What: asked, or the choice. When: the row's time. Never raises."""
    def observe(**kwargs):
        try:
            key = str(kwargs.get("pattern_key") or "")
            if not key.startswith("plugin_rule:luvebot:"):
                return
            from gateway.session_context import get_session_env
            if _norm(get_session_env("HERMES_SESSION_PROFILE", "")) not in ("", _norm(profile)):
                return
            _backend()
            import luvebot_backend.hook_store as store
            platform = _norm(get_session_env("HERMES_SESSION_PLATFORM", ""))
            if platform not in store.CHANNEL_APPROVAL_PLATFORMS:
                if phase == "answered" and platform == "api_server":
                    _out_of_band(profile, key, _norm(kwargs.get("choice")))
                return  # LuveBot's own approvals are audited by the dashboard when a person decides
            user = str(get_session_env("HERMES_SESSION_USER_ID", "") or "").strip()
            rule, _, tail = key[len("plugin_rule:luvebot:"):].rpartition("#")
            event = tail.partition(".")[0]
            choice = "asked" if phase == "asked" else _norm(kwargs.get("choice"))
            from luvebot_backend.audit import AuditLog
            AuditLog(_db()).act(f"{platform}:{user if re.fullmatch(r'[0-9]{1,20}', user) else 'unknown'}",
                                f"approval.channel.{choice if re.fullmatch(r'[a-z_]{1,24}', choice) else 'unknown'}",
                                f"hook_event:{event if re.fullmatch(r'[0-9]{1,17}', event) else 'unknown'}", {"kind": "hermes_hook"},
                                lambda: None, bot=profile,
                                payload={"rule": rule[:128], "chat_type": _norm(get_session_env("HERMES_SESSION_CHAT_TYPE", ""))[:16],
                                         "coalesced": bool(kwargs.get("coalesced"))})
        except BaseException as error:  # noqa: BLE001  (observability must never touch the approval itself)
            _log_failure("approval observer", error)  # but a lost audit row (an out_of_band alert) is never silent
    return observe


def _log_failure(where, error):
    """One line for the operator: where, and the error's CLASS only (its text may carry a command or a path). Never raises."""
    try:
        import logging
        logging.getLogger("luvebot.hook").warning("%s failed: %s", where, type(error).__name__)
    except BaseException:  # noqa: BLE001
        pass


def _out_of_band(profile, key, choice):
    """ADR-002 R-9, contract v0.1 A-20 (red team gap G4.2): detect, never prevent. A decision Hermes reports on one of OUR requests
    in an API Server turn that LuveBot did not make (luvebot_backend.approvals.out_of_band) was made outside LuveBot: with the
    profile's key on POST /v1/runs/{id}/approval, on Hermes's own surfaces, or by its smart approver. Audited as
    `approval.out_of_band`, the alert Activity shows. Hermes does not say who decided."""
    import luvebot_backend.approvals as approvals
    if not approvals.out_of_band(_db(), profile, key, choice):
        return
    rule, _, tail = key[len("plugin_rule:luvebot:"):].rpartition("#")
    event = tail.partition(".")[0]
    from luvebot_backend.audit import AuditLog
    AuditLog(_db()).act("api_server:unknown", "approval.out_of_band",
                        f"hook_event:{event if re.fullmatch(r'[0-9]{1,17}', event) else 'unknown'}", {"kind": "hermes_hook"},
                        lambda: None, bot=profile,
                        payload={"rule": rule[:128], "choice": choice if re.fullmatch(r"[a-z_]{1,24}", choice) else "unknown"})


def _channel_block(channel, tool_name, rule_id, profile):
    """S1: what the Bot is told (and repeats in the channel). No button, no key: nothing to approve here."""
    return {"action": "block",
            "message": (f"luvebot:channel_block:{channel}:{rule_id or 'noncanonical'}: Esta ação precisa de aprovação no LuveBot e não "
                        f"pode ser aprovada por aqui: {str(tool_name)[:64]} ({rule_id or 'regra do LuveBot'}). Abra o Bot {profile} no "
                        f"LuveBot e peça de novo por lá.")}


def _approvals_bypassed():
    """-> why Hermes's gate would approve an `approve` from this hook with NOBODY asked, or None: 'yolo' (CLI --yolo or the
    session's /yolo), 'approvals_off' (`approvals.mode: off`), 'unattended_approve' (no person or approval bridge present and the
    unattended context's mode approves: single-query, cron, unattended platform). Read in this process with Hermes's own
    functions (tools/approval.py#L973-L1015, the same order as its gate); anything unreadable counts as bypassed (fail closed)."""
    try:
        from tools import approval, approval_context
        if approval._yolo_active():
            return "yolo"
        if approval_context._get_approval_mode() == "off":
            return "approvals_off"
        _callback, is_cli, is_gateway, is_ask = approval._presence(None)
        if not (is_cli or is_gateway or is_ask):
            contexts = approval._unattended_contexts()
            if contexts and contexts[0].mode() != "deny":
                return "unattended_approve"
        return None
    except BaseException:  # noqa: BLE001
        return "unreadable"


def _bypass_block(why, rule_id):
    """ADR-002 4.4: an `ask` is never approved by nobody. What the Bot is told (and the hook records) instead."""
    return (f"luvebot:approvals_bypassed:{why}:{rule_id or 'noncanonical'}: Esta ação precisa da aprovação de uma pessoa no LuveBot, "
            f"e as aprovações estão desligadas aqui ({why}). Ela não foi feita; peça a alguém que aprove no LuveBot, sem /yolo nem "
            "approvals.mode off.")


def _rules_unavailable(profile, tool_name):
    """Fail closed. On a channel it is a block like any other; elsewhere a person decides, under a key that is unique to this
    call, so an "Always" on it is never a standing approval of every action the hook cannot check (the fixed key of 0.1.0)."""
    channel = _channel()
    if channel is not None:
        return _channel_block(channel, tool_name, "rules_unavailable", profile)
    why = _approvals_bypassed()
    if why:  # ADR-002 4.4: nobody would be asked, so it is stopped
        return {"action": "block", "message": _bypass_block(why, "rules_unavailable")}
    return {"action": "approve", "message": "luvebot:rules_unavailable", "rule_key": f"luvebot:rules_unavailable#{uuid.uuid4().hex}"}


def _record(store, *row):
    """The hook's row for this call, or None. Writing it can fail (luvebot.db locked past the timeout, a full disk, a corrupt page);
    that must never change the verdict: a block stays a block (invariant 8). Only the verdict decides what Hermes is told."""
    try:
        return store.record_event(_db(), *row)
    except Exception:  # noqa: BLE001  (the row is evidence, not the decision)
        return None


def _make_hook(profile):
    def pre_tool_call(tool_name, args, task_id="", session_id="", **kwargs):
        try:
            _backend()
            from luvebot_backend.rules import hook_verdict
            import luvebot_backend.hook_store as store
            command = args.get("command") if isinstance(args, dict) and isinstance(args.get("command"), str) else None
            if tool_name == "kanban_create":  # the "before" half of a Bot-made handoff (contract v0.3 4.4)
                import hashlib
                title = args.get("title") if isinstance(args, dict) and isinstance(args.get("title"), str) else ""
                to = args.get("assignee") if isinstance(args, dict) and isinstance(args.get("assignee"), str) else ""
                _record(store, profile, "kanban_create", None, "handoff", f"{to[:128]}|{hashlib.sha256(title.encode()).hexdigest()}",
                        str(task_id)[:128], str(session_id)[:128], str(kwargs.get("tool_call_id", ""))[:128], None)
            verdict = _worse(hook_verdict(_table(profile), tool=tool_name, command=command), _origin_verdict(profile, tool_name, command))
            if verdict.action == "none":
                return None
            channel = _channel() if verdict.action == "approve" else None
            if channel and _channel_approval(profile, channel):  # D-025: a named approver's own private chat gets the approval
                channel = None
            action = "block" if channel else verdict.action
            message = f"luvebot:channel_block:{channel}:{verdict.rule_id or 'noncanonical'}" if channel else verdict.message
            bypassed = _approvals_bypassed() if action == "approve" else None
            if bypassed:  # ADR-002 4.4: Hermes would approve this with nobody asked (/yolo, mode off): block it, and say why. EVERY
                # approve, not only the strict ones: an approve inherited from a handoff's origin (_origin_verdict) is one too
                action, message = "block", _bypass_block(bypassed, verdict.rule_id)
            event_id = _record(store, profile, str(tool_name)[:128], verdict.rule_id, action, message,
                               str(task_id)[:128], str(session_id)[:128], str(kwargs.get("tool_call_id", ""))[:128],
                               _redact(command) if command else None)
            if channel:
                return _channel_block(channel, tool_name, verdict.rule_id, profile)
            if verdict.action == "block":
                return {"action": "block", "message": f"{verdict.message}: this action is blocked by a LuveBot rule."}
            if bypassed:
                return {"action": "block", "message": message}
            # Hermes makes the approval's request_id AFTER this hook answers (tools/approval_gateway_wait.py), but it copies our
            # rule_key into the request's pattern_keys: the id of the row above tells LuveBot exactly which call is being asked.
            # The random part keeps the key unique beyond this database: ids restart if luvebot.db is ever recreated, and an
            # "Always" stored for an old `#N` must never match a new call N (backend/approvals.py _hook_key reads both parts).
            # Without the row (its write failed) the key carries no id: unique all the same, and LuveBot cannot tie the request to a call,
            # so it shows it as details_unavailable and never lets anyone decide it blind (backend/approvals.py C1).
            tail = f"{event_id}.{uuid.uuid4().hex}" if event_id is not None else uuid.uuid4().hex
            return {"action": "approve", "message": verdict.message, "rule_key": f"luvebot:{verdict.rule_id or 'noncanonical'}#{tail}"}
        except BaseException:  # noqa: BLE001  (fail closed: a human decides; nothing may escape into Hermes)
            try:
                return _rules_unavailable(profile, tool_name)
            except BaseException:  # noqa: BLE001  (not even that could be built: stop the action)
                return {"action": "block", "message": "luvebot:rules_unavailable"}
    return pre_tool_call


# Everything this module imports lazily (the beat thread, pre_tool_call, the approval observers), imported by register() itself.
# Hermes's loader iterates sys.modules while it loads the NEXT plugin (hermes_cli/plugins_loader.py _evict_modules,
# `[n for n in sys.modules ...]`): a first import in one of our threads at that moment failed that plugin's load with
# "dictionary changed size during iteration". Done here, on the loader's own thread, nothing of ours imports during a discovery.
_PRELOAD = ("luvebot_backend.hook_store", "luvebot_backend.rules", "luvebot_backend.audit", "agent.redact", "agent.secret_scope",
            "gateway.session_context", "hermes_cli.kanban_db", "hermes_cli.kanban_db_connect", "hermes_cli.profiles", "hashlib")


def _preload():
    for name in _PRELOAD:
        try:
            importlib.import_module(name)
        except Exception:
            pass  # absent here (an older Hermes, a test): the call that needs it fails closed as before


def register(ctx):
    profile = ctx.profile_name
    ctx.register_hook("pre_tool_call", _make_hook(profile))
    for event, phase in (("pre_approval_request", "asked"), ("post_approval_response", "answered")):
        try:
            ctx.register_hook(event, _approval_observer(profile, phase))
        except Exception:
            pass  # an older Hermes without these events: the seal shows the approval surface as not applied
    with _lock:
        if profile in _beating:
            return  # register called again on this same load: its beat is already running
        _beating.add(profile)
    try:
        _backend()
        _preload()
        from hermes_constants import get_hermes_home
        thread = threading.Thread(target=_heartbeat_loop, args=(profile, str(get_hermes_home()), sys.modules.get(__name__)),
                                  name=f"luvebot-hook-heartbeat:{profile}", daemon=True)
        thread.start()
    except Exception:
        with _lock:
            _beating.discard(profile)
        # no beat means "not live": LuveBot refuses new work on this Bot
