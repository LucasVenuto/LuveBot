"""ADR-006 D2 against the REAL files the harness mounts and the REAL FastAPI. A fresh interpreter per case, so nothing a test already
imported can hide a leak.
* In a plugin host (HERMES_PLUGIN_HOST_PROCESS=1, what Hermes sets there), or anywhere the dashboard app is not being imported (the guard
  is positive, F2-2), the manifest's `api` file imports nothing of LuveBot or of the dashboard, starts no thread, and every route answers
  409 `luvebot_needs_in_process`.
* In the dashboard (`hermes_cli.web_server` imported, the module registered under the name Hermes gives it before it runs) it hands over
  the very router of plugin_api.py, with its routes, and exactly one `luvebot-budget` watcher runs.
(The normal path with FastAPI stand-ins, and the mutations of the guard: tests/unit/backend/test_plugin_entry.py.)"""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

PLUGIN = Path('/root/.hermes/plugins/luvebot/dashboard')
HOST = 'HERMES_PLUGIN_HOST_PROCESS'
REFUSES = r'''
import asyncio, importlib.util, json, sys, threading
spec = importlib.util.spec_from_file_location("entry", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
from fastapi import FastAPI
app = FastAPI()
app.include_router(module.router, prefix="/api/plugins/luvebot")

async def call(method, path):
    sent = []
    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}
    async def send(message):
        sent.append(message)
    await app({"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method, "path": path,
               "raw_path": path.encode(), "query_string": b"", "headers": [], "client": ("127.0.0.1", 1), "server": ("x", 80),
               "scheme": "http", "root_path": ""}, receive, send)
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return [sent[0]["status"], json.loads(body)["error"]["code"]]

out = {"imported": sorted(n for n in ("luvebot_backend", "luvebot_plugin_api", "agent", "hermes_cli", "tools", "gateway") if n in sys.modules),
       "threads": sorted(t.name for t in threading.enumerate() if t.name.startswith("luvebot"))}
for method, path in (("GET", "/health"), ("POST", "/bots"), ("PUT", "/bots/vendas/approval-surface"), ("DELETE", "/bots/vendas"),
                     ("GET", "/bots/vendas/runs/r1/events"), ("GET", "/no/such/route")):
    out[method + " " + path] = asyncio.run(call(method, "/api/plugins/luvebot" + path))
print(json.dumps(out))
'''
HANDS_OVER = r'''
import importlib.util, json, sys, threading
import hermes_cli.web_server  # the dashboard app: imported before Hermes mounts any plugin
spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_luvebot", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module        # Hermes registers the module before it runs
spec.loader.exec_module(module)
api = sys.modules["luvebot_plugin_api"]
print(json.dumps({"same_router": module.router is api.router,
                  "has_health": any(getattr(r, "path", "").endswith("/health") for r in module.router.routes),
                  "routes": len(module.router.routes),
                  "budget_watchers": sum(1 for t in threading.enumerate() if t.name == "luvebot-budget")}))
'''


def entry():
    manifest = json.loads((PLUGIN / 'manifest.json').read_text())
    assert manifest['api'] == 'plugin_entry.py'
    return PLUGIN / manifest['api']


def run(code, variable):
    env = {k: v for k, v in os.environ.items() if k not in (HOST, 'LUVEBOT_BACKGROUND')}   # support.py sets LUVEBOT_BACKGROUND=0 here: the dashboard does not
    if variable is not None:
        env[HOST] = variable
    done = subprocess.run([sys.executable, '-I', '-c', code, str(entry())], capture_output=True, text=True, timeout=180, env=env)
    assert done.returncode == 0, done.stderr[-800:]
    return json.loads(done.stdout.strip().splitlines()[-1])


@pytest.mark.parametrize('variable', ['1', None], ids=['in a plugin host', 'no dashboard app, variable not set (fail closed)'])
def test_a_plugin_host_gets_only_409_and_loads_nothing_of_ours(variable):
    out = run(REFUSES, variable)
    assert out.pop('imported') == [], 'a host process imported LuveBot or the dashboard'
    assert out.pop('threads') == [], 'a host process started a LuveBot thread (a second budget watcher)'
    assert out and all(answer == [409, 'luvebot_needs_in_process'] for answer in out.values()), out


def test_in_the_dashboard_the_entry_hands_over_plugin_apis_own_router_with_one_watcher():
    out = run(HANDS_OVER, None)
    assert out['same_router'] is True and out['has_health'] is True and out['routes'] > 100, out
    assert out['budget_watchers'] == 1, out
