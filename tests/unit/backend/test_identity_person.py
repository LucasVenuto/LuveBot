"""DT-1 and DT-1b (contract v0.11 section 5 and 5.1; invariant 6): only a person's login is a person; the deployment credential of Hermes `main` (`session-token` / `deployment-token`) and any provider LuveBot does not know are the machine.
* the predicate (`identity.mode_of`) is an ALLOWLIST: `basic`, `nous`, `self-hosted` and what the operator declared in `LUVEBOT_PERSON_PROVIDERS` (read once, at load, from the environment only; each name `[a-z0-9-]{1,32}`;
  `session-token` and `drain-secret` ignored if listed), with `session-token`, `drain-secret` and the user `deployment-token` denied on top; every comparison exact (a lookalike is not on the list, a value that is not text is nobody's);
* the one human check (`identity.require_person`): only `gated` passes; `deployment` is `403 credential_not_human` (with `details: {provider}` and the words of 5.1) whatever the installation chose; `loopback` is `403 loopback_not_human` unless it opted in;
* `_identity` returns the third mode, records the actor as `provider:user_id` (never the token's value) and names the provider for the refusal (redacted, capped); a missing session is still 401 (the gate holds); `/health` says `auth.person_providers`;
* `_human`, `_human_actor`, `_budget_actor` (raising refused, lowering allowed), a Bot's memory refuses it; EVERY place that decides by the mode goes through the one check (a scan of the source);
* what it may still do is what loopback may do (it is accepted as a session, reads, and tightens).
The pieces of plugin_api.py are the real text, run against stand-ins. Mutations: one line changed -> red."""
import importlib
import importlib.util
import itertools
import logging
import re
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_config_boundary_threads as threads  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
API = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
TOKEN = 'TOKEN-VALUE-Zq81xx-never-shown'
WORDS = ("This sign-in is not one LuveBot recognizes as a person's login (a deployment credential, or a provider it does not know). "
         "Sign in with a person's login, or ask the operator to declare the provider.")


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch):
    """No declared providers unless a test declares them; no provider noted from an earlier request."""
    for name in ('LUVEBOT_PERSON_PROVIDERS', 'LUVEBOT_ALLOW_LOOPBACK_APPROVALS'):
        monkeypatch.setenv(name, '')     # so the test's own writes to os.environ are undone too
        monkeypatch.delenv(name)


def module(name_, edits=()):
    """The module under a package of its own, executed NOW: `identity` reads the environment when it is loaded, so the caller sets the environment first."""
    name, _ = threads.package()
    return threads.variant(name, name_, edits), name


def refusal(call):
    try:
        call()
    except Exception as error:  # noqa: BLE001
        return error
    return None


# ---- the predicate and the one check ---------------------------------------------------------------------------------------------------------------------
class Text(str):
    """A str that says it equals anything the list holds: not a plain `str`, so nobody's."""
    def __eq__(self, other):
        return True

    __hash__ = str.__hash__


PEOPLE = [('basic', 'ana'), ('nous', 'eyJzdWIi'), ('self-hosted', 'oidc-sub-1'), ('basic', 'deployment'), ('basic', 'Deployment-Token'), ('basic', 'deployment-token2'), ('basic', 'deployment-token '), ('basic', ' deployment-token'), ('basic', 'DEPLOYMENT-TOKEN'), ('basic', 'deployment-token\n'), ('nous', 'deployment-t\u043eken'), ('basic', 'deployment-tokens')]
MACHINES = [('session-token', 'deployment-token'), ('session-token', 'someone'), ('session-token', ''), ('drain-secret', 'drain-control'), ('drain-secret', 'ana'),   # the denied names, whoever the user is
            ('basic', 'deployment-token'), ('nous', 'deployment-token'), ('self-hosted', 'deployment-token'),                                                   # the denied user, whatever the provider
            ('github', '1234'), ('acme', 'ana'), ('google', 'x'), ('', 'ana'), ('basic-', 'ana'), ('basi', 'ana'), ('basics', 'ana'), ('self_hosted', 'ana'), ('selfhosted', 'ana'), ('self-hosted-2', 'ana'),   # a provider nobody listed
            ('Basic', 'ana'), ('BASIC', 'ana'), ('Nous', 'ana'), ('SELF-HOSTED', 'ana'), (' basic', 'ana'), ('basic ', 'ana'), ('basic\n', 'ana'), ('basic\x00', 'ana'), ('\tnous', 'ana'),   # another case, a space, a control character
            ('basi\u0441', 'ana'), ('\u0262asic', 'ana'), ('\uff42asic', 'ana'), ('b\u0430sic', 'ana'), ('nou\u0455', 'ana'), ('ba\u200bsic', 'ana'), ('self\u2011hosted', 'ana'), ('\uff53elf-hosted', 'ana'), ('bas\u0131c', 'ana'),   # Unicode lookalikes
            ('Session-Token', 'deployment-token'), ('session-token ', 'ana'), ('\u0455ession-token', 'x'), ('deployment-token', 'session-token'),
            (b'basic', 'ana'), (['basic'], 'ana'), (1, 2), (None, None), ('basic', None), (None, 'ana'), ('basic', b'ana'), ('basic', ['ana']), (Text('basic'), 'ana'), ('basic', Text('ana')), (Text('acme'), 'ana')]


def predicate_checks(m):
    for provider, user in PEOPLE:
        assert m.mode_of(provider, user) == 'gated', (provider, user)
    for provider, user in MACHINES:
        assert m.mode_of(provider, user) == 'deployment', (provider, user)
    assert m.person_providers() == ['basic', 'nous', 'self-hosted'] and isinstance(m.person_providers(), list)           # nothing declared: the known set, sorted, names only
    saved = m.PERSON_PROVIDERS                                                                                              # the denied names win over a list that holds them (defence in depth: the parser drops them too)
    try:
        m.PERSON_PROVIDERS = saved | {'session-token', 'drain-secret', 'acme'}
        assert m.mode_of('session-token', 'ana') == 'deployment' and m.mode_of('drain-secret', 'ana') == 'deployment' and m.mode_of('basic', 'deployment-token') == 'deployment'
        assert m.mode_of('acme', 'ana') == 'gated' and m.mode_of('acme', 'deployment-token') == 'deployment'
    finally:
        m.PERSON_PROVIDERS = saved


def declared_checks(m):
    """The operator's list: exact names only, the denied names dropped, nothing that is not a name accepted, the ignored ones only counted."""
    d = m.declared_providers
    assert d(None) == (frozenset(), 0) and d('') == (frozenset(), 0) and d(' , ,,') == (frozenset(), 0) and d(7) == (frozenset(), 0) and d(b'acme') == (frozenset(), 0)
    assert d('acme') == (frozenset({'acme'}), 0) and d('acme,corp-sso,okta2') == (frozenset({'acme', 'corp-sso', 'okta2'}), 0) and d('a-b-9,acme,') == (frozenset({'a-b-9', 'acme'}), 0)
    assert d('acme, corp') == (frozenset({'acme', 'corp'}), 0) and d('\tacme \t,\t corp ') == (frozenset({'acme', 'corp'}), 0)                 # spaces and tabs around an entry: the way a list is written
    assert d('basic,nous') == (frozenset({'basic', 'nous'}), 0) and d('acme,acme') == (frozenset({'acme'}), 0)
    assert d('session-token') == (frozenset(), 1) and d('drain-secret') == (frozenset(), 1) and d('acme,session-token,drain-secret,corp') == (frozenset({'acme', 'corp'}), 2)   # never people, even if listed
    for bad in ['Acme', 'ACME', 'acme corp', 'ac me', 'acme_corp', 'acme.corp', 'acme/x', 'acme:x', 'acme@x', 'acme!', 'a' * 33, 'a' * 64, '\u0430cme', 'acm\u0435', '\uff41cme', 'acme\n', '\nacme', 'ac\nme', 'acme\x00', 'acme\u200b', '\u00e1cme',
                'acme\u2011corp', '-' * 33, "acme';--", 'acme\r']:
        assert d(bad) == (frozenset(), 1), repr(bad)
        assert d(f'good,{bad},fine') == (frozenset({'good', 'fine'}), 1), repr(bad)
    assert d('a' * 32) == (frozenset({'a' * 32}), 0) and d('a') == (frozenset({'a'}), 0) and d('-') == (frozenset({'-'}), 0) and d('0') == (frozenset({'0'}), 0)
    assert d('acme;corp') == (frozenset(), 1) and d('acme corp') == (frozenset(), 1) and d('acme|corp') == (frozenset(), 1)                       # only the comma separates


def require_checks(m):
    words = 'needs a login; this one is in loopback mode'
    m.require_person('gated', words)                                                      # a person passes, with or without the opt-in
    m.require_person('gated', words, loopback_ok=True)
    m.require_person('loopback', words, loopback_ok=True)                                  # the installation chose to trust its loopback
    error = refusal(lambda: m.require_person('loopback', words))
    assert (error.code, error.status, str(error)) == ('loopback_not_human', 403, words), error
    for opted in (False, True):                                                              # the opt-in never opens the deployment credential
        error = refusal(lambda: m.require_person('deployment', words, loopback_ok=opted))
        assert (error.code, error.status, str(error)) == ('credential_not_human', 403, WORDS), (opted, error)
    assert m.human_refusal('gated', words) is None and m.human_refusal('gated', words, loopback_ok=True) is None
    assert m.human_refusal('loopback', words) == ('loopback_not_human', words) and m.human_refusal('loopback', words, loopback_ok=True) is None
    class Yes:                                                                                # an object that says it is equal to anything: never a person, never a trusted loopback
        def __eq__(self, other):
            return True

        __hash__ = None
    for odd in ('deployment', None, 'weird', 'Gated', ' gated', 'GATED', 'loopback ', 7, 0, True, ['gated'], b'gated', object(), Yes()):   # the deployment credential and anything nobody knows: closed, whatever the opt-in
        for opted in (False, True):
            assert m.human_refusal(odd, words, loopback_ok=opted) == ('credential_not_human', WORDS), (odd, opted)
            assert refusal(lambda: m.require_person(odd, words, loopback_ok=opted)).code == 'credential_not_human'
    assert (m.credential_not_human().code, m.credential_not_human().status) == ('credential_not_human', 403) and WORDS == m.CREDENTIAL_WORDS and 'loopback' not in WORDS
    assert TOKEN not in str(refusal(lambda: m.require_person('deployment', words)))
    m.note_provider('acme')                                                                  # the refusal names the provider (5.1), for the credential and for what nobody knows, never for loopback
    for opted in (False, True):
        assert refusal(lambda: m.require_person('deployment', words, loopback_ok=opted)).extra == {'details': {'provider': 'acme'}}
        assert refusal(lambda: m.require_person('weird', words, loopback_ok=opted)).extra == {'details': {'provider': 'acme'}}
    assert refusal(lambda: m.require_person('loopback', words)).extra == {}
    assert m.refusal_extra('credential_not_human') == {'details': {'provider': 'acme'}} and m.refusal_extra('loopback_not_human') is None and m.refusal_extra('x') is None
    assert m.credential_not_human().extra == {'details': {'provider': 'acme'}}
    m.note_provider('a' * 200)
    assert m.refusal_extra('credential_not_human') == {'details': {'provider': 'a' * 64}}                  # capped
    for odd in (None, '', 7, b'acme', ['acme'], Text('acme')):                                               # nothing to name: no details at all
        m.note_provider(odd)
        assert m.refusal_extra('credential_not_human') is None and refusal(lambda: m.require_person('deployment', words)).extra == {}, odd
    m.note_provider('acme')
    m.note_provider(None)
    assert m.refusal_extra('credential_not_human') is None                                                   # a person's request clears what an earlier one noted


ENV_LIST = 'acme, Corp ,okta2,session-token,drain-secret,bad name!'   # acme and okta2 are names; Corp, session-token, drain-secret and "bad name!" are not (4 ignored)


def env_checks(declared, log, near):
    """`declared` was loaded with ENV_LIST (and the environment changed AFTER it), `near` with the real variable unset and look-alike variables set."""
    assert declared.person_providers() == ['acme', 'basic', 'nous', 'okta2', 'self-hosted'], declared.person_providers()
    for provider in ('acme', 'okta2', 'basic', 'nous', 'self-hosted'):
        assert declared.mode_of(provider, 'ana') == 'gated', provider
    for provider in ('Corp', 'corp', 'Acme', 'bad name!', 'bad', 'session-token', 'drain-secret', 'other', 'github'):                # not declared, not a name, or never a person
        assert declared.mode_of(provider, 'ana') == 'deployment', provider
    assert declared.mode_of('acme', 'deployment-token') == 'deployment' and declared.mode_of('session-token', 'deployment-token') == 'deployment'
    assert 'acme' in log and 'okta2' in log and '4 entries ignored' in log, log                                                      # the extras by name, the rest only counted
    assert 'bad name' not in log and 'Corp' not in log, log                                                                          # an entry that is not a name is never echoed
    assert near.person_providers() == ['basic', 'nous', 'self-hosted'] and near.mode_of('acme', 'ana') == 'deployment'               # only LUVEBOT_PERSON_PROVIDERS counts


def build(edits, monkeypatch, caplog):
    """The module as the three environments load it. The edits (a mutation) apply to all."""
    clean = module('identity', edits)[0]                                                                                             # nothing declared
    monkeypatch.setenv('LUVEBOT_PERSON_PROVIDERS', ENV_LIST)
    caplog.clear()
    with caplog.at_level(logging.INFO, logger='luvebot.identity'):
        declared = module('identity', edits)[0]
    log = ' | '.join(r.getMessage() for r in caplog.records if r.name == 'luvebot.identity')
    monkeypatch.setenv('LUVEBOT_PERSON_PROVIDERS', 'other')                                                                          # changed after the load: read ONCE
    near = None
    with monkeypatch.context() as scoped:
        scoped.delenv('LUVEBOT_PERSON_PROVIDERS')
        for name in ('LUVEBOT_PERSON_PROVIDER', 'PERSON_PROVIDERS', 'HERMES_PERSON_PROVIDERS', 'LUVEBOT_PERSON_PROVIDERS_FILE'):
            scoped.setenv(name, 'acme')
        near = module('identity', edits)[0]
    return clean, declared, log, near


def all_checks(built):
    clean, declared, log, near = built
    predicate_checks(clean)
    declared_checks(clean)
    require_checks(clean)
    env_checks(declared, log, near)


def test_the_predicate_is_an_allowlist():
    predicate_checks(module('identity')[0])


def test_the_operators_list_is_parsed_exactly():
    declared_checks(module('identity')[0])


def test_the_declared_providers_come_from_the_environment_once_and_the_start_up_line_names_them(monkeypatch, caplog):
    all_checks(build((), monkeypatch, caplog))


def test_nothing_is_logged_when_nothing_is_declared(monkeypatch, caplog):
    with caplog.at_level(logging.DEBUG, logger='luvebot.identity'):
        module('identity')
    assert [r for r in caplog.records if r.name == 'luvebot.identity'] == []


def test_the_list_is_read_in_one_place_at_load_from_the_environment_and_nothing_else_reads_it():
    """Static: the variable is one string literal in the whole plugin, at module level of identity.py; identity.py opens no file and imports no way to receive a value (a request, a config)."""
    import ast
    sites = []
    for path in [ROOT / 'dashboard' / 'plugin_api.py', ROOT / 'dashboard' / 'plugin_entry.py', *sorted((ROOT / 'backend').glob('*.py'))]:
        tree = ast.parse(path.read_text())
        parents = {id(c): n for n in ast.walk(tree) for c in ast.iter_child_nodes(n)}
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and node.value == 'LUVEBOT_PERSON_PROVIDERS':
                up, inside = node, False
                while id(up) in parents:
                    up = parents[id(up)]
                    inside = inside or isinstance(up, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef))
                sites.append((path.name, inside))
    assert sites == [('identity.py', False)], sites
    tree = ast.parse((ROOT / 'backend' / 'identity.py').read_text())
    imported = {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names} | {n.module or '.' for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)}
    assert imported == {'contextvars', 'logging', 'os', 're', 'api_errors'}, imported
    assert not [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in ('open', 'eval', 'exec', '__import__')]
    assert [n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == 'os'] == ['environ']


def test_only_a_gated_request_is_a_person():
    require_checks(module('identity')[0])


IDENTITY_MUTATIONS = {
    'every provider is a person': ("    return 'gated' if provider in PERSON_PROVIDERS else 'deployment'", "    return 'gated'"),
    'the denylist of one pair is back': ("    return 'gated' if provider in PERSON_PROVIDERS else 'deployment'", "    return 'deployment' if provider == DEPLOYMENT_PROVIDER and user_id == DEPLOYMENT_USER else 'gated'"),
    'an unknown provider is a person': ("    return 'gated' if provider in PERSON_PROVIDERS else 'deployment'", "    return 'gated' if provider in PERSON_PROVIDERS or provider not in DENIED_PROVIDERS else 'deployment'"),
    'nobody is a person': ("    return 'gated' if provider in PERSON_PROVIDERS else 'deployment'", "    return 'deployment'"),
    'the provider is case-folded': ("provider in PERSON_PROVIDERS else", "provider.lower() in PERSON_PROVIDERS else"),
    'the provider is trimmed': ("provider in PERSON_PROVIDERS else", "provider.strip() in PERSON_PROVIDERS else"),
    'the provider is normalized': ("provider in PERSON_PROVIDERS else", "__import__('unicodedata').normalize('NFKC', provider) in PERSON_PROVIDERS else"),
    'the provider is matched by prefix': ("'gated' if provider in PERSON_PROVIDERS else", "'gated' if any(provider.startswith(name) for name in PERSON_PROVIDERS) else"),
    'the provider is matched by containing': ("'gated' if provider in PERSON_PROVIDERS else", "'gated' if any(name in provider for name in PERSON_PROVIDERS) else"),
    'the provider is checked without its type': ("    if type(provider) is not str or type(user_id) is not str:\n        return 'deployment'\n", ""),
    'only the provider has to be text': ("    if type(provider) is not str or type(user_id) is not str:\n        return 'deployment'\n", "    if type(provider) is not str:\n        return 'deployment'\n"),
    'the user is not checked for its type': ("type(provider) is not str or type(user_id) is not str", "type(provider) is not str"),
    'session-token is a person when listed': ("DENIED_PROVIDERS = frozenset({DEPLOYMENT_PROVIDER, 'drain-secret'})", "DENIED_PROVIDERS = frozenset({'drain-secret'})"),
    'drain-secret is a person when listed': ("DENIED_PROVIDERS = frozenset({DEPLOYMENT_PROVIDER, 'drain-secret'})", "DENIED_PROVIDERS = frozenset({DEPLOYMENT_PROVIDER})"),
    'the denied provider is not checked in the predicate': ("    if provider in DENIED_PROVIDERS or user_id == DEPLOYMENT_USER:\n        return 'deployment'\n", "    if user_id == DEPLOYMENT_USER:\n        return 'deployment'\n"),
    'the denied user is a person': ("    if provider in DENIED_PROVIDERS or user_id == DEPLOYMENT_USER:\n        return 'deployment'\n", "    if provider in DENIED_PROVIDERS:\n        return 'deployment'\n"),
    'either denied name is enough only with the user': ("provider in DENIED_PROVIDERS or user_id == DEPLOYMENT_USER", "provider in DENIED_PROVIDERS and user_id == DEPLOYMENT_USER"),
    'the denied user is compared folded': ("provider in DENIED_PROVIDERS or user_id == DEPLOYMENT_USER", "provider in DENIED_PROVIDERS or user_id.lower() == DEPLOYMENT_USER"),
    'the denied user is compared trimmed': ("provider in DENIED_PROVIDERS or user_id == DEPLOYMENT_USER", "provider in DENIED_PROVIDERS or user_id.strip() == DEPLOYMENT_USER"),
    'the denied user is matched by prefix': ("provider in DENIED_PROVIDERS or user_id == DEPLOYMENT_USER", "provider in DENIED_PROVIDERS or user_id.startswith(DEPLOYMENT_USER)"),
    'the known set lacks a provider': ("frozenset({'basic', 'nous', 'self-hosted'})", "frozenset({'basic', 'nous'})"),
    'the known set has a provider more': ("frozenset({'basic', 'nous', 'self-hosted'})", "frozenset({'basic', 'nous', 'self-hosted', 'github'})"),
    'the known set holds the deployment provider': ("frozenset({'basic', 'nous', 'self-hosted'})", "frozenset({'basic', 'nous', 'self-hosted', 'session-token'})"),
    'the declared list is dropped': ("declared_providers(os.environ.get('LUVEBOT_PERSON_PROVIDERS'))", "declared_providers(None)"),
    'the declared list is read from another variable': ("os.environ.get('LUVEBOT_PERSON_PROVIDERS')", "os.environ.get('LUVEBOT_PERSON_PROVIDER')"),
    'the declared list is read from a near variable': ("os.environ.get('LUVEBOT_PERSON_PROVIDERS')", "os.environ.get('LUVEBOT_PERSON_PROVIDERS') or os.environ.get('PERSON_PROVIDERS')"),
    'the declared list is read from a file': ("os.environ.get('LUVEBOT_PERSON_PROVIDERS')", "os.environ.get('LUVEBOT_PERSON_PROVIDERS_FILE') and os.environ.get('LUVEBOT_PERSON_PROVIDERS')"),
    'the declared list is read at every request': ("    return 'gated' if provider in PERSON_PROVIDERS else 'deployment'", "    return 'gated' if provider in KNOWN_PERSON_PROVIDERS | declared_providers(os.environ.get('LUVEBOT_PERSON_PROVIDERS'))[0] else 'deployment'"),
    'the declared list replaces the known set': ("PERSON_PROVIDERS = KNOWN_PERSON_PROVIDERS | _EXTRA", "PERSON_PROVIDERS = _EXTRA or KNOWN_PERSON_PROVIDERS"),
    'the effective list is only the declared one in health': ("    return sorted(PERSON_PROVIDERS)", "    return sorted(_EXTRA)"),
    'the effective list is not sorted': ("    return sorted(PERSON_PROVIDERS)", "    return sorted(PERSON_PROVIDERS, reverse=True)"),   # NOT `list(PERSON_PROVIDERS)`: a frozenset of 5 names iterates already sorted for 1 hash seed in 120, and the mutant then survives
    'a denied name is accepted from the list': ("PROVIDER_NAME.fullmatch(entry) and entry not in DENIED_PROVIDERS", "PROVIDER_NAME.fullmatch(entry)"),
    'a denied name is only half refused': ("PROVIDER_NAME.fullmatch(entry) and entry not in DENIED_PROVIDERS", "PROVIDER_NAME.fullmatch(entry) and entry != DEPLOYMENT_PROVIDER"),
    'any entry is a name': ("PROVIDER_NAME.fullmatch(entry) and entry not in DENIED_PROVIDERS", "entry not in DENIED_PROVIDERS"),
    'a name is matched by its start': ("PROVIDER_NAME.fullmatch(entry)", "PROVIDER_NAME.match(entry)"),
    'a name may be 64 long': ("re.compile(r'[a-z0-9-]{1,32}')", "re.compile(r'[a-z0-9-]{1,64}')"),
    'an empty entry is an ignored one': ("        if not entry:\n            continue\n", "        if False:\n            continue\n"),
    'a name may have capitals': ("re.compile(r'[a-z0-9-]{1,32}')", "re.compile(r'[A-Za-z0-9-]{1,32}')"),
    'a name may have an underscore': ("re.compile(r'[a-z0-9-]{1,32}')", "re.compile(r'[a-z0-9_-]{1,32}')"),
    'a name may have a dot': ("re.compile(r'[a-z0-9-]{1,32}')", "re.compile(r'[a-z0-9.-]{1,32}')"),
    'an entry is lowered': ("        entry = entry.strip(' \\t')\n", "        entry = entry.strip(' \\t').lower()\n"),
    'an entry is cleaned of any space': ("        entry = entry.strip(' \\t')\n", "        entry = entry.strip()\n"),
    'an entry is cleaned of every space inside': ("        entry = entry.strip(' \\t')\n", "        entry = entry.replace(' ', '')\n"),
    'an entry is normalized': ("        entry = entry.strip(' \\t')\n", "        entry = __import__('unicodedata').normalize('NFKC', entry.strip(' \\t'))\n"),
    'the list is split on more than the comma': ("(raw if type(raw) is str else '').split(',')", "__import__('re').split('[,; ]', raw if type(raw) is str else '')"),
    'a value that is not text is parsed': ("(raw if type(raw) is str else '').split(',')", "(raw or '').split(',')"),
    'an ignored entry is not counted': ("            ignored += 1\n", "            pass\n"),
    'an ignored entry is echoed': ("'LUVEBOT_PERSON_PROVIDERS: %d entries ignored (a name is 1 to 32 of a-z, 0-9 and -; session-token and drain-secret are never people)', _IGNORED)", "'LUVEBOT_PERSON_PROVIDERS: %s entries ignored', os.environ.get('LUVEBOT_PERSON_PROVIDERS'))"),
    'the declared names are not logged': ("if _EXTRA:\n    logging", "if False:\n    logging"),
    'the refusal names no provider': ("    return {'details': {'provider': name}} if code == 'credential_not_human' and name else None", "    return None"),
    'the loopback refusal names a provider': ("if code == 'credential_not_human' and name else None", "if name else None"),
    'the provider is not capped': ("name[:64] if type(name) is str and name else None", "name if type(name) is str and name else None"),
    'any value is noted as a provider': ("name[:64] if type(name) is str and name else None", "name[:64] if name else None"),
    'the credential refusal carries no details': ("PluginError('credential_not_human', CREDENTIAL_WORDS, 403, refusal_extra('credential_not_human'))", "PluginError('credential_not_human', CREDENTIAL_WORDS, 403)"),
    'the person check raises without details': ("        raise PluginError(refusal[0], refusal[1], 403, refusal_extra(refusal[0]))", "        raise PluginError(refusal[0], refusal[1], 403)"),
    'the opt-in opens the deployment credential': ("    if type(mode) is not str or mode not in LOOPBACK_MODES:\n        return ('credential_not_human', CREDENTIAL_WORDS)", "    if type(mode) is not str or mode not in LOOPBACK_MODES:\n        return None if loopback_ok else ('credential_not_human', CREDENTIAL_WORDS)"),
    'the deployment credential is let through': ("    if type(mode) is not str or mode not in LOOPBACK_MODES:\n        return ('credential_not_human', CREDENTIAL_WORDS)", "    if type(mode) is not str or mode not in LOOPBACK_MODES:\n        return None"),
    'the deployment credential answers as loopback': ("    if type(mode) is not str or mode not in LOOPBACK_MODES:\n        return ('credential_not_human', CREDENTIAL_WORDS)", "    if type(mode) is not str or mode not in LOOPBACK_MODES:\n        return ('loopback_not_human', loopback_words)"),
    'only the deployment credential is closed': ("    if type(mode) is not str or mode not in LOOPBACK_MODES:\n        return ('credential_not_human', CREDENTIAL_WORDS)", "    if type(mode) is not str or mode not in LOOPBACK_MODES:\n        return ('credential_not_human', CREDENTIAL_WORDS) if mode == 'deployment' else None"),
    'a loopback is let through': ("    return None if loopback_ok else ('loopback_not_human', loopback_words)", "    return None"),
    'the loopback opt-in is ignored': ("    return None if loopback_ok else ('loopback_not_human', loopback_words)", "    return ('loopback_not_human', loopback_words)"),
    'a person is refused': ("    if type(mode) is str and mode == 'gated':   # the type first: an object whose __eq__ says yes is not a person\n        return None\n    if type(mode) is not str or mode not in LOOPBACK_MODES:", "    if type(mode) is not str or mode not in LOOPBACK_MODES:"),
    'an object that says it equals gated is a person': ("    if type(mode) is str and mode == 'gated':", "    if mode == 'gated':"),
    'an object that says it is loopback is trusted': ("    if type(mode) is not str or mode not in LOOPBACK_MODES:\n        return ('credential_not_human', CREDENTIAL_WORDS)", "    if mode not in LOOPBACK_MODES:\n        return ('credential_not_human', CREDENTIAL_WORDS)"),
    'the refusal is not raised': ("    if refusal is not None:\n        raise PluginError(refusal[0], refusal[1], 403, refusal_extra(refusal[0]))", "    if False:\n        raise PluginError(refusal[0], refusal[1], 403, refusal_extra(refusal[0]))"),
    'the refusal is a 401': ("        raise PluginError(refusal[0], refusal[1], 403, refusal_extra(refusal[0]))", "        raise PluginError(refusal[0], refusal[1], 401, refusal_extra(refusal[0]))"),
    'the words are loopback words': ('"Sign in with a person\'s login, or ask the operator to declare the provider.")', '"This dashboard is in loopback mode.")'),
    'the code is the loopback one': ("PluginError('credential_not_human', CREDENTIAL_WORDS, 403,", "PluginError('loopback_not_human', CREDENTIAL_WORDS, 403,"),
    'the status is a 401': ("PluginError('credential_not_human', CREDENTIAL_WORDS, 403,", "PluginError('credential_not_human', CREDENTIAL_WORDS, 401,"),
}


@pytest.mark.parametrize('label', sorted(IDENTITY_MUTATIONS))
def test_each_identity_mutation_is_caught(label, monkeypatch, caplog):
    old, new = IDENTITY_MUTATIONS[label]
    built = build([(old, new)], monkeypatch, caplog)                                       # an anchor that moved fails HERE
    with pytest.raises(BaseException):  # noqa: B017
        all_checks(built)


# ---- the pieces of plugin_api.py ---------------------------------------------------------------------------------------------------------------------------
class HTTPException(Exception):
    def __init__(self, status_code):
        super().__init__(status_code)
        self.status_code = status_code


def block(text, start, end):
    return re.search(start + r'.*?(?=' + end + ')', text, re.S).group(0)


def namespace(edits=()):
    text = API
    for old, new in edits:
        assert text.count(old) == 1, old
        text = text.replace(old, new)
    ident, name = module('identity')
    package = importlib.import_module(name)
    seen = {'csrf': []}

    class Actor:
        def __init__(self, kind, id_):
            self.kind, self.id = kind, id_
    rules = types.SimpleNamespace(Actor=Actor, ActorKind=types.SimpleNamespace(HUMAN='human'))
    ns = {'identity': ident, 'HTTPException': HTTPException, '_REDACT': lambda text: text.replace('SECRET', '***'), 'rules': rules, 'os': __import__('os'),
          'PluginError': importlib.import_module(f'{name}.api_errors').PluginError, '_require_csrf': lambda request, credential: seen['csrf'].append(credential), 'AuditLog': None}
    exec(block(text, r"def _identity\(request\):", r"\n\n\nasync def _gate"), ns)
    exec(block(text, r"def _loopback_trusted\(\):", r"\n\n\ndef _audit_payload"), ns)
    exec(block(text, r"def _human_actor\(request\):", r"\n\n\n@router\.post\('/rules'\)"), ns)
    exec(re.search(r"def _budget_actor\(request, \*, raises\):.*?\n    return actor\n", text, re.S).group(0), ns)
    ns['_auth_src'] = re.search(r"'auth': (\{.*?\}),   # names only", text).group(1)         # the real expression `/health` answers, evaluated below
    ns['person_providers'] = ident.person_providers
    return ns, seen


def request(provider=None, user=None, token=TOKEN, gated=True):
    session = types.SimpleNamespace(provider=provider, user_id=user, access_token=token) if provider is not None or user is not None else None
    return types.SimpleNamespace(app=types.SimpleNamespace(state=types.SimpleNamespace(auth_required=gated)), state=types.SimpleNamespace(session=session), headers={'x-hermes-session-token': 'loop-token'})


def piece_checks(edits=(), monkeypatch=None):
    import os
    ns, seen = namespace(edits)
    # _identity: the third mode, the actor the audit records, never the token's value in it; the gate still holds
    assert ns['_identity'](request('session-token', 'deployment-token')) == ('session-token:deployment-token', TOKEN, 'deployment')
    assert ns['_identity'](request('basic', 'ana')) == ('basic:ana', TOKEN, 'gated')
    assert ns['_identity'](request('Session-Token', 'deployment-token'))[2] == 'deployment'            # a lookalike is not a person's login either: it is not on the list
    assert ns['_identity'](request('session-token', 'deployment-token ', gated=True))[2] == 'deployment'
    assert ns['_identity'](request('acme', 'ana'))[2] == 'deployment' and ns['_identity'](request('Basic', 'ana'))[2] == 'deployment'   # a provider nobody listed
    assert ns['_identity'](request('nous', 'sub-1'))[2] == 'gated' and ns['_identity'](request('self-hosted', 'sub-1'))[2] == 'gated'
    ident, shown = ns['identity'], lambda: ident.refusal_extra('credential_not_human')
    ns['_identity'](request('session-token', 'deployment-token'))                                         # the refusal names the provider, redacted and capped, and a later request clears it
    assert shown() == {'details': {'provider': 'session-token'}}
    ns['_identity'](request('basic', 'ana'))
    assert shown() is None
    ns['_identity'](request('acme-SECRET', 'ana'))
    assert shown() == {'details': {'provider': 'acme-***'}}, shown()
    ns['_identity'](request('a' * 200, 'ana'))
    assert shown() == {'details': {'provider': 'a' * 64}}
    ns['_identity'](request(gated=False))
    assert shown() is None
    ns['_identity'](request('session-token', 'deployment-token'))
    ns['_identity'](request(gated=False))
    assert shown() is None                                                                                 # loopback names no provider
    assert eval(ns['_auth_src'], dict(ns), {'request': request('basic', 'ana')}) == {'required': True, 'person_providers': ['basic', 'nous', 'self-hosted']}   # `/health` says who counts, names only
    assert eval(ns['_auth_src'], dict(ns), {'request': request(gated=False)})['required'] is False
    actor, credential, mode = ns['_identity'](request('session-token', 'deployment-token'))
    assert TOKEN not in actor and credential == TOKEN and mode == 'deployment'
    for provider, user, token in (('session-token', 'deployment-token', ''), ('session-token', '', TOKEN), ('', 'deployment-token', TOKEN), (None, None, TOKEN)):
        error = refusal(lambda: ns['_identity'](request(provider, user, token)))
        assert getattr(error, 'status_code', None) == 401, (provider, user, token)                       # no credential, or an incomplete session: the gate holds
    assert ns['_identity'](request(gated=False))[2:] == ('loopback',) and ns['_identity'](request(gated=False))[0] == 'dashboard'
    # the checks of a person: `_human` and `_human_actor` refuse the deployment credential, always; loopback only unless the installation opted in
    deployment, person, machine = request('session-token', 'deployment-token'), request('basic', 'ana'), request(gated=False)
    for opted in ('1', '0', ''):
        os.environ['LUVEBOT_ALLOW_LOOPBACK_APPROVALS'] = opted
        error = refusal(lambda: ns['_human'](deployment))
        assert (error.code, error.status, str(error)) == ('credential_not_human', 403, WORDS), (opted, error)
        assert error.extra == {'details': {'provider': 'session-token'}}, error.extra                      # and names the provider
        assert refusal(lambda: ns['_human'](request('acme', 'ana'))).extra == {'details': {'provider': 'acme'}}
        error = refusal(lambda: ns['_human_actor'](deployment))
        assert (error.code, error.status) == ('credential_not_human', 403), opted
        assert ns['_human'](person).id == 'basic:ana' and ns['_human_actor'](person).id == 'basic:ana'
        assert ns['_human_actor'](machine).id == 'dashboard'                                                # the v0 convention of loopback stays for the steps that keep it
        loopback = refusal(lambda: ns['_human'](machine))
        assert (loopback is None) == (opted == '1') and (loopback is None or loopback.code == 'loopback_not_human'), opted
        for raises in (True, False):                                                                       # a budget change: raising is for a person, lowering is a tightening
            error = refusal(lambda: ns['_budget_actor'](deployment, raises=raises))
            assert (error is None) == (not raises), (opted, raises, error)
            assert error is None or (error.code, error.status) == ('credential_not_human', 403)
            assert ns['_budget_actor'](person, raises=raises) == 'basic:ana'
            loopback = refusal(lambda: ns['_budget_actor'](machine, raises=raises))
            assert (loopback is None) == (not raises or opted == '1'), (opted, raises)
    os.environ.pop('LUVEBOT_ALLOW_LOOPBACK_APPROVALS', None)
    assert ns['_budget_actor'](deployment, raises=False) == 'session-token:deployment-token'               # the audit shows the deployment credential acted, never a person
    assert set(seen['csrf']) <= {TOKEN, 'loop-token'}                                                   # the session's token only ever reaches the CSRF derivation


def test_the_pieces_of_the_gate_refuse_the_deployment_credential():
    piece_checks()


PIECE_MUTATIONS = {
    'the third mode is not returned': [("identity.mode_of(session.provider, session.user_id) if gated else 'loopback'", "'gated' if gated else 'loopback'")],
    'the actor is the token': [("        actor = _REDACT(f'{session.provider}:{session.user_id}')\n", "        actor = _REDACT(f'{session.provider}:{session.access_token}')\n")],
    'the actor is a person label': [("    mode = identity.mode_of(session.provider, session.user_id) if gated else 'loopback'", "    mode = identity.mode_of(session.provider, session.user_id) if gated else 'loopback'\n    actor = 'dashboard' if mode == 'deployment' else actor")],
    '_human lets the deployment credential in': [("    identity.require_person(mode, 'Deciding an approval needs a dashboard with a login; this dashboard is in loopback mode.', loopback_ok=_loopback_trusted())\n",
                                                  "    if mode == 'loopback' and not _loopback_trusted():\n        raise PluginError('loopback_not_human', 'x', 403)\n")],
    '_human lets the opt-in open it': [("identity.require_person(mode, 'Deciding an approval needs a dashboard with a login; this dashboard is in loopback mode.', loopback_ok=_loopback_trusted())",
                                        "identity.require_person('loopback' if mode == 'deployment' else mode, 'Deciding an approval needs a dashboard with a login; this dashboard is in loopback mode.', loopback_ok=_loopback_trusted())")],
    '_human_actor lets the deployment credential in': [("    identity.require_person(mode, '', loopback_ok=True)   # loopback keeps its v0 convention here; the deployment credential never gets a human Actor\n", "")],
    '_budget_actor is left on the old check': [("        identity.require_person(mode, 'Raising a cap or resuming a Bot needs a dashboard with a login; this one is in loopback mode.', loopback_ok=_loopback_trusted())\n",
                                                "        if mode == 'loopback' and not _loopback_trusted():\n            raise PluginError('loopback_not_human', 'x', 403)\n")],
    '_budget_actor refuses a lowering too': [("    if raises:\n        identity.require_person(", "    if True:\n        identity.require_person(")],
    'the refusal does not name the provider': [("    identity.note_provider(_REDACT(session.provider) if mode == 'deployment' else None)   # so the refusal can name the provider (contract v0.11 5.1)\n", "")],
    'the provider is named unredacted': [("identity.note_provider(_REDACT(session.provider) if mode", "identity.note_provider(session.provider if mode")],
    'the provider of an earlier request lingers': [("identity.note_provider(_REDACT(session.provider) if mode == 'deployment' else None)", "(identity.note_provider(_REDACT(session.provider)) if mode == 'deployment' else None)")],
    'a person\'s request names its provider': [("if mode == 'deployment' else None)   # so the refusal", "if gated else None)   # so the refusal")],
    'the loopback request names a provider': [("if mode == 'deployment' else None)   # so the refusal", "if mode != 'gated' else None)   # so the refusal")],
    'health forgets who counts as a person': [("'person_providers': person_providers()},   # names only", "},   # names only")],
    'health shows the declared providers only': [("'person_providers': person_providers()},   # names only", "'person_providers': sorted(identity._EXTRA)},   # names only")],
    'health lists every provider it knows': [("'person_providers': person_providers()},   # names only", "'person_providers': ['*']},   # names only")],
    'the opt-in is read as a truthy string': [("    return os.environ.get('LUVEBOT_ALLOW_LOOPBACK_APPROVALS') == '1'", "    return bool(os.environ.get('LUVEBOT_ALLOW_LOOPBACK_APPROVALS'))")],
}


@pytest.mark.parametrize('label', sorted(PIECE_MUTATIONS))
def test_each_piece_mutation_is_caught(label):
    edits = PIECE_MUTATIONS[label]
    assert all(API.count(old) == 1 for old, _ in edits), label                          # an anchor that moved fails HERE
    with pytest.raises(BaseException):  # noqa: B017
        piece_checks(edits)


# ---- a Bot's memory ------------------------------------------------------------------------------------------------------------------
def test_the_memory_write_refuses_the_deployment_credential():
    memory, _ = module('memory')
    memory.identity.note_provider('acme')
    for mode, code, extra in (('deployment', 'credential_not_human', {'details': {'provider': 'acme'}}), ('loopback', 'loopback_not_human', {})):
        error = refusal(lambda: memory._human_only(mode))
        assert (error.code, error.status, error.extra) == (code, 403, extra), mode
    assert refusal(lambda: memory._human_only('gated')) is None


# ---- the scan: every place that decides by the mode goes through the one check -----------------------------------------------------------------------------
def test_no_human_gate_decides_by_the_mode_on_its_own():
    """The old shape was `mode == 'loopback'` and a typed 403 in each place, which a new credential walks around. Now the code of the refusal and the opt-in variable live in one place each."""
    assert API.count("'loopback_not_human'") == 0 and API.count('LUVEBOT_ALLOW_LOOPBACK_APPROVALS') == 1 and "'credential_not_human'" not in API       # (the helper `_loopback_trusted` reads the variable once)
    import ast
    modes = {'gated', 'loopback', 'deployment'}
    found = []
    for path in [ROOT / 'dashboard' / 'plugin_api.py', *sorted((ROOT / 'backend').glob('*.py'))]:
        if path.name == 'identity.py':
            continue
        tree = ast.parse(path.read_text())
        inside_identity = {id(n) for f in ast.walk(tree) if isinstance(f, ast.FunctionDef) and f.name == '_identity' for n in ast.walk(f)}
        for node in ast.walk(tree):
            if isinstance(node, ast.Compare) and id(node) not in inside_identity:
                parts = [node.left, *node.comparators]
                if any(isinstance(p, ast.Constant) and p.value in modes for p in parts) and any(isinstance(p, ast.Name) and p.id in ('mode', '_mode', 'auth_mode') for p in parts):
                    found.append((path.name, node.lineno))
    assert found == [], f'a comparison of the identity mode with a string outside identity.py and `_identity` (it would let a new mode through): {found}'
    gates = [m.group(1) for m in re.finditer(r"\n(?:async )?def (\w+)\([^)]*\):(?:(?!\n(?:async )?def |\n@router).)*?, mode = _identity\(request\)", API, re.S)]
    assert gates, 'no function unpacks the mode'
    allowed_to_read_only = {'session', '_memory_write'}                                                       # `/session` reports it; a Bot's memory (`memory._human_only(mode)`, below) refuses a `deployment` one
    for name in gates:
        body = block(API, rf"def {name}\(", r"\n\n\n(?:@router|def |async def |_[A-Z_]+ =|class )")
        assert name in allowed_to_read_only or 'identity.require_person(' in body or 'identity.human_refusal(' in body, f'{name} reads the mode and does not use the one check'
    memory_text = (ROOT / 'backend' / 'memory.py').read_text()
    assert memory_text.count('_human_only(mode)') >= 3 and 'identity.require_person(mode' in memory_text, 'every memory write asks the one check'
    human_routes = len(re.findall(r"_human\(request\)", API))
    assert human_routes >= 12, human_routes                                                                                     # the routes that need a person all go through `_human`
    assert API.count('identity.require_person(') == 6 and API.count('identity.human_refusal(') == 0
