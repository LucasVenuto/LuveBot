"""The Hermes side of approvals: the ONE native answer, and the watcher that captures requests of runs LuveBot started.

Hermes route used (f8489405):
  POST /v1/runs/{run_id}/approval   gateway/platforms/api_server_runs.py#L1168   body {"choice", "request_id"}, observed in the
                                    T3.0c spike: 200 {"object": "hermes.run.approval_response", "run_id", "choice",
                                    "request_id", "resolved": 1}
  GET  /v1/runs/{run_id}/events     the run's SSE stream, also read by the browser; several readers are allowed
  GET  /v1/runs/{run_id}            the run's status, and `pending_steer` once it ended (agent/turn_finalizer.py#L728)
  POST /v1/runs/{run_id}/steer      api_server_runs.py#L1219, body {"input"}: accepted only while the run is `running` (never
                                    during waiting_for_approval); queued, then delivered after the tool batch or before the
                                    next model call, or handed back as `pending_steer` when the run ends first
`decide` is called only by `approvals.resolve` (passed in by the route), never directly: that is test H1.
b3: the approval route drops a deny reason (api_server_runs.py#L1204 calls resolve_gateway_approval without it), so a reason
goes to the run as a steer AFTER the deny. It counts as delivered only with PROOF that the model read it: the steer row is in the
session's transcript with an answer of the model after it (see `settle_reasons`).
"""
import logging
import os
import threading
import time

from . import approvals, sse_proxy
from .hermes_api import ApiClient, safe_id
from .hermes_client import HermesError

MAX_WATCHERS = 64
WATCH_FLOOR = 6 * 3600.0       # the watcher's safety ceiling never goes below this (it normally ends with the run)
RECONNECT_MAX = 30.0           # the longest pause between two attempts to reopen a dropped stream
_log = logging.getLogger('luvebot.approvals')
_active = set()
_lock = threading.Lock()


def decide(bot, run_id, choice, request_id):
    """-> True when Hermes resolved the request, False when it no longer has it pending. Transport trouble raises HermesError.
    Only "once" and "deny" can leave this function: a persistent native choice would be a rule outside our control (RT 5)."""
    if choice not in approvals.CHOICES or safe_id(run_id) is None or safe_id(request_id) is None:
        raise ValueError('refused')
    status, payload = ApiClient(bot).call('POST', f'/v1/runs/{run_id}/approval', {'choice': choice, 'request_id': request_id})
    if status == 200 and payload and isinstance(payload.get('resolved'), int) and payload['resolved'] >= 1:
        return True
    if status in (404, 409):
        return False
    raise HermesError('hermes_error')


STEER_WAIT = 5.0
_ENDED = ('completed', 'failed', 'cancelled', 'interrupted')


def steer_reason(bot, run_id, text, *, wait=STEER_WAIT):
    """After a delivered deny: the reason as a steer of the run. -> True when Hermes accepted it (queued, not yet seen by the model),
    False when the run did not come back to `running` in time (it ended, or is still waiting) or Hermes refused it."""
    if safe_id(run_id) is None or not text:
        return False
    deadline = time.monotonic() + wait
    while True:
        status, payload = ApiClient(bot).call('GET', f'/v1/runs/{run_id}')
        state = payload.get('status') if status == 200 and isinstance(payload, dict) else None
        if state == 'running':
            break
        if state in _ENDED or state is None or time.monotonic() > deadline:
            return False
        time.sleep(0.05)
    status, payload = ApiClient(bot).call('POST', f'/v1/runs/{run_id}/steer', {'input': text})
    return status == 200 and isinstance(payload, dict) and payload.get('accepted') is True


def deny_steer_text(reason):
    """The steer a deny reason is sent as: a FIXED frame and the person's own (redacted) words, nothing from the agent. Hermes
    delivers a steer as a user message, so a command quoted here could speak for the person (Lume, b3 B2)."""
    return f'[luvebot:deny] A pessoa negou a ação que você acabou de pedir e disse: {reason}'


def _session_id(bot, run_id):
    status, payload = ApiClient(bot).call('GET', f'/v1/runs/{run_id}')
    session_id = payload.get('session_id') if status == 200 and isinstance(payload, dict) else None
    return session_id if isinstance(session_id, str) and safe_id(session_id) is not None else None


def steer_watermark(bot, run_id):
    """The id of the run's session's last message, read just BEFORE a steer is sent: the steer's row can only come after it.
    Hermes orders a session by id, never by time (hermes_state_messages.py get_messages: "clocks regress"). -> int, or None when
    it cannot be read (then no proof is ever possible: unknown)."""
    from .hermes_cron import _session_db
    session_id = _session_id(bot, run_id)
    if session_id is None:
        return None
    db = _session_db(bot)
    try:
        last = db.get_messages(session_id, latest=True, limit=1)
    finally:
        db.close()
    return int(last[-1]['id']) if last else 0


def steer_proofs(bot, session_id, sent):
    """Which of `sent` = [(request_id, text, after)] the session's transcript PROVES the model read. A steer row (`role` user,
    `display_kind` 'steer', agent/prompt_builder.py steer_user_row) holds each text it delivered; an answer of the model after it
    means a model call had it in its request. Each occurrence proves ONE send: only one inserted after that send's watermark
    (Hermes persists the turn every tool round BEFORE the tools run, agent/turn_tool_round.py#L121, so an earlier send's row is
    below a later send's watermark), taken in send order; two sends in one tool batch can share a row (Hermes joins pending
    steers), so the text must occur once per send. The same reason twice, the second one lost, never borrows the first one's row."""
    from .hermes_cron import _session_db
    db = _session_db(bot)
    try:
        rows = db.get_messages(session_id, after_id=min(after for _r, _t, after in sent))
    finally:
        db.close()
    proven, used = set(), {}
    for request_id, text, after in sorted(sent, key=lambda s: (s[2], s[0])):
        wanted = text.strip()
        for index, row in enumerate(rows):
            if not (row.get('role') == 'user' and row.get('display_kind') == 'steer' and int(row.get('id') or 0) > after):
                continue
            free = str(row.get('content') or '').count(wanted) - used.get((index, wanted), 0)
            if free > 0 and any(later.get('role') == 'assistant' for later in rows[index + 1:]):
                used[(index, wanted)] = used.get((index, wanted), 0) + 1
                proven.add(request_id)
                break
    return proven


def settle_reasons(path, bot, run_id):
    """Once the run ended, what became of each deny reason sent to it as a steer. 'delivered' ONLY with proof that the model read
    it (`steer_proofs`). A steer can land in three places (f8489405): before a model call (drained into it, agent/turn_iteration_prep.py
    #L153: read); during the last model call (the finalizer hands it back as `pending_steer`, agent/turn_finalizer.py#L728:
    'not_delivered'); or AFTER that drain and before the run is marked completed (api_server_runs.py `_finish` runs only when the
    worker returns, and `_handle_steer_run` still accepts it while the status says running): it stays in the agent of that run,
    never read and never reported. So "completed with nothing pending" is NOT proof (found by the B3_QUICK test, 1 run in 3); the
    proof is `steer_proofs`, per send.
    Without proof, or with a failed, cancelled or interrupted run, or an unreadable transcript: 'unknown', never 'delivered'."""
    waiting = approvals.reasons_waiting(path, run_id)
    if not waiting:
        return
    status, payload = ApiClient(bot).call('GET', f'/v1/runs/{run_id}')
    if status != 200 or not isinstance(payload, dict) or payload.get('status') not in _ENDED:
        return  # not ended (or unreadable): stays "accepted", shown as not known yet, never as delivered
    session_id = payload.get('session_id')
    proven = set()
    if payload.get('status') == 'completed' and not payload.get('pending_steer'):
        rows = [approvals.get(path, request_id) for request_id in waiting]
        sent = [(r['request_id'], deny_steer_text(r['reason']), r['reason_steer_after']) for r in rows
                if r and r.get('reason') and r.get('reason_steer_after') is not None]
        try:
            if sent and isinstance(session_id, str) and safe_id(session_id) is not None:
                proven = steer_proofs(bot, session_id, sent)
        except Exception:  # the transcript could not be read: no proof
            proven = set()
    for request_id in waiting:
        if payload.get('status') != 'completed':
            state = 'unknown'
        elif payload.get('pending_steer'):
            state = 'not_delivered'
        else:
            state = 'delivered' if request_id in proven else 'unknown'
        approvals.set_reason_steer(path, request_id, state, only_from='accepted')


def watch_ceiling(bot):
    """The SAFETY ceiling of a run's approval watcher, in seconds: max(WATCH_FLOOR, 2 x the Bot's approval wait + 600). The watcher
    normally ends with the run; this only bounds a run whose end is never seen. A fixed 3600 s stopped watching any run longer
    than an hour: later requests never reached the inbox and a deny reason never settled. LUVEBOT_APPROVAL_WATCH_CEILING
    (seconds) replaces it, for tests."""
    forced = os.environ.get('LUVEBOT_APPROVAL_WATCH_CEILING')
    if forced:
        try:
            return max(float(forced), 1.0)
        except ValueError:
            pass
    return max(WATCH_FLOOR, 2 * (approvals.ttl(bot) - approvals.TTL_SLACK) + 600)


def start_watcher(path, bot, run_id, redact):
    """Capture the approval requests of a run LuveBot started, with no browser attached (A-19). Closing a browser stream never
    stops it and never stops the run; it lives as long as the run does (`_watch`). One watcher per run."""
    with _lock:
        if run_id in _active or len(_active) >= MAX_WATCHERS:
            return False
        _active.add(run_id)
    threading.Thread(target=_watch, args=(path, bot, run_id, redact), daemon=True, name=f'luvebot-approvals-{run_id[:12]}').start()
    return True


def _run_state(bot, run_id):
    """The run's status from Hermes, None when Hermes no longer knows the run (404), 'unreadable' otherwise."""
    status, payload = ApiClient(bot).call('GET', f'/v1/runs/{run_id}')
    if status == 404:
        return None
    return payload.get('status') if status == 200 and isinstance(payload, dict) else 'unreadable'


def _ended(path, bot, run_id):
    approvals.expire_run(path, run_id)
    try:
        settle_reasons(path, bot, run_id)
    except Exception:  # noqa: BLE001  (unsettled stays "accepted": shown as not known, never as delivered)
        pass


def _follow(path, bot, run_id, redact, clock, deadline):
    """One connection to the run's events. -> (ended, frames): ended is True when the run's terminal event was seen (and handled),
    False when the stream ended, dropped or could not open, or the ceiling passed, with the run's end not seen; frames counts the
    events read on this connection."""
    stream, frames = None, 0
    try:
        status, stream = ApiClient(bot).open_stream('GET', f'/v1/runs/{run_id}/events')
        if stream is None:
            return False, 0
        parser = sse_proxy.SseReader()
        for line in stream.lines(sse_proxy.MAX_LINE):
            frame = parser.feed(line)
            if frame:
                frames += 1
                event, data = frame
                if event == 'approval.request':
                    transformed = sse_proxy.transform('run', event, data, redact)
                    if transformed:
                        approvals.record_request(path, bot, run_id, 'run', transformed[1])
                elif event in sse_proxy.TERMINAL:
                    _ended(path, bot, run_id)
                    return True, frames
            if clock() > deadline:
                return False, frames
        return False, frames
    except Exception as error:  # noqa: BLE001  (a dropped connection is retried by the caller)
        _log.warning('approval watcher: stream dropped (%s)', type(error).__name__)
        return False, frames
    finally:
        if stream is not None:
            stream.abort()


def _watch(path, bot, run_id, redact, *, clock=time.monotonic, sleep=time.sleep):
    """A run's approval watcher. It ends on the run's terminal event, or when the stream ends and Hermes says the run ended (an
    `interrupted` run has no terminal event in sse_proxy.TERMINAL). A stream that drops while the run lives is reopened with
    backoff: Hermes replays the run's retained events (api_server_runs.py _RunStream, 1000) and record_request ignores a request
    it already has, so nothing is lost or doubled. Only the safety ceiling (`watch_ceiling`) stops it otherwise, and that leaves
    an audit row and a log line, never silence. A missed request is never reconstructed as an approved one (A-19)."""
    backoff = 0.5
    try:
        deadline = clock() + watch_ceiling(bot)
        while True:
            ended, frames = _follow(path, bot, run_id, redact, clock, deadline)
            if ended:
                return
            if clock() > deadline:
                _log.warning('approval watcher: safety ceiling reached for run %s; its later approval requests are not captured', run_id)
                from .audit import AuditLog
                AuditLog(path).act('system', 'approval.watch.ceiling', run_id, {'kind': 'system'}, lambda: None, bot=bot)
                return
            state = _run_state(bot, run_id)
            if state in _ENDED:
                _ended(path, bot, run_id)
                return
            if state is None:
                _log.warning('approval watcher: Hermes no longer knows run %s', run_id)
                return
            if frames:
                backoff = 0.5  # that connection worked for a while: start the pauses over
            sleep(backoff)
            backoff = min(backoff * 2, RECONNECT_MAX)
    except Exception as error:  # noqa: BLE001
        _log.warning('approval watcher stopped: %s', type(error).__name__)  # the class only, never the text
    finally:
        with _lock:
            _active.discard(run_id)
