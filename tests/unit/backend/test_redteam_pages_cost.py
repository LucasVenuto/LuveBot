"""Red team (Lume, 31/10) of P-1 / A-227: the CPU cost of what a page (up to 1 MiB, `pages.MAX_BYTES`) or a note of the notes index puts through `backend/pages.py`.
`excerpt` runs for EVERY approved note under the index lock (the index refresh) and for every page of `list_pages` (500 of them), `re` holds the GIL, so one
quadratic stage freezes the whole panel, not just the request. Brasa's `test_pages_excerpt.py` measures the cleaner and `excerpt`; this file adds what it does not:
* EVERY stage a page goes through (`_FENCE.sub`, `title_of`, `excerpt`, the whole `page_view`), each on the worst text of each kind at 1 MiB;
* the STALL, not only the total: a heartbeat thread beats every 2 ms while the stage runs, and the longest gap between two beats is what every other request waits;
* the kinds the first measurement missed: blank lines (`^\s*` crossed them: 16 thousand blank lines cost 4.9 s), whitespace of every kind (CRLF, tab, form feed, em space),
  fence lines (a fence line leaves a blank line behind that the marker pass then read), unclosed openers with their tail (`[a](b`, `[[a|`, `<a `) and runs of openers (`[[[[`).
Each case runs in a CHILD process with a time limit, because the code under test, before P-1, took minutes on these inputs: a child that does not answer in time is the
failure, and the suite never hangs. Before P-1 (measured on the unpatched pages.py, strict xfail on dbc696d) 18 of these cases were red; with P-1 all are green.
Measured with P-1 (Python 3.14, 1 MiB): the worst `excerpt` 0.13 s (gap 0.09 s), `page_view` 0.15 s, `title_of` 0.07 s (a million lines), `_FENCE.sub` 0.08 s.
The BUDGET is generous on purpose (8x the measured worst): the invariant is "no stage grows with the square of the page", not a benchmark.
NOT covered here, and a real limit: the cost is linear per page but a `list_pages` over 500 pages of 1 MiB is 500 times it (the real redactor not counted); see the report."""
import json
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

ROOT = str(Path(__file__).resolve().parents[3])
SIZE = 1024 * 1024
TIMEOUT_S = 3.0           # the child's limit: before P-1 the worst of these needed minutes
BUDGET_S = 1.0            # one call, and the longest gap between two heartbeats (2 ms apart), at 1 MiB

CHILD = textwrap.dedent('''
    import json, sys, threading, time
    sys.path.insert(0, %r)
    import backend.pages as pg
    prim, size, stages = json.loads(sys.argv[1]), int(sys.argv[2]), sys.argv[3].split(',')
    text = (prim * (size // len(prim) + 1))[:size]
    data, keep = text.encode(), (lambda s: s)
    stat = type('S', (), {'st_size': len(data), 'st_mtime': 0})()
    gaps, stop = [], []
    def beat():
        last = time.perf_counter()
        while not stop:
            time.sleep(0.002)
            now = time.perf_counter(); gaps.append(now - last); last = now
    thread = threading.Thread(target=beat, daemon=True); thread.start(); time.sleep(0.05)
    work = {'fence': lambda: pg._FENCE.sub(' ', text), 'title_of': lambda: pg.title_of(text, 's', keep),
            'excerpt': lambda: pg.excerpt(text, keep), 'page_view': lambda: pg.page_view('s', data, stat, None, ('a', 'b'), keep)}
    out = {}
    for name in stages:
        gaps.clear(); started = time.perf_counter(); work[name]()
        out[name] = [time.perf_counter() - started, max(gaps or [0])]
    stop.append(1); print(json.dumps(out))
''' % ROOT)


def measure(prim, stages):
    """{stage: (seconds, longest heartbeat gap)} for `prim` repeated to 1 MiB, or None when the child did not finish in time."""
    try:
        done = subprocess.run([sys.executable, '-c', CHILD, json.dumps(prim), str(SIZE), ','.join(stages)], capture_output=True, text=True, timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return None
    assert done.returncode == 0, done.stderr[-400:]
    return json.loads(done.stdout)


def assert_bounded(prim, stages):
    out = measure(prim, stages)
    assert out is not None, f'{prim!r} x 1 MiB did not finish in {TIMEOUT_S} s'
    for stage in stages:
        seconds, gap = out[stage]
        assert seconds < BUDGET_S and gap < BUDGET_S, (prim, stage, seconds, gap)


# Quadratic BEFORE P-1 in `excerpt` (measured on the unpatched pages.py: the time grew x4 for every doubling): the three openers that close nothing (and runs of them), blank lines
# (the marker pass read them from every line start; a tab, a form feed or an em space before the newline behave like a space), the fence lines that left blank lines behind,
# and the unclosed openers with a tail.
QUADRATIC = ['![', '[', '<', '\n', '\r\n', ' \n', '```\n', '~~~\n', '[a](b', '[a](b\n', '[[a|', '[[[[', '[a]((((', '<a ']
# Linear before and after (a held control: a fix that is linear on the marks must not make these slow).
LINEAR = ['`', '<b>', '[a](b)', '**', '![](x)', '<!---->', '- ', '> ', '-\n', '#\n', '>\n', '1.\n', '# ', '\n# ', 'x\n# ', '#######\n', '1111111111111111\n', ']]]]', '))))']


@pytest.mark.parametrize('prim', QUADRATIC)
def test_the_worst_text_of_each_kind_through_excerpt_is_bounded_with_no_stall_at_1_mib(prim):
    assert_bounded(prim, ['excerpt'])


@pytest.mark.parametrize('prim', LINEAR)
def test_the_linear_kinds_stay_bounded_through_excerpt_at_1_mib(prim):
    assert_bounded(prim, ['excerpt'])


@pytest.mark.parametrize('prim', ['![', '<', 'NL', 'FENCE'])
def test_the_whole_page_view_of_a_hostile_page_is_bounded_with_no_stall_at_1_mib(prim):
    assert_bounded({'NL': '\n', 'FENCE': '```\n'}.get(prim, prim), ['page_view'])


@pytest.mark.parametrize('prim', ['\n', '\r\n', '```\n', '~~~\n', '`', '![', '<', ' \n'])
def test_the_other_stages_are_linear_on_the_same_worst_texts_at_1_mib(prim):
    assert_bounded(prim, ['fence', 'title_of'])                                       # the fence regex and the title scan were linear already (Architect, 1 MiB: 43 to 55 ms): held


def test_an_ordinary_page_of_1_mib_is_far_below_the_budget():
    benign = measure('Uma frase comum, com [um link](http://x/y), **negrito**, `codigo` e <b>html</b>.\n', ['excerpt', 'page_view', 'title_of', 'fence'])
    assert benign is not None and all(seconds < BUDGET_S for seconds, _gap in benign.values()), benign   # the control for the budget itself
