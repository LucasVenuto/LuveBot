"""D-025: the stored approval surface (hook_store) and the route's validation (approval_surface), as pure code."""
import json
import sqlite3

import pytest

import backend.hook_store as store
from backend.api_errors import PluginError
import backend.approval_surface as surface


def test_default_is_luvebot_and_a_row_round_trips(tmp_path):
    db = tmp_path / "f.db"
    assert store.read_surface(db, "p") == {"mode": "luvebot", "approvers": [], "digest": None, "updated_at": None, "updated_by": None}
    store.put_surface(db, "p", "channel", ["telegram:9", "telegram:42"], "basic:ana", now=5.0)
    row = store.read_surface(db, "p")
    assert row["mode"] == "channel" and row["approvers"] == ["telegram:42", "telegram:9"] and row["updated_by"] == "basic:ana"
    assert row["digest"] == store.surface_digest("channel", ["telegram:9", "telegram:42"])          # order does not matter
    assert store.read_surface(db, "other")["mode"] == "luvebot"


@pytest.mark.parametrize("tamper", [
    "UPDATE approval_surface SET mode='both'",
    "UPDATE approval_surface SET approvers_json='[\"telegram:42\",\"discord:1\"]'",
    "UPDATE approval_surface SET approvers_json='[\"telegram:7\"]'",                         # digest no longer matches
    "UPDATE approval_surface SET approvers_json='not json'",
    "UPDATE approval_surface SET approvers_json='[]'",
])
def test_a_row_that_does_not_verify_reads_as_luvebot(tmp_path, tamper):
    db = tmp_path / "f.db"
    store.put_surface(db, "p", "channel", ["telegram:42"], "basic:ana")
    conn = sqlite3.connect(db)
    conn.execute(tamper)
    conn.commit()
    conn.close()
    assert store.read_surface(db, "p")["mode"] == "luvebot"


@pytest.mark.parametrize("mode,approvers", [("both", ["telegram:1"]), ("channel", []), ("channel", ["telegram:1", "telegram:1"]),
                                            ("channel", ["discord:1"]), ("channel", ["telegram:abc"]), ("channel", ["telegram:١٢"]),
                                            ("channel", [f"telegram:{i}" for i in range(21)]), ("channel", "telegram:1")])
def test_put_refuses_what_the_hook_must_not_act_on(tmp_path, mode, approvers):
    with pytest.raises(ValueError):
        store.put_surface(tmp_path / "f.db", "p", mode, approvers, "basic:ana")


@pytest.mark.parametrize("body", [None, [], {}, {"approvers": []}, {"mode": "both"}, {"mode": "channel"}, {"mode": "channel", "approvers": []},
                                  {"mode": "channel", "approvers": ["telegram:1"], "extra": 1}, {"mode": "channel", "approvers": "telegram:1"},
                                  {"mode": "channel", "approvers": [1]}, {"mode": "channel", "approvers": ["telegram:1", "telegram:1"]},
                                  {"mode": "channel", "approvers": [" telegram:1"]}])
def test_parse_refuses_bad_bodies_with_422(body):
    with pytest.raises(PluginError) as refused:
        surface.parse(body)
    assert refused.value.code == "invalid_field" and refused.value.status == 422


def test_parse_accepts_the_contract():
    assert surface.parse({"mode": "luvebot"}) == ("luvebot", [])
    assert surface.parse({"mode": "channel", "approvers": ["telegram:9", "telegram:42"]}) == ("channel", ["telegram:42", "telegram:9"])


def test_loosens_is_true_only_when_more_approvals_can_reach_a_chat():
    off = {"mode": "luvebot", "approvers": []}
    on = {"mode": "channel", "approvers": ["telegram:1"]}
    assert surface.loosens(off, "channel", ["telegram:1"])                 # turning it on
    assert surface.loosens({"mode": "luvebot", "approvers": ["telegram:1"]}, "channel", ["telegram:1"])   # back on, same names kept
    assert surface.loosens(on, "channel", ["telegram:1", "telegram:2"])    # naming someone new
    assert not surface.loosens(on, "channel", ["telegram:1"])             # same
    assert not surface.loosens({"mode": "channel", "approvers": ["telegram:1", "telegram:2"]}, "channel", ["telegram:1"])   # fewer
    assert not surface.loosens(on, "luvebot", [])                         # turning it off


@pytest.mark.parametrize("raw,open_", [("*", True), (" * ", True), ("123,*", True), ('["123", "*"]', True), (["42", "*"], True),
                                       ("[*", True), ("42,43", False), ('["42"]', False), (["42"], False), ("", False), (None, False)])
def test_the_wildcard_is_read_the_way_hermes_reads_an_allowlist(raw, open_):
    assert store.has_wildcard(raw) is open_


def hermes_stub(monkeypatch, secrets=None, config=None, environ=None):
    """The three Hermes calls allow_all makes, as thin stand-ins: what is under test is OUR reading of their values."""
    import contextlib
    import sys
    import types
    for name in ("agent", "hermes_cli"):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    monkeypatch.setitem(sys.modules, "agent.secret_scope", types.SimpleNamespace(get_secret=lambda n, d=None: (secrets or {}).get(n, d)))
    monkeypatch.setitem(sys.modules, "hermes_cli.config", types.SimpleNamespace(load_config=lambda: config or {}))
    monkeypatch.setitem(sys.modules, "hermes_cli.web_server_profiles", types.SimpleNamespace(_config_profile_scope=lambda bot: contextlib.nullcontext()))
    for name in ("GATEWAY_ALLOW_ALL_USERS", "TELEGRAM_ALLOW_ALL_USERS", "TELEGRAM_ALLOWED_USERS", "GATEWAY_ALLOWED_USERS"):
        monkeypatch.delenv(name, raising=False)
    for name, value in (environ or {}).items():
        monkeypatch.setenv(name, value)


@pytest.mark.parametrize("where,expected", [
    ({"secrets": {"TELEGRAM_ALLOWED_USERS": "*"}}, "TELEGRAM_ALLOWED_USERS"),
    ({"secrets": {"GATEWAY_ALLOWED_USERS": "123,*"}}, "GATEWAY_ALLOWED_USERS"),
    ({"secrets": {"TELEGRAM_ALLOWED_USERS": '["123", "*"]'}}, "TELEGRAM_ALLOWED_USERS"),
    ({"environ": {"GATEWAY_ALLOWED_USERS": "*"}}, "GATEWAY_ALLOWED_USERS"),
    ({"secrets": {"TELEGRAM_ALLOW_ALL_USERS": "yes"}}, "TELEGRAM_ALLOW_ALL_USERS"),
    ({"config": {"allow_all_users": True}}, "allow_all_users"),
    ({"config": {"gateway": {"allow_all_users": "true"}}}, "allow_all_users"),
    ({"config": {"telegram": {"allow_from": "*"}}}, "allow_from"),
    ({"config": {"telegram": {"extra": {"allow_from": ["42", "*"]}}}}, "allow_from"),
    ({"config": {"platforms": {"telegram": {"extra": {"allow_from": "*"}}}}}, "allow_from"),
    ({"config": {"gateway": {"platforms": {"telegram": {"allow_from": "123,*"}}}}}, "allow_from"),
])
def test_allow_all_sees_every_way_the_gateway_lets_everyone_in(monkeypatch, where, expected):
    hermes_stub(monkeypatch, **where)
    assert surface.allow_all("p") == (True, expected)


def test_named_allowlists_without_the_wildcard_are_not_allow_all(monkeypatch):
    hermes_stub(monkeypatch, secrets={"TELEGRAM_ALLOWED_USERS": "42,43", "GATEWAY_ALLOWED_USERS": '["42"]'},
                config={"telegram": {"allow_from": ["42"], "extra": {"allow_from": "42"}}, "platforms": {"telegram": {"allow_from": "43"}}})
    assert surface.allow_all("p") == (False, None)


def test_allow_all_fails_closed_when_hermes_cannot_be_read(monkeypatch):
    import builtins
    real_import = builtins.__import__

    def no_hermes(name, *a, **k):
        if name.startswith(("agent", "hermes_cli")):
            raise ImportError(name)
        return real_import(name, *a, **k)
    monkeypatch.setattr(builtins, "__import__", no_hermes)
    assert surface.allow_all("p") == (True, "unreadable")


# ---- applied / applied_reason (VPS 2026-10-02: hook 0.3.0 live, setting saved, the card said "the hook needs an update") ------
from backend.rules import HookState

D = store.surface_digest('channel', ['telegram:8851915860'])


@pytest.mark.parametrize('mode,state,reason', [
    ('channel', HookState(True, 5.0, 't', '0.3.0', D), 'applied'),
    ('channel', HookState(True, 5.0, 't', '0.3.1', D), 'applied'),
    ('channel', HookState(True, 5.0, 't', '0.3.0', None), 'pending'),          # right after saving: not reported yet
    ('channel', HookState(True, 5.0, 't', '0.3.0', 'e' * 64), 'pending'),      # still reporting the previous setting
    ('channel', HookState(True, 5.0, 't', '0.2.1', D), 'hook_outdated'),
    ('channel', HookState(True, 5.0, 't', None, D), 'hook_outdated'),           # a version it cannot read is not enough
    ('channel', HookState(True, 500.0, 't', '0.3.0', D), 'hook_not_live'),      # no recent heartbeat
    ('channel', HookState(False, 5.0, 't', '0.3.0', D), 'hook_not_live'),       # not installed and enabled
    ('channel', HookState(True, None, None, None, None), 'hook_not_live'),
    ('luvebot', HookState(True, 5.0, 't', '0.2.0', None), 'applied'),
    ('luvebot', HookState(True, 5.0, 't', '0.1.0', None), 'hook_outdated'),
])
def test_applied_says_why(tmp_path, monkeypatch, mode, state, reason):
    db = tmp_path / 'fleet.db'
    store.put_surface(db, 'default', mode, ['telegram:8851915860'] if mode == 'channel' else [], 'basic:ceo')
    monkeypatch.setattr(surface, 'allow_all', lambda bot: (False, None))
    monkeypatch.setattr(surface.hook, 'seal_state', lambda path, bot: state)
    got = surface.view(db, 'default')
    assert (got['applied_reason'], got['applied']) == (reason, reason == 'applied')


def test_after_saving_the_view_waits_for_the_hook_only_while_it_is_pending(tmp_path, monkeypatch):
    db = tmp_path / 'fleet.db'
    store.put_surface(db, 'default', 'channel', ['telegram:8851915860'], 'basic:ceo')
    monkeypatch.setattr(surface, 'allow_all', lambda bot: (False, None))
    beats = iter([HookState(True, 1.0, 't', '0.3.0', None)] * 3 + [HookState(True, 1.0, 't', '0.3.0', D)] * 10)
    monkeypatch.setattr(surface.hook, 'seal_state', lambda path, bot: next(beats))
    assert surface.view_after_save(db, 'default', timeout=5, every=0.01)['applied_reason'] == 'applied'    # the hook reported it
    monkeypatch.setattr(surface.hook, 'seal_state', lambda path, bot: HookState(True, 1.0, 't', '0.3.0', None))
    started = __import__('time').monotonic()
    assert surface.view_after_save(db, 'default', timeout=0.2, every=0.01)['applied_reason'] == 'pending'   # bounded
    assert __import__('time').monotonic() - started < 1
    calls = []
    monkeypatch.setattr(surface.hook, 'seal_state', lambda path, bot: calls.append(1) or HookState(True, 1.0, 't', '0.2.0', D))
    assert surface.view_after_save(db, 'default', timeout=5, every=0.01)['applied_reason'] == 'hook_outdated' and len(calls) == 1


# ---- hook_latest_version (t161): the version this LuveBot ships, so an older hook is offered the update ----
import ast as _ast
from pathlib import Path as _Path
import importlib.util as _ilu
import sys as _sys

import backend.hook as _hook

_HOOK_FILE = _Path(__file__).resolve().parents[3] / "hermes-plugin" / "__init__.py"


def _shipped():
    """PLUGIN_VERSION of the hook, read independently of the code under test."""
    tree = _ast.parse(_HOOK_FILE.read_text())
    return next(n.value.value for n in tree.body if isinstance(n, _ast.Assign) and getattr(n.targets[0], "id", "") == "PLUGIN_VERSION")


def _latest_version_checks(module, tmp_path, monkeypatch):
    monkeypatch.delenv("LUVEBOT_HOOK_SOURCE", raising=False)
    loaded = {name for name, mod in _sys.modules.items() if "hermes-plugin" in str(getattr(mod, "__file__", "") or "")}
    assert module.latest_version() == _shipped()
    assert {name for name, mod in _sys.modules.items() if "hermes-plugin" in str(getattr(mod, "__file__", "") or "")} == loaded  # read, never imported
    fake = tmp_path / "repo" / "hermes-plugin"
    fake.mkdir(parents=True)
    monkeypatch.setenv("LUVEBOT_HOOK_SOURCE", f"file://{tmp_path / 'repo'}")   # the same source the installer uses
    (fake / "__init__.py").write_text('PLUGIN_VERSION = "9.9.10"\n')
    assert module.latest_version() == "9.9.10"
    (fake / "__init__.py").write_text('PLUGIN_VERSION = "dev"\n')
    assert module.latest_version() is None
    (fake / "__init__.py").unlink()
    assert module.latest_version() is None
    monkeypatch.setenv("LUVEBOT_HOOK_SOURCE", "http://example.com/x")
    assert module.latest_version() is None


def test_the_hook_version_this_luvebot_ships_is_read_not_imported(tmp_path, monkeypatch):
    _latest_version_checks(_hook, tmp_path, monkeypatch)   # the view's field: tests/invariants/test_approval_surface.py (needs Hermes)


def test_the_mutation_is_caught(tmp_path, monkeypatch):
    source = _Path(_hook.__file__).read_text()
    old = "_SHIPPED = re.compile(r'^PLUGIN_VERSION = "
    assert source.count(old) == 1
    spec = _ilu.spec_from_loader("backend.hook_mutant", loader=None)
    mutant = _ilu.module_from_spec(spec)
    mutant.__package__, mutant.__file__ = "backend", _hook.__file__
    exec(compile(source.replace(old, "_SHIPPED = re.compile(r'^HOOK_VERSION = "), _hook.__file__, "exec"), mutant.__dict__)
    with pytest.raises(AssertionError):
        _latest_version_checks(mutant, tmp_path, monkeypatch)
