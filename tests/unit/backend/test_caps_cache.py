"""Perf item 5: GET /health asked every Bot's API Server on every call (a slow one held every call up to 3 s: measured 2.5 s with a 2.5 s Hermes).
`bots.capabilities_cached` remembers the probe of each Bot for 15 s, the failure too, and gives back exactly what `HermesClient(name).capabilities`
gave or raised. Real module, Hermes's client faked."""
import contextlib
import sys
import types

import pytest


def _stub(name, **attrs):
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    sys.modules[name] = module


_installed = [name for name in ("agent", "hermes_cli", "agent.secret_scope", "hermes_cli.profiles", "hermes_cli.web_server_profiles") if name not in sys.modules]
for _name, _attrs in (("agent", {}), ("hermes_cli", {}), ("agent.secret_scope", {"current_secret_scope": lambda: None, "get_secret": lambda *a: None}),
                      ("hermes_cli.profiles", {"list_profile_names": lambda: []}),
                      ("hermes_cli.web_server_profiles", {"_config_profile_scope": lambda p: contextlib.nullcontext()})):
    if _name in _installed:
        _stub(_name, **_attrs)

from backend import bots  # noqa: E402
from backend.hermes_client import HermesError  # noqa: E402

for _name in _installed:
    sys.modules.pop(_name, None)


@pytest.fixture
def probe(monkeypatch):
    state = {"calls": [], "answers": {}, "now": 1000.0}

    class Client:
        def __init__(self, name):
            self.name = name

        def capabilities(self):
            state["calls"].append(self.name)
            answer = state["answers"][self.name]
            if isinstance(answer, Exception):
                raise answer
            return answer
    monkeypatch.setattr(bots, "HermesClient", Client)
    monkeypatch.setattr(bots.time, "monotonic", lambda: state["now"])
    bots._raw_caps.clear()
    yield state
    bots._raw_caps.clear()


def test_a_probe_is_remembered_for_its_time_per_bot(probe):
    probe["answers"] = {"vendas": {"object": "x", "n": 1}, "suporte": {"object": "x", "n": 2}}
    assert bots.capabilities_cached("vendas")["n"] == 1 and bots.capabilities_cached("suporte")["n"] == 2
    assert bots.capabilities_cached("vendas")["n"] == 1
    assert probe["calls"] == ["vendas", "suporte"]                                          # the second ask of vendas never reached Hermes
    probe["now"] += bots._RAW_TTL - 0.1
    bots.capabilities_cached("vendas")
    assert probe["calls"] == ["vendas", "suporte"]
    probe["now"] += 0.2
    probe["answers"]["vendas"] = {"object": "x", "n": 3}
    assert bots.capabilities_cached("vendas")["n"] == 3 and probe["calls"][-1] == "vendas"  # older than its time: asked again
    assert bots._RAW_TTL == 15


def test_a_failure_is_remembered_too_and_given_back_as_the_error_it_was(probe):
    boom = HermesError("hermes_timeout")
    probe["answers"] = {"vendas": boom}
    first = bots.capabilities_cached("vendas")
    assert first is boom and bots.capabilities_cached("vendas") is boom and probe["calls"] == ["vendas"]    # one slow Bot is asked once, not by every tab
    probe["now"] += bots._RAW_TTL + 1
    probe["answers"]["vendas"] = {"object": "x"}
    assert bots.capabilities_cached("vendas") == {"object": "x"}                              # and it is asked again when its time is up


def test_only_a_hermes_error_is_kept_any_other_exception_goes_up(probe):
    probe["answers"] = {"vendas": RuntimeError("bug")}
    with pytest.raises(RuntimeError):
        bots.capabilities_cached("vendas")
    assert "vendas" not in bots._raw_caps


def test_a_cache_with_no_memory_turns_the_tests_red(probe, monkeypatch):
    """Mutation: a time-to-live of 0 is no cache; the tests above must notice."""
    monkeypatch.setattr(bots, "_RAW_TTL", 0)
    with pytest.raises(AssertionError):
        test_a_probe_is_remembered_for_its_time_per_bot(probe)
    with pytest.raises(AssertionError):
        test_a_failure_is_remembered_too_and_given_back_as_the_error_it_was(probe)
