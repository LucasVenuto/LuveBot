"""Generate disposable fixtures outside the repository using host stdlib only."""
import json
import os
from pathlib import Path
import secrets

root = Path(os.environ.get("SPIKE_DIR", "/tmp/luvebot-spike"))
root.mkdir(parents=True, exist_ok=True)
(root / "evidence").mkdir(exist_ok=True)
credentials = root / "credentials.json"
if not credentials.exists():
    descriptor = os.open(credentials, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump({"username": "harness-human", "password": secrets.token_urlsafe(32),
                   "api_key": secrets.token_hex(32), "signing_key": secrets.token_hex(32)}, stream)
plugin = root / "dashboard"
(plugin / "dist").mkdir(parents=True, exist_ok=True)
(plugin / "manifest.json").write_text(json.dumps({
    "name": "t0-spike", "label": "Disposable T0 spike", "version": "0.0.0",
    "tab": {"path": "/t0-spike", "override": "/"},
    "entry": "dist/index.js", "api": "plugin_api.py"}, indent=2))
(plugin / "plugin_api.py").write_text('from fastapi import APIRouter\nrouter = APIRouter()\n@router.get("/probe")\ndef probe():\n    return {"spike": "t0-spike", "result": "real-plugin-router"}\n')
(plugin / "dist/index.js").write_text('(function () {\n  const sdk = window.__HERMES_PLUGIN_SDK__;\n  if (!sdk || !sdk.React) throw new Error("Hermes SDK missing");\n  window.__HERMES_PLUGINS__.register("t0-spike", function SpikeHome() {\n    return sdk.React.createElement("main", {"data-testid": "luvebot-spike-home"},\n      "LuveBot disposable T0 spike home");\n  });\n})();\n')
print(f"Disposable spike generated: {root} (credentials not printed)")

# Upgrade existing disposable credentials without exposing either profile's key.
values = json.loads(credentials.read_text())
if "vendas_api_key" not in values:
    values["vendas_api_key"] = secrets.token_hex(32)
    credentials.write_text(json.dumps(values))
    credentials.chmod(0o600)
