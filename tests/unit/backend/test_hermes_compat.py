"""Invariant 9, F2 (honest gate): which Hermes runs and whether LuveBot was tested on it, from fake versions (no Hermes needed).

The gate used `hermes_cli.__release_date__`, a constant Hermes stopped updating (2026.9.24 on the baseline, on v0.22.2 and on
main): every Hermes passed. It reads `get_version_info()` now. Pinned here:
* three states (compatible, untested, unsupported) from the identity, the isolation and the session authority;
* an identity that cannot be read is `untested`, never "update Hermes"; only a release proven older than the baseline says update;
* `plugins.isolation: host` (also when we run INSIDE a plugin host) is `unsupported` with its own code;
* main (session authority) is `untested`: `limits` names what has no code, `unproven` what has code but no harness proof on this version
  (F2 of the second cross review), and it is `compatible` once every break is in HANDLED, which needs an evidence file with the code, a
  green result and the Hermes commit (a mutation: an empty file, or HANDLED filled without one, is red);
* the payload carries no release date, and no code path reads one (a static guard; mutation: put the old read back -> red).
"""
import ast
import importlib.machinery
from pathlib import Path
import re
import sys
import types

import pytest

import backend.hermes_compat as compat

REPO = Path(__file__).resolve().parents[3]
BASE = {"version": "0.21.5", "display_version": "0.21.5+3", "commit": "f8489405600c9a7d9d2f307dace086f18d7173ba", "distance": 3}
V0222 = {"version": "0.22.2", "display_version": "0.22.2", "commit": "d923a5eb487a" + "0" * 28, "distance": 0}
MAIN = {"version": "0.22.2", "display_version": "0.22.2+41", "commit": "7de59bee" + "0" * 32, "distance": 41}


def hermes(identity, isolation="in_process", authority=False, plg3=False):
    return compat.describe(identity, isolation, authority, plg3)


def test_the_tested_baseline_is_compatible_and_says_nothing():
    got, problem = hermes(BASE)
    assert (got["compat"], got["limits"], got["channel"], problem) == ("compatible", [], "main", None)
    assert (got["version"], got["display_version"], got["commit"]) == ("0.21.5", "0.21.5+3", BASE["commit"])
    assert (got["isolation"], got["session_authority"]) == ("in_process", False)


@pytest.mark.parametrize("identity", [V0222, MAIN, {**BASE, "commit": "aaaaaaaa" + "0" * 32}, {**V0222, "version": "0.30.0"}])
def test_a_hermes_nobody_ran_the_suite_on_is_untested_not_refused(identity):
    got, problem = hermes(identity)
    assert got["compat"] == "untested" and compat.gate(identity, "in_process") is None
    assert problem["code"] == "hermes_untested" and problem["feature"] == "hermes" and "update" not in problem["message"].lower()
    assert got["baseline_ok"] is True            # the features follow what /v1/capabilities reports


def test_stable_and_main_by_distance_and_nothing_when_unknown():
    assert hermes(V0222)[0]["channel"] == "stable" and hermes(MAIN)[0]["channel"] == "main"
    for distance in (None, -1, "3", True):
        assert hermes({**V0222, "distance": distance})[0]["channel"] is None, distance


@pytest.mark.parametrize("identity", [None, {}, {"version": "unknown", "display_version": "unknown", "commit": None, "distance": None},
                                      {"version": None}, {"version": 5}, {"version": "garbage"}])
def test_an_identity_that_cannot_be_read_is_untested_and_never_update_hermes(identity):
    got, problem = hermes(identity)
    assert got["compat"] == "untested" and got["version"] == "unknown" and got["commit"] is None and got["channel"] is None
    assert problem["code"] == "hermes_untested" and "update" not in problem["message"].lower()
    assert compat.gate(identity, "in_process") is None and compat.gate(identity, None) is None   # unknown isolation: not a refusal


@pytest.mark.parametrize("version", ["0.21.4", "0.20.9", "0.0.0", "0.9.99"])
def test_only_a_release_proven_older_than_the_baseline_is_unsupported_and_says_update(version):
    got, problem = hermes({**BASE, "version": version, "commit": None})
    assert got["compat"] == "unsupported" and got["baseline_ok"] is False and compat.gate({"version": version}, "in_process") == "hermes_unsupported"
    assert problem["code"] == "hermes_unsupported" and "update Hermes" in problem["message"] and "0.21.5" in problem["message"]


def test_the_baseline_release_itself_and_newer_ones_are_not_refused():
    for version in ("0.21.5", "0.21.6", "0.22.0", "1.0.0", "0.22.2-rc.1"):
        assert compat.gate({"version": version}, "in_process") is None, version


def test_isolation_host_is_unsupported_with_its_own_code_and_beats_everything():
    for identity in (BASE, V0222, None):
        got, problem = hermes(identity, "host")
        assert got["compat"] == "unsupported" and got["isolation"] == "host" and got["baseline_ok"] is False
        assert problem["code"] == "isolation_host" and "plugins.isolation: in_process" in problem["message"]
    got, problem = hermes({**BASE, "version": "0.1.0"}, "host", True)                # even older AND host: the host reason wins
    assert problem["code"] == "isolation_host" and got["limits"] == [] and got["unproven"] == []     # refused: nothing "unproven" to say
    assert compat.gate(BASE, "host") == "isolation_host" and compat.gate(BASE, "in_process") is None


def test_main_is_untested_with_limits_and_unproven_until_each_break_is_proved(monkeypatch):
    """F2-4: the two signals are independent (a main canary can have the session authority without per-profile plugins): `profile_selector`
    hangs on `plg3`, the other three on `session_authority`. F2 (review 2): a break with code and no proof is `unproven`, not a limit."""
    three = ["approval_resolve", "session_other_channel", "run_unknown"]
    monkeypatch.setattr(compat, "HANDLED", frozenset())                      # the state before a harness proof (the real constant now holds the three: tests/harness/evidence/handled-*.txt)
    got, problem = hermes(MAIN, authority=True)
    assert got["compat"] == "untested" and got["session_authority"] is True and problem["code"] == "hermes_untested"
    assert (got["limits"], got["unproven"]) == ([], three)                 # F4 is in the code: implemented, not proved
    got = hermes(MAIN, authority=True, plg3=True)[0]
    assert (got["limits"], got["unproven"]) == (["profile_selector"], three)    # F5 has no code yet: a limit
    only_plg3, problem = hermes(MAIN, authority=False, plg3=True)                                   # the other way round
    assert (only_plg3["limits"], only_plg3["unproven"], only_plg3["compat"], problem["code"]) == (["profile_selector"], [], "untested", "hermes_untested")
    monkeypatch.setattr(compat, "IMPLEMENTED", frozenset())                  # before the slice: every break is a limit again
    got = hermes(MAIN, authority=True, plg3=True)[0]
    assert (got["limits"], got["unproven"]) == (three + ["profile_selector"], [])
    monkeypatch.undo()
    monkeypatch.setattr(compat, "HANDLED", frozenset({"approval_resolve", "session_other_channel"}))
    got = hermes(MAIN, authority=True, plg3=True)[0]
    assert (got["limits"], got["unproven"], got["compat"]) == (["profile_selector"], ["run_unknown"], "untested")
    monkeypatch.setattr(compat, "HANDLED", frozenset(compat.AUTHORITY_BREAKS))
    got, problem = hermes(MAIN, authority=True)
    assert (got["compat"], got["limits"], got["unproven"], problem) == ("compatible", [], [], None)  # recognised once proved (no plg3 here)
    got = hermes(MAIN, authority=True, plg3=True)[0]
    assert (got["limits"], got["unproven"], got["compat"]) == (["profile_selector"], [], "untested")  # F5 still open
    monkeypatch.setattr(compat, "HANDLED", frozenset(compat.AUTHORITY_BREAKS + compat.PLG3_BREAKS))
    got, problem = hermes(MAIN, authority=True, plg3=True)
    assert (got["compat"], got["limits"], got["unproven"], problem) == ("compatible", [], [], None)
    assert hermes(None, authority=True)[0]["compat"] == "untested"                        # the flag alone no longer says "main": an unreadable channel is not certified
    monkeypatch.undo()
    assert hermes(MAIN, authority=False)[0]["limits"] == [] and hermes(MAIN, authority=None)[0]["session_authority"] is None
    assert hermes(MAIN, isolation="host", authority=True, plg3=True)[1]["code"] == "isolation_host"   # a refusal still wins


def test_the_channel_decides_who_is_compatible_a_new_tag_is_never_certified(monkeypatch):
    """The session authority is on the STABLE Hermes since v0.22.3, so the flag no longer means "main": with every break in HANDLED a new
    release nobody ran (v0.22.6, 0.23.0) would be certified. By channel: main (distance > 0) is compatible once proved; a tag (distance 0) or an
    unreadable channel only when its commit is in TESTED_COMMITS. `limits` and `unproven` stay by capability in every channel."""
    three = ["approval_resolve", "session_other_channel", "run_unknown"]
    stable = {**V0222, "version": "0.22.5", "display_version": "0.22.5", "commit": "9a8b7c6d" + "0" * 32}   # a tag the suite never ran on
    monkeypatch.setattr(compat, "HANDLED", frozenset())                      # the state before a harness proof (the real constant now holds the three)
    got, problem = hermes(stable, authority=True)
    assert (got["compat"], got["channel"], got["limits"], got["unproven"], problem["code"]) == ("untested", "stable", [], three, "hermes_untested")
    monkeypatch.setattr(compat, "HANDLED", frozenset(compat.AUTHORITY_BREAKS + compat.PLG3_BREAKS))      # everything proved elsewhere
    got, problem = hermes(stable, authority=True, plg3=True)
    assert (got["compat"], got["limits"], got["unproven"], problem["code"]) == ("untested", [], [], "hermes_untested")   # still not certified: nobody ran this tag
    for distance in (None, -1, "3", True):                                                              # an unreadable channel is the same
        got = hermes({**MAIN, "distance": distance}, authority=True, plg3=True)[0]
        assert got["compat"] == "untested" and got["channel"] is None, distance
    assert hermes(MAIN, authority=True, plg3=True)[0]["compat"] == "compatible"                         # main with everything proved
    tested = {**stable, "commit": compat.TESTED_COMMITS[0]}                                  # a tag whose commit the suite ran on
    assert hermes(tested, authority=True, plg3=True)[0]["compat"] == "compatible"
    monkeypatch.setattr(compat, "HANDLED", frozenset())
    assert hermes(tested, authority=True)[0]["compat"] == "untested"                                    # ...but an unproven break still says untested
    assert hermes(stable, authority=False)[0]["compat"] == "untested" and hermes(BASE, authority=False)[0]["compat"] == "compatible"


@pytest.mark.parametrize("old,new", [
    ('    elif (authority or plg3) and main and clean_commit:', '    elif (authority or plg3) and clean_commit:'),
    ('    main = isinstance(distance, int) and not isinstance(distance, bool) and distance > 0', '    main = isinstance(distance, int) and distance >= 0'),
    ('    elif unproven:  # code without a harness proof, in any channel and on any build\n        compat, code = "untested", "hermes_untested"\n', ''),
], ids=["no_channel_check", "a_tag_counts_as_main", "unproven_breaks_ignored"])
def test_each_channel_mutation_is_caught(monkeypatch, old, new):
    source = (REPO / "backend" / "hermes_compat.py").read_text()
    assert source.count(old) == 1, old
    variant = types.ModuleType("backend.hermes_compat_variant")
    exec(compile(source.replace(old, new), "hermes_compat_variant", "exec"), variant.__dict__)
    monkeypatch.setattr(variant, "HANDLED", frozenset(variant.AUTHORITY_BREAKS + variant.PLG3_BREAKS))
    stable = {**V0222, "version": "0.22.5", "commit": "9a8b7c6d" + "0" * 32}
    ok = variant.describe(stable, "in_process", True, True)[0]["compat"] == "untested" and variant.describe(MAIN, "in_process", True, True)[0]["compat"] == "compatible"
    ok = ok and variant.describe(stable, "in_process", True, False)[0]["compat"] == "untested"
    monkeypatch.setattr(variant, "HANDLED", frozenset())
    ok = ok and variant.describe(MAIN, "in_process", True, False)[0]["compat"] == "untested"
    assert not ok


def test_unproven_is_empty_outside_a_main_build_and_when_refused():
    """Review 2 F2 (Prumo's adjustment 2): a stable Hermes that is compatible, a new release, an unreadable identity and a refusal all say
    nothing about `unproven`; the field is always there (a list), so a reader of the new payload never meets a missing key."""
    for identity, authority in ((BASE, False), (V0222, False), (None, False), (None, None), (MAIN, False)):
        got = hermes(identity, authority=authority)[0]
        assert got["unproven"] == [], (identity, authority)
    for identity, isolation in ((BASE, "host"), ({**BASE, "version": "0.1.0"}, "in_process"), (None, "host")):
        got = hermes(identity, isolation, authority=True, plg3=True)[0]
        assert got["compat"] == "unsupported" and got["unproven"] == [], (identity, isolation)


EVIDENCE = REPO / "tests" / "harness" / "evidence"


def evidence_gaps(names, root=EVIDENCE):
    """The names whose evidence file `handled-<name>.txt` does not hold, as `key: value` lines, the code itself, `result: pass` and the
    Hermes commit (7 to 64 lowercase hex). An absent or empty file, another code, a failed result or no commit is a gap."""
    gaps = []
    for name in sorted(names):
        path = Path(root) / f"handled-{name}.txt"
        text = path.read_text(errors="replace") if path.is_file() else ""
        fields = dict(line.split(": ", 1) for line in text.splitlines() if ": " in line)
        if not (fields.get("code") == name and fields.get("result") == "pass" and re.fullmatch(r"[0-9a-f]{7,64}", fields.get("hermes_commit", ""))):
            gaps.append(name)
    return gaps


def test_handled_needs_evidence_and_the_constants_agree():
    assert set(compat.IMPLEMENTED) <= set(compat.AUTHORITY_BREAKS) | set(compat.PLG3_BREAKS)
    assert set(compat.HANDLED) <= set(compat.IMPLEMENTED)                      # proved means it has code
    assert evidence_gaps(compat.HANDLED) == [], "HANDLED names a break with no evidence file in tests/harness/evidence/"


def test_the_evidence_check_bites(tmp_path):
    """Mutations of the check itself: each is red (a gap) except the one good file."""
    good = "code: run_unknown\nresult: pass\nhermes_commit: 7de59bee0123\n"
    cases = {"absent": None, "empty": "", "another code": good.replace("run_unknown", "approval_resolve"), "failed": good.replace("pass", "fail"),
             "no commit": "code: run_unknown\nresult: pass\n", "bad commit": good.replace("7de59bee0123", "NOTHEX!"), "only the name": "run_unknown\n"}
    for label, text in cases.items():
        if text is not None:
            (tmp_path / "handled-run_unknown.txt").write_text(text)
        assert evidence_gaps({"run_unknown"}, tmp_path) == ["run_unknown"], label
    (tmp_path / "handled-run_unknown.txt").write_text(good)
    assert evidence_gaps({"run_unknown"}, tmp_path) == []
    # HANDLED filled without evidence, against the real folder: the guard above would be red (the breaks with no proof yet: `profile_selector`; the authority breaks have theirs)
    assert evidence_gaps(set(compat.PLG3_BREAKS)) == sorted(set(compat.PLG3_BREAKS))
    assert evidence_gaps(set(compat.AUTHORITY_BREAKS)) == []


def test_the_session_authority_is_read_from_the_capabilities_that_answered():
    on, off = {"features": {"run_unknown_resolution": True}}, {"features": {"run_submission": True}}
    assert compat.session_authority([]) is None
    assert compat.session_authority([None, "x", {}, {"features": "yes"}]) is None        # nothing readable: unknown, not False
    assert compat.session_authority([off]) is False and compat.session_authority([on]) is True
    assert compat.session_authority([off, on]) is True                                    # one gateway with it is enough to say so
    assert compat.session_authority([{"features": {"run_unknown_resolution": "true"}}]) is False


@pytest.mark.parametrize("field,value", [("display_version", "<script>alert(1)</script>"), ("display_version", "a b"), ("display_version", "x" * 65),
                                         ("display_version", 5), ("commit", "nothex!"), ("commit", "abc"), ("commit", "F8489405"),
                                         ("commit", "sk-" + "a" * 40), ("commit", ["x"])])
def test_hostile_or_malformed_identity_fields_are_dropped_not_echoed(field, value):
    got, _ = hermes({**BASE, field: value})
    assert got[field] is None and value not in got.values()


def test_the_payload_has_no_release_date_and_keeps_the_old_aliases_only():
    got, _ = hermes(BASE)
    assert set(got) == {"version", "display_version", "commit", "channel", "session_authority", "isolation", "compat", "limits",
                        "unproven", "baseline", "baseline_ok"}
    assert got["baseline"] == "f8489405" and got["baseline_ok"] is True


def test_read_asks_hermes_once_per_window(monkeypatch):
    calls = []
    monkeypatch.setattr(compat, "_identity", lambda: calls.append("i") or BASE)
    monkeypatch.setattr(compat, "_isolation", lambda: calls.append("s") or "in_process")
    compat._cache[:] = [0.0, None]
    assert compat.read() == (BASE, "in_process") and compat.read() == (BASE, "in_process") and calls == ["i", "s"]
    compat._cache[0] -= compat.CACHE_S + 1
    compat.read()
    assert calls == ["i", "s", "i", "s"]
    compat._cache[:] = [0.0, None]


def fake_hermes(monkeypatch, *, release_date, info, isolation_mode=None):
    """A stand-in `hermes_cli` whose release date and identity are set apart: the gate must follow the identity only."""
    package = types.ModuleType("hermes_cli")
    package.__release_date__ = release_date
    version_info = types.ModuleType("hermes_cli.version_info")
    version_info.get_version_info = lambda: types.SimpleNamespace(**info)
    monkeypatch.setitem(sys.modules, "hermes_cli", package)
    monkeypatch.setitem(sys.modules, "hermes_cli.version_info", version_info)
    if isolation_mode is None:
        monkeypatch.delitem(sys.modules, "hermes_cli.plugin_isolation", raising=False)
    else:
        module = types.ModuleType("hermes_cli.plugin_isolation")
        module.isolation_mode = isolation_mode
        monkeypatch.setitem(sys.modules, "hermes_cli.plugin_isolation", module)
    monkeypatch.delenv(compat.HOST_ENV, raising=False)
    compat._cache[:] = [0.0, None]


def info(base, commit, distance):
    return dict(base_version=base, display_version=f"{base}+{distance}" if distance else base, commit=commit, distance=distance)


def test_the_gate_follows_the_identity_and_ignores_the_release_date(monkeypatch):
    for date in ("2026.9.24", "2020.1.1", "2099.12.31", None, "garbage"):
        fake_hermes(monkeypatch, release_date=date, info=info("0.21.5", BASE["commit"], 3), isolation_mode=lambda: "in_process")
        identity, isolation = compat.read()
        assert (identity["version"], isolation) == ("0.21.5", "in_process") and hermes(identity, isolation)[0]["compat"] == "compatible", date
    fake_hermes(monkeypatch, release_date="2099.12.31", info=info("0.20.0", None, 0), isolation_mode=lambda: "in_process")
    assert compat.gate(*compat.read()) == "hermes_unsupported"                         # a recent date does not rescue an old release


def test_read_degrades_to_unknown_never_to_a_guess(monkeypatch):
    fake_hermes(monkeypatch, release_date="2026.9.24", info={}, isolation_mode=lambda: (_ for _ in ()).throw(RuntimeError("x")))
    assert compat.read() == (None, None)                                                # unreadable: unknown, so `untested`
    assert hermes(*compat.read(), None)[0]["compat"] == "untested"
    fake_hermes(monkeypatch, release_date="2026.9.24", info=info("0.22.2", None, 0), isolation_mode=lambda: "weird")
    assert compat.read()[1] is None                                                     # a value that is not a mode is unknown


def test_isolation_host_is_seen_from_the_config_and_from_inside_a_plugin_host(monkeypatch):
    fake_hermes(monkeypatch, release_date="2026.9.24", info=info("0.22.2", None, 0), isolation_mode=lambda: "host")
    assert compat.read()[1] == "host"
    fake_hermes(monkeypatch, release_date="2026.9.24", info=info("0.22.2", None, 0), isolation_mode=lambda: "in_process")
    monkeypatch.setenv(compat.HOST_ENV, "1")               # inside the host Hermes' own isolation_mode() says in_process
    compat._cache[:] = [0.0, None]
    assert compat.read()[1] == "host"
    monkeypatch.setenv(compat.HOST_ENV, "0")
    compat._cache[:] = [0.0, None]
    assert compat.read()[1] == "in_process"
    compat._cache[:] = [0.0, None]


# ---- the static guard: no code path reads a release date again ---------------------------------------------------------------
def reads_a_release_date(source):
    """True when the code reads Hermes's release constant or the `release_date` field of /api/status."""
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Attribute) and node.attr == "__release_date__":
            return True
        if isinstance(node, ast.Name) and node.id in ("__release_date__", "_release_date", "_baseline_state", "_BASELINE_DATE"):
            return True
        if isinstance(node, ast.Constant) and node.value == "release_date":
            return True
        if isinstance(node, ast.ImportFrom) and any(a.name == "__release_date__" for a in node.names):
            return True
    return False


OLD_GATE = '''
def _release_date():
    try:
        import hermes_cli
        return hermes_cli.__release_date__
    except Exception:
        return None
'''


def test_no_code_path_reads_a_release_date():
    sources = [REPO / "dashboard" / "plugin_api.py", REPO / "hermes-plugin" / "__init__.py", *sorted((REPO / "backend").glob("*.py"))]
    assert [p.name for p in sources if reads_a_release_date(p.read_text())] == []


def test_the_guard_is_red_on_the_old_gate():
    """The mutation: the date gate put back (in any of the shapes it had)."""
    assert reads_a_release_date(OLD_GATE)
    assert reads_a_release_date("raw = status.get('release_date')")
    assert reads_a_release_date("from hermes_cli import __release_date__")
    assert reads_a_release_date("baseline = _baseline_state(x)")
    assert not reads_a_release_date("hermes_cli.version_info.get_version_info()")
    plugin = (REPO / "dashboard" / "plugin_api.py").read_text()
    assert reads_a_release_date(plugin + OLD_GATE) and not reads_a_release_date(plugin)


# ---- ADR-006 D4: plugin_scope ------------------------------------------------------------------------------------------------
def scope(isolation="in_process", plg3=True, launch="default", active="default", enabled=None):
    return compat.plugin_scope(isolation, plg3, launch, active, {"default": True, "vendas": True} if enabled is None else enabled)


def test_plugin_scope_is_quiet_when_every_bot_has_the_plugin_or_the_selector_is_home():
    got = scope()
    assert got == {"plg3": True, "isolation": "in_process", "launch_profile": "default", "active_profile": "default",
                   "dashboard_enabled_in": ["default", "vendas"], "dashboard_missing_in": [], "selector_risk": False}
    assert scope(active="vendas")["selector_risk"] is False                      # the selector will land on a Bot that has it
    assert scope(enabled={"default": True, "vendas": False})["selector_risk"] is False   # active is the launch profile: the home is LuveBot


def test_selector_risk_needs_per_profile_plugins_another_active_profile_and_a_bot_without_the_plugin():
    risky = scope(active="vendas", enabled={"default": True, "vendas": False, "ana": True})
    assert risky["selector_risk"] is True and risky["dashboard_missing_in"] == ["vendas"] and risky["dashboard_enabled_in"] == ["ana", "default"]
    assert scope(plg3=False, active="vendas", enabled={"vendas": False})["selector_risk"] is False   # v0.22.2: no per-profile plugins
    assert scope(launch=None, active="vendas", enabled={"vendas": False})["selector_risk"] is False  # unreadable: no accusation
    assert scope(active=None, enabled={"vendas": False})["selector_risk"] is False
    assert scope(active="vendas", enabled={"default": True, "vendas": None})["dashboard_missing_in"] == ["vendas"]   # not known to be enabled


def test_without_per_profile_plugins_nothing_about_enablement_is_reported():
    got = scope(plg3=False, enabled={"default": True, "vendas": False})
    assert (got["plg3"], got["dashboard_enabled_in"], got["dashboard_missing_in"]) == (False, [], [])


def test_isolation_unknown_reads_as_in_process_and_hostile_names_are_dropped():
    assert scope(isolation=None)["isolation"] == "in_process" and scope(isolation="host")["isolation"] == "host"
    assert scope(isolation="weird")["isolation"] == "in_process"
    got = scope(launch="/etc/passwd", active="a b")
    assert got["launch_profile"] is None and got["active_profile"] is None and got["selector_risk"] is False
    custom = scope(launch="custom", active="vendas", enabled={"vendas": False})                      # F2-5: "custom" names no profile
    assert custom["launch_profile"] is None and custom["selector_risk"] is False and custom["active_profile"] == "vendas"
    assert set(got) == {"plg3", "isolation", "launch_profile", "active_profile", "dashboard_enabled_in", "dashboard_missing_in", "selector_risk"}


def fake_profiles(monkeypatch, *, launch="default", active="default", plg3=True, raises=False):
    package = types.ModuleType("hermes_cli")
    profiles = types.ModuleType("hermes_cli.profiles")

    def explode():
        raise RuntimeError("unreadable")
    profiles.get_active_profile_name = explode if raises else (lambda: launch)
    profiles.get_active_profile = explode if raises else (lambda: active)
    package.profiles = profiles
    monkeypatch.setitem(sys.modules, "hermes_cli", package)
    monkeypatch.setitem(sys.modules, "hermes_cli.profiles", profiles)
    if plg3:
        module = types.ModuleType("hermes_cli.web_server_plugin_profiles")
        module.__spec__ = importlib.machinery.ModuleSpec("hermes_cli.web_server_plugin_profiles", None)
        monkeypatch.setitem(sys.modules, "hermes_cli.web_server_plugin_profiles", module)
    else:
        monkeypatch.delitem(sys.modules, "hermes_cli.web_server_plugin_profiles", raising=False)


def test_read_scope_reads_the_profiles_and_the_enablement_only_with_per_profile_plugins(monkeypatch):
    fake_profiles(monkeypatch, launch="default", active="vendas", plg3=True)
    seen = []
    got = compat.read_scope(["default", "vendas"], lambda name: seen.append(name) or name == "default")
    assert got == (True, "default", "vendas", {"default": True, "vendas": False}) and seen == ["default", "vendas"]
    fake_profiles(monkeypatch, plg3=False)
    seen.clear()
    assert compat.read_scope(["default"], lambda name: seen.append(name) or True) == (False, "default", "default", {}) and seen == []
    fake_profiles(monkeypatch, raises=True)
    assert compat.read_scope(["default"], lambda name: True)[1:3] == (None, None)       # unreadable: unknown, never a guess
    fake_profiles(monkeypatch, launch="", active="")
    assert compat.read_scope([], None)[1:3] == ("default", "default")                    # Hermes's own reading of an empty name


def test_a_bot_whose_config_cannot_be_read_is_not_shown_as_enabled(monkeypatch):
    fake_profiles(monkeypatch)

    def reader(name):
        if name == "broken":
            raise OSError("unreadable")
        return True
    assert compat.read_scope(["default", "broken"], reader)[3] == {"default": True, "broken": False}


# ---- ADR-006 D2b: the dashboard's ?profile= selector ---------------------------------------------------------------------------
@pytest.mark.parametrize("value,launch,ok", [
    ("", "default", True), ("current", "default", True), ("default", "default", True), ("vendas", "vendas", True),
    ("vendas", "default", False), ("Current", "default", False), ("CURRENT ", "default", False), (" default", "default", False),
    ("default\n", "default", False), ("../x", "default", False), ("default", None, False), ("custom", None, False),
    ("", None, True), ("current", None, True), ("x" * 70, "x" * 70, True)])
def test_only_none_current_and_the_launch_profile_are_answered(value, launch, ok):
    assert compat.profile_param_ok(value, launch) is ok


def test_the_launch_profile_is_the_one_the_dashboard_is_scoped_to_and_custom_names_none(monkeypatch):
    for name, expected in (("vendas", "vendas"), ("", "default"), (None, "default"), ("custom", None), ("a b", None), ("x" * 65, None)):
        fake_profiles(monkeypatch, launch=name)
        compat._launch[:] = [-compat.CACHE_S, None]
        assert compat.launch_profile() == expected, name
    fake_profiles(monkeypatch, raises=True)
    compat._launch[:] = [-compat.CACHE_S, None]
    assert compat.launch_profile() is None                                                # unreadable: only none and `current` pass


def test_the_launch_profile_is_read_once_per_window(monkeypatch):
    calls = []
    fake_profiles(monkeypatch, launch="default")
    sys.modules["hermes_cli.profiles"].get_active_profile_name = lambda: calls.append(1) or "default"
    compat._launch[:] = [-compat.CACHE_S, None]
    assert compat.launch_profile() == "default" and compat.launch_profile() == "default" and calls == [1]
    compat._launch[0] -= compat.CACHE_S + 1
    compat.launch_profile()
    assert calls == [1, 1]
    compat._launch[:] = [-compat.CACHE_S, None]


# ---- COMPAT-1 (A-193): a TAG built from a tested commit is compatible although `limits` is not empty ---------------------------------------------------------
def rule_checks(module, monkeypatch):
    """The real state of 0.22.5: the three authority breaks are HANDLED, `profile_selector` (PLG-3) has no code, so `limits` is [`profile_selector`] with plg3 on."""
    monkeypatch.setattr(module, "HANDLED", frozenset(module.AUTHORITY_BREAKS))
    tag = {**V0222, "version": "0.22.5", "display_version": "0.22.5", "commit": module.TESTED_COMMITS[0]}
    got, problem = module.describe(tag, "in_process", True, True)
    assert (got["compat"], got["limits"], got["unproven"], got["channel"], problem) == ("compatible", ["profile_selector"], [], "stable", None)    # listed, not a reason
    other = {**tag, "commit": "9a8b7c6d" + "0" * 32}                                                          # a tag the suite never ran on: the same limits are a reason
    assert module.describe(other, "in_process", True, True)[0]["compat"] == "untested"
    main_tested = {**tag, "distance": 3, "display_version": "0.22.5+3"}                                       # MAIN needs `limits` empty even on a tested commit
    assert module.describe(main_tested, "in_process", True, True)[0]["compat"] == "untested"
    assert module.describe(MAIN, "in_process", True, True)[0]["compat"] == "untested"
    unreadable = {**tag, "distance": None}                                                                    # an unreadable channel is not a tag
    assert module.describe(unreadable, "in_process", True, True)[0]["compat"] == "untested"
    assert module.describe(unreadable, "in_process", False, False)[0]["compat"] == "compatible"               # ...and with nothing in `limits` it is, as before
    monkeypatch.setattr(module, "HANDLED", frozenset())                                                       # code without proof: never
    assert module.describe(tag, "in_process", True, True)[0]["compat"] == "untested" and module.describe(tag, "in_process", True, False)[0]["unproven"] != []
    monkeypatch.setattr(module, "HANDLED", frozenset(module.AUTHORITY_BREAKS))
    tested_commit = module.TESTED_COMMITS[0]
    other_end = tested_commit[:-1] + ("0" if tested_commit[-1] != "0" else "1")                              # differs in the LAST hex digit only
    for bad in ({"dirty": True}, {"commit": tested_commit.upper()}, {"commit": tested_commit[:7]}, {"commit": tested_commit[:8]}, {"commit": tested_commit[:12]}, {"commit": tested_commit[:39]},
                {"commit": other_end}, {"commit": tested_commit + "0"}, {"commit": "f8489405" + "0" * 32}, {"commit": "f8489405" + "g" * 32}, {"commit": 5}, {"commit": None}, {"commit": ""}):
        assert module.describe({**tag, **bad}, "in_process", True, True)[0]["compat"] == "untested", bad       # a dirty tree, a commit of the wrong shape or one that shares only a SHORTER start
    assert module.describe({**tag, "commit": tested_commit}, "in_process", True, True)[0]["compat"] == "compatible"   # EQUALITY with the full commit is the match
    assert module.describe(tag, "host", True, True)[0]["compat"] == "unsupported"                              # a refusal still wins


def test_a_tag_built_from_a_tested_commit_is_compatible_with_limits_listed(monkeypatch):
    rule_checks(compat, monkeypatch)


def test_every_tested_commit_makes_a_tag_compatible_and_only_when_it_is_whole(monkeypatch):
    """COMPAT-3 (A-205): the full commit of Hermes v0.22.5, the build the harness ran the whole suite on, is tested. EVERY entry of TESTED_COMMITS is compared by equality: the full commit makes a tag `compatible`, and a short start of it, a
    change of the last digit or an upper-case spelling does not."""
    monkeypatch.setattr(compat, "HANDLED", frozenset(compat.AUTHORITY_BREAKS))
    tag = {**V0222, "version": "0.22.5", "display_version": "0.22.5"}
    assert "bf0203a794a07aac3ff764972ab9087baa4e4f4e" in compat.TESTED_COMMITS
    for commit in compat.TESTED_COMMITS:
        assert compat.describe({**tag, "commit": commit}, "in_process", True, True)[0]["compat"] == "compatible", commit
        for bad in (commit[:8], commit[:39], commit.upper(), commit[:-1] + ("0" if commit[-1] != "0" else "1"), commit + "0"):
            assert compat.describe({**tag, "commit": bad}, "in_process", True, True)[0]["compat"] == "untested", bad


def test_every_tested_commit_is_a_full_commit_and_the_baseline_label_is_its_start():
    assert compat.TESTED_COMMITS and all(isinstance(c, str) and re.fullmatch(r"[0-9a-f]{40}", c) for c in compat.TESTED_COMMITS)    # A-194: 40 hex, no prefix
    assert compat.BASELINE == "f8489405" and compat.BASELINE_COMMIT.startswith(compat.BASELINE) and compat.BASELINE_COMMIT in compat.TESTED_COMMITS


@pytest.mark.parametrize("old,new", [
    ('    elif tag and tested:', '    elif tested:'),
    ('    elif tag and tested:', '    elif tag:'),
    ('    elif unproven:  # code without a harness proof, in any channel and on any build\n        compat, code = "untested", "hermes_untested"\n', ''),
    ('    elif limits:  # a break with no code', '    elif False:  # a break with no code'),
    ('    tested = clean_commit and identity["commit"] in TESTED_COMMITS', '    tested = bool(identity) and identity.get("commit") in TESTED_COMMITS'),
    ('    tested = clean_commit and identity["commit"] in TESTED_COMMITS', '    tested = clean_commit and identity["commit"].startswith(TESTED_COMMITS)'),
    ('    tested = clean_commit and identity["commit"] in TESTED_COMMITS', '    tested = clean_commit and any(t.startswith(identity["commit"]) for t in TESTED_COMMITS)'),
    ('    tested = clean_commit and identity["commit"] in TESTED_COMMITS', '    tested = clean_commit and identity["commit"][:12] in tuple(c[:12] for c in TESTED_COMMITS)'),
    ('    tag = isinstance(distance, int) and not isinstance(distance, bool) and distance == 0', '    tag = isinstance(distance, int) and distance == 0 or distance is None'),
    ('    elif tested:\n        compat, code = "compatible", None  # an unreadable channel', '    elif False:\n        compat, code = "compatible", None  # an unreadable channel'),
], ids=["any_tested_build", "any_tag", "unproven_passes", "limits_never_matter", "a_dirty_commit_is_tested", "startswith_is_back", "a_short_commit_is_a_prefix_of_a_tested_one", "only_twelve_digits_are_compared", "an_unreadable_channel_is_a_tag", "an_unreadable_tested_channel_is_refused"])
def test_each_compat_rule_mutation_is_caught(monkeypatch, old, new):
    source = (REPO / "backend" / "hermes_compat.py").read_text()
    assert source.count(old) == 1, old
    variant = types.ModuleType("backend.hermes_compat_variant")
    exec(compile(source.replace(old, new), "hermes_compat_variant", "exec"), variant.__dict__)
    with pytest.raises(AssertionError):
        rule_checks(variant, monkeypatch)
