"""Hook 0.7.0, step 22b (docs/contracts/rules-conditions-v0.md section 10; engine interface rules-conditions-engine-v0.md section 7): the hook extracts
the `recipient` fact for the two tools a model can call that name one, and passes `facts` as a dict `{"path": [...], "recipient": [...]}`.

* `kanban_create`: the assignee as `bot:<profile>`, by the profile's REAL name in Hermes's own list; not a profile, or a list that cannot be read, is `unresolved`;
* `cronjob_manage` on `create` and `update`: the tags of `deliver` and `failure_deliver`, each a comma-list, by a LEXICAL parse of the grammar the tool
  documents ('local', 'all', 'origin', 'bot-chat:<profile>', 'platform:chat_id[:thread]'): no Hermes resolver, no plugin discovery; anything else, a bare
  `bot-chat`, a channel name, an update that keeps the old target, `list`/`run`/`pause`/..., is `unresolved`;
* `send_message` is NOT an adapter (Hermes does not register it as a model tool: tools/send_message_tool.py:28, toolsets.py:189 in v0.22.5);
* only the facts a table entry asks about are built: a Bot with no recipient rule never reads the profile list; the tag is never folded.
Real hook, real engine and SQLite; Hermes's profile list is faked. Mutations: one line of the source changed -> red. Until the harness runs: `unproven`."""
import importlib.util
import sys
import types

import pytest

from test_hook_free_mode import IDS, REPO, action, rig

RECIPIENTS = REPO / "backend" / "recipients.py"
PROFILES = ["default", "vendas", "suporte"]


def load_recipients(edits=()):
    source = RECIPIENTS.read_text()
    for old, new in edits:
        assert source.count(old) == 1, old
        source = source.replace(old, new)
    spec = importlib.util.spec_from_loader("luvebot_backend.recipients_under_test", loader=None)
    module = importlib.util.module_from_spec(spec)
    module.__package__ = "luvebot_backend"
    exec(compile(source, str(RECIPIENTS), "exec"), module.__dict__)
    return module


R = load_recipients()


def tags(tool, **args):
    return R.recipient_facts(tool, args, lambda: PROFILES)


# ---- the grammar of `deliver`, read lexically -------------------------------------------------------------------------------------
@pytest.mark.parametrize("value,expected", [
    ("local", ["local"]), ("all", ["all"]), ("origin", ["origin"]), ("Origin", ["origin"]), ("ORIGIN", ["origin"]),
    ("origin,all", ["origin", "all"]), (" local , all ", ["local", "all"]), ("local,local", ["local"]),
    ("telegram:-1001234567890:17585", ["chat:telegram:-1001234567890"]),                  # the thread is dropped
    ("telegram:123", ["chat:telegram:123"]), ("discord:99:5", ["chat:discord:99"]),
    ("bot-chat:vendas", ["bot:vendas"]), ("bot-chat: vendas ", ["bot:vendas"]), ("bot-chat:Vendas", ["bot:Vendas"]),     # kept as written: the engine folds
    ("bot-chat", ["unresolved"]), ("bot-chat:", ["unresolved"]), ("bot-chat:ven das", ["unresolved"]), ("bot-chat:-x", ["unresolved"]),
    ("#geral", ["unresolved"]), ("telegram:#geral", ["unresolved"]), ("unknownplat:abc", ["unresolved"]), ("telegram:abc", ["unresolved"]),
    ("Telegram:123", ["unresolved"]), ("local:123", ["unresolved"]), ("all:5", ["unresolved"]), ("origin:5", ["unresolved"]),
    ("telegram:1:2:3", ["unresolved"]), ("telegram:1:", ["unresolved"]), (":123", ["unresolved"]), ("telegram:", ["unresolved"]),
    ("x" * 33 + ":1", ["unresolved"]), ("telegram:" + "9" * 21, ["unresolved"]), ("telegram:١٢٣", ["unresolved"]),             # a non-ASCII digit is not an id
    ("local,#geral", ["local", "unresolved"]), ("telegram:111,telegram:222", ["chat:telegram:111", "chat:telegram:222"]),
    (",", ["unresolved"]), ("   ", ["unresolved"]), ("LOCAL", ["unresolved"]), ("Local", ["unresolved"]),
    (["telegram:1", "local"], ["chat:telegram:1", "local"]), ([], ["unresolved"]), ([""], ["unresolved"]), (["local", 5], ["unresolved"]),
    (5, ["unresolved"]), ({"a": 1}, ["unresolved"]), (None, ["unresolved"]),
])
def test_the_documented_grammar_gives_these_tags_and_anything_else_is_unresolved(value, expected):
    assert R.deliver_tags(value) == expected


# ---- cronjob_manage ------------------------------------------------------------------------------------------------------------------
def test_create_without_deliver_posts_to_the_chat_it_was_made_from():
    assert tags("cronjob_manage", action="create", prompt="x", schedule="1h") == ["origin"]
    assert tags("cronjob_manage", action="create", deliver="") == ["origin"]
    assert tags("cronjob_manage", action="create", deliver="local") == ["local"]
    assert tags("cronjob_manage", action=" CREATE ", deliver="all") == ["all"]


def test_a_failure_target_adds_its_own_tags_and_an_omitted_or_cleared_one_adds_none():
    assert tags("cronjob_manage", action="create", failure_deliver="telegram:9") == ["origin", "chat:telegram:9"]
    assert tags("cronjob_manage", action="create", deliver="local", failure_deliver="") == ["local"]
    assert tags("cronjob_manage", action="create", deliver="local", failure_deliver="local") == ["local"]
    assert tags("cronjob_manage", action="update", deliver="local", failure_deliver="") == ["local"]            # '' clears it: nothing new is posted
    assert tags("cronjob_manage", action="update", deliver="all", failure_deliver="telegram:9") == ["all", "chat:telegram:9"]


def test_an_update_that_keeps_the_old_target_is_unresolved_because_the_hook_cannot_know_it():
    assert tags("cronjob_manage", action="update", job_id="j") == ["unresolved"]
    assert tags("cronjob_manage", action="update", deliver="") == ["unresolved"]
    assert tags("cronjob_manage", action="update", failure_deliver="telegram:9") == ["unresolved", "chat:telegram:9"]


@pytest.mark.parametrize("action", ["list", "pause", "resume", "remove", "run", "frobnicate", "", None, 5, ["create"]])
def test_the_other_actions_name_no_recipient_so_a_rule_on_this_tool_asks(action):
    assert tags("cronjob_manage", action=action, deliver="local") == ["unresolved"]
    assert R.recipient_facts("cronjob_manage", {}, lambda: PROFILES) == ["unresolved"]


# ---- kanban_create ---------------------------------------------------------------------------------------------------------------------
def test_the_assignee_is_a_bot_by_the_real_name_of_the_profile():
    assert tags("kanban_create", assignee="vendas") == ["bot:vendas"]
    assert tags("kanban_create", assignee="  suporte ") == ["bot:suporte"]
    assert tags("kanban_create", assignee="Vendas") == ["bot:vendas"]                  # Hermes lowercases profile ids: the name that is listed
    for assignee in ("ceo", "", "   ", None, 5, ["vendas"], "vendas/../x", "default2"):
        assert tags("kanban_create", assignee=assignee) == ["unresolved"], assignee
    assert tags("kanban_create") == ["unresolved"]


def test_a_profile_list_that_cannot_be_read_is_unresolved():
    def broken():
        raise RuntimeError("no list")
    assert R.recipient_facts("kanban_create", {"assignee": "vendas"}, broken) == ["unresolved"]
    assert R.recipient_facts("kanban_create", {"assignee": "vendas"}, lambda: None) == ["unresolved"]
    assert R.recipient_facts("kanban_create", {"assignee": "vendas"}, lambda: [5, None, "vendas"]) == ["bot:vendas"]


def test_other_tools_have_no_adapter_and_send_message_is_not_one():
    for tool in ("send_message", "terminal", "write_file", "patch", "read_file", "kanban_list", "cronjob", "mcp_mail_send"):
        assert R.recipient_facts(tool, {"assignee": "vendas", "deliver": "local", "action": "create"}, lambda: PROFILES) is None, tool
    assert R.recipient_facts("kanban_create", None, lambda: PROFILES) == ["unresolved"]       # args that are not a dict read as nothing


def test_the_adapter_tools_are_the_engines():
    import backend.rules as rules
    assert set(R.ADAPTER_TOOLS) == {tool for tool, facts in rules.ADAPTERS.items() if "recipient" in facts}
    assert "from .rules" not in RECIPIENTS.read_text() and "import rules" not in RECIPIENTS.read_text()    # pure: no engine, no Hermes


# ---- the hook ----------------------------------------------------------------------------------------------------------------------------
def rule(R_, id, tool, tag, level=None, extra=()):
    return R_.Rule(id=id, label=id, level=level or R_.Level.ASK, scope=R_.Scope(R_.ScopeKind.GLOBAL),
                   match=R_.Match(tools=(tool,), toolsets=(), mcp_servers=(), commands=(), conditions=(("recipient:eq", tag), *extra)),
                   state=R_.RuleState.ACTIVE, origin=R_.Origin.HUMAN)


EDIT = {"plugin": None}


def setup(tmp_path, monkeypatch, *, rules=True):
    """-> call(tool, args) -> the hook's verdict action, store, db, plugin, spy. Bot `p` asks about a handoff to `vendas` and about a job posting to chat 111."""
    plugin, store, db = rig(tmp_path, EDIT["plugin"])
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    import luvebot_backend.rules as Rr
    if rules:
        store.put_table(db, "p", Rr.compile_hook_table(
            [*Rr.builtin_rules(), rule(Rr, "r_vendas", "kanban_create", "bot:vendas"), rule(Rr, "r_chat", "cronjob_manage", "chat:telegram:111")],
            version=1, toolset_tools={}, mcp_server_tools={}))
    spy = {"profiles": 0, "facts": []}
    profiles = types.ModuleType("hermes_cli.profiles")

    def list_profile_names():
        spy["profiles"] += 1
        return list(PROFILES)
    profiles.list_profile_names = list_profile_names
    hermes = types.ModuleType("hermes_cli")
    hermes.profiles = profiles
    monkeypatch.setitem(sys.modules, "hermes_cli", hermes)
    monkeypatch.setitem(sys.modules, "hermes_cli.profiles", profiles)
    real = Rr.hook_verdict
    monkeypatch.setattr(Rr, "hook_verdict", lambda table, **kw: spy["facts"].append(kw.get("facts")) or real(table, **kw))
    hook = plugin._make_hook("p")
    return (lambda tool, **args: action(hook(tool, args, **IDS))), store, db, plugin, spy


def test_a_handoff_to_the_named_bot_asks_and_to_another_does_not(tmp_path, monkeypatch):
    call, *_ = setup(tmp_path, monkeypatch)
    assert call("kanban_create", title="t", assignee="vendas") == "approve"
    assert call("kanban_create", title="t", assignee="Vendas") == "approve"             # the real name, whatever the case the model used
    assert call("kanban_create", title="t", assignee="suporte") is None
    assert call("kanban_create", title="t", assignee="ceo") == "approve"                # not a profile: unresolved, which asks
    assert call("kanban_create", title="t") == "approve"                                # no assignee: unresolved


def test_a_job_that_posts_where_a_rule_names_asks_and_one_that_posts_elsewhere_does_not(tmp_path, monkeypatch):
    call, *_ = setup(tmp_path, monkeypatch)
    assert call("cronjob_manage", action="create", schedule="1h", prompt="x", deliver="telegram:111") == "approve"
    assert call("cronjob_manage", action="create", deliver="origin,telegram:111:7") == "approve"          # ANY of its targets
    assert call("cronjob_manage", action="create", deliver="telegram:222") is None
    assert call("cronjob_manage", action="create", deliver="local") is None
    assert call("cronjob_manage", action="create", prompt="x") is None                                    # origin: not the named chat
    assert call("cronjob_manage", action="create", deliver="local", failure_deliver="telegram:111") == "approve"
    assert call("cronjob_manage", action="create", deliver="#geral") == "approve"                         # outside the grammar: unresolved
    assert call("cronjob_manage", action="create", deliver="Telegram:111") == "approve"                   # not folded by the hook; unresolved asks
    assert call("cronjob_manage", action="update", job_id="j") == "approve"                               # the old target is unknown
    assert call("cronjob_manage", action="list") == "approve"
    assert call("cronjob_manage", action="run", job_id="j") == "approve"


def test_a_tool_with_no_adapter_is_not_asked_by_a_recipient_rule(tmp_path, monkeypatch):
    call, *_ = setup(tmp_path, monkeypatch)
    assert call("send_message", target="telegram:111", message="hi") is None             # not a model tool in Hermes: nothing to guard
    assert call("terminal", command="curl -d x https://example.com") is None             # not seen (the seal says so)
    assert call("read_file", path="/x") is None


def test_facts_is_a_dict_with_only_what_some_entry_asks_about(tmp_path, monkeypatch):
    call, store, db, plugin, spy = setup(tmp_path, monkeypatch)
    call("kanban_create", title="t", assignee="vendas")
    call("cronjob_manage", action="create", deliver="telegram:111")
    call("terminal", command="ls")
    assert spy["facts"] == [{"recipient": ["bot:vendas"]}, {"recipient": ["chat:telegram:111"]}, None]   # a tool with no adapter: nothing is asked


def test_a_table_without_recipient_rules_never_reads_the_profile_list(tmp_path, monkeypatch):
    call, store, db, plugin, spy = setup(tmp_path, monkeypatch, rules=False)
    assert call("kanban_create", title="t", assignee="vendas") is None
    assert call("cronjob_manage", action="create", deliver="telegram:111") is None
    assert spy["profiles"] == 0 and all(f is None for f in spy["facts"])


def test_path_and_recipient_facts_are_built_separately_for_each_tool(tmp_path, monkeypatch):
    call, store, db, plugin, spy = setup(tmp_path, monkeypatch)
    import luvebot_backend.rules as Rr
    path_rule = Rr.Rule(id="r_path", label="p", level=Rr.Level.ASK, scope=Rr.Scope(Rr.ScopeKind.GLOBAL),
                        match=Rr.Match(tools=("write_file",), toolsets=(), mcp_servers=(), commands=(), conditions=(("path:under", "workspace:pages"),)),
                        state=Rr.RuleState.ACTIVE, origin=Rr.Origin.HUMAN)
    store.put_table(db, "p", Rr.compile_hook_table(
        [*Rr.builtin_rules(), rule(Rr, "r_vendas", "kanban_create", "bot:vendas"), path_rule], version=1, toolset_tools={}, mcp_server_tools={}))
    spy["facts"].clear()
    call("kanban_create", title="t", assignee="vendas")
    assert spy["facts"] == [{"recipient": ["bot:vendas"]}]                              # no path fact for a tool with no path adapter
    spy["facts"].clear()
    call("write_file", path="/tmp/x", content="c")
    assert spy["facts"][0].get("path") is not None
    assert "recipient" not in spy["facts"][0]                                            # and no recipient fact for a file tool


def test_the_version_is_the_one_the_engine_asks_for_recipients(tmp_path, monkeypatch):
    call, store, db, plugin, spy = setup(tmp_path, monkeypatch)
    import luvebot_backend.rules as Rr
    assert plugin.PLUGIN_VERSION == "0.8.7" and tuple(map(int, plugin.PLUGIN_VERSION.split("."))) >= Rr.FACTS_VERSION["recipient"]   # 0.8.0 keeps what 0.7.0 does
    assert "luvebot_backend.recipients" in plugin._PRELOAD


# ---- mutations ---------------------------------------------------------------------------------------------------------------------------
def mutant(edits):
    global R
    R = load_recipients(edits)


MUTATIONS = {
    "the assignee is used as written": (
        [("    real = next((name for name in names if name.lower() == assignee.strip().lower()), None)   # Hermes lowercases profile ids",
          "    real = assignee.strip()")], test_the_assignee_is_a_bot_by_the_real_name_of_the_profile),
    "an update without deliver reads as origin": (
        [("        tags = [UNRESOLVED] if _blank(deliver) else deliver_tags(deliver)  # an update", "        tags = ['origin'] if _blank(deliver) else deliver_tags(deliver)  # an update")],
        test_an_update_that_keeps_the_old_target_is_unresolved_because_the_hook_cannot_know_it),
    "a bare bot-chat is a bot": (
        [("    return UNRESOLVED                                    # a bare `bot-chat`, a channel name", "    return 'bot:self' if token == 'bot-chat' else UNRESOLVED   # a bare `bot-chat`, a channel name")],
        test_the_documented_grammar_gives_these_tags_and_anything_else_is_unresolved),
    "the thread is kept": (
        [('        return f"chat:{parts[0]}:{parts[1]}"            # the thread is dropped: a rule on a chat covers every thread of it',
          '        return ":".join(["chat", *parts])')], test_the_documented_grammar_gives_these_tags_and_anything_else_is_unresolved),
    "the platform is lower-cased": (
        [('    token = raw.strip()\n', '    token = raw.strip()\n    token = token.split(":", 1)[0].lower() + (":" + token.split(":", 1)[1] if ":" in token else "")\n')],
        test_the_documented_grammar_gives_these_tags_and_anything_else_is_unresolved),
    "send_message is an adapter": (
        [('ADAPTER_TOOLS = ("kanban_create", "cronjob_manage")', 'ADAPTER_TOOLS = ("kanban_create", "cronjob_manage", "send_message")')],
        test_other_tools_have_no_adapter_and_send_message_is_not_one),
    "list and run name a recipient": (
        [('        return [UNRESOLVED]                              # list, pause, resume, remove, run: no new recipient. A rule on this tool asks (noisy, safe)',
          '        return []')], test_the_other_actions_name_no_recipient_so_a_rule_on_this_tool_asks),
    "a cleared failure target is read as unresolved": (
        [("    if not _blank(failure):", "    if failure is not None:")], test_a_failure_target_adds_its_own_tags_and_an_omitted_or_cleared_one_adds_none),
}


@pytest.mark.parametrize("label", sorted(MUTATIONS))
def test_each_recipients_mutation_turns_its_test_red(label):
    global R
    edits, check = MUTATIONS[label]
    saved = R
    try:
        mutant(edits)
        with pytest.raises(AssertionError):
            _run_parametrized(check)
    finally:
        R = saved


def _run_parametrized(check):
    """A parametrized check, run over every one of its cases against the mutated module."""
    marks = [m for m in getattr(check, "pytestmark", []) if m.name == "parametrize"]
    if not marks:
        return check()
    names, cases = marks[0].args[0], marks[0].args[1]
    single = "," not in names
    for case in cases:
        check(case) if single else check(*case)


PLUGIN_MUTATIONS = {
    "recipient facts are never passed": ([('            facts["recipient"] = cache["recipient"]', '            pass')], test_a_handoff_to_the_named_bot_asks_and_to_another_does_not),
    "the profile list is read even with no recipient rule": (
        [('    if any(getattr(entry, "recipients", ()) for entry in entries):\n', '    if True:\n')], test_a_table_without_recipient_rules_never_reads_the_profile_list),
    "the version stays 0.6.0": ([('PLUGIN_VERSION = "0.8.7"', 'PLUGIN_VERSION = "0.6.0"')], test_the_version_is_the_one_the_engine_asks_for_recipients),
}


@pytest.mark.parametrize("label", sorted(PLUGIN_MUTATIONS))
def test_each_plugin_mutation_turns_its_test_red(label, tmp_path, monkeypatch):
    edit, check = PLUGIN_MUTATIONS[label]
    monkeypatch.setitem(EDIT, "plugin", edit[0])
    with pytest.raises(AssertionError):
        check(tmp_path, monkeypatch)
