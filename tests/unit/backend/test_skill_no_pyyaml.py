"""SK-2g (contract v0.11 3.4, "Amended 2026-10-31"): the real Hermes does not ship PyYAML, so teaching must work without it. The unit tests passed while every teaching route answered `409 capability_missing` on
the real Hermes, because their environment happened to have PyYAML. Four things keep that from coming back:
* a static guard: no module of `backend/` or `dashboard/` imports `yaml` (`import`, `from`, `__import__`, `importlib.import_module`);
* the skill suites run with `yaml` unimportable (a fixture in conftest.py: `sys.modules['yaml'] = None`);
* `feature()` and `need()` probe ruamel and Hermes's routes, never `yaml`;
* without ruamel nothing reads a header: `capability_missing`, never a crash.
Mutations: one line changed -> red."""
import ast
import importlib
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_config_boundary_threads as threads  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
SOURCE = (ROOT / 'backend' / 'skill_teach.py').read_text()
GOOD = 'Use quando precisar enviar o relatório semanal ao cliente.'
ROUTES = ('create_skill', 'get_skill_content', 'get_skills', 'toggle_skill', 'update_skill_content')


def load(edits=()):
    name, _ = threads.package()
    return threads.variant(name, 'skill_teach', edits)


def yaml_imports(source):
    """Where a source imports PyYAML: `import yaml[.x]`, `from yaml[.x] import y`, `__import__('yaml')`, `import_module('yaml[.x]')`. `hermes_yaml` and `ruamel.yaml` are other libraries."""
    found = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found += [alias.name for alias in node.names if alias.name.split('.')[0] == 'yaml']
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and (node.module or '').split('.')[0] == 'yaml':
            found.append(node.module)
        elif isinstance(node, ast.Call):
            callee = node.func.id if isinstance(node.func, ast.Name) else node.func.attr if isinstance(node.func, ast.Attribute) else ''
            if callee in ('__import__', 'import_module') and node.args and isinstance(node.args[0], ast.Constant) and str(node.args[0].value).split('.')[0] == 'yaml':
                found.append('dynamic')
    return found


def test_nothing_in_backend_or_dashboard_imports_pyyaml():
    files = sorted((ROOT / 'backend').rglob('*.py')) + sorted((ROOT / 'dashboard').glob('*.py'))
    assert len(files) > 40
    assert {str(path.relative_to(ROOT)): yaml_imports(path.read_text()) for path in files if yaml_imports(path.read_text())} == {}


@pytest.mark.parametrize('source', ['import yaml', 'import yaml.constructor', 'import os, yaml', 'from yaml import SafeLoader', 'from yaml.constructor import ConstructorError',
                                    "yaml = __import__('yaml')", "import importlib\nimportlib.import_module('yaml')", "importlib.import_module('yaml.constructor')", 'def f():\n    import yaml'])
def test_the_guard_sees_every_way_to_import_pyyaml(source):
    assert yaml_imports(source) != []


@pytest.mark.parametrize('source', ['import hermes_yaml', 'import ruamel.yaml', 'from ruamel import yaml', 'from ruamel.yaml import events', 'from . import yaml', "importlib.import_module('ruamel.yaml')", "name = 'yaml'"])
def test_the_guard_leaves_the_other_libraries_alone(source):
    assert yaml_imports(source) == []


def test_the_skill_suites_cannot_import_pyyaml():
    """The fixture of conftest.py: this module's name says `skill`, so `import yaml` is an ImportError here, whatever the environment has."""
    with pytest.raises(ImportError):
        importlib.import_module('yaml')
    conftest = (Path(__file__).parent / 'conftest.py').read_text()
    assert "'skill' in request.module.__name__" in conftest and "monkeypatch.setitem(sys.modules, 'yaml', None)" in conftest


def hermes_routes(monkeypatch, present=True):
    for name in ('hermes_cli', 'hermes_cli.web_routers'):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    module = types.ModuleType('hermes_cli.web_routers.skills')
    for route in ROUTES:
        setattr(module, route, lambda *args, **kwargs: None)
    monkeypatch.setitem(sys.modules, 'hermes_cli.web_routers.skills', module if present else None)


def without_ruamel(monkeypatch):
    monkeypatch.setitem(sys.modules, 'ruamel.yaml', None)


def checks(m, monkeypatch):
    hermes_routes(monkeypatch)
    assert m.feature() == 'ok'                                                       # no PyYAML, ruamel and Hermes's routes: the exact situation of the real Hermes
    assert m.need() is None
    assert m.dry_run('enviar-relatorio', f'---\nname: enviar-relatorio\ndescription: {GOOD}\n---\ncorpo')['name'] == 'enviar-relatorio'
    with monkeypatch.context() as scoped:
        without_ruamel(scoped)                                                       # no YAML library: unavailable and said so, never a crash
        assert m.feature() == 'unavailable'
        for call in (m.need, lambda: m.dry_run('enviar-relatorio', f'---\nname: enviar-relatorio\ndescription: {GOOD}\n---\ncorpo')):
            try:
                call()
            except m.PluginError as error:
                assert (error.code, error.status, error.extra) == ('capability_missing', 409, {'feature': 'skills'}), error.code
            else:
                raise AssertionError('answered without a YAML library')
    with monkeypatch.context() as scoped:
        hermes_routes(scoped, present=False)                                         # Hermes without the routes: unavailable
        assert m.feature() == 'unavailable'
        try:
            m.need()
        except m.PluginError as error:
            assert error.code == 'capability_missing'
        else:
            raise AssertionError('need() let it through')


def test_feature_and_need_ask_for_ruamel_and_the_routes_and_never_for_yaml(monkeypatch):
    checks(load(), monkeypatch)


MUTATIONS = {
    'feature asks for PyYAML': ("    return 'ok' if _base() is not None else 'unavailable'", "    import yaml  # noqa: F401\n    return 'ok'"),
    'feature does not ask for ruamel': ("    return 'ok' if _base() is not None else 'unavailable'", "    return 'ok'"),
    'feature does not ask for the routes': ("        from hermes_cli.web_routers.skills import create_skill, get_skill_content, get_skills, toggle_skill, update_skill_content  # noqa: F401\n", "        pass\n"),
    'need lets everything through': ("    if feature() != 'ok':\n        raise PluginError('capability_missing'", "    if False:\n        raise PluginError('capability_missing'"),
    'a missing ruamel is a library': ("    except Exception:  # noqa: BLE001\n        return None\n\n\ndef _yaml():", "    except Exception:  # noqa: BLE001\n        return types.SimpleNamespace()\n\n\ndef _yaml():"),
    'a header is read without a library': ("    base = _base()\n    if base is None:\n        raise PluginError(", "    base = _base()\n    if False:\n        raise PluginError("),
}


@pytest.mark.parametrize('label', sorted(MUTATIONS))
def test_each_mutation_is_caught(label, monkeypatch):
    old, new = MUTATIONS[label]
    assert SOURCE.count(old) == 1, label
    with pytest.raises(BaseException):  # noqa: B017
        checks(load([(old, new)]), monkeypatch)
