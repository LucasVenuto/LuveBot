"""SSE relay rules (contract section 6): parse Hermes frames, drop unknown ones, apply the 6.3 changes, frame ours.

Pure: no I/O, no Hermes imports. The caller passes the redactor. Frame text is DATA for the browser, never an
instruction; this module only removes or masks, it never interprets.
"""
import json

RUN_EVENTS = {'message.delta', 'reasoning.available', 'message.interim', 'tool.started', 'tool.completed',
              'approval.request', 'run.completed', 'run.cancelled', 'run.queued'}
CHAT_EVENTS = {'run.started', 'message.started', 'assistant.delta', 'tool.progress', 'assistant.commentary',
               'tool.started', 'tool.completed', 'tool.failed', 'approval.request', 'assistant.completed',
               'run.completed', 'run.cancelled', 'done'}
# Documented upstream but never observed (6.1/6.2, [D]): allowed through, the UI tolerates their absence.
DOCUMENTED = {'subagent.start', 'subagent.complete', 'run.failed'}
ALLOWED = {'run': RUN_EVENTS | DOCUMENTED, 'chat': CHAT_EVENTS | DOCUMENTED}
TERMINAL = {'run.completed': 'completed', 'run.cancelled': 'cancelled', 'run.failed': 'completed'}
# ponytail: run.failed has no observed frame; it ends the stream "completed" and the frame itself says it failed.
ARGS_CAP = 4096
# F4 (B-2): the main's run stream says `run.queued` when a run was accepted and waits for the next owner. Hermes's text says "do not resend"
# and is Hermes's: it never leaves; this one is ours (a stable `code` the UI translates).
RUN_QUEUED = 'Hermes accepted this and queued it until it is back; do not send it again.'
MAX_LINE = 1024 * 1024


class SseReader:
    """Incremental SSE parser over raw upstream lines. Comment frames and non-JSON events vanish here."""

    def __init__(self):
        self.event, self.data = '', []

    def feed(self, line):
        """line: one decoded line without its newline. Returns (event, data_dict) or None."""
        if line.endswith('\r'):
            line = line[:-1]
        if line == '':
            raw, event, self.data, self.event = '\n'.join(self.data), self.event, [], ''
            if not raw:
                return None
            try:
                data = json.loads(raw)
            except ValueError:
                return None
            if not isinstance(data, dict):
                return None
            name = event or data.get('event')
            return (name, data) if isinstance(name, str) and name else None
        if line.startswith(':'):
            return None
        field, _, value = line.partition(':')
        value = value[1:] if value.startswith(' ') else value
        if field == 'event':
            self.event = value
        elif field == 'data':
            self.data.append(value)
        return None


def _redact(value, redact, depth=0):
    if isinstance(value, str):
        return redact(value)
    if depth < 8 and isinstance(value, dict):
        return {k: _redact(v, redact, depth + 1) for k, v in value.items()}
    if depth < 8 and isinstance(value, list):
        return [_redact(v, redact, depth + 1) for v in value]
    return value


# Hermes's own sentence for a turn it accepted and kept queued while its owner retires (gateway/session_api_turn.py `AdmissionQueued.MESSAGE`). The session chat stream has already sent its
# 200 by then, so it says it as an SSE `error` frame with this text and no code. EXACTLY this sentence (a text that merely contains it, as a provider's error could, is not it): if a Hermes
# rewords it the frame is dropped as any other `error`, the old behaviour, never worse.
HERMES_QUEUED = 'Hermes is restarting. Your input is saved and will run once when it is back; do not resend it.'


def transform(surface, event, data, redact):
    """6.3 applied to one frame -> (event, data) or None when the event name is not on the allowlist."""
    if surface == 'chat' and event == 'error' and isinstance(data.get('message'), str) and data['message'].strip() == HERMES_QUEUED:
        # Accepted and queued for the next owner: OUR `run.queued` (stable code, our words, never Hermes's), so the person is told "do not send it again" instead of the stream ending with
        # nothing. It keeps the seq of the frame it replaces.
        run_id, seq = data.get('run_id'), data.get('seq')
        frame = {'status': 'queued', 'code': 'run_queued'}
        frame['message'] = RUN_QUEUED
        if isinstance(run_id, str) and 0 < len(run_id) <= 128:
            frame['run_id'] = run_id
        if type(seq) is int:
            frame['seq'] = seq
        return 'run.queued', frame
    if event not in ALLOWED[surface]:
        return None
    if event == 'run.queued':
        run_id = data.get('run_id')
        return event, {'status': 'queued', 'code': 'run_queued', 'message': RUN_QUEUED,
                       **({'run_id': run_id} if isinstance(run_id, str) and 0 < len(run_id) <= 128 else {})}
    out = dict(data)
    if event == 'approval.request' and not out.get('request_id') and isinstance(out.get('prompt_id'), str):
        # Hermes >= v0.22.3 (session authority) names the control `prompt_id` and sends no `request_id`; the rest of LuveBot, the old format and the
        # UI call it `request_id`. Every caller that turns this event into a request (the run watcher, the chat and run proxies) comes through here.
        # `execution_generation` rides along untouched; resolving reads the generation Hermes reports NOW (canonical.py), never this one.
        # A frame that carries BOTH ids keeps its own `request_id` (it is never replaced): a mismatch fails closed, since deciding only acts on a
        # control in the run's own `pending_controls` (canonical.py), so it ends as a refusal, never as the wrong approval.
        out['request_id'] = out['prompt_id']
    if surface == 'chat':
        if event in ('run.completed', 'run.cancelled'):
            out.pop('messages', None)   # the whole turn, tool arguments and raw outputs: not needed by the UI
        if event == 'run.started':
            out.pop('user_message', None)  # the UI holds what it sent; a pasted secret would be echoed
    out = _redact(out, redact)
    args = out.get('args')
    if args is not None and len(json.dumps(args, ensure_ascii=False)) > ARGS_CAP:
        out['args'], out['args_truncated'] = {}, True
    return event, out


def encode(seq, event, data):
    """Every frame we emit has id, event and data (6.0)."""
    return f'id: {seq}\nevent: {event}\ndata: {json.dumps(data, ensure_ascii=False, separators=(",", ":"))}\n\n'.encode()


def ours(seq, event, **fields):
    return encode(seq, event, fields)
