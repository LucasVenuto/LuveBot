"""Inside the NEW container: a stock Hermes (api_server on /p/<profile>/, two profiles) + the spike plugin + fake model.
Usage: setup_container.py ROOT_ENABLED PROFILE_ENABLED PROFILE_HAS_PLUGIN [APPROVALS_MODE]   (flags 0 or 1; mode default manual)
  ROOT_ENABLED       plugins.enabled lists the spike in ~/.hermes/config.yaml (the `default` profile)
  PROFILE_ENABLED    plugins.enabled lists it in ~/.hermes/profiles/vendas/config.yaml
  PROFILE_HAS_PLUGIN a copy of the plugin directory sits in ~/.hermes/profiles/vendas/plugins/
It always (re)starts the gateway, so each combination is a clean process."""
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import hermes_yaml as yaml
from hermes_cli.profiles import create_profile

root_enabled, profile_enabled, profile_has = (a == "1" for a in sys.argv[1:4])
approvals_mode = sys.argv[4] if len(sys.argv) > 4 else "manual"
home = Path(os.environ["HERMES_HOME"])
base = Path("/tmp/hook-spike")
base.mkdir(exist_ok=True)
creds_file = base / "creds.json"
if creds_file.exists():
    creds = json.loads(creds_file.read_text())
else:
    creds = {"default_key": secrets.token_hex(16), "vendas_key": secrets.token_hex(16)}
    creds_file.write_text(json.dumps(creds))
(base / "mode").write_text("off")
def make_config(enabled):
    return {
    "model": {"default": "fake-harness", "provider": "custom", "base_url": "http://127.0.0.1:8000/v1"},
    "gateway": {"multiplex_profiles": True},
    "plugins": {"enabled": ["luvebot_hook_spike"] if enabled else [], "hook_callback_timeout": 3},
    "terminal": {"backend": "local"}, "platform_toolsets": {"api_server": ["terminal"]},
    "approvals": {"mode": approvals_mode, "timeout": 60},
    }


import shutil
home.mkdir(parents=True, exist_ok=True)
(home / "config.yaml").write_text(yaml.safe_dump(make_config(root_enabled)))
profile = home / "profiles/vendas"
if not profile.exists():
    profile = create_profile("vendas", no_alias=True, no_skills=True)
(profile / "config.yaml").write_text(yaml.safe_dump(make_config(profile_enabled)))
target = profile / "plugins" / "luvebot_hook_spike"
shutil.rmtree(target, ignore_errors=True)
if profile_has:
    (profile / "plugins").mkdir(exist_ok=True)
    shutil.copytree(home / "plugins" / "luvebot_hook_spike", target)
for directory, key in ((home, creds["default_key"]), (profile, creds["vendas_key"])):
    (directory / ".env").write_text(f"API_SERVER_KEY={key}\nAPI_SERVER_HOST=127.0.0.1\nAPI_SERVER_PORT=8642\n"
                                    f"OPENAI_API_KEY={key}\nOPENAI_BASE_URL=http://127.0.0.1:8000/v1\n")
    (directory / ".env").chmod(0o600)


def listening(port):
    try:
        socket.create_connection(("127.0.0.1", port), timeout=1).close()
        return True
    except OSError:
        return False


if not listening(8000):
    subprocess.Popen([sys.executable, "/tmp/hook-spike/fake_model.py"], stdout=open(base / "fake.log", "w"),
                     stderr=subprocess.STDOUT, start_new_session=True)
old = base / "gateway.pid"
if old.exists():
    try:
        os.kill(int(old.read_text()), signal.SIGTERM)
    except (OSError, ValueError):
        pass
    for _ in range(60):
        if not listening(8642):
            break
        time.sleep(0.5)
gateway = subprocess.Popen([sys.executable, "-m", "gateway.run"], stdout=open(base / "gateway.log", "w"),
                           stderr=subprocess.STDOUT, start_new_session=True)
old.write_text(str(gateway.pid))
for _ in range(180):
    if listening(8642) and listening(8000):
        break
    time.sleep(1)
else:
    raise SystemExit("gateway or fake model did not start")
print(f"ready: root_enabled={root_enabled} profile_enabled={profile_enabled} profile_has_plugin={profile_has}, gateway pid {gateway.pid}")
