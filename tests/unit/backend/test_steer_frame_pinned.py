"""R-14 (contract v0.11 section 8, A-209): the screen tells the steer of a denial that reached the transcript as a plain `user` row (no display kind) by the FIXED frame the server starts it with. The frame is ONE constant on the screen
(`STEER_FRAME` in dashboard/src/components/chat/history.ts) and it must stay the start of what `deny_steer_text` (backend/approvals_native.py) sends: a static guard that reads both files, so a change of the server's words cannot
silently turn the steer back into a person's bubble that takes its answer from the message above it. Nothing is imported (the backend module needs Hermes): the function is read with `ast`."""
import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HISTORY = ROOT / 'dashboard' / 'src' / 'components' / 'chat' / 'history.ts'
NATIVE = ROOT / 'backend' / 'approvals_native.py'


def ui_frame():
    found = re.findall(r'export const STEER_FRAME = "([^"\n]*)";', HISTORY.read_text(encoding='utf-8'))
    assert len(found) == 1, 'the screen must define STEER_FRAME exactly once'
    return found[0]


def server_text_before_the_reason():
    """The fixed text `deny_steer_text` puts before the person's words: the constant part of its f-string, up to the first placeholder."""
    function = next(n for n in ast.walk(ast.parse(NATIVE.read_text(encoding='utf-8'))) if isinstance(n, ast.FunctionDef) and n.name == 'deny_steer_text')
    strings = [n for n in ast.walk(function) if isinstance(n, ast.JoinedStr)]
    assert strings, 'deny_steer_text no longer builds its text with an f-string: read the new shape and update this guard'
    first = strings[0].values[0]
    assert isinstance(first, ast.Constant) and isinstance(first.value, str)
    return first.value


def test_the_screens_frame_is_the_start_of_what_the_server_sends():
    frame, sent = ui_frame(), server_text_before_the_reason()
    assert sent.startswith(frame), (frame, sent)


def test_the_frame_is_the_tag_and_its_space_not_more_and_not_less():
    frame = ui_frame()
    assert frame == '[luvebot:deny] ', frame     # more would miss a send whose words changed; less would take a person's own message for a steer


def test_the_server_text_has_the_person_words_after_the_frame():
    assert server_text_before_the_reason() != ui_frame(), 'the frame must be the start, with the explanation of what was denied after it'
