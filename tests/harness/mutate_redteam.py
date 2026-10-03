"""T3.5 host-stdlib runner: two real Docker overlays, no repository product writes.

Reserve the shared harness with Lume before invoking. Output stays in /tmp by default.
This runner first demands a GREEN native malformed-Host control and RT13 export test, then
breaks each respectively. It never counts an already-red baseline as mutation evidence.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--only', choices=('rt12', 'rt13'))
    args = parser.parse_args()
    harness = Path(__file__).resolve().parent
    repo = harness.parents[1]
    product = repo / 'dashboard/plugin_api.py'
    original = product.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    state = Path(os.environ.get('HARNESS_STATE', '/tmp/luvebot-harness'))
    evidence = state / 'evidence/t35'
    evidence.mkdir(parents=True, exist_ok=True)
    overlays = Path('/tmp/luvebot-t35-mutations')
    overlays.mkdir(exist_ok=True)
    base = ['docker', 'compose', '-f', str(harness / 'compose.yaml')]
    testfile = '/root/.hermes/plugins/luvebot/tests/invariants/test_redteam_12_13.py'

    def pytest_run(compose, name, selected):
        junit = evidence / (name + '.xml')
        command = compose + ['exec', '-T', 'hermes', 'python', '-m', 'pytest', '-c', '/dev/null',
                            '-s', '-v', testfile, '-k', selected, '-p', 'no:cacheprovider',
                            '--basetemp=/tmp/t35-' + name,
                            '--junitxml=/fixtures/evidence/t35/' + junit.name]
        (evidence / (name + '-command.json')).write_text(json.dumps(command, indent=2))
        junit.unlink(missing_ok=True)
        with (evidence / (name + '.txt')).open('w') as output:
            result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT)
        if not junit.exists():
            raise RuntimeError('No real pytest JUnit result: ' + name)
        suites = ET.parse(junit).getroot().findall('.//testsuite')
        counts = {key: sum(int(s.get(key, '0')) for s in suites)
                  for key in ('tests', 'failures', 'errors', 'skipped')}
        counts['passed'] = counts['tests'] - counts['failures'] - counts['errors'] - counts['skipped']
        print(name + ': ' + json.dumps(counts) + '; exit=' + str(result.returncode), flush=True)
        return result.returncode, counts

    code, counts = pytest_run(base, 'mutation-baseline', 'invalid_authority or rt13')
    if code != 0 or counts != {'tests': 2, 'failures': 0, 'errors': 0, 'skipped': 0, 'passed': 2}:
        raise RuntimeError('Mutation controls must both pass against unmodified real Hermes')
    additions = {
        'rt12': ('foreign_host_origin', '''
# MUTATION: remove the plugin router's own Host/Origin guard (the dashboard's wildcard bind accepts any Host).
_foreign_request = lambda _request: None
'''),
        'rt13': ('rt13', '''
# MUTATION: contaminate actual exported template content with the local API Server URL.
TEMPLATES[0]['soul'] += '\\nInternal API: http://127.0.0.1:8642/p/default/v1/capabilities'
'''),
    }
    try:
        for name, (selected, addition) in additions.items():
            if args.only and args.only != name:
                continue
            source = overlays / (name + '.py')
            source.write_bytes(original + addition.encode())
            override = overlays / (name + '.yaml')
            override.write_text(json.dumps({'services': {'hermes': {'volumes': [
                str(source) + ':/root/.hermes/plugins/luvebot/dashboard/plugin_api.py:ro']}}}))
            compose = base + ['-f', str(override)]
            subprocess.run(compose + ['up', '-d', '--force-recreate', 'hermes'], check=True)
            code, counts = pytest_run(compose, 'mutation-' + name, selected)
            expected = 4 if name == 'rt12' else 1  # the RT12 test runs for four vectors: host, origin, host_and_origin, null_origin
            if code != 1 or counts != {'tests': expected, 'failures': expected, 'errors': 0, 'skipped': 0, 'passed': 0}:
                raise RuntimeError('Overlay did not fail exactly the intended test: ' + name)
            print(name + ': genuine green-to-red mutation', flush=True)
    finally:
        subprocess.run(base + ['up', '-d', '--force-recreate', 'hermes'], check=True)
        if hashlib.sha256(product.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Product source changed during reservation; inspect concurrent writes')
        print('Repository plugin restored; product source SHA-256 unchanged', flush=True)
    code, counts = pytest_run(base, 'mutation-restored', 'invalid_authority or rt13')
    if code != 0 or counts != {'tests': 2, 'failures': 0, 'errors': 0, 'skipped': 0, 'passed': 2}:
        raise RuntimeError('Restored real plugin did not pass both controls')


if __name__ == '__main__':
    main()
