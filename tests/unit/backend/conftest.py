"""The skill suites run as if PyYAML did not exist: the real Hermes does not ship it (it reads and lists a skill with `hermes_yaml`, which is ruamel), and a unit environment that happened to have it hid a
`409 capability_missing` on every teaching route (SK-2g). `sys.modules['yaml'] = None` makes `import yaml` an ImportError; ruamel.yaml (the version Hermes pins) must be in the environment."""
import sys

import pytest


@pytest.fixture(autouse=True)
def _skill_suites_cannot_import_pyyaml(request, monkeypatch):
    if 'skill' in request.module.__name__:
        monkeypatch.setitem(sys.modules, 'yaml', None)
    yield
