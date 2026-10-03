"""Host-stdlib mutation runner for the approval routes (T3.3). Only /tmp overlays change; the repository stays read-only.

Each mutation replaces dashboard/plugin_api.py in the container with a deliberately broken copy, recreates Hermes, runs ONE
test and requires it to FAIL:
  csrf      _human() no longer demands the CSRF proof          -> red team 4: a session without it can decide
  loopback  _human() no longer refuses decisions in loopback   -> D-012: the machine token can decide
  gate      the route no longer builds a HUMAN actor from the session (a SYSTEM actor is used) -> red team 4
"""
import json
import os
from pathlib import Path
import subprocess

harness = Path(__file__).resolve().parent
repo = harness.parents[1]
original = (repo / 'dashboard/plugin_api.py').read_text()
state = Path(os.environ.get('HARNESS_STATE', '/tmp/luvebot-harness'))
evidence = state / 'evidence'
evidence.mkdir(parents=True, exist_ok=True)
overlay_dir = Path('/tmp/luvebot-t33-mutations')
overlay_dir.mkdir(exist_ok=True)
base = ['docker', 'compose', '-f', str(harness / 'compose.yaml')]
CSRF = "    actor, credential, mode = _identity(request)\n    _require_csrf(request, credential)\n    if mode == 'loopback' and os.environ.get"
LOOP = "    if mode == 'loopback' and os.environ.get('LUVEBOT_ALLOW_LOOPBACK_APPROVALS') != '1':"
ACTOR = "this dashboard is in loopback mode.', 403)\n    return rules.Actor(rules.ActorKind.HUMAN, actor)\n"
for needle in (CSRF, LOOP, ACTOR):
    assert original.count(needle) == 1, needle
mutations = {
    'csrf': ('rt4_the_agent_cannot', original.replace(CSRF, "    actor, credential, mode = _identity(request)\n    if mode == 'loopback' and os.environ.get")),
    'loopback': ('loopback_refuses', original.replace(LOOP, "    if False:")),
    'gate': ('rt4_the_agent_cannot', original.replace(ACTOR, "this dashboard is in loopback mode.', 403)\n    return rules.Actor(rules.ActorKind.SYSTEM, actor)\n")),
}
ok = False
try:
    for name, (test, source_text) in mutations.items():
        assert source_text != original
        source = overlay_dir / (name + '.py')
        source.write_text(source_text)
        override = overlay_dir / (name + '.yaml')
        override.write_text(json.dumps({'services': {'hermes': {'volumes': [
            str(source) + ':/root/.hermes/plugins/luvebot/dashboard/plugin_api.py:ro']}}}))
        compose = base + ['-f', str(override)]
        subprocess.run(compose + ['up', '-d', '--force-recreate', 'hermes'], check=True)
        with (evidence / ('mutation-approvals-' + name + '.txt')).open('w') as output:
            result = subprocess.run(compose + ['exec', '-T', 'hermes', 'python', '-m', 'pytest', '-c', '/dev/null', '-s', '-v',
                '/root/.hermes/plugins/luvebot/tests/invariants/test_approvals.py', '-k', test, '-p', 'no:cacheprovider',
                '--basetemp=/tmp/t33-mutation-' + name], stdout=output, stderr=subprocess.STDOUT)
        text = (evidence / ('mutation-approvals-' + name + '.txt')).read_text()
        if result.returncode != 1 or '1 failed' not in text or 'ERROR' in text:
            raise RuntimeError('Mutation did not fail the intended test: ' + name)
        print(name + ': intended test red (pytest exit 1)', flush=True)
    ok = True
finally:
    subprocess.run(base + ['up', '-d', '--force-recreate', 'hermes'], check=True)  # drop the overlay
if ok:
    print('Mutations red; the read-only repository plugin restored', flush=True)
