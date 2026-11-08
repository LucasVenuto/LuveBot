"""Red team (Lume, 30/10) of `_FILE_TOOLS` (r51, contract v0.9 section 14): a PARTIAL answer is shown but never remembered, and the "shown" part lives in a list of the request that
STARTED the read. A second request that arrives while that read is in flight JOINS it (Flight: same key, same epoch, one computation for all), gets the same exception, and finds
ITS OWN list empty: the Bot detail it returns has no `file_tools` at all, while the first request's has the keys that could be told.

Runs the REAL `files()` of `_one` (its text is taken out of plugin_api.py and run with stand-ins and the real Memo), so a change of that code changes this test.
FINDING (Baixa), FIXED (r52): the partial answer travels in the exception (`error.value`), so every request that joined the read gets it; the finding is a plain test now, with the mutations that bring it back below. Display only: the screen says nothing when the object is absent
(never a false "cannot"), so the cost is two tabs showing different things for up to one read."""
import asyncio
import re
import textwrap
import types
from pathlib import Path

import pytest

from backend.flight import Memo

API = (Path(__file__).resolve().parents[3] / 'dashboard' / 'plugin_api.py').read_text()
TOOLS = ('read_file', 'vision_analyze', 'terminal')
PARTIAL = {'read_file': True, 'terminal': False}                   # two of the three keys could be told
FULL = {'read_file': True, 'vision_analyze': False, 'terminal': True}


def files_of(memo, told, gate, reads):
    """The `files()` of one request: its own `partial` list, its own stand-in for the shared toolsets read (`reads` counts how many times a request really read)."""
    text = re.search(r"    async def files\(\):.*?(?=\n    details, answer, handled)", API, re.S).group(0)

    async def toolsets():
        reads.append(1)
        await gate.wait()
        return {'file_tools': told}
    ns = {'toolsets': toolsets, 'live_state': types.SimpleNamespace(FILE_TOOLS=TOOLS), '_FILE_TOOLS': memo, '_EPOCH': [0], 'name': 'vendas'}
    exec(textwrap.dedent(text), ns)
    return ns['files']


def two_requests(told):
    async def scenario():
        memo, gate, reads = Memo(60.0), asyncio.Event(), []
        first = asyncio.ensure_future(files_of(memo, told, gate, reads)())
        await asyncio.sleep(0)                                       # the first request misses the cache and starts the read
        second = asyncio.ensure_future(files_of(memo, told, gate, reads)())
        await asyncio.sleep(0)                                       # the second arrives while it is in flight: it joins
        gate.set()
        return await first, await second, len(reads)
    return asyncio.run(scenario())


def test_control_a_request_alone_gets_what_could_be_told_and_it_is_not_remembered():
    async def scenario():
        memo, gate, reads = Memo(60.0), asyncio.Event(), []
        gate.set()
        again = files_of(memo, PARTIAL, gate, reads)
        return await again(), await files_of(memo, PARTIAL, gate, reads)(), len(reads)
    first, second, reads = asyncio.run(scenario())
    assert first == PARTIAL and second == PARTIAL and reads == 2    # shown both times, read both times: never remembered


def test_control_two_requests_that_overlap_share_ONE_read_of_a_full_answer():
    first, second, reads = two_requests(FULL)
    assert first == FULL and second == FULL and reads == 1          # the second joined: it never read


def test_control_the_joiner_really_does_join_a_partial_read():
    first, _second, reads = two_requests(PARTIAL)
    assert first == PARTIAL and reads == 1


def test_finding_a_request_that_joins_a_partial_read_gets_the_same_answer_as_the_one_that_started_it():
    first, second, _reads = two_requests(PARTIAL)
    assert second == first


def run_with(monkeypatch, old, new):
    """The same two requests, with `files()` taken from a plugin_api.py text that has one defect put back."""
    assert API.count(old) == 1, old
    import sys
    monkeypatch.setattr(sys.modules[__name__], 'API', API.replace(old, new))
    return two_requests(PARTIAL)


@pytest.mark.parametrize('old,new', [
    ('            error.value = found', '            pass'),
    ("            return getattr(error, 'value', None)", '            return None'),
    ("        except LookupError as error:\n            return getattr(error, 'value', None)", "        except LookupError:\n            return None"),
], ids=['the value is not put in the exception', 'the value is never returned', 'the exception is caught without its value'])
def test_each_mutation_brings_the_finding_back(monkeypatch, old, new):
    first, second, _reads = run_with(monkeypatch, old, new)
    assert not (first == PARTIAL and second == PARTIAL)
