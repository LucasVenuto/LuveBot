"""Red team (Lume, 31/10) of SK-2h (5b79e13): after a creation that raised, "is the file on the disk OURS" compares the sha256 of the text that was REVIEWED with the sha256 of what Hermes reads back.

The premise, read in the Hermes of this machine (hermes_cli/web_routers/skills.py `get_skill_content`: `skill_md.read_text(encoding="utf-8")`; tools/skill_manager_tool.py `_create_skill`: `atomic_write_text(skill_md, content)`): Hermes
writes the text as it is and reads it back with the universal newlines of `read_text`, so every `\\r\\n` and lone `\\r` comes back as `\\n`. The header must end its lines with `\\n` (the server refuses a first line of `---` + CR as "no header"), so the CR has to be in the BODY: a Bot whose answer ends its body lines with `\\r\\n`, or holds a `\\r`, passes the dry run (the sheet sends the extracted
text as it is until the person edits it).

FIXED IN SK-2i (the two tests that were `xfail(strict=True)` are plain tests now, and the mutations are in test_skill_teach_flow.py): F-SK2h-1: a creation that raises AFTER the file was written (the case `_ours` exists for) with a text that holds a CR: what is read back differs from the sha256 of what was
sent, so the file that IS ours is taken for a stranger's: `409 skill_exists appeared_meanwhile` ("somebody else's skill took the name, and LuveBot turned it off") for the skill the person just reviewed, which is on the disk, unrecorded as taught,
and disabled. Narrow (the creation must raise after writing and the text must hold a CR), and wrong in the loud direction. Reference fix: compare the digests of both texts with the newlines read the way Hermes reads them."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sk2f = pytest.importorskip('test_redteam_skill_teach_sk2f', reason='my fakes of SK-2f')
flow = sk2f.flow
REAL = sk2f.REAL


def lf(text):
    return text.replace('\r\n', '\n').replace('\r', '\n')


def universal_newlines(fake):
    """Hermes's read: `read_text`, so the newlines of the file come back as `\\n`."""
    def read(bot, name):
        if name not in fake.texts:
            raise REAL.PluginError('skill_not_found', 'x', 404)
        return lf(fake.texts[name])
    fake.read = read
    return fake


def with_cr_body(newline):
    """A valid skill whose HEADER ends its lines with LF and whose body ends its lines with `newline`."""
    return flow.skill() + 'Linha dois.' + newline + 'Linha tres.' + newline


def run(tmp_path, content):
    fake = universal_newlines(sk2f.WritesThenFails(RuntimeError('the cache clear failed after the file was written')))
    try:
        out = REAL.create(flow.Audit(), str(tmp_path / 'c.db'), 'basic:ana', 'vendas', sk2f.NAME, None, content, flow.redactor, 'req', fake)
    except BaseException as error:  # noqa: BLE001
        out = error
    return out, fake


def test_control_a_text_with_only_LF_that_hermes_wrote_and_failed_after_is_ours(tmp_path):
    out, fake = run(tmp_path, flow.skill())
    assert isinstance(out, dict) and out['enabled'] is False, out                             # the harness is faithful: the case carries on as a success
    for newline in ('\r\n', '\r'):
        REAL.dry_run(sk2f.NAME, with_cr_body(newline), None, True, flow.redactor)               # and the CR text of the tests below PASSES the dry run (a CR in the header would not)
    assert REAL.taught(str(tmp_path / 'c.db'), 'vendas', sk2f.NAME) is not None


def test_control_somebody_elses_text_is_still_a_409_whatever_its_newlines(tmp_path):
    fake = universal_newlines(sk2f.Race())
    fake.fail_create = REAL.SkillInvalid('hermes_refused')
    try:
        out = REAL.create(flow.Audit(), str(tmp_path / 'c.db'), 'basic:ana', 'vendas', sk2f.NAME, None, with_cr_body('\r\n'), flow.redactor, 'req', fake)
    except BaseException as error:  # noqa: BLE001
        out = error
    assert isinstance(out, REAL.PluginError) and out.code == 'skill_exists' and out.status == 409, out


@pytest.mark.parametrize('newline', ['\r\n', '\r'], ids=['CRLF', 'CR'])
def test_a_text_with_a_carriage_return_that_hermes_wrote_and_failed_after_is_still_ours(tmp_path, newline):
    out, fake = run(tmp_path, with_cr_body(newline))
    assert isinstance(out, dict) and out['enabled'] is False, out                             # not "somebody else's skill took the name"
    assert REAL.taught(str(tmp_path / 'c.db'), 'vendas', sk2f.NAME) is not None
