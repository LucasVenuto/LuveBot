"""Generate test-only state; never install a plugin or packages on the host."""
import json
import os
from pathlib import Path
import secrets

root = Path(os.environ.get('HARNESS_STATE', '/tmp/luvebot-harness'))
root.mkdir(parents=True, exist_ok=True)
credentials = root / 'credentials.json'
if not credentials.exists():
    values = {'username': 'harness-human', 'password': secrets.token_urlsafe(32),
              'api_key': secrets.token_hex(32), 'vendas_api_key': secrets.token_hex(32),
              'signing_key': secrets.token_hex(32), 'extra_canary': secrets.token_hex(32)}
    descriptor = os.open(credentials, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(values, stream)
(root / 'evidence').mkdir(exist_ok=True)
print('Isolated Hermes test credentials prepared (values omitted)')
