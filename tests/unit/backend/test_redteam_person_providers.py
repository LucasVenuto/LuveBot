"""Red team (Lume, 31/10) of DT-1b (27b04ab): "only a person's login is a person", by an allowlist of provider names (contract v0.11 section 5.1).

Four things are attacked, each from the contract's own words and none from the code's:
  (1) the operator's list, `LUVEBOT_PERSON_PROVIDERS`: parsed against an INDEPENDENT reading of the rule over a hostile corpus; a denied name never gets in; read once and from the environment only;
  (2) `mode_of`: only an exact, plain-text name on the list is a person, whatever the lookalike, the type or the user;
  (3) the provider named in the refusal (`details: {provider}`), a ContextVar that `_identity` sets for each request: set before it is read in EVERY route, never by a request that did not set it, never read
      in a shared computation (see below), redacted, cut to 64, never on `loopback_not_human`, and nothing else added to the answer;
  (4) `/health` `auth.person_providers`: names only, a copy.

THE ONE MECHANISM THAT WOULD LEAK, and why the census below exists. A ContextVar is per request only where the refusal is BUILT in that request's own context: a request task, a threadpool call (starlette copies the context
there) or a function called from them. A `Flight`/`Memo` computation is ONE task started in the context of the FIRST caller and awaited by all of them (`asyncio.ensure_future` copies the context), and a Flight hands every
joiner the same exception: a gate inside it would answer the second caller with the first caller's provider (measured on real starlette + uvicorn, 31/10: the second caller got `first-prov`; 2579 other requests over
keep-alive connections, `BaseHTTPMiddleware`, `async`, `def` and threadpool routes, with and without `_identity`: 0 mixed). A plain `threading.Thread` starts with an EMPTY context (no name at all). Nothing of the kind
exists today; `test_no_gate_is_reachable_from_a_shared_computation_or_a_background_thread` keeps it so, and proves on planted sources that it would see one.

What is NOT claimed: the walk stands in for the dashboard (the same stand-ins as test_redteam_deployment_token.py), so the real-stack variant at the end runs only where starlette is installed (the harness lane)."""
import ast
import asyncio
import json
import logging
import random
import re
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_redteam_deployment_token as dt  # noqa: E402

ROOT = dt.ROOT
ENV = 'LUVEBOT_PERSON_PROVIDERS'
KNOWN = {'basic', 'nous', 'self-hosted'}
DENIED = {'session-token', 'drain-secret'}
NAME_CHARS = set('abcdefghijklmnopqrstuvwxyz0123456789-')
cp = chr


@pytest.fixture(autouse=True)
def _no_name_left_behind():
    """Some tests poison the provider noted in the harness's shared namespace (that is the attack): it must not be there for the next test of any file."""
    yield
    dt.build()['identity'].note_provider(None)


def load(monkeypatch, env):
    """backend/identity.py loaded afresh (its list is read at load) under `env` (None: variable absent)."""
    (monkeypatch.delenv(ENV, raising=False) if env is None else monkeypatch.setenv(ENV, env))
    return dt.real_identity()


# ======================================================================== (1) the operator's list ====================================================================
def reference(raw):
    """The rule as the contract words it, written with no regex and no reuse of the module's code: split on commas; only spaces and tabs trimmed; a name is 1 to 32 of a-z, 0-9 and '-'; denied names ignored (counted)."""
    if type(raw) is not str:
        return frozenset(), 0
    names, ignored = set(), 0
    for entry in raw.split(','):
        entry = entry.strip(' \t')
        if not entry:
            continue
        if 1 <= len(entry) <= 32 and set(entry) <= NAME_CHARS and entry not in DENIED:
            names.add(entry)
        else:
            ignored += 1
    return frozenset(names), ignored


def corpus():
    rnd = random.Random(20261031)
    odd = ['\u00a0', '\u200b', '\u212a', '\u0131', '\uff41', '\uff0c', '\u0663', '\u00e4', '\x00', '\u0130', '\u202e', '\ufeff', '\u2028', '\u0301', '\U0001f600']
    alphabet = list('abcxyz019-_ ,\t\n\r.:/*ABC') + odd
    frags = ['basic', 'nous', 'self-hosted', 'session-token', 'drain-secret', 'a' * 32, 'a' * 33, 'x-y', 'Basic', ' basic ', '\tnous\t', 'SESSION-TOKEN', 'session-token ', ' drain-secret\t', 'a,b', ',,', '-', '0']
    fixed = ['', ',', ',,,', 'basic', ' a , b\t', 'A', 'a_b', 'a b', 'a\nb', 'a\n', 'a\r', '\na', 'a' * 32, 'a' * 33, 'session-token', ' session-token\t', 'drain-secret,basic', 'idp\uff0cidp2', 'idp\u00a0', '\u00a0idp',
             'idp\u200b', '\u212aeep', 'basic,\u0131dp', '-', '--', '0', 'idp,' * 40, ',' * 5000, 'x' * 100000]
    out = list(fixed)
    for _ in range(3000):
        if rnd.random() < 0.5:
            out.append(''.join(rnd.choice(alphabet) for _ in range(rnd.randint(0, 40))))
        else:
            out.append(','.join(rnd.choice(frags + [''.join(rnd.choice(alphabet) for _ in range(rnd.randint(1, 12)))]) for _ in range(rnd.randint(1, 6))))
    return out


def test_the_operators_list_is_read_as_the_contract_says_over_a_hostile_corpus(monkeypatch):
    module = load(monkeypatch, None)
    for raw in corpus():
        assert module.declared_providers(raw) == reference(raw), repr(raw[:80])


@pytest.mark.parametrize('raw, names, ignored', [
    ('', set(), 0), (',', set(), 0), (' ,\t, ', set(), 0), ('idp', {'idp'}, 0), (' a , b\t', {'a', 'b'}, 0),
    ('A', set(), 1), ('a_b', set(), 1), ('a b', set(), 1), ('a\nb', set(), 1), ('a\n', set(), 1), ('a\r', set(), 1), ('\na', set(), 1),     # a newline is not "space or tab": the entry is a misfit, not trimmed
    ('a' * 32, {'a' * 32}, 0), ('a' * 33, set(), 1),
    ('idp\uff0cidp2', set(), 1), ('idp\u00a0', set(), 1), ('\u00a0idp', set(), 1), ('idp\u200b', set(), 1), ('\u212aeep', set(), 1), ('\u0131dp', set(), 1), ('\uff49dp', set(), 1), ('\u0663', set(), 1),
    ('session-token', set(), 1), (' session-token\t', set(), 1), ('drain-secret', set(), 1), ('SESSION-TOKEN', set(), 1), ('session-token,idp,drain-secret', {'idp'}, 2),
    ('basic,basic', {'basic'}, 0), ('-', {'-'}, 0), ('0', {'0'}, 0),
])
def test_the_operators_list_by_example(monkeypatch, raw, names, ignored):
    assert load(monkeypatch, None).declared_providers(raw) == (frozenset(names), ignored)


class TextSubclass(str):
    pass


@pytest.mark.parametrize('raw', [None, b'basic', 5, ['basic'], ('basic',), {'basic'}, object(), TextSubclass('basic')])
def test_a_value_that_is_not_plain_text_declares_nobody(monkeypatch, raw):
    assert load(monkeypatch, None).declared_providers(raw) == (frozenset(), 0)


def test_the_list_is_read_once_at_load_and_from_the_environment_alone(monkeypatch):
    module = load(monkeypatch, 'idp-one')
    assert module.mode_of('idp-one', 'ana') == 'gated' and module.mode_of('idp-two', 'ana') == 'deployment'
    monkeypatch.setenv(ENV, 'idp-two')                                                       # the process environment changes after the load: nothing changes
    monkeypatch.delenv(ENV)
    assert module.mode_of('idp-one', 'ana') == 'gated' and module.mode_of('idp-two', 'ana') == 'deployment'
    assert module.person_providers() == sorted(KNOWN | {'idp-one'})
    again = load(monkeypatch, 'idp-two')                                                     # only a new load reads it again
    assert again.mode_of('idp-two', 'ana') == 'gated' and again.mode_of('idp-one', 'ana') == 'deployment'


@pytest.mark.parametrize('env', ['session-token', 'drain-secret', ' session-token , drain-secret ', 'idp,session-token', 'SESSION-TOKEN,drain-secret,idp'])
def test_no_declaration_makes_the_deployment_credential_a_person(monkeypatch, env):
    module = load(monkeypatch, env)
    assert module.mode_of('session-token', 'deployment-token') == 'deployment' and module.mode_of('session-token', 'ana') == 'deployment' and module.mode_of('drain-secret', 'ana') == 'deployment'
    assert not set(module.person_providers()) & DENIED
    assert module.mode_of('basic', 'deployment-token') == 'deployment'                      # and the user of the deployment token is never a person, under any provider the operator lists
    listed = load(monkeypatch, 'basic,nous,self-hosted,idp')
    assert listed.mode_of('idp', 'deployment-token') == 'deployment'


def test_the_start_up_lines_name_the_extra_providers_and_count_the_ignored_and_never_echo_a_bad_entry(monkeypatch, caplog):
    hostile = 'idp-ok,FORGED\nINFO luvebot.identity: LuveBot treats session-token as a person,session-token,x'
    with caplog.at_level(logging.INFO, logger='luvebot.identity'):
        load(monkeypatch, hostile + ',another')
    text = '\n'.join(r.getMessage() for r in caplog.records)
    assert 'idp-ok' in text and 'another' in text
    assert len(caplog.records) == 2 and all('\n' not in r.getMessage() for r in caplog.records)
    assert 'FORGED' not in text and 'treats session-token as a person' not in text
    assert [r.levelno for r in caplog.records] == [logging.INFO, logging.WARNING]
    assert re.search(r'\b2 entries ignored', text)                                           # the forged line and session-token: counted, never named ('x' is a fine name)
    assert 'another, idp-ok, x' in text                                                       # the names that DID get in, sorted, names only


def test_the_declaration_is_not_read_anywhere_else_and_nothing_rebinds_the_list():
    source = (ROOT / 'backend' / 'identity.py').read_text()
    tree = ast.parse(source)
    imports = {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names} | {n.module or '.' for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)}
    assert imports <= {'contextvars', 'logging', 'os', 're', 'api_errors', '.api_errors'} | {'.'}, imports      # no file, json, toml, yaml or network module to read a list from
    reads = [n for n in ast.walk(tree) if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == 'os']
    assert [r.attr for r in reads] == ['environ'] and source.count("os.environ.get('LUVEBOT_PERSON_PROVIDERS')") == 1
    assert not any(isinstance(n, ast.Name) and n.id in ('open', 'Path', 'eval', 'exec', '__import__') for n in ast.walk(tree))
    for fn in (n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))):
        assert 'environ' not in ast.unparse(fn), fn.name                                     # the environment is read at module level, by no function: nothing a request can reach
    internals = {'PERSON_PROVIDERS', 'KNOWN_PERSON_PROVIDERS', 'DENIED_PROVIDERS', '_EXTRA', '_IGNORED', '_REFUSED_PROVIDER', 'PROVIDER_NAME', 'DEPLOYMENT_PROVIDER', 'DEPLOYMENT_USER'}
    found = []
    for path in [*sorted((ROOT / 'backend').glob('*.py')), dt.API_PATH, ROOT / 'dashboard' / 'plugin_entry.py']:
        if path.name == 'identity.py':
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Attribute) and node.attr in internals:
                found.append(f'{path.name}:{node.lineno}:{node.attr}')
            if isinstance(node, ast.ImportFrom) and (node.module or '').split('.')[-1] == 'identity':
                found += [f'{path.name}:{node.lineno}:from-import {a.name}' for a in node.names if a.name in internals]
    assert found == [], found                                                                # nothing outside identity.py touches the list or its guards, not even to read them


# ======================================================================== (2) mode_of ==============================================================================
class Everything(str):
    """A text that claims to be every name: equal to any string and hashing like 'basic'."""
    def __eq__(self, other):
        return True

    def __hash__(self):
        return hash('basic')


LOOKALIKES = ['Basic', 'BASIC', 'basic ', ' basic', 'basic\n', 'basic\x00', 'basic\u200b', 'b\u0430sic', '\uff42\uff41\uff53\uff49\uff43', 'basic.', 'basic-', 'basics', 'bas', 'nous\u00a0', 'Nous', 'self_hosted', 'selfhosted',
              'self-hosted ', 'SELF-HOSTED', 'session-token', 'Session-Token', 'session-token ', 'drain-secret', 'drain_secret', '', '-', 'basic,nous', 'basic;nous', 'basic nous', 'basic\u202e', '\ufeffbasic', 'bas\u00adic']


@pytest.mark.parametrize('provider', sorted(KNOWN))
def test_a_known_provider_with_an_ordinary_user_is_a_person_and_the_deployment_user_never_is(monkeypatch, provider):
    module = load(monkeypatch, None)
    assert module.mode_of(provider, 'ana') == 'gated' and module.mode_of(provider, 'deployment-token') == 'deployment'
    assert module.mode_of(provider, 'Deployment-Token') == 'gated' and module.mode_of(provider, 'deployment-token ') == 'gated'      # the user is compared exactly, like the contract says: no folding, no trimming


@pytest.mark.parametrize('provider', LOOKALIKES)
def test_a_lookalike_provider_is_the_machine_with_and_without_a_declaration(monkeypatch, provider):
    for env in (None, 'idp,basic', 'basic,nous,self-hosted'):
        assert load(monkeypatch, env).mode_of(provider, 'ana') == 'deployment', (provider, env)


@pytest.mark.parametrize('provider, user', [(None, 'ana'), (5, 'ana'), (b'basic', 'ana'), (['basic'], 'ana'), (('basic',), 'ana'), ({'basic'}, 'ana'), (object(), 'ana'), (Everything('basic'), 'ana'),
                                            ('basic', None), ('basic', 5), ('basic', b'ana'), ('basic', ['ana']), ('basic', TextSubclass('ana')), (TextSubclass('basic'), 'ana'), ('basic', Everything('x'))])
def test_a_session_part_that_is_not_plain_text_is_never_a_person_and_never_raises(monkeypatch, provider, user):
    assert load(monkeypatch, 'idp').mode_of(provider, user) == 'deployment'


# ======================================================================== (3) the provider in the refusal ==========================================================
def test_the_provider_is_noted_cut_to_64_and_only_if_it_is_plain_text(monkeypatch):
    module = load(monkeypatch, None)
    for name, expected in [('idp', 'idp'), ('x' * 64, 'x' * 64), ('x' * 65, 'x' * 64), ('x' * 10000, 'x' * 64), ('\u00e9' * 70, '\u00e9' * 64), ('\U0001f600' * 70, '\U0001f600' * 64)]:
        module.note_provider(name)
        assert module.refusal_extra('credential_not_human') == {'details': {'provider': expected}}, name[:10]
    for nothing in (None, '', 5, b'idp', ['idp'], TextSubclass('idp'), object()):
        module.note_provider('stale')
        module.note_provider(nothing)
        assert module.refusal_extra('credential_not_human') is None, repr(nothing)           # a value that is not text clears what was noted: it never keeps the previous request's name


def test_the_refusal_adds_nothing_but_the_name_and_only_to_credential_not_human(monkeypatch):
    module = load(monkeypatch, None)
    module.note_provider('idp-x')
    extra = module.refusal_extra('credential_not_human')
    assert set(extra) == {'details'} and set(extra['details']) == {'provider'}                # `_error` spreads `extra` into the error: a code, message or request_id key would overwrite them
    for other in ('loopback_not_human', 'forbidden', 'invalid_field', '', None):
        assert module.refusal_extra(other) is None
    with pytest.raises(dt.PluginError) as got:
        module.require_person('loopback', 'words')
    assert got.value.code == 'loopback_not_human' and got.value.extra == {}                   # never on loopback_not_human, even right after a name was noted
    with pytest.raises(dt.PluginError) as got:
        module.require_person('deployment', 'words')
    assert got.value.code == 'credential_not_human' and got.value.extra == {'details': {'provider': 'idp-x'}}
    assert module.human_refusal('gated', 'words') is None and module.credential_not_human().extra == {'details': {'provider': 'idp-x'}}
    assert 'idp-x' not in module.CREDENTIAL_WORDS and 'idp-x' not in str(got.value)           # the name is data beside the sentence, never inside it


def test_identity_notes_the_provider_of_a_machine_session_and_clears_it_for_anyone_else():
    ns = dt.build()
    module = ns['identity']
    for who in (lambda: dt.gated(dt.session('idp-a', 'u')), lambda: dt.gated(dt.session(*dt.PAIR)), lambda: dt.gated(dt.session('unknown-idp', 'u'))):
        module.note_provider('stale-from-another-request')
        ns['_identity'](who())
        assert module.refusal_extra('credential_not_human')['details']['provider'] in ('idp-a', 'session-token', 'unknown-idp')
    for person_or_loopback in (lambda: dt.gated(dt.PERSON()), dt.LOOPBACK):
        module.note_provider('stale-from-another-request')
        ns['_identity'](person_or_loopback())
        assert module.refusal_extra('credential_not_human') is None                          # set before read: a person's request overwrites whatever a request before it left
    module.note_provider('stale-from-another-request')
    with pytest.raises(dt.HTTPException):
        ns['_identity'](dt.gated(None))                                                      # no session: 401, there is no answer to put a name in


def test_the_provider_goes_through_the_redactor_before_it_is_noted():
    ns = dt.build()
    try:
        ns['_REDACT'] = lambda text: text.replace('sk-secret', '***')
        ns['_identity'](dt.gated(dt.session('idp-sk-secret-99', 'u')))
        assert ns['identity'].refusal_extra('credential_not_human') == {'details': {'provider': 'idp-***-99'}}
    finally:
        dt.reset()
    calls = [n for n in ast.walk(dt.TREE) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == 'note_provider']
    assert len(calls) == 1, 'note_provider is called in one place'
    inner = calls[0].args[0]                                                                  # `_REDACT(session.provider) if mode == 'deployment' else None`
    assert isinstance(inner, ast.IfExp) and isinstance(inner.body, ast.Call) and inner.body.func.id == '_REDACT' and not inner.body.keywords
    owners = [n.name for n in dt.TREE.body if isinstance(n, ast.FunctionDef) and any(c is calls[0] for c in ast.walk(n))]
    assert owners == ['_identity']
    others = [p.name for p in (ROOT / 'backend').glob('*.py') if p.name != 'identity.py' and 'note_provider' in p.read_text()]
    assert others == []                                                                       # no other module sets who is refused


def run_full(name, req):
    """Like `dt.run` but returns what was RAISED (a PluginError with its `extra`, an HTTPException) or None."""
    import inspect
    ns = dt.build()
    dt.reset()
    ns.update(dt.DRIVERS.get(name, {}))
    fn = ns[name]
    kwargs = {}
    for p in inspect.signature(fn).parameters.values():
        if p.name == 'request':
            kwargs['request'] = req
        elif p.default is inspect._empty and p.kind in (p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY):
            kwargs[p.name] = 'x'
    try:
        out = fn(**kwargs)
        if inspect.isawaitable(out):
            async def wait():
                return await out
            asyncio.run(asyncio.wait_for(wait(), 5))
        return None
    except (dt.PluginError, dt.HTTPException) as error:
        return error
    except Exception as error:  # noqa: BLE001
        return error


def test_in_every_route_the_name_in_the_refusal_is_the_name_of_that_request_even_in_one_shared_context():
    """The worst case for a ContextVar: ONE context for every 'request' (this process), each poisoned with another request's name before it runs. If no route can name a stale provider here, correctness does not depend on
    the server giving each request its own context: every gate is behind the `_identity` of its own request."""
    module = dt.build()['identity']
    refusing = []
    for _method, _path, name in dt.MUTATING:
        module.note_provider('stale-aaa')
        got = run_full(name, dt.gated(dt.session('idp-bbb', 'ana')))
        if isinstance(got, dt.PluginError) and got.code == 'credential_not_human':
            refusing.append(name)
            assert got.extra == {'details': {'provider': 'idp-bbb'}}, f'{name}: {got.extra}'
        module.note_provider('stale-aaa')
        person = run_full(name, dt.gated(dt.PERSON()))
        assert not (isinstance(person, dt.PluginError) and person.code in ('credential_not_human', 'loopback_not_human')), name
        assert not (isinstance(person, dt.PluginError) and 'stale-aaa' in repr(person.extra)), name
        module.note_provider('stale-aaa')
        loop = run_full(name, dt.LOOPBACK())
        if isinstance(loop, dt.PluginError):
            assert 'stale-aaa' not in repr(loop.extra) and (loop.code != 'loopback_not_human' or loop.extra == {}), name
        module.note_provider('stale-aaa')
        nobody = run_full(name, dt.gated(None))
        assert isinstance(nobody, dt.HTTPException) and nobody.status_code == 401, name        # a session-less request is 401, never a refusal that could carry a name
    assert set(dt.HUMAN_SENTINELS) <= set(refusing), sorted(set(dt.HUMAN_SENTINELS) - set(refusing))   # the walk reached every human gate: every one of them named the provider of its own request


def test_the_gates_outside_plugin_api_name_the_provider_too():
    module = dt.build()['identity']
    memory_gate = dt._function(ROOT / 'backend' / 'memory.py', '_human_only', identity=module)
    module.note_provider('idp-mem')
    with pytest.raises(dt.PluginError) as got:
        memory_gate('deployment')
    assert got.value.code == 'credential_not_human' and got.value.extra == {'details': {'provider': 'idp-mem'}}



# ---- the census: no gate behind a shared computation or a background thread -----------------------------------------------------------------------------------------
GATES = {'require_person', 'human_refusal', 'not_a_person', '_human_only', 'credential_not_human', 'refusal_extra'}


def _imports(tree):
    """name -> (module stem, original name) for `from .x import a as b` / `from luvebot_backend.x import a`, and alias -> module stem for `from . import x` / `from luvebot_backend import x`."""
    names, modules = {}, set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            stem = (node.module or '').split('.')[-1]
            for a in node.names:
                if node.module in (None, 'luvebot_backend') or (node.level and not node.module):
                    modules.add(a.asname or a.name)
                else:
                    names[a.asname or a.name] = (stem, a.name)
    return names, modules


def build_graph(sources):
    """{(module, function): set of (module, function)} by NAME, over-approximating: a bare name is the same module's function or an imported one, `mod.f` is that module's, `self.m`/`obj.m` is any method `m` of the
    same module. Function references that are not calls (a function handed to a pool) count as calls. Nested functions and lambdas belong to the function that holds them."""
    trees = {stem: ast.parse(src) for stem, src in sources.items()}
    defs = {stem: {} for stem in trees}
    for stem, tree in trees.items():
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                defs[stem].setdefault(node.name, []).append(node)
    graph, roots = {}, set()
    for stem, tree in trees.items():
        names, modules = _imports(tree)
        for fname, nodes in defs[stem].items():
            edges = set()
            for fn in nodes:
                for n in ast.walk(fn):
                    called = n.id if isinstance(n, ast.Name) else n.attr if isinstance(n, ast.Attribute) else None
                    if called is None:
                        continue
                    if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id in modules and n.value.id in defs:
                        edges.add((n.value.id, called))
                    elif isinstance(n, ast.Attribute):
                        edges |= {(stem, called)} if called in defs[stem] else set()
                    elif called in names:
                        edges.add(names[called])
                    elif called in defs[stem]:
                        edges.add((stem, called))
                    if called in GATES and stem != 'identity':
                        roots.add((stem, fname))
            graph[(stem, fname)] = {e for e in edges if e[0] in defs and e[1] in defs[e[0]] and e != (stem, fname)}
    return graph, roots, trees


def reaching_a_gate(graph, roots):
    """Every function that can reach a gate (a fixpoint of the reverse edges)."""
    bad = set(roots)
    changed = True
    while changed:
        changed = False
        for key, edges in graph.items():
            if key not in bad and edges & bad:
                bad.add(key)
                changed = True
    return bad


def shared_executions(stem, tree):
    """(line, kind, expression) of what runs OUTSIDE the request that started it: the computation of a Flight or Memo (3rd argument of `.run(` / `.get(` on one), a thread's `target=`, a pool's `.submit(` / `.run_in_executor(`,
    and a bare `ensure_future` / `create_task`."""
    holders = {t.id for n in ast.walk(tree) if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call) and getattr(n.value.func, 'id', '') in ('Flight', 'Memo') for t in n.targets if isinstance(t, ast.Name)}
    holders |= {t.attr for n in ast.walk(tree) if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call) and getattr(n.value.func, 'id', '') in ('Flight', 'Memo') for t in n.targets if isinstance(t, ast.Attribute)}
    out = []
    for n in ast.walk(tree):
        if not isinstance(n, ast.Call):
            continue
        attr = n.func.attr if isinstance(n.func, ast.Attribute) else getattr(n.func, 'id', '')
        owner = n.func.value if isinstance(n.func, ast.Attribute) else None
        owner_name = getattr(owner, 'id', None) or getattr(owner, 'attr', None)
        if attr in ('run', 'get') and owner_name in holders and len(n.args) >= 3:
            out.append((n.lineno, 'flight', n.args[2]))
        elif attr in ('Thread', 'Process'):
            out += [(n.lineno, 'thread', k.value) for k in n.keywords if k.arg == 'target']
        elif attr == 'submit' and n.args:
            out.append((n.lineno, 'pool', n.args[0]))
        elif attr == 'run_in_executor' and len(n.args) >= 2:
            out.append((n.lineno, 'pool', n.args[1]))
        elif attr in ('ensure_future', 'create_task') and n.args:
            out.append((n.lineno, 'task', n.args[0]))
    return out


def gate_behind_shared(sources):
    graph, roots, trees = build_graph(sources)
    bad, found = reaching_a_gate(graph, roots), []
    for stem, tree in trees.items():
        names, modules = _imports(tree)
        local = {f for (m, f) in graph if m == stem}
        for line, kind, expr in shared_executions(stem, tree):
            for n in ast.walk(expr):
                called = n.id if isinstance(n, ast.Name) else n.attr if isinstance(n, ast.Attribute) else None
                key = (n.value.id, called) if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id in modules else names.get(called) or ((stem, called) if called in local else None)
                if called in GATES or (key in bad):
                    found.append(f'{stem}:{line}:{kind}:{called}')
    return sorted(set(found))


def real_sources():
    out = {p.stem: p.read_text() for p in sorted((ROOT / 'backend').glob('*.py'))}
    out['plugin_api'] = dt.API_SOURCE
    return out


def test_no_gate_is_reachable_from_a_shared_computation_or_a_background_thread():
    sources = real_sources()
    graph, roots, trees = build_graph(sources)
    assert {('memory', '_human_only'), ('plugin_api', 'resolve_approval'), ('plugin_api', 'put_bot_skill')} <= reaching_a_gate(graph, roots)      # the census sees the gates it must
    seen = [x for stem, tree in trees.items() for x in shared_executions(stem, tree)]
    assert len(seen) >= 12, len(seen)                                                         # and the places it must look at: the Flight and Memo calls, the threads, the pools
    assert gate_behind_shared(sources) == []


@pytest.mark.parametrize('plant', [
    "async def r(request):\n    return await _FLIGHT.run('k', 0, lambda: gate())\nasync def gate():\n    identity.require_person('deployment', '')",
    "async def r(request):\n    return await _FLIGHT.run('k', 0, lambda: later())\nasync def later():\n    return await run_in_threadpool(gate2)\ndef gate2():\n    identity.require_person('deployment', '')",
    "async def r(request):\n    return await _MEMO.get('k', 0, lambda: gate())\ndef gate():\n    raise identity.credential_not_human()",
    "def r(request):\n    threading.Thread(target=gate, daemon=True).start()\ndef gate():\n    identity.require_person('deployment', '')",
    "def r(request):\n    threading.Thread(target=lambda: gate(), daemon=True).start()\ndef gate():\n    identity.human_refusal('deployment', '')",
    "async def r(request):\n    asyncio.ensure_future(gate())\nasync def gate():\n    identity.require_person('deployment', '')",
    "def r(request):\n    POOL.submit(gate)\ndef gate():\n    identity.require_person('deployment', '')",
])
def test_the_census_sees_a_gate_planted_behind_a_shared_computation(plant):
    header = "from luvebot_backend import identity\nfrom luvebot_backend.flight import Flight, Memo\n_FLIGHT = Flight()\n_MEMO = Memo(5.0)\n"
    assert gate_behind_shared({'plugin_api': header + plant, 'identity': ''}), plant


def test_the_census_keeps_quiet_for_a_computation_that_reaches_no_gate():
    ok = ("from luvebot_backend import identity\nfrom luvebot_backend.flight import Flight\n_FLIGHT = Flight()\n"
          "async def r(request):\n    identity.require_person('gated', '')\n    return await _FLIGHT.run('k', 0, lambda: read())\nasync def read():\n    return 1\n")
    assert gate_behind_shared({'plugin_api': ok, 'identity': ''}) == []


def test_the_identity_module_exists_once_so_the_name_noted_is_the_name_read():
    """The name travels in a ContextVar OWNED by the module object: a module that reached identity.py under another name (`backend.identity` beside `luvebot_backend.identity`) would hold a second
    ContextVar, and every refusal would lose its provider without any error. Everything in backend/ and the plugin imports it as a sibling (`from .identity`, `from luvebot_backend...`)."""
    bad = []
    for path in [*sorted((ROOT / 'backend').glob('*.py')), dt.API_PATH, ROOT / 'dashboard' / 'plugin_entry.py']:
        for node in ast.walk(ast.parse(path.read_text())):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ''] if isinstance(node, ast.ImportFrom) and node.level == 0 else []
            bad += [f'{path.name}:{node.lineno}:{n}' for n in names if n.split('.')[0] == 'backend']
    assert bad == [], bad


# ======================================================================== (4) /health ===============================================================================
def test_health_lists_names_only_as_a_copy_that_nobody_can_use_to_change_who_is_a_person(monkeypatch):
    module = load(monkeypatch, ' idp-1 ,IDP-2, session-token,idp-1')
    listed = module.person_providers()
    assert listed == sorted(KNOWN | {'idp-1'}) and isinstance(listed, list) and all(type(x) is str and re.fullmatch(r'[a-z0-9-]{1,32}', x) for x in listed)
    listed.append('session-token')
    listed.clear()
    assert module.person_providers() == sorted(KNOWN | {'idp-1'}) and module.mode_of('session-token', 'deployment-token') == 'deployment'
    assert json.loads(json.dumps({'auth': {'person_providers': module.person_providers()}}))['auth']['person_providers'] == sorted(KNOWN | {'idp-1'})
    assert 'IDP-2' not in json.dumps(module.person_providers()) and isinstance(module.PERSON_PROVIDERS, frozenset)
    assert load(monkeypatch, None).person_providers() == sorted(KNOWN)


def test_health_asks_for_a_login_before_it_names_anything():
    body = next(n for n in dt.TREE.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'health')
    first = [s for s in body.body if not (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant))][0]
    assert isinstance(first, ast.Expr) and isinstance(first.value, ast.Call) and first.value.func.id == '_identity'     # the first statement: 401 before anything is read
    assert 'person_providers()' in ast.unparse(body)
    got = run_full('health', dt.gated(None))
    assert isinstance(got, dt.HTTPException) and got.status_code == 401


# ======================================================================== the real stack (where starlette is installed) =============================================
def test_on_real_starlette_a_burst_of_mixed_requests_never_gets_another_requests_name():
    pytest.importorskip('starlette')
    httpx = pytest.importorskip('httpx')
    import time
    from starlette.applications import Starlette
    from starlette.concurrency import run_in_threadpool
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    ns = dt.build()
    module, identify = ns['identity'], ns['_identity']

    def attach(request):
        prov = request.headers.get('x-prov')
        request.state.session = types.SimpleNamespace(provider=prov, user_id=request.headers.get('x-user', 'ana'), access_token='tok') if prov else None

    def answer(mode):
        try:
            module.require_person(mode, 'words')
            return JSONResponse({'ok': True})
        except dt.PluginError as error:
            return JSONResponse({'code': error.code, **(error.extra or {})})

    async def in_loop(request):
        attach(request)
        mode = identify(request)[2]
        await asyncio.sleep(random.random() * 0.01)
        return answer(mode)

    def in_thread(request):                                   # a `def` route: starlette runs it in its threadpool
        attach(request)
        mode = identify(request)[2]
        time.sleep(random.random() * 0.01)
        return answer(mode)

    async def in_pool(request):                               # the gate inside `run_in_threadpool`, as memory.py is called
        attach(request)
        mode = identify(request)[2]
        await asyncio.sleep(random.random() * 0.01)
        return await run_in_threadpool(answer, mode)

    async def no_identity(request):                           # a route that never asks who it is and still reaches a gate: it must not inherit a name
        return answer('deployment')

    app = Starlette(routes=[Route('/loop', in_loop), Route('/thread', in_thread), Route('/pool', in_pool), Route('/none', no_identity)])
    app.state.auth_required = True
    provs = ['aaa', 'bbb', 'ccc-ddd', 'basic', 'nous', 'self-hosted', 'session-token', 'zz9']

    async def burst():
        rnd = random.Random(7)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://t') as client:
            jobs = []
            for i in range(400):
                p = rnd.choice(provs)
                path = rnd.choice(['/loop', '/thread', '/pool', '/none'])
                jobs.append((path, p, client.get(path, headers={'x-prov': p, 'x-user': 'deployment-token' if p == 'session-token' else 'ana'})))
            replies = await asyncio.gather(*(j[2] for j in jobs))
            return [(j[0], j[1], r.json()) for j, r in zip(jobs, replies)]
    wrong = []
    for path, p, body in asyncio.run(burst()):
        person = p in KNOWN
        if path == '/none':
            expected = {'code': 'credential_not_human'}                                           # no `_identity` in this request: refused, and no name (never another request's)
        else:
            expected = {'ok': True} if person else {'code': 'credential_not_human', 'details': {'provider': p}}
        if body != expected:
            wrong.append((path, p, body))
    assert wrong == [], wrong[:5]
