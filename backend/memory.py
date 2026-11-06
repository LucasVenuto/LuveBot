"""Contract v0.8 section 1: a Bot's memory, item by item. Every read and write goes through Hermes's own `MemoryStore`
(tools/memory_tool.py load_on_disk_store at f8489405) in the Bot's profile scope; LuveBot never opens MEMORY.md or USER.md
(invariant 4). An entry is addressed by the first 16 hex of its SHA-256 and written with `matched_entry` pinned to the exact
entry found in a fresh read, so a concurrent change is refused by Hermes, never guessed. The browser never gets an unredacted
entry, and Hermes's text (it can quote an entry) never leaves (invariant 1)."""
import hashlib

from . import identity
from .api_errors import PluginError

TARGETS = ('memory', 'user')
MAX_TEXT = 2000
TITLES = {'memory': 'Notas do Bot', 'user': 'Perfil da pessoa'}


class HermesMemory:
    """Hermes's store, loaded fresh in the Bot's profile scope for every operation (its own non-agent writers do the same)."""

    @staticmethod
    def run(bot, fn):
        from hermes_cli.web_server_profiles import _config_profile_scope
        from tools.memory_tool import load_on_disk_store
        with _config_profile_scope(bot):
            return fn(load_on_disk_store())

    @staticmethod
    def scan(text):
        from tools.memory_tool_store import _scan_memory_content
        return _scan_memory_content(text)

    @staticmethod
    def delimiter():
        from tools.memory_tool_store import ENTRY_DELIMITER
        return ENTRY_DELIMITER

    @staticmethod
    def provider(bot):
        """The name of an external memory provider configured for the Bot, or None (only the built-in files are editable)."""
        from hermes_cli.web_server_profiles import _config_profile_scope
        from tools.memory_tool import get_builtin_memory_config
        with _config_profile_scope(bot):
            name = get_builtin_memory_config().get('provider')
        return name if isinstance(name, str) and name.strip() and name.strip().lower() not in ('builtin', 'none') else None


def entry_id(entry):
    return hashlib.sha256(entry.encode('utf-8')).hexdigest()[:16]


def target_of(value):
    if value not in TARGETS:
        raise PluginError('memory_target_not_found', 'Memory target not found.', 404)
    return value


def text_of(body):
    if not isinstance(body, dict) or set(body) != {'text'}:
        raise PluginError('bad_request', 'Malformed request body.', 400)
    text = body['text']
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
        raise PluginError('invalid_field', 'text must have 1 to 2,000 characters.', 422)
    return text.strip()


def _human_only(mode):
    """A write puts text into every future prompt of the Bot: in loopback an agent cannot be told from a person (A-105)."""
    identity.require_person(mode, 'Writing a Bot\'s memory needs a dashboard with a login; this one is in loopback mode.')


def _read(hermes, bot):
    """{target: (enabled, limit, entries)} from a fresh store."""
    def read(store):
        return {'memory': (store.target_enabled('memory'), store.memory_char_limit, list(store.memory_entries)),
                'user': (store.target_enabled('user'), store.user_char_limit, list(store.user_entries))}
    return hermes.run(bot, read)


def view(hermes, bot, redact):
    """GET /bots/{bot}/memory."""
    delimiter, targets = hermes.delimiter(), {}
    for target, (enabled, limit, entries) in _read(hermes, bot).items():
        shown = []
        for entry in entries if enabled else []:
            text = redact(entry)
            shown.append({'id': entry_id(entry), 'text': text, 'redacted': text != entry})
        targets[target] = {'enabled': bool(enabled), 'limit': int(limit), 'used': len(delimiter.join(entries)) if enabled else 0,
                           'entries': shown}
    try:
        provider = hermes.provider(bot)
    except Exception:
        provider = None
    return {'targets': targets, 'provider': provider, 'notice': 'applies_to_new_conversations'}


def _entry(hermes, bot, target, eid):
    enabled, _limit, entries = _read(hermes, bot)[target]
    found = next((e for e in entries if entry_id(e) == eid), None) if enabled else None
    if found is None:
        raise PluginError('memory_entry_not_found', 'This memory item was not found.', 404)
    return found


def _enabled(hermes, bot, target):
    if not _read(hermes, bot)[target][0]:
        raise PluginError('memory_disabled', 'This memory is turned off for this Bot in Hermes.', 409)


def _scanned(hermes, text):
    if hermes.scan(text):
        raise PluginError('memory_refused', 'Hermes refused this text for memory (it looks like an instruction or a leak).', 422)


def _check(result, hermes, bot, target, pinned=None):
    """Hermes's answer -> nothing or our static error. Its own text is never forwarded."""
    if isinstance(result, dict) and result.get('success') is True:
        return result
    if isinstance(result, dict) and 'current_entries' in result:
        raise PluginError('memory_full', 'This memory is full; remove or shorten an item first.', 422)
    if pinned is not None and pinned not in _read(hermes, bot)[target][2]:
        raise PluginError('memory_changed', 'This item changed meanwhile; reload and try again.', 409)
    if isinstance(result, dict) and 'drift_backup' in result:
        raise PluginError('memory_changed', 'The memory file was changed outside Hermes; reload and try again.', 409)
    raise PluginError('hermes_error', 'Hermes could not change this memory.', 502)


def add(audit, hermes, keyed, actor, mode, bot, target, text, ref):
    _human_only(mode)
    _enabled(hermes, bot, target)
    _scanned(hermes, text)
    audit.act(actor, 'memory.add', f'{bot}:{target}', {'kind': 'ui', 'ref': ref},
              lambda: _check(hermes.run(bot, lambda store: store.add(target, text)), hermes, bot, target),
              bot=bot, payload={'hmac': keyed(text.encode()), 'chars': len(text)})
    return {'id': entry_id(text)}


def replace(audit, hermes, keyed, redact, actor, mode, bot, target, eid, text, ref):
    _human_only(mode)
    pinned = _entry(hermes, bot, target, eid)
    if redact(pinned) != pinned:
        raise PluginError('memory_redacted', 'This item holds hidden text; remove it instead of editing it.', 409)
    _scanned(hermes, text)
    audit.act(actor, 'memory.replace', f'{bot}:{target}', {'kind': 'ui', 'ref': ref},
              lambda: _check(hermes.run(bot, lambda store: store.replace(target, pinned, text, matched_entry=pinned)), hermes, bot, target, pinned),
              bot=bot, payload={'id': eid, 'hmac': keyed(text.encode()), 'chars': len(text)})
    return {'id': entry_id(text)}


def remove(audit, hermes, actor, bot, target, eid, ref):
    pinned = _entry(hermes, bot, target, eid)
    audit.act(actor, 'memory.remove', f'{bot}:{target}', {'kind': 'ui', 'ref': ref},
              lambda: _check(hermes.run(bot, lambda store: store.remove(target, pinned, matched_entry=pinned)), hermes, bot, target, pinned),
              bot=bot, payload={'id': eid})
    return {'removed': 1}


def clear(audit, hermes, actor, bot, target, confirm, ref):
    """One single remove per entry, in order: Hermes refuses a batch that empties a store and names single removes as the deliberate
    wipe. Not atomic: an entry that changed meanwhile is skipped and counted, never guessed."""
    if confirm != 'all':
        raise PluginError('bad_request', 'Clearing needs confirm=all.', 400)
    entries = _read(hermes, bot)[target][2]

    def effect():
        def each(store):
            removed = skipped = 0
            for entry in entries:
                if store.remove(target, entry, matched_entry=entry).get('success') is True:
                    removed += 1
                else:
                    skipped += 1
            return {'removed': removed, 'skipped': skipped}
        return hermes.run(bot, each)

    return audit.act(actor, 'memory.clear', f'{bot}:{target}', {'kind': 'ui', 'ref': ref}, effect, bot=bot,
                     payload={'count': len(entries)})


def export(hermes, bot, redact):
    """GET /bots/{bot}/memory/export: both targets as Markdown, redacted."""
    lines = [f'# Memória de {bot}', '']
    for target, (enabled, _limit, entries) in _read(hermes, bot).items():
        lines += [f'## {TITLES[target]}', '']
        if not enabled:
            lines += ['(desligada no Hermes)', '']
            continue
        lines += [f'- {redact(e).replace(chr(10), chr(10) + "  ")}' for e in entries] or ['(vazia)']
        lines.append('')
    return '\n'.join(lines)
