"""`pages.workspace` after the root moved to the shared helper (backend/workspace.py `cwd_root`, also used by the hook's path facts): the same
states as before for the same configs, over a real folder. Hermes is faked only where `workspace()` reaches for it."""
import contextlib
import sys
import types

import pytest


@pytest.fixture
def pages(tmp_path, monkeypatch):
    home = tmp_path / "hermes"
    (home / "workspace").mkdir(parents=True)
    state = {"terminal": {}, "remote": None}

    def module(name, **attrs):
        mod = types.ModuleType(name)
        mod.__dict__.update(attrs)
        monkeypatch.setitem(sys.modules, name, mod)
    module("agent"), module("hermes_cli"), module("hermes_cli.web_routers")
    module("agent.secret_scope", get_secret=lambda *a: None, current_secret_scope=lambda: None)
    module("hermes_cli.profiles", list_profile_names=lambda: [])
    module("hermes_cli.config", load_config=lambda: {"terminal": state["terminal"]})
    module("hermes_cli.web_routers.files", _fs_backend=lambda bot: state["remote"])
    module("hermes_cli.web_server_profiles", _config_profile_scope=lambda bot: contextlib.nullcontext())
    module("hermes_constants", get_default_hermes_root=lambda: home, get_hermes_home=lambda: home)
    import backend.pages as pages
    return pages, state, tmp_path, home


def test_the_states_for_each_kind_of_terminal_cwd(pages):
    module, state, tmp, home = pages
    work = tmp / "work"
    work.mkdir()
    for unset in (None, "", ".", "auto", "cwd", "relative", 5):
        state["terminal"] = {"cwd": unset}
        assert module.workspace("vendas") == ("no_workspace", None), unset
    state["terminal"] = {"cwd": str(tmp / "missing")}
    assert module.workspace("vendas") == ("no_workspace", None)
    state["terminal"] = {"cwd": "/"}
    assert module.workspace("vendas") == ("no_workspace", None)
    state["terminal"] = {"cwd": str(work)}
    assert module.workspace("vendas") == ("empty", str(work.resolve()))                       # no pages/ yet
    (work / "pages").mkdir()
    assert module.workspace("vendas") == ("ready", str(work.resolve()))
    state["terminal"] = {"cwd": str(home / "profiles")}
    (home / "profiles").mkdir()
    assert module.workspace("vendas") == ("inside_hermes", None)                              # the Hermes root stays refused
    state["terminal"] = {"cwd": str(home / "workspace")}
    assert module.workspace("vendas")[0] == "empty"                                           # the Bot's own workspace is accepted
    state["terminal"] = {"cwd": str(work), "backend": "docker"}
    assert module.workspace("vendas") == ("not_local", None)
    state["terminal"] = {"cwd": str(work)}
    state["remote"] = object()
    assert module.workspace("vendas") == ("not_local", None)


def test_pages_and_the_hook_share_one_definition_of_the_root(pages):
    module, *_ = pages
    from backend import workspace
    assert module.workspace_root is workspace.cwd_root and module.NOT_SET is workspace.NOT_SET
