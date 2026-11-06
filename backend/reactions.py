"""Reactions (contract plugin-api v0.8, section 4, direction B): a person's mark on a message, kept by HERMES in the message row
(`SessionDB.set_message_reaction`, hermes_state_messages.py#L546), so its app shows it too. Assumed exception to invariant 4: a storage
call in process, never SQL or a file, until Hermes offers an HTTP route.

* Always `author="user"`: Hermes accepts only `user` and `agent` and announces only `user`. WHO reacted lives in LuveBot's audit
  (`message.react`), not in Hermes's record; one slot per message for everybody.
* The emoji is the only free text that could reach a model (Hermes puts it raw into the input when it announces), so it is checked
  against a closed list by exact equality on every write (anything else 404, nothing written) and shaped on every read.
* PUT is idempotent (Hermes toggles off on the same emoji, so we read first); DELETE clears only the reaction it names.
* The Bot is told (RX-1, voice-language-reactions-v0 section 4, A-282, A-283): `with_announcements` wraps a send, and only with Hermes's own `display.message_reactions` on, in front of the person's text it puts Hermes's note for each
  reaction made since the last turn, only for the closed set, five at most, the snippet redacted whole, neutralised, then cut. A failed send puts the reactions back. `set_bot_sees` is the per-Bot switch.
"""
import json
import re
import threading
import unicodedata

from .api_errors import PluginError
from .audit import ActionDenied, AuditUnavailable

EMOJIS = ('\U0001F44D', '\U0001F44E', '\u2764\uFE0F', '\U0001F525', '\U0001F389', '\U0001F44F', '\U0001F64F', '\U0001F4AA', '\u2705', '\u274C', '\u2B50', '\U0001F4A1', '\U0001F440', '\U0001F914', '\U0001F642', '\U0001F604', '\U0001F602', '\U0001F60D', '\U0001F62E', '\U0001F622', '\U0001F621', '\U0001F680', '\U0001F4AF', '\U0001F91D')   # 👍 👎 ❤️ 🔥 🎉 👏 🙏 💪 ✅ ❌ ⭐ 💡 👀 🤔 🙂 😄 😂 😍 😮 😢 😡 🚀 💯 🤝
AUTHORS = ('user', 'agent')
NEEDED = ('set_message_reaction', 'get_message_reactions', 'get_message_role')
ANNOUNCES = NEEDED + ('take_unseen_reactions',)   # what telling the Bot needs of Hermes's SessionDB as well
DOT = '·'
MAX_EMOJI = 16
# ponytail: process lock around read-then-write; the dashboard is one process (invariant 3). Hermes's own writer is the other writer.
LOCK = threading.Lock()


def check_emoji(value):
    if not isinstance(value, str) or value not in EMOJIS:
        raise PluginError('reaction_not_found', 'Unknown reaction.', 404)
    return value


def row_id(text):
    """The durable row id of Hermes's message. Anything that is not one (a live message with no id yet) is "not saved"."""
    if not isinstance(text, str) or not re.fullmatch(r'[0-9]{1,15}', text) or int(text) < 1:
        raise PluginError('message_not_saved', 'This message is not saved yet.', 409)
    return int(text)


def capable():
    """`features.reactions`: Hermes's SessionDB has the writer, the reader and the role lookup this module calls."""
    try:
        from hermes_state import SessionDB
    except Exception:  # noqa: BLE001
        return False
    return all(callable(getattr(SessionDB, name, None)) for name in NEEDED)


def need_capability():
    if not capable():
        raise PluginError('capability_missing', 'This Hermes cannot keep reactions.', 409, {'feature': 'reactions'})


def _one_emoji(value):
    """A short run of symbols, joiners and selectors: no letter, digit, space, control, bracket or quote."""
    if not isinstance(value, str) or not 0 < len(value) <= MAX_EMOJI:
        return False
    for char in value:
        kind = unicodedata.category(char)
        if not (kind in ('So', 'Sk') or char in ('‍', '️', '︎', '⃣')):
            return False
    return True


def views(raw, redact):
    """`[{emoji, author}]` from a message's display_metadata (a dict or its JSON): only `user` and `agent`; an emoji outside the closed
    list only when it is one short emoji, else a neutral dot. Redacted; whatever else is in the record never leaves."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return []
    found = raw.get('reactions') if isinstance(raw, dict) else raw
    out = []
    for item in found if isinstance(found, list) else ():
        if not isinstance(item, dict) or item.get('author') not in AUTHORS:
            continue
        emoji = item.get('emoji')
        shown = emoji if emoji in EMOJIS or _one_emoji(emoji) else DOT
        out.append({'emoji': shown if redact(shown) == shown else DOT, 'author': item['author']})
    return out


def _user_emoji(reactions):
    for item in reactions if isinstance(reactions, list) else ():
        if isinstance(item, dict) and item.get('author') == 'user':
            return item.get('emoji')
    return None


def _open(bot):
    from hermes_cli.web_server_sessions import _open_session_db_for_profile
    return _open_session_db_for_profile(bot, read_only=False)


def _hermes_failure(error):
    """A locked store is "busy"; anything else is Hermes's. The text of the error never leaves."""
    if type(error).__name__ == 'OperationalError' and 'locked' in str(error).lower():
        return PluginError('hermes_busy', 'Hermes is busy saving; try again.', 503)
    return PluginError('hermes_error', 'Hermes returned an unexpected response.', 502)


def react(bot, session_id, message_row_id, emoji, clear, audit, actor, redact, *, tip):
    """Set (or, with `clear`, remove) the reaction on one message and answer `{reactions: [{emoji, author}]}`. `tip` is the resume tip
    of `session_id` (404 already checked): the message is looked for in it and in the id the person knows."""
    with LOCK:
        try:
            db = _open(bot)
        except Exception as error:  # noqa: BLE001
            raise _hermes_failure(error) from None
        try:
            physical = next((s for s in dict.fromkeys((tip, session_id)) if db.get_message_role(s, message_row_id) in ('user', 'assistant')), None)
            if physical is None:
                raise PluginError('message_not_found', 'Message not found.', 404)
            current = db.get_message_reactions(physical, message_row_id)
            stored = _user_emoji(current)
            if (stored != emoji) if clear else (stored == emoji):  # already as asked: Hermes would toggle it OFF, so write nothing
                return {'reactions': views(current, redact)}

            def effect():
                want = None if clear else emoji
                for _ in range(2):  # Hermes's own app writes the same slot (and toggles the same emoji off): check what it kept, fix ONCE
                    result = db.set_message_reaction(physical, message_row_id, want, author='user')
                    if result is None:
                        raise PluginError('message_not_found', 'Message not found.', 404)
                    if _user_emoji(result) == want:
                        break
                return result
            result = audit.act(actor, 'message.react', f'{session_id}:{message_row_id}', {'kind': 'ui'}, effect, bot=bot,
                               payload={'row_id': message_row_id, 'emoji': emoji, 'op': 'clear' if clear else 'set'})
            return {'reactions': views(result, redact)}
        except (PluginError, ActionDenied, AuditUnavailable):  # ours (the audit refused, or a 404 from the effect): as they are
            raise
        except Exception as error:  # noqa: BLE001
            raise _hermes_failure(error) from None
        finally:
            db.close()


# ---- RX-1: the Bot is told (voice-language-reactions-v0.md section 4 item 3, A-283) ----------------------------------------------------------------------------------------
NOTES_MAX, SNIPPET_MAX, ELLIPSIS = 5, 120, chr(0x2026)


def _hermes_config(bot):
    from .voice import HermesAudio
    return HermesAudio.config(bot)        # the Bot's configuration as Hermes reads it, in the Bot's profile: the default profile never answers for a Bot


def is_on(config):
    """On only when `display.message_reactions` is the boolean True (A-283 a): absent, False, None, a string, a `display` that is not a mapping are off, although Hermes reads the key with `bool()` (a string "false" is on there): we fail closed."""
    display = config.get('display') if isinstance(config, dict) else None
    return isinstance(display, dict) and display.get('message_reactions') is True


def enabled(bot):
    try:
        return is_on(_hermes_config(bot))
    except Exception:  # noqa: BLE001  (an unreadable configuration is off, and Hermes is then never asked: asking consumes)
        return False


def neutral(text):
    """The snippet of a note is data from a message of the conversation: no `"`, `[` or `]` (it cannot close a note or open a forged one), no control, format, line or paragraph separator and no space but the plain one."""
    out = ''.join(' ' if unicodedata.category(c) in ('Cc', 'Cf', 'Zl', 'Zp', 'Zs') else "'" if c == '"' else '(' if c == '[' else ')' if c == ']' else c for c in text)
    return out.strip()


def note(entry, redact):
    """Hermes's own wording (tui_gateway/methods_prompt.py#L204-L234): `[The user reacted E to their own|your message: "snippet"]`, `earlier message` when there is nothing to quote. The snippet is the redacted WHOLE message (never a window: a key block cut in half
    escapes the redactor), then neutralised, then cut at 120 characters plus one ellipsis."""
    text = entry.get('text')
    snippet = neutral(redact(text) if isinstance(text, str) and text else '')
    snippet = snippet[:SNIPPET_MAX] + ELLIPSIS if len(snippet) > SNIPPET_MAX else snippet
    return '[The user reacted %s to %s %s]' % (entry['emoji'], 'their own' if entry.get('role') == 'user' else 'your', 'message: "%s"' % snippet if snippet else 'earlier message')


def compose(notes, text):
    """The ONE place the notes meet the person's text (RX-4 measures whether Hermes keeps a note in the stored message; if it does, this is what moves, to `instructions` or to a hidden leading block)."""
    return '\n'.join(notes) + '\n\n' + text if notes else text


def _mine(db, session, entry):
    current = db.get_message_reactions(session, entry['row_id'])
    return next((r for r in current if isinstance(r, dict) and r.get('author') == 'user'), None)


def rearm(bot, entries):
    """Hermes marked every reaction seen when it was read; one that was not announced (a sixth, or the whole turn when the send failed) is made unseen again: clear, then set, and ONLY while it is still the person's current mark and still seen (one the person changed, cleared or set
    again meanwhile is left as they have it: writing the same emoji over a mark toggles it OFF). A set that fails after the clear is tried once more. -> how many could not be put back (a number: the caller counts it, never says which)."""
    failed = 0
    with LOCK:
        try:
            db = _open(bot)
        except Exception:  # noqa: BLE001
            return len(entries)
        try:
            for entry in entries:
                session = entry['session']
                try:
                    mine = _mine(db, session, entry)
                    if not (mine and mine.get('emoji') == entry['emoji'] and mine.get('seen')):
                        continue
                    db.set_message_reaction(session, entry['row_id'], None, author='user')
                except Exception:  # noqa: BLE001
                    failed += 1
                    continue
                for attempt in range(2):
                    try:
                        db.set_message_reaction(session, entry['row_id'], entry['emoji'], author='user')
                        break
                    except Exception:  # noqa: BLE001
                        failed += attempt
        finally:
            db.close()
    return failed


def _unseen(bot, sessions):
    """What the person reacted since the last turn, oldest row first, only an emoji of the closed set (anything else is taken and dropped: it does not use up the five, and Hermes's own app will not announce what we took). A read that fails sends nothing and consumed nothing."""
    try:
        db = _open(bot)
    except Exception:  # noqa: BLE001
        return []
    found = []
    try:
        for session in sessions:
            for entry in db.take_unseen_reactions(session, author='user'):
                if isinstance(entry, dict) and isinstance(entry.get('emoji'), str) and entry['emoji'] in EMOJIS and type(entry.get('row_id')) is int:
                    found.append({**entry, 'session': session})
    except Exception:  # noqa: BLE001  (a locked store, or the second conversation of two failed after the first was read: what was taken is put back)
        taken, found = found, []
    else:
        taken = []
    finally:
        db.close()
    if taken:
        rearm(bot, taken)
    return sorted(found, key=lambda e: e['row_id'])


def with_announcements(bot, session_id, text, send, audit, actor, redact, *, tip=None):
    """Runs `send(text)` and answers what it answers; with the Bot's switch on, `send` gets the notes in front of the text instead. `tip` is the resume tip of the conversation, or a function that finds it (a mark made on a compressed session lives under it).
    The audit row of the notes holds their number, never the emoji or a snippet. A send that fails (an exception: Hermes did not accept the run) puts the reactions it announced back, and the error is the send's own, never the re-arm's."""
    if not enabled(bot):
        return send(text)
    sessions = list(dict.fromkeys(s for s in (tip() if callable(tip) else tip, session_id) if s))     # a tip that is a function is asked only when the switch is on
    shown = _unseen(bot, sessions)
    now, later = shown[:NOTES_MAX], shown[NOTES_MAX:]
    if later:
        rearm(bot, later)
    if not now:
        return send(text)
    try:
        audit.act(actor, 'reactions.announce', session_id, {'kind': 'ui'}, lambda: None, bot=bot, payload={'notes': len(now)})
        return send(compose([note(entry, redact) for entry in now], text))
    except BaseException:
        failed = rearm(bot, now)
        if failed:
            try:
                audit.act(actor, 'reactions.rearm', session_id, {'kind': 'ui'}, lambda: None, bot=bot, payload={'rearm_failed': failed})
            except Exception:  # noqa: BLE001  (the error of the send is the one that matters)
                pass
        raise


# ---- RX-1: the per-Bot switch (A-282) --------------------------------------------------------------------------------------------------------------------------------------
def announces():
    """`reactions.bot_sees` of GET /bots/{bot} exists only for a Hermes that can announce."""
    try:
        from hermes_state import SessionDB
    except Exception:  # noqa: BLE001
        return False
    return all(callable(getattr(SessionDB, name, None)) for name in ANNOUNCES)


def bot_sees(bot):
    """{'bot_sees': boolean}, or None when it cannot be told (a Hermes without `take_unseen_reactions`, or an unreadable configuration): the object is then ABSENT and the screen shows the switch off and unavailable, never on."""
    if not announces():
        return None
    try:
        return {'bot_sees': is_on(_hermes_config(bot))}
    except Exception:  # noqa: BLE001
        return None


def switch_body(body):
    """EXACTLY {"enabled": true | false}: nothing else of the configuration can be sent (1, 0 and 1.0 are not booleans)."""
    if not isinstance(body, dict):
        raise PluginError('bad_request', 'Malformed request body.', 400)
    if set(body) != {'enabled'} or type(body['enabled']) is not bool:
        raise PluginError('invalid_field', 'Send {"enabled": true} or {"enabled": false}.', 422)
    return body['enabled']


def set_bot_sees(audit, actor, bot, enabled_, ref):
    """PUT /bots/{bot}/reactions/bot-sees: audited FIRST (`reactions.bot_sees`, the two booleans), written by Hermes's own `update_config` in the Bot's profile (only `display.message_reactions`), read back with Hermes's reader: a value that did not stick is a 502. Hermes's text never leaves."""
    from .voice import HermesAudio
    from . import hermes_boundary
    try:
        before = is_on(_hermes_config(bot))
    except Exception:  # noqa: BLE001
        raise PluginError('hermes_error', 'Hermes could not read this setting.', 502) from None

    def effect():
        try:
            HermesAudio.write_config(bot, {'display': {'message_reactions': enabled_}})
        except Exception as error:  # noqa: BLE001
            if hermes_boundary.config_write_refusal(error) is not None:
                raise  # a write Hermes's config backend refused (a lock above, an invalid value): SafeRoute says which, with our words
            raise PluginError('hermes_error', 'Hermes could not change this setting.', 502) from None
        try:
            kept = is_on(_hermes_config(bot))
        except Exception:  # noqa: BLE001
            raise PluginError('hermes_error', 'Hermes could not change this setting.', 502) from None
        if kept != enabled_:
            raise PluginError('hermes_error', 'Hermes did not keep this setting.', 502)

    audit.act(actor, 'reactions.bot_sees', bot, {'kind': 'ui', 'ref': ref}, effect, bot=bot, payload={'before': before, 'after': enabled_})
    return {'reactions': {'bot_sees': enabled_}}
