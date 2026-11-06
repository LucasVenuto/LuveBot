"""F6 (cross review 2): the Bot x Skill matrix read every Bot's catalog and config one after the other on every request. Now it is kept 30 s, and
until anything changes (a toggle bumps the epoch); each caller gets its own copy. The route's own function is run with stand-ins."""
import asyncio
from pathlib import Path
import re
import types

import pytest

from backend.flight import Memo

API = (Path(__file__).resolve().parents[3] / 'dashboard' / 'plugin_api.py').read_text()


def function(source, name):
    return re.search(rf'(?:async )?def {name}\(.*?(?=\n(?:@router|def |async def |class )|\Z)', source, re.S).group(0)


async def _pool(fn, *args):
    return fn(*args)


def rig(source):
    import copy
    now, calls, epoch = [0.0], [], [0]

    def matrix(bots, redact):
        calls.append(list(bots))
        return {'bots': [{'bot': b} for b in bots], 'skills': [], 'cells': [], 'truncated': {'bots': False, 'skills': False}}

    async def names():
        return ['default', 'vendas']
    ns = {'copy': copy, '_identity': lambda request: None, '_names': names, 'run_in_threadpool': _pool, 'skills': types.SimpleNamespace(matrix=matrix),
          '_REDACT': lambda text: text, '_SKILLS_MATRIX': Memo(30.0, clock=lambda: now[0]), '_EPOCH': epoch, 'Request': object}
    exec(function(source, 'get_skills_matrix'), ns)
    return lambda: asyncio.run(ns['get_skills_matrix'](None)), now, calls, epoch


def checks(source):
    ask, now, calls, epoch = rig(source)
    first = ask()
    now[0] += 20
    assert ask() == first and len(calls) == 1                        # 20 s later: no Bot is read again
    first['bots'].append('mine')
    assert ask()['bots'] == [{'bot': 'default'}, {'bot': 'vendas'}]    # a caller that changes its answer does not change the next one
    now[0] += 11
    ask()
    assert len(calls) == 2                                           # past 30 s: read again
    epoch[0] += 1
    ask()
    assert len(calls) == 3                                           # a toggle (any change) never leaves a stale matrix


def test_the_matrix_is_kept_and_never_older_than_a_change():
    checks(API)


@pytest.mark.parametrize('old,new', [
    ("await _SKILLS_MATRIX.get(('matrix', tuple(names)), _EPOCH[0], lambda: run_in_threadpool(skills.matrix, names, _REDACT))", "await run_in_threadpool(skills.matrix, names, _REDACT)"),
    ("_EPOCH[0], lambda: run_in_threadpool(skills.matrix", "0, lambda: run_in_threadpool(skills.matrix"),
    ("    return copy.deepcopy(grid)", "    return grid"),
], ids=['no_cache', 'epoch_ignored', 'shared_copy'])
def test_each_mutation_is_caught(old, new):
    assert API.count(old) == 1, old
    with pytest.raises(Exception):   # noqa: B017
        checks(API.replace(old, new))
