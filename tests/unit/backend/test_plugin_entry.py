"""ADR-006 D2: LuveBot never runs in a plugin host. Hermes mounts `dashboard/plugin_entry.py` (manifest `api`). With
HERMES_PLUGIN_HOST_PROCESS=1 (what Hermes sets in a host: `plugins.isolation: host`, or a request for another profile's plugin) it
imports nothing of ours and answers 409 `luvebot_needs_in_process` on every route; anywhere else it hands over plugin_api.py's router
unchanged. FastAPI is a stand-in here (the real one lives in the Hermes image); the harness mounts the real files.
Mutation: the guard taken out -> the host case is red."""
import asyncio
import ast
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import types

import pytest

REPO = Path(__file__).resolve().parents[3]
ENTRY = REPO / "dashboard" / "plugin_entry.py"
HOST = "HERMES_PLUGIN_HOST_PROCESS"
APP = "hermes_cli.web_server"


class Router:
    def __init__(self):
        self.routes = []

    def api_route(self, path, methods):
        def register(function):
            self.routes.append((path, tuple(methods), function))
            return function
        return register


class Response:
    def __init__(self, content, status_code=200, headers=None):
        self.content, self.status_code, self.headers = content, status_code, headers or {}


def stand_in_fastapi(monkeypatch):
    fastapi, responses = types.ModuleType("fastapi"), types.ModuleType("fastapi.responses")
    fastapi.APIRouter, responses.JSONResponse = Router, Response
    monkeypatch.setitem(sys.modules, "fastapi", fastapi)
    monkeypatch.setitem(sys.modules, "fastapi.responses", responses)


def load(path, name="luvebot_entry_under_test"):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def in_the_dashboard(monkeypatch):
    """The dashboard app is being imported (what is true when Hermes mounts plugins): `hermes_cli.web_server` is in sys.modules."""
    monkeypatch.setitem(sys.modules, APP, types.ModuleType(APP))


def in_a_host(monkeypatch, path=ENTRY):
    stand_in_fastapi(monkeypatch)
    monkeypatch.setenv(HOST, "1")
    for name in ("luvebot_backend", "luvebot_plugin_api"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    return load(path)


def check_a_host_only_refuses(entry):
    (path, methods, handler), = entry.router.routes
    assert path == "/{path:path}" and {"GET", "POST", "PUT", "PATCH", "DELETE"} <= set(methods)
    for requested in ("bots", "bots/vendas/runs", "health", ""):
        answer = asyncio.run(handler(requested))
        error = answer.content["error"]
        assert answer.status_code == 409 and error["code"] == "luvebot_needs_in_process", requested
        assert "plugins.isolation: in_process" in error["message"] and "update" not in error["message"].lower()
        assert answer.headers == {"X-LuveBot-API": "0", "Cache-Control": "no-store"} and error["request_id"].startswith("req_")
        assert not requested or requested not in json.dumps(answer.content)     # nothing of the request is echoed
    assert "luvebot_backend" not in sys.modules and "luvebot_plugin_api" not in sys.modules   # nothing of ours was imported


def test_in_a_plugin_host_every_route_is_409_and_nothing_of_ours_is_imported(monkeypatch):
    check_a_host_only_refuses(in_a_host(monkeypatch))


@pytest.mark.parametrize("value", ["", "0", "true", "yes"])
def test_only_the_value_hermes_sets_means_a_host(monkeypatch, tmp_path, value):
    """`1` and nothing else (the value Hermes sets): any other value is the normal path, and the router comes from plugin_api.py."""
    folder = tmp_path / "dashboard"
    folder.mkdir()
    shutil.copy(ENTRY, folder / "plugin_entry.py")
    (folder / "plugin_api.py").write_text("router = object()\n")
    in_the_dashboard(monkeypatch)
    monkeypatch.setenv(HOST, value)
    entry = load(folder / "plugin_entry.py")
    assert entry.router is sys.modules["luvebot_plugin_api"].router
    monkeypatch.delitem(sys.modules, "luvebot_plugin_api", raising=False)


def test_in_the_dashboard_the_router_is_plugin_apis_own(monkeypatch, tmp_path):
    folder = tmp_path / "dashboard"
    folder.mkdir()
    shutil.copy(ENTRY, folder / "plugin_entry.py")
    (folder / "plugin_api.py").write_text("router = ['the real router']\nimported_from = __file__\n")
    monkeypatch.delenv(HOST, raising=False)
    in_the_dashboard(monkeypatch)
    entry = load(folder / "plugin_entry.py")
    assert entry.router == ["the real router"] and sys.modules["luvebot_plugin_api"].imported_from == str(folder / "plugin_api.py")
    monkeypatch.delitem(sys.modules, "luvebot_plugin_api", raising=False)


def test_a_plugin_api_that_fails_to_import_fails_loudly_and_leaves_no_half_module(monkeypatch, tmp_path):
    folder = tmp_path / "dashboard"
    folder.mkdir()
    shutil.copy(ENTRY, folder / "plugin_entry.py")
    (folder / "plugin_api.py").write_text("raise RuntimeError('dashboard internals missing')\n")
    monkeypatch.delenv(HOST, raising=False)
    in_the_dashboard(monkeypatch)
    with pytest.raises(RuntimeError, match="dashboard internals missing"):
        load(folder / "plugin_entry.py")
    assert "luvebot_plugin_api" not in sys.modules


@pytest.mark.parametrize("value", [None, "0", "", "true"])
def test_without_the_dashboard_app_the_entry_fails_closed_even_if_the_host_variable_is_not_set(monkeypatch, value):
    """F2-2: if Hermes ever renamed the host variable, importing plugin_api.py in a host would open a second budget watcher; the entry
    loads it only when the dashboard app is being imported, and answers 409 otherwise."""
    stand_in_fastapi(monkeypatch)
    for name in (APP, "luvebot_plugin_api", "luvebot_backend"):   # a clean interpreter, as in a plugin host: other tests may have imported them
        monkeypatch.delitem(sys.modules, name, raising=False)
    if value is None:
        monkeypatch.delenv(HOST, raising=False)
    else:
        monkeypatch.setenv(HOST, value)
    check_a_host_only_refuses(load(ENTRY))


def test_the_entry_imports_only_the_standard_library_outside_the_host_branch():
    tree = ast.parse(ENTRY.read_text())
    top = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom))]
    names = {(node.module if isinstance(node, ast.ImportFrom) else alias.name).split(".")[0] for node in top for alias in node.names}
    assert names <= {"importlib", "os", "sys", "pathlib", "uuid"}
    host = next(node for node in tree.body if isinstance(node, ast.If))
    inside = {n.module.split(".")[0] if isinstance(n, ast.ImportFrom) else n.names[0].name.split(".")[0]
              for node in host.body for n in ast.walk(node) if isinstance(n, (ast.Import, ast.ImportFrom))}
    assert inside == {"fastapi"}                      # the host branch needs a router and a response, nothing of the dashboard or LuveBot


def test_hermes_mounts_the_entry_and_both_files_ship():
    manifest = json.loads((REPO / "dashboard" / "manifest.json").read_text())
    assert manifest["has_api"] is True and manifest["api"] == "plugin_entry.py"
    assert (REPO / "dashboard" / manifest["api"]).is_file() and (REPO / "dashboard" / "plugin_api.py").is_file()
    assert "plugin_entry.py" in (REPO / "dashboard" / "plugin_api.py").read_text().split("def _code_digest")[1].split("_CODE_LOADED")[0]


GUARD = 'if os.environ.get("HERMES_PLUGIN_HOST_PROCESS") == "1" or "hermes_cli.web_server" not in sys.modules:'
LOADS = 'else:\n    _path = Path(__file__).with_name("plugin_api.py")'
MUTATIONS = [("guard removed", GUARD, "if False:"),
             ("a host also loads plugin_api.py", LOADS, 'if True:\n    _path = Path(__file__).with_name("plugin_api.py")')]


@pytest.mark.parametrize("label,old,new", MUTATIONS, ids=[m[0] for m in MUTATIONS])
def test_the_mutations_are_caught(monkeypatch, tmp_path, label, old, new):
    text = ENTRY.read_text()
    assert text.count(old) == 1                      # the anchor must still match
    folder = tmp_path / "dashboard"
    folder.mkdir()
    (folder / "plugin_entry.py").write_text(text.replace(old, new, 1))
    (folder / "plugin_api.py").write_text("raise ImportError('hermes_cli.web_routers.status: not in a host')\n")
    with pytest.raises(Exception):                   # red = the host case no longer holds (it tried to load the dashboard, or lost its 409)
        check_a_host_only_refuses(in_a_host(monkeypatch, folder / "plugin_entry.py"))


def test_the_mutation_without_the_dashboard_check_is_caught(monkeypatch, tmp_path):
    """The positive half of the guard taken out (only the variable decides): with no dashboard app and no variable it would load plugin_api.py."""
    text = ENTRY.read_text()
    old = ' or "hermes_cli.web_server" not in sys.modules:'
    assert text.count(old) == 1
    folder = tmp_path / "dashboard"
    folder.mkdir()
    (folder / "plugin_entry.py").write_text(text.replace(old, ":", 1))
    (folder / "plugin_api.py").write_text("raise ImportError('a second budget watcher would start here')\n")
    stand_in_fastapi(monkeypatch)
    monkeypatch.delitem(sys.modules, APP, raising=False)
    monkeypatch.delitem(sys.modules, "luvebot_plugin_api", raising=False)
    monkeypatch.delenv(HOST, raising=False)
    with pytest.raises(Exception):
        check_a_host_only_refuses(load(folder / "plugin_entry.py"))


def test_a_guard_that_treats_zero_as_a_host_is_caught(monkeypatch, tmp_path):
    """The other direction: HERMES_PLUGIN_HOST_PROCESS=0 is the normal path; a guard that fires on any set value would refuse the dashboard."""
    text = ENTRY.read_text()
    assert text.count(GUARD) == 1                    # the anchor must still match
    folder = tmp_path / "dashboard"
    folder.mkdir()
    (folder / "plugin_entry.py").write_text(text.replace(GUARD, 'if os.environ.get("HERMES_PLUGIN_HOST_PROCESS"):', 1))
    (folder / "plugin_api.py").write_text("router = object()\n")
    stand_in_fastapi(monkeypatch)
    in_the_dashboard(monkeypatch)
    monkeypatch.setenv(HOST, "0")
    monkeypatch.delitem(sys.modules, "luvebot_plugin_api", raising=False)
    entry = load(folder / "plugin_entry.py")
    with pytest.raises(Exception):                   # the mutated entry answered 409 where plugin_api's router belonged
        assert entry.router is sys.modules["luvebot_plugin_api"].router
