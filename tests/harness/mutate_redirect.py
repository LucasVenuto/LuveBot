"""Host-stdlib mutation runner for T10.4 (the redirect is a dispatch). One deliberate defect per run, mounted over the read-only
repository file; Hermes is recreated, the test runs, and it must FAIL. The repository itself is never modified.

  no_verification     the redirect checks neither the destination's hook nor the creator's compiled table (the finding itself)
  no_origin_check     only the destination's hook is checked: a task made by a Bot with no compiled table is sent on
  no_gate_for_person  a task made by a person skips the destination's hook gate
"""
import json
import os
from pathlib import Path
import subprocess

harness = Path(__file__).resolve().parent
repo = harness.parents[1]
overlay_dir = Path('/tmp/luvebot-t104-mutations')
overlay_dir.mkdir(exist_ok=True)
base = ['docker', 'compose', '-f', str(harness / 'compose.yaml')]
PLUGIN = 'dashboard/plugin_api.py'
CHECK = """        if origin in known_bots:
            _verify_handoff_enforcement(meta.path, origin, target)
        else:
            hook.hook_gate(meta.path, target)
"""
TEST = 't104_a_redirect_is_dispatch'
mutations = {
    'no_verification': (TEST, [(PLUGIN, CHECK, '')]),
    'no_origin_check': (TEST, [(PLUGIN, CHECK, '        hook.hook_gate(meta.path, target)\n')]),
    'no_gate_for_person': (TEST, [(PLUGIN, CHECK, CHECK.replace('            hook.hook_gate(meta.path, target)\n', '            pass\n'))]),
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
        target = Path(os.environ.get('HARNESS_STATE', '/tmp/luvebot-harness')) / 'evidence' / f'mutation-redirect-{name}.txt'
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('w') as output:
            result = subprocess.run(compose + ['exec', '-T', 'hermes', 'python', '-m', 'pytest', '-c', '/dev/null', '-s', '-v',
                '/root/.hermes/plugins/luvebot/tests/invariants/test_activity_actions.py', '-k', test, '-p', 'no:cacheprovider',
                '--basetemp=/tmp/t104-' + name], stdout=output, stderr=subprocess.STDOUT)
        text = target.read_text()
        if result.returncode != 1 or ' failed' not in text or 'ERROR' in text:
            raise RuntimeError('Mutation did not fail the intended test: ' + name)
        print(name + ': intended test red (pytest exit 1)', flush=True)
    ok = True
finally:
    subprocess.run(base + ['up', '-d', '--force-recreate', 'hermes'], check=True)
if ok:
    print('Mutations red; the read-only repository plugin restored', flush=True)
