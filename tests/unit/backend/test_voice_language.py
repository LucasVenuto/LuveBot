"""VL-1 (docs/contracts/voice-language-reactions-v0.md section 2; A-277, A-278, A-281): the language of the Radio, backend/voice.py and the three lines of the routes that carry it.

The attack is the Lume's (test_redteam_voice_language.py: the route and a stand-in of Hermes, 159 proofs). This file proves that each guard of the CODE is held by a proof that goes red without it: every invariant also runs against a variant of voice.py (or of the route source)
with ONE defect, and each must fail; plus what that file does not reach: the shape of `timing`, the creation of a Bot, the order of the gates in the route."""
import copy
import re
import sqlite3
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_redteam_voice_language as lume  # noqa: E402  (its stand-in of Hermes and the route compiler)
import test_voice as tv  # noqa: E402  (the variant loader and the helpers)
import test_approval_timeout as at  # noqa: E402  (a Hermes stand-in that creates profiles: `hermes` is its fixture)
from test_approval_timeout import hermes  # noqa: E402,F401

real = tv.real
KEY = 'sk-' + 'Aa1b' * 6 + 'Zq'
ARIA, FRANCISCA, CHOSEN = 'en-US-AriaNeural', 'pt-BR-FranciscaNeural', 'pt-PT-RaquelNeural'
RICH = {'display': {'message_reactions': True}, 'voice': {'client_direct': False, 'beep': True},
        'stt': {'provider': 'local', 'openai': {'api_key': KEY}},
        'tts': {'provider': 'edge', 'edge': {'voice': ARIA, 'rate': '+10%'}, 'openai': {'voice': 'alloy', 'api_key': KEY}}}
ALLOWED = {('stt', 'language'), ('tts', 'edge', 'voice')}


def redact(text):
    return re.sub(r'sk-[A-Za-z0-9]{20,}', '***', text)


def merge(base, patch):
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            merge(base[key], value)
        else:
            base[key] = copy.deepcopy(value)


class Hermes:
    """The two seams the VL-1 code uses (`config`, `write_config`), with a memory and the audit rows seen at the moment of the write."""
    def __init__(self, tmp=None, cfg=None):
        self.cfg, self.tmp, self.writes, self.intents, self.fail, self.keeps = copy.deepcopy(RICH if cfg is None else cfg), tmp, [], [], None, True

    def config(self, bot):
        if self.fail == 'read':
            raise RuntimeError('unreadable ' + KEY)
        return copy.deepcopy(self.cfg)

    def write_config(self, bot, patch):
        self.writes.append((bot, copy.deepcopy(patch)))
        if self.tmp is not None:
            conn = sqlite3.connect(self.tmp / 'audit.db')
            self.intents.append(conn.execute("SELECT COUNT(*) FROM audit_log WHERE action='voice.language' AND detail='intent'").fetchone()[0])
            conn.close()
        if self.fail == 'write':
            raise RuntimeError('yaml error ' + KEY)
        if self.keeps:
            merge(self.cfg, patch)


def leaves(value, prefix=()):
    return {k: v for key, item in value.items() for k, v in leaves(item, prefix + (key,)).items()} if isinstance(value, dict) and value else {prefix: value}


def put(m, tmp, fake, language, bot='vendas'):
    return m.set_language(tv.audit_of(m, tmp), fake, 'basic:ana', bot, language, redact, 'req_1')


# ---- (1) only the two keys, and a chosen voice is never overwritten ---------------------------------------------------------------------------
def inv_only_the_two_keys(m, tmp):
    for provider, voice, language in [(p, v, l) for p in (None, 'edge', 'openai') for v in (None, '', ARIA, FRANCISCA, CHOSEN, 123, ['x']) for l in (None, 'pt', 'fr')]:
        start = copy.deepcopy(RICH)
        start['tts'].pop('provider')
        if provider:
            start['tts']['provider'] = provider
        start['tts']['edge'].pop('voice')
        if voice is not None:
            start['tts']['edge']['voice'] = voice
        if language is not None:
            start['stt']['language'] = language
        for word in ('pt', 'en', 'auto'):
            patch = m.language_patch(start, word)
            assert set(leaves(patch)) <= ALLOWED and leaves(patch)[('stt', 'language')] == ('' if word == 'auto' else word), (provider, voice, word, patch)
            wrote_voice = ('tts', 'edge', 'voice') in leaves(patch)
            ours = provider in (None, 'edge') and voice in (None, '', ARIA, FRANCISCA)
            assert wrote_voice == (ours and word != 'auto'), (provider, voice, word, patch)      # a chosen voice, another provider and `auto` write no voice
            if wrote_voice:
                assert leaves(patch)[('tts', 'edge', 'voice')] == {'pt': FRANCISCA, 'en': ARIA}[word]
    for broken in ({'tts': []}, {'tts': {'edge': 'Aria'}}, {'tts': {'provider': ['edge']}}):                  # wrong shapes of tts: no voice, never an error
        assert ('tts', 'edge', 'voice') not in leaves(m.language_patch(broken, 'pt'))
    for empty in ({}, {'tts': None}, None):                                                                                  # nothing set (or no readable configuration): the defaults follow the language
        assert leaves(m.language_patch(empty, 'en'))[('tts', 'edge', 'voice')] == ARIA


def inv_the_write_keeps_everything_else(m, tmp):
    fake = Hermes(tmp)
    assert put(m, tmp, fake, 'pt')['settings']['language'] == 'pt'
    assert fake.writes == [('vendas', {'stt': {'language': 'pt'}, 'tts': {'edge': {'voice': FRANCISCA}}})]            # only the leaves, in the Bot's profile; nothing is resent
    after = leaves(fake.cfg)
    assert {k: v for k, v in after.items() if k not in ALLOWED} == {k: v for k, v in leaves(RICH).items() if k not in ALLOWED}


# ---- (2) the value: exactly one key, three words --------------------------------------------------------------------------------------------
def inv_the_body_is_one_key_and_three_words(m, tmp):
    assert [m.language_body({'language': word}) for word in ('pt', 'en', 'auto')] == ['pt', 'en', 'auto']
    for body in ({}, None, [], 'pt', 5, {'lang': 'pt'}, {'language': 'pt', 'stt': {}}, {'language': 'pt', 'bot': 'x'}):
        tv.refused(m, 'bad_request', m.language_body, body)
    for value in ('PT', 'pt ', 'pt-BR', 'portugues', '', None, 5, True, ['pt'], {'pt': 1}, 'x' * 9000, KEY):
        error = tv.refused(m, 'invalid_field', m.language_body, {'language': value})
        assert error.status == 422 and KEY not in tv.shown(error) and 'x' * 50 not in tv.shown(error)       # the value never comes back
        tv.refused(m, 'invalid_field', m.language_value, value)


# ---- (3) the words: never the raw value ------------------------------------------------------------------------------------------------------
def inv_words_are_never_the_raw_value(m, tmp):
    assert [m.language_word(v) for v in ('pt', 'en', '', None, 'fr', 'PT', 'pt-BR', KEY, ['pt'], 5)] == ['pt', 'en', 'auto', 'auto', 'other', 'other', 'other', 'other', 'other', 'other']
    seen = []
    audit = tv.audit_of(m, tmp)
    original = audit.act
    audit.act = lambda *a, **k: (seen.append(k.get('payload')), original(*a, **k))[1]
    fake = Hermes(tmp, {**RICH, 'stt': {'provider': 'local', 'language': 'fr'}})
    m.set_language(audit, fake, 'basic:ana', 'vendas', 'pt', redact, 'req_1')
    assert seen == [{'from': 'other', 'to': 'pt'}]                                                  # `fr` is not in the audit, and neither is anything else
    view = m.settings_view(fake.cfg, redact)
    assert view['language'] == 'pt' and view['stt']['language'] == 'pt'
    assert m.settings_view({'stt': {'language': 'fr'}}, redact)['stt']['language'] == 'fr'          # the raw value stays in the status, for the screen to say "set in Hermes: fr"


# ---- (4) audited first, read back, no Hermes text ---------------------------------------------------------------------------------------------
def inv_audited_first_then_read_back(m, tmp):
    fake = Hermes(tmp)
    put(m, tmp, fake, 'en')
    assert fake.intents == [1], 'Hermes was asked before the audit had the intent'
    rows = sqlite3.connect(tmp / 'audit.db').execute("SELECT outcome, detail, bot, target FROM audit_log WHERE action='voice.language' ORDER BY id").fetchall()
    assert rows == [('ok', 'intent', 'vendas', 'vendas'), ('ok', 'result', 'vendas', 'vendas')]
    sub = tmp / 'kept'
    sub.mkdir()
    stuck = Hermes(sub)
    stuck.keeps = False                                                                              # Hermes says yes and keeps nothing: never a claimed success
    refused = tv.refused(m, 'hermes_error', put, m, sub, stuck, 'pt')
    assert refused.status == 502 and stuck.cfg == RICH
    assert sqlite3.connect(sub / 'audit.db').execute("SELECT outcome FROM audit_log WHERE action='voice.language' AND detail='result'").fetchall() == [('error',)]
    sub = tmp / 'fail'
    sub.mkdir()
    broken = Hermes(sub)
    broken.fail = 'write'
    refused = tv.refused(m, 'hermes_error', put, m, sub, broken, 'pt')
    assert refused.status == 502 and KEY not in tv.shown(refused) and 'yaml' not in tv.shown(refused)   # Hermes's text never leaves
    sub = tmp / 'unread'
    sub.mkdir()
    blind = Hermes(sub)
    blind.fail = 'read'
    refused = tv.refused(m, 'hermes_error', put, m, sub, blind, 'pt')
    assert KEY not in tv.shown(refused) and blind.writes == []                                       # a configuration that cannot be read is not written over


# ---- (5) the status: the listed keys, redacted, cut ---------------------------------------------------------------------------------------------
def inv_the_status_is_the_listed_keys_redacted_and_cut(m, tmp):
    view = m.settings_view(RICH, redact)
    assert view == {'stt': {'provider': 'local', 'language': None}, 'tts': {'provider': 'edge', 'voice': ARIA}, 'language': 'auto'}
    assert KEY not in str(view) and 'api_key' not in str(view) and 'rate' not in str(view)
    hostile = m.settings_view({'stt': {'provider': ['x'], 'language': KEY}, 'tts': {'provider': 'edge', 'edge': {'voice': 'v' * 20000}}}, redact)
    assert hostile['stt'] == {'provider': None, 'language': '***'} and hostile['language'] == 'other' and len(hostile['tts']['voice']) == 200
    straddle = m.settings_view({'tts': {'edge': {'voice': 'x' * 190 + KEY}}}, redact)['tts']['voice']          # redacted BEFORE the cut: a key is not cut into a piece the redactor no longer knows
    assert 'sk-' not in straddle and straddle == 'x' * 190 + '***'
    assert m.settings_view(None, redact)['language'] == 'auto' and m.settings_view({'tts': {'provider': ''}}, redact)['tts']['provider'] == 'edge'
    assert 'settings' not in m.status(tv.FakeHermes(), 'vendas', tv.open_gate, redact)                      # a Hermes with no reader: absent, not invented
    blind = tv.FakeHermes()
    blind.config = lambda bot: (_ for _ in ()).throw(RuntimeError(KEY))
    assert 'settings' not in m.status(blind, 'vendas', tv.open_gate, redact)                                 # unreadable: absent, and the rest of the status is unharmed
    assert m.status(blind, 'vendas', tv.open_gate, redact)['radio']['available'] is True
    ready = tv.FakeHermes()
    ready.config = lambda bot: copy.deepcopy(RICH)
    assert m.status(ready, 'vendas', tv.open_gate, redact)['settings']['tts']['voice'] == ARIA
    assert 'settings' not in m.status(ready, 'vendas', tv.open_gate)                                         # no redactor, no settings


# ---- (6) transcribe: timing, and a row that holds no text ---------------------------------------------------------------------------------------
def inv_transcribe_timing(m, tmp):
    answer = tv.transcribe(m, tmp, tv.FakeHermes(transcript='ola ' + KEY), data=b'RIFFwav!')
    assert set(answer) == {'text', 'provider', 'timing'} and set(answer['timing']) == {'server_ms', 'bytes'} and answer['timing']['bytes'] == 8
    assert type(answer['timing']['server_ms']) is int and 0 <= answer['timing']['server_ms'] < 60000
    conn = sqlite3.connect(tmp / 'audit.db')
    rows = conn.execute("SELECT action, outcome, detail, digest FROM audit_log ORDER BY id").fetchall()
    assert [r[0] for r in rows] == ['voice.transcribe'] * 2 + ['voice.transcribe.timing'] * 2 and 'ola' not in str(rows) and KEY not in str(rows)
    sub = tmp / 'down'
    sub.mkdir()
    audit = tv.audit_of(m, sub)
    original = audit.act

    def timing_row_fails(*args, **kw):
        if args[1] == 'voice.transcribe.timing':
            raise RuntimeError('audit down')
        return original(*args, **kw)
    audit.act = timing_row_fails
    assert tv.transcribe(m, sub, tv.FakeHermes(), audit=audit)['text'] == 'olá'                           # a number is not worth losing the transcription
    failed = tv.refused(m, 'voice_unavailable', tv.transcribe, m, sub, tv.FakeHermes(fail=RuntimeError('boom ' + KEY)))
    assert 'timing' not in tv.shown(failed) and KEY not in tv.shown(failed)


INVARIANTS = {name[4:]: fn for name, fn in globals().items() if name.startswith('inv_')}

PATCH_ARM = "    patch = {'stt': {'language': '' if language == 'auto' else language}}\n"
MUTATIONS = [
    ('only_the_two_keys', 'auto writes the language, not an empty one', PATCH_ARM, "    patch = {'stt': {'language': language}}\n"),
    ('only_the_two_keys', 'a chosen voice is overwritten', "(edge or {}).get('voice') in (None, '', *VOICES.values())", 'True'),
    ('only_the_two_keys', 'another provider\'s Edge voice is overwritten', "(tts or {}).get('provider') in (None, 'edge')", 'True'),
    ('only_the_two_keys', 'auto writes a voice as well', "    if language != 'auto' and ours:", '    if ours:'),
    ('only_the_two_keys', 'a wrong shape of tts is an error', "    ours = (tts is None or isinstance(tts, dict)) and (edge is None or isinstance(edge, dict)) and ", "    ours = "),
    ('only_the_two_keys', 'the voice follows the wrong language', "patch['tts'] = {'edge': {'voice': VOICES[language]}}", "patch['tts'] = {'edge': {'voice': VOICES['pt']}}"),
    ('the_write_keeps_everything_else', 'the patch carries a third key', PATCH_ARM, "    patch = {'stt': {'language': '' if language == 'auto' else language}, 'voice': {'beep': False}}\n"),
    ('the_write_keeps_everything_else', 'the write names no profile', "hermes.write_config(bot, patch)", "hermes.write_config(None, patch)"),
    ('the_body_is_one_key_and_three_words', 'a second key is accepted', "if not isinstance(body, dict) or set(body) != {'language'}:", "if not isinstance(body, dict) or 'language' not in body:"),
    ('the_body_is_one_key_and_three_words', 'any word is accepted', "if not isinstance(value, str) or value not in LANGUAGES:", "if not isinstance(value, str):"),
    ('the_body_is_one_key_and_three_words', 'the value comes back in the error', "'Use \"pt\", \"en\" or \"auto\".', 422)    # never the value back", "'Use \"pt\", \"en\" or \"auto\": ' + value, 422)"),
    ('words_are_never_the_raw_value', 'the audit holds the raw value', "    return value if value in ('pt', 'en') else 'auto' if value in ('', None) else 'other'", "    return value if value not in ('', None) else 'auto'"),
    ('words_are_never_the_raw_value', 'a language of Hermes is auto', "else 'auto' if value in ('', None) else 'other'", "else 'auto'"),
    ('words_are_never_the_raw_value', 'the status loses the raw value', "'language': _shown(stt.get('language'), redact)}", "'language': None}"),
    ('audited_first_then_read_back', 'the audit is after the write',
     "    kept = audit.act(actor, 'voice.language', bot, {'kind': 'ui', 'ref': ref}, lambda: _apply_language(hermes, bot, language, patch), bot=bot,\n                     payload={'from': _word(before), 'to': language})",
     "    kept = _apply_language(hermes, bot, language, patch)\n    audit.act(actor, 'voice.language', bot, {'kind': 'ui', 'ref': ref}, lambda: kept, bot=bot, payload={'from': _word(before), 'to': language})"),
    ('audited_first_then_read_back', 'the value is not read back', "    if _word(kept) != language:", "    if False:"),
    ('audited_first_then_read_back', 'Hermes\'s text is forwarded', "        raise PluginError('hermes_error', 'Hermes could not change this setting.', 502) from None\n    try:\n        kept", "        raise PluginError('hermes_error', str(error), 502) from None\n    try:\n        kept"),
    ('audited_first_then_read_back', 'an unreadable configuration is written over', "    except Exception:\n        raise PluginError('hermes_error', 'Hermes could not read this setting.', 502) from None\n", "    except Exception:\n        before = {}\n"),
    ('the_status_is_the_listed_keys_redacted_and_cut', 'the language is not redacted', "'language': _shown(stt.get('language'), redact)}", "'language': stt.get('language')}"),
    ('the_status_is_the_listed_keys_redacted_and_cut', 'the voice is not cut', "redact(value)[:SHOWN] if", "redact(value) if"),
    ('the_status_is_the_listed_keys_redacted_and_cut', 'cut before redacted', "redact(value)[:SHOWN] if", "redact(value[:SHOWN]) if"),
    ('the_status_is_the_listed_keys_redacted_and_cut', 'a provider section is shown whole', "'voice': _shown(_section(tts, provider).get('voice'), redact)}", "'voice': _section(tts, provider)}"),
    ('the_status_is_the_listed_keys_redacted_and_cut', 'an unreadable configuration breaks the status', "        return settings_view(read(bot), redact)\n    except Exception:\n        return None", "        return settings_view(read(bot), redact)\n    except ZeroDivisionError:\n        return None"),
    ('the_status_is_the_listed_keys_redacted_and_cut', 'the default provider is not named', "isinstance(tts.get('provider'), str) and tts.get('provider') else 'edge'", "isinstance(tts.get('provider'), str) else 'edge'"),
    ('transcribe_timing', 'no timing in the answer', "'provider': _provider(result.get('provider')), 'timing': timing}", "'provider': _provider(result.get('provider'))}"),
    ('transcribe_timing', 'the timing is not a row', "        audit.act(actor, 'voice.transcribe.timing', bot, {'kind': 'ui', 'ref': ref}, lambda: None, bot=bot, payload=timing)", "        pass"),
    ('transcribe_timing', 'a failed timing row loses the text', "    except Exception:\n        pass  # the transcription is audited above; a number is not worth losing it", "    except ZeroDivisionError:\n        pass"),
    ('transcribe_timing', 'the size is the text', "timing = {'server_ms': took[0], 'bytes': len(data)}", "timing = {'server_ms': took[0], 'bytes': len(text)}"),
]


def load(tmp_path_factory, old, new):
    return tv.load_variant(tmp_path_factory, old, new)


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(tmp_path, name):
    INVARIANTS[name](real, tmp_path)


def test_every_invariant_has_a_mutation():
    assert set(INVARIANTS) == {inv for inv, *_ in MUTATIONS}


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(tmp_path_factory, tmp_path, invariant, label, old, new):
    variant = load(tmp_path_factory, old, new)                    # outside pytest.raises: a mutation that does not apply is an error
    with pytest.raises(Exception):                                # any failure is red: an assertion, or the defect itself raising
        INVARIANTS[invariant](variant, tmp_path)


# ---- the route: the order of the gates, through the Lume's compiler of the route source ----------------------------------------------------------
def proof_csrf(env):
    lume.test_without_the_csrf_header_the_answer_is_403_before_the_body_the_bot_and_any_effect(lume.Route(), env)


def proof_loopback(env):
    lume.test_the_loopback_credential_is_no_person_and_is_refused(lume.Route(), env)


def proof_no_bot(env):
    lume.test_a_bot_that_does_not_exist_is_a_404_and_writes_nothing(lume.Route(), env)


def proof_hostile_body(env):
    for body in ({'language': 'pt', 'stt': {'provider': 'cloud'}}, {'language': 'PT'}, {'lang': 'pt'}):
        answer = lume.Route().put(env, 'vendas', body)
        assert answer.status in (400, 422) and env.calls == [], (body, answer.status)


def proof_actor(env):
    assert lume.Route().put(env, 'vendas', {'language': 'pt'}).status == 200
    assert {row[0] for row in sqlite3.connect(env.audit.path).execute('SELECT actor FROM audit_log')} == {'basic:ana'}


ROUTE_MUTATIONS = {
    'the person gate is the identity only': ("    human = _human(request)\n    name = await _existing(bot)\n    language = voice.language_body",
                                             "    actor, credential, _mode = _identity(request)\n    human = type('H', (), {'id': actor})()\n    name = await _existing(bot)\n    language = voice.language_body", proof_loopback),
    'the CSRF header is not asked': ("    human = _human(request)\n    name = await _existing(bot)\n    language = voice.language_body",
                                     "    actor, credential, mode = _identity(request)\n    identity.require_person(mode, 'x', loopback_ok=False)\n    human = type('H', (), {'id': actor})()\n    name = await _existing(bot)\n    language = voice.language_body", proof_csrf),
    'the Bot is not looked up': ("    name = await _existing(bot)\n    language = voice.language_body", "    name = bot\n    language = voice.language_body", proof_no_bot),
    'the body is not checked': ("    language = voice.language_body(await _json_body(request))", "    language = (await _json_body(request)).get('language')", proof_hostile_body),
    'the audit actor is not the person': ("voice.set_language, audit, voice.HermesAudio, human.id, name, language", "voice.set_language, audit, voice.HermesAudio, 'system', name, language", proof_actor),
}


def test_the_route_source_has_the_gates_in_this_order():
    route = lume.block("@router.put('/bots/{bot}/voice/language')")
    assert route.index('_human(request)') < route.index('_existing(bot)') < route.index('voice.language_body(') < route.index('voice.set_language')
    assert 'human.id' in route and '_REDACT' in route
    assert "voice.status, voice.HermesAudio, name, lambda: _voice_gate_reason(meta.path, audit, name), _REDACT)" in lume.API
    create = lume.block("@router.post('/bots')")
    assert "language = voice.language_value(body.pop('language')) if isinstance(body, dict) and 'language' in body else None" in create and 'create_in_hermes(name, template, display, model, meta, soul, language)' in create


@pytest.mark.parametrize('label', sorted(ROUTE_MUTATIONS))
def test_each_route_mutation_is_caught(label, tmp_path, monkeypatch):
    old, new, proof = ROUTE_MUTATIONS[label]
    proof(lume.Env(tmp_path / 'ok', monkeypatch) if (tmp_path / 'ok').mkdir() is None else None)   # the proof passes on the real route
    assert lume.API.count(old) == 1, label                         # an anchor that moved fails HERE
    monkeypatch.setattr(lume, 'API', lume.API.replace(old, new))
    (tmp_path / 'mutated').mkdir()
    with pytest.raises(AssertionError):
        proof(lume.Env(tmp_path / 'mutated', monkeypatch))


# ---- the creation of a Bot: the screen's language, best effort ---------------------------------------------------------------------------------------
def make(edit=None):
    _controls, bots = at.load(edit, 'bots') if edit else at.load()
    bots.hook = types.SimpleNamespace(install_hook=lambda *a: None, verify_installed=lambda *a: None, forget=lambda *a: None, HookError=type('HookError', (Exception,), {}))
    bots._markdown_hint = lambda name: None
    meta = types.SimpleNamespace(path='db', upsert=lambda *a: None, set_template=lambda *a: None, delete=lambda *a: None)
    return bots, meta


def creation_checks(bots, meta, hermes, monkeypatch):
    configs = hermes['configs']
    default_before = copy.deepcopy(configs['default'])
    assert bots.create_in_hermes('novo', None, {}, None, meta, None, 'pt') is True
    assert configs['novo'] == {'approvals': {'timeout': 3600}, 'stt': {'language': 'pt'}, 'tts': {'edge': {'voice': FRANCISCA}}} and configs['default'] == default_before   # in its own profile only
    for later, language in (('auto', 'auto'), ('nada', None)):                                       # `auto` (or nothing sent) writes nothing: Hermes's default stays the default
        assert bots.create_in_hermes(later, None, {}, None, meta, None, language) is True and configs[later] == {'approvals': {'timeout': 3600}}
    config_env = sys.modules['hermes_cli.web_routers.config_env']
    original = config_env.update_config

    async def refuse_language(body, profile=None, preserve_language=False):
        if 'stt' in body.config:
            raise RuntimeError('yaml error ' + KEY)
        return await original(body, profile, preserve_language)
    monkeypatch.setattr(config_env, 'update_config', refuse_language)
    assert bots.create_in_hermes('tropeco', None, {}, None, meta, None, 'en') is True                # a language that Hermes refuses does not undo the Bot
    assert configs['tropeco'] == {'approvals': {'timeout': 3600}} and 'tropeco' not in hermes['deleted']


def test_a_new_bot_gets_the_screens_language_after_its_steps_and_a_failure_of_it_does_not_undo_the_bot(hermes, monkeypatch):
    creation_checks(*make(), hermes, monkeypatch)


@pytest.mark.parametrize('edit,label', [
    (("    if language in ('pt', 'en'):\n        _voice_language(name, language)\n", ""), 'the language is never written'),
    (("    if language in ('pt', 'en'):\n", "    if language:\n"), 'auto is written as well'),
    (("    except Exception:\n        pass  # a nicety, not a step", "    except ZeroDivisionError:\n        pass  # a nicety, not a step"), 'a refusal of the language undoes the Bot'),
], ids=lambda value: value if isinstance(value, str) else '')
def test_each_creation_mutation_is_caught(hermes, monkeypatch, edit, label):
    bots, meta = make(edit)
    with pytest.raises(Exception):
        creation_checks(bots, meta, hermes, monkeypatch)


def test_apply_language_writes_the_same_leaves_as_the_route():
    hermes_ = Hermes(cfg={})
    real.apply_language(hermes_, 'novo', 'en')
    assert hermes_.writes == [('novo', {'stt': {'language': 'en'}, 'tts': {'edge': {'voice': ARIA}}})] and hermes_.cfg['stt']['language'] == 'en'
    tv.refused(real, 'invalid_field', real.set_language, None, hermes_, 'a', 'x', 'PT', redact, 'r')      # a word outside the three never reaches the patch builder (no KeyError, no 500)
    tv.refused(real, 'invalid_field', real.apply_language, hermes_, 'x', 'PT')
