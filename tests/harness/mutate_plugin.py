"""Host-stdlib mutation runner. Only /tmp overlays change; repository stays read-only."""
import json
import os
from pathlib import Path
import subprocess
import sys

harness = Path(__file__).resolve().parent
repo = harness.parents[1]
original = (repo / 'dashboard/plugin_api.py').read_text()
state = Path(os.environ.get('HARNESS_STATE', '/tmp/luvebot-harness'))
evidence = state / 'evidence'
evidence.mkdir(parents=True, exist_ok=True)
mutation_dir = Path('/tmp/luvebot-t11-mutations')
mutation_dir.mkdir(exist_ok=True)
base = ['docker', 'compose', '-f', str(harness / 'compose.yaml')]
mutations = {
    'secret': ('test_no_secret', '''
from agent.secret_scope import get_secret
@router.get('/mutation-leak')
def mutation_leak():
    return {'leak': get_secret('API_SERVER_KEY')}
'''),
    'auth': ('test_all_discovered', '''
# a route of the plugin is behind two gates that do not know each other: the dashboard's login (Hermes) and `SafeRoute` (ours: `_identity` before every handler of the router). The test asks every
# route without a session and wants 401, so it can only see an unprotected route when BOTH let one through: the path is made public in every place Hermes keeps its set (the auth middleware and
# web_server each bind it at import), and the route is added on a plain APIRoute, so `SafeRoute` never runs on it.
import sys
from fastapi.routing import APIRoute as MutationRoute
import hermes_cli.dashboard_auth.middleware as mutation_auth
for mutation_module, mutation_names in ((mutation_auth, ('PUBLIC_API_PATHS',)), (sys.modules.get('hermes_cli.web_server'), ('_PUBLIC_API_PATHS', 'PUBLIC_API_PATHS'))):
    for mutation_name in mutation_names:
        if mutation_module is not None and hasattr(mutation_module, mutation_name):
            setattr(mutation_module, mutation_name, getattr(mutation_module, mutation_name) | {'/api/plugins/luvebot/mutation-public'})
def mutation_public():
    return {'unprotected': True}
router.add_api_route('/mutation-public', mutation_public, methods=['GET'], route_class_override=MutationRoute)
'''),
    'port': ('test_plugin_opens_no', '''
import socket
mutation_listener = socket.socket()
mutation_listener.bind(('127.0.0.1', 9127))
mutation_listener.listen(1)
'''),
}
expected_failure = False
try:
    for name, (test, addition) in mutations.items():
        if os.environ.get('ONLY') and name not in os.environ['ONLY'].split(','):
            continue
        source = mutation_dir / (name + '.py')
        source.write_text(original + addition)
        override = mutation_dir / (name + '.yaml')
        # JSON is a valid YAML document. No interpolation or credentials in shell commands.
        override.write_text(json.dumps({'services': {'hermes': {'volumes': [
            str(source) + ':/root/.hermes/plugins/luvebot/dashboard/plugin_api.py:ro']}}}))
        compose = base + ['-f', str(override)]
        subprocess.run(compose + ['up', '-d', '--force-recreate', 'hermes'], check=True)
        with (evidence / ('mutation-' + name + '.txt')).open('w') as output:
            result = subprocess.run(compose + ['exec', '-T', 'hermes', 'python', '-m', 'pytest', '-c', '/dev/null',
                '-s', '-v', '/root/.hermes/plugins/luvebot/tests/invariants/test_plugin.py', '-k', test,
                '-p', 'no:cacheprovider', '--basetemp=/tmp/t11-mutation-' + name], stdout=output, stderr=subprocess.STDOUT)
        text = (evidence / ('mutation-' + name + '.txt')).read_text()
        # Collection/setup errors are not successful mutation evidence.
        if result.returncode != 1 or '1 failed' not in text or 'ERROR' in text:
            raise RuntimeError('Mutation did not fail the intended invariant: ' + name)
        print(name + ': intended invariant red (pytest exit 1)', flush=True)
    expected_failure = True
finally:
    # Drop file overlay; production source on the host is never edited.
    subprocess.run(base + ['up', '-d', '--force-recreate', 'hermes'], check=True)
if expected_failure:
    print('Three mutations red; real read-only repository plugin restored', flush=True)
