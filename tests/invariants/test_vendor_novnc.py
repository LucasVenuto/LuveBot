"""THIRD_PARTY_LICENSES.md, "noVNC vendoring terms (D-007)", rule 1: every file in dashboard/vendor/novnc/ is byte-identical to
the npm package of tag v1.7.0 (CHECKSUMS.sha256), nothing is added or missing, the license texts travel with the code, and
noVNC's app/ (CC BY-SA images) is not there. Pure: no Hermes needed."""
import hashlib
from pathlib import Path
import shutil

import pytest

FOLDER = Path(__file__).resolve().parents[2] / 'dashboard' / 'vendor' / 'novnc'
OURS = {'CHECKSUMS.sha256', 'SOURCE'}
LICENSES = ('LICENSE.txt', 'docs/LICENSE.MPL-2.0', 'docs/LICENSE.BSD-3-Clause', 'vendor/pako/LICENSE')


def problems(folder):
    """-> list of what breaks the vendoring terms (empty = conforming)."""
    found = []
    listed = {}
    for line in (folder / 'CHECKSUMS.sha256').read_text().splitlines():
        digest, _, name = line.partition('  ')
        listed[name] = digest
    present = {str(p.relative_to(folder)) for p in folder.rglob('*') if p.is_file()} - OURS
    found += [f'not listed: {n}' for n in sorted(present - set(listed))]
    found += [f'missing: {n}' for n in sorted(set(listed) - present)]
    found += [f'changed: {n}' for n in sorted(set(listed) & present)
              if hashlib.sha256((folder / n).read_bytes()).hexdigest() != listed[n]]
    found += [f'license text missing: {n}' for n in LICENSES if n not in present]
    if (folder / 'app').exists():
        found.append('app/ is vendored')
    source = (folder / 'SOURCE').read_text()
    if 'v1.7.0' not in source or '63107bd06d9e1f6136ff21aeda8cd62cbf0d433e' not in source:
        found.append('SOURCE does not name the tag and commit')
    return found


def test_the_vendored_novnc_is_unmodified_and_complete():
    assert problems(FOLDER) == []
    assert (FOLDER / 'core' / 'rfb.js').is_file() and (FOLDER / 'vendor' / 'pako' / 'lib').is_dir()


@pytest.mark.parametrize('mutation', ['edit one character of core/rfb.js', 'add a file', 'remove a license', 'vendor app/'])
def test_each_breach_of_the_terms_is_caught(tmp_path, mutation):
    copy = tmp_path / 'novnc'
    shutil.copytree(FOLDER, copy)
    if mutation == 'edit one character of core/rfb.js':
        rfb = copy / 'core' / 'rfb.js'
        text = rfb.read_bytes()
        rfb.write_bytes(text[:100] + (b'X' if text[100:101] != b'X' else b'Y') + text[101:])
    elif mutation == 'add a file':
        (copy / 'core' / 'luvebot-patch.js').write_text('// ours')
    elif mutation == 'remove a license':
        (copy / 'docs' / 'LICENSE.MPL-2.0').unlink()
    else:
        (copy / 'app').mkdir()
        (copy / 'app' / 'ui.js').write_text('')
    assert problems(copy), mutation


def test_the_dashboard_bundle_does_not_contain_novnc():
    """Rule 3: loaded by URL, never bundled into our IIFE."""
    bundle = (FOLDER.parents[1] / 'dist' / 'index.js').read_text(errors='replace')
    assert 'noVNC authors' not in bundle and 'class RFB' not in bundle
