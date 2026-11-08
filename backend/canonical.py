"""F4 (contract v0.9 B): the main's CANONICAL run controls, behind `features.run_unknown_resolution` of `/v1/capabilities`.

With a session authority (the main, v0.23) Hermes resolves a run's approval and clarify through durable claims. Differences LuveBot meets:
  GET  /v1/runs/{id}                  the projection carries `execution_generation` and `pending_controls`
                                      (gateway/platforms/api_server_authority_runs.py#L68)
  POST /v1/runs/{id}/approval         body EXACTLY {request_id, execution_generation, choice}; 200 {status: resolved|already_resolved}
  POST /v1/runs/{id}/clarify          body EXACTLY {request_id, execution_generation, answer}; clarify is NOT in the SSE, only in `pending_controls`
  POST /v1/runs/{id}/resolve-unknown  body EXACTLY {admission_id, execution_generation}; acknowledges a run whose owner Hermes lost
  The SSE `approval.request` carries the control's `prompt_id` (no `request_id`); sse_proxy.transform sets `request_id` = `prompt_id` when `request_id`
  is missing, so for LuveBot a request's `request_id` IS the control's `prompt_id`. A stale generation, or a request no longer pending, is 409.
Without the flag nothing here runs and every call keeps the old format (approvals_native.decide, the old mapping of 409).

What the browser gets is a WHITELIST (an approval item's `edit` and `timeout_s` are ignored; a clarify item is one `question`, its `choices`
and `multi_select`), redacted and bounded. The answer to a clarify is the person's own words: it is validated here (the API path does not
coerce it, tools/clarify_gateway.py) and audited only as a keyed digest and a length. Nothing here answers on its own (invariant 6).
"""
import json
import re
import threading
import time

from .api_errors import PluginError
from .hermes_api import ApiClient, safe_id
from .hermes_client import HermesError

FLAG = 'run_unknown_resolution'
FLAG_TTL = 60.0
FAIL_TTL = 8.0   # a Hermes that does not answer is not asked again by every chat turn and every decision: each used to pay up to 3 s (review 2, F8)
MAX_QUESTION, MAX_CHOICES, MAX_CHOICE, MAX_ANSWER = 2000, 20, 200, 16384
KINDS = ('approval', 'clarify')

_lock = threading.Lock()
_flag = {}  # bot -> (monotonic time, bool)


def _capabilities(bot):
    from .hermes_client import HermesClient  # imported here: only a process with Hermes has it
    return HermesClient(bot).capabilities()


def authority(bot, *, reader=None, now=time.monotonic):
    """True when this Bot's Hermes runs a session authority (`features.run_unknown_resolution`). Cached 60 s. Anything unreadable is False:
    the old format, which a main with an authority refuses loudly (400/409), never silently. A failure is remembered FAIL_TTL seconds (False)."""
    with _lock:
        hit = _flag.get(bot)
    if hit is not None and now() - hit[0] < hit[2]:
        return hit[1]
    try:
        caps = (reader or _capabilities)(bot)
        features = caps.get('features') if isinstance(caps, dict) else None
        value = isinstance(features, dict) and features.get(FLAG) is True
    except HermesError:
        with _lock:
            _flag[bot] = (now(), False, FAIL_TTL)   # the failure too, for a few seconds: a down Hermes is asked once, not on every turn
        return False
    with _lock:
        _flag[bot] = (now(), value, FLAG_TTL)
    return value


# ---- what Hermes says about a run -------------------------------------------------------------------------------------------------
def generation(payload):
    value = payload.get('execution_generation') if isinstance(payload, dict) else None
    return value if type(value) is int and value >= 0 else None


def _text(value, limit):
    return value[:limit] if isinstance(value, str) else None


def controls(payload):
    """The whitelisted pending controls of a canonical run projection, UNREDACTED (they are validated against, never shown as they are):
    [{kind, request_id}] for an approval, [{kind, request_id, question, choices, multi_select, timeout_s?}] for a clarify. Unknown kinds and
    malformed items are dropped, never guessed at."""
    out = []
    for item in (payload.get('pending_controls') if isinstance(payload, dict) else None) or ():
        if not isinstance(item, dict) or item.get('kind') not in KINDS or safe_id(item.get('prompt_id')) is None:
            continue
        control = {'kind': item['kind'], 'request_id': item['prompt_id']}
        if item['kind'] == 'clarify':
            choices = [c for c in (item.get('choices') if isinstance(item.get('choices'), list) else []) if isinstance(c, str)]
            control.update(question=_text(item.get('question'), 100_000) or '', choices=choices, multi_select=item.get('multi_select') is True)
            timeout = item.get('timeout_s')
            if isinstance(timeout, (int, float)) and not isinstance(timeout, bool) and 0 < timeout <= 86400:
                control['timeout_s'] = int(timeout)
        out.append(control)
    return out


def view(control, redact):
    """One control as the browser sees it: redacted and bounded (question 2000, 20 choices of 200)."""
    if control['kind'] == 'approval':
        return {'kind': 'approval', 'request_id': control['request_id']}
    # redact FIRST, then cut: a secret that straddles the cut would otherwise survive as a half the redactor does not recognize
    out = {'kind': 'clarify', 'request_id': control['request_id'], 'question': redact(control['question'])[:MAX_QUESTION],
           'choices': [redact(c)[:MAX_CHOICE] for c in control['choices'][:MAX_CHOICES]], 'multi_select': control['multi_select']}
    if 'timeout_s' in control:
        out['timeout_s'] = control['timeout_s']
    return out


def run_extras(payload, redact):
    """What a canonical run adds to the run object of `GET /bots/{bot}/runs/{id}`; {} for any other Hermes (no `execution_generation`)."""
    gen = generation(payload)
    if gen is None:
        return {}
    extras = {'execution_generation': gen, 'pending_controls': [view(c, redact) for c in controls(payload)]}
    admission = payload.get('admission_id')
    if payload.get('status') == 'unknown' and safe_id(admission) is not None:
        extras['resolution'] = {'needed': True, 'admission_id': admission, 'execution_generation': gen}
    return extras


def read_run(bot, run_id):
    status, payload, code = ApiClient(bot).call_coded('GET', f'/v1/runs/{run_id}')
    if status == 404:
        raise PluginError('run_not_found', 'Run not found.', 404)
    if status != 200 or not isinstance(payload, dict):
        raise refusal(status, code, 'run') or HermesError('hermes_error')
    return payload


# ---- the refusals, in words (B-5, B-9: by CODE, never only by status) ----------------------------------------------------------
_MESSAGES = {
    'hermes_draining': 'Hermes is restarting; try again in a few seconds.',
    'hermes_busy': 'Hermes is busy saving; try again.',
    'run_queued': 'Hermes accepted this and queued it until it is back; do not send it again.',
    'request_not_pending': 'This request is no longer waiting: the Bot moved on, someone answered it, or Hermes restarted.',
    'run_conflict': 'Two requests share one identifier; send it again.',
    'run_unknown': 'Hermes lost track of this run; confirm it ended to free the conversation.',
    'session_other_channel': 'This conversation belongs to another channel; continue in a new one.',
}


def is_queued(status, code):
    """Hermes accepted the work and queued it for the next owner (503 `admission_queued`, `x-should-retry: false`). That is NOT a refusal: it
    never becomes an error. The caller answers `QUEUED_BODY` (a success) and never sends the work again."""
    return status == 503 and code == 'admission_queued'


def queued_body():
    return {'queued': True, 'code': 'run_queued', 'message': _MESSAGES['run_queued'], 'run': None}


def open_turn(index, cid, opener, fail):
    """Open a chat turn's stream once its `client_message_id` is claimed. `opener() -> (status, stream|None, code|None)`,
    `fail(status, code) -> the error to raise`. -> the stream, or None when Hermes QUEUED the turn (a success: the caller answers
    `queued_body()`). A refusal or a failure RELEASES the claim (the message was not taken, so a retry is honest); a queue KEEPS it:
    Hermes has the message, and a resend would run the work twice."""
    try:
        status, stream, code = opener()
        if stream is None and is_queued(status, code):
            return None
        if stream is None:
            raise fail(status, code)
        return stream
    except BaseException:
        if cid:
            index.release_message(cid)
        raise


def refusal(status, code, surface):
    """A Hermes refusal -> our PluginError, or None when this pair has no words of its own (the caller keeps its old mapping).
    `surface` is 'create' (a run), 'chat' (a session turn) or 'run' (a control of a run): `permission_denied` is the other-channel refusal
    only on the first two; on a run control it means something else and is NOT mapped. A queue (`is_queued`) is not a refusal and is not here."""
    table = {(503, 'runtime_draining'): ('hermes_draining', 503), (503, 'gateway_draining'): ('hermes_draining', 503), (503, 'storage_unavailable'): ('hermes_busy', 503),
             (503, 'chain_moved'): ('hermes_busy', 503),
             (409, 'stale_generation'): ('request_not_pending', 409), (409, 'approval_not_pending'): ('request_not_pending', 409),
             (409, 'admission_conflict'): ('run_conflict', 409), (409, 'unknown_execution'): ('run_unknown', 409)}
    if surface in ('create', 'chat'):
        table[(409, 'permission_denied')] = ('session_other_channel', 409)
    found = table.get((status, code))
    if found is None:
        return None
    extra = {'details': {'can_fork': True}} if found[0] == 'session_other_channel' else None
    return PluginError(found[0], _MESSAGES[found[0]], found[1], extra)


# ---- approval (B-1) -----------------------------------------------------------------------------------------------------------------
def decide_approval(bot, run_id, choice, request_id):
    """-> True ONLY when Hermes says `resolved`; False when it no longer has the request (`already_resolved`: someone else answered or it
    expired; a stale generation; the run is gone). Anything else raises HermesError (the caller reports the result as unknown, never as
    decided). Never decides blind: the request must be a pending approval control of THIS run, in the generation Hermes reports now."""
    if choice not in ('once', 'deny') or safe_id(run_id) is None or safe_id(request_id) is None:
        raise ValueError('refused')
    payload = read_run(bot, run_id)
    gen = generation(payload)
    if gen is None or not any(c['kind'] == 'approval' and c['request_id'] == request_id for c in controls(payload)):
        return False
    status, body, code = ApiClient(bot).call_coded('POST', f'/v1/runs/{run_id}/approval',
                                                   {'request_id': request_id, 'execution_generation': gen, 'choice': choice})
    if status == 200 and isinstance(body, dict) and body.get('status') in ('resolved', 'already_resolved'):
        return body['status'] == 'resolved'
    if status == 404 or (status == 409 and code in ('stale_generation', 'approval_not_pending', 'not_found')):
        return False
    raise HermesError('hermes_error')


# ---- clarify (B-3, B-5) -------------------------------------------------------------------------------------------------------------
def _invalid():
    return PluginError('invalid_answer', 'This answer is not one the question accepts.', 422)


def validate_answer(control, answer):
    """-> the exact string to send. Free text when the question has no choices; the exact label when it has; a JSON list string of exact,
    distinct labels when it is multi-select. The API path does not coerce, so a loose answer would reach the Bot as it is."""
    if not isinstance(answer, str) or not answer.strip() or len(answer) > MAX_ANSWER:
        raise _invalid()
    choices = control['choices']
    if not choices:
        return answer
    if control['multi_select']:
        try:
            picked = json.loads(answer)
        except ValueError:
            raise _invalid() from None
        if not isinstance(picked, list) or not picked or len(set(map(str, picked))) != len(picked) \
                or not all(isinstance(p, str) and p.strip() and p in choices for p in picked):
            raise _invalid()
        return json.dumps(picked, ensure_ascii=False)
    if answer not in choices:
        raise _invalid()
    return answer


# The Skip (contract v0.11 section 4, K-1): Hermes reads a BLANK answer as `skipped` for THAT question and the run goes on (K-2b); the EMPTY string ends the whole call and `null` is a 400. So a skip is exactly one space,
# a constant defined here once and used once, by the skip alone: never `""`, never `None`, never the word `skip`, never anything the browser sent.
CLARIFY_SKIP_ANSWER = ' '


def validate_clarify_body(body):
    """The body is exactly {request_id, execution_generation, answer} or exactly {request_id, execution_generation, skip: true}. -> {request_id, execution_generation, answer, skip}: `answer` None for a skip.
    `skip` is the boolean `true` and nothing else (a string, 1, null, false), and a skip carries no answer, no choices and no other key: 422 `invalid_answer`."""
    if not isinstance(body, dict) or not {'request_id', 'execution_generation'} <= set(body) or not ({'answer'} == set(body) - {'request_id', 'execution_generation'} or 'skip' in body):
        raise PluginError('bad_request', 'Malformed request body.', 400)
    if safe_id(body['request_id']) is None or type(body['execution_generation']) is not int or body['execution_generation'] < 0:
        raise PluginError('invalid_field', 'Invalid request_id or execution_generation.', 422)
    if 'skip' in body:
        if set(body) != {'request_id', 'execution_generation', 'skip'} or body['skip'] is not True:
            raise _invalid()
        return {'request_id': body['request_id'], 'execution_generation': body['execution_generation'], 'answer': None, 'skip': True}
    if not isinstance(body['answer'], str):
        raise _invalid()
    return {'request_id': body['request_id'], 'execution_generation': body['execution_generation'], 'answer': body['answer'], 'skip': False}


def answer_clarify(bot, run_id, request_id, seen_generation, answer, *, skip=False):
    """Send the person's answer to a pending clarify of this run, in the generation they saw. -> None. PluginError for every refusal. With `skip` nothing the person typed is looked at or sent: it is the one space of
    `CLARIFY_SKIP_ANSWER` (Hermes reads it as `skipped`, for this question only), under the same checks of the generation and of the pending request."""
    payload = read_run(bot, run_id)
    gen = generation(payload)
    control = next((c for c in controls(payload) if c['kind'] == 'clarify' and c['request_id'] == request_id), None)
    if gen is None or gen != seen_generation or control is None:
        raise PluginError('request_not_pending', _MESSAGES['request_not_pending'], 409)
    value = CLARIFY_SKIP_ANSWER if skip else validate_answer(control, answer)
    status, body, code = ApiClient(bot).call_coded('POST', f'/v1/runs/{run_id}/clarify',
                                                   {'request_id': request_id, 'execution_generation': gen, 'answer': value})
    if status == 200 and isinstance(body, dict) and body.get('status') == 'resolved':
        return
    if status == 200 and isinstance(body, dict) and body.get('status') == 'already_resolved':
        raise PluginError('request_not_pending', _MESSAGES['request_not_pending'], 409)
    if status == 404 or (status == 409 and code == 'not_found'):
        raise PluginError('request_not_pending', _MESSAGES['request_not_pending'], 409)
    raise refusal(status, code, 'run') or HermesError('hermes_error')


# ---- resolve-unknown (B3) -----------------------------------------------------------------------------------------------------------
def validate_unknown_body(body):
    if not isinstance(body, dict) or set(body) != {'execution_generation'}:
        raise PluginError('bad_request', 'Malformed request body.', 400)
    if type(body['execution_generation']) is not int or body['execution_generation'] < 0:
        raise PluginError('invalid_field', 'Invalid execution_generation.', 422)
    return body


def resolve_unknown(bot, run_id, seen_generation, *, gate=None):
    """The person confirms the run Hermes lost is over. The server reads `admission_id` and the CURRENT generation itself; a generation
    other than the one the person saw is 409 `stale` (they decide about what they saw). `gate` is the gate of a NEW run (hook live, no pause,
    no cap: invariant 7), called FIRST and before anything reaches Hermes: resolving frees the turns queued behind the lost run, so it
    starts work. -> None."""
    if gate is not None:
        gate()
    payload = read_run(bot, run_id)
    gen, admission = generation(payload), payload.get('admission_id')
    if payload.get('status') != 'unknown' or gen is None or safe_id(admission) is None:
        raise PluginError('run_not_unknown', 'This run is not waiting to be resolved.', 409)
    if gen != seen_generation:
        raise PluginError('stale', 'This run changed since you looked at it; reload and check again.', 409)
    status, _body, code = ApiClient(bot).call_coded('POST', f'/v1/runs/{run_id}/resolve-unknown',
                                                    {'admission_id': admission, 'execution_generation': gen})
    if status == 200:
        return
    raise refusal(status, code, 'run') or HermesError('hermes_error')


# ---- a session of another channel (B-6, B-7, B-8) ---------------------------------------------------------------------------------
def session_source(bot, session_id, *, db_of=None):
    """The `source` of a stored session (read-only, Hermes's own SessionDB), or None when unknown or unreadable."""
    try:
        from .hermes_cron import _session_db
        db = (db_of or _session_db)(bot)
        try:
            row = db.get_session(session_id)
        finally:
            db.close()
    except Exception:  # noqa: BLE001  (a hint only; Hermes decides)
        return None
    source = row.get('source') if isinstance(row, dict) else None
    return source if isinstance(source, str) and source else None


def check_session_channel(bot, session_id, *, db_of=None, flag=None):
    """B-8: with the flag, a turn on a session whose source is not `api_server` is refused HERE the way Hermes refuses it (a copy of its
    rule: gateway/session_api.py#L176, no special case for rooms), so the person sees the words and the way out instead of a 409. A hint of
    UX only: the truth is Hermes's own `permission_denied`, mapped by `refusal` on the chat and run-create paths."""
    if not (flag if flag is not None else authority(bot)):
        return
    source = session_source(bot, session_id, db_of=db_of)
    if source is not None and source != 'api_server':
        raise PluginError('session_other_channel', _MESSAGES['session_other_channel'], 409,
                          {'details': {'source': source if re.fullmatch(r'[a-z0-9_-]{1,32}', source) else 'other', 'can_fork': True}})


def validate_fork_body(body):
    if not isinstance(body, dict) or set(body) - {'title'}:
        raise PluginError('bad_request', 'Malformed request body.', 400)
    title = body.get('title')
    if title is not None and (not isinstance(title, str) or not title.strip() or len(title) > 200):
        raise PluginError('invalid_field', 'Invalid value for title.', 422)
    return title


def fork(bot, session_id, title):
    """Hermes's fork: a copy of the conversation as an `api_server` session. SIDE EFFECT (B-7): Hermes ends the ORIGINAL as `branched`.
    Only ever from a person's click (the route is human-initiated and audited), never automatic. -> {id, title}."""
    status, payload, code = ApiClient(bot).call_coded('POST', f'/api/sessions/{session_id}/fork', {'title': title} if title else {})
    if status == 404:
        raise PluginError('session_not_found', 'Session not found.', 404)
    if status not in (200, 201) or not isinstance(payload, dict):
        raise refusal(status, code, 'chat') or HermesError('hermes_error')
    session = payload.get('session') if isinstance(payload.get('session'), dict) else payload
    new_id = safe_id(session.get('id') or session.get('session_id'))
    if new_id is None:
        raise HermesError('hermes_error')
    return {'id': new_id, 'title': _text(session.get('title'), 200)}
