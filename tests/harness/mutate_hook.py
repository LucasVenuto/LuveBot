"""Host-stdlib mutation runner for the Bot rules hook (T3.0e). Only /tmp overlays change; the repository stays read-only.

Each mutation replaces backend/hook.py in the container with a deliberately broken copy, recreates Hermes (the harness
entrypoint installs the hook in the existing Bots by the product's own route), runs ONE test and requires it to FAIL:
  gate    hook_gate lets everything through      -> the run on a Bot without the hook is no longer refused with 409
  scope   install ignores config_write_scope     -> installing for one Bot no longer lands in that Bot's profile (H-3)
"""
import os
from pathlib import Path
import subprocess
import json

harness = Path(__file__).resolve().parent
repo = harness.parents[1]
original = (repo / 'backend/hook.py').read_text()
state = Path(os.environ.get('HARNESS_STATE', '/tmp/luvebot-harness'))
evidence = state / 'evidence'
evidence.mkdir(parents=True, exist_ok=True)
overlay_dir = Path('/tmp/luvebot-t30e-mutations')
overlay_dir.mkdir(exist_ok=True)
base = ['docker', 'compose', '-f', str(harness / 'compose.yaml')]
GATE_OLD = "    state = hook_state(path, profile)\n    if state['status'] in ('live', 'disabled_pending_restart'):\n        return\n"
SCOPE_OLD = "        with config_write_scope(profile):\n"
assert original.count(GATE_OLD) == 1 and original.count(SCOPE_OLD) == 1
mutations = {
    'gate': ('h4_reload', "    return  # MUTATION: the gate lets everything through\n" + GATE_OLD),
    'scope': ('h3_installing', "import contextlib\n"),
}
sources = {
    'gate': original.replace(GATE_OLD, mutations['gate'][1]),
    # only the Bots the harness setup installs keep their scope, so the container still comes up; any other Bot lands in the launch profile
    'scope': original.replace(SCOPE_OLD, "        with (config_write_scope(profile) if profile in ('default', 'vendas') else contextlib.nullcontext()):\n")
                     .replace("import os\n", "import contextlib\nimport os\n", 1),
}
ok = False
try:
    for name, (test, _) in mutations.items():
        source = overlay_dir / (name + '.py')
        source.write_text(sources[name])
        assert source.read_text() != original
        override = overlay_dir / (name + '.yaml')
        override.write_text(json.dumps({'services': {'hermes': {'volumes': [
            str(source) + ':/root/.hermes/plugins/luvebot/backend/hook.py:ro']}}}))
        compose = base + ['-f', str(override)]
        subprocess.run(compose + ['up', '-d', '--force-recreate', 'hermes'], check=True)
        with (evidence / ('mutation-hook-' + name + '.txt')).open('w') as output:
            result = subprocess.run(compose + ['exec', '-T', 'hermes', 'python', '-m', 'pytest', '-c', '/dev/null', '-s', '-v',
                '/root/.hermes/plugins/luvebot/tests/invariants/test_hook.py', '-k', test, '-p', 'no:cacheprovider',
                '--basetemp=/tmp/t30e-mutation-' + name], stdout=output, stderr=subprocess.STDOUT)
        text = (evidence / ('mutation-hook-' + name + '.txt')).read_text()
        if result.returncode != 1 or '1 failed' not in text or 'ERROR' in text:
            raise RuntimeError('Mutation did not fail the intended test: ' + name)
        print(name + ': intended test red (pytest exit 1)', flush=True)
    ok = True
finally:
    subprocess.run(base + ['up', '-d', '--force-recreate', 'hermes'], check=True)  # drop the overlay: the repository source again
if ok:
    print('Mutations red; the read-only repository backend restored', flush=True)
