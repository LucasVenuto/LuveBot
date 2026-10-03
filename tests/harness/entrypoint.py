"""Start REAL Hermes before/after enabling the read-only repository plugin."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen

from plugins.dashboard_auth.basic import hash_password
from hermes_cli.profiles import create_profile
import hermes_yaml as yaml
from support import listeners

state = Path('/fixtures')
credentials = json.loads((state / 'credentials.json').read_text())
home = Path(os.environ['HERMES_HOME'])
home.mkdir(parents=True, exist_ok=True)
logs = state / 'logs'
logs.mkdir(exist_ok=True)
for path in ('ports-before.json', 'ports-after.json'):
    (state / path).unlink(missing_ok=True)
config = {
    'model': {'default': 'fake-harness', 'provider': 'custom', 'base_url': 'http://fake-openai:8000/v1'},
    'gateway': {'multiplex_profiles': True}, 'plugins': {'enabled': []},
    'dashboard': {'basic_auth': {'username': credentials['username'],
                                'password_hash': hash_password(credentials['password']),
                                'secret': credentials['signing_key']}},
    'terminal': {'backend': 'local'}, 'platform_toolsets': {'api_server': ['terminal']},
    'approvals': {'mode': 'manual', 'timeout': 60},
}
config.update(json.loads(os.environ.get('HARNESS_EXTRA_CONFIG') or '{}'))  # D-007 screen harness: e.g. the screen's memory floor
(home / 'config.yaml').write_text(yaml.safe_dump(config))
profile = home / 'profiles/vendas'
if not profile.exists():
    profile = create_profile('vendas', no_alias=True, no_skills=True)
(profile / 'config.yaml').write_text(yaml.safe_dump(config))
for directory, key in ((home, credentials['api_key']), (profile, credentials['vendas_api_key'])):
    (directory / '.env').write_text('API_SERVER_KEY=' + key + '\nAPI_SERVER_HOST=0.0.0.0\nAPI_SERVER_PORT=8642\n'
                                  'OPENAI_API_KEY=' + key + '\nOPENAI_BASE_URL=http://fake-openai:8000/v1\n'
                                  'LUVE_TEST_CANARY=' + credentials['extra_canary'] + '\n')
    (directory / '.env').chmod(0o600)

processes = []
streams = []
exit_status = 0


def stop(*_):
    for process in processes:
        if process.poll() is None:
            process.terminate()
    for process in processes:
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
    for stream in streams:
        stream.close()
    sys.exit(exit_status)


for signum in (signal.SIGTERM, signal.SIGINT):
    signal.signal(signum, stop)


def launch(arguments, log_name):
    stream = (logs / log_name).open('w')
    streams.append(stream)
    process = subprocess.Popen([sys.executable, *arguments], stdout=stream, stderr=subprocess.STDOUT)
    processes.append(process)
    return process


def wait_dashboard():
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            with urlopen('http://127.0.0.1:9119/api/health', timeout=2) as response:
                if response.status == 200:
                    return
        except (URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(1)
    raise RuntimeError('Hermes dashboard failed to start; see isolated logs')


gateway = launch(['-m', 'gateway.run'], 'gateway.log')
dashboard_args = ['-m', 'hermes_cli.main', 'dashboard', '--host', '0.0.0.0', '--port', '9119', '--no-open']
baseline = launch(dashboard_args, 'dashboard-before.log')
wait_dashboard()
# Wait for the REAL API Server listener too, then record the disabled-plugin baseline.
from socket import create_connection
for _ in range(180):
    try:
        with create_connection(('127.0.0.1', 8642), timeout=1):
            break
    except OSError:
        time.sleep(1)
else:
    raise RuntimeError('Hermes API Server failed to start')
(state / 'ports-before.json').write_text(json.dumps(listeners()))
baseline.terminate()
baseline.wait(timeout=20)
processes.remove(baseline)
config['plugins']['enabled'] = ['luvebot']
for directory in (home, profile):
    (directory / 'config.yaml').write_text(yaml.safe_dump(config))
# ADR-003: the plugin source for the Bots' rules hook. The repository is a read-only bind mount whose hermes-plugin/ may
# hold uncommitted work, and Hermes installs plugins from a git commit, so the harness snapshots that folder into a
# throwaway git repository and names it for the dashboard (the operator override LUVEBOT_HOOK_SOURCE; never a client value).
hook_source = Path('/opt/luvebot-hook-src')
shutil.rmtree(hook_source, ignore_errors=True)
shutil.copytree('/root/.hermes/plugins/luvebot/hermes-plugin', hook_source / 'hermes-plugin')
for git_args in (['init', '-q'], ['add', '-A'], ['-c', 'user.name=harness', '-c', 'user.email=harness@test', 'commit', '-qm', 'snapshot']):
    subprocess.run(['git', *git_args], cwd=hook_source, check=True)
os.environ['LUVEBOT_HOOK_SOURCE'] = 'file://' + str(hook_source)
# Source is the repository bind mount, read-only; no generated spike is installed.
dashboard = launch(dashboard_args, 'dashboard.log')
wait_dashboard()


def install_hooks_and_wait(names):
    """Setup, not a test: give every pre-existing Bot its rules hook through the product's own route, as a human would
    (password login, CSRF, POST /bots/{bot}/hook/install), and wait until each hook reports live."""
    import http.cookiejar
    import urllib.request
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    base = 'http://127.0.0.1:9119'

    def call(path, body=None, method=None, headers=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(base + path, data=data, method=method,
                                         headers={'Content-Type': 'application/json', **(headers or {})})
        with opener.open(request, timeout=180) as response:
            return json.loads(response.read() or b'{}')

    call('/auth/password-login', {'provider': 'basic', 'username': credentials['username'],
                                  'password': credentials['password'], 'next': '/'})
    csrf = call('/api/plugins/luvebot/session')['csrf']
    for name in names:
        call(f'/api/plugins/luvebot/bots/{name}/hook/install', method='POST', headers={'X-LuveBot-CSRF': csrf})
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        bots = {b['name']: b for b in call('/api/plugins/luvebot/bots')['bots']}
        if all((bots.get(n, {}).get('hook') or {}).get('status') == 'live' for n in names):
            return
        time.sleep(2)
    raise RuntimeError('the rules hook did not become live for ' + ', '.join(names))


install_hooks_and_wait(['default', 'vendas'])
(state / 'ports-after.json').write_text(json.dumps(listeners()))
(state / 'gateway-pid.txt').write_text(str(gateway.pid))
print('REAL Hermes: repository plugin luvebot; gate enabled; distinct profile keys; listeners recorded')
while all(process.poll() is None for process in processes):
    time.sleep(1)
exit_status = 1
print('Hermes process exited; inspect isolated harness logs')
stop()
