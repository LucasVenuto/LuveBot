"""Red team (Lume, 29/10): the pause by inactivity (v0.8 section 8) against invariant 7 (the spending cap pauses for real). FIXED.

FINDING (Alta, fixed): `POST /routines/inactivity-resume` -> `inactivity.resume` resumed every routine the inactivity pause paused, for every Bot, with
NO look at the spending cap. The single-routine resume (`resume_routine`, plugin_api.py) refuses with `bot_paused` when `is_paused(path, bot)`
("invariant 7: resuming a job must not undo the pause") and runs `_start_gate`; the bulk one had neither. Sequence: nobody opens LuveBot for the
configured days -> the routines of Bot A are paused (reason `luvebot:inactivity`); Bot A then reaches its cap (the cap skips jobs that are already
paused, so they keep the inactivity reason); the person comes back and presses "Retomar" -> A's routines were scheduled again while A was capped.

The fix SKIPS a held Bot's routines and does not forget them: they stay paused AND remembered, the answer says how many stayed out (`held`), and the
banner stays (its count is what is still held), so a later "Retomar" brings them back once the cap is lifted. Each check also runs with one defect each.
"""
import sqlite3

import pytest

import test_inactivity as ti   # the SAME module instance pytest already imported (its module counter names the packages: a second copy would collide)
hermes_imports = ti.hermes_imports   # the same autouse fixture (the stand-ins for what bot_controls imports at load)


def _paused_by_inactivity(ina, tmp_path):
    db, cron, audit, bots = tmp_path / 'cap.db', ti.Cron(), ti.Audit(), ['vendas', 'default']
    ina.set_days(audit, 'ana', db, 7, now=ti.T0)
    ina.touch(db, 'ana', now=ti.T0 + ti.DAY, clock=lambda: 0.0)
    assert ina.check(db, audit, bots, cron, now=ti.T0 + 9 * ti.DAY) == 2           # j1 (vendas) and j4 (default)
    return db, cron, audit, bots


def _cap(db, bot):
    conn = sqlite3.connect(db)
    conn.execute('CREATE TABLE IF NOT EXISTS budget_pauses (bot TEXT PRIMARY KEY)')   # the table backend/budget.py writes when a cap trips
    conn.execute('INSERT OR IGNORE INTO budget_pauses VALUES (?)', (bot,))
    conn.commit()
    conn.close()


def _uncap(db, bot):
    conn = sqlite3.connect(db)
    conn.execute('DELETE FROM budget_pauses WHERE bot=?', (bot,))
    conn.commit()
    conn.close()


def cap_checks(ina, tmp_path):
    db, cron, audit, bots = _paused_by_inactivity(ina, tmp_path)
    _cap(db, 'vendas')                                                             # vendas reaches its cap after the inactivity pause
    done = ina.resume(audit, 'ana', db, bots, cron)
    assert cron.states()['j1'] == ('paused', 'luvebot:inactivity')                 # the cap holds: vendas stays paused
    assert cron.states()['j4'] == ('scheduled', None)                              # the Bot that is not capped is resumed as before
    assert done == {'resumed': 1, 'held': 1}                                       # and the answer says how many stayed out
    assert ina.status(db)['paused']['count'] == 1                                  # the banner stays, for the one still held
    _uncap(db, 'vendas')                                                           # a person lifts the cap...
    assert ina.resume(audit, 'ana', db, bots, cron) == {'resumed': 1, 'held': 0}   # ...the routine was remembered: the next "Retomar" brings it back
    assert cron.states()['j1'] == ('scheduled', None) and ina.status(db)['paused'] is None


def gate_checks(ina, tmp_path):
    """What the route's start gate refuses (paused by a person, a budget that cannot be verified) keeps a Bot's routines out too."""
    db, cron, audit, bots = _paused_by_inactivity(ina, tmp_path)
    refused = []

    def gate(bot):
        refused.append(bot)
        if bot == 'default':
            raise ina.PluginError('bot_paused', 'This Bot is paused.', 409)
    assert ina.resume(audit, 'ana', db, bots, cron, gate) == {'resumed': 1, 'held': 1}
    assert cron.states()['j1'] == ('scheduled', None) and cron.states()['j4'] == ('paused', 'luvebot:inactivity') and sorted(refused) == ['default', 'vendas']
    assert ina.resume(audit, 'ana', db, bots, cron) == {'resumed': 1, 'held': 0}   # no longer refused: it comes back


def unreadable_cap_checks(ina, tmp_path):
    """A cap that cannot be read keeps the routines paused (fail closed), never a guess that lets work start."""
    db, cron, audit, bots = _paused_by_inactivity(ina, tmp_path)
    conn = sqlite3.connect(db)
    conn.execute('CREATE TABLE budget_pauses (other TEXT)')                        # the table is there but unreadable for the Budget (no `bot` column)
    conn.commit()
    conn.close()
    assert ina.resume(audit, 'ana', db, bots, cron) == {'resumed': 0, 'held': 2}
    assert cron.states()['j1'] == ('paused', 'luvebot:inactivity') and cron.states()['j4'] == ('paused', 'luvebot:inactivity')


CHECKS = {'cap': cap_checks, 'gate': gate_checks, 'unreadable_cap': unreadable_cap_checks}
HELD = "        held = [bot for bot in bots if _held(path, bot, gate)]"
MUTATIONS = [
    ('cap', 'the cap is not looked at', HELD, "        held = []"),
    ('cap', 'the cap check is off', "        if is_paused(path, bot):\n            return True", "        if False:\n            return True"),
    ('cap', 'the held routines are forgotten, the banner goes', "        if left:\n            _write(path, 'UPDATE", "        if False:\n            _write(path, 'UPDATE"),
    ('cap', 'the answer hides how many stayed out', "return {'resumed': count, 'held': left}", "return {'resumed': count, 'held': 0}"),
    ('gate', "the route's gate is ignored", "            gate(bot)\n", "            pass\n"),
    ('unreadable_cap', 'an unreadable cap lets the routines start', "    except (PluginError, BudgetUnavailable):", "    except PluginError:"),
]


@pytest.mark.parametrize('name', sorted(CHECKS))
def test_the_resume_honors_the_cap_and_the_gate(tmp_path, name):
    CHECKS[name](ti.load(), tmp_path)


def test_every_check_has_a_mutation():
    assert set(CHECKS) == {name for name, *_ in MUTATIONS}


@pytest.mark.parametrize('name,label,old,new', MUTATIONS, ids=[f'{n}|{l}' for n, l, *_ in MUTATIONS])
def test_each_mutation_is_caught(tmp_path, name, label, old, new):
    with pytest.raises(Exception):   # a variant may break with another error than the assertion (a raised BudgetUnavailable): it is red all the same
        CHECKS[name](ti.load(('inactivity', old, new)), tmp_path)


def test_control_without_a_cap_the_resume_works(tmp_path):
    """The control: with no cap the same resume brings both routines back (so the checks above are about the cap, not about the setup)."""
    ina = ti.load()
    db, cron, audit, bots = _paused_by_inactivity(ina, tmp_path)
    assert ina.resume(audit, 'ana', db, bots, cron) == {'resumed': 2, 'held': 0}
    assert cron.states()['j1'] == ('scheduled', None) and cron.states()['j4'] == ('scheduled', None)


def test_the_route_hands_the_start_gate_to_the_resume_and_says_what_stayed_out():
    api = (ti.BACKEND.parent / 'dashboard' / 'plugin_api.py').read_text()

    def wired(text):
        route = text.split('async def resume_after_inactivity(', 1)[1].split('\n@router', 1)[0]
        return "lambda bot: _start_gate(budget, meta.path, bot)" in route and "'held': done['held']" in route and "done['resumed']" in route
    assert wired(api)
    assert not wired(api.replace("lambda bot: _start_gate(budget, meta.path, bot)", "None"))
    assert not wired(api.replace("**({'held': done['held']} if done['held'] else {})", ""))
