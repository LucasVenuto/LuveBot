"""The file Hermes mounts as LuveBot's API (manifest `api`). ADR-006 D2: LuveBot runs inside the dashboard process, never in a plugin
host (`plugins.isolation: host`, or a request for another profile's plugin on a Hermes that serves plugins per profile): a host is a
separate process, request/response only, no stream and no websocket, and plugin_api.py imports dashboard internals that exist only in
the dashboard. In a host (HERMES_PLUGIN_HOST_PROCESS=1, set by Hermes) this module imports nothing of ours and answers 409
`luvebot_needs_in_process` on every route; anywhere else it loads plugin_api.py by path, exactly as Hermes did before, and hands
over its router. (plugin_api.py cannot hold this guard itself: a module has no early exit, and its first lines already import the
dashboard.)

Fail closed (Architect, F2-2): the guard is positive. plugin_api.py is loaded only when this is NOT a plugin host AND the dashboard app
is already being imported (`hermes_cli.web_server` in sys.modules: true when Hermes mounts plugins, hot mount and a dashboard hosted by
the gateway included). If Hermes ever renamed the host variable, an import in a host would open a second budget watcher and executor in
another process; with this check the entry answers 409 instead, which shows at once."""
import importlib.util
import os
import sys
from pathlib import Path
from uuid import uuid4

if os.environ.get("HERMES_PLUGIN_HOST_PROCESS") == "1" or "hermes_cli.web_server" not in sys.modules:
    from fastapi import APIRouter
    from fastapi.responses import JSONResponse

    router = APIRouter()

    @router.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
    async def luvebot_needs_in_process(path: str):
        return JSONResponse({"error": {"code": "luvebot_needs_in_process", "request_id": "req_" + uuid4().hex,
                                       "message": "LuveBot runs inside the dashboard process and cannot run in a plugin host: set "
                                                  "plugins.isolation: in_process and open LuveBot in the dashboard's own profile."}},
                            status_code=409, headers={"X-LuveBot-API": "0", "Cache-Control": "no-store"})
else:
    _path = Path(__file__).with_name("plugin_api.py")
    _spec = importlib.util.spec_from_file_location("luvebot_plugin_api", _path)
    _module = importlib.util.module_from_spec(_spec)
    sys.modules[_spec.name] = _module
    try:
        _spec.loader.exec_module(_module)
    except BaseException:
        sys.modules.pop(_spec.name, None)
        raise
    router = _module.router
