"""M-2 (contract v0.11 section 1.4): changing a Bot's model from its Profile, proven on the REAL Hermes (`GET /bots/{bot}/model`, `.../model/options`, `POST /bots/{bot}/model`); only the model provider is fake.

The options list is Hermes's AUTHENTICATED providers, read in the Bot's own profile scope, and LuveBot never offers `custom`, `local` or `nous`: the harness Bot's provider (`custom`, the fake) is not on it. So the
setup gives the Bot `openrouter` the way a person does, through Hermes's own writer (`PUT /api/env?profile=vendas`): a fake key with the shape Hermes requires (`sk-or-`) and `OPENROUTER_BASE_URL` pointing
at the fake provider (how Hermes resolves an OpenRouter mirror), both in THAT Bot's `.env` (a key in the process environment does not reach a profile scope), and removed afterwards. A conversation that uses
`openrouter` then reaches the fake, which says the model NAME it received (`M2_MODEL_PROBE`, tests/harness/fake_openai.py).

Care: on a developer's Mac the options also list providers that Hermes finds in the developer's OWN credentials (the Claude Code login, `gh`, a codex login): switching to one of those would send a conversation to a
real provider with real credentials. This file only ever switches to `openrouter`, whose base URL is the fake. NOT proven here, on purpose: the expensive-model path (`409 confirm_required`): it needs price data
for the model and the harness has none (the options payload is read from Hermes's cache only); that gap is declared in the evidence note. The write goes to ONE Bot's `config.yaml` and the file is put back at the end."""
import contextlib
import hashlib
import json
import sqlite3
import uuid
from pathlib import Path

import pytest
import hermes_yaml as yaml   # Hermes ships its own YAML module (no PyYAML in its environment)

from support import DASHBOARD
from test_bots import DB, error_of, post
from test_hook import ROOT_HOME, wait_for
from test_plugin import PREFIX
from test_runs import get, wait_run

KEY = 'sk-or-v1-' + '0' * 64   # an obvious fake, built at run time so that no scanner reads the source as a key; Hermes only requires the `sk-or-` prefix and a value that is not a placeholder shape (hermes_cli/auth.py)
BASE = 'http://fake-openai:8000/v1'                        # the native lane rewrites it to the fake's port
VENDAS = ROOT_HOME / 'profiles/vendas/config.yaml'
DEFAULT = ROOT_HOME / 'config.yaml'
CURRENT = {'provider': 'custom', 'model': 'fake-harness'}   # the harness Bot's own model (tests/harness/entrypoint.py)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def model_post(browser, body):
    return post(browser, '/bots/vendas/model', body)


@pytest.fixture(autouse=True)
def openrouter_for_vendas(human_browser):
    """What a person does to give a Bot a provider: Hermes's own writer, scoped to the Bot. Removed at the end (the Bot's `.env` as it was)."""
    for key, value in (('OPENROUTER_API_KEY', KEY), ('OPENROUTER_BASE_URL', BASE)):
        done = human_browser.request.put(DASHBOARD + '/api/env', data={'key': key, 'value': value, 'profile': 'vendas'})
        assert done.status == 200, (key, done.status, done.text()[:200])
    yield
    for key in ('OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL'):
        human_browser.request.delete(DASHBOARD + '/api/env', data={'key': key, 'profile': 'vendas'})


def offered(browser):
    """The options as LuveBot serves them; LuveBot caches them 60 s per Bot, so wait for the one that the setup just gave the Bot."""
    def read():
        answer = get(browser, '/bots/vendas/model/options')
        assert answer.status == 200, answer.text()
        rows = {row['slug']: row for row in answer.json()['providers']}
        return rows if 'openrouter' in rows else None
    return wait_for(read, 90, "'openrouter' on the Bot's options")


def probe(browser, session=None):
    """One run of the Bot that asks the fake which model NAME it received. -> (session id, the fake's answer)."""
    if session is None:
        created = post(browser, '/bots/vendas/sessions', {})
        assert created.status == 201, created.text()
        session = created.json()['session']['id']
    started = post(browser, '/bots/vendas/runs', {'input': 'M2_MODEL_PROBE: which model?', 'session_id': session})
    assert started.status == 202, started.text()
    return session, wait_run(browser, 'vendas', started.json()['run']['id'], {'completed'})['output']


def test_the_options_are_only_what_luvebot_changes_and_a_refused_choice_leaves_the_file_byte_for_byte(human_browser):
    providers = offered(human_browser)
    assert not {'custom', 'local', 'nous'} & set(providers), sorted(providers)
    models = providers['openrouter']['models']
    assert models and all(isinstance(m, str) for m in models)
    now = get(human_browser, '/bots/vendas/model').json()
    assert {k: now[k] for k in ('provider', 'model')} == CURRENT, now
    before = (digest(VENDAS), digest(DEFAULT))
    expected = {'expected': CURRENT}
    refusals = [
        ({'provider': 'openrouter', 'model': models[0], **expected, 'api_key': KEY}, 422, 'invalid_field'),                     # a key never travels browser -> config
        ({'provider': 'openrouter', 'model': models[0], **expected, 'base_url': 'http://evil.example/v1'}, 422, 'invalid_field'),
        ({'provider': 'openrouter', 'model': models[0], **expected, 'scope': 'auxiliary'}, 422, 'invalid_field'),
        ({'provider': 'openrouter', 'model': models[0], **expected, 'profile': 'default'}, 422, 'invalid_field'),               # the profile is the path's Bot, never the client's
        ({'provider': 'custom', 'model': 'fake-harness', **expected}, 422, 'provider_not_supported'),
        ({'provider': 'nous', 'model': models[0], **expected}, 422, 'provider_not_supported'),
        ({'provider': 'openrouter', 'model': 'not/a-listed-model', **expected}, 422, 'model_not_offered'),                      # only what the list LuveBot fetched itself offers
        ({'provider': 'openrouter', 'model': models[0], 'expected': {'provider': 'openrouter', 'model': 'someone/else'}}, 409, 'stale'),
        ({'provider': 'openrouter', 'model': models[0]}, 422, 'invalid_field'),                                                  # no `expected`: no unconditional overwrite
    ]
    for body, status, code in refusals:
        answer = model_post(human_browser, body)
        assert (answer.status, error_of(answer)['code']) == (status, code), (body, answer.status, answer.text()[:300])
        assert KEY not in answer.text() and 'evil.example' not in answer.text(), body
        assert (digest(VENDAS), digest(DEFAULT)) == before, f'the file changed after a refused choice: {body}'
    assert get(human_browser, '/bots/vendas/model').json()['provider'] == 'custom'


@contextlib.contextmanager
def switched(browser):
    """A conversation is opened and answers with the harness model, THEN the Bot's model is switched through the route. -> (the model chosen, the open session, the route's answer). The file is put back at the end."""
    saved = VENDAS.read_bytes()
    try:
        model = offered(browser)['openrouter']['models'][0]
        session_before, said = probe(browser)
        assert said == 'MODEL:fake-harness', said
        answer = model_post(browser, {'provider': 'openrouter', 'model': model, 'expected': CURRENT})
        assert answer.status == 200, (answer.status, answer.text()[:300])
        yield model, session_before, answer
    finally:
        VENDAS.write_bytes(saved)                                                                                   # back to the fake provider for whatever runs next


def test_a_set_lands_in_that_bots_file_only_and_a_new_conversation_sends_the_new_model(human_browser):
    other = 'm2-' + uuid.uuid4().hex[:6]
    created = post(human_browser, '/bots', {'name': other, 'display': {'label': 'Outro'}})
    assert created.status == 201, created.text()
    other_file = ROOT_HOME / 'profiles' / other / 'config.yaml'
    try:
        untouched = (digest(DEFAULT), digest(other_file))
        with switched(human_browser) as (model, session_before, answer):
            body = answer.json()
            assert {k: body[k] for k in ('provider', 'model', 'applies')} == {'provider': 'openrouter', 'model': model, 'applies': 'next_message'}, body
            assert set(body) == {'provider', 'model', 'applies', 'stale_aux'} and KEY not in answer.text() and 'http' not in answer.text().replace('https://', '')
            # `info` reflects the set, and the write is in THAT Bot's file: the second Bot and the default profile are byte for byte as they were
            info = get(human_browser, '/bots/vendas/model').json()
            assert (info['provider'], info['model']) == ('openrouter', model), info
            written = yaml.safe_load(VENDAS.read_text())['model']
            assert (written['provider'], written['default']) == ('openrouter', model), written
            assert (digest(DEFAULT), digest(other_file)) == untouched
            # a NEW conversation sends the new model NAME to the provider
            _new_session, said_new = probe(human_browser)
            assert said_new == 'MODEL:' + model, said_new
            # the audit: the intent committed before Hermes was called, then the result; the row holds the digest of the NAMES `{from, to}` (never a key, an address or Hermes's text)
            payload = {'from': CURRENT, 'to': {'provider': 'openrouter', 'model': model}}
            expected = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
            conn = sqlite3.connect(DB)
            try:
                rows = conn.execute("SELECT * FROM audit_log WHERE action='bot.model.set' AND target='vendas' ORDER BY rowid").fetchall()
                last = conn.execute("SELECT detail, outcome, digest FROM audit_log WHERE action='bot.model.set' AND target='vendas' ORDER BY rowid DESC LIMIT 2").fetchall()
            finally:
                conn.close()
            assert last[::-1] == [('intent', 'ok', expected), ('result', 'ok', expected)], last
            text = ' '.join(str(c) for r in rows for c in r)
            assert KEY not in text and 'http' not in text and 'api_key' not in text, text
    finally:
        human_browser.request.delete(DASHBOARD + '/api/profiles/' + other)
        conn = sqlite3.connect(DB)
        conn.execute('DELETE FROM bot_meta WHERE bot=?', (other,))
        conn.commit()
        conn.close()


def test_a_conversation_already_open_uses_the_new_model_on_its_next_message(human_browser):
    """The truth M-2 found (contract v0.11 1.1; the sentence that said otherwise left the contract and the screen, M-6): the API Server builds the agent of EVERY run from the config as it is then."""
    with switched(human_browser) as (model, session_before, _answer):
        _same, said_open = probe(human_browser, session_before)
        assert said_open == 'MODEL:' + model, said_open
