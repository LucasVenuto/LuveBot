"""Host-stdlib mutation runner for T10.1 (the single target resolver). One deliberate defect per run, mounted over the read-only
repository file; Hermes is recreated, the test runs, and it must FAIL. The repository itself is never modified.

  global_port     the resolver reads the port with get_secret again (the process value, ignoring the profile's .env)
  api_own_target  ApiClient keeps a private copy of the old lookup (REST and SSE go somewhere else than capabilities)
  invalid_falls_back  an explicit value that is not a port silently becomes the default port
"""
import json
import os
from pathlib import Path
import subprocess

harness = Path(__file__).resolve().parent
repo = harness.parents[1]
overlay_dir = Path('/tmp/luvebot-t101-mutations')
overlay_dir.mkdir(exist_ok=True)
base = ['docker', 'compose', '-f', str(harness / 'compose.yaml')]
CLIENT, API = 'backend/hermes_client.py', 'backend/hermes_api.py'
mutations = {
    'global_port': ('go_to_the_port_and_key', [(CLIENT, "                raw_port = scoped.get('API_SERVER_PORT') if scoped is not None else None\n", "                raw_port = None\n")]),
    'api_own_target': ('go_to_the_port_and_key', [(API, "    # `_target()` is inherited: the one resolver of HermesClient (S10), the same for capabilities, REST and streams.\n",
                                         "    def _target(self):\n        from agent.secret_scope import get_secret\n        from hermes_cli.web_server_profiles import _config_profile_scope\n        with _config_profile_scope(self.profile):\n            return int(get_secret('API_SERVER_PORT', '8642')), get_secret('API_SERVER_KEY', '')\n")]),
    'invalid_falls_back': ('explicit_value_that_is_not_a_port', [(CLIENT, "        if not key or not isinstance(raw_port, str) or not re.fullmatch(r'[0-9]{1,5}', raw_port.strip()):\n            raise HermesError('hermes_unreachable')\n",
                                              "        if not key:\n            raise HermesError('hermes_unreachable')\n        if not isinstance(raw_port, str) or not re.fullmatch(r'[0-9]{1,5}', raw_port.strip()):\n            raw_port = DEFAULT_PORT\n")]),
}
only = os.environ.get('ONLY')
ok = False
try:
    for name, (test, edits) in mutations.items():
        if only and name not in only.split(','):
            continue
        texts, mounts = {}, []
        for relative, old, new in edits:
            text = texts.setdefault(relative, (repo / relative).read_text())
            assert text.count(old) == 1, (name, old)
            texts[relative] = text.replace(old, new)
        for index, (relative, text) in enumerate(texts.items()):
            source = overlay_dir / f'{name}-{index}.py'
            source.write_text(text)
            mounts.append(f'{source}:/root/.hermes/plugins/luvebot/{relative}:ro')
        override = overlay_dir / (name + '.yaml')
        override.write_text(json.dumps({'services': {'hermes': {'volumes': mounts}}}))
        compose = base + ['-f', str(override)]
        subprocess.run(compose + ['up', '-d', '--force-recreate', 'hermes'], check=True)
        for _ in range(120):
            probe = subprocess.run(compose + ['exec', '-T', 'hermes', 'python', '-c',
                                              "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:9119/api/status',timeout=2);assert os.path.exists('/fixtures/ports-after.json')"],
                                   capture_output=True)
            if probe.returncode == 0:
                break
            subprocess.run(['sleep', '2'])
        subprocess.run(['sleep', '40'])
        target = Path(os.environ.get('HARNESS_STATE', '/tmp/luvebot-harness')) / 'evidence' / f'mutation-target-{name}.txt'
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('w') as output:
            result = subprocess.run(compose + ['exec', '-T', 'hermes', 'python', '-m', 'pytest', '-c', '/dev/null', '-s', '-v',
                '/root/.hermes/plugins/luvebot/tests/invariants/test_target.py', '-k', test, '-p', 'no:cacheprovider',
                '--basetemp=/tmp/t101-' + name], stdout=output, stderr=subprocess.STDOUT)
        text = target.read_text()
        if result.returncode != 1 or ' failed' not in text or 'ERROR' in text:
            raise RuntimeError('Mutation did not fail the intended test: ' + name)
        print(name + ': intended test red (pytest exit 1)', flush=True)
    ok = True
finally:
    subprocess.run(base + ['up', '-d', '--force-recreate', 'hermes'], check=True)
if ok:
    print('Mutations red; the read-only repository plugin restored', flush=True)
