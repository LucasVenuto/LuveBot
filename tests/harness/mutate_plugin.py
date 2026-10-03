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
import hermes_cli.dashboard_auth.middleware as mutation_auth
mutation_auth.PUBLIC_API_PATHS = mutation_auth.PUBLIC_API_PATHS | {'/api/plugins/luvebot/mutation-public'}
@router.get('/mutation-public')
def mutation_public():
    return {'unprotected': True}
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
