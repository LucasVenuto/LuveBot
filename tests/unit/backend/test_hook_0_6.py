"""Hook 0.6.0, step 22a (docs/contracts/rules-conditions-v0.md sections 2, 3 and 6; engine interface rules-conditions-engine-v0.md): the hook
extracts ONE path tag per file a `write_file` or `patch` call touches and passes them as `facts` to `rules.hook_verdict`.

What is real here: the plugin as a gateway loads it, the engine, the table in SQLite, and the file system (a real workspace with a real
`pages/`, symlinks and `..`, resolved by `Path.resolve()` exactly as Hermes's host branch does, tools/file_tools_paths.py `_anchor`).
What is faked: `tools.file_tools_paths` (the same three names and signatures in the baseline, v0.22.2, v0.22.5 and main), `tools.patch_parser`
(its four header patterns, `_OP_MARKERS`, copied from Hermes v0.22.5 tools/patch_parser.py:51-55) and `hermes_cli.config.load_config`.
Until the harness runs these against a real Hermes the feature is `unproven` (ADR-007).

Pinned:
* the tag is exactly what the resolver gave (no fold, no normalization) and a call is judged on ALL the files it touches;
* a relative path after a `cd`, `~`, a `..` that leaves `pages/`, a symlink into `pages/` and one out of it, are what the file system says;
* a V4A patch: every header path, a Delete/Move named by its directory ENTRY (a symlink is the link, not its target), both ends of a Move;
* anything it cannot say is `unresolved` and a restrictive rule matches it: a malformed patch, a sandbox backend, a missing path, a resolver
  that is not there, a config that cannot be read;
* a table with no path rule never calls the resolver; `terminal` writing into `pages/` is NOT stopped (the documented limit);
* a handoff origin's table gets the same facts; the version is 0.6.0, the one the engine's seal asks for.
Mutations: the plugin or workspace source with one line changed -> red."""
import contextlib
import importlib.util
import json
import os
import re
import sys
import types
from pathlib import Path, PurePosixPath

import pytest

from test_hook_free_mode import IDS, REPO, action, fake_kanban, rig

PLUGIN = REPO / "hermes-plugin" / "__init__.py"
WORKSPACE = REPO / "backend" / "workspace.py"
HEADERS = [(kind, re.compile(rx)) for kind, rx in (
    ("update", r"\*\*\*\s*Update\s+File:\s*(.+)"), ("add", r"\*\*\*\s*Add\s+File:\s*(.+)"), ("delete", r"\*\*\*\s*Delete\s+File:\s*(.+)"),
    ("move", r"\*\*\*\s*Move\s+File:\s*(.+?)\s*->\s*(.+)"))]


class World:
    """A workspace on disk and the Hermes modules over it. `cwd` is the task's session cwd (what a `cd` changes)."""

    def __init__(self, tmp_path, monkeypatch):
        self.root = (tmp_path / "workspace").resolve()
        for folder in ("pages/sub", "outside"):
            (self.root / folder).mkdir(parents=True)
        (self.root / "shortcut").symlink_to(self.root / "pages")            # a link INTO pages/
        (self.root / "pages" / "escape").symlink_to(self.root / "outside")  # a link OUT of pages/
        self.cwd, self.container, self.calls, self.config = self.root, None, [], {"terminal": {"cwd": str(self.root)}}
        monkeypatch.setenv("HOME", str(self.root))
        self._install(monkeypatch)

    def _install(self, monkeypatch):
        world = self

        def resolve(text, task_id="default"):
            world.calls.append(("resolve", text, task_id))
            if world.container:                                              # a sandbox: a pure path, never the host's
                return PurePosixPath(os.path.normpath(os.path.join("/workspace", text)))
            path = Path(os.path.expanduser(text))
            return (path if path.is_absolute() else world.cwd / path).resolve()

        def entry(text, task_id="default"):
            world.calls.append(("entry", text, task_id))
            parent, name = os.path.split(text)
            if name in ("", ".", ".."):
                return resolve(text, task_id)
            return resolve(parent or ".", task_id) / name                    # the last component stays, even a symlink

        def parse(text):
            ops, started = [], False
            for line in text.split("\n"):
                if re.fullmatch(r"\*\*\*\s*Begin\s+Patch\s*", line):
                    started = True
                elif re.fullmatch(r"\*\*\*\s*End\s+Patch\s*", line):
                    break
                for kind, rx in HEADERS:
                    m = rx.match(line)
                    if m:
                        ops.append(types.SimpleNamespace(operation=types.SimpleNamespace(value=kind), file_path=m.group(1).strip(),
                                                         new_path=m.group(2).strip() if kind == "move" else None, hunks=[1]))
                        break
            if "no hunks" in text:
                return [], "Parse error: no hunks"
            return ops, None

        files = types.ModuleType("tools.file_tools_paths")
        files._resolve_path_for_task, files._resolve_entry_for_task = resolve, entry
        files.container_backend_for_task = lambda task_id="default": world.container
        patcher = types.ModuleType("tools.patch_parser")
        patcher.parse_v4a_patch = parse
        config = types.ModuleType("hermes_cli.config")

        def load_config():
            if isinstance(world.config, Exception):
                raise world.config
            return world.config
        config.load_config = load_config
        for name, module in (("tools", types.ModuleType("tools")), ("tools.file_tools_paths", files), ("tools.patch_parser", patcher),
                             ("hermes_cli", types.ModuleType("hermes_cli")), ("hermes_cli.config", config)):
            monkeypatch.setitem(sys.modules, name, module)


def path_rule(R, id="r_pages", under="workspace:pages", level=None):
    return R.Rule(id=id, label=id, level=level or R.Level.ASK, scope=R.Scope(R.ScopeKind.GLOBAL),
                  match=R.Match(tools=("write_file", "patch"), toolsets=(), mcp_servers=(), commands=(), conditions=(("path:under", under),)),
                  state=R.RuleState.ACTIVE, origin=R.Origin.HUMAN)


EDIT = {"plugin": None}   # a mutation of the plugin source, set by the mutation tests


def setup(tmp_path, monkeypatch, *, edit=None, rules=True):
    """-> world, call(tool, args, task='t') -> the hook's answer, plugin, store, db. The Bot `p` has an ask rule on `workspace:pages`."""
    world = World(tmp_path, monkeypatch)
    plugin, store, db = rig(tmp_path, edit or EDIT["plugin"])
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    import luvebot_backend.hook as backend_hook
    import luvebot_backend.rules as R
    if rules:
        store.put_table(db, "p", R.compile_hook_table([*R.builtin_rules(), path_rule(R)], version=1, toolset_tools={}, mcp_server_tools={}))
    hook = plugin._make_hook("p")
    return world, (lambda tool, args, **ids: hook(tool, args, **{**IDS, **ids})), plugin, store, db


def verdict(call, tool="write_file", **args):
    return action(call(tool, args))


def v4a(*lines):
    return "*** Begin Patch\n" + "\n".join(lines) + "\n*** End Patch"


# ---- what is stopped, and what is not ------------------------------------------------------------------------------------------
def test_a_write_into_pages_asks_and_one_outside_does_not(tmp_path, monkeypatch):
    world, call, *_ = setup(tmp_path, monkeypatch)
    assert verdict(call, path=str(world.root / "pages" / "a.md"), content="x") == "approve"
    assert verdict(call, path=str(world.root / "outside" / "a.md"), content="x") is None
    assert verdict(call, path="/tmp/elsewhere/a.md", content="x") is None
    assert verdict(call, "read_file", path=str(world.root / "pages" / "a.md")) is None                       # no adapter: the rule names only write tools


def test_a_relative_path_follows_the_tasks_cwd_after_a_cd(tmp_path, monkeypatch):
    world, call, *_ = setup(tmp_path, monkeypatch)
    assert verdict(call, path="a.md", content="x") is None                                    # cwd = the workspace root: not in pages/
    world.cwd = world.root / "pages" / "sub"                                                  # the Bot did `cd pages/sub`
    assert verdict(call, path="a.md", content="x") == "approve"
    assert verdict(call, path="../../outside/a.md", content="x") is None                      # and `..` leaves it again


def test_tilde_and_a_dotdot_that_leaves_pages_are_what_the_file_system_says(tmp_path, monkeypatch):
    world, call, *_ = setup(tmp_path, monkeypatch)
    assert verdict(call, path="~/pages/a.md", content="x") == "approve"
    assert verdict(call, path="pages/../outside/a.md", content="x") is None                  # looks like pages/, lands outside
    assert verdict(call, path="outside/../pages/a.md", content="x") == "approve"             # looks outside, lands in pages/


def test_a_symlink_into_pages_asks_and_one_out_of_it_does_not(tmp_path, monkeypatch):
    world, call, *_ = setup(tmp_path, monkeypatch)
    assert verdict(call, path="shortcut/a.md", content="x") == "approve"                      # the link resolves to pages/
    assert verdict(call, path="pages/escape/a.md", content="x") is None                       # the file lands in outside/


def test_the_tag_is_exactly_what_the_resolver_gave(tmp_path, monkeypatch):
    world, call, plugin, store, db = setup(tmp_path, monkeypatch)
    import luvebot_backend.rules as R
    seen, real = [], R.hook_verdict
    monkeypatch.setattr(R, "hook_verdict", lambda table, **kw: seen.append(kw.get("facts")) or real(table, **kw))
    call("write_file", {"path": str(world.root / "pages" / "Mixed-Case.MD"), "content": "x"})
    assert seen[-1] == {"path": ["workspace:pages/Mixed-Case.MD"]}                             # not folded (0.7.0: `facts` is a dict by fact)
    call("write_file", {"path": "pages/Ünï cod é.md", "content": "x"})
    assert seen[-1] == {"path": ["workspace:pages/Ünï cod é.md"]}


# ---- V4A patches ---------------------------------------------------------------------------------------------------------------
def test_a_patch_is_judged_on_every_file_it_names(tmp_path, monkeypatch):
    world, call, *_ = setup(tmp_path, monkeypatch)
    two = v4a("*** Update File: outside/x.md", "@@", "-a", "+b", "*** Add File: pages/y.md", "+hello")
    assert verdict(call, "patch", mode="patch", patch=two) == "approve"                      # one of the two is in pages/
    only_out = v4a("*** Update File: outside/x.md", "@@", "-a", "+b", "*** Add File: outside/z.md", "+hello")
    assert verdict(call, "patch", mode="patch", patch=only_out) is None
    assert verdict(call, "patch", path=str(world.root / "pages" / "a.md"), old_string="a", new_string="b") == "approve"   # replace mode: its `path`
    assert verdict(call, "patch", mode="replace", path=str(world.root / "outside" / "a.md"), old_string="a", new_string="b") is None


def test_a_delete_names_the_entry_and_a_move_names_both_ends(tmp_path, monkeypatch):
    world, call, *_ = setup(tmp_path, monkeypatch)
    # pages/escape is a link to outside/: deleting it removes the LINK, which is in pages/ (resolving it would aim at outside/)
    assert verdict(call, "patch", mode="patch", patch=v4a("*** Delete File: pages/escape")) == "approve"
    assert verdict(call, "patch", mode="patch", patch=v4a("*** Delete File: outside/gone.md")) is None
    assert verdict(call, "patch", mode="patch", patch=v4a("*** Move File: outside/a.md -> pages/b.md")) == "approve"    # the destination
    assert verdict(call, "patch", mode="patch", patch=v4a("*** Move File: pages/a.md -> outside/b.md")) == "approve"    # the source
    assert verdict(call, "patch", mode="patch", patch=v4a("*** Move File: outside/a.md -> outside/b.md")) is None


def test_a_patch_that_does_not_parse_or_has_no_header_is_unresolved_so_it_asks(tmp_path, monkeypatch):
    world, call, *_ = setup(tmp_path, monkeypatch)
    assert verdict(call, "patch", mode="patch", patch="just some text, no header") == "approve"
    assert verdict(call, "patch", mode="patch", patch=v4a("*** Update File: outside/x.md", "no hunks")) == "approve"
    assert verdict(call, "patch", mode="patch", patch="") == "approve"
    assert verdict(call, "patch", mode="patch") == "approve"
    assert verdict(call, "patch", mode="patch", patch=["*** Add File: outside/a"]) == "approve"


# ---- what it cannot say --------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("args", [{}, {"path": None}, {"path": 5}, {"path": ""}, {"path": "   "}, {"path": ["a"]}, {"content": "x"}])
def test_a_missing_or_non_string_path_is_unresolved_so_it_asks(tmp_path, monkeypatch, args):
    world, call, *_ = setup(tmp_path, monkeypatch)
    assert verdict(call, "write_file", **args) == "approve"


def test_a_sandbox_backend_is_unresolved_so_it_asks(tmp_path, monkeypatch):
    world, call, *_ = setup(tmp_path, monkeypatch)
    assert verdict(call, path=str(world.root / "outside" / "a.md"), content="x") is None
    world.container, world.calls[:] = "docker", []                                           # its paths belong to a container
    assert verdict(call, path="outside/a.md", content="x") == "approve"                      # we cannot say where it lands: asked, not guessed
    assert world.calls == []                                                                 # and Hermes's resolver is not even asked
    assert workspace_tag(PurePosixPath("/workspace/outside/a.md")) == "unresolved"           # a second wall: a sandbox path is never a host path


def workspace_tag(resolved):
    from luvebot_backend import workspace
    return workspace.path_tag(resolved, "/ws")


def test_a_resolver_that_is_missing_or_raises_is_unresolved_so_it_asks(tmp_path, monkeypatch):
    (tmp_path / "gone").mkdir()
    world, call, *_ = setup(tmp_path / "gone", monkeypatch)
    monkeypatch.setitem(sys.modules, "tools.file_tools_paths", None)                         # an import failure
    assert verdict(call, path=str(world.root / "outside" / "a.md"), content="x") == "approve"
    (tmp_path / "boom").mkdir()
    world2, call2, *_ = setup(tmp_path / "boom", monkeypatch)                                 # modules back
    assert verdict(call2, path=str(world2.root / "outside" / "a.md"), content="x") is None
    sys.modules["tools.file_tools_paths"]._resolve_path_for_task = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
    assert verdict(call2, path=str(world2.root / "outside" / "a.md"), content="x") == "approve"   # a call failure


def test_a_config_that_cannot_be_read_is_unresolved_and_no_workspace_means_nothing_is_inside(tmp_path, monkeypatch):
    world, call, *_ = setup(tmp_path, monkeypatch)
    world.config = RuntimeError("unreadable")
    assert verdict(call, path=str(world.root / "outside" / "a.md"), content="x") == "approve"
    world.config = {"terminal": {"cwd": "auto"}}                                              # no workspace configured: no path is inside it
    assert verdict(call, path=str(world.root / "pages" / "a.md"), content="x") is None


def test_the_workspace_root_itself_is_unresolved(tmp_path, monkeypatch):
    world, call, *_ = setup(tmp_path, monkeypatch)
    assert verdict(call, path=str(world.root), content="x") == "approve"                      # no file is written there: not a guess


# ---- limits and costs ----------------------------------------------------------------------------------------------------------
def test_terminal_writing_into_pages_is_not_stopped(tmp_path, monkeypatch):
    """The documented limit (rules-conditions-v0 section 6): `terminal`, `execute_code` and MCP file servers are not seen."""
    world, call, *_ = setup(tmp_path, monkeypatch)
    assert verdict(call, "terminal", command="echo hi > pages/a.md") is None
    assert verdict(call, "execute_code", code="open('pages/a.md','w').write('x')") is None


def test_a_table_without_path_rules_never_calls_the_resolver(tmp_path, monkeypatch):
    world, call, *_ = setup(tmp_path, monkeypatch, rules=False)
    assert verdict(call, path=str(world.root / "pages" / "a.md"), content="x") is None
    assert verdict(call, "patch", mode="patch", patch=v4a("*** Add File: pages/y.md", "+hello")) is None
    assert world.calls == []


def test_a_handoffs_origin_table_gets_the_same_facts(tmp_path, monkeypatch):
    world, call, plugin, store, db = setup(tmp_path, monkeypatch, rules=False)              # the destination has no path rule
    import luvebot_backend.rules as R
    store.put_table(db, "guarded", R.compile_hook_table([*R.builtin_rules(), path_rule(R)], version=1, toolset_tools={}, mcp_server_tools={}))
    fake_kanban(monkeypatch, "guarded")                                                        # the origin of this task is `guarded`
    assert verdict(call, path=str(world.root / "pages" / "a.md"), content="x") == "approve"   # the origin's rule asks
    assert verdict(call, path=str(world.root / "outside" / "a.md"), content="x") is None      # and judges by the real tag, not by "unresolved"


def test_the_two_lists_of_file_tools_are_one(tmp_path, monkeypatch):
    world, call, plugin, store, db = setup(tmp_path, monkeypatch)
    import luvebot_backend.rules as R
    from luvebot_backend import workspace
    assert workspace.PATH_TOOLS == R.PATH_TOOLS == ("write_file", "patch")
    source = open(workspace.__file__).read()
    assert "from .rules" not in source and "import rules" not in source          # Pages loads this module: no engine with it


def test_the_version_is_the_one_the_engine_asks_for(tmp_path, monkeypatch):
    world, call, plugin, store, db = setup(tmp_path, monkeypatch)
    import luvebot_backend.rules as R
    assert plugin.PLUGIN_VERSION == "0.8.7" and tuple(map(int, plugin.PLUGIN_VERSION.split("."))) >= R.PATH_FACTS_VERSION   # 0.8.0 keeps what 0.6.0 does
    assert all(name in plugin._PRELOAD for name in ("luvebot_backend.workspace", "tools.file_tools_paths", "tools.patch_parser"))


# ---- 21a: the paths and the preview on the approve row ----------------------------------------------------------------------------
def with_redactor(monkeypatch):
    redact = types.ModuleType("agent.redact")
    redact.redact_sensitive_text = lambda text, force=False: text.replace("SECRET", "[REDACTED]")
    monkeypatch.setitem(sys.modules, "agent", types.ModuleType("agent"))
    monkeypatch.setitem(sys.modules, "agent.redact", redact)


def approve_rows(store, db):
    return [r for r in store.events(db, "p", 100) if r["verdict"] == "approve"]


def last_detail(store, db):
    rows = approve_rows(store, db)
    return json.loads(rows[0]["detail"]) if rows and rows[0]["detail"] else None   # newest first


def test_a_write_file_approve_row_carries_the_paths_and_a_redacted_preview(tmp_path, monkeypatch):
    world, call, plugin, store, db = setup(tmp_path, monkeypatch)
    with_redactor(monkeypatch)
    target = str(world.root / "pages" / "plan.md")
    assert verdict(call, path=target, content="# plan\nkey: SECRET\n") == "approve"
    detail = last_detail(store, db)
    assert detail, "the approve row has no detail"
    assert detail["paths"] == ["workspace:pages/plan.md"]
    proposal = detail["proposal"]
    assert (proposal["kind"], proposal["path_tag"], proposal["truncated"]) == ("whole", "workspace:pages/plan.md", False)
    assert proposal["content"] == "# plan\nkey: [REDACTED]\n" and proposal["size"] == len("# plan\nkey: SECRET\n")
    assert "base_sha" not in detail and "base_sha" not in proposal                              # the backend reads the file itself


def test_redaction_comes_before_the_cut_so_a_secret_across_it_does_not_survive(tmp_path, monkeypatch):
    world, call, plugin, store, db = setup(tmp_path, monkeypatch)
    with_redactor(monkeypatch)
    verdict(call, path=str(world.root / "pages" / "big.md"), content="x" * (64 * 1024 - 3) + "SECRET tail")
    proposal = last_detail(store, db)["proposal"]
    assert proposal["truncated"] is True and "SEC" not in proposal["content"][-12:] and "SECRET" not in proposal["content"]


def test_a_replace_patch_is_old_and_new_as_minus_and_plus_lines_and_a_v4a_patch_is_its_text(tmp_path, monkeypatch):
    world, call, plugin, store, db = setup(tmp_path, monkeypatch)
    with_redactor(monkeypatch)
    verdict(call, "patch", path=str(world.root / "pages" / "a.md"), old_string="one\ntwo", new_string="uno")
    proposal = last_detail(store, db)["proposal"]
    assert (proposal["kind"], proposal["content"]) == ("replace", "- one\n- two\n+ uno")
    text = v4a("*** Update File: outside/x.md", "@@", "-a", "+b", "*** Add File: pages/y.md", "+hello")
    verdict(call, "patch", mode="patch", patch=text)
    detail = last_detail(store, db)
    assert detail["paths"] == ["workspace:outside/x.md", "workspace:pages/y.md"]               # several: the proposal stays, the backend finds no single page
    assert (detail["proposal"]["kind"], detail["proposal"]["content"]) == ("v4a", text)


def test_no_redactor_or_no_text_leaves_the_preview_out_but_keeps_the_paths(tmp_path, monkeypatch):
    world, call, plugin, store, db = setup(tmp_path, monkeypatch)
    monkeypatch.setitem(sys.modules, "agent.redact", None)                                      # no redactor here: no preview, never an unredacted one
    verdict(call, path=str(world.root / "pages" / "a.md"), content="x")
    assert last_detail(store, db) == {"paths": ["workspace:pages/a.md"]}
    with_redactor(monkeypatch)
    verdict(call, path=str(world.root / "pages" / "b.md"), content=5)                           # not text
    assert last_detail(store, db) == {"paths": ["workspace:pages/b.md"]}
    verdict(call, "patch", path=str(world.root / "pages" / "c.md"), old_string="a")             # no new_string
    assert last_detail(store, db) == {"paths": ["workspace:pages/c.md"]}


def test_the_detail_is_only_for_the_approve_row_of_a_file_tool(tmp_path, monkeypatch):
    world, call, plugin, store, db = setup(tmp_path, monkeypatch)
    with_redactor(monkeypatch)
    import luvebot_backend.rules as R
    block = R.Rule(id="r_block", label="b", level=R.Level.BLOCK, scope=R.Scope(R.ScopeKind.GLOBAL),
                   match=R.Match(tools=("write_file",), toolsets=(), mcp_servers=(), commands=(), conditions=()), state=R.RuleState.ACTIVE, origin=R.Origin.HUMAN)
    store.put_table(db, "p", R.compile_hook_table([*R.builtin_rules(), block], version=1, toolset_tools={}, mcp_server_tools={}))
    assert verdict(call, path=str(world.root / "pages" / "a.md"), content="x") == "block"
    assert [r for r in store.events(db, "p", 50) if r["verdict"] == "block"][0]["detail"] is None
    verdict(call, "terminal", command="chmod 600 /tmp/x")                                       # an approve, but not a file tool
    assert approve_rows(store, db)[0]["detail"] is None


def test_an_ask_that_names_no_path_still_gets_the_paths_and_the_preview(tmp_path, monkeypatch):
    """The card is for any approval of a file tool, not only one that a path rule asked: the paths are extracted when the row is written."""
    world, call, plugin, store, db = setup(tmp_path, monkeypatch, rules=False)
    with_redactor(monkeypatch)
    import luvebot_backend.rules as R
    ask = R.Rule(id="r_ask", label="a", level=R.Level.ASK, scope=R.Scope(R.ScopeKind.GLOBAL),
                 match=R.Match(tools=("write_file",), toolsets=(), mcp_servers=(), commands=(), conditions=()), state=R.RuleState.ACTIVE, origin=R.Origin.HUMAN)
    store.put_table(db, "p", R.compile_hook_table([*R.builtin_rules(), ask], version=1, toolset_tools={}, mcp_server_tools={}))
    assert verdict(call, path=str(world.root / "pages" / "a.md"), content="hello") == "approve"
    detail = last_detail(store, db)
    assert detail["paths"] == ["workspace:pages/a.md"] and detail["proposal"]["content"] == "hello"


# ---- the shared workspace helper ----------------------------------------------------------------------------------------------
def test_cwd_root_is_the_one_definition_of_the_root(tmp_path):
    from luvebot_backend import workspace
    real = tmp_path / "ws"
    real.mkdir()
    (tmp_path / "link").symlink_to(real)
    assert workspace.cwd_root({"cwd": str(real)}) == str(real.resolve())
    assert workspace.cwd_root({"cwd": str(tmp_path / "link")}) == str(real.resolve())          # realpath
    for bad in ({}, {"cwd": ""}, {"cwd": "."}, {"cwd": "auto"}, {"cwd": "cwd"}, {"cwd": "relative/dir"}, {"cwd": "/"},
                {"cwd": str(tmp_path / "missing")}, {"cwd": 5}, None, "x"):
        assert workspace.cwd_root(bad) is None, bad


def test_path_tag_rules(tmp_path):
    from luvebot_backend import workspace
    root = str(tmp_path.resolve())
    assert workspace.path_tag(Path(root, "pages", "a.md"), root) == "workspace:pages/a.md"
    assert workspace.path_tag(Path("/etc/passwd"), root) == "abs:/etc/passwd"
    assert workspace.path_tag(Path(root), root) == "unresolved"
    assert workspace.path_tag(Path(root + "X", "a"), root) == f"abs:{root}X/a"                # a sibling that shares a prefix is outside
    assert workspace.path_tag(PurePosixPath("/workspace/a"), root) == "unresolved"            # a sandbox path
    assert workspace.path_tag("pages/a.md", root) == "unresolved"
    assert workspace.path_tag(Path("/a/b"), None) == "abs:/a/b"                               # no workspace: nothing is inside


# ---- mutations -----------------------------------------------------------------------------------------------------------------
def load_workspace(edits):
    source = WORKSPACE.read_text()
    for old, new in edits:
        assert source.count(old) == 1, old
        source = source.replace(old, new)
    spec = importlib.util.spec_from_loader("luvebot_backend.workspace", loader=None)
    module = importlib.util.module_from_spec(spec)
    module.__package__ = "luvebot_backend"
    exec(compile(source, str(WORKSPACE), "exec"), module.__dict__)
    return module


WORKSPACE_MUTATIONS = {
    "the tag is lower-cased": ([("            return 'workspace:' + text[len(base) + 1:]\n", "            return 'workspace:' + text[len(base) + 1:].lower()\n")],
                               test_the_tag_is_exactly_what_the_resolver_gave),
    "the container check is gone": ([("        if hermes.container_backend_for_task(tid) is not None:", "        if False:")],
                                    test_a_sandbox_backend_is_unresolved_so_it_asks),
    "a delete resolves the link's target": ([("        out.append((op.file_path, kind in ('delete', 'move')))", "        out.append((op.file_path, False))")],
                                            test_a_delete_names_the_entry_and_a_move_names_both_ends),
    "a move names only the source": ([("        if kind == 'move':\n            out.append((op.new_path, True))\n", "")],
                                      test_a_delete_names_the_entry_and_a_move_names_both_ends),
    "a failure gives no tag at all": ([("    except BaseException:  # noqa: BLE001  (no resolver, no parser, no config: nothing can be said)\n        return [UNRESOLVED]",
                                        "    except BaseException:  # noqa: BLE001\n        return ['abs:/nowhere']")],
                                      test_a_resolver_that_is_missing_or_raises_is_unresolved_so_it_asks),
    "a bad patch is read as a file outside pages": ([("    if error or not operations:\n        return [(None, False)]\n", "    if error or not operations:\n        return [('/tmp/not-in-pages', False)]\n")],
                                                    test_a_patch_that_does_not_parse_or_has_no_header_is_unresolved_so_it_asks),
    "the root itself is a workspace path": ([("        if text == base:\n            return UNRESOLVED\n", "")],
                                            test_the_workspace_root_itself_is_unresolved),
    "a sibling with the same prefix is inside": ([("        if text.startswith(base + '/'):", "        if text.startswith(base):")],
                                                 test_path_tag_rules),
}


@pytest.mark.parametrize("label", sorted(WORKSPACE_MUTATIONS))
def test_each_workspace_mutation_turns_its_test_red(label, tmp_path, monkeypatch):
    edits, check = WORKSPACE_MUTATIONS[label]
    # the plugin imports `luvebot_backend.workspace` when it needs it: swap in the mutated module before the test builds its hook
    from test_hook_free_mode import rig as _rig
    (tmp_path / "boot").mkdir()
    _rig(tmp_path / "boot")                                                                    # makes `luvebot_backend` importable
    mutated = load_workspace(edits)
    monkeypatch.setitem(sys.modules, "luvebot_backend.workspace", mutated)
    import luvebot_backend
    monkeypatch.setattr(luvebot_backend, "workspace", mutated, raising=False)
    args = {"tmp_path": tmp_path / "run", "monkeypatch": monkeypatch}
    names = check.__code__.co_varnames[:check.__code__.co_argcount]
    (tmp_path / "run").mkdir()
    with pytest.raises(AssertionError):
        check(**{k: args[k] for k in names})


PLUGIN_MUTATIONS = {
    "the detail is never written": ([("_redact(command) if command else None, detail=detail)", "_redact(command) if command else None)")],
                                    test_a_write_file_approve_row_carries_the_paths_and_a_redacted_preview),
    "the detail is written for a block too": ([('if action == "approve" else None  # 21a', "if True else None  # 21a")],
                                              test_the_detail_is_only_for_the_approve_row_of_a_file_tool),
    "the preview uses the 500-character redactor": ([("workspace.review_detail(tool_name, args, cache[\"facts\"] or [], _redact_full)", "workspace.review_detail(tool_name, args, cache[\"facts\"] or [], _redact)")],
                                                    test_redaction_comes_before_the_cut_so_a_secret_across_it_does_not_survive),
    "the version stays 0.5.0": ([('PLUGIN_VERSION = "0.8.7"', 'PLUGIN_VERSION = "0.5.0"')], test_the_version_is_the_one_the_engine_asks_for),
    "the origin's table gets no facts": ([("    verdict = hook_verdict(table, tool=tool_name, command=command, facts=facts(table) if facts else None)",
                                           "    verdict = hook_verdict(table, tool=tool_name, command=command)")], test_a_handoffs_origin_table_gets_the_same_facts),
    "the resolver is called even with no path rule": ([("    if not any(getattr(entry, \"paths\", ()) for entry in table.entries):\n        return None\n", "")],
                                                      test_a_table_without_path_rules_never_calls_the_resolver),
}


@pytest.mark.parametrize("label", sorted(PLUGIN_MUTATIONS))
def test_each_plugin_mutation_turns_its_test_red(label, tmp_path, monkeypatch):
    edit, check = PLUGIN_MUTATIONS[label]
    monkeypatch.setitem(EDIT, "plugin", edit[0])
    with pytest.raises(AssertionError):
        check(tmp_path, monkeypatch)
