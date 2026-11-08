"""Invariant 9: which Hermes is running, and whether LuveBot was tested on it.

The identity is `hermes_cli.version_info.get_version_info()` (the same one GET /api/health reports: install stamp, then live git,
then unknown), NOT `hermes_cli.__release_date__`: Hermes stopped updating that constant (it reads 2026.9.24 on the baseline, on
v0.22.2 and on main), so a gate on it let every Hermes through. Three states, each with its own words in the UI:

  compatible   LuveBot was run against this very build: a TAG (distance 0) whose clean commit is in TESTED_COMMITS and whose `unproven` is empty
               (`limits`, what has no code yet, is then information in the answer and not a reason: the suite ran on this build and never claimed it),
               or main's session authority with every break of it handled (`limits` AND `unproven` empty: each break is in HANDLED, which needs a harness
               evidence file). A main build, or any build outside TESTED_COMMITS, needs both empty; `unproven` never passes; a dirty tree or a commit of the
               wrong shape is never compatible. TESTED_COMMITS holds FULL 40-hex commits compared by EQUALITY with the commit read (A-194, the policy of
               SERVING_PROVEN): a short commit is an identity not read whole, and is `untested`
  untested     a Hermes we have no proof about (a newer release, an unknown identity, main while its breaks are not all handled):
               the features follow what `/v1/capabilities` reports; `limits` lists what does not work here (no code yet) and
               `unproven` what has code but no harness proof on this version
  unsupported  proof that LuveBot must not run: a release older than the baseline, or `plugins.isolation: host` (the router would
               run in a plugin-host process: buffered responses, no stream, no websocket, no approval transport)

An identity that cannot be read is `untested`, never "update Hermes". Pure functions: `read()` is the only one that touches Hermes.
"""
import importlib.util
import os
import re
import sys
import time

BASELINE = "f8489405"              # the short label of the old payload (`baseline`): its value in the answer does not change
BASELINE_COMMIT = "f8489405600c9a7d9d2f307dace086f18d7173ba"   # the FULL commit of that build (2026-10-01)
TESTED_COMMITS = (BASELINE_COMMIT, "bf0203a794a07aac3ff764972ab9087baa4e4f4e")   # FULL 40-hex commits the harness ran the whole suite on (the second is Hermes v0.22.5: COMPAT-3 closed, A-205), compared by EQUALITY with the commit read (the policy of SERVING_PROVEN, A-194); add v0.22.2 (d923a5eb...) only with that evidence (F1), and
#                                    only once the image's identity is legible (a `.git` or an install-stamp.json: without them
#                                    get_version_info() says "unknown" and even the tested build reads `untested`)
MIN_BASE = (0, 21, 5)              # the release the baseline sits after: older than this is proof of "unsupported"
# What changes on a Hermes that runs the gateway's session authority (`features.run_unknown_resolution`: any Hermes that reports the flag,
# stable since v0.22.3, and main), and what changes on one that serves dashboard plugins per profile (PLG-3: its module is in the v0.22.5
# tree too). The two are independent (a canary can have the first without the second), so each list hangs on its own signal. A break leaves `limits` when the slice that handles it has code (IMPLEMENTED: it
# moves to `unproven`), and leaves `unproven` when a harness run proves it (HANDLED, which needs an evidence file: see the test).
AUTHORITY_BREAKS = ("approval_resolve", "session_other_channel", "run_unknown")
PLG3_BREAKS = ("profile_selector",)
IMPLEMENTED = frozenset(AUTHORITY_BREAKS)   # F4 (86afd53, 247ee06); `profile_selector` (F5) has no code yet
HANDLED = frozenset(AUTHORITY_BREAKS)       # proved on a real Hermes (v0.22.5, bf0203a7); a name here needs tests/harness/evidence/handled-<name>.txt
HOST_ENV = "HERMES_PLUGIN_HOST_PROCESS"   # set by Hermes inside a plugin-host process (hermes_cli/plugin_isolation.py)
CACHE_S = 10.0
_VERSION = re.compile(r"([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+][A-Za-z0-9.-]+)?")
_DISPLAY = re.compile(r"[A-Za-z0-9._+-]{1,64}")
_COMMIT = re.compile(r"[0-9a-f]{7,64}")
_PROFILE = re.compile(r"[A-Za-z0-9_.-]{1,64}")
_cache = [0.0, None]
_launch = [-CACHE_S, None]


def read():
    """(identity, isolation) of the RUNNING Hermes, in this process; either is None when it cannot be read. Cached CACHE_S seconds
    (the identity never changes while Hermes runs and the isolation is a config key), so a route can ask on every request. Meant
    for a worker thread: the first read of an unstamped install may run git."""
    now = time.monotonic()
    if _cache[1] is not None and now - _cache[0] < CACHE_S:
        return _cache[1]
    found = (_identity(), _isolation())
    _cache[0], _cache[1] = now, found
    return found


def _identity():
    try:
        from hermes_cli.version_info import get_version_info
        info = get_version_info()
        return {"version": info.base_version, "display_version": info.display_version, "commit": info.commit,
                "distance": info.distance, "dirty": bool(getattr(info, "dirty", False))}   # `dirty`: local changes on the install (git: `status --porcelain -uno`; a stamp's `dirty`)
    except Exception:  # noqa: BLE001  (an older Hermes without the module, or any failure: unknown, never a guess)
        return None


def _isolation():
    """'host' when the router runs INSIDE a plugin host (there `isolation_mode()` says in_process: it never nests hosts) or the
    profile's config says host; 'in_process'; None when it cannot be told."""
    if os.environ.get(HOST_ENV) == "1":
        return "host"
    try:
        from hermes_cli.plugin_isolation import isolation_mode
        mode = isolation_mode()
        return mode if mode in ("in_process", "host") else None
    except Exception:  # noqa: BLE001
        return None


LIFESPAN_MARK = "event_lock"      # set on `app.state` by BOTH of Hermes's lifespans (web_server_app.py standalone_lifespan and http_lifespan), before they yield
PLUGIN_PREFIX = "/api/plugins/luvebot"


SERVING_PROVEN = ("bf0203a794a07aac3ff764972ab9087baa4e4f4e",)   # FULL 40-hex commits where the harness proved the three cases (mount at boot, hot mount, a gateway that only imports) AND pinned `event_lock`; NOT TESTED_COMMITS
#                       (that one grows with the banner): v0.22.5; each entry needs tests/harness/evidence/serving-<entry>.txt; empty = the predicate never says False, the watcher runs everywhere, as before.
#                       Full hashes because `get_version_info().commit` is the whole `git rev-parse HEAD` (a stamp's `commit` is copied verbatim) and the comparison is EQUALITY: a prefix would accept any string that begins like the proven
#                       commit (junk after the hash, another commit sharing 8 hex), and that kind of build is not the code the harness pinned (test_redteam_watcher_proof.py: F1)


def pinned(identity):
    """A build whose lifespan internals the harness pinned (SERVING_PROVEN): the only kind of Hermes this module trusts to answer "no". The commit must EQUAL a proven one and the tree
    must not be `dirty` (local changes: not the code the harness ran). Anything else is not pinned, and "not pinned" is the safe answer (the watcher runs)."""
    return (bool(identity) and isinstance(identity.get("commit"), str) and identity["commit"] in SERVING_PROVEN and not identity.get("dirty"))


def read_app():
    """The dashboard's FastAPI app of THIS process, only when `hermes_cli.web_server` is already imported there: it is never imported from here (importing it is what
    mounts the plugins). None otherwise."""
    module = sys.modules.get("hermes_cli.web_server")
    return getattr(module, "app", None) if module is not None else None


def serving(identity, app):
    """-> (state, reason): does THIS process serve LuveBot's routes? state is True, False or None (unknown). `import hermes_cli.web_server` alone mounts the plugin's router
    (web_server.py: _mount_plugin_api_routes at import), so a gateway that only imports it is not a server; the lifespan is what runs when an ASGI server serves the app.
    The watcher (budget, executor, voice, inactivity) stays off ONLY on False, and False is answered only POSITIVELY: a build the harness proved (SERVING_PROVEN), an `app.state` that can be
    read, and no lifespan mark on it. Everything else (any other build, an unreadable app, a router not seen yet) lets the watcher run, as it does without this check: it
    fails toward the cap (invariant 7), and a duplicate watcher costs only audit rows now that the Budget counts atomically."""
    if not pinned(identity):
        return None, "hermes_not_pinned"
    try:
        state = getattr(app, "state", None)
        if state is None:
            return None, "app_unreadable"
        started = hasattr(state, LIFESPAN_MARK)
    except Exception:  # noqa: BLE001
        return None, "app_unreadable"
    if not started:
        return False, "no_lifespan"
    try:
        mounted = any(str(getattr(route, "path", "")).startswith(PLUGIN_PREFIX) for route in getattr(app, "routes", ()) or ())  # an APIRoute and a Mount both carry `path`
    except Exception:  # noqa: BLE001
        mounted = False
    return (True, "lifespan_ran") if mounted else (None, "router_not_seen")


def session_authority(capabilities):
    """True when any probed profile's API Server reports `features.run_unknown_resolution` (the gateway's session authority: any Hermes
    that reports the flag, stable since v0.22.3, and main); False when some answered and none does; None when none answered (nothing is known)."""
    answered = [c["features"] for c in capabilities if isinstance(c, dict) and isinstance(c.get("features"), dict)]
    if not answered:
        return None
    return any(f.get("run_unknown_resolution") is True for f in answered)


def _base(identity):
    match = _VERSION.fullmatch(identity["version"]) if identity and isinstance(identity.get("version"), str) else None
    return tuple(int(g) for g in match.groups()) if match else None


def gate(identity, isolation):
    """None when the features may follow what the API Server reports; else why they are off: 'isolation_host' or
    'hermes_unsupported'. The one check every feature gate uses (it needs no probe and no session authority)."""
    if isolation == "host":
        return "isolation_host"
    base = _base(identity)
    return "hermes_unsupported" if base is not None and base < MIN_BASE else None


MESSAGES = {
    "isolation_host": "LuveBot does not run with plugins.isolation: host (its streaming and approvals need the plugin inside the "
                      "dashboard process); set plugins.isolation: in_process and restart the dashboard.",
    "hermes_unsupported": f"This Hermes is older than {'.'.join(map(str, MIN_BASE))}, the oldest release LuveBot was tested on; update Hermes.",
    "hermes_untested": "LuveBot has not been tested on this Hermes; its features follow what the API Server reports.",
}


def describe(identity, isolation, authority, plg3=False):
    """-> (the `hermes` object of GET /health, the problem for it or None). `limits` is what does not work on this Hermes (no code),
    `unproven` what has code and no harness proof here (empty when the Hermes is refused); both by capability, in any channel (the flags say so).
    The channel decides only who may be `compatible`: a MAIN build (distance > 0) once every break it shows is proved, a TAG (distance 0) or an
    unreadable channel only when its commit is in TESTED_COMMITS, so a new release nobody ran is never certified because its breaks are all in HANDLED. A TAG built from a
    tested commit stays `compatible` with `limits` not empty (COMPAT-1, A-193: they are listed, not a reason; the suite ran on this very build); an `unproven` break never passes."""
    refusal = gate(identity, isolation)
    distance = (identity or {}).get("distance")
    main = isinstance(distance, int) and not isinstance(distance, bool) and distance > 0
    breaks = ([n for n in AUTHORITY_BREAKS if n not in HANDLED] if authority else []) + (
        [n for n in PLG3_BREAKS if n not in HANDLED] if plg3 else [])
    limits = [n for n in breaks if n not in IMPLEMENTED]
    unproven = [] if refusal else [n for n in breaks if n in IMPLEMENTED]
    # `compatible` (either channel) needs an identity LuveBot can READ and trust: a commit it would show (`_COMMIT`, else `commit: null`: invariant 9, an identity that cannot be read is `untested`)
    # and a tree with no local changes (`dirty` is the code the suite did not run); a missing `dirty` key counts as clean, as in `pinned`
    clean_commit = bool(identity) and isinstance(identity.get("commit"), str) and bool(_COMMIT.fullmatch(identity["commit"])) and not identity.get("dirty")
    tag = isinstance(distance, int) and not isinstance(distance, bool) and distance == 0
    tested = clean_commit and identity["commit"] in TESTED_COMMITS    # EQUALITY with a FULL commit (A-194): a short commit (an identity not read whole) or one that only STARTS alike is another build
    if refusal:
        compat, code = "unsupported", refusal
    elif unproven:  # code without a harness proof, in any channel and on any build
        compat, code = "untested", "hermes_untested"
    elif tag and tested:  # a TAG built from a commit the suite ran on: `limits` is information (it stays in the answer), not a reason
        compat, code = "compatible", None
    elif limits:  # a break with no code: a main build, or one the suite never ran, needs `limits` empty too
        compat, code = "untested", "hermes_untested"
    elif (authority or plg3) and main and clean_commit:  # a main build: the flags say so, and every break it shows is proved
        compat, code = "compatible", None
    elif tested:
        compat, code = "compatible", None  # an unreadable channel is compatible only when the suite ran on that commit
    else:
        compat, code = "untested", "hermes_untested"
    identity = identity or {}
    version, display, commit, distance = (identity.get("version"), identity.get("display_version"), identity.get("commit"),
                                          identity.get("distance"))
    hermes = {
        "version": version if isinstance(version, str) and _VERSION.fullmatch(version) else "unknown",
        "display_version": display if isinstance(display, str) and _DISPLAY.fullmatch(display) else None,
        "commit": commit if isinstance(commit, str) and _COMMIT.fullmatch(commit) else None,
        "channel": None if not isinstance(distance, int) or isinstance(distance, bool) or distance < 0
                   else ("stable" if distance == 0 else "main"),
        "session_authority": authority if isinstance(authority, bool) else None,
        "isolation": isolation if isolation in ("in_process", "host") else None,
        "compat": compat,
        "limits": limits,
        "unproven": unproven,
        # the old payload, kept one release for readers that have not moved to `compat`: no release date any more
        "baseline": BASELINE, "baseline_ok": compat != "unsupported",
    }
    return hermes, None if code is None else {"code": code, "feature": "hermes", "message": MESSAGES[code]}


# ---- ADR-006 D4: which profile's plugins the Hermes dashboard serves, and whether LuveBot is enabled there -------------------------
def _plg3():
    """True when this Hermes serves dashboard plugins per profile (the module that forwards a request for another profile's plugin
    exists: in the v0.22.5 tree and on main). find_spec only: nothing is imported. Any failure is False."""
    try:
        return importlib.util.find_spec("hermes_cli.web_server_plugin_profiles") is not None
    except (ImportError, ValueError, AttributeError):
        return False


def launch_profile():
    """The profile this dashboard is scoped to (Hermes's `current`), or None when it cannot be told ("custom", which Hermes answers when
    HERMES_HOME is outside ~/.hermes, names no profile). Cached with `read()`'s window; for a worker thread."""
    now = time.monotonic()
    if now - _launch[0] < CACHE_S:
        return _launch[1]
    try:
        from hermes_cli import profiles
        name = profiles.get_active_profile_name() or "default"
    except Exception:  # noqa: BLE001
        name = None
    name = name if isinstance(name, str) and _PROFILE.fullmatch(name) and name != "custom" else None
    _launch[0], _launch[1] = now, name
    return name


def profile_param_ok(value, launch):
    """ADR-006 D2b: the Hermes dashboard appends `?profile=<selector>` to every plugin call. LuveBot lives in the process of the launch
    profile and takes its Bot from the path, so the only values it answers are none, `current` and the launch profile's own name; any
    other (a selector on another profile, or a hand-made value) is `400 profile_param_not_supported`. An unknown launch profile
    accepts only none and `current`."""
    return value in ("", "current") or (launch is not None and value == launch)


def read_scope(names, enabled_of=None):
    """(plg3, launch, active, enabled) from the running Hermes, in this process, for a worker thread. `launch` is the profile this
    dashboard is scoped to (what `/api/profiles/active` calls `current`), `active` the sticky one `hermes profile use` writes; each
    is None when unreadable. `enabled` maps each Bot to whether `luvebot` is in ITS `plugins.enabled` (and not disabled): read only
    when the Hermes serves plugins per profile, since only then does it matter."""
    plg3 = _plg3()
    launch = active = None
    try:
        from hermes_cli import profiles
        launch = profiles.get_active_profile_name() or "default"
        active = profiles.get_active_profile() or "default"
    except Exception:  # noqa: BLE001
        pass
    enabled = {}
    if plg3:
        if enabled_of is None:
            from . import hook
            enabled_of = lambda name: hook._enabled(hook.profile_home(name))  # noqa: E731
        for name in names or ():
            try:
                enabled[name] = bool(enabled_of(name))
            except Exception:  # noqa: BLE001  (a profile that cannot be read is not shown as enabled)
                enabled[name] = False
    return plg3, launch, active, enabled


def plugin_scope(isolation, plg3, launch, active, enabled):
    """The `plugin_scope` object of GET /health (ADR-006 section 5): names only, no path, no secret."""
    enabled = enabled if plg3 and isinstance(enabled, dict) else {}
    # "custom" is what Hermes answers when HERMES_HOME is outside ~/.hermes: it names no profile (and would read as a false alarm)
    launch = launch if isinstance(launch, str) and _PROFILE.fullmatch(launch) and launch != "custom" else None
    active = active if isinstance(active, str) and _PROFILE.fullmatch(active) else None
    missing = sorted(name for name, value in enabled.items() if value is not True)
    return {"plg3": bool(plg3), "isolation": isolation if isolation in ("in_process", "host") else "in_process",
            "launch_profile": launch, "active_profile": active,
            "dashboard_enabled_in": sorted(name for name, value in enabled.items() if value is True), "dashboard_missing_in": missing,
            "selector_risk": bool(launch and active and active != launch and missing)}   # `missing` is [] without per-profile plugins
