"""Who counts as a person (contract v0.11 section 5, DT-1 and DT-1b; invariant 6: an approval is never resolved without a person).

The identity of a request has three modes:
  gated       a session of a person who logged in to the dashboard;
  loopback    the dashboard's own token on a loopback dashboard: it names the machine, so it may read and tighten and, unless the installation opted in, nothing that needs a person;
  deployment  everything that is not a person's login: the deployment credential of Hermes `main` (`HERMES_DASHBOARD_SESSION_TOKEN`, the `session_token` dashboard-auth plugin: Hermes gives it a synthetic session with
              `provider == "session-token"` and `user_id == "deployment-token"`), a service credential, or a provider LuveBot does not know. It is the machine too, and the loopback opt-in does NOT open it.

An ALLOWLIST (section 5.1): a session is a person's only when its provider is one of `KNOWN_PERSON_PROVIDERS` (`basic`, `nous`, `self-hosted`) or one the operator declared in `LUVEBOT_PERSON_PROVIDERS` (read ONCE, when this
module is loaded, from the process environment and nowhere else), and never when the provider is `session-token` or `drain-secret` or the user is `deployment-token`. A denylist would treat every provider a third party
registers tomorrow as a person until someone noticed; the allowlist costs a refusal (a person of an unlisted provider is `credential_not_human` until the operator declares it), never a bypass. Every comparison is exact:
case-sensitive, no trimming, no prefix, no normalization, so a lookalike is not a name on the list and a value that is not text is nobody's."""
import contextvars
import logging
import os
import re

from .api_errors import PluginError

DEPLOYMENT_PROVIDER, DEPLOYMENT_USER = 'session-token', 'deployment-token'
KNOWN_PERSON_PROVIDERS = frozenset({'basic', 'nous', 'self-hosted'})
DENIED_PROVIDERS = frozenset({DEPLOYMENT_PROVIDER, 'drain-secret'})   # never a person, even if the operator lists them
PROVIDER_NAME = re.compile(r'[a-z0-9-]{1,32}')
LOOPBACK_MODES = ('loopback',)   # a tuple and `in`: a comparison of a mode with this string is for `human_refusal` and `_identity` alone
CREDENTIAL_WORDS = ("This sign-in is not one LuveBot recognizes as a person's login (a deployment credential, or a provider it does not know). "
                    "Sign in with a person's login, or ask the operator to declare the provider.")


def declared_providers(raw):
    """`(names, ignored)` of the operator's list: the entries (split on commas, spaces and tabs around an entry dropped) that are exactly `[a-z0-9-]{1,32}` and not a denied name, and how many non-empty entries were not."""
    names, ignored = set(), 0
    for entry in (raw if type(raw) is str else '').split(','):
        entry = entry.strip(' \t')
        if not entry:
            continue
        if PROVIDER_NAME.fullmatch(entry) and entry not in DENIED_PROVIDERS:
            names.add(entry)
        else:
            ignored += 1
    return frozenset(names), ignored


_EXTRA, _IGNORED = declared_providers(os.environ.get('LUVEBOT_PERSON_PROVIDERS'))   # once, here: a request, a file or the browser never changes who is a person
PERSON_PROVIDERS = KNOWN_PERSON_PROVIDERS | _EXTRA
if _EXTRA:
    logging.getLogger('luvebot.identity').info('LuveBot treats these dashboard sign-in providers as a person\'s login, as declared in LUVEBOT_PERSON_PROVIDERS: %s', ', '.join(sorted(_EXTRA)))
if _IGNORED:
    logging.getLogger('luvebot.identity').warning('LUVEBOT_PERSON_PROVIDERS: %d entries ignored (a name is 1 to 32 of a-z, 0-9 and -; session-token and drain-secret are never people)', _IGNORED)


def person_providers():
    """The effective list, names only (`GET /health`)."""
    return sorted(PERSON_PROVIDERS)


def mode_of(provider, user_id):
    """'gated' for a person's login, else 'deployment' (the machine): a provider on the list and neither a denied name nor the deployment user; a value that is not text is never a person (the caller has already required a user, a provider and a token)."""
    if type(provider) is not str or type(user_id) is not str:
        return 'deployment'
    if provider in DENIED_PROVIDERS or user_id == DEPLOYMENT_USER:
        return 'deployment'
    return 'gated' if provider in PERSON_PROVIDERS else 'deployment'


_REFUSED_PROVIDER = contextvars.ContextVar('luvebot_refused_provider', default=None)


def note_provider(name):
    """`_identity` says, for each request, the (already redacted) provider of a session that is not a person's (None for anyone else), so the refusal can name it (`details: {provider}`, section 5.1) without every gate carrying it."""
    _REFUSED_PROVIDER.set(name[:64] if type(name) is str and name else None)


def refusal_extra(code):
    """The additive `details` of a `credential_not_human` answer: the provider's name, so an operator sees why a login was refused; nothing for another code or when no provider was noted."""
    name = _REFUSED_PROVIDER.get()
    return {'details': {'provider': name}} if code == 'credential_not_human' and name else None


def credential_not_human():
    return PluginError('credential_not_human', CREDENTIAL_WORDS, 403, refusal_extra('credential_not_human'))


def human_refusal(mode, loopback_words, *, loopback_ok=False):
    """The ONE answer to "is this request a person's?": None for a person (a `gated` request, or a `loopback` one the installation chose to trust: `loopback_ok`), else `(code, words)`: `loopback_not_human` for a
    loopback token, `credential_not_human` for the deployment credential and for ANYTHING ELSE (a value nobody knows, a type that is not a string): closed. Every human gate calls this and turns the answer into its own
    error type (PluginError here, Refused in another module); no code outside this function and `_identity` compares the mode with a string."""
    if type(mode) is str and mode == 'gated':   # the type first: an object whose __eq__ says yes is not a person
        return None
    if type(mode) is not str or mode not in LOOPBACK_MODES:
        return ('credential_not_human', CREDENTIAL_WORDS)
    return None if loopback_ok else ('loopback_not_human', loopback_words)


def require_person(mode, loopback_words, *, loopback_ok=False):
    """`human_refusal` as the PluginError most gates raise (403)."""
    refusal = human_refusal(mode, loopback_words, loopback_ok=loopback_ok)
    if refusal is not None:
        raise PluginError(refusal[0], refusal[1], 403, refusal_extra(refusal[0]))
