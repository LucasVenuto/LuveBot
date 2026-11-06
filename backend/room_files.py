"""Files in a room (contract plugin-api v0.6, Part C, 9.1 and section 15): a person's message with files.

Hermes's room carries text only (`groups.send`; the room capability `attachments` is false) and every member works in its OWN
profile, so a file goes as ONE copy into EACH recipient Bot's workspace, `attachments/<uuid>-<name>`, the same uuid and name in
every Bot, written by Hermes's own upload writer (pages._write_attachment). The room text then carries one neutral
`[Anexo: attachments/…]` line per file, appended AFTER the person's text was checked for mentions.

All or nothing BEFORE any copy: the files (ADR-005 rules, once each), the caps (25 MiB per send, 100 MiB of files x recipients),
the recipients' gates and every recipient's workspace. A copy that fails midway leaves the audited copies already written and no
text is sent (A-91). The send is recorded here (event_id -> stored names and recipients) so the person's bubble shows its chips
from LuveBot's record, never from the text: an `[Anexo: …]` line a person typed gets no chip.
"""
import json
import sqlite3
import time
import uuid

from . import pages
from .api_errors import PluginError
from . import dbfile

FILES_MAX = 5
SEND_MAX = 25 * 1024 * 1024        # all files of one send together (Q13)
FANOUT_MAX = 100 * 1024 * 1024     # files x recipients per send (section 15, C)
BODY_MAX = SEND_MAX + 64 * 1024    # the multipart body is capped before it is parsed
SCHEMA = """
CREATE TABLE IF NOT EXISTS room_files (
    room_id TEXT NOT NULL, event_id TEXT NOT NULL, files TEXT NOT NULL, created_at REAL NOT NULL, PRIMARY KEY (room_id, event_id)
);
"""


def checked(files):
    """[(filename, bytes)] -> [{stored, name, mime, size, data}]: each file checked ONCE by the ADR-005 rules, nothing written."""
    if len(files) > FILES_MAX:
        raise PluginError('invalid_field', 'Send up to 5 files in one message.', 422)
    if sum(len(data) for _name, data in files) > SEND_MAX:
        raise PluginError('too_large', 'The files of one message are limited to 25 MiB together.', 413)
    items = []
    for filename, data in files:
        name, mime, _original = pages.check_attachment(filename, data)
        items.append({'stored': f'{uuid.uuid4().hex}-{name}', 'name': name, 'mime': mime, 'size': len(data), 'data': data})
    return items


def disk_bytes(items, targets):
    return sum(item['size'] for item in items) * len(targets)


def check_fanout(items, targets):
    total = disk_bytes(items, targets)
    if total > FANOUT_MAX:
        raise PluginError('too_large', 'These files for these Bots add up to more than 100 MiB; send them to fewer Bots.', 413,
                          {'details': {'disk_bytes': total}})


def workspaces(targets):
    """{bot: workspace root} of every recipient, checked before any write; any one not ready refuses the WHOLE send."""
    roots, missing = {}, []
    for target in targets:
        state, root = pages.workspace(target['bot'])
        if state in ('ready', 'empty'):
            roots[target['bot']] = root
        else:
            missing.append({'bot': target['bot'], 'reason': state})
    if missing:
        raise PluginError('workspace_unavailable', 'Some Bots have no working folder for files; nothing was sent.', 409,
                          {'details': {'bots': missing}})
    return roots


def path_of(item):
    return f'{pages.ATTACH_DIR}/{item["stored"]}'


def final_text(stored, items):
    """The person's checked text, then one neutral line per file. The stored name is clean_name's output ([A-Za-z0-9_-] and the
    extension): no '@', so a line can never wake anyone."""
    return '\n'.join([stored, *(pages.reference(path_of(item), item['mime'], item['size']) for item in items)])


def copy_all(audit, actor, items, roots, digests, origin_ref):
    """One audited copy per file per recipient (`attachment.upload`, target `<bot>:<digest>`, the send's origin ref)."""
    for item, digest in zip(items, digests):
        for bot, root in roots.items():
            audit.act(actor, 'attachment.upload', f'{bot}:{digest}', {'kind': 'ui', 'ref': origin_ref},
                      lambda root=root, item=item: pages._write_attachment(root, item['stored'], item['data']),
                      bot=bot, payload={'hmac': digest, 'size': item['size'], 'type': item['mime'], 'name': item['name']})


def view(items, bots):
    return [{'name': item['name'], 'path': path_of(item), 'size': item['size'], 'kind': item['mime'], 'bots': list(bots)} for item in items]


def _connect(path):
    conn = dbfile.connect(path)
    conn.executescript(SCHEMA)
    return conn


def record(path, room_id, event_id, files):
    conn = _connect(path)
    try:
        conn.execute('INSERT OR REPLACE INTO room_files VALUES(?,?,?,?)', (room_id, event_id, json.dumps(files), time.time()))
        conn.commit()
    finally:
        conn.close()


def recorded(path, room_id, event_ids):
    """{event_id: files} of the sends LuveBot recorded among these events."""
    ids = [e for e in event_ids if isinstance(e, str)]
    if not ids:
        return {}
    conn = _connect(path)
    try:
        rows = conn.execute(f'SELECT event_id, files FROM room_files WHERE room_id=? AND event_id IN ({",".join("?" * len(ids))})',
                            (room_id, *ids)).fetchall()
    finally:
        conn.close()
    return {event_id: json.loads(files) for event_id, files in rows}


def annotate(events, members, sends):
    """The log as the UI needs it, decided on the server: a person's message gets `attachments` from LuveBot's record of that send
    (never from its text), and a member's message gets `author_bot`, the profile of the member that SENT it (Hermes's actor:
    member_id, or the profile field), never a name in the text (A-90). An actor that matches no member gets None."""
    by_id = {m['member_id']: m['bot'] for m in members if m.get('member_id')}
    bots = {m['bot'] for m in members}
    out = []
    for event in events:
        if not isinstance(event, dict):
            continue
        actor = event.get('actor') if isinstance(event.get('actor'), dict) else {}
        if event.get('kind') == 'message.user' and event.get('event_id') in sends:
            event = {**event, 'attachments': sends.get(event['event_id'])}
        elif event.get('kind') == 'message.member':
            author = by_id.get(actor.get('id'))
            profile = actor.get('profile')
            if author is None and profile in bots:
                author = profile
            if profile is not None and author is not None and profile != author:
                author = None                                   # the two fields disagree: no card is fetched
            event = {**event, 'author_bot': author}
        out.append(event)
    return out
