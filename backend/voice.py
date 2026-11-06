"""Contract v0.7: Voice (Radio and the Bot's voice status). Everything goes through Hermes's own audio handlers in process, with
`profile=<bot>` (hermes_cli/web_routers/audio.py at f8489405); LuveBot keeps no audio and no transcript (A-98). A Hermes or vendor
detail never leaves: every failure is the same static `voice_unavailable` (invariant 1). Voice never decides for a person: a
transcription is only text the browser sends as a normal turn (invariant 6)."""
import asyncio
import base64
import binascii
from contextlib import contextmanager
import hashlib
import importlib
import math
import re
import sqlite3
import threading
import time
import uuid

from .api_errors import PluginError
from . import dbfile, hermes_boundary

UPLOAD_MIMES = ('audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav')
SPEAK_MIMES = ('audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4')
MAX_UPLOAD = 5 * 1024 * 1024  # A-102
MAX_SPEAK = 4000              # A-102
MAX_TEXT = 10000
CENTS_PER_MINUTE = 5          # A-100
MAX_SECONDS = 900             # A-102
MAX_DELEGATIONS = 6           # A-102
_PROVIDER = re.compile(r'[a-z0-9][a-z0-9_.-]{0,31}')
LANGUAGES = ('pt', 'en', 'auto')                                   # VL-1 (the voice language contract, section 2): what the person may choose
VOICES = {'pt': 'pt-BR-FranciscaNeural', 'en': 'en-US-AriaNeural'}  # the Bot's two default voices of the Edge provider: the only ones that follow the language
SHOWN = 200                                                        # the longest raw setting the status shows
_CONFIG_READ = threading.Lock()                                    # one reader of a Bot's configuration at a time (the profile scope is Hermes's; a reader that is not per-thread must not see another Bot's file)


def unavailable(step):
    return PluginError('voice_unavailable', 'Voice is unavailable right now. Try again later.', 502, {'details': {'step': step}})


def upload_mime(content_type):
    """The recording's type from Content-Type (`;codecs=…` allowed), or 415."""
    mime = (content_type or '').split(';', 1)[0].strip().lower()
    if mime not in UPLOAD_MIMES:
        raise PluginError('unsupported_media', 'Send the recording as WebM, Ogg, MP4, MPEG or WAV audio.', 415)
    return mime


def upload_length(header):
    """Content-Length, checked before the body is read: 411 without it, 413 over 5 MiB, 400 when empty."""
    try:
        length = int(header or '')
    except ValueError:
        raise PluginError('length_required', 'Send the recording with a Content-Length.', 411) from None
    if length > MAX_UPLOAD:
        raise PluginError('too_large', 'A recording is limited to 5 MB.', 413)
    if length <= 0:
        raise PluginError('bad_request', 'The recording is empty.', 400)
    return length


def _provider(value):
    value = value.strip().lower() if isinstance(value, str) else ''
    return value if _PROVIDER.fullmatch(value) else None


class HermesAudio:
    """Hermes's own handlers, called in process (this thread has no running loop, as in bots.py/pages.py)."""

    @staticmethod
    def routes():
        try:  # import_module, not `from … import`: it honours a module that is missing (None in sys.modules)
            web_models = importlib.import_module('hermes_cli.web_models')
            audio = importlib.import_module('hermes_cli.web_routers.audio')
        except Exception:
            return set()
        names = {'transcribe': ('transcribe_audio_upload', 'AudioTranscriptionRequest'),
                 'speak': ('speak_text', 'TTSSpeakRequest'),
                 'live_status': ('get_voice_live_status', None),
                 'live_session': ('create_voice_live_session', 'VoiceLiveSessionRequest')}
        return {key for key, (handler, model) in names.items()
                if callable(getattr(audio, handler, None)) and (model is None or hasattr(web_models, model))}

    @staticmethod
    def transcribe(data, mime, bot):
        from hermes_cli.web_models import AudioTranscriptionRequest
        from hermes_cli.web_routers.audio import transcribe_audio_upload
        url = f'data:{mime};base64,' + base64.b64encode(data).decode('ascii')
        return asyncio.run(transcribe_audio_upload(AudioTranscriptionRequest(data_url=url, mime_type=mime), profile=bot))

    @staticmethod
    def speak(text, bot):
        from hermes_cli.web_models import TTSSpeakRequest
        from hermes_cli.web_routers.audio import speak_text
        return asyncio.run(speak_text(TTSSpeakRequest(text=text), profile=bot))

    @staticmethod
    def live_status(bot):
        from hermes_cli.web_routers.audio import get_voice_live_status
        return asyncio.run(get_voice_live_status(profile=bot))

    @staticmethod
    def live_session(sdp, bot):
        from hermes_cli.web_models import VoiceLiveSessionRequest
        from hermes_cli.web_routers.audio import create_voice_live_session
        return asyncio.run(create_voice_live_session(VoiceLiveSessionRequest(sdp=sdp, history=None), profile=bot))

    @staticmethod
    def turn_note(context):
        from tools.voice_live import voice_live_turn_note
        return voice_live_turn_note(context)

    @staticmethod
    def client_direct_off(bot):
        """V6: Hermes's own PUT /api/config handler (config_env.py update_config: a strict read, then a deep merge of this one key
        under its config lock), ALWAYS with the Bot's profile (without it Hermes writes the default profile's file)."""
        from hermes_cli.web_models import ConfigUpdate
        from hermes_cli.web_routers.config_env import update_config
        return asyncio.run(update_config(ConfigUpdate(config={'voice': {'client_direct': False}}, profile=bot), profile=bot))

    @staticmethod
    def client_direct(bot):
        from hermes_cli.web_server_profiles import _config_profile_scope
        from tools.voice_client_config import _client_direct_enabled
        with _config_profile_scope(bot):
            return _client_direct_enabled()

    @staticmethod
    def config(bot):
        """VL-1: the Bot's configuration as Hermes reads it, in the Bot's profile (a read: nothing is written, and only the listed keys ever leave `settings_view`)."""
        from hermes_cli.config import load_config
        from hermes_cli.web_server_profiles import _config_profile_scope
        with _CONFIG_READ, _config_profile_scope(bot):
            return load_config()

    @staticmethod
    def write_config(bot, patch):
        """VL-1: Hermes's own PUT /api/config handler (a strict read, a deep merge of `patch` under its config lock), ALWAYS with the Bot's profile (without it Hermes writes the default profile's file)."""
        from hermes_cli.web_models import ConfigUpdate
        from hermes_cli.web_routers.config_env import update_config
        return asyncio.run(update_config(ConfigUpdate(config=patch, profile=bot), profile=bot))


def status(hermes, bot, gate_reason, redact=None):
    """GET /bots/{bot}/voice (3.1). `gate_reason()` -> None | 'bot_paused' | 'budget' (the start gate, no reservation). Hermes's
    own `reason` text is never forwarded; a status that cannot be read is no call (fail closed). With `redact`, `settings` (VL-1) is
    the language, the STT provider and the TTS provider and voice of the Bot; it is ABSENT when the configuration cannot be read."""
    routes = hermes.routes()
    radio_ok = {'transcribe', 'speak'} <= routes
    reason = None
    if not radio_ok or not {'live_status', 'live_session'} <= routes:
        reason = 'hermes_audio_missing'
    else:
        try:
            live = hermes.live_status(bot)
        except Exception:
            live = None
        if not isinstance(live, dict):
            reason = 'hermes_audio_missing'
        elif live.get('available') is not True:
            reason = 'no_openai_key'
        else:
            reason = gate_reason()
    try:
        direct = hermes.client_direct(bot) is not False
    except Exception:
        direct = True  # unknown: show the warning rather than hide it
    view = {'radio': {'available': radio_ok, 'reason': None if radio_ok else 'hermes_audio_missing'},
            'call': {'available': reason is None, 'reason': reason, 'cents_per_minute': CENTS_PER_MINUTE,
                     'max_seconds': MAX_SECONDS, 'max_delegations': MAX_DELEGATIONS},
            'client_direct': direct}
    settings = _settings(hermes, bot, redact)
    if settings is not None:
        view['settings'] = settings
    return view


def features(hermes):
    """health.features.voice_radio / voice_call (invariant 9): from the presence of Hermes's handlers."""
    routes = hermes.routes()
    radio = {'transcribe', 'speak'} <= routes
    return {'voice_radio': 'ok' if radio else 'unavailable',
            'voice_call': 'ok' if radio and {'live_status', 'live_session'} <= routes else 'unavailable'}


def transcribe(audit, hermes, actor, bot, data, mime, gate, redact, ref):
    """POST /bots/{bot}/voice/transcribe (2.1). Gate first, then the intent row with only size and type, then Hermes."""
    if not data or len(data) > MAX_UPLOAD:
        raise PluginError('too_large', 'A recording is limited to 5 MB.', 413) if data else \
            PluginError('bad_request', 'The recording is empty.', 400)
    gate()
    took = []

    def effect():
        started = time.perf_counter()
        try:
            result = hermes.transcribe(data, mime, bot)
        except Exception:
            raise unavailable('transcribe') from None
        if not isinstance(result, dict) or not isinstance(result.get('transcript', ''), str):
            raise unavailable('transcribe')
        took.append(int((time.perf_counter() - started) * 1000))
        return result

    result = audit.act(actor, 'voice.transcribe', bot, {'kind': 'ui', 'ref': ref}, effect, bot=bot,
                       payload={'bytes': len(data), 'mime': mime})
    text = redact((result.get('transcript') or '').strip())[:MAX_TEXT]
    timing = {'server_ms': took[0], 'bytes': len(data)}      # VL-1 (A-278): how long Hermes's STT took here, and the size; never text
    try:
        audit.act(actor, 'voice.transcribe.timing', bot, {'kind': 'ui', 'ref': ref}, lambda: None, bot=bot, payload=timing)   # after the effect, so it is a row of its own (the audit keeps the digest of a payload, not the payload)
    except Exception:
        pass  # the transcription is audited above; a number is not worth losing it
    return {'text': text, 'provider': _provider(result.get('provider')), 'timing': timing}


def speak_text(body):
    text = body.get('text') if isinstance(body, dict) else None
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_SPEAK:
        raise PluginError('bad_request', 'Send the text to speak (up to 4,000 characters).', 400)
    return text


def speak(audit, hermes, actor, bot, text, gate, redact, ref):
    """POST /bots/{bot}/voice/speak (2.2) -> (audio bytes, mime). The text is redacted BEFORE it reaches the TTS provider."""
    spoken = redact(text).strip()
    gate()

    def effect():
        try:
            result = hermes.speak(spoken, bot)
        except Exception:
            raise unavailable('speak') from None
        mime = result.get('mime_type') if isinstance(result, dict) else None
        url = result.get('data_url') if isinstance(result, dict) else None
        if mime not in SPEAK_MIMES or not isinstance(url, str) or not url.startswith(f'data:{mime};base64,'):
            raise unavailable('speak')
        try:
            audio = base64.b64decode(url.split(',', 1)[1], validate=True)
        except (binascii.Error, ValueError):
            raise unavailable('speak') from None
        if not audio:
            raise unavailable('speak')
        return audio, mime

    return audit.act(actor, 'voice.speak', bot, {'kind': 'ui', 'ref': ref}, effect, bot=bot, payload={'chars': len(spoken)})


# ---- V6: turn off Hermes's client-direct voice config (it hands provider keys to any client that asks; LuveBot never does) -----
def client_direct_body(body):
    """Only {"enabled": false}: turning it ON again would loosen a control, and LuveBot does not offer that."""
    if not isinstance(body, dict) or set(body) != {'enabled'}:
        raise PluginError('bad_request', 'Malformed request body.', 400)
    if body['enabled'] is not False:
        raise PluginError('invalid_field', 'Only turning it off is supported here.', 422)
    return False


def client_direct_off(audit, hermes, actor, bot, ref):
    """Audited first (tightening, so loopback may do it as well, A-103), written by Hermes in the Bot's profile, then re-read with
    Hermes's own reader: a value that did not stick is a 502, never a claimed success. Hermes's text never leaves."""
    before = hermes.client_direct(bot) is not False

    def effect():
        try:
            hermes.client_direct_off(bot)
        except Exception as error:
            if hermes_boundary.config_write_refusal(error) is not None:
                raise  # a write Hermes's config backend refused (a lock above, an invalid value): SafeRoute says which, with our words
            raise PluginError('hermes_error', 'Hermes could not change this setting.', 502) from None

    audit.act(actor, 'voice.client_direct.set', bot, {'kind': 'ui', 'ref': ref}, effect, bot=bot, payload={'from': before, 'to': False})
    if hermes.client_direct(bot) is not False:
        raise PluginError('hermes_error', 'Hermes did not keep this setting.', 502)
    return {'client_direct': False}


# ---- VL-1: the language of the Radio (the voice language contract, section 2; A-277, A-281) ------------------------------------
# Hermes's two audio routes take no language and no voice: the only lever is the Bot's own configuration, written through Hermes's official write.
def language_value(value):
    if not isinstance(value, str) or value not in LANGUAGES:
        raise PluginError('invalid_field', 'Use "pt", "en" or "auto".', 422)    # never the value back
    return value


def language_body(body):
    """PUT /bots/{bot}/voice/language: EXACTLY {"language": "pt" | "en" | "auto"}; nothing else of the configuration can be sent."""
    if not isinstance(body, dict) or set(body) != {'language'}:
        raise PluginError('bad_request', 'Malformed request body.', 400)
    return language_value(body['language'])


def language_word(value):
    """What a raw `stt.language` is called in the status and in the audit: pt, en, auto (empty or unset: the provider detects) or other (a value the person set in Hermes, say fr: read only, never the raw value in the audit)."""
    return value if value in ('pt', 'en') else 'auto' if value in ('', None) else 'other'


def _section(config, key):
    value = config.get(key) if isinstance(config, dict) else None
    return value if isinstance(value, dict) else {}


def _word(config):
    return language_word(_section(config, 'stt').get('language'))


def _shown(value, redact):
    return redact(value)[:SHOWN] if isinstance(value, str) else None    # redacted first, then cut: a key must not be cut into a piece the redactor no longer knows


def settings_view(config, redact):
    """The listed keys and no others (no api_key, no voice id, nothing under a provider but the voice): {stt: {provider, language}, tts: {provider, voice}, language}."""
    stt, tts = _section(config, 'stt'), _section(config, 'tts')
    provider = tts.get('provider') if isinstance(tts.get('provider'), str) and tts.get('provider') else 'edge'     # Hermes's default provider
    return {'stt': {'provider': _shown(stt.get('provider'), redact), 'language': _shown(stt.get('language'), redact)},
            'tts': {'provider': _shown(provider, redact), 'voice': _shown(_section(tts, provider).get('voice'), redact)},
            'language': language_word(stt.get('language'))}


def _settings(hermes, bot, redact):
    read = getattr(hermes, 'config', None)
    if redact is None or read is None:
        return None
    try:
        return settings_view(read(bot), redact)
    except Exception:
        return None


def language_patch(config, language):
    """The only two leaves that may be written: `stt.language` ('' for auto: empty reads as not set) and, for pt or en, `tts.edge.voice`, only when the provider is Edge (or unset) and the voice is unset or one of our two defaults. A voice the person chose is never overwritten and no other provider is touched."""
    patch = {'stt': {'language': '' if language == 'auto' else language}}
    tts = config.get('tts') if isinstance(config, dict) else None
    edge = tts.get('edge') if isinstance(tts, dict) else None
    ours = (tts is None or isinstance(tts, dict)) and (edge is None or isinstance(edge, dict)) and (tts or {}).get('provider') in (None, 'edge') \
        and (edge or {}).get('voice') in (None, '', *VOICES.values())
    if language != 'auto' and ours:
        patch['tts'] = {'edge': {'voice': VOICES[language]}}
    return patch


def _apply_language(hermes, bot, language, patch):
    """Hermes writes `patch` in the Bot's profile and the value is read back with Hermes's own reader: one that did not stick is a 502, never a claimed success. Hermes's text never leaves."""
    try:
        hermes.write_config(bot, patch)
    except Exception as error:
        if hermes_boundary.config_write_refusal(error) is not None:
            raise  # a write Hermes's config backend refused (a lock above, an invalid value): SafeRoute says which, with our words
        raise PluginError('hermes_error', 'Hermes could not change this setting.', 502) from None
    try:
        kept = hermes.config(bot)
    except Exception:
        raise PluginError('hermes_error', 'Hermes could not change this setting.', 502) from None
    if _word(kept) != language:
        raise PluginError('hermes_error', 'Hermes did not keep this setting.', 502)
    return kept


def set_language(audit, hermes, actor, bot, language, redact, ref):
    """PUT /bots/{bot}/voice/language: audited first (`voice.language`, the words before and after, never text), then written and read back."""
    language_value(language)
    try:
        before = hermes.config(bot)
    except Exception:
        raise PluginError('hermes_error', 'Hermes could not read this setting.', 502) from None
    patch = language_patch(before, language)
    kept = audit.act(actor, 'voice.language', bot, {'kind': 'ui', 'ref': ref}, lambda: _apply_language(hermes, bot, language, patch), bot=bot,
                     payload={'from': _word(before), 'to': language})
    return {'settings': settings_view(kept, redact)}


def apply_language(hermes, bot, language):
    """The creation of a Bot (inside the `bot.create` row): the screen's language is the Bot's from the first minute. Not audited on its own, and the caller may ignore a failure."""
    language_value(language)
    _apply_language(hermes, bot, language, language_patch(hermes.config(bot), language))


# ---- Call (3.2-3.4): GPT-Live through Hermes; LuveBot keeps times, counts and cents only (A-98) ------------------------------
CALL_RESERVE = MAX_SECONDS // 60 * CENTS_PER_MINUTE   # A-100: 75 cents, the most a call may cost
HEARTBEAT_SECONDS = 30
LOST_AFTER = 90            # a call with no heartbeat for this long is closed by the sweeper
LOST_GRACE = 60            # ... and billed up to its last heartbeat + this
STARTING_TIMEOUT = 120     # a claimed call Hermes never answered
MAX_OPEN_TOTAL = 3         # A-102
MAX_SDP = 64 * 1024
MAX_CONTEXT = 6000
END_REASONS = ('hangup', 'max_time', 'stop', 'error')
_DELEGATION_ID = re.compile(r'[A-Za-z0-9_-]{1,128}')
_SAFE_ID = re.compile(r'[A-Za-z0-9_.:-]{1,128}')
CALLS_SCHEMA = """CREATE TABLE IF NOT EXISTS voice_calls (
 id TEXT PRIMARY KEY, bot TEXT NOT NULL, session_id TEXT, vendor_session TEXT, reservation TEXT,
 started_at REAL NOT NULL, last_beat REAL NOT NULL, ended_at REAL, end_reason TEXT, delegations INTEGER NOT NULL DEFAULT 0,
 vendor_seconds INTEGER, billed_cents INTEGER, committed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL)"""
_OPEN = ('starting', 'open')


def billed_cents(seconds):
    """A-100: 5 cents per STARTED minute."""
    return -(-max(0, int(math.ceil(seconds))) // 60) * CENTS_PER_MINUTE


def call_body(body):
    if not isinstance(body, dict) or set(body) - {'sdp', 'session_id'}:
        raise PluginError('bad_request', 'Malformed request body.', 400)
    sdp, session = body.get('sdp'), body.get('session_id')
    if not isinstance(sdp, str) or not sdp.strip() or len(sdp.encode('utf-8', 'replace')) > MAX_SDP:
        raise PluginError('invalid_field', 'Invalid value for sdp.', 422)
    if session is not None and not (isinstance(session, str) and _SAFE_ID.fullmatch(session)):
        raise PluginError('invalid_field', 'Invalid value for session_id.', 422)
    return sdp, session


def delegation_body(body):
    if not isinstance(body, dict) or set(body) - {'delegation_id', 'context'}:
        raise PluginError('bad_request', 'Malformed request body.', 400)
    did, context = body.get('delegation_id'), body.get('context', '')
    if not isinstance(did, str) or not _DELEGATION_ID.fullmatch(did):
        raise PluginError('invalid_field', 'Invalid value for delegation_id.', 422)
    if not isinstance(context, str) or len(context) > MAX_CONTEXT:
        raise PluginError('invalid_field', 'Invalid value for context.', 422)
    return did, context


def end_body(body):
    if not isinstance(body, dict) or set(body) - {'vendor_seconds', 'reason'}:
        raise PluginError('bad_request', 'Malformed request body.', 400)
    seconds, reason = body.get('vendor_seconds'), body.get('reason')
    if seconds is not None and (type(seconds) is not int or not 0 <= seconds <= 86400):
        raise PluginError('invalid_field', 'Invalid value for vendor_seconds.', 422)
    if reason not in END_REASONS:
        raise PluginError('invalid_field', 'Invalid value for reason.', 422)
    return seconds, reason


def _not_found():
    return PluginError('call_not_found', 'This call was not found.', 404)


def _not_open():
    return PluginError('call_not_open', 'This call is not open.', 409)


class Calls:
    """voice_calls in luvebot.db. Every state change is one IMMEDIATE transaction, so two requests never both win a slot or an end."""

    def __init__(self, path, clock=time.time):
        self.path, self.clock = path, clock
        with self._tx() as conn:
            conn.execute(CALLS_SCHEMA)

    @contextmanager
    def _tx(self):
        conn = dbfile.connect(self.path)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute('BEGIN IMMEDIATE')
            yield conn
            conn.commit()
        finally:
            conn.close()

    def claim(self, bot, session_id):
        """One open call per Bot and MAX_OPEN_TOTAL in all (A-102), checked and taken in one transaction."""
        now = self.clock()
        with self._tx() as conn:
            mine = conn.execute(f"SELECT COUNT(*) FROM voice_calls WHERE bot=? AND status IN {_OPEN}", (bot,)).fetchone()[0]
            total = conn.execute(f"SELECT COUNT(*) FROM voice_calls WHERE status IN {_OPEN}").fetchone()[0]
            if mine or total >= MAX_OPEN_TOTAL:
                raise PluginError('call_in_progress', 'A call is already in progress.', 409)
            call_id = 'call_' + uuid.uuid4().hex
            conn.execute("INSERT INTO voice_calls(id, bot, session_id, started_at, last_beat, status) VALUES(?,?,?,?,?,'starting')",
                         (call_id, bot, session_id, now, now))
        return call_id

    def reserved(self, call_id, reservation):
        with self._tx() as conn:
            conn.execute('UPDATE voice_calls SET reservation=? WHERE id=?', (reservation, call_id))

    def opened(self, call_id, vendor_session):
        now = self.clock()
        with self._tx() as conn:
            conn.execute("UPDATE voice_calls SET status='open', vendor_session=?, started_at=?, last_beat=? WHERE id=? AND status='starting'",
                         (vendor_session, now, now, call_id))

    def failed(self, call_id):
        with self._tx() as conn:
            conn.execute("UPDATE voice_calls SET status='failed', ended_at=?, billed_cents=0 WHERE id=? AND status='starting'",
                         (self.clock(), call_id))

    def get_any(self, call_id):
        with self._tx() as conn:
            row = conn.execute('SELECT * FROM voice_calls WHERE id=?', (call_id,)).fetchone()
        if row is None:
            raise _not_found()
        return dict(row)

    def get(self, bot, call_id):
        with self._tx() as conn:
            row = conn.execute('SELECT * FROM voice_calls WHERE id=? AND bot=?', (call_id, bot)).fetchone()
        if row is None:
            raise _not_found()
        return dict(row)

    def beat(self, bot, call_id):
        """-> seconds since the call started. Only an open call beats."""
        now = self.clock()
        with self._tx() as conn:
            row = conn.execute('SELECT status, started_at FROM voice_calls WHERE id=? AND bot=?', (call_id, bot)).fetchone()
            if row is None:
                raise _not_found()
            if row['status'] != 'open':
                raise _not_open()
            conn.execute('UPDATE voice_calls SET last_beat=? WHERE id=?', (now, call_id))
        return now - row['started_at']

    def take_delegation(self, bot, call_id):
        """Counts one delegation of THIS call: open, time left, fewer than MAX_DELEGATIONS. -> the call row."""
        now = self.clock()
        with self._tx() as conn:
            row = conn.execute('SELECT * FROM voice_calls WHERE id=? AND bot=?', (call_id, bot)).fetchone()
            if row is None:
                raise _not_found()
            if row['status'] != 'open':
                raise _not_open()
            if now - row['started_at'] >= MAX_SECONDS:
                raise PluginError('call_time_over', 'This call reached its time limit.', 409)
            if row['delegations'] >= MAX_DELEGATIONS:
                raise PluginError('delegation_limit', 'This call reached its task limit.', 409)
            conn.execute('UPDATE voice_calls SET delegations=delegations+1 WHERE id=?', (call_id,))
        return dict(row, delegations=row['delegations'] + 1)

    def close(self, call_id, reason, vendor_seconds=None):
        """Ends an open call and fixes what it costs. -> (row, won): `won` is False when it had already ended (the stored receipt)."""
        now = self.clock()
        with self._tx() as conn:
            row = conn.execute('SELECT * FROM voice_calls WHERE id=?', (call_id,)).fetchone()
            if row is None:
                raise _not_found()
            if row['status'] != 'open':
                return dict(row), False
            if reason == 'lost':      # 3.4: up to the last heartbeat + 60 s, never past the 900 s the client was told
                seconds = min(row['last_beat'] + LOST_GRACE, row['started_at'] + MAX_SECONDS) - row['started_at']
            else:                     # the vendor's own count when it says more (the client cannot bill less than the server saw)
                seconds = max(now - row['started_at'], vendor_seconds or 0)
            cents = billed_cents(seconds)
            conn.execute("UPDATE voice_calls SET status=?, ended_at=?, end_reason=?, vendor_seconds=?, billed_cents=? WHERE id=?",
                         ('lost' if reason == 'lost' else 'ended', now, reason, vendor_seconds, cents, call_id))
            return dict(row, status='ended', ended_at=now, end_reason=reason, vendor_seconds=vendor_seconds, billed_cents=cents,
                        seconds=int(math.ceil(seconds))), True

    def committed(self, call_id):
        with self._tx() as conn:
            conn.execute('UPDATE voice_calls SET committed=1 WHERE id=?', (call_id,))

    def due(self):
        """For the sweeper: open calls with no heartbeat for LOST_AFTER, calls Hermes never answered, and spends not yet committed."""
        now = self.clock()
        with self._tx() as conn:
            lost = [r[0] for r in conn.execute("SELECT id FROM voice_calls WHERE status='open' AND last_beat < ?", (now - LOST_AFTER,))]
            stuck = [dict(r) for r in conn.execute("SELECT * FROM voice_calls WHERE status='starting' AND started_at < ?",
                                                  (now - STARTING_TIMEOUT,))]
            uncommitted = [dict(r) for r in conn.execute(
                "SELECT * FROM voice_calls WHERE status IN ('ended','lost','failed') AND committed=0")]
        return lost, stuck, uncommitted

    def spend_since(self, start):
        """[(bot, ended_at, cents)] of calls billed since `start` (epoch): the "voz" line of GET /costs."""
        with self._tx() as conn:
            return [tuple(r) for r in conn.execute(
                "SELECT bot, ended_at, billed_cents FROM voice_calls WHERE status IN ('ended','lost') AND ended_at >= ? AND billed_cents > 0",
                (start,))]


def _receipt(row):
    seconds = row.get('seconds')
    if seconds is None:  # a stored row: the same rule `close` billed with
        seconds = int(math.ceil(min(row['last_beat'] + LOST_GRACE, row['started_at'] + MAX_SECONDS) - row['started_at']
                                if row['end_reason'] == 'lost' else max(row['ended_at'] - row['started_at'], row['vendor_seconds'] or 0)))
    return {'seconds': seconds, 'delegations': row['delegations'], 'cents': row['billed_cents']}


def _settle(budget, calls, row):
    """The call's spend into the Budget: against its reservation, or (no reservation: no cap existed when it started) as spend
    of its own. Idempotent, so the sweeper can retry it."""
    if row['reservation']:
        budget.commit(row['reservation'], row['billed_cents'] or 0)
    elif row['billed_cents']:
        budget.record_spend(row['id'], row['bot'], row['billed_cents'])
    calls.committed(row['id'])


def _quietly(fn, *args):
    try:
        fn(*args)
    except Exception:
        pass  # the sweeper retries what did not settle (`Calls.due`)


def start_call(audit, budget, calls, hermes, actor, bot, body, gate, refusal, ref):
    """POST /bots/{bot}/voice/calls (3.2). Gate, one slot, the reservation of the call's maximum, then the intent row, then Hermes
    exchanges the SDP (history=None, A-99). Any failure releases the slot and settles the reservation at 0."""
    sdp, session_id = call_body(body)
    gate()
    call_id = calls.claim(bot, session_id)
    reservation = None
    try:
        try:
            reservation = budget.reserve(bot, CALL_RESERVE)
        except Exception as error:
            decision = getattr(error, 'decision', None)
            if decision is None:
                raise
            refused = refusal(decision)  # None only when no cap exists at all (nothing to reserve against, as for a run)
            if refused is not None:
                raise refused from None
        if reservation is not None:
            calls.reserved(call_id, reservation)

        def effect():
            try:
                result = hermes.live_session(sdp, bot)
            except Exception:
                raise unavailable('call') from None
            answer = ((result or {}).get('transport') or {}).get('sdp') if isinstance(result, dict) else None
            vendor = ((result or {}).get('session') or {}).get('id') if isinstance(result, dict) else None
            if not isinstance(answer, str) or not answer.strip() or not isinstance(vendor, str) or not _SAFE_ID.fullmatch(vendor):
                raise unavailable('call')
            return answer, vendor

        answer, vendor = audit.act(actor, 'voice.call.start', bot, {'kind': 'ui', 'ref': ref}, effect, bot=bot,
                                   payload={'call_id': call_id, 'session_id': session_id})
    except BaseException:
        _quietly(calls.failed, call_id)
        if reservation is not None:
            _quietly(budget.commit, reservation, 0)
            _quietly(calls.committed, call_id)
        raise
    calls.opened(call_id, vendor)
    return {'call_id': call_id, 'sdp': answer, 'max_seconds': MAX_SECONDS, 'max_delegations': MAX_DELEGATIONS,
            'heartbeat_seconds': HEARTBEAT_SECONDS}


def heartbeat(calls, bot, call_id, stop_reason):
    """3.3: `stop_reason()` -> None | 'bot_paused' | 'budget'. Not audited: no effect."""
    elapsed = calls.beat(bot, call_id)
    reason = 'max_time' if elapsed >= MAX_SECONDS else stop_reason()
    return {'stop': reason is not None, 'reason': reason, 'remaining_seconds': max(0, int(MAX_SECONDS - elapsed))}


def delegate(audit, calls, hermes, actor, bot, call_id, body, gate, redact, ref):
    """3.3: counts the delegation of THIS call (audited first) -> (session_id, turn text, client message id). The route then
    sends the text as a NORMAL turn through the conversation path (the same rules, gates and budget as typed text)."""
    did, context = delegation_body(body)
    row = calls.get(bot, call_id)
    if row['session_id'] is None:
        raise PluginError('session_required', 'This call has no conversation to send tasks to.', 409)
    gate()
    audit.act(actor, 'voice.call.delegation', bot, {'kind': 'ui', 'ref': ref}, lambda: calls.take_delegation(bot, call_id), bot=bot,
              payload={'call_id': call_id, 'delegation_id': did, 'context_chars': len(context)})
    return row['session_id'], hermes.turn_note(redact(context)), f'vc{call_id[5:21]}{hashlib.sha256(did.encode()).hexdigest()[:24]}'


def end_call(audit, budget, calls, actor, bot, call_id, body, ref):
    """3.4: the receipt. Billed seconds = max(server, vendor); idempotent (a second end answers the same receipt, no new row)."""
    vendor_seconds, reason = end_body(body)
    row = calls.get(bot, call_id)
    if row['status'] in ('ended', 'lost'):
        return _receipt(row)
    if row['status'] != 'open':
        raise _not_open()

    def effect():
        closed, won = calls.close(call_id, reason, vendor_seconds)
        if won:
            _settle(budget, calls, closed)
        return closed

    closed = audit.act(actor, 'voice.call.end', bot, {'kind': 'ui', 'ref': ref}, effect, bot=bot,
                       payload={'call_id': call_id, 'reason': reason, 'vendor_seconds': vendor_seconds})
    return _receipt(closed)


def sweep(audit, budget, calls):
    """With the budget watcher (3.4): a call with no heartbeat for 90 s is closed as `lost` and billed up to its last heartbeat
    + 60 s; a call Hermes never answered is released; a spend that did not commit is committed again (same amount)."""
    lost, stuck, uncommitted = calls.due()
    for call_id in lost:
        def effect(call_id=call_id):
            closed, won = calls.close(call_id, 'lost')
            if won:
                _settle(budget, calls, closed)
            return closed
        row = calls.get_any(call_id)
        audit.act('system', 'voice.call.end', row['bot'], {'kind': 'system'}, effect, bot=row['bot'],
                  payload={'call_id': call_id, 'reason': 'lost'})
    for row in stuck:
        calls.failed(row['id'])
        _settle(budget, calls, dict(row, billed_cents=0))
    for row in uncommitted:
        _settle(budget, calls, row)
    return lost
