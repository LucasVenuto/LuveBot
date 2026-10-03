"""Host-stdlib mutation runner for the rules routes (T3.4). Only /tmp overlays change; the repository stays read-only.

Each mutation replaces dashboard/plugin_api.py in the container with a deliberately broken copy, recreates Hermes, runs ONE
test and requires it to FAIL:
  loopback  activation no longer needs the login-mode gate (D-012)   -> the machine token could activate a rule
  seal      every active rule's seal is a lock whatever Hermes says   -> red team 8 (a lying seal)
  unverified a stored ACTIVE row is trusted without its activation   -> E
  archive   archiving an ACTIVE rule goes back through _human_actor  -> the machine token could loosen a rule (red team F2)
LUVEBOT_COMPOSE_OVERRIDE=<file.yml> adds a compose file (e.g. a worktree mounted as the plugin).
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
overlay_dir = Path('/tmp/luvebot-t34-mutations')
overlay_dir.mkdir(exist_ok=True)
base = ['docker', 'compose', '-f', str(harness / 'compose.yaml')]
if os.environ.get('LUVEBOT_COMPOSE_OVERRIDE'):
    base += ['-f', os.environ['LUVEBOT_COMPOSE_OVERRIDE']]
LOOP = "    human = _human(request) if fields['state'] == 'active' else _human_actor(request)\n"
SEAL = "        per_bot[bot] = _BROKEN_STATE if read is None else rules_service.seal_for(path, rule, bot, read[0])\n"
TRUST = "    if not trusted:\n        return rules_service.untrusted_seal()\n"
ARCHIVE = "    if fields['state'] == 'archived' and current.state is rules.RuleState.ACTIVE:\n        human = _human(request)"
for needle in (LOOP, SEAL, TRUST, ARCHIVE):
    assert original.count(needle) == 1, needle
mutations = {
    'loopback': ('activation_needs_a_human', original.replace(LOOP, "    human = _human_actor(request)\n")),
    'seal': ('rt8_a_lock_that_the_world', original.replace(SEAL, "        per_bot[bot] = rules.SealResult(rules.Seal.LOCK, (), (), ())\n")),
    'unverified': ('row_written_active_by_hand', original.replace(TRUST, "    if False:\n        return rules_service.untrusted_seal()\n")),
    'archive': ('loopback_cannot_archive_an_active_rule', original.replace(ARCHIVE, "    if False:\n        human = _human(request)")),
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
        with (evidence / ('mutation-rules-api-' + name + '.txt')).open('w') as output:
            result = subprocess.run(compose + ['exec', '-T', 'hermes', 'python', '-m', 'pytest', '-c', '/dev/null', '-s', '-v',
                '/root/.hermes/plugins/luvebot/tests/invariants/test_rules_api.py', '-k', test, '-p', 'no:cacheprovider',
                '--basetemp=/tmp/t34-mutation-' + name], stdout=output, stderr=subprocess.STDOUT)
        text = (evidence / ('mutation-rules-api-' + name + '.txt')).read_text()
        if result.returncode != 1 or '1 failed' not in text or 'ERROR' in text:
            raise RuntimeError('Mutation did not fail the intended test: ' + name)
        print(name + ': intended test red (pytest exit 1)', flush=True)
    ok = True
finally:
    subprocess.run(base + ['up', '-d', '--force-recreate', 'hermes'], check=True)  # drop the overlay
if ok:
    print('Mutations red; the read-only repository plugin restored', flush=True)
