"""SSE relay rules (contract section 6): parse Hermes frames, drop unknown ones, apply the 6.3 changes, frame ours.

Pure: no I/O, no Hermes imports. The caller passes the redactor. Frame text is DATA for the browser, never an
instruction; this module only removes or masks, it never interprets.
"""
import json

RUN_EVENTS = {'message.delta', 'reasoning.available', 'message.interim', 'tool.started', 'tool.completed',
              'approval.request', 'run.completed', 'run.cancelled'}
CHAT_EVENTS = {'run.started', 'message.started', 'assistant.delta', 'tool.progress', 'assistant.commentary',
               'tool.started', 'tool.completed', 'tool.failed', 'approval.request', 'assistant.completed',
               'run.completed', 'run.cancelled', 'done'}
# Documented upstream but never observed (6.1/6.2, [D]): allowed through, the UI tolerates their absence.
DOCUMENTED = {'subagent.start', 'subagent.complete', 'run.failed'}
ALLOWED = {'run': RUN_EVENTS | DOCUMENTED, 'chat': CHAT_EVENTS | DOCUMENTED}
TERMINAL = {'run.completed': 'completed', 'run.cancelled': 'cancelled', 'run.failed': 'completed'}
# ponytail: run.failed has no observed frame; it ends the stream "completed" and the frame itself says it failed.
ARGS_CAP = 4096
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


def transform(surface, event, data, redact):
    """6.3 applied to one frame -> (event, data) or None when the event name is not on the allowlist."""
    if event not in ALLOWED[surface]:
        return None
    out = dict(data)
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
