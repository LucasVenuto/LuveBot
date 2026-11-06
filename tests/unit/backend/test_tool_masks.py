"""BA-7 (the public half): `backend/tool_masks.py`, the registry the proxy asks about every frame of a stream, every row of a history page and every row of a search.

It knows no tool and no folder. What it promises, with fake masks that hide nothing in particular:
* nothing registered: every frame, row and search row passes through the SAME object;
* a mask is asked with the state it made for ONE stream or ONE page, the page is scanned before the first row is answered, and the viewer reaches the row;
* FAIL CLOSED: a mask that raises, a state that could not be made, a scan that raised: the neutral line, made of identifiers only, never the original text; a search row whose mask raises is dropped;
* the neutral frame and row keep identifiers (a string or a number, never a flag, a list or a dict).
Every guard also runs against a copy of the module with ONE defect: the control (no defect) passes, the defect turns its proof red."""
import contextlib
import importlib.util
import itertools
import re
import tempfile
from pathlib import Path

import pytest

import backend.tool_masks as real

SRC = Path(real.__file__)
FOLDER = tempfile.TemporaryDirectory()
RED = (Exception, pytest.fail.Exception)
_n = itertools.count()
SECRET = 'sk-the-text-of-a-result'


@contextlib.contextmanager
def registered(m, *masks):
    before = list(m._MASKS)
    m._MASKS[:] = list(masks)
    try:
        yield
    finally:
        m._MASKS[:] = before


class Mask:
    """A mask that records what it was asked and answers with a fixed marker."""

    def __init__(self):
        self.log = []

    def new_state(self):
        self.log.append('new_state')
        return {'seen': []}

    def scan(self, rows, state):
        self.log.append(('scan', len(rows)))
        state['seen'] = [r['id'] for r in rows]

    def frame(self, state, event, data):
        self.log.append(('frame', event))
        return {**data, 'marked': True}

    def row(self, state, row, viewer):
        self.log.append(('row', row['id'], viewer, tuple(state['seen'])))
        return {**row, 'viewer': viewer}

    def drops(self, row):
        return row.get('role') == 'tool'


class Boom(Mask):
    def __init__(self, where):
        super().__init__()
        self.where = where

    def new_state(self):
        if self.where == 'new_state':
            raise RuntimeError('state')
        return super().new_state()

    def scan(self, rows, state):
        if self.where == 'scan':
            raise RuntimeError('scan')
        super().scan(rows, state)

    def frame(self, state, event, data):
        if self.where == 'frame':
            raise RuntimeError(SECRET)
        return super().frame(state, event, data)

    def row(self, state, row, viewer):
        if self.where == 'row':
            raise RuntimeError(SECRET)
        return super().row(state, row, viewer)

    def drops(self, row):
        if self.where == 'drops':
            raise RuntimeError('drops')
        return super().drops(row)


class Blind(Mask):
    """No state could be made for it, and it never reads the state it is handed: only the registry can stop it."""

    def new_state(self):
        raise RuntimeError('state')

    def frame(self, state, event, data):
        return {**data, 'marked': True}

    def row(self, state, row, viewer):
        return {**row, 'viewer': viewer}


FRAME = {'event': 'tool.started', 'tool': 'any', 'tool_call_id': 'c1', 'seq': 3, 'run_id': 'r1', 'preview': SECRET, 'extra': {'text': SECRET}}
ROW = {'id': 7, 'role': 'tool', 'tool_name': 'any', 'tool_call_id': 'c1', 'timestamp': 12.5, 'content': SECRET, 'display_content': SECRET, 'tool_calls': [{'x': SECRET}]}
NEUTRAL_FRAME = {'event': 'tool.started', 'tool': 'any', 'tool_call_id': 'c1', 'seq': 3, 'run_id': 'r1', 'preview': real.HIDDEN, 'masked': {'kind': 'hidden'}}
NEUTRAL_ROW = {'id': 7, 'role': 'tool', 'tool_name': 'any', 'tool_call_id': 'c1', 'timestamp': 12.5, 'content': real.HIDDEN, 'display_content': real.HIDDEN, 'masked': {'kind': 'hidden'}}


# ---- the checks: each takes the module to prove, the real one or a variant with one defect

def check_empty_registry_passes_everything_through(m):
    with registered(m):
        states = m.stream()
        assert states == [] and m.scan([ROW]) == []
        assert m.mask_frame(states, 'tool.started', FRAME) is FRAME
        assert m.mask_row(m.scan([ROW]), ROW, 'ana') is ROW
        assert m.drop_row(ROW) is False


def check_a_mask_is_asked_with_its_state_and_the_viewer(m):
    mask = Mask()
    with registered(m, mask):
        states = m.stream()
        assert m.mask_frame(states, 'tool.started', FRAME) == {**FRAME, 'marked': True}
        page = [{'id': 1, 'role': 'user'}, ROW]
        page_states = m.scan(page)
        out = m.mask_row(page_states, ROW, 'ana')
        assert out['viewer'] == 'ana'
        assert ('row', 7, 'ana', (1, 7)) in mask.log                       # the whole page was scanned before the row was answered
        assert mask.log.index(('scan', 2)) < mask.log.index(('row', 7, 'ana', (1, 7)))
        assert m.drop_row(ROW) is True and m.drop_row({'role': 'user'}) is False


def check_a_mask_registered_later_does_not_touch_an_open_stream(m):
    with registered(m):
        states = m.stream()
        late = Mask()
        m.register(late)
        assert m.mask_frame(states, 'tool.started', FRAME) is FRAME
        assert late.log == []


def check_a_frame_that_raises_is_the_neutral_frame(m):
    with registered(m, Boom('frame')):
        out = m.mask_frame(m.stream(), 'tool.started', FRAME)
    assert out == NEUTRAL_FRAME and SECRET not in repr(out)


def check_a_row_that_raises_is_the_neutral_row(m):
    with registered(m, Boom('row')):
        out = m.mask_row(m.scan([ROW]), ROW, 'ana')
    assert out == NEUTRAL_ROW and SECRET not in repr(out)


def check_a_state_that_could_not_be_made_is_neutral(m):
    with registered(m, Blind()):
        frame = m.mask_frame(m.stream(), 'tool.started', FRAME)
        row = m.mask_row(m.scan([ROW]), ROW, 'ana')
    assert frame == NEUTRAL_FRAME and row == NEUTRAL_ROW


def check_a_scan_that_raised_makes_every_row_neutral(m):
    mask = Boom('scan')
    with registered(m, mask):
        states = m.scan([ROW])
        out = m.mask_row(states, ROW, 'ana')
    assert out == NEUTRAL_ROW and not [entry for entry in mask.log if entry[0] == 'row']           # the mask was not even asked about the row


def check_the_registry_says_whether_a_mask_drops_search_rows(m):
    with registered(m):
        assert m.drops_rows() is False
    with registered(m, object(), Blind()):
        assert m.drops_rows() is True                                                                  # Mask has `drops`; the search then asks for more than it shows
    only = type('Only', (), {'frame': lambda self, state, event, data: data})()
    with registered(m, only):
        assert m.drops_rows() is False


def check_a_search_row_is_dropped_when_the_mask_raises(m):
    with registered(m, Boom('drops')):
        assert m.drop_row({'role': 'user', 'content': 'plain'}) is True


def check_the_first_failure_ends_the_chain(m):
    after = Mask()
    with registered(m, Boom('frame'), after):
        assert m.mask_frame(m.stream(), 'tool.started', FRAME) == NEUTRAL_FRAME
    assert ('frame', 'tool.started') not in after.log


def check_the_chain_passes_the_answer_of_the_first_to_the_second(m):
    class Upper:
        def frame(self, state, event, data):
            return {**data, 'tool': data['tool'].upper()}

    class Seen:
        def frame(self, state, event, data):
            return {**data, 'was': data['tool']}

    with registered(m, Upper(), Seen()):
        assert m.mask_frame(m.stream(), 'tool.started', FRAME)['was'] == 'ANY'


def check_a_mask_with_no_methods_is_not_an_error(m):
    with registered(m, object()):
        assert m.mask_frame(m.stream(), 'tool.started', FRAME) is FRAME
        assert m.mask_row(m.scan([ROW]), ROW) is ROW
        assert m.drop_row(ROW) is False


def check_the_neutral_ones_keep_identifiers_only(m):
    data = {'event': 'tool.started', 'tool': 'any', 'tool_call_id': {'text': SECRET}, 'seq': True, 'run_id': ['x', SECRET], 'id': 4, 'timestamp': 1.5, 'preview': SECRET, 'content': SECRET, 'delta': SECRET, 'role': 'tool'}
    frame, row = m.neutral_frame(data), m.neutral_row(data)
    assert frame == {'event': 'tool.started', 'tool': 'any', 'id': 4, 'role': 'tool', 'timestamp': 1.5, 'preview': real.HIDDEN, 'masked': {'kind': 'hidden'}}, frame
    assert row == {'event': 'tool.started', 'tool': 'any', 'id': 4, 'role': 'tool', 'timestamp': 1.5, 'content': real.HIDDEN, 'display_content': real.HIDDEN, 'masked': {'kind': 'hidden'}}, row
    assert m.neutral_frame(None) == {'preview': real.HIDDEN, 'masked': {'kind': 'hidden'}} and m.neutral_row('text') == {'content': real.HIDDEN, 'display_content': real.HIDDEN, 'masked': {'kind': 'hidden'}}


CHECKS = [v for k, v in sorted(globals().items()) if k.startswith('check_')]


@pytest.mark.parametrize('check', CHECKS, ids=lambda c: c.__name__[len('check_'):])
def test_the_registry(check):
    check(real)


def test_the_neutral_line_is_what_the_panel_shows_for_a_masked_result():
    assert real.HIDDEN == 'result hidden' and NEUTRAL_FRAME['preview'] == NEUTRAL_ROW['content'] == 'result hidden'


def test_the_registry_names_no_tool_and_no_folder():
    text = SRC.read_text().casefold()
    assert not re.search('|'.join(('br' + 'ain', 'c.re' + 'bro', 'va' + 'ult')), text)


# ---- mutations: ONE line changed, the proof named turns red; the control (no change) passes them all

def variant(old, new, times=1):
    text = SRC.read_text()
    assert text.count(old) == times, (old, text.count(old))
    path = Path(FOLDER.name) / f'tm{next(_n)}.py'
    path.write_text(text.replace(old, new))
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MUTATIONS = [
    ('a frame that raises passes the original', '            return neutral_frame(data)\n    return data', '            return data\n    return data', 1, check_a_frame_that_raises_is_the_neutral_frame),
    ('a row that raises passes the original', '            return neutral_row(row)\n    return row', '            return row\n    return row', 1, check_a_row_that_raises_is_the_neutral_row),
    ('a broken state is not neutral (frame)', "            if state is _BROKEN:\n                raise RuntimeError('state')\n            data = mask.frame", '            data = mask.frame', 1, check_a_state_that_could_not_be_made_is_neutral),
    ('a broken state is not neutral (row)', "            if state is _BROKEN:\n                raise RuntimeError('state')\n            row = mask.row", '            row = mask.row', 1, check_a_state_that_could_not_be_made_is_neutral),
    ('a state that could not be made is None', 'out.append((mask, _BROKEN))', 'out.append((mask, None))', 1, check_a_state_that_could_not_be_made_is_neutral),
    ('a scan that raised does not break the page', 'states[index] = (mask, _BROKEN)', 'pass', 1, check_a_scan_that_raised_makes_every_row_neutral),
    ('the page is not scanned', '            mask.scan(rows, state)', '            pass', 1, check_a_mask_is_asked_with_its_state_and_the_viewer),
    ('a search row whose mask raises stays', '        except Exception:  # noqa: BLE001\n            return True', '        except Exception:  # noqa: BLE001\n            return False', 1, check_a_search_row_is_dropped_when_the_mask_raises),
    ('the search never drops', '            if mask.drops(row):\n                return True', '            if False:\n                return True', 1, check_a_mask_is_asked_with_its_state_and_the_viewer),
    ('the viewer does not reach the row', 'row = mask.row(state, row, viewer)', 'row = mask.row(state, row, None)', 1, check_a_mask_is_asked_with_its_state_and_the_viewer),
    ('the first failure does not end the chain', '            return neutral_frame(data)\n    return data', '            continue\n    return data', 1, check_the_first_failure_ends_the_chain),
    ('the registry never says a mask drops rows', 'return any(hasattr(mask, \'drops\') for mask in list(_MASKS))', 'return False', 1, check_the_registry_says_whether_a_mask_drops_search_rows),
    ('the registry always says a mask drops rows', 'return any(hasattr(mask, \'drops\') for mask in list(_MASKS))', 'return True', 1, check_the_registry_says_whether_a_mask_drops_search_rows),
    ('the second mask is not asked', '            data = mask.frame(state, event, data)', '            mask.frame(state, event, data)', 1, check_the_chain_passes_the_answer_of_the_first_to_the_second),
    ('the neutral frame keeps the text', "KEEP = ('event', 'tool',", "KEEP = ('delta', 'event', 'tool',", 1, check_the_neutral_ones_keep_identifiers_only),
    ('the neutral row keeps a list', 'isinstance(row[key], (str, int, float))', 'isinstance(row[key], (str, int, float, list, dict))', 1, check_the_neutral_ones_keep_identifiers_only),
    ('the neutral frame keeps a dict', 'isinstance(data[key], (str, int, float))', 'isinstance(data[key], (str, int, float, list, dict))', 1, check_the_neutral_ones_keep_identifiers_only),
    ('the neutral frame keeps a flag', ' and not isinstance(data[key], bool)', '', 1, check_the_neutral_ones_keep_identifiers_only),
    ('the neutral row keeps a flag', ' and not isinstance(row[key], bool)', '', 1, check_the_neutral_ones_keep_identifiers_only),
    ('a mask with no methods is an error', "if not hasattr(mask, 'frame'):\n            continue", 'pass', 1, check_a_mask_with_no_methods_is_not_an_error),
    ('a late mask reaches an open stream', 'for mask, state in states:\n        if not hasattr(mask, \'frame\')', 'for mask, state in _states():\n        if not hasattr(mask, \'frame\')', 1, check_a_mask_registered_later_does_not_touch_an_open_stream),
]


def test_the_control_passes_every_proof():
    module = variant('HIDDEN =', 'HIDDEN =')
    for check in CHECKS:
        check(module)


@pytest.mark.parametrize('name, old, new, times, check', MUTATIONS, ids=[m[0] for m in MUTATIONS])
def test_a_defect_turns_its_proof_red(name, old, new, times, check):
    module = variant(old, new, times)
    with pytest.raises(RED):
        check(module)
