"""Change a Bot's model from its Profile (contract v0.11 section 1, M-1): Hermes's own model handlers called in process, and only what LuveBot's invariants need on top of them.

  hermes_cli/web_routers/models.py  get_model_info (L90, sync), get_model_options (L138), set_model_assignment (L376), each with the Bot's `profile`
  hermes_cli/web_models.py          ModelAssignment {scope, provider, model, task, reasoning_effort, base_url, api_key, confirm_expensive_model, profile}

What LuveBot adds: the profile is ALWAYS the path's Bot (Hermes writes the DEFAULT profile's file without it), `scope` is always `main`, and a key or an address does not exist for LuveBot: the body is exactly
{provider, model, expected: {provider, model}, confirm_expensive?}, the choice must be in the options list LuveBot fetches itself at that moment (never the client's copy), `custom`, `local` and `nous` and every
user-defined or endpoint provider are never offered nor set from here (a `nous` change writes other config keys, a `custom` one registers an endpoint and may store a key), and nothing Hermes says in words is
forwarded but its price warning, redacted and cut. The pure parts (normalizing, validating, checking) are separate from the Hermes calls so they are tested without Hermes."""
import asyncio
import re
import unicodedata

from . import unicode_invisible
from .api_errors import PluginError
from .audit import ActionDenied
from .hermes_boundary import guarded

PROBES = ('get_model_info', 'get_model_options', 'set_model_assignment')
UNSUPPORTED = frozenset({'custom', 'local', 'nous'})   # A-146
ENDPOINT_KEYS = ('base_url', 'api_base', 'baseUrl', 'endpoint', 'url', 'host', 'api_key', 'apiKey', 'key_env', 'api_key_env')   # a row that names an address or a key, under whatever name, is a row that needs one
SLUG = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}')
MODEL_ID = re.compile(r'[\w.:/@+-]{1,128}', re.ASCII)   # ASCII only: a Cyrillic or fullwidth letter makes a twin of a real model id, and a twin may cost more
PROVIDERS_MAX, MODELS_MAX, STALE_MAX, WARNING_MAX = 30, 200, 10, 400
OPTIONS_TIMEOUT_S = 20.0                               # Hermes bounds the catalog build at about 15 s; LuveBot at 20 and then says the server is unavailable
BODY_KEYS = {'provider', 'model', 'expected', 'confirm_expensive'}
APPLIES = 'next_message'                              # the API server builds an agent for every run from the current config: an open conversation uses the new model on its next message (M-2 on the real v0.22.5; Hermes's docstring is about channel sessions)


# ---- the adapter: the three Hermes calls (imports are lazy: this module loads, and its pure parts are tested, without Hermes) ----------------------------------
def available():
    """-> (ok, missing list): the probes of 1.2. Anything missing and the three routes answer `capability_missing` (invariant 9)."""
    missing = []
    try:
        from hermes_cli.web_routers import models
        missing += [name for name in PROBES if not hasattr(models, name)]
    except Exception:
        missing += list(PROBES)
    try:
        from hermes_cli import web_models
        if not hasattr(web_models, 'ModelAssignment'):
            missing.append('ModelAssignment')
    except Exception:
        missing.append('ModelAssignment')
    return not missing, missing


def read_info(bot):
    """Hermes's `get_model_info` for this Bot's profile, normalized. A SYNC handler (it may probe a context length for seconds): call it in the thread pool."""
    from hermes_cli.web_routers.models import get_model_info
    try:
        return normalize_info(get_model_info(profile=bot))
    except Exception as error:  # noqa: BLE001
        raise refusal_of(error) from None


async def read_options_raw(bot):
    """Hermes's `get_model_options` for this Bot's profile, as Hermes gives it (never cached, never shown): `refresh` (which probes every provider) is not exposed. Bounded at OPTIONS_TIMEOUT_S."""
    from hermes_cli.web_routers.models import get_model_options
    try:
        return await asyncio.wait_for(guarded(get_model_options(profile=bot, refresh=False, include_unconfigured=False, explicit_only=False)), OPTIONS_TIMEOUT_S)
    except asyncio.TimeoutError:
        raise PluginError('hermes_unreachable', 'Hermes is unavailable.', 503) from None
    except Exception as error:  # noqa: BLE001
        raise refusal_of(error) from None


async def read_options(bot):
    return normalize_options(await read_options_raw(bot))


def assign(bot, provider, model, confirm):
    """Hermes's `set_model_assignment` for this Bot, scope `main`, synchronous (it runs inside the audit's effect, in a worker thread with no loop). Returns Hermes's answer."""
    from hermes_cli.web_models import ModelAssignment
    from hermes_cli.web_routers.models import set_model_assignment
    body = ModelAssignment(scope='main', provider=provider, model=model, confirm_expensive_model=bool(confirm), profile=bot)
    return asyncio.run(set_model_assignment(body, profile=bot))


# ---- the pure parts -------------------------------------------------------------------------------------------------------------------------------------
def _name(value, pattern):
    return value if isinstance(value, str) and pattern.fullmatch(value) else None


def normalize_info(raw):
    """{provider, model, context_length} from Hermes's answer: `null` for what is not set (Hermes answers an empty string), and nothing else of it (no base_url, no capability table)."""
    raw = raw if isinstance(raw, dict) else {}
    length = raw.get('effective_context_length')
    return {'provider': _name(raw.get('provider'), SLUG), 'model': _name(raw.get('model'), MODEL_ID),
            'context_length': length if isinstance(length, int) and not isinstance(length, bool) and 0 < length < 10 ** 9 else None}


def _unsupported(row):
    return bool(row.get('is_user_defined')) or any(row.get(key) for key in ENDPOINT_KEYS) or str(row.get('slug') or '').strip().lower() in UNSUPPORTED


def unsupported_slugs(raw):
    """The slugs of the rows LuveBot never offers or sets (user-defined, with an endpoint, or `custom`, `local`, `nous`), lower-cased."""
    rows = raw.get('providers') if isinstance(raw, dict) else None
    found = {str(row['slug']).strip().lower() for row in rows if isinstance(row, dict) and isinstance(row.get('slug'), str) and _unsupported(row)} if isinstance(rows, list) else set()
    return found | set(UNSUPPORTED)


def normalize_options(raw):
    """{providers: [{slug, name?, current, models: [str]}]}: only those fields, only rows LuveBot may change, bounded (30 providers, 200 models each, a model id `[\\w.:/@+-]{1,128}`)."""
    rows = raw.get('providers') if isinstance(raw, dict) else None
    out, blocked = [], unsupported_slugs(raw)
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or _unsupported(row) or _name(row.get('slug'), SLUG) is None or row['slug'].strip().lower() in blocked:   # a slug that has an endpoint on ANOTHER row is not offered at all
            continue
        models = [m for m in (row.get('models') if isinstance(row.get('models'), list) else []) if _name(m, MODEL_ID)][:MODELS_MAX]
        item = {'slug': row['slug'], 'current': row.get('is_current') is True, 'models': models}
        name = row.get('name')
        shown = ' '.join(_clean(name[:4096]).split())[:80] if isinstance(name, str) else ''
        if shown:
            item['name'] = shown
        out.append(item)
        if len(out) >= PROVIDERS_MAX:
            break
    return {'providers': out}


class ConfirmRequired(PluginError, ActionDenied):
    """A price warning is neither an error nor an effect: the audit says `denied` (as for a decision a check refused), and the answer is the 409 of the contract."""


def _bad(field):
    return PluginError('invalid_field', f'Invalid value for {field}.', 422)


def _expected_name(value, pattern, field):
    if value is None:
        return None
    if _name(value, pattern) is None:
        raise _bad(field)
    return value


def validate_body(body):
    """-> (provider, model, expected provider, expected model, confirm). The body is EXACTLY {provider, model, expected: {provider, model}, confirm_expensive?}: any other key (`api_key`, `base_url`, `scope`, `task`,
    `reasoning_effort`, `profile`, anything, in any casing) is a 422, and a missing `expected` too (an unconditional overwrite is not offered)."""
    if not isinstance(body, dict):
        raise PluginError('bad_request', 'Invalid request body.', 400)
    extra = set(body) - BODY_KEYS
    if extra:
        raise PluginError('invalid_field', 'Unsupported field: ' + ', '.join(sorted(map(str, extra)))[:200] + '.', 422)
    provider, model = _name(body.get('provider'), SLUG), _name(body.get('model'), MODEL_ID)
    if provider is None:
        raise _bad('provider')
    if model is None:
        raise _bad('model')
    expected = body.get('expected')
    if not isinstance(expected, dict) or set(expected) != {'provider', 'model'}:
        raise _bad('expected')
    confirm = body.get('confirm_expensive', False)
    if not isinstance(confirm, bool):
        raise _bad('confirm_expensive')
    return provider, model, _expected_name(expected['provider'], SLUG, 'expected'), _expected_name(expected['model'], MODEL_ID, 'expected'), confirm


def check_choice(raw, provider, model):
    """The choice must be in the options LuveBot fetched itself, now: a provider it does not change is 422 `provider_not_supported`, anything else that is not offered is 422 `model_not_offered`."""
    if provider.lower() in unsupported_slugs(raw):
        raise PluginError('provider_not_supported', 'Change this one in Hermes: it needs an endpoint, a key or other settings.', 422)
    for row in normalize_options(raw)['providers']:
        if row['slug'] == provider and model in row['models']:
            return
    raise PluginError('model_not_offered', 'This model is not offered for this Bot.', 422)


def check_expected(info, provider, model):
    """`expected` is what the person saw as current: another one now is 409 `stale`."""
    if (info['provider'], info['model']) != (provider, model):
        raise PluginError('stale', 'The model changed since you opened this; reload it.', 409)


def _clean(text):
    """No control character, no format character (Tags, bidi, zero-width), no line or paragraph separator, no lone surrogate and nothing of the table of invisible characters (the Hangul fillers, the blank braille cell ...):
    a text from a catalog or from Hermes is third-party text, and what no screen draws is not shown."""
    return ''.join(c for c in text if c in '\n\t' or (unicodedata.category(c) not in ('Cc', 'Cs', 'Cf', 'Zl', 'Zp') and unicode_invisible.kind_of(ord(c)) is None))


def _plain(text, limit, redact):
    """Plain text of at most `limit` characters: CLEANED first and redacted after, so a secret split by a character that is then removed is still seen whole by the redactor."""
    return ' '.join(redact(_clean(str(text)[:4096])).split())[:limit]


def refusal_of(error):
    """`_refusal_of`, and never a failure of its own: it runs inside an `except`, and an exception with a hostile attribute is a plain refusal of Hermes."""
    try:
        return _refusal_of(error)
    except Exception:  # noqa: BLE001
        return PluginError('hermes_error', 'Hermes returned an unexpected response.', 502)


def _refusal_of(error):
    """The PluginError a failure of a Hermes model call is, in our words: a refused config write is left as it is (the route says which: 409 `config_key_locked` ..., the key `model.default`), Hermes's `503 Restart
    required` is `hermes_restart_required`, a 400 is `invalid_field`, anything else `hermes_error`. Hermes's `detail` text is never forwarded."""
    from .hermes_boundary import CONVERTED, config_write_refusal
    if isinstance(error, PluginError) or getattr(error, 'code', None) in CONVERTED or config_write_refusal(error) is not None:
        return error   # already ours; or the boundary's own answer (the config outage 503, a plain exit 502); or a refused config write, which the route says by its code
    status, detail = getattr(error, 'status_code', None), getattr(error, 'detail', '')
    if status == 503 and isinstance(detail, str) and detail.startswith('Restart required'):
        return PluginError('hermes_restart_required', 'Hermes was updated on disk; restart the dashboard first.', 503)
    if status == 400:
        return PluginError('invalid_field', 'Hermes refused this choice.', 422)
    return PluginError('hermes_error', 'Hermes returned an unexpected response.', 502)


def result_of(answer, provider, model, redact):
    """Hermes's answer to the assignment -> the 200 body, or the PluginError for what it says instead. `confirm_required` is 409 with Hermes's price warning as plain redacted text of at most 400 characters;
    `stale_aux` is the NAMES of the auxiliary slots (at most 10) that still point to the previous provider; `base_url`, `gateway_tools` and `notice` are dropped."""
    if not isinstance(answer, dict):
        raise PluginError('hermes_error', 'Hermes returned an unexpected response.', 502)
    if answer.get('confirm_required') is True:
        raise ConfirmRequired('confirm_required', 'Hermes says this model is expensive; confirm to use it.', 409, {'details': {'warning': _plain(answer.get('confirm_message') or '', WARNING_MAX, redact)}})
    if answer.get('ok') is not True:
        raise PluginError('hermes_error', 'Hermes returned an unexpected response.', 502)
    stale = answer.get('stale_aux')
    names = [s for s in (stale if isinstance(stale, list) else []) if _name(s, re.compile(r'[A-Za-z0-9_.-]{1,40}'))][:STALE_MAX]
    return {'provider': provider, 'model': model, 'applies': APPLIES, 'stale_aux': names}


def change(audit, actor, bot, provider, model, confirm, before, redact, origin_ref):
    """The audited write: `bot.model.set` with the NAMES `{from, to}` only (never a key, a URL or Hermes's text), the intent committed before Hermes is called. -> the 200 body. Synchronous: the thread pool."""
    def effect():
        try:
            return result_of(assign(bot, provider, model, confirm), provider, model, redact)
        except Exception as error:  # noqa: BLE001
            raise refusal_of(error) from None
    return audit.act(actor, 'bot.model.set', bot, {'kind': 'ui', 'ref': origin_ref}, effect, bot=bot,
                     payload={'from': {'provider': before['provider'], 'model': before['model']}, 'to': {'provider': provider, 'model': model}})
