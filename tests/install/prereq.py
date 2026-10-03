"""Stands in for the user's existing Hermes (README "Prerequisites"): auth configured, one profile API Server key,
gateway and dashboard running. Runs INSIDE the fresh container. Nothing of LuveBot is installed here."""
import json
import os
import secrets
import socket
import subprocess
import time
from pathlib import Path
from urllib.request import urlopen

from plugins.dashboard_auth.basic import hash_password
import hermes_yaml as yaml

home = Path(os.environ['HERMES_HOME'])
home.mkdir(parents=True, exist_ok=True)
creds = {'username': 'install-test', 'password': secrets.token_urlsafe(18), 'signing_key': secrets.token_hex(32)}
Path('/tmp/t/creds.json').write_text(json.dumps(creds))
(home / 'config.yaml').write_text(yaml.safe_dump({
    'dashboard': {'basic_auth': {'username': creds['username'], 'password_hash': hash_password(creds['password']),
                                'secret': creds['signing_key']}}}))
(home / '.env').write_text('API_SERVER_KEY=' + secrets.token_hex(16) + '\nAPI_SERVER_HOST=127.0.0.1\nAPI_SERVER_PORT=8642\n')
(home / '.env').chmod(0o600)
# `hermes gateway run` refuses root inside the image; the image's own harness runs gateway.run directly, so do we
for args, log in ((['python', '-m', 'gateway.run'], 'gateway.log'), (['hermes', 'dashboard', '--no-open'], 'dashboard.log')):
    subprocess.Popen(args, stdout=open('/tmp/t/' + log, 'w'), stderr=subprocess.STDOUT, start_new_session=True)
for _ in range(180):
    try:
        urlopen('http://127.0.0.1:9119/api/health', timeout=2).read()
        break
    except OSError:
        time.sleep(1)
else:
    raise SystemExit('dashboard did not start')
for _ in range(120):
    try:
        socket.create_connection(('127.0.0.1', 8642), timeout=1).close()
        break
    except OSError:
        time.sleep(1)
else:
    raise SystemExit('API Server did not start')
print('prerequisites ready')
