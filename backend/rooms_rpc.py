"""The in-process call to Hermes Group Chat (`groups.*`), contract v0.3 section 2 (A-34).

`/api/ws` runs `tui_gateway.server.dispatch` inside the dashboard process; the plugin backend, a worker thread of the same
process, calls the same dispatcher (`tui_gateway.server.handle_request`: the functions of `rpc_dispatch.py` are rebound onto the server module, so the bare
module is not callable on its own; found by running it, harness H-R1). No credential and no socket are involved,
and the browser never calls `groups.*` (a mutation from page code would skip CSRF, the membership check, the budget gate and the
audit). The upstream error text is never forwarded.
"""
import uuid

from .api_errors import PluginError

# Hermes room error codes (tui_gateway/methods_groups.py): 4110 create, 4111 send, 4112 log, 4113 disband, 4114 state,
# 4115 driver unavailable, 4117 rename, 4123 worker unavailable; 5110 to 5119 internal.
UNAVAILABLE = {4115, 4123}
NOT_FOUND = {4114, 4112, 4113, 4117}


def available():
    try:
        from tui_gateway import server  # noqa: F401
        return True
    except Exception:
        return False


def call(method, params):
    """-> result dict, or a PluginError in the v0 envelope."""
    try:
        from tui_gateway import server  # rpc_dispatch's functions are rebound onto this module's namespace (method_ctx.py)
        reply = server.handle_request({"jsonrpc": "2.0", "id": "luvebot-" + uuid.uuid4().hex[:12], "method": method, "params": params})
    except Exception:
        raise PluginError("hermes_unreachable", "Hermes is unavailable.", 503) from None
    if not isinstance(reply, dict):
        raise PluginError("hermes_error", "Hermes returned an unexpected response.", 502)
    error = reply.get("error")
    if error:
        code = error.get("code") if isinstance(error, dict) else None
        reason = (error.get("data") or {}).get("reason") if isinstance(error, dict) and isinstance(error.get("data"), dict) else None
        if code in UNAVAILABLE:
            raise PluginError("capability_missing", "Group Chat is not running in this Hermes.", 409)
        if code in NOT_FOUND and reason in ("not_found", "room_not_found", "disbanded", None) and code == 4114:
            raise PluginError("room_not_found", "Room not found.", 404)
        if isinstance(code, int) and 4000 <= code < 5000:
            raise PluginError("invalid_field", "Hermes refused this request.", 422)
        raise PluginError("hermes_error", "Hermes returned an unexpected response.", 502)
    result = reply.get("result")
    if not isinstance(result, dict):
        raise PluginError("hermes_error", "Hermes returned an unexpected response.", 502)
    return result
