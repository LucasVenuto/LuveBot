"""Real-container probes shared by T1.1 tests; no endpoint mocks."""
import importlib.util
import itertools
import json
import os
from pathlib import Path
import sys
import time
import types
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

if 'pytest' in sys.modules:  # test processes only: the entrypoint also imports this file and launches the dashboard with its environment
    os.environ.setdefault('LUVEBOT_BACKGROUND', '0')  # a test process that imports the plugin must not run the watcher thread
    os.environ.setdefault('HERMES_STATE_DB_GUARD_BYPASS', '1')  # T4.5 seeds sessions in the harness profile's own state.db, as Hermes would
ROOT = Path('/root/.hermes/plugins/luvebot')
STATE = Path('/fixtures')
DASHBOARD = 'http://127.0.0.1:9119'
API = 'http://127.0.0.1:8642'


def credentials():
    return json.loads((STATE / 'credentials.json').read_text())


def http(path, key=None):
    try:
        with urlopen(Request(path, headers={} if key is None else {'Authorization': 'Bearer ' + key}), timeout=10) as response:
            return response.status, response.read()
    except HTTPError as error:
        return error.code, error.read()


def ready():
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            if http(DASHBOARD + '/api/health')[0] == 200 and (STATE / 'ports-after.json').exists():
                return
        except (URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(1)
    raise RuntimeError('Real Hermes/plugin did not become ready')


def plugin():
    name = 'luvebot_invariant_router'
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, ROOT / 'dashboard/plugin_api.py')
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


_variants = itertools.count()


def plugin_variant(edit):
    """A second copy of the real plugin_api.py with ONE edit (old, new): the in-process mutation of a router test. The edit must
    apply exactly once; the real module (plugin()) is untouched."""
    path = ROOT / 'dashboard/plugin_api.py'
    text = path.read_text()
    assert text.count(edit[0]) == 1, edit[0]
    module = types.ModuleType(f'luvebot_invariant_variant_{next(_variants)}')
    module.__file__ = str(path)
    sys.modules[module.__name__] = module
    exec(compile(text.replace(*edit), str(path), 'exec'), module.__dict__)
    return module


def listeners():
    result = []
    for name in ('tcp', 'tcp6'):
        for line in Path('/proc/net/' + name).read_text().splitlines()[1:]:
            fields = line.split()
            if fields[3] == '0A':
                result.append(name + '/' + fields[1])
    return sorted(result)
