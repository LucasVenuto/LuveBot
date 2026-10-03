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
goes to the run as a steer AFTER the deny, and counts as delivered only when the run ended with nothing pending.
"""
import threading
import time

from . import approvals, sse_proxy
from .hermes_api import ApiClient, safe_id
from .hermes_client import HermesError

MAX_WATCHERS = 64
WATCH_SECONDS = 3600
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


def settle_reasons(path, bot, run_id):
    """Once the run ended. Only a COMPLETED run went through Hermes's turn finalizer, which hands back an unread steer as
    `pending_steer`: completed without it = delivered, completed with it = not delivered. A failed, cancelled or interrupted run
    ends without the finalizer and without the field (api_server_runs.py#L987-L996): unknown, never delivered."""
    waiting = approvals.reasons_waiting(path, run_id)
    if not waiting:
        return
    status, payload = ApiClient(bot).call('GET', f'/v1/runs/{run_id}')
    if status != 200 or not isinstance(payload, dict) or payload.get('status') not in _ENDED:
        return  # not ended (or unreadable): stays "accepted", shown as not known yet, never as delivered
    if payload.get('status') != 'completed':
        state = 'unknown'
    else:
        state = 'not_delivered' if payload.get('pending_steer') else 'delivered'
    for request_id in waiting:
        approvals.set_reason_steer(path, request_id, state, only_from='accepted')


def start_watcher(path, bot, run_id, redact):
    """Capture the approval requests of a run LuveBot started, with no browser attached (A-19). Closing a browser stream never
    stops it and never stops the run; it ends with the run, or after WATCH_SECONDS."""
    with _lock:
        if run_id in _active or len(_active) >= MAX_WATCHERS:
            return False
        _active.add(run_id)
    threading.Thread(target=_watch, args=(path, bot, run_id, redact), daemon=True, name=f'luvebot-approvals-{run_id[:12]}').start()
    return True


def _watch(path, bot, run_id, redact):
    stream = None
    try:
        status, stream = ApiClient(bot).open_stream('GET', f'/v1/runs/{run_id}/events')
        if stream is None:
            return
        parser, deadline = sse_proxy.SseReader(), time.monotonic() + WATCH_SECONDS
        for line in stream.lines(sse_proxy.MAX_LINE):
            frame = parser.feed(line)
            if frame:
                event, data = frame
                if event == 'approval.request':
                    transformed = sse_proxy.transform('run', event, data, redact)
                    if transformed:
                        approvals.record_request(path, bot, run_id, 'run', transformed[1])
                elif event in sse_proxy.TERMINAL:
                    approvals.expire_run(path, run_id)
                    try:
                        settle_reasons(path, bot, run_id)
                    except Exception:  # noqa: BLE001  (unsettled stays "accepted": shown as not known, never as delivered)
                        pass
                    return
            if time.monotonic() > deadline:
                return
    except Exception:
        pass  # a missed request is never reconstructed as an approved one (A-19): it simply is not in the inbox
    finally:
        if stream is not None:
            stream.abort()
        with _lock:
            _active.discard(run_id)
