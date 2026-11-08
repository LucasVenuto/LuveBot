"""SK-2 (the flow) and SK-3 (contract v0.11 section 3.2 to 3.3; invariants 1, 4, 5 and 6): the draft turn, the creation born OFF, the edit, and LuveBot's own toggle, against a stand-in Hermes.
* the draft: the gates first, THEN the nonce recorded, THEN the turn sent (it must never reach the history without its record); the history hides a user turn ONLY when its first line is exactly the marker of a
  recorded nonce, in its own conversation (a prefix, a made-up nonce, an assistant line, another conversation: shown);
* the creation: a text that fails the dry run again reaches no Hermes call; under the (bot, name) lock and ONE audit row (intent first, hashes and sizes, never the text): a name that exists in the list or as a folder is
  409, the name is DISABLED BEFORE the skill exists (a refused write creates nothing), the list is re-read by that name (not found, or found ON, is 502 and the name is disabled again), the name we added is removed if the
  creation failed, the scan is kept; two creations of one name take turns;
* the edit: stale, not editable, redacted, truncated, in that order, then the dry run WITHOUT the new-skill budget, then Hermes's update, one audit row with the hashes and sizes of both texts;
* the toggle: turning ON a skill LuveBot wrote is refused when the scan policy is `block` (the scan asked again now, the stored one only when it cannot run), one never touched is not checked, under the same lock;
* the routes (a scan of plugin_api.py): who may do what, the order of the gates, nothing from the client but the text.
Mutations: one line changed -> red."""
import json
import re
import sys
import threading
import time
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_config_boundary_threads as threads  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
SOURCE = (ROOT / 'backend' / 'skill_teach.py').read_text()
SKILLS_SOURCE = (ROOT / 'backend' / 'skills.py').read_text()
BOT_CONTROLS = (ROOT / 'backend' / 'bot_controls.py').read_text()
API = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
SECRET = 'sk-proj-ABCDEF0123456789abcdef0123456789'
BODY_MARK = 'SEGREDO-CORPO-7f3a'
GOOD = 'Use quando precisar enviar o relatório.'
NONCE = '0123456789abcdef'
OTHER = 'fedcba9876543210'


def load(edits=(), module='skill_teach'):
    name, _ = threads.package()
    return threads.variant(name, module, edits)


def redactor(text):
    return text.replace(SECRET, '***')


def skill(description=GOOD, body=f'1. Abra o CRM. {BODY_MARK}\n2. Exporte o CSV.', name='enviar-relatorio'):
    return f'---\nname: {name}\ndescription: {description}\n---\n{body}'


def entry(name, on=False, provenance='agent'):
    return {'name': name, 'description': 'd', 'category': None, 'provenance': provenance, 'usage': 0, 'essential': False, 'enabled': {'all': on, 'api_server': on}, 'state': 'on' if on else 'off'}


class Fake:
    """Hermes, in memory, with the failures the sequence has to survive."""
    def __init__(self, listed=(), disabled=(), dirs=(), scan=None, texts=None):
        self.listed = {n: p for n, p in listed}
        self.off, self.dirs, self.calls, self.texts = set(disabled), set(dirs), [], dict(texts or {})
        self.scan_value = scan
        self.fail_create = self.toggle_error = None
        self.hidden = self.born_on = False
        self.unknown_state = False
        self.write_then_raise = self.directory_error = self.undo_error = None
        self.attempted = False
        self.audit = None
        self.rows_at_first_call = None

    def _note(self, what):
        if self.rows_at_first_call is None:
            self.rows_at_first_call = len(self.audit.rows) if self.audit else None
        self.calls.append(what)

    def entries(self, bot):
        self._note('entries')
        shown = {n: entry(n, n not in self.off, p) for n, p in self.listed.items() if not (self.hidden and n == getattr(self, 'new', None))}
        if self.unknown_state and getattr(self, 'new', None) in shown:
            shown[self.new]['enabled']['all'] = None
        return shown

    def disabled(self, bot):
        self._note('disabled')
        return set(self.off)

    def directory(self, bot, name):
        self._note('directory')
        if self.directory_error and self.attempted:        # only the question asked AFTER a creation raised
            raise self.directory_error
        return name in self.dirs

    def toggle(self, bot, name, enabled):
        self._note(f'toggle:{name}:{enabled}')
        if self.toggle_error:
            raise self.toggle_error
        if enabled and self.undo_error:
            raise self.undo_error
        (self.off.discard if enabled else self.off.add)(name)

    def create(self, bot, name, content, category):
        self._note('create')
        self.attempted = True
        if self.fail_create:
            raise self.fail_create
        self.listed[name], self.texts[name], self.new = 'agent', content, name
        self.dirs.add(name)
        if self.born_on:
            self.off.discard(name)
        if self.write_then_raise:
            raise self.write_then_raise

    def read(self, bot, name):
        self._note('read')
        if name not in self.texts:
            raise types.SimpleNamespace(code='skill_not_found')  # replaced below
        return self.texts[name]

    def update(self, bot, name, content):
        self._note('update')
        self.texts[name] = content

    def scan(self, bot, name):
        self._note('scan')
        return self.scan_value


class Audit:
    def __init__(self):
        self.rows = []

    def act(self, actor, action, target, origin, fn, *, bot=None, payload=None):
        self.rows.append(('intent', actor, action, target, origin, bot, payload))
        try:
            result = fn()
        except BaseException as error:  # noqa: BLE001
            self.rows.append(('error', action, type(error).__name__))
            raise
        self.rows.append(('ok', action))
        return result


def refusal(call):
    try:
        call()
    except Exception as error:  # noqa: BLE001
        return error
    return None


def caught(call):
    """Like `refusal`, for what is not an `Exception` too (`SystemExit`, `KeyboardInterrupt`)."""
    try:
        call()
    except BaseException as error:  # noqa: BLE001
        return error
    return None


def sha(text):
    import hashlib
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def fake_for(m, **kw):
    fake = Fake(**kw)

    def read(bot, name, _orig=fake.read):
        if name not in fake.texts:
            fake._note('read')
            raise m.PluginError('skill_not_found', 'Skill not found.', 404)
        return _orig(bot, name)
    fake.read = read
    return fake


def create_checks(m, tmp_path):
    db = str(tmp_path / 'create.db')
    # the sequence, in order, inside one audit row whose intent comes first, never holding the text
    audit, fake = Audit(), fake_for(m, scan={'verdict': 'safe', 'policy': 'allow', 'findings': 0, 'categories': []})
    fake.audit = audit
    text = skill()
    out = m.create(audit, db, 'basic:ana', 'vendas', 'enviar-relatorio', None, text, redactor, 'req_1', fake)
    assert fake.calls == ['entries', 'directory', 'disabled', 'toggle:enviar-relatorio:False', 'create', 'scan', 'entries'], fake.calls
    assert out['enabled'] is False and out['skill']['name'] == 'enviar-relatorio' and out['skill']['enabled']['all'] is False and out['scan']['policy'] == 'allow'
    assert fake.rows_at_first_call == 1 and audit.rows[0] == ('intent', 'basic:ana', 'skill.create', 'vendas:enviar-relatorio', {'kind': 'ui', 'ref': 'req_1'}, 'vendas',
                                                              {'category': None, 'sha256': sha(text), 'bytes': len(text.encode())}), audit.rows
    assert audit.rows[-1] == ('ok', 'skill.create') and BODY_MARK not in repr(audit.rows)
    row = m.taught(db, 'vendas', 'enviar-relatorio')
    assert row == {'sha256': sha(text), 'verdict': 'safe', 'policy': 'allow', 'categories': [], 'findings': 0}, row
    assert m.taught(db, 'outro-bot', 'enviar-relatorio') is None and m.taught(db, 'vendas', 'outra') is None
    audit2, fake2 = Audit(), fake_for(m)
    m.create(audit2, db, 'basic:ana', 'vendas', 'com-categoria', 'ops', skill(name='com-categoria'), redactor, 'req_2', fake2)
    assert audit2.rows[0][6]['category'] == 'ops' and m.taught(db, 'vendas', 'com-categoria')['policy'] is None                       # a scan that could not run leaves no policy
    # the dry run runs AGAIN and before any Hermes call
    for bad_name, bad_text, why in (('enviar-relatorio', skill(name='outro'), 'bad_name'), ('Enviar', skill(), 'bad_name'), ('enviar-relatorio', skill(body='1. a\x00'), 'hidden_characters'),
                                   ('enviar-relatorio', skill(body=f'1. {SECRET}'), None), ('enviar-relatorio', skill(description='x' * 61), 'description_too_long')):
        audit3, fake3 = Audit(), fake_for(m)
        error = refusal(lambda: m.create(audit3, db, 'basic:ana', 'vendas', bad_name, None, bad_text, redactor, 'req', fake3))
        assert error is not None and getattr(error, 'why', None) == why and fake3.calls == [] and audit3.rows == [], (bad_name, why)
    error = refusal(lambda: m.create(Audit(), db, 'basic:ana', 'vendas', 'enviar-relatorio', 'venv', skill(), redactor, 'req', fake_for(m)))
    assert error.why == 'bad_category'
    # a name that exists in the list or as a folder is 409 and nothing is touched
    for kw, calls in (({'listed': [('enviar-relatorio', 'agent')]}, ['entries']), ({'dirs': ['enviar-relatorio']}, ['entries', 'directory'])):
        audit4, fake4 = Audit(), fake_for(m, **kw)
        error = refusal(lambda: m.create(audit4, db, 'basic:ana', 'vendas', 'enviar-relatorio', None, skill(), redactor, 'req', fake4))
        assert (error.code, error.status) == ('skill_exists', 409) and fake4.calls == calls and audit4.rows[-1][0] == 'error', fake4.calls
    # a refused write of `skills.disabled` (the config boundary) creates nothing
    audit5, fake5 = Audit(), fake_for(m)
    fake5.toggle_error = m.PluginError('config_key_locked', 'locked', 409)
    error = refusal(lambda: m.create(audit5, db, 'basic:ana', 'vendas', 'sem-escrita', None, skill(name='sem-escrita'), redactor, 'req', fake5))
    assert error.code == 'config_key_locked' and 'create' not in fake5.calls and m.taught(db, 'vendas', 'sem-escrita') is None
    # Hermes refused the creation: the name WE added is removed again, one that was already there stays
    for was_off, tidied in ((False, True), (True, False)):
        audit6, fake6 = Audit(), fake_for(m, disabled=['falha'] if was_off else [])
        fake6.fail_create = m.SkillInvalid('hermes_refused')
        error = refusal(lambda: m.create(audit6, db, 'basic:ana', 'vendas', 'falha', None, skill(name='falha'), redactor, 'req', fake6))
        assert error.why == 'hermes_refused' and (fake6.calls[-1] == 'toggle:falha:True') == tidied and ('falha' in fake6.off) == was_off and m.taught(db, 'vendas', 'falha') is None, (was_off, fake6.calls)
    # after `create` raises the truth is on the DISK (item 5): written, then an Exception = carry on and let the re-read decide; the name is never enabled in between
    audit_w, fake_w = Audit(), fake_for(m)
    fake_w.write_then_raise = m.skills._hermes_error()
    out = m.create(audit_w, db, 'basic:ana', 'vendas', 'gravada', None, skill(name='gravada'), redactor, 'req', fake_w)
    assert out['enabled'] is False and out['skill']['name'] == 'gravada' and 'gravada' in fake_w.off and fake_w.calls == ['entries', 'directory', 'disabled', 'toggle:gravada:False', 'create', 'directory', 'read', 'scan', 'entries'], fake_w.calls
    assert m.taught(db, 'vendas', 'gravada') is not None and audit_w.rows[-1] == ('ok', 'skill.create')
    # SK-2i (F-SK2h-1): a text with a CR, written and then the creation raised: Hermes reads it back with universal newlines (or, in another build, as it wrote it): it is OURS in both
    for index, newline in enumerate(('\r\n', '\r')):
        for universal in (False, True):
            name = f'com-cr-{index}{int(universal)}'
            audit_c, fake_c = Audit(), fake_for(m)
            fake_c.write_then_raise = m.skills._hermes_error()
            if universal:
                real_read = fake_c.read
                fake_c.read = lambda bot, skill_name, real_read=real_read: real_read(bot, skill_name).replace('\r\n', '\n').replace('\r', '\n')
            out_c = m.create(audit_c, db, 'basic:ana', 'vendas', name, None, skill(name=name, body='1. Abra.' + newline + '2. Feche.' + newline), redactor, 'req', fake_c)
            assert out_c['enabled'] is False and name in fake_c.off and m.taught(db, 'vendas', name) is not None and audit_c.rows[-1] == ('ok', 'skill.create'), (newline, universal)
    stranger_cr = Fake()                                                                                  # ...and a stranger's text is still a stranger's whatever its newlines
    stranger_cr.fail_create = None

    def taken_cr(bot, name, content, category, fake=stranger_cr):
        fake._note('create')
        fake.attempted = True
        fake.texts[name] = '---\r\nname: alheia-cr\r\ndescription: Use when asked.\r\n---\r\noutra coisa\r\n'
        fake.dirs.add(name)
        raise m.skills._hermes_error()
    stranger_cr.create = taken_cr
    error_cr = refusal(lambda: m.create(Audit(), db, 'basic:ana', 'vendas', 'alheia-cr', None, skill(name='alheia-cr', body='1. Abra.\r\n'), redactor, 'req', stranger_cr))
    assert (error_cr.code, error_cr.status) == ('skill_exists', 409) and m.taught(db, 'vendas', 'alheia-cr') is None
    audit_w2, fake_w2 = Audit(), fake_for(m)
    fake_w2.write_then_raise, fake_w2.hidden = m.skills._hermes_error(), True                                                                # ...and if the re-read cannot find it, that is the 502 with the name disabled again
    error = refusal(lambda: m.create(audit_w2, db, 'basic:ana', 'vendas', 'gravada-oculta', None, skill(name='gravada-oculta'), redactor, 'req', fake_w2))
    assert error.code == 'skill_state_unverified' and fake_w2.calls[-1] == 'toggle:gravada-oculta:False' and 'toggle:gravada-oculta:True' not in fake_w2.calls and 'gravada-oculta' in fake_w2.off
    audit_w3, fake_w3 = Audit(), fake_for(m)
    fake_w3.write_then_raise, fake_w3.born_on = m.skills._hermes_error(), True                                                              # ...and found ON, it is turned off again
    error = refusal(lambda: m.create(audit_w3, db, 'basic:ana', 'vendas', 'gravada-ligada', None, skill(name='gravada-ligada'), redactor, 'req', fake_w3))
    assert error.code == 'skill_state_unverified' and fake_w3.calls[-1] == 'toggle:gravada-ligada:False' and 'gravada-ligada' in fake_w3.off
    # the question itself fails: that is no proof, so the name is NEVER enabled; the creation is carried on and the re-read has the last word (here: no such skill, so 502)
    audit_q, fake_q = Audit(), fake_for(m)
    fake_q.fail_create, fake_q.directory_error = m.skills._hermes_error(), m.skills._hermes_error()
    error = refusal(lambda: m.create(audit_q, db, 'basic:ana', 'vendas', 'sem-resposta', None, skill(name='sem-resposta'), redactor, 'req', fake_q))
    assert error.code == 'skill_state_unverified' and error.status == 502 and 'toggle:sem-resposta:True' not in fake_q.calls and 'sem-resposta' in fake_q.off and fake_q.calls[-1] == 'toggle:sem-resposta:False' and m.taught(db, 'vendas', 'sem-resposta') is None   # cannot be told: not "somebody else's"
    # F-SK2f-1 (SK-2h): a file that was READ and is another text is a stranger's; one whose read FAILS is 'cannot be told' (502, off again), never a stranger's; the name was taken by somebody else between the check and the create (Hermes refused ours): a stranger's file is NOT carried on, NOT enabled, NOT recorded as taught; the row says error
    for stranger in ('---\nname: alheia\ndescription: Use when asked.\n---\noutra coisa', skill(name='alheia', body='1. Outra.')):
        audit_s, fake_s = Audit(), fake_for(m)

        def taken(bot, name, content, category, fake=fake_s, text=stranger):                                                          # between the check and the create somebody else got there first
            fake._note('create')
            fake.attempted = True
            fake.texts[name] = text
            fake.dirs.add(name)
            raise m.skills._hermes_error()
        fake_s.create = taken
        error = refusal(lambda: m.create(audit_s, db, 'basic:ana', 'vendas', 'alheia', None, skill(name='alheia'), redactor, 'req', fake_s))
        assert (error.code, error.status, error.extra) == ('skill_exists', 409, {'details': {'appeared_meanwhile': True}}), error.code
        assert 'alheia' in fake_s.off and 'toggle:alheia:True' not in fake_s.calls and 'scan' not in fake_s.calls and m.taught(db, 'vendas', 'alheia') is None and audit_s.rows[-1][0] == 'error'
    audit_r, fake_r = Audit(), fake_for(m)                                                                                          # a stranger's file whose read fails is not proven ours either
    def taken_unreadable(bot, name, content, category):
        fake_r._note('create')
        fake_r.attempted = True
        fake_r.dirs.add(name)
        raise m.skills._hermes_error()
    fake_r.create = taken_unreadable
    error = refusal(lambda: m.create(audit_r, db, 'basic:ana', 'vendas', 'ilegivel', None, skill(name='ilegivel'), redactor, 'req', fake_r))
    assert (error.code, error.status) == ('skill_state_unverified', 502) and 'ilegivel' in fake_r.off and fake_r.calls[-1] == 'toggle:ilegivel:False' and 'toggle:ilegivel:True' not in fake_r.calls and m.taught(db, 'vendas', 'ilegivel') is None
    # a BaseException proves nothing and leaves the name disabled, written or not, and goes up unchanged
    for exit_error in (SystemExit(1), KeyboardInterrupt()):
        for written in (True, False):
            audit_b, fake_b = Audit(), fake_for(m)
            if written:
                fake_b.write_then_raise = exit_error
            else:
                fake_b.fail_create = exit_error
            error = caught(lambda: m.create(audit_b, db, 'basic:ana', 'vendas', 'interrompida', None, skill(name='interrompida'), redactor, 'req', fake_b))
            assert error is exit_error and 'interrompida' in fake_b.off and 'toggle:interrompida:True' not in fake_b.calls and fake_b.calls[-1] == 'create' and audit_b.rows[-1][0] == 'error', (exit_error, written, fake_b.calls)
    # the undo never masks the error that started it: if taking the name back fails, the ORIGINAL error goes up and the name stays disabled
    audit_u2, fake_u2 = Audit(), fake_for(m)
    fake_u2.fail_create, fake_u2.undo_error = m.SkillInvalid('hermes_refused'), m.PluginError('config_key_locked', 'locked', 409)
    error = refusal(lambda: m.create(audit_u2, db, 'basic:ana', 'vendas', 'desfaz-falha', None, skill(name='desfaz-falha'), redactor, 'req', fake_u2))
    assert error.why == 'hermes_refused' and 'desfaz-falha' in fake_u2.off and fake_u2.calls[-1] == 'toggle:desfaz-falha:True'
    # the list cannot show the new skill: 502, never a success; and a skill found ON is turned off again, then 502
    audit7, fake7 = Audit(), fake_for(m)
    fake7.hidden = True
    error = refusal(lambda: m.create(audit7, db, 'basic:ana', 'vendas', 'escondida', None, skill(name='escondida'), redactor, 'req', fake7))
    assert (error.code, error.status) == ('skill_state_unverified', 502) and m.taught(db, 'vendas', 'escondida') is not None
    assert fake7.calls[-1] == 'toggle:escondida:False' and 'escondida' in fake7.off and fake7.calls[-2] == 'entries'       # not found: the name is turned off AGAIN before the 502, as when it is found ON
    audit8, fake8 = Audit(), fake_for(m)
    fake8.born_on = True
    error = refusal(lambda: m.create(audit8, db, 'basic:ana', 'vendas', 'nasceu-on', None, skill(name='nasceu-on'), redactor, 'req', fake8))
    assert (error.code, error.status) == ('skill_state_unverified', 502) and fake8.calls[-1] == 'toggle:nasceu-on:False' and 'nasceu-on' in fake8.off and m.taught(db, 'vendas', 'nasceu-on') is not None
    audit_u, fake_u = Audit(), fake_for(m)
    fake_u.unknown_state = True
    error = refusal(lambda: m.create(audit_u, db, 'basic:ana', 'vendas', 'sem-estado', None, skill(name='sem-estado'), redactor, 'req', fake_u))
    assert (error.code, error.status) == ('skill_state_unverified', 502) and fake_u.calls[-1] == 'toggle:sem-estado:False'                # a state that is not a plain False is never "off"
    # two creations of one name take turns: the second finds the first's skill
    fake9, gate, started, results, audit9 = fake_for(m), threading.Event(), threading.Event(), [], Audit()
    inner = fake9.create

    def slow(bot, name, content, category):
        started.set()
        gate.wait(5)
        return inner(bot, name, content, category)
    fake9.create = slow

    def run():
        results.append(refusal(lambda: m.create(audit9, db, 'basic:ana', 'vendas', 'corrida', None, skill(name='corrida'), redactor, 'req', fake9)) or 'created')
    first, second = threading.Thread(target=run), threading.Thread(target=run)
    first.start()
    started.wait(5)
    second.start()
    time.sleep(0.2)
    gate.set()
    first.join(5)
    second.join(5)
    assert sorted(r if isinstance(r, str) else r.code for r in results) == ['created', 'skill_exists'] and fake9.calls.count('toggle:corrida:False') == 1, (results, fake9.calls)
    # ...but the lock is of ONE skill of ONE Bot: another skill, or the same name in another Bot, does not wait
    fake10, held, started10, done, audit10 = fake_for(m), threading.Event(), threading.Event(), [], Audit()
    inner10 = fake10.create

    def hold(bot, name, content, category):
        if name == 'segurada' and bot == 'vendas':
            started10.set()
            held.wait(5)
        return inner10(bot, name, content, category)
    fake10.create = hold
    slow_one = threading.Thread(target=lambda: m.create(audit10, db, 'basic:ana', 'vendas', 'segurada', None, skill(name='segurada'), redactor, 'req', fake10))
    slow_one.start()
    started10.wait(5)
    others = [threading.Thread(target=lambda b=b, n=n: done.append(m.create(Audit(), db, 'basic:ana', b, n, None, skill(name=n), redactor, 'req', fake10)['skill']['name'])) for b, n in (('vendas', 'solta'), ('suporte', 'segurada'))]
    for other in others:
        other.start()
    for other in others:
        other.join(2)
    assert sorted(done) == ['segurada', 'solta'] and slow_one.is_alive(), done                                                           # they finished while the first was still held
    held.set()
    slow_one.join(5)


def edit_checks(m, tmp_path):
    db = str(tmp_path / 'edit.db')
    old = skill(name='minha')
    new = skill(description='Use quando precisar enviar o relatório semanal ao cliente.', body='1. Abra o CRM.\n2. Envie.', name='minha')      # changed, and inside the 60
    listed = [('minha', 'agent'), ('de-hub', 'hub')]

    def run(fake, content=new, expected=None, name='minha', audit=None):
        return m.edit(audit or Audit(), db, 'basic:ana', 'vendas', name, content, expected if expected is not None else sha(fake.texts.get(name, '')), redactor, 'req_9', fake)
    audit, fake = Audit(), fake_for(m, listed=listed, disabled=['minha'], texts={'minha': old, 'de-hub': skill(name='de-hub')}, scan={'verdict': 'safe', 'policy': 'allow', 'findings': 0, 'categories': []})
    fake.audit = audit
    out = run(fake, audit=audit)
    assert fake.calls == ['read', 'entries', 'read', 'update', 'scan'] and fake.texts['minha'] == new and fake.rows_at_first_call == 0, fake.calls    # the first read is before the intent row, the rest inside it
    assert out == {'name': 'minha', 'bytes': len(new.encode()), 'digest': sha(new), 'warnings': [], 'on': False, 'turned_off': False, 'scan': {'verdict': 'safe', 'policy': 'allow', 'findings': 0, 'categories': []}}, out
    assert audit.rows[0] == ('intent', 'basic:ana', 'skill.edit', 'vendas:minha', {'kind': 'ui', 'ref': 'req_9'}, 'vendas',
                             {'from_sha256': sha(old), 'from_bytes': len(old.encode()), 'to_sha256': sha(new), 'to_bytes': len(new.encode())}), audit.rows
    assert BODY_MARK not in repr(audit.rows) and m.taught(db, 'vendas', 'minha')['sha256'] == sha(new)                             # an edited skill is one LuveBot wrote
    fake_on = fake_for(m, listed=listed, texts={'minha': old})
    fake_on.off = set()
    assert run(fake_on)['on'] is True                                                                                                 # the screen says "your Bot uses the change right away"
    # the order of refusals: stale, not editable, redacted, truncated
    secret_text = skill(name='minha', body=f'1. {SECRET}')
    big = skill(name='minha', body=f'1. {SECRET}\n' + 'a' * (256 * 1024 + 10))
    hub = fake_for(m, listed=listed, texts={'de-hub': skill(name='de-hub'), 'minha': secret_text, 'grande': big})
    hub.listed['grande'] = 'agent'
    error = refusal(lambda: run(hub, name='de-hub', expected='0' * 64))
    assert (error.code, error.status) == ('stale', 409)
    error = refusal(lambda: run(hub, name='de-hub'))
    assert (error.code, error.status) == ('skill_not_editable', 422) and 'update' not in hub.calls
    error = refusal(lambda: run(hub, name='minha'))
    assert (error.code, error.status) == ('skill_redacted', 422)
    error = refusal(lambda: run(hub, name='grande'))
    assert (error.code, error.status) == ('skill_redacted', 422)                                                                       # redacted before truncated
    long_text = skill(name='longa', body='1. ' + 'a' * (256 * 1024 + 10))
    longa = fake_for(m, listed=[('longa', 'agent')], texts={'longa': long_text})
    error = refusal(lambda: run(longa, name='longa'))
    assert (error.code, error.status) == ('skill_truncated', 422) and 'update' not in longa.calls
    wide = skill(name='larga', body='1. ' + '\u00e9' * (128 * 1024 + 100))                                                                # fewer characters than the cap, more bytes
    larga = fake_for(m, listed=[('larga', 'agent')], texts={'larga': wide})
    assert len(wide) < 256 * 1024 < len(wide.encode())
    error = refusal(lambda: run(larga, name='larga'))
    assert (error.code, error.status) == ('skill_truncated', 422) and 'update' not in larga.calls
    # the new text goes through the dry run WITHOUT the new-skill budget (a description over 60 is fine), and a bad one reaches no update
    legacy = skill(description='x' * 200, name='minha')
    fresh = fake_for(m, listed=listed, texts={'minha': legacy})
    assert run(fresh, content=skill(description='x' * 200, name='minha', body='1. outro corpo'))['bytes'] > 0                          # a long description the edit does not touch stays editable (the 60 holds only for a CHANGED one)
    assert 'update' in fresh.calls
    for changed in ('y' * 61, 'x' * 201, 'x' * 1000):
        fake_c = fake_for(m, listed=listed, texts={'minha': legacy})
        error = refusal(lambda: run(fake_c, content=skill(description=changed, name='minha')))
        assert (error.why, error.extra['details']) == ('description_too_long', {'limit': 60}) and 'update' not in fake_c.calls and fake_c.texts['minha'] == legacy, len(changed)
    fake_c2 = fake_for(m, listed=listed, texts={'minha': legacy})
    assert run(fake_c2, content=skill(description='y' * 60, name='minha'))['bytes'] > 0                                                  # changed to something that fits the 60
    fake_c3 = fake_for(m, listed=listed, texts={'minha': old})
    error = refusal(lambda: run(fake_c3, content=skill(description='x' * 200, name='minha')))
    assert error.why == 'description_too_long' and 'update' not in fake_c3.calls                                                          # the text before had a short one: this one CHANGES it
    for bad, why in ((skill(name='outra'), 'bad_name'), (skill(name='minha', body='1. a\x00'), 'hidden_characters'), (skill(name='minha', body=''), 'empty_body')):
        fake_bad = fake_for(m, listed=listed, texts={'minha': old})
        error = refusal(lambda: run(fake_bad, content=bad))
        assert error.why == b'' or error.why == why, why
        assert 'update' not in fake_bad.calls and fake_bad.texts['minha'] == old
    fake_secret = fake_for(m, listed=listed, texts={'minha': old})
    error = refusal(lambda: run(fake_secret, content=skill(name='minha', body=f'1. {SECRET}')))
    assert error.code == 'skill_has_secret' and 'update' not in fake_secret.calls
    # an edit that leaves an ON skill with a `block` policy turns it OFF, in the same lock, on the record (A-177); nothing else is touched
    block = {'verdict': 'dangerous', 'policy': 'block', 'findings': 2, 'categories': ['exfiltration']}
    for policy_scan, on_now, expected_off in ((block, True, True), (block, False, False), ({**block, 'policy': 'ask'}, True, False), ({**block, 'policy': 'allow'}, True, False), (None, True, False)):
        audit_t, fake_t = Audit(), fake_for(m, listed=listed, disabled=[] if on_now else ['minha'], texts={'minha': old}, scan=policy_scan)
        out_t = run(fake_t, audit=audit_t)
        assert (out_t['on'], out_t['turned_off']) == ((False, True) if expected_off else (on_now, False)), (policy_scan, on_now, out_t)
        assert ('toggle:minha:False' in fake_t.calls) is expected_off and ('minha' in fake_t.off) is (not on_now or expected_off) and fake_t.texts['minha'] == new
        if expected_off:
            assert [r[0:3] for r in audit_t.rows if r[0] == 'intent'] == [('intent', 'basic:ana', 'skill.edit'), ('intent', 'basic:ana', 'skill.disable')]
            assert audit_t.rows[1] == ('intent', 'basic:ana', 'skill.disable', 'vendas:minha', {'kind': 'ui', 'ref': 'req_9'}, 'vendas', {'enabled': False, 'reason': 'scan_blocked'}) and audit_t.rows[-1] == ('ok', 'skill.edit')
            assert fake_t.calls[-2:] == ['scan', 'toggle:minha:False'] and m.taught(db, 'vendas', 'minha')['policy'] == 'block'
        else:
            assert [r[2] for r in audit_t.rows if r[0] == 'intent'] == ['skill.edit']
    # F-SK2f-2: the text is saved and the scan says block, but turning the skill off FAILS: 200 `on: true, turned_off: false`, never an error that says the edit failed; the failed disable is on the record
    audit_f, fake_f = Audit(), fake_for(m, listed=listed, texts={'minha': old}, scan=block)
    fake_f.toggle_error = m.PluginError('config_key_locked', 'locked', 409)
    try:
        out_f = run(fake_f, audit=audit_f)
    except Exception as error_f:  # noqa: BLE001
        raise AssertionError(f'a failed turn-off broke the edit: {type(error_f).__name__}') from None
    assert (out_f['on'], out_f['turned_off']) == (True, False) and fake_f.texts['minha'] == new and m.taught(db, 'vendas', 'minha')['policy'] == 'block'
    assert [r[0:3] for r in audit_f.rows if r[0] == 'intent'] == [('intent', 'basic:ana', 'skill.edit'), ('intent', 'basic:ana', 'skill.disable')] and ('error', 'skill.disable', 'PluginError') in audit_f.rows and audit_f.rows[-1] == ('ok', 'skill.edit')
    audit_k, fake_k = Audit(), fake_for(m, listed=listed, texts={'minha': old}, scan=block)                                     # an interruption is not a failed turn-off: it goes up
    fake_k.toggle_error = KeyboardInterrupt()
    assert caught(lambda: run(fake_k, audit=audit_k)) is fake_k.toggle_error
    # a skill that does not exist is 404 before any audit row; something that is not text is 400; a lone surrogate is a refusal and never an encoder error
    audit_404 = Audit()
    error = refusal(lambda: run(fake_for(m, listed=listed, texts={}), name='nao-existe', expected='x', audit=audit_404))
    assert (error.code, error.status) == ('skill_not_found', 404) and audit_404.rows == []
    for content, expected in ((5, 'x'), ('x', 5), (None, None), (b'x', 'x')):
        error = refusal(lambda: m.edit(Audit(), db, 'basic:ana', 'vendas', 'minha', content, expected, redactor, 'req', fake_for(m, listed=listed, texts={'minha': old})))
        assert (error.code, error.status) == ('bad_request', 400), (content, expected)
    fake_s = fake_for(m, listed=listed, texts={'minha': old})
    error = refusal(lambda: run(fake_s, content=skill(name='minha', body='1. a\ud800')))
    assert error.why == 'hidden_characters' and 'update' not in fake_s.calls


def toggle_checks(m, tmp_path):
    db = str(tmp_path / 'toggle.db')
    seen = []

    def real_toggle(audit, actor, bot, skill_name, enabled, ref, redact):
        seen.append((bot, skill_name, enabled, m.lock(bot, skill_name).locked()))
        return {'toggled': enabled}
    m.skills.toggle = real_toggle
    blocked = {'verdict': 'dangerous', 'policy': 'block', 'findings': 2, 'categories': ['exfiltration', 'injection']}
    allowed = {'verdict': 'safe', 'policy': 'allow', 'findings': 0, 'categories': []}
    m.record_taught(db, 'vendas', 'minha', sha('x'), allowed)
    m.record_taught(db, 'vendas', 'travada', sha('x'), blocked)
    m.record_taught(db, 'vendas', 'pergunta', sha('x'), {'verdict': 'caution', 'policy': 'ask', 'findings': 1, 'categories': ['network']})
    cases = (('minha', allowed, True), ('minha', blocked, False), ('travada', None, False), ('travada', allowed, True), ('travada', blocked, False), ('pergunta', {'verdict': 'caution', 'policy': 'ask', 'findings': 1, 'categories': ['network']}, True),
             ('nunca-tocada', blocked, True), ('minha', {'verdict': 'caution', 'policy': 'block', 'findings': 1, 'categories': ['network']}, False),
             ('minha', {'verdict': 'dangerous', 'policy': 'ask', 'findings': 3, 'categories': ['exfiltration']}, True))
    for name, scan_now, goes in cases:
        fake = fake_for(m, scan=scan_now)
        error = refusal(lambda: m.toggle(Audit(), db, 'basic:ana', 'vendas', name, True, 'req', redactor, fake))
        if goes:
            assert error is None, (name, scan_now)
        else:
            assert (error.code, error.status) == ('skill_scan_blocked', 409), (name, scan_now)
            assert error.extra['details'] == {'verdict': (scan_now or blocked)['verdict'], 'categories': (scan_now or blocked)['categories']}, error.extra
    assert [s for s in seen if s[1] == 'travada'] == [('vendas', 'travada', True, True)]                                              # only the one that was allowed went through, and under the lock
    fake_never = fake_for(m, scan=blocked)
    m.toggle(Audit(), db, 'basic:ana', 'vendas', 'nunca-tocada', True, 'req', redactor, fake_never)
    assert fake_never.calls == []                                                                                                      # a skill LuveBot never touched is not scanned and not subject to the check
    fake_off = fake_for(m, scan=blocked)
    m.toggle(Audit(), db, 'basic:ana', 'vendas', 'travada', False, 'req', redactor, fake_off)
    assert fake_off.calls == [] and seen[-1] == ('vendas', 'travada', False, True)                                                    # turning OFF tightens: never refused, never scanned


def draft_checks(m, tmp_path):
    db = str(tmp_path / 'draft.db')
    order = []
    text = m.draft_instruction(None, NONCE)

    def gates():
        order.append('gates')

    def send(sent):
        order.append('send')
        assert sent == text and m.draft_nonces(db, ['s1']) == frozenset({NONCE}), 'the turn is sent only AFTER its nonce is recorded'
        return 'run_1', 'running'
    assert m.start_draft(db, 's1', 'basic:ana', NONCE, text, gates, send) == ('run_1', 'running') and order == ['gates', 'send']
    assert m._sql(db, 'SELECT nonce, session_id, run_id, actor FROM skill_drafts') == [(NONCE, 's1', 'run_1', 'basic:ana')]
    # a gate that refuses leaves nothing behind; a turn Hermes queued has no run; a send that fails leaves a record that hides nothing real
    def refuse():
        raise m.PluginError('bot_paused', 'paused', 409)
    sent = []
    error = refusal(lambda: m.start_draft(db, 's2', 'basic:ana', OTHER, text, refuse, lambda t: sent.append(t)))
    assert error.code == 'bot_paused' and sent == [] and m.draft_nonces(db, ['s2']) == frozenset()
    assert m.start_draft(db, 's3', 'basic:ana', '1111111111111111', text, lambda: None, lambda t: None) is None
    assert m._sql(db, "SELECT run_id FROM skill_drafts WHERE nonce = '1111111111111111'") == [(None,)]
    error = refusal(lambda: m.start_draft(db, 's4', 'basic:ana', '2222222222222222', text, lambda: None, lambda t: (_ for _ in ()).throw(RuntimeError('x'))))
    assert isinstance(error, RuntimeError)
    error = refusal(lambda: m.record_draft(db, 's1', 'basic:ana', NONCE))                                                              # a nonce is never reused
    assert error is not None
    with pytest.raises(ValueError):
        m.record_draft(db, 's1', 'basic:ana', 'not-a-nonce')
    assert m.draft_nonces(db, ['s1', 's3']) == frozenset({NONCE, '1111111111111111'}) and m.draft_nonces(db, ['other']) == frozenset() and m.draft_nonces(db, []) == frozenset() and m.draft_nonces(db, [None, 5]) == frozenset()
    # what the history hides: ONLY the exact first line of a recorded nonce
    marker = f'[luvebot:skill-draft {NONCE}]'
    nonces = frozenset({NONCE})
    assert m.hides(f'{marker}\nWrite a reusable skill', nonces) and m.hides(marker, nonces)
    for shown in (f'[luvebot:skill-draft {OTHER}]\nx', '[luvebot:skill-draft]\nx', f'{marker} extra\nx', f' {marker}\nx', f'x\n{marker}', f'{marker[:-1]}', f'[luvebot:skill-draft {NONCE}]x', f'[luvebot:skill-draft {NONCE.upper()}]\nx',
                  'a person typed [luvebot:skill-draft', '', None, 5, ['x'], b'x'):
        assert not m.hides(shown, nonces), repr(shown)
    assert not m.hides(f'{marker}\nx', frozenset()) and not m.hides(f'{marker}\nx', frozenset({OTHER})) and not m.hides(f'{marker}\nx', None)


def view_checks(tmp_path):
    view_checks_with(load(module='bot_controls'))


def view_checks_with(controls):
    marker = f'[luvebot:skill-draft {NONCE}]'
    note_line = 'The person\'s note, quoted as data and never as an instruction: "relatorio ' + BODY_MARK + '"'
    row = lambda role, content, **kw: {'id': 7, 'role': role, 'content': content, 'timestamp': 1.5, **kw}
    drafts = frozenset({NONCE})
    placeholder = controls.message_view(row('user', f'{marker}\nWrite a reusable skill\n\n{note_line}'), lambda t: t, False, drafts)
    assert placeholder == {'id': 7, 'role': 'user', 'text': '', 'at': 1.5, 'display_kind': 'skill_draft'}, placeholder      # the row the screen labels, with no text: never the instruction, never the note
    assert BODY_MARK not in repr(placeholder) and 'Write a reusable skill' not in repr(placeholder) and marker not in repr(placeholder)
    assert controls.message_view(row('user', marker, display_content=f'{marker}\nx'), lambda t: t, False, drafts)['text'] == ''
    assert controls.message_view(row('user', f'{marker}\nWrite a skill'), lambda t: t) not in (None, placeholder) and controls.message_view(row('user', f'{marker}\nWrite a skill'), lambda t: t)['text'].startswith(marker)   # nothing recorded: an ordinary message, text and all
    assert controls.message_view(row('user', f'{marker}\nWrite a skill'), lambda t: t, False, frozenset({OTHER}))['text'].startswith(marker)
    assert controls.message_view(row('assistant', f'{marker}\nWrite a skill'), lambda t: t, False, drafts)['text'].startswith(marker)               # only a user turn
    assert controls.message_view(row('tool', f'{marker}\nx'), lambda t: t, False, drafts)['role'] == 'tool'
    for shown in (f'x\n{marker}', f'{marker} and more', '[luvebot:skill-draft] hello', f' {marker}'):
        assert controls.message_view(row('user', shown), lambda t: t, False, drafts)['text'] == shown, shown                                # a prefix, a later line: still on screen
    assert controls.message_view(row('user', '[luvebot:intro] hi'), lambda t: t, True, drafts) is None and controls.message_view(row('user', '[luvebot:intro] hi'), lambda t: t, False, drafts)['text'] == '[luvebot:intro] hi'


def body_checks(m):
    assert m.validate_draft_body({'session_id': 's1'}) == ('s1', None) and m.validate_draft_body({'session_id': 's1', 'note': 'foco'}) == ('s1', 'foco') and m.validate_draft_body({'session_id': 's1', 'note': None}) == ('s1', None)
    for bad in (None, [], {}, {'note': 'x'}, {'session_id': 5}, {'session_id': 's1', 'note': 5}, {'session_id': 's1', 'profile': 'x'}, {'session_id': 's1', 'instruction': 'x'}, {'session_id': None}):
        assert refusal(lambda: m.validate_draft_body(bad)).code == 'bad_request', bad
    full = {'name': 'a', 'content': 'c', 'dry_run': True}
    assert m.validate_create_body(full) == ('a', None, 'c', True) and m.validate_create_body({**full, 'category': 'ops', 'dry_run': False}) == ('a', 'ops', 'c', False) and m.validate_create_body({**full, 'category': None})[1] is None
    for bad in (None, [], {}, {'name': 'a', 'content': 'c'}, {'name': 'a', 'dry_run': True}, {'content': 'c', 'dry_run': True}, {**full, 'dry_run': 1}, {**full, 'dry_run': 'true'}, {**full, 'dry_run': None}, {**full, 'profile': 'x'},
                {**full, 'name': 5}, {**full, 'content': 5}, {**full, 'category': 5}, {**full, 'extra': 1}):
        assert refusal(lambda: m.validate_create_body(bad)).code == 'bad_request', bad
    assert m.validate_edit_body({'content': 'c', 'expected_digest': 'd'}) == ('c', 'd')
    for bad in (None, [], {}, {'content': 'c'}, {'expected_digest': 'd'}, {'content': 5, 'expected_digest': 'd'}, {'content': 'c', 'expected_digest': 5}, {'content': 'c', 'expected_digest': 'd', 'name': 'x'}):
        assert refusal(lambda: m.validate_edit_body(bad)).code == 'bad_request', bad
    assert m.MAX_BODY == 6 * m.MAX_BYTES + 1024


def checks(m, tmp_path):
    create_checks(m, tmp_path)
    edit_checks(m, tmp_path)
    toggle_checks(m, tmp_path)
    draft_checks(m, tmp_path)
    body_checks(m)


def test_the_creation_the_edit_the_toggle_and_the_draft(tmp_path):
    checks(load(), tmp_path)


def test_the_history_hides_only_a_recorded_draft_turn(tmp_path):
    view_checks(tmp_path)


MUTATIONS = {
    # the draft
    'the nonce is recorded after the send': ("    gates()\n    record_draft(path, session_id, actor, nonce)\n    sent = send(text)", "    gates()\n    sent = send(text)\n    record_draft(path, session_id, actor, nonce)"),
    'the nonce is recorded before the gates': ("    gates()\n    record_draft(path, session_id, actor, nonce)\n    sent = send(text)", "    record_draft(path, session_id, actor, nonce)\n    gates()\n    sent = send(text)"),
    'the gates are skipped': ("    gates()\n    record_draft(path, session_id, actor, nonce)", "    record_draft(path, session_id, actor, nonce)"),
    'the run is not kept with its nonce': ("    if sent is not None:\n        set_draft_run(path, nonce, sent[0])", "    if False:\n        set_draft_run(path, nonce, sent[0])"),
    'a queued turn is given a run': ("    if sent is not None:\n        set_draft_run(path, nonce, sent[0])\n    return sent", "    if sent is None:\n        sent = ('queued', 'queued')\n    set_draft_run(path, nonce, sent[0])\n    return sent"),
    'a nonce may be reused': ("'INSERT INTO skill_drafts (nonce, session_id, actor, at) VALUES (?, ?, ?, ?)'", "'INSERT OR REPLACE INTO skill_drafts (nonce, session_id, actor, at) VALUES (?, ?, ?, ?)'"),
    'a nonce that is not one is recorded': ("    marker(nonce)\n    _sql(path, 'INSERT INTO skill_drafts", "    _sql(path, 'INSERT INTO skill_drafts"),
    'the nonces of every session are returned': ("f'SELECT nonce FROM skill_drafts WHERE session_id IN ({\",\".join(\"?\" * len(ids))})', ids)", "'SELECT nonce FROM skill_drafts', [])"),
    'a prefix hides a turn': ("    return any(first == f'[luvebot:skill-draft {nonce}]' for nonce in nonces)", "    return any(first.startswith('[luvebot:skill-draft') for nonce in nonces)"),
    'a made-up nonce hides a turn': ("    return any(first == f'[luvebot:skill-draft {nonce}]' for nonce in nonces)", "    return first.startswith('[luvebot:skill-draft ') and first.endswith(']')"),
    'the first line is a prefix of the text': ("    first = content.split('\\n', 1)[0]\n    return any(first == f'[luvebot:skill-draft {nonce}]' for nonce in nonces)", "    return any(content.startswith(f'[luvebot:skill-draft {nonce}]') for nonce in nonces)"),
    'a marker anywhere hides a turn': ("    first = content.split('\\n', 1)[0]\n    return any(first == f'[luvebot:skill-draft {nonce}]' for nonce in nonces)", "    return any(f'[luvebot:skill-draft {nonce}]' in content for nonce in nonces)"),
    'a turn is hidden with no nonce recorded': ("    if not nonces or type(content) is not str:\n        return False", "    if type(content) is not str:\n        return False"),
    # the creation
    'the dry run is not repeated': ("    preview = dry_run(name, content, category, True, redact)\n    hermes = hermes or Hermes()\n    sha256 = _digest(content)", "    preview = {'category': category, 'bytes': len(content)}\n    hermes = hermes or Hermes()\n    sha256 = _digest(content)"),
    'the dry run is for an edit': ("    preview = dry_run(name, content, category, True, redact)\n    hermes = hermes or Hermes()", "    preview = dry_run(name, content, category, False, redact)\n    hermes = hermes or Hermes()"),
    'an existing name is overwritten': ("            if name in hermes.entries(bot) or hermes.directory(bot, name):\n                raise PluginError('skill_exists', 'A skill with this name already exists in this Bot.', 409)", "            pass"),
    'only the list is checked': ("if name in hermes.entries(bot) or hermes.directory(bot, name):", "if name in hermes.entries(bot):"),
    'only the folder is checked': ("if name in hermes.entries(bot) or hermes.directory(bot, name):", "if hermes.directory(bot, name):"),
    'the name is disabled after the skill is created': ("            hermes.toggle(bot, name, False)                        # BEFORE the skill exists: a skill born ON would be loadable until this call ended\n            try:\n                hermes.create(bot, name, content, preview['category'])\n            except Exception:", "            try:\n                hermes.create(bot, name, content, preview['category'])\n                hermes.toggle(bot, name, False)\n            except Exception:"),
    'the name is never disabled': ("            hermes.toggle(bot, name, False)                        # BEFORE the skill exists: a skill born ON would be loadable until this call ended\n", ""),
    'the name we added stays after a failure': ('                    if not was_off:\n                        _undo(hermes, bot, name)', '                    if False:\n                        _undo(hermes, bot, name)'),
    'a name that was already disabled is enabled after a failure': ('                    if not was_off:\n                        _undo(hermes, bot, name)', '                    if True:\n                        _undo(hermes, bot, name)'),
    'a skill not found in the list is a success': ("            if entry is None:                                      # Hermes's list is cached by file signature: a fresh skill can be missing from it\n                hermes.toggle(bot, name, False)                    # ...and then it is the name that is turned off again, as in the case below, so \"turned off again\" is true in both\n                raise _unverified()\n", "            if entry is None:\n                return {'name': name, 'enabled': {'all': False}}, scan\n"),
    'a skill not found is not turned off again': ("                hermes.toggle(bot, name, False)                    # ...and then it is the name that is turned off again, as in the case below, so \"turned off again\" is true in both\n", ""),
    'a skill found ON is only a warning': ("                hermes.toggle(bot, name, False)                    # somebody enabled the name between the two steps (the Hermes CLI, another dashboard): no lock of ours covers that\n                raise _unverified()", "                pass"),
    'a skill found ON is not turned off again': ("                hermes.toggle(bot, name, False)                    # somebody enabled the name between the two steps (the Hermes CLI, another dashboard): no lock of ours covers that\n                raise _unverified()", "                raise _unverified()"),
    'the enabled flag is not read': ("            if entry['enabled']['all'] is not False:", "            if False:"),
    'an unreadable state counts as off': ("            if entry['enabled']['all'] is not False:", "            if entry['enabled']['all']:"),
    'the creation is not under the lock': ("    def effect():\n        with lock(bot, name):\n            if name in hermes.entries(bot) or hermes.directory(bot, name):", "    def effect():\n        with threading.Lock():\n            if name in hermes.entries(bot) or hermes.directory(bot, name):"),
    'the lock is one for every skill': ("        return _LOCKS.setdefault((bot, name), threading.Lock())", "        return _LOCKS.setdefault('all', threading.Lock())"),
    'the lock is per name only': ("        return _LOCKS.setdefault((bot, name), threading.Lock())", "        return _LOCKS.setdefault(name, threading.Lock())"),
    'the taught row is not written': ("            record_taught(path, bot, name, sha256, scan)           # the skill exists now", "            pass                                                   # the skill exists now"),
    'the taught row is written only when verified': ("            scan = hermes.scan(bot, name)\n            record_taught(path, bot, name, sha256, scan)           # the skill exists now: it is one LuveBot wrote (and turning it on is checked), verified OFF or not\n            entry = hermes.entries(bot).get(name)",
                                                     "            scan = hermes.scan(bot, name)\n            entry = hermes.entries(bot).get(name)"),
    'the audit row is written after the effect': ("    entry, scan = audit.act(actor, 'skill.create', f'{bot}:{name}', {'kind': 'ui', 'ref': ref}, effect, bot=bot,\n                            payload={'category': preview['category'], 'sha256': sha256, 'bytes': preview['bytes']})",
                                                  "    entry, scan = effect()\n    audit.act(actor, 'skill.create', f'{bot}:{name}', {'kind': 'ui', 'ref': ref}, lambda: None, bot=bot,\n              payload={'category': preview['category'], 'sha256': sha256, 'bytes': preview['bytes']})"),
    'the audit holds the text': ("payload={'category': preview['category'], 'sha256': sha256, 'bytes': preview['bytes']})", "payload={'category': preview['category'], 'sha256': sha256, 'bytes': preview['bytes'], 'text': content})"),
    'the audit action is another': ("'skill.create', f'{bot}:{name}'", "'skill.make', f'{bot}:{name}'"),
    'the created skill is answered as on': ("    return {'skill': skills.view(entry, redact), 'enabled': False, 'scan': scan}", "    return {'skill': skills.view(entry, redact), 'enabled': True, 'scan': scan}"),
    # the edit
    'the edit is not checked for staleness': ("            if _digest(real) != expected:\n                raise PluginError('stale',", "            if False:\n                raise PluginError('stale',"),
    'the staleness is checked on the shown text': ("            if _digest(real) != expected:", "            if _digest(redact(real)) != expected:"),
    'any provenance is editable': ("            if entry.get('provenance') != 'agent':", "            if False:"),
    'a hub skill is editable': ("            if entry.get('provenance') != 'agent':", "            if entry.get('provenance') not in ('agent', 'hub'):"),
    'a redacted text is saved': ("            if redact(real) != real:\n                raise PluginError('skill_redacted',", "            if False:\n                raise PluginError('skill_redacted',"),
    'a truncated text is saved': ("            if len(real.encode('utf-8')) > skills.CONTENT_MAX:", "            if False:"),
    'the truncation is counted in characters': ("            if len(real.encode('utf-8')) > skills.CONTENT_MAX:", "            if len(real) > skills.CONTENT_MAX:"),
    'the redaction is checked after the truncation': ("            if redact(real) != real:\n                raise PluginError('skill_redacted', 'This skill holds text LuveBot hides (a key or a line that looks like a password), so saving it here would overwrite that text. Edit it in Hermes.', 422)\n            if len(real.encode('utf-8')) > skills.CONTENT_MAX:\n                raise PluginError('skill_truncated', 'This skill is longer than LuveBot shows, so saving it here would cut the end. Edit it in Hermes.', 422)",
                                                     "            if len(real.encode('utf-8')) > skills.CONTENT_MAX:\n                raise PluginError('skill_truncated', 'This skill is longer than LuveBot shows, so saving it here would cut the end. Edit it in Hermes.', 422)\n            if redact(real) != real:\n                raise PluginError('skill_redacted', 'This skill holds text LuveBot hides (a key or a line that looks like a password), so saving it here would overwrite that text. Edit it in Hermes.', 422)"),
    'the edit is checked as a new skill': ('            preview = dry_run(name, content, None, False, redact, real)', '            preview = dry_run(name, content, None, True, redact, real)'),
    'the edit skips the dry run': ('            preview = dry_run(name, content, None, False, redact, real)', "            preview = {'bytes': len(content), 'warnings': []}"),
    'the edit is written before the checks': ('            hermes.update(bot, name, content)\n            scan = hermes.scan(bot, name)\n            record_taught(path, bot, name, _digest(content), scan)\n            on, turned_off', '            scan = hermes.scan(bot, name)\n            record_taught(path, bot, name, _digest(content), scan)\n            on, turned_off'),
    'the edit is not recorded as taught': ('            record_taught(path, bot, name, _digest(content), scan)\n            on, turned_off', '            on, turned_off'),
    'the edit does not scan again': ("            hermes.update(bot, name, content)\n            scan = hermes.scan(bot, name)", "            hermes.update(bot, name, content)\n            scan = None"),
    'the edit reads the skill after the intent': ("    before = hermes.read(bot, name)                               # 404 before the audit row; its hash and size go in the intent\n", "    before = ''\n"),
    'the audit of an edit lacks the old hash': ("payload={'from_sha256': _digest(before), 'from_bytes': len(before.encode('utf-8')), 'to_sha256'", "payload={'from_sha256': None, 'from_bytes': 0, 'to_sha256'"),
    'the audit of an edit holds the text': ("'to_bytes': len(content.encode('utf-8', 'surrogatepass'))})", "'to_bytes': len(content.encode('utf-8', 'surrogatepass')), 'text': content})"),
    'the digest of a lone surrogate breaks': ("_digest = skills.digest      #", "_digest = lambda text: __import__('hashlib').sha256(text.encode('utf-8')).hexdigest()      #"),
    'the edit takes content that is not text': ("    if type(content) is not str or type(expected) is not str:\n        raise PluginError('bad_request', 'Send \"content\" and \"expected_digest\" as text.', 400)\n", ""),
    'an edit answers whether the skill is on wrongly': ("on, turned_off = entry['enabled']['all'] is True, False", 'on, turned_off = False, False'),
    # the toggle
    'a blocked skill is turned on': ("                if now.get('policy') == 'block':", "                if False:"),
    'only a dangerous verdict blocks': ("                if now.get('policy') == 'block':", "                if now.get('verdict') == 'dangerous':"),
    'an ask verdict blocks': ("                if now.get('policy') == 'block':", "                if now.get('policy') in ('block', 'ask'):"),
    'a skill never touched is checked': ("            row = taught(path, bot, skill)\n            if row is not None:\n                now = (hermes or Hermes()).scan(bot, skill) or row", "            row = taught(path, bot, skill) or {}\n            if True:\n                now = (hermes or Hermes()).scan(bot, skill) or row"),
    'turning off is checked too': ("        if enabled:\n            row = taught(path, bot, skill)", "        if True:\n            row = taught(path, bot, skill)"),
    'the stored scan outranks the fresh one': ("                now = (hermes or Hermes()).scan(bot, skill) or row", "                now = row or (hermes or Hermes()).scan(bot, skill)"),
    'the fresh scan is never asked': ("                now = (hermes or Hermes()).scan(bot, skill) or row", "                now = row"),
    'a scan that cannot run lets it through': ("                now = (hermes or Hermes()).scan(bot, skill) or row", "                now = (hermes or Hermes()).scan(bot, skill) or {}"),
    'the toggle is not under the lock': ("    with lock(bot, skill):\n        if enabled:", "    with threading.Lock():\n        if enabled:"),
    'the refusal tells nothing': ("{'details': {'verdict': now.get('verdict'), 'categories': now.get('categories') or []}}", "None"),
    'the refusal is a 403': ("\"Hermes's scan blocks this skill; it cannot be turned on from here.\", 409,", "\"Hermes's scan blocks this skill; it cannot be turned on from here.\", 403,"),
    # the shapes
    'a dry_run default is allowed': ("{'name', 'content', 'dry_run'} - set(body) or type(body['dry_run']) is not bool", "False or False"),
    'a dry_run that is not a boolean is allowed': ("or type(body['dry_run']) is not bool:\n        raise _bad_body('Send \"name\", \"content\" and \"dry_run\"", "or False:\n        raise _bad_body('Send \"name\", \"content\" and \"dry_run\""),
    'a profile may come in the body': ("set(body) - {'name', 'category', 'content', 'dry_run'}", "set(body) - {'name', 'category', 'content', 'dry_run', 'profile'}"),
    'a draft takes the instruction from the client': ("set(body) - {'session_id', 'note'}", "set(body) - {'session_id', 'note', 'instruction'}"),
    'an edit takes more than two fields': ("set(body) != {'content', 'expected_digest'}", "not {'content', 'expected_digest'} <= set(body)"),
    'the body limit is 32 KiB': ("MAX_BODY = 6 * MAX_BYTES + 1024", "MAX_BODY = MAX_BYTES"),
    'a file that cannot be read is ours': ('    except Exception:  # noqa: BLE001\n        return None\n    return _digest(_lf(text)) == _digest(_lf(content))', '    except Exception:  # noqa: BLE001\n        return True\n    return _digest(_lf(text)) == _digest(_lf(content))'),
    "a failed read is a stranger's": ('    except Exception:  # noqa: BLE001\n        return None\n    return _digest(_lf(text)) == _digest(_lf(content))', '    except Exception:  # noqa: BLE001\n        return False\n    return _digest(_lf(text)) == _digest(_lf(content))'),
    'a failed read is carried on': ('                    if ours is None:\n', '                    if False:\n'),
    'a failed read does not turn the name off again': ('                        hermes.toggle(bot, name, False)            # cannot be told', '                        pass                                       # cannot be told'),
    'the undo runs without asking the disk': ('                if _on_disk(hermes, bot, name):\n                    ours = _ours(', '                if False:\n                    ours = _ours('),
    'a skill on the disk is not carried on': ('                if _on_disk(hermes, bot, name):\n                    ours = _ours(hermes, bot, name, content)', '                if _on_disk(hermes, bot, name):\n                    raise'),
    "a stranger's file is carried on": ('                    if ours is False:\n', '                    if False:\n'),
    'every file on the disk is ours': ('    return _digest(_lf(text)) == _digest(_lf(content))', '    return True'),
    'the raw text is compared': ("    return _digest(_lf(text)) == _digest(_lf(content))", "    return _digest(text) == _digest(content)"),
    'only the reviewed text is read as Hermes reads it': ("    return _digest(_lf(text)) == _digest(_lf(content))", "    return _digest(text) == _digest(_lf(content))"),
    'only the file is read as Hermes reads it': ("    return _digest(_lf(text)) == _digest(_lf(content))", "    return _digest(_lf(text)) == _digest(content)"),
    'a CRLF is not read as one newline': ("    return text.replace('\\r\\n', '\\n').replace('\\r', '\\n')", "    return text.replace('\\r', '\\n')"),
    'a lone CR is not a newline': ("    return text.replace('\\r\\n', '\\n').replace('\\r', '\\n')", "    return text.replace('\\r\\n', '\\n')"),
    'every text is the same once its newlines are read': ("    return _digest(_lf(text)) == _digest(_lf(content))", "    return _digest(_lf(text)[:20]) == _digest(_lf(content)[:20])"),
    'the stranger is refused without its mark': ("{'details': {'appeared_meanwhile': True}}", 'None'),
    'the stranger is refused as another error': ("'skill_exists', 'A skill with this name already exists in this Bot.', 409, {'details': {'appeared_meanwhile': True}}", "'skill_state_unverified', 'A skill with this name already exists in this Bot.', 409, {'details': {'appeared_meanwhile': True}}"),
    'a failed turn-off is an error': ('                except Exception:  # noqa: BLE001\n                    pass                                           # the text is already saved', '                except ZeroDivisionError:\n                    pass                                           # the text is already saved'),
    'a failed turn-off is called turned off': ("                try:\n                    audit.act(actor, 'skill.disable'", "                on, turned_off = False, True\n                try:\n                    audit.act(actor, 'skill.disable'"),
    'an interruption is swallowed by the turn-off': ('                except Exception:  # noqa: BLE001\n                    pass                                           # the text is already saved', '                except BaseException:  # noqa: BLE001\n                    pass                                           # the text is already saved'),
    'a question that fails is read as absent': ('    try:\n        return bool(hermes.directory(bot, name))\n    except Exception:  # noqa: BLE001\n        return True', '    try:\n        return bool(hermes.directory(bot, name))\n    except Exception:  # noqa: BLE001\n        return False'),
    'a question that fails is not caught': ('    try:\n        return bool(hermes.directory(bot, name))\n    except Exception:  # noqa: BLE001\n        return True', '    try:\n        return bool(hermes.directory(bot, name))\n    except ZeroDivisionError:\n        return True'),
    'an interruption is carried on': ('            except BaseException:\n                raise                                              # SystemExit', '            except BaseException:\n                pass                                               # SystemExit'),
    'an interruption takes the name back': ('            except BaseException:\n                raise                                              # SystemExit', '            except BaseException:\n                _undo(hermes, bot, name)\n                raise                                              # SystemExit'),
    'the undo masks the error that started it': ('    try:\n        hermes.toggle(bot, name, True)\n    except Exception:  # noqa: BLE001\n        pass', '    hermes.toggle(bot, name, True)'),
    'the undo hides a refusal of the config boundary': ('    try:\n        hermes.toggle(bot, name, True)\n    except Exception:  # noqa: BLE001\n        pass', "    try:\n        hermes.toggle(bot, name, True)\n    except Exception:  # noqa: BLE001\n        raise RuntimeError('undo')"),
    'the edit does not pass the text before': ('dry_run(name, content, None, False, redact, real)', 'dry_run(name, content, None, False, redact)'),
    'a blocked edit leaves the skill on': ("            if on and scan and scan.get('policy') == 'block':", '            if False:'),
    'an ask edit turns the skill off': ("scan.get('policy') == 'block':\n                # a blocked skill", "scan.get('policy') in ('block', 'ask'):\n                # a blocked skill"),
    'an edit turns off a skill that was off': ("            if on and scan and scan.get('policy') == 'block':", "            if scan and scan.get('policy') == 'block':"),
    'an edit without a scan turns the skill off': ("            if on and scan and scan.get('policy') == 'block':", "            if on and (not scan or scan.get('policy') == 'block'):"),
    'the turn-off is not on the record': ("                audit.act(actor, 'skill.disable', f'{bot}:{name}', {'kind': 'ui', 'ref': ref}, lambda: hermes.toggle(bot, name, False), bot=bot, payload={'enabled': False, 'reason': 'scan_blocked'})", '                hermes.toggle(bot, name, False)'),
    'the turn-off is another action': ("'skill.disable', f'{bot}:{name}', {'kind': 'ui', 'ref': ref}, lambda", "'skill.edit.off', f'{bot}:{name}', {'kind': 'ui', 'ref': ref}, lambda"),
    'the turn-off says no reason': ("payload={'enabled': False, 'reason': 'scan_blocked'})", "payload={'enabled': False})"),
    'the turn-off turns the skill ON': ("lambda: hermes.toggle(bot, name, False), bot=bot, payload={'enabled': False, 'reason': 'scan_blocked'})", "lambda: hermes.toggle(bot, name, True), bot=bot, payload={'enabled': False, 'reason': 'scan_blocked'})"),
    'the answer does not say it turned the skill off': ('                on, turned_off = False, True\n', '                on, turned_off = False, False\n'),
    'the answer still says on after turning off': ('                on, turned_off = False, True\n', '                on, turned_off = True, True\n'),
    'the answer never says turned_off': ("'on': on, 'turned_off': turned_off, 'scan': scan}", "'on': on, 'turned_off': False, 'scan': scan}"),
    'the answer lacks turned_off': ("'on': on, 'turned_off': turned_off, 'scan': scan}", "'on': on, 'scan': scan}"),
}


@pytest.mark.parametrize('label', sorted(MUTATIONS))
def test_each_mutation_is_caught(label, tmp_path):
    old, new = MUTATIONS[label]
    assert SOURCE.count(old) == 1, label                      # an anchor that moved fails HERE
    m = load([(old, new)])
    with pytest.raises(BaseException):  # noqa: B017
        checks(m, tmp_path)


VIEW_MUTATIONS = {
    'the history hides every user turn with the marker prefix': ("    if role == 'user' and skill_teach.hides(content, drafts):", "    if role == 'user' and isinstance(content, str) and content.startswith('[luvebot:skill-draft'):"),
    'the history hides assistant turns too': ("    if role == 'user' and skill_teach.hides(content, drafts):", "    if skill_teach.hides(content, drafts):"),
    'the history never hides': ("    if role == 'user' and skill_teach.hides(content, drafts):", "    if False:"),
    'the placeholder holds the turn': ("'text': '', 'at': row.get('timestamp'), 'display_kind': 'skill_draft'}", "'text': content, 'at': row.get('timestamp'), 'display_kind': 'skill_draft'}"),
    'the placeholder holds the marker line': ("'text': '', 'at': row.get('timestamp'), 'display_kind': 'skill_draft'}", "'text': content.split('\\n', 1)[0], 'at': row.get('timestamp'), 'display_kind': 'skill_draft'}"),
    'the placeholder holds the note': ("'text': '', 'at': row.get('timestamp'), 'display_kind': 'skill_draft'}", "'text': content.split('\\n')[-1], 'at': row.get('timestamp'), 'display_kind': 'skill_draft'}"),
    'the placeholder is no kind': ("'text': '', 'at': row.get('timestamp'), 'display_kind': 'skill_draft'}", "'text': '', 'at': row.get('timestamp')}"),
    'the placeholder is another kind': ("'display_kind': 'skill_draft'}", "'display_kind': 'hidden'}"),
    'the placeholder has no id': ("return {'id': row.get('id'), 'role': 'user', 'text': ''", "return {'id': None, 'role': 'user', 'text': ''"),
    'the placeholder has no time': ("'at': row.get('timestamp'), 'display_kind': 'skill_draft'}", "'at': None, 'display_kind': 'skill_draft'}"),
    'the placeholder is an assistant row': ("return {'id': row.get('id'), 'role': 'user', 'text': ''", "return {'id': row.get('id'), 'role': 'assistant', 'text': ''"),
    'the placeholder is the same row for any turn': ("    if role == 'user' and skill_teach.hides(content, drafts):\n        # the turn LuveBot sent", "    if role == 'user' and isinstance(content, str) and drafts:\n        # the turn LuveBot sent"),
}


@pytest.mark.parametrize('label', sorted(VIEW_MUTATIONS))
def test_each_history_mutation_is_caught(label, tmp_path):
    old, new = VIEW_MUTATIONS[label]
    assert BOT_CONTROLS.count(old) == 1, label
    controls = load([(old, new)], module='bot_controls')
    with pytest.raises(BaseException):  # noqa: B017
        view_checks_with(controls)


def test_messages_asks_the_database_for_the_nonces_of_the_conversation_and_its_tip():
    """Static: `messages()` reads the nonces recorded for `sid` AND `tip` (the conversation may have moved on to a new session) and passes them to every view; the route hands it the database."""
    assert "drafts = skill_teach.draft_nonces(drafts_db, (sid, tip)) if drafts_db else frozenset()" in BOT_CONTROLS and BOT_CONTROLS.count('message_view(row, redact, intro, drafts)') == 1
    assert "bot_controls.messages, name, sid, limit, before, _REDACT, intro, meta.path, actor)" in API


# ---- SK-3: what GET .../content tells the editor -----------------------------------------------------------------------------------------------------------------
def content_checks(skills_mod, monkeypatch):
    text = skill(name='minha')

    def view(provenance, content, redact=redactor):
        monkeypatch.setattr(skills_mod, '_entry', lambda bot, name: ([], {'provenance': provenance}))
        monkeypatch.setitem(sys.modules, 'hermes_cli', types.ModuleType('hermes_cli'))
        monkeypatch.setitem(sys.modules, 'hermes_cli.web_routers', types.ModuleType('hermes_cli.web_routers'))
        fake = types.ModuleType('hermes_cli.web_routers.skills')

        async def get_skill_content(name, profile=None):
            return {'content': content}
        fake.get_skill_content = get_skill_content
        monkeypatch.setitem(sys.modules, 'hermes_cli.web_routers.skills', fake)
        return skills_mod.content('vendas', 'minha', redact)
    out = view('agent', text)
    assert out['digest'] == sha(text) and out['editable'] is True and out['redacted'] is False and out['truncated'] is False and out['content'] == text
    assert view('hub', text)['editable'] is False and view('bundled', text)['editable'] is False and view('external', text)['editable'] is False and view(None, text)['editable'] is False
    secret = skill(name='minha', body=f'1. {SECRET}')
    out = view('agent', secret)
    assert out['redacted'] is True and out['editable'] is False and out['digest'] == sha(secret) and SECRET not in out['content']           # the digest is of the REAL text; the text shown is not
    big = skill(name='minha', body='a' * (256 * 1024 + 10))
    out = view('agent', big)
    assert out['truncated'] is True and out['editable'] is False and out['digest'] == sha(big) and len(out['content'].encode()) <= 256 * 1024
    assert len(skills_mod.digest('x\ud800y')) == 64 and skills_mod.digest('x\ud800y') != skills_mod.digest('xy')                        # a lone surrogate is a digest, not a crash


def test_the_content_of_a_skill_tells_the_editor_what_it_may_do(monkeypatch):
    content_checks(load(module='skills'), monkeypatch)


SKILLS_MUTATIONS = {
    'any provenance is editable': ("            'editable': entry.get('provenance') == 'agent' and not redacted and not truncated}", "            'editable': not redacted and not truncated}"),
    'a redacted text is editable': ("            'editable': entry.get('provenance') == 'agent' and not redacted and not truncated}", "            'editable': entry.get('provenance') == 'agent' and not truncated}"),
    'a truncated text is editable': ("            'editable': entry.get('provenance') == 'agent' and not redacted and not truncated}", "            'editable': entry.get('provenance') == 'agent' and not redacted}"),
    'the digest is of the shown text': ("'truncated': truncated, 'digest': digest(text),", "'truncated': truncated, 'digest': digest(shown),"),
    'the digest is of the cut text': ("'truncated': truncated, 'digest': digest(text),", "'truncated': truncated, 'digest': digest(cut),"),
    'the digest is missing': ("'truncated': truncated, 'digest': digest(text),", "'truncated': truncated,"),
    'the digest breaks on a lone surrogate': ("    return hashlib.sha256(text.encode('utf-8', 'surrogatepass')).hexdigest()", "    return hashlib.sha256(text.encode('utf-8')).hexdigest()"),
    'every provenance is agent': ("'provenance': entry.get('provenance') if entry.get('provenance') in ('hub', 'bundled', 'agent') else 'agent',", "'provenance': 'agent',"),
}


@pytest.mark.parametrize('label', sorted(SKILLS_MUTATIONS))
def test_each_skills_mutation_is_caught(label, monkeypatch):
    old, new = SKILLS_MUTATIONS[label]
    assert SKILLS_SOURCE.count(old) == 1, label
    if label == 'every provenance is agent':
        return                                                                                                                               # `view` is the matrix's and has its own tests (test_skills.py)
    m = load([(old, new)], module='skills')
    with pytest.raises(BaseException):  # noqa: B017
        content_checks(m, monkeypatch)


# ---- the routes (a scan of plugin_api.py) --------------------------------------------------------------------------------------------------------------------
def body_of(text, route):
    start = text.index(route)
    end = re.search(r"\n\n\n(?:@router|def |async def |_[A-Z_]+ =|class |# ----)", text[start:])
    return text[start:start + end.start()] if end else text[start:]


def route_checks(api):
    draft, create, edit = body_of(api, "@router.post('/bots/{bot}/skills/draft')"), body_of(api, "@router.post('/bots/{bot}/skills')"), body_of(api, "@router.put('/bots/{bot}/skills/{skill}/content')")
    toggle_route = body_of(api, "@router.put('/bots/{bot}/skills/{skill}')")
    for route in (draft, create, edit, toggle_route):
        assert '_identity(request)' in route and '_require_csrf(request, credential)' in route and route.index('_require_csrf') < route.index('await '), route[:60]
    # the draft: allowed in loopback (no `_human`), the note is the only client text, the instruction is built before anything is recorded, the order of the effect is `start_draft`'s
    assert '_human(request)' not in draft and 'skill_teach.validate_draft_body(await _json_body(request))' in draft and 'safe_id(session_id) is None' in draft
    assert draft.index('skill_teach.draft_instruction(note, nonce)') < draft.index('audit.act') and 'skill_teach.new_nonce()' in draft and draft.count('skill_teach.start_draft(') == 1 and "'skill.draft.request'" in draft
    assert "hook.hook_gate(meta.path, name)" in draft and "budget_gate(budget, meta.path, name)" in draft and "payload={'session_id': session_id, 'note_length': len(note or '')}" in draft
    assert "'/v1/runs', {'input': instruction, 'session_id': session_id}" in draft and 'approvals_native.start_watcher(meta.path, name, run_id, _REDACT)' in draft and 'record_draft' not in draft
    # the creation: a dry run for anyone with a session, a write only for a person with a login, the Bot is the path's and never the body's
    assert 'skill_teach.validate_create_body(await _json_body(request, skill_teach.MAX_BODY))' in create and create.index('if dry:') < create.index('_human(request)') < create.index('skill_teach.create,')
    assert create.count('_human(request)') == 1 and 'status_code=201' in create and 'skill_teach.need' in create and 'profile' not in create.replace("'/v1/runs'", '')
    assert re.search(r"if dry:\n        return JSONResponse\(_redact_deep\(await run_in_threadpool\(skill_teach\.dry_run, skill_name, content, category, True, _REDACT\)\), headers=_HEADERS\)", create)
    assert "skill_teach.create, audit, meta.path, actor, name, skill_name, category, content, _REDACT, 'req_' + uuid4().hex" in create
    # the edit: a person with a login before anything else is read; the body is exactly content and the digest; a write needs the stricter name
    assert edit.count('_human(request)') == 1 and edit.index('_human(request)') < edit.index('await _existing(bot)') and 'skill_teach.validate_edit_body(' in edit and 'skills.SKILL_NAME.fullmatch(skill)' in edit
    assert "skill_teach.edit, audit, meta.path, actor, name, skill, content, expected, _REDACT, 'req_' + uuid4().hex" in edit and 'skill_teach.need' in edit
    # the toggle: LuveBot's own, under the lock, through the same function for ON and OFF; ON is a person's
    assert 'skill_teach.toggle, audit, meta.path, actor, name, skill, enabled' in toggle_route and 'skills.toggle' not in toggle_route and 'if enabled:\n        _human(request)' in toggle_route
    assert "bot_controls.messages, name, sid, limit, before, _REDACT, intro, meta.path, actor)" in api
    assert api.count('skill_teach.toggle,') == 1 and api.count("@router.post('/bots/{bot}/skills") == 2 and api.count("@router.put('/bots/{bot}/skills/{skill}/content')") == 1


def test_the_routes_are_wired_as_the_contract_says():
    route_checks(API)


ROUTE_MUTATIONS = {
    'the draft is a person-only route': ("    name = await _existing(bot)\n    session_id, note = skill_teach.validate_draft_body(await _json_body(request))", "    _human(request)\n    name = await _existing(bot)\n    session_id, note = skill_teach.validate_draft_body(await _json_body(request))"),
    'the draft instruction is built after the audit': ("    text = skill_teach.draft_instruction(note, nonce)    # a note with a refused character is 422 here, before anything is recorded or sent\n", ""),
    'the draft skips the session check': ("    if safe_id(session_id) is None:\n        raise PluginError('session_not_found', 'Session not found.', 404)\n    nonce = skill_teach.new_nonce()", "    nonce = skill_teach.new_nonce()"),
    'the draft is audited under another action': ("'skill.draft.request', session_id, {'kind': 'ui'},", "'skill.draft', session_id, {'kind': 'ui'},"),
    'the draft skips the hook gate': ("        hook.hook_gate(meta.path, name)  # D-015 B-3: no new work where the rules hook is not live\n        budget_gate(budget, meta.path, name)  # invariant 7\n\n    def send(instruction):", "        budget_gate(budget, meta.path, name)  # invariant 7\n\n    def send(instruction):"),
    'the draft skips the cap': ("        budget_gate(budget, meta.path, name)  # invariant 7\n\n    def send(instruction):", "        pass\n\n    def send(instruction):"),
    'the draft sends the note as typed': ("{'input': instruction, 'session_id': session_id}", "{'input': text, 'session_id': session_id}"),
    'the draft records the nonce in the route': ("    def gates():\n        hook.hook_gate(meta.path, name)  # D-015 B-3", "    skill_teach.record_draft(meta.path, session_id, actor, nonce)\n\n    def gates():\n        hook.hook_gate(meta.path, name)  # D-015 B-3"),
    'the create is open to loopback': ("    _human(request)  # 403 loopback_not_human\n    await run_in_threadpool(skill_teach.need)\n    audit, meta = await run_in_threadpool(_stores)\n    result = await run_in_threadpool(skill_teach.create,", "    await run_in_threadpool(skill_teach.need)\n    audit, meta = await run_in_threadpool(_stores)\n    result = await run_in_threadpool(skill_teach.create,"),
    'the dry run needs a person': ("    if dry:\n        return JSONResponse(_redact_deep(", "    if dry:\n        _human(request)\n        return JSONResponse(_redact_deep("),
    'the dry run is checked after the person': ("    if dry:\n        return JSONResponse(_redact_deep(await run_in_threadpool(skill_teach.dry_run, skill_name, content, category, True, _REDACT)), headers=_HEADERS)\n    _human(request)  # 403 loopback_not_human\n",
                                                "    _human(request)  # 403 loopback_not_human\n    if dry:\n        return JSONResponse(_redact_deep(await run_in_threadpool(skill_teach.dry_run, skill_name, content, category, True, _REDACT)), headers=_HEADERS)\n"),
    'the create is answered 200': ("    return JSONResponse(_redact_deep(result), status_code=201, headers=_HEADERS)", "    return JSONResponse(_redact_deep(result), headers=_HEADERS)"),
    'the create reads the body without the limit': ("skill_teach.validate_create_body(await _json_body(request, skill_teach.MAX_BODY))", "skill_teach.validate_create_body(await _json_body(request))"),
    'the edit is open to loopback': ("    _require_csrf(request, credential)\n    _human(request)  # 403 loopback_not_human\n    name = await _existing(bot)\n    content, expected", "    _require_csrf(request, credential)\n    name = await _existing(bot)\n    content, expected"),
    'the edit takes any skill name': ("    if not skills.SKILL_NAME.fullmatch(skill):\n        raise skills.not_found()\n    await run_in_threadpool(skill_teach.need)\n    audit, meta = await run_in_threadpool(_stores)\n    result = await run_in_threadpool(skill_teach.edit,", "    await run_in_threadpool(skill_teach.need)\n    audit, meta = await run_in_threadpool(_stores)\n    result = await run_in_threadpool(skill_teach.edit,"),
    'the toggle skips the lock': ("skill_teach.toggle, audit, meta.path, actor, name, skill, enabled,", "skills.toggle, audit, actor, name, skill, enabled,"),
    'the messages do not know the drafts': ("bot_controls.messages, name, sid, limit, before, _REDACT, intro, meta.path, actor)", "bot_controls.messages, name, sid, limit, before, _REDACT, intro, None, actor)"),
}


@pytest.mark.parametrize('label', sorted(ROUTE_MUTATIONS))
def test_each_route_mutation_is_caught(label):
    old, new = ROUTE_MUTATIONS[label]
    assert API.count(old) == 1, label
    with pytest.raises(BaseException):  # noqa: B017
        route_checks(API.replace(old, new))
