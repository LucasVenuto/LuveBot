"""Hook 0.5.0 (docs/propostas/hook-0.5-free-pass-e-espera.md, approved by the Architect): it decides nothing new, it WRITES two more
kinds of row in `hook_events`.
* A2 `free_pass`: the free surface silenced an ask rule of the Bot's own table and nothing else asks (a handoff's origin may still: then
  the origin's own row is the record, not a pass); never when the Bot is not free; a failed write never changes the answer.
* F6-B `waiting` / `resolved` from Hermes's `on_human_input_request` / `on_human_input_resolved`: five payload keys, each checked against a
  fixed shape; never what the person typed, the session key or anything in `**extra`; another profile's turn ignored; the observer only
  observes (returns None, imports nothing of Hermes's approval code); a Hermes without the events registers nothing and breaks nothing.
Real hook, real built-in table, in process (as test_hook_free_mode.py). Mutations: the plugin source with one line changed -> red."""
import ast
import re
import sqlite3
import sys
import types

import pytest

from test_hook_free_mode import ASKED, IDS, action, answers, fake_kanban, rig

SECRET = "hunter2-the-typed-password"
REQUEST = "0123456789abcdef0123456789abcdef"


def free(store, db, profile="p"):
    store.put_surface(db, profile, "free", [], "basic:ceo")


def rows(store, db, verdict, profile="p"):
    return [r for r in store.events(db, profile, 500) if r["verdict"] == verdict]


def locked(*_a, **_k):
    raise sqlite3.OperationalError("database is locked")


# ---- A2: free_pass -----------------------------------------------------------------------------------------------------------
def test_a_free_bot_leaves_a_free_pass_row_for_each_ask_it_silenced(tmp_path, monkeypatch):
    plugin, store, db = rig(tmp_path)
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    monkeypatch.setattr(plugin, "_redact", lambda text: text[:500])          # Hermes's redactor is not in this process
    free(store, db)
    call = plugin._make_hook("p")
    assert answers(call, ASKED) == dict.fromkeys(ASKED)                      # the answer is still nothing at all
    got = rows(store, db, "free_pass")
    assert len(got) == len(ASKED) and not rows(store, db, "approve") and not rows(store, db, "block")
    by_command = {r["command"]: r for r in got}
    assert set(by_command) == {args["command"] for _tool, args in ASKED.values()}
    chmod = by_command["chmod 600 /tmp/x"]
    assert (chmod["tool"], chmod["profile"], chmod["session_id"], chmod["tool_call_id"]) == ("terminal", "p", "s", "c")
    assert chmod["rule_id"] and chmod["message"] and "rule_key" not in chmod
    assert by_command["'ls' -la"]["rule_id"] is None                         # the non-canonical floor has no rule id


def test_a_command_the_hook_could_not_redact_is_not_stored(tmp_path, monkeypatch):
    plugin, store, db = rig(tmp_path)
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    free(store, db)
    monkeypatch.setitem(sys.modules, "agent.redact", None)                    # no redactor even where Hermes is installed (its venv has one)
    plugin._make_hook("p")("terminal", {"command": f"chmod 600 /tmp/{SECRET}"}, **IDS)   # no `agent.redact` here: no redactor, no text
    assert [r["command"] for r in rows(store, db, "free_pass")] == [None]
    assert SECRET not in repr(store.events(db, "p", 50))


def test_only_a_free_bot_writes_free_pass_and_a_silenced_ask_that_other_things_still_ask_is_not_a_pass(tmp_path, monkeypatch):
    plugin, store, db = rig(tmp_path)
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    call = plugin._make_hook("p")
    answers(call, ASKED)                                                     # the default surface
    store.put_surface(db, "p", "channel", ["telegram:42"], "basic:ceo")
    answers(call, ASKED)
    assert not rows(store, db, "free_pass")
    free(store, db)
    answers(call, STOPPED_ONLY)                                              # a block is not a pass
    assert not rows(store, db, "free_pass") and len(rows(store, db, "block")) == len(STOPPED_ONLY)
    fake_kanban(monkeypatch, "guarded")                                      # a handoff from a Bot that is not free: the origin asks
    asked_before = len(rows(store, db, "approve"))
    answers(call, ASKED)
    assert not rows(store, db, "free_pass") and len(rows(store, db, "approve")) == asked_before + len(ASKED)
    store.put_surface(db, "guarded", "free", [], "basic:ceo")                # the origin is free too: nothing asks, so it passed
    answers(call, ASKED)
    assert len(rows(store, db, "free_pass")) == len(ASKED)


STOPPED_ONLY = {"chpasswd": ("terminal", {"command": "chpasswd --help"}), "make_payment": ("make_payment", {})}


def test_a_failed_write_of_the_row_never_changes_the_answer(tmp_path, monkeypatch):
    plugin, store, db = rig(tmp_path)
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    free(store, db)
    call = plugin._make_hook("p")
    monkeypatch.setattr(store, "record_event", locked)
    assert answers(call, ASKED) == dict.fromkeys(ASKED)                      # a free Bot stays free
    assert {k: action(v) for k, v in answers(call, STOPPED_ONLY).items()} == dict.fromkeys(STOPPED_ONLY, "block")


# ---- F6-B: the observers ------------------------------------------------------------------------------------------------------
def session_env(monkeypatch, profile=""):
    context = types.ModuleType("gateway.session_context")
    context.get_session_env = lambda name, default="": profile if name == "HERMES_SESSION_PROFILE" else default
    monkeypatch.setitem(sys.modules, "gateway", types.ModuleType("gateway"))
    monkeypatch.setitem(sys.modules, "gateway.session_context", context)


def payload(**changes):
    base = {"kind": "clarify", "request_id": REQUEST, "session_id": "sess-1", "session_key": "agent:main:telegram:dm:9:7",
            "platform": "telegram", "prompt": "May I delete the folder?"}
    return {**base, **changes}


def observe(plugin, phase, monkeypatch, **changes):
    return plugin._human_input_observer("p", phase)(**payload(**changes))


def test_a_wait_and_its_end_are_two_rows_with_the_same_request_id(tmp_path, monkeypatch):
    plugin, store, db = rig(tmp_path)
    session_env(monkeypatch)
    monkeypatch.setattr(plugin, "_redact", lambda text: text[:500])
    assert observe(plugin, "waiting", monkeypatch) is None                    # an observer answers nothing
    assert observe(plugin, "resolved", monkeypatch, outcome="answered") is None
    waiting, resolved = rows(store, db, "waiting"), rows(store, db, "resolved")
    assert len(waiting) == len(resolved) == 1
    assert (waiting[0]["tool"], waiting[0]["message"], waiting[0]["tool_call_id"], waiting[0]["session_id"]) == (
        "human_input:clarify", "May I delete the folder?", REQUEST, "sess-1")
    assert (resolved[0]["tool"], resolved[0]["message"], resolved[0]["tool_call_id"]) == ("human_input:clarify", "answered", REQUEST)
    assert all(r["command"] is None and r["rule_id"] is None and not r["task_id"] for r in waiting + resolved)


def test_nothing_the_person_typed_nor_the_session_key_nor_any_extra_key_reaches_a_row(tmp_path, monkeypatch):
    plugin, store, db = rig(tmp_path)
    session_env(monkeypatch)
    monkeypatch.setattr(plugin, "_redact", lambda text: text[:500])
    extras = dict(answer=SECRET, password=SECRET, choice=SECRET, response=SECRET, secret=SECRET, token=SECRET, questions=[SECRET])
    observe(plugin, "waiting", monkeypatch, **extras)
    observe(plugin, "resolved", monkeypatch, outcome="answered", **extras)
    text = repr(store.events(db, "p", 50))
    assert SECRET not in text and "agent:main:telegram:dm:9:7" not in text and "telegram:dm" not in text
    assert len(store.events(db, "p", 50)) == 2


@pytest.mark.parametrize("changes,kind,message", [
    (dict(kind="Sudo!"), "unknown", "May I delete the folder?"), (dict(kind="x" * 30), "unknown", "May I delete the folder?"),
    (dict(kind=None), "unknown", "May I delete the folder?"), (dict(kind="approval"), "approval", "May I delete the folder?"),
    (dict(prompt=None), "clarify", None), (dict(prompt=""), "clarify", None), (dict(prompt=["x"]), "clarify", None)])
def test_a_hostile_or_missing_field_is_dropped_not_stored(tmp_path, monkeypatch, changes, kind, message):
    plugin, store, db = rig(tmp_path)
    session_env(monkeypatch)
    monkeypatch.setattr(plugin, "_redact", lambda text: text[:500])
    observe(plugin, "waiting", monkeypatch, **changes)
    (row,) = rows(store, db, "waiting")
    assert (row["tool"], row["message"]) == (f"human_input:{kind}", message)


@pytest.mark.parametrize("request_id", [None, "", "short", "G" * 32, "0123456789ABCDEF0123456789ABCDEF", "a" * 33, 5])
def test_an_event_without_a_well_formed_request_id_is_dropped(tmp_path, monkeypatch, request_id):
    plugin, store, db = rig(tmp_path)
    session_env(monkeypatch)
    observe(plugin, "waiting", monkeypatch, request_id=request_id)
    assert not store.events(db, "p", 50)


def test_a_session_id_that_is_not_an_identifier_is_not_stored_and_the_outcome_is_a_word(tmp_path, monkeypatch):
    plugin, store, db = rig(tmp_path)
    session_env(monkeypatch)
    observe(plugin, "waiting", monkeypatch, session_id="agent:main:telegram:dm:9:7 and secret")
    observe(plugin, "resolved", monkeypatch, outcome="the person said hunter2")
    waiting, resolved = rows(store, db, "waiting")[0], rows(store, db, "resolved")[0]
    assert waiting["session_id"] == "" and resolved["message"] == "unknown"


def test_the_prompt_is_redacted_again_and_never_stored_when_there_is_no_redactor(tmp_path, monkeypatch):
    plugin, store, db = rig(tmp_path)
    session_env(monkeypatch)
    monkeypatch.setitem(sys.modules, "agent.redact", None)                    # no redactor even where Hermes is installed (its venv has one)
    observe(plugin, "waiting", monkeypatch, prompt=f"rm -rf {SECRET}")        # no `agent.redact` in this process
    assert rows(store, db, "waiting")[0]["message"] is None
    monkeypatch.setattr(plugin, "_redact", lambda text: text.replace(SECRET, "[REDACTED]")[:500])
    observe(plugin, "waiting", monkeypatch, request_id="f" * 32, prompt=f"rm -rf {SECRET} " + "x" * 600)
    stored = rows(store, db, "waiting")[0]["message"]
    assert SECRET not in stored and len(stored) <= 500 and stored.startswith("rm -rf [REDACTED]")


def test_another_profiles_turn_in_a_multiplexed_gateway_is_ignored(tmp_path, monkeypatch):
    plugin, store, db = rig(tmp_path)
    session_env(monkeypatch, profile="vendas")
    observe(plugin, "waiting", monkeypatch)
    assert not store.events(db, "p", 50)
    session_env(monkeypatch, profile="p")
    observe(plugin, "waiting", monkeypatch)
    session_env(monkeypatch, profile="")                                       # a single-profile process names none
    observe(plugin, "waiting", monkeypatch, request_id="e" * 32)
    assert len(store.events(db, "p", 50)) == 2


def test_a_failure_to_write_or_to_read_the_session_never_reaches_hermes(tmp_path, monkeypatch):
    plugin, store, db = rig(tmp_path)
    session_env(monkeypatch)
    monkeypatch.setattr(store, "record_event", locked)
    assert observe(plugin, "waiting", monkeypatch) is None
    monkeypatch.delitem(sys.modules, "gateway.session_context")                # not importable at all
    monkeypatch.delitem(sys.modules, "gateway")
    assert observe(plugin, "waiting", monkeypatch) is None


def test_the_observer_only_observes_it_imports_nothing_of_hermes_approval_code():
    """H-4: nothing in this bump answers a prompt or calls Hermes back."""
    text = rig.__globals__["PLUGIN"].read_text()
    tree = ast.parse(text)
    function = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "_human_input_observer")
    imported = {n.module for n in ast.walk(function) if isinstance(n, ast.ImportFrom)} | {a.name for n in ast.walk(function)
                                                                                         if isinstance(n, ast.Import) for a in n.names}
    assert imported == {"gateway.session_context", "luvebot_backend.hook_store"}
    called = {n.func.attr if isinstance(n.func, ast.Attribute) else getattr(n.func, "id", "") for n in ast.walk(function) if isinstance(n, ast.Call)}
    assert not {name for name in called if re.search(r"resolve|respond|approve|answer|submit|decide", name)}, called


class Ctx:
    """The plugin context Hermes gives `register`: `register_hook` raises for an event this Hermes does not have."""

    def __init__(self, known):
        self.profile_name, self.known, self.hooks = "p", known, {}

    def register_hook(self, event, function):
        if event not in self.known:
            raise ValueError(f"unknown hook {event}")
        self.hooks[event] = function


def test_register_adds_the_two_observers_and_a_hermes_without_them_loses_only_this(tmp_path, monkeypatch):
    plugin, _store, _db = rig(tmp_path)
    monkeypatch.setattr(plugin, "_backend", lambda: None)
    monkeypatch.setattr(plugin, "_preload", lambda: None)
    monkeypatch.setattr(plugin.threading, "Thread", lambda **kw: types.SimpleNamespace(start=lambda: None))
    monkeypatch.setitem(sys.modules, "hermes_constants", types.SimpleNamespace(get_hermes_home=lambda: tmp_path))
    every = {"pre_tool_call", "pre_approval_request", "post_approval_response", "on_human_input_request", "on_human_input_resolved"}
    plugin._beating.discard("p")
    full = Ctx(every)
    plugin.register(full)
    assert set(full.hooks) == every
    plugin._beating.discard("p")
    older = Ctx({"pre_tool_call", "pre_approval_request", "post_approval_response"})
    plugin.register(older)                                                     # no exception, the rest registered
    assert set(older.hooks) == {"pre_tool_call", "pre_approval_request", "post_approval_response"}
    plugin._beating.discard("p")


def test_the_hook_is_0_8_0_and_keeps_the_0_5_0_rows():
    """0.6.0 (step 22a, test_hook_0_6.py) added the path facts and the 21a detail, 0.7.0 (step 22b, test_hook_0_7.py) the recipient facts, 0.8.0 (test_hook_0_8.py) the call in the approval message; every 0.5.0 row above is unchanged."""
    assert re.search(r'^PLUGIN_VERSION = "0\.8\.7"$', rig.__globals__["PLUGIN"].read_text(), re.M)


# ---- mutations ---------------------------------------------------------------------------------------------------------------
def scenario(plugin, store, db, monkeypatch):
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    monkeypatch.setattr(plugin, "_redact", lambda text: text[:500])
    session_env(monkeypatch, profile="vendas")
    observe(plugin, "waiting", monkeypatch, **dict(session_key="SK-LEAK"))        # another profile: no row
    assert not store.events(db, "p", 50), "another profile's event was stored"
    session_env(monkeypatch)
    observe(plugin, "waiting", monkeypatch, answer=SECRET, request_id="d" * 32)
    observe(plugin, "waiting", monkeypatch, request_id="not-hex")
    observe(plugin, "resolved", monkeypatch, outcome="answered", request_id="d" * 32, answer=SECRET)
    text = repr(store.events(db, "p", 50))
    assert SECRET not in text and "SK-LEAK" not in text and "agent:main:telegram" not in text, "something that must not be stored was"
    assert len(rows(store, db, "waiting")) == 1 and len(rows(store, db, "resolved")) == 1, "a malformed id was stored or a row is missing"
    monkeypatch.setattr(plugin, "_redact", lambda text: None)
    observe(plugin, "waiting", monkeypatch, request_id="c" * 32, prompt=f"secret {SECRET}")
    assert SECRET not in repr(store.events(db, "p", 50)), "an unredacted prompt was stored"
    call = plugin._make_hook("p")
    free(store, db)
    assert answers(call, ASKED) == dict.fromkeys(ASKED)
    got = rows(store, db, "free_pass")
    assert len(got) == len(ASKED), "free_pass rows missing or with the wrong verdict"
    fake_kanban(monkeypatch, "guarded")
    answers(call, ASKED)
    assert len(rows(store, db, "free_pass")) == len(ASKED), "a call the origin still asks about was written as a pass"
    store.put_surface(db, "p", "luvebot", [], "basic:ceo")
    monkeypatch.delenv("HERMES_KANBAN_TASK")
    answers(call, ASKED)
    assert len(rows(store, db, "free_pass")) == len(ASKED), "a Bot that is not free wrote a pass"
    free(store, db)
    monkeypatch.setattr(store, "record_event", locked)
    assert answers(call, ASKED) == dict.fromkeys(ASKED), "a failed write changed the answer"


def test_the_scenario_holds_on_the_real_plugin(tmp_path, monkeypatch):
    scenario(*rig(tmp_path), monkeypatch)


MUTATIONS = [
    ("free_pass has the verdict approve", '"free_pass", silenced.message', '"approve", silenced.message'),
    ("free_pass is written even when the origin asks", "            if verdict.action == \"none\":\n                if silenced is not None:",
     "            if True:\n                if silenced is not None:"),
    ("the write of free_pass is not guarded", '_record(store, profile, str(tool_name)[:128], silenced.rule_id, "free_pass"',
     'store.record_event(_db(), profile, str(tool_name)[:128], silenced.rule_id, "free_pass"'),
    ("another profile's event is stored", '''if _norm(get_session_env("HERMES_SESSION_PROFILE", "")) not in ("", _norm(profile)):
                return None  # another profile's turn in a multiplexed gateway''', '''if False:
                return None  # another profile's turn in a multiplexed gateway'''),
    ("the request id is not checked", 'if not isinstance(request, str) or not _REQUEST.fullmatch(request):', "if False:"),
    ("the session key is stored", 'session = kwargs.get("session_id")', 'session = kwargs.get("session_key")'),
    ("the prompt is stored unredacted", 'message = _redact(prompt) if isinstance(prompt, str) and prompt else None',
     'message = prompt[:500] if isinstance(prompt, str) and prompt else None'),
    ("the typed answer is stored", 'message = outcome if isinstance(outcome, str) and _KIND.fullmatch(outcome) else "unknown"',
     'message = kwargs.get("answer") or outcome'),
]


@pytest.mark.parametrize("label,old,new", MUTATIONS, ids=[m[0] for m in MUTATIONS])
def test_the_mutations_are_caught(tmp_path, monkeypatch, label, old, new):
    rigged = rig(tmp_path, edit=(old, new))      # outside `raises`: a mutation anchor that no longer matches must fail the test
    with pytest.raises(AssertionError) as red:
        scenario(*rigged, monkeypatch)
    print(f"{label}: RED: {str(red.value).splitlines()[0][:100]}")
