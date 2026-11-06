"""Host-stdlib mutation runner for T10.3 (an honest /health). One deliberate defect per run, mounted over the read-only repository
file; Hermes is recreated, the test runs, and it must FAIL. The repository itself is never modified.

  approvals_ignore_hook   approvals are "ok" whenever the API Server runs, whatever the Bot's hook says
  unreadable_is_ok        a hook state that cannot be read counts as available
  groups_hardcoded        Group Chat is reported "unknown" again without asking groups.capabilities (the VPS finding)
  driver_truthy           any truthy `driver` value (not only true) counts as a running Group Chat
  transport_unavailable   approval_transport is "unavailable" again, as if approvals could not work
"""

import json
import os
from pathlib import Path
import subprocess

harness = Path(__file__).resolve().parent
repo = harness.parents[1]
overlay_dir = Path('/tmp/luvebot-t103-mutations')
overlay_dir.mkdir(exist_ok=True)
base = ['docker', 'compose', '-f', str(harness / 'compose.yaml')]
PLUGIN = 'dashboard/plugin_api.py'
APPROVALS = "        return 'ok' if hook.hook_state(db_path, name)['status'] in ('live', 'disabled_pending_restart') else 'unavailable'\n"
UNREADABLE = "        return 'ok' if hook.hook_state(db_path, name)['status'] in ('live', 'disabled_pending_restart') else 'unavailable'\n    except Exception:\n        return 'unknown'\n"
DRIVER = "    return 'ok' if isinstance(result, dict) and result.get('driver') is True else 'unavailable'\n"
mutations = {
    'approvals_ignore_hook': ('approvals_follow', [(PLUGIN, APPROVALS, "        return 'ok'\n")]),
    'unreadable_is_ok': ('approvals_follow', [(PLUGIN, UNREADABLE, UNREADABLE.replace("return 'unknown'", "return 'ok'"))]),
    'groups_hardcoded': ('group_chat', [(PLUGIN, "    features['groups'] = await _groups_state()\n", "    features['groups'] = 'unknown'\n")]),
    'driver_truthy': ('group_chat', [(PLUGIN, DRIVER, DRIVER.replace(" is True", ""))]),
    'transport_unavailable': ('real_health', [(PLUGIN, "    features['approval_transport'] = 'not_used'\n", "    features['approval_transport'] = 'unavailable'\n")]),
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
        target = Path(os.environ.get('HARNESS_STATE', '/tmp/luvebot-harness')) / 'evidence' / f'mutation-health-{name}.txt'
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('w') as output:
            result = subprocess.run(compose + ['exec', '-T', 'hermes', 'python', '-m', 'pytest', '-c', '/dev/null', '-s', '-v',
                '/root/.hermes/plugins/luvebot/tests/invariants/test_health.py', '-k', test, '-p', 'no:cacheprovider',
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
