"""Generate disposable T0.8 plugin code in /tmp, never in the product tree."""
from pathlib import Path
import runpy

fixtures = runpy.run_path(str(Path(__file__).with_name("prepare_spike.py")))
plugin = fixtures["plugin"]
(plugin / "plugin_api.py").write_text('''from fastapi import APIRouter, HTTPException, Request
from agent.secret_scope import get_secret, current_secret_scope_home
from urllib.request import Request as HttpRequest, urlopen
import json

router = APIRouter()

@router.get("/probe")
def probe():
    return {"spike": "t0-spike", "result": "real-plugin-router"}

@router.get("/identity")
def identity(request: Request, profile: str = "default"):
    session = getattr(request.state, "session", None)
    if session is None:
        raise HTTPException(status_code=401, detail="Verified human session required")
    # Session also contains tokens. Select actor fields explicitly, never dump it.
    actor = {"user_id": session.user_id, "provider": session.provider}
    key = get_secret("API_SERVER_KEY", "")
    if not key:
        raise HTTPException(status_code=503, detail="Profile key unavailable")
    upstream = HttpRequest("http://127.0.0.1:8642/p/" + profile + "/v1/capabilities",
                           headers={"Authorization": "Bearer " + key})
    with urlopen(upstream, timeout=10) as response:
        status = response.status
        capabilities = json.loads(response.read())
    return {"actor": actor, "profile": profile,
            "profile_home": str(current_secret_scope_home()),
            "key_resolved": bool(key), "upstream_status": status,
            "upstream_object": capabilities["object"]}
''')
(plugin / "dist/index.js").write_text('''(function () {
  const sdk = window.__HERMES_PLUGIN_SDK__;
  if (!sdk || !sdk.React) throw new Error("Hermes SDK missing");
  // Exercised from this plugin's actual page; no substitute WS server/client.
  window.__T08_SPIKE__ = {
    async rpc(methods) {
      const url = await sdk.buildWsUrl("/api/ws");
      const ws = new WebSocket(url);
      const replies = [];
      try {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("WS open timeout")), 15000);
          ws.onopen = () => { clearTimeout(timeout); resolve(); };
          ws.onerror = () => { clearTimeout(timeout); reject(new Error("WS open failed")); };
        });
        for (let i = 0; i < methods.length; i++) {
          const method = methods[i];
          const reply = await new Promise((resolve, reject) => {
            const id = "t08-" + i;
            const timeout = setTimeout(() => reject(new Error("RPC timeout: " + method)), 30000);
            ws.onmessage = event => {
              for (const line of String(event.data).split("\\n")) {
                if (!line.trim()) continue;
                const data = JSON.parse(line);
                if (data.id === id) { clearTimeout(timeout); resolve(data); }
              }
            };
            ws.send(JSON.stringify({jsonrpc: "2.0", id, method, params: {profile: "default"}}));
          });
          replies.push({method, reply});
        }
        return {origin: location.origin, path: new URL(url).pathname,
                ticketAuth: new URL(url).searchParams.has("ticket"), opened: true, replies};
      } finally { ws.close(); }
    },
    async identity(profile) {
      const response = await sdk.authedFetch("/api/plugins/t0-spike/identity?profile=" + profile);
      return {status: response.status, text: await response.text()};
    },
    displaySocket(ticket) {
      return new Promise((resolve, reject) => {
        const url = new URL("/api/display/ws", location.origin);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        if (ticket) url.searchParams.set("display_ticket", ticket);
        const ws = new WebSocket(url);
        let opened = false;
        const timer = setTimeout(() => { ws.close(); reject(new Error("display WS timeout")); }, 15000);
        ws.onopen = () => { opened = true; };
        ws.onmessage = event => { clearTimeout(timer); ws.close(); resolve({opened, binary: typeof event.data !== "string"}); };
        ws.onclose = event => { clearTimeout(timer); resolve({opened, code: event.code, reason: event.reason}); };
      });
    }
  };
  window.__HERMES_PLUGINS__.register("t0-spike", function SpikeHome() {
    return sdk.React.createElement("main", {"data-testid": "luvebot-spike-home"},
      "LuveBot disposable T0 spike home");
  });
})();
''')
print("T0.8 disposable RPC/identity probe generated (no credentials returned)")
