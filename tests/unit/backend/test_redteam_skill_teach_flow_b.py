"""Red team (Lume, 31/10) of SK-2 slice B and SK-3 (bad116e: the draft with its nonce and the history, the creation born OFF, the edit, the toggle with the scan) against contract v0.11 section 3.2 and 3.3.
It reuses the Brasa's stand-in Hermes and audit (`test_skill_teach_flow.py`), whose mutations already hold the normal flow; what is attacked here is what that battery does not say.

FIXED by SK-2f (it was an `xfail(strict=True)`, now a plain test):
  F-SK-B2 (Media, the F-SK1 family): the undo of a failed creation (3.2 step 5, "remove it from the disabled list again") runs for ANY failure of Hermes's `create`, including one that comes AFTER the file was written.
          Hermes's route does exactly that: `create_skill` runs `_create_skill` (the SKILL.md is on disk), then `_clear_skills_prompt_cache()` (hermes_cli/web_routers/skills.py, v0.22.5 line 429), and anything that
          raises there reaches LuveBot as a refusal of the creation; `create` then re-enables the name it had disabled, so the skill exists and is ON: the one instant 3.2 step 4 says there must never be.
          The undo is right only when the skill does not exist; the fix is one question before it (`hermes.directory(bot, name)`). A `SystemExit` or a `KeyboardInterrupt` in the same place does the same.

HELD (plain tests): two tabs saving the same skill with the digest they both loaded: exactly one wins, the other is `stale`, the file is the winner's, nothing is lost; and what hides a turn from the history is the
first line, exactly, of a recorded nonce, over a corpus of near misses and an oracle that does not share the code's expression.

NOT CLAIMED, written in the report: the (bot, name) lock is per process (the dashboard and the gateway can both host the plugin app, so two tabs through two processes are covered by the digest alone, between its
check and Hermes's write); the draft route does not ask for a person (3.2: "allowed in loopback"), and the turn it sends is hidden from the history with its note."""
import random
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
flow = pytest.importorskip('test_skill_teach_flow', reason='the Brasa stand-ins of SK-2')
m = flow.load()
NAME = 'enviar-relatorio'
cp = chr


class WritesThenFails(flow.Fake):
    """Hermes's `create_skill`: the skill is written, and then something after the write raises."""
    def __init__(self, error, **kw):
        super().__init__(**kw)
        self.error = error

    def create(self, bot, name, content, category):
        flow.Fake.create(self, bot, name, content, category)
        self.dirs.add(name)
        raise self.error


def run_create(fake, tmp_path):
    outcome = None
    try:
        m.create(flow.Audit(), str(tmp_path / 'c.db'), 'basic:ana', 'vendas', NAME, None, flow.skill(), flow.redactor, 'req_1', fake)
    except BaseException as error:  # noqa: BLE001
        outcome = error
    return outcome


def skill_exists(fake):
    return NAME in fake.texts or NAME in fake.dirs


@pytest.mark.parametrize('error', [lambda: SystemExit(1), lambda: KeyboardInterrupt()], ids=['SystemExit', 'KeyboardInterrupt'])
def test_a_creation_interrupted_after_the_skill_is_written_never_leaves_it_on(error, tmp_path):
    """3.2 step 4 item 5 (F-SK-B2, fixed by SK-2f): nothing is proven by a `BaseException`: the name stays disabled, the error goes up."""
    fake = WritesThenFails(error())
    outcome = run_create(fake, tmp_path)
    assert outcome is not None                                                  # the person is told it failed
    assert skill_exists(fake), 'the stand-in must have written the skill'
    assert NAME in fake.off, 'the skill exists and its name is no longer in skills.disabled: it is ON (loadable) right after an error'


def test_a_creation_that_raises_an_exception_after_the_skill_is_written_carries_on_and_the_reread_decides(tmp_path):
    """The same failure as an `Exception` (Hermes's route clears its cache AFTER the write): the skill exists, so it is a success if the re-read finds it OFF, and the name was never enabled in between."""
    fake = WritesThenFails(m.skills._hermes_error())
    assert run_create(fake, tmp_path) is None and skill_exists(fake) and NAME in fake.off
    assert 'toggle:' + NAME + ':True' not in fake.calls                          # the one act that needs a proof was never done
    assert m.taught(str(tmp_path / 'c.db'), 'vendas', NAME) is not None
    fake = WritesThenFails(m.skills._hermes_error())
    fake.hidden = True                                                          # ...and if the re-read cannot find it, that is the 502, with the name disabled again
    outcome = run_create(fake, tmp_path)
    assert getattr(outcome, 'code', None) == 'skill_state_unverified' and NAME in fake.off and fake.calls[-1] == f'toggle:{NAME}:False'


def test_a_creation_that_fails_before_anything_is_written_leaves_no_name_behind_and_a_name_that_was_off_stays_off(tmp_path):
    fake = flow.fake_for(m)
    fake.fail_create = m.skills._hermes_error()
    assert run_create(fake, tmp_path) is not None
    assert not skill_exists(fake) and NAME not in fake.off                      # the name we added for a skill that was never made is gone again
    fake = flow.fake_for(m, disabled=[NAME])
    fake.fail_create = m.skills._hermes_error()
    assert run_create(fake, tmp_path) is not None
    assert NAME in fake.off                                                     # one that was already disabled is not enabled by our undo


# ---- two tabs ----------------------------------------------------------------------------------------------------------------------------------------------------------
def test_two_tabs_saving_the_same_skill_with_the_digest_they_both_loaded_cannot_both_win(tmp_path):
    base = flow.skill(description='Use quando precisar enviar o relatorio.', body='1. Abra o CRM.')
    one = flow.skill(description='Use quando precisar enviar o relatorio.', body='1. Abra o CRM. ABA-UM')
    two = flow.skill(description='Use quando precisar enviar o relatorio.', body='1. Abra o CRM. ABA-DOIS')
    fake = flow.fake_for(m, listed=[(NAME, 'agent')], texts={NAME: base})
    writing, original = threading.Event(), fake.update

    def slow_update(bot, name, content):                                       # Hermes's write takes a while: the second tab arrives inside it
        writing.set()
        threading.Event().wait(0.15)
        original(bot, name, content)
    fake.update = slow_update
    expected = m._digest(base)
    outcomes, start = [], threading.Barrier(2)

    def save(text):
        start.wait()
        try:
            m.edit(flow.Audit(), str(tmp_path / 'e.db'), 'basic:ana', 'vendas', NAME, text, expected, flow.redactor, 'req', fake)
            outcomes.append('ok')
        except Exception as error:  # noqa: BLE001
            outcomes.append(getattr(error, 'code', repr(error)))
    threads = [threading.Thread(target=save, args=(t,)) for t in (one, two)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert sorted(outcomes) == ['ok', 'stale'], outcomes
    assert fake.texts[NAME] in (one, two) and fake.texts[NAME] != base          # the file is one tab's text, whole


def test_a_second_save_with_the_old_digest_after_the_first_is_stale_and_changes_nothing(tmp_path):
    base = flow.skill(body='1. A.')
    first = flow.skill(body='1. A. PRIMEIRA')
    fake = flow.fake_for(m, listed=[(NAME, 'agent')], texts={NAME: base})
    db, expected = str(tmp_path / 'e.db'), m._digest(base)
    m.edit(flow.Audit(), db, 'basic:ana', 'vendas', NAME, first, expected, flow.redactor, 'req_1', fake)
    audit = flow.Audit()
    error = flow.refusal(lambda: m.edit(audit, db, 'basic:ana', 'vendas', NAME, flow.skill(body='1. A. SEGUNDA'), expected, flow.redactor, 'req_2', fake))
    assert error is not None and error.code == 'stale' and fake.texts[NAME] == first
    assert [row[0] for row in audit.rows] == ['intent', 'error']                # the refused attempt is on the record too, intent first


# ---- what hides a turn from the history -----------------------------------------------------------------------------------------------------------------------------
def test_only_a_turn_whose_first_line_is_exactly_the_marker_of_a_recorded_nonce_is_hidden_over_a_corpus_of_near_misses():
    nonce, other = '0123456789abcdef', 'fedcba9876543210'
    marker = f'[luvebot:skill-draft {nonce}]'
    rnd = random.Random(20261031)
    tails = ['', '\nThe instruction.', '\n\nmore', '\n' + marker, ' tail', '\r\nrest']
    heads = [marker, marker.upper(), marker.replace('[', '(').replace(']', ')'), ' ' + marker, marker + ' ', '\t' + marker, cp(0xa0) + marker, cp(0xfeff) + marker, cp(0x200b) + marker, marker + cp(0x200b),
             f'[luvebot:skill-draft {other}]', f'[luvebot:skill-draft {nonce[:-1]}]', f'[luvebot:skill-draft {nonce}0]', f'[luvebot:skill-draft  {nonce}]', f'[luvebot:skill-draft{nonce}]',
             f'[luvebot:skill-draft {nonce.upper()}]', f'[luvebot:skill-draft {nonce}', f'luvebot:skill-draft {nonce}]', 'oi ' + marker, marker.replace('luvebot', 'luvebo7'), '[luvebot:intro]',
             f'[luvebot:skill-draft {cp(0xff10) + nonce[1:]}]', f'[luvebot:skill-draft {nonce[:8]}{cp(0x200b)}{nonce[8:]}]', f'[luvebot:skill-draft {nonce}]'.replace('skill-draft', 'skill\u2010draft'.replace('\u2010', cp(0x2010)))]
    for _ in range(600):
        heads.append(''.join(rnd.choice(marker + ' []:-' + cp(0x200b) + cp(0xa0)) for _ in range(rnd.randint(20, 40))))
    for head in heads:
        for tail in tails:
            content = head + tail
            oracle = content == marker or content.startswith(marker + '\n')    # the contract's words: the first line is exactly the marker (a line ends at the line feed LuveBot wrote)
            assert m.hides(content, frozenset({nonce})) == oracle, repr(content[:60])
            assert m.hides(content, frozenset()) is False                       # no nonce recorded: nothing is hidden
    for not_text in (None, b'x', 5, ['x'], {'a': 1}):
        assert m.hides(not_text, frozenset({nonce})) is False
    assert m.hides(marker + '\nx', frozenset({other, nonce})) is True and m.hides(marker + '\nx', frozenset({other})) is False
