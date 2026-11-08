"""Host-stdlib mutation runner for the D-007 screen harness. One deliberate defect per run, mounted over the read-only repository
file; Hermes is recreated, test_screen_live.py runs, and the NAMED step must fail. The repository itself is never modified.

  watch_takes        watching also takes the lease: a watcher drives the screen
  take_no_acquire    take hands out a ticket but never acquires the lease: the person's input is dropped
  stop_forces        stop ignores the person holding control and forces
  return_no_release  return forgets the viewer but never releases the lease: the agent stays locked out
  reconcile_off      a hand-back by Hermes (clean close) leaves no screen.return row
"""
import json
import os
from pathlib import Path
import subprocess

here = Path(__file__).resolve().parent
repo = here.parents[2]
state = Path(os.environ.get('DISPLAY_STATE', '/tmp/luvebot-display'))
overlay_dir = Path('/tmp/luvebot-d007-mutations')
overlay_dir.mkdir(exist_ok=True)
base = ['docker', 'compose', '-p', 'luvebot-display', '-f', str(here / 'compose.yaml')]
SCREEN = 'backend/screen.py'
OBSERVE = "            return await call('display.observe', {'profile': bot})\n        try:\n            observed = self.runner(run)\n"
ACQUIRE = "                acquired = await call('display.lease.acquire', {'profile': bot, 'viewer_id': observed['viewer_id'], 'reason': note})\n"
HUMAN = "        if (st.get('lease') or {}).get('holder') == 'human':\n            raise PluginError('screen_in_use'"
RELEASE = "            released = self.runner(run)\n"
RECONCILE = "        done = []\n        for row in self.viewers():\n"
mutations = {
    'watch_takes': ('test_02', [(SCREEN, OBSERVE, OBSERVE.replace(
        "            return await call('display.observe', {'profile': bot})\n",
        "            o = await call('display.observe', {'profile': bot})\n"
        "            await call('display.lease.acquire', {'profile': bot, 'viewer_id': o['viewer_id'], 'reason': 'mutation'})\n"
        "            return o\n"))]),
    'take_no_acquire': ('test_05', [(SCREEN, ACQUIRE, "                acquired = {'lease': {'holder': 'human'}}\n")]),
    'stop_forces': ('test_06', [(SCREEN, HUMAN, "        if False:\n            raise PluginError('screen_in_use'"),
                                (SCREEN, "call('display.stop', {'profile': bot})", "call('display.stop', {'profile': bot, 'force': True})")]),
    'return_no_release': ('test_08', [(SCREEN, RELEASE, "            released = {'lease': {'holder': 'agent'}}\n")]),
    'reconcile_off': ('test_09', [(SCREEN, RECONCILE, "        done = []\n        for row in []:\n")]),
}


def wait_ready(compose):
    for _ in range(120):
        probe = subprocess.run(compose + ['exec', '-T', 'hermes', 'python', '-c',
                                          "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:9119/api/health',timeout=2);"
                                          "assert os.path.exists('/fixtures/ports-after.json')"], capture_output=True)
        if probe.returncode == 0:
            return
        subprocess.run(['sleep', '3'])
    raise RuntimeError('the screen harness did not come up')


only = os.environ.get('ONLY')
ok = False
try:
    for name, (step, edits) in mutations.items():
        if only and name not in only.split(','):
            continue
        texts = {}
        for relative, old, new in edits:
            text = texts.setdefault(relative, (repo / relative).read_text())
            assert text.count(old) == 1, (name, old)
            texts[relative] = text.replace(old, new)
        mounts = []
        for index, (relative, text) in enumerate(texts.items()):
            source = overlay_dir / f'{name}-{index}.py'
            source.write_text(text)
            mounts.append(f'{source}:/root/.hermes/plugins/luvebot/{relative}:ro')
        override = overlay_dir / (name + '.yaml')
        override.write_text(json.dumps({'services': {'hermes': {'volumes': mounts}}}))
        compose = base + ['-f', str(override)]
        (state / 'ports-after.json').unlink(missing_ok=True)
        subprocess.run(compose + ['up', '-d', '--force-recreate', 'hermes'], check=True)
        wait_ready(compose)
        target = state / 'evidence' / f'mutation-screen-{name}.txt'
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('w') as output:
            result = subprocess.run(compose + ['exec', '-T', 'hermes', 'python', '-m', 'pytest', '-c', '/dev/null', '-p', 'no:cacheprovider',
                                               '-s', '-v', '--basetemp=/tmp/d007-' + name,
                                               '/root/.hermes/plugins/luvebot/tests/harness/display/test_screen_live.py'],
                                    stdout=output, stderr=subprocess.STDOUT)
        text = target.read_text()
        if result.returncode != 1 or not any(line.startswith('FAILED') and f'::{step}_' in line for line in text.splitlines()):
            raise RuntimeError(f'Mutation did not fail {step}: {name}')
        print(f'{name}: {step} red (pytest exit 1)', flush=True)
    ok = True
finally:
    (state / 'ports-after.json').unlink(missing_ok=True)
    subprocess.run(base + ['up', '-d', '--force-recreate', 'hermes'], check=True)
if ok:
    print('Mutations red; the read-only repository plugin restored', flush=True)
