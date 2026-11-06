"""Contract v0.8 section 3 (backend/routines.py): a "Pesquisa" routine. Created with exactly `enabled_toolsets: ["web", "no_mcp"]`,
delivered locally, its prompt ending with the fixed line; a client asking for more is refused. The "Só leitura" seal comes from the
LIVE job: `real` while it is exactly web + no_mcp (order ignored), `broken` once the job can do more (edited in Hermes, say, to
add `terminal`). Mutations: the seal from our marker alone; the toolsets taken from the client."""
import importlib
import importlib.util
import itertools
from pathlib import Path
import sys

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
_n = itertools.count()


def load(edit=None):
    name = f'research_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    if not edit:
        return importlib.import_module(f'{name}.routines')
    source = (BACKEND / 'routines.py').read_text()
    assert source.count(edit[0]) == 1, edit[0]
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.routines', loader=None))
    module.__package__ = name
    sys.modules[module.__name__] = module
    exec(compile(source.replace(*edit), str(BACKEND / 'routines.py'), 'exec'), module.__dict__)
    return module


def code_of(fn, *args):
    try:
        return fn(*args)
    except Exception as error:  # noqa: BLE001
        return getattr(error, 'code', type(error).__name__)


BODY = {'bot': 'vendas', 'name': 'Concorrentes', 'schedule': '0 8 * * 1', 'prompt': 'Pesquise as novidades dos concorrentes.',
        'template': 'research'}


def checks(r, tmp_path):
    bot, fields, start, template = code_of(r.validate_create, BODY)
    assert template == 'research' and fields.get('enabled_toolsets') == ['web', 'no_mcp'] and fields['deliver'] == 'local'
    assert fields['prompt'].endswith(r.RESEARCH_LINE) and fields['prompt'].count(r.RESEARCH_LINE) == 1
    again = code_of(r.validate_create, {**BODY, 'prompt': fields['prompt'], 'enabled_toolsets': ['no_mcp', 'web']})
    assert again[1]['prompt'].count(r.RESEARCH_LINE) == 1                                    # the line is never doubled
    for extra in ({'enabled_toolsets': ['web', 'no_mcp', 'terminal']}, {'enabled_toolsets': ['web']}, {'deliver': 'telegram'},
                  {'no_agent': True}, {'template': 'outro'}):
        assert code_of(r.validate_create, {**BODY, **extra}) == 'invalid_field', extra
    assert code_of(r.validate_create, {k: v for k, v in BODY.items() if k != 'template'})[3] is None   # a normal routine

    db = tmp_path / f'r{next(_n)}.db'
    r.mark_template(db, 'job_1', 'research')
    marks = r.templates(db)
    live = {'id': 'job_1', 'enabled_toolsets': ['no_mcp', 'web']}
    assert r.view('vendas', live, template=marks.get('job_1'))['readonly_seal'] == 'real'
    edited = {'id': 'job_1', 'enabled_toolsets': ['web', 'no_mcp', 'terminal']}                # edited in Hermes
    assert r.view('vendas', edited, template=marks.get('job_1'))['readonly_seal'] == 'broken'
    assert r.view('vendas', {'id': 'job_1'}, template='research')['readonly_seal'] == 'broken'  # no allowlist at all: can do anything
    assert r.view('vendas', {'id': 'job_2', 'enabled_toolsets': ['web', 'no_mcp']})['readonly_seal'] is None


def test_research_routine_is_readonly(tmp_path):
    checks(load(), tmp_path)


@pytest.mark.parametrize('edit', [
    ('    return "real" if isinstance(toolsets, list) and sorted(toolsets) == sorted(RESEARCH_TOOLSETS) else "broken"',
     '    return "real"'),
    ('        if sorted(out.get("enabled_toolsets", RESEARCH_TOOLSETS)) != sorted(RESEARCH_TOOLSETS):\n            raise _bad("enabled_toolsets")\n', ''),
    ('        out = {**out, "enabled_toolsets": list(RESEARCH_TOOLSETS), "deliver": "local", "prompt": prompt}',
     '        out = {**out, "deliver": "local", "prompt": prompt}'),
], ids=['seal_from_the_marker', 'more_toolsets_accepted', 'toolsets_not_forced'])
def test_each_mutation_is_caught(tmp_path, edit):
    with pytest.raises(AssertionError):
        checks(load(edit), tmp_path)
