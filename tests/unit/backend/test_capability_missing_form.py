"""Red team F10 (cross review 2): `capability_missing` names its feature in ONE form, `feature` at the top of the error (the form of /health
`problems` and of contract v0.8/v0.9), never also under `details.feature`. The test reads the source of every place that raises it."""
from pathlib import Path
import re

import pytest

ROOT = Path(__file__).resolve().parents[3]
SOURCES = sorted((ROOT / 'backend').glob('*.py')) + [ROOT / 'dashboard' / 'plugin_api.py']
RAISE = re.compile(r"^.*capability_missing['\"].*(?:\n.*){0,2}", re.M)


def forms(text):
    """-> (how many places raise capability_missing, the ones that put the feature under `details`)."""
    found = [m.group(0) for m in RAISE.finditer(text)]
    return len(found), [f for f in found if 'details' in f or re.search(r"_details\(['\"]capability_missing", f)]


def test_every_capability_missing_names_its_feature_at_the_top():
    total = bad = 0
    for path in SOURCES:
        n, wrong = forms(path.read_text())
        total, bad = total + n, bad + len(wrong)
    assert total >= 10 and bad == 0, bad


@pytest.mark.parametrize('name,old,new', [
    ('backend/skills.py', "409, {'feature': 'skills'})", "409, {'details': {'feature': 'skills'}})"),
    ('dashboard/plugin_api.py', "409, {'feature': 'attachments'})", "409, {'details': {'feature': 'attachments'}})"),
    ('backend/pages.py', "raise Refused('capability_missing', 'This Hermes cannot save pages.', 409, {'feature': 'pages_write'})",
     "raise _details('capability_missing', 'This Hermes cannot save pages.', 409, feature='pages_write')"),
], ids=['skills', 'attachments', 'pages'])
def test_each_second_form_is_caught(name, old, new):
    source = (ROOT / name).read_text()
    assert source.count(old) >= 1, old
    assert forms(source.replace(old, new))[1], 'the second form went unnoticed'
