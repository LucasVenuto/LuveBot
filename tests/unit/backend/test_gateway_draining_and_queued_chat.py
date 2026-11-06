"""r55: the two defects the real v0.22.5 showed in `test_zz_admission_queued` (Forja, 2026-10-30), both in the v0.2 surfaces.

1. A request that ARRIVES while the gateway drains is answered by the API Server's own front door: 503, `Retry-After: 1`, `error.code` **`gateway_draining`** (the session store's word for the same
   thing is `runtime_draining`, which was the only one LuveBot knew). Unknown, it read as a 502 "Hermes returned an unexpected response" and the person was told something broke. Now both
   codes are read (`hermes_api.CODES`) and both are `503 hermes_draining` ("try again in a few seconds"), on every surface (create a run, chat, a run's control).
2. A turn the session CHAT STREAM accepted and that is still queued when the owner retires: the stream has already sent its 200, so Hermes says it as an SSE `error` frame with the text
   `AdmissionQueued.MESSAGE` and no code, then `done`. The relay dropped the frame and closed `upstream_closed`: the person saw the answer stop for no reason and sent the message again (the work
   runs twice). Now that exact frame becomes OUR `run.queued` (code `run_queued`, our words, the frame's seq), like the run surface's. Hermes's sentence is matched EXACTLY (a provider's error text that merely
   contains it stays an `error`, dropped), and never leaves.
Mutations: the code not read; the table row missing; the frame not mapped; any text containing the sentence mapped; the run surface mapped; Hermes's text passed on."""
import importlib
import importlib.util
import itertools
import json
from pathlib import Path
import sys
import types

import pytest

import backend.sse_proxy as sse_module

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
_n = itertools.count()
REAL_BODY = json.dumps({'error': {'message': 'Gateway is draining existing work; retry shortly.', 'type': 'invalid_request_error', 'param': None, 'code': 'gateway_draining'}}).encode()
HERMES = sse_module.HERMES_QUEUED
CANARY = 'SECRET-TOKEN-xyz'


def redact(text):
    return text


def load(file='canonical', edit=None):
    """A copy of the backend package with Hermes's client module stubbed; the REAL hermes_api and canonical, one of them with one edit."""
    name = f'gd_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    client = types.ModuleType(f'{name}.hermes_client')

    class HermesError(Exception):
        def __init__(self, code):
            self.code = code
            super().__init__(code)
    client.HermesError, client.MAX_RESPONSE_BYTES = HermesError, 1024 * 1024
    client._NoRedirect = type('_NoRedirect', (), {})
    client.HermesClient = type('HermesClient', (), {})
    sys.modules[client.__name__] = client
    modules = {}
    for module in ('hermes_api', 'canonical'):
        if edit and module == file:
            source = (BACKEND / f'{module}.py').read_text()
            assert source.count(edit[0]) == 1, edit[0]
            loaded = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.{module}', loader=None))
            loaded.__package__ = name
            sys.modules[loaded.__name__] = loaded
            exec(compile(source.replace(*edit), str(BACKEND / f'{module}.py'), 'exec'), loaded.__dict__)
            modules[module] = loaded
        else:
            modules[module] = importlib.import_module(f'{name}.{module}')
    return modules['hermes_api'], modules['canonical']


class Body:
    def __init__(self, data):
        self.data = data

    def read(self, limit=-1):
        return self.data[:limit] if limit >= 0 else self.data


def draining_checks(api, canonical):
    assert api.error_code(Body(REAL_BODY)) == 'gateway_draining'                                    # the body the real gateway sent while draining
    assert CANARY not in str(api.error_code(Body(json.dumps({'error': {'code': 'gateway_draining', 'message': CANARY}}).encode())))   # nothing but the code is kept
    for surface in ('create', 'chat', 'run'):
        for code in ('gateway_draining', 'runtime_draining'):
            error = canonical.refusal(503, code, surface)
            assert (error.code, error.status) == ('hermes_draining', 503) and error.message and CANARY not in error.message, (surface, code)
    for pair in ((409, 'gateway_draining'), (500, 'gateway_draining'), (200, 'gateway_draining'), (503, 'gateway_draining_x'), (503, None)):
        assert canonical.refusal(*pair, 'chat') is None, pair                                       # by code AND status: never the status alone, never a look-alike name


def test_the_real_gateways_draining_code_is_read_and_means_try_again():
    draining_checks(*load())


@pytest.mark.parametrize('file,old,new', [
    ('hermes_api', "'runtime_draining', 'gateway_draining', 'storage_unavailable'", "'runtime_draining', 'storage_unavailable'"),
    ('canonical', "(503, 'gateway_draining'): ('hermes_draining', 503), ", ""),
    ('canonical', "(503, 'gateway_draining'): ('hermes_draining', 503)", "(503, 'gateway_draining'): ('hermes_busy', 503)"),
    ('canonical', "(503, 'gateway_draining'): ('hermes_draining', 503)", "(500, 'gateway_draining'): ('hermes_draining', 503)"),
], ids=['the code is not read', 'the table has no row', 'the row says busy', 'the row is for another status'])
def test_each_draining_mutation_is_caught(file, old, new):
    api, canonical = load(file, (old, new))                         # an anchor that moved fails HERE
    with pytest.raises(Exception):  # noqa: B017
        draining_checks(api, canonical)


# ---- the queued chat turn -------------------------------------------------------------------------------------------------------------------
def queued_checks(sse):
    frame = {'event': 'error', 'run_id': 'run_abc', 'seq': 3, 'message': HERMES}
    got = sse.transform('chat', 'error', dict(frame), redact)
    assert got == ('run.queued', {'status': 'queued', 'code': 'run_queued', 'message': sse.RUN_QUEUED, 'run_id': 'run_abc', 'seq': 3}), got      # OUR frame, with the seq it replaces
    assert HERMES not in json.dumps(got) and 'resend' not in got[1]['message'].replace('send it again', '')                                      # Hermes's sentence never leaves
    assert sse.transform('chat', 'error', {'message': ' ' + HERMES + '\n'}, redact)[0] == 'run.queued'                                           # surrounding blanks are not a different sentence
    assert sse.transform('chat', 'error', {'message': HERMES}, redact)[1] == {'status': 'queued', 'code': 'run_queued', 'message': sse.RUN_QUEUED}   # no id, no seq: none invented
    assert sse.transform('chat', 'error', {'message': HERMES, 'run_id': 'x' * 200, 'seq': True}, redact)[1] == {'status': 'queued', 'code': 'run_queued', 'message': sse.RUN_QUEUED}
    # only that sentence, only on the chat surface, only as an `error`
    for message in (HERMES + ' Also: ' + CANARY, 'Provider says: ' + HERMES, HERMES.replace('Hermes is restarting.', 'Hermes is down.'), HERMES.lower(), 'Your input is saved', '', None, 7, ['x']):
        assert sse.transform('chat', 'error', {'message': message}, redact) is None, message                     # an `error` frame stays dropped, as before
    assert sse.transform('run', 'error', dict(frame), redact) is None                                         # the run surface has its own run.queued event
    assert sse.transform('chat', 'luvebot.error', dict(frame), redact) is None                                # upstream cannot forge our events
    assert sse.transform('chat', 'assistant.completed', {'message': HERMES, 'content': HERMES}, redact)[0] == 'assistant.completed'   # a real reply that quotes the sentence is a reply


def test_a_chat_turn_queued_at_retirement_becomes_our_run_queued_frame():
    queued_checks(sse_module)


QUEUED_MUTATIONS = {
    'the frame is not mapped': ("    if surface == 'chat' and event == 'error' and isinstance(data.get('message'), str) and data['message'].strip() == HERMES_QUEUED:", "    if False:"),
    'any text that contains the sentence': ("data['message'].strip() == HERMES_QUEUED:", "HERMES_QUEUED in data['message']:"),
    'the run surface is mapped too': ("    if surface == 'chat' and event == 'error' and", "    if event == 'error' and"),
    'Hermes text is passed on': ("        frame['message'] = RUN_QUEUED\n", "        frame['message'] = data['message']\n"),
    'the seq is lost': ("        if type(seq) is int:\n            frame['seq'] = seq\n", ""),
    'any type of seq': ("        if type(seq) is int:\n            frame['seq'] = seq\n", "        if seq is not None:\n            frame['seq'] = seq\n"),
    'a run id of any length': ("if isinstance(run_id, str) and 0 < len(run_id) <= 128:\n            frame['run_id'] = run_id", "if isinstance(run_id, str):\n            frame['run_id'] = run_id"),
    'every error is queued': ("    if surface == 'chat' and event == 'error' and isinstance(data.get('message'), str) and data['message'].strip() == HERMES_QUEUED:", "    if surface == 'chat' and event == 'error':"),
}


@pytest.mark.parametrize('label', sorted(QUEUED_MUTATIONS))
def test_each_queued_mutation_is_caught(label):
    old, new = QUEUED_MUTATIONS[label]
    source = Path(sse_module.__file__).read_text()
    assert source.count(old) == 1, old
    variant = types.ModuleType('sse_variant')
    exec(compile(source.replace(old, new), 'sse_variant', 'exec'), variant.__dict__)
    with pytest.raises(Exception):  # noqa: B017 (an AssertionError, or the KeyError of a mutant that reads a message that is not there)
        queued_checks(variant)
