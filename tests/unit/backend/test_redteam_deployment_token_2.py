"""Red team (Lume, DT-4 part 2, 30/10) of DT-1 as committed (`backend/identity.py`, one `human_refusal`): does a human gate escape the function, does a mode get compared outside it, does the loopback opt-in open the
deployment credential, does an actor or an answer carry the token's value. Built on the harness of test_redteam_deployment_token.py (the REAL code of plugin_api.py executed with stand-ins).

What is pinned (plain tests): the three mode words are spelled in `identity.py` and in `_identity` and nowhere else in plugin_api.py or backend/ (a census of string LITERALS, which also catches `mode in ('loopback',)`,
`match` and `is`, forms the census of comparisons does not see); the session and the auth gate are read in `_identity` (and the two lines that need them), nowhere else; the credential's value goes only to
`_csrf_for` (an HMAC under a per-process key) and `_require_csrf`; the answer of `/session`, every refusal of every mutating route and the audit actor for the deployment token hold the pair's NAMES and never the
token; the opt-in opens a loopback dashboard only when it is exactly `1` and never the deployment credential or a mode nobody knows; `human_refusal` is closed for every value that is not one of the three words.
Open: F-DT6 (Info) a mode OBJECT whose `__eq__` says yes passes `human_refusal` as a person (`mode == 'gated'`): the value comes from `_identity`, so it is defence in depth; `type(mode) is str` closes it."""
import ast
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_redteam_deployment_token as dt  # noqa: E402

ROOT = dt.ROOT
WORDS = {'loopback', 'gated', 'deployment'}
identity = dt.real_identity()


def literal_sites():
    """[(file, function, word, line)] for every string literal equal to a mode word, docstrings aside, in plugin_api.py and backend/*.py."""
    out = []
    for path in [dt.API_PATH, *sorted((ROOT / 'backend').glob('*.py'))]:
        tree = ast.parse(path.read_text())
        docs = {id(n.body[0].value) for n in ast.walk(tree) if isinstance(n, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.body
                and isinstance(n.body[0], ast.Expr) and isinstance(n.body[0].value, ast.Constant)}
        parents = {id(c): n for n in ast.walk(tree) for c in ast.iter_child_nodes(n)}

        def where(node):
            while id(node) in parents:
                node = parents[id(node)]
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    return node.name
            return '<module>'
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value in WORDS and id(node) not in docs:
                out.append((path.name, where(node), node.value, node.lineno))
    return out


def test_the_three_mode_words_are_spelled_in_identity_and__identity_and_nowhere_else():
    stray = [s for s in literal_sites() if s[0] != 'identity.py' and not (s[0] == 'plugin_api.py' and s[1] == '_identity')]
    assert stray == [], stray


def test_the_session_and_the_auth_gate_are_read_in_identity_and_the_two_places_that_need_them():
    """`request.state.session`, `app.state.auth_required` and the fields of a session: nobody else decides who is asking."""
    reads = []
    for path in [dt.API_PATH, *sorted((ROOT / 'backend').glob('*.py'))]:
        tree = ast.parse(path.read_text())
        for fn in [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
            for node in ast.walk(fn):
                if isinstance(node, ast.Attribute) and node.attr in ('access_token', 'user_id') or isinstance(node, ast.Constant) and node.value in ('auth_required',):
                    reads.append((path.name, fn.name))
                if isinstance(node, ast.Attribute) and node.attr == 'session' and isinstance(node.value, ast.Attribute) and node.value.attr == 'state':
                    reads.append((path.name, fn.name))
    assert {r for r in reads if r[0] in ('plugin_api.py', 'identity.py')} <= {('plugin_api.py', '_identity'), ('plugin_api.py', 'health')}, sorted(set(reads))
    assert not [r for r in reads if r[0] not in ('plugin_api.py',) and r[0] not in ('identity.py',)], sorted(set(reads))


def test_the_credentials_value_goes_only_to_the_csrf_functions():
    """`credential` is passed to `_require_csrf` and `_csrf_for` (an HMAC under a per-process key) and nowhere else: not to a log, an audit, an answer, a Hermes call."""
    tree = ast.parse(dt.API_SOURCE)
    bad = []
    for fn in [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
        for node in ast.walk(fn):
            if isinstance(node, ast.Call):
                for arg in [*node.args, *[k.value for k in node.keywords]]:
                    if isinstance(arg, ast.Name) and arg.id == 'credential':
                        callee = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, 'attr', '?')
                        if callee not in ('_require_csrf', '_csrf_for'):
                            bad.append((fn.name, callee))
            if isinstance(node, ast.Return) and node.value is not None and fn.name not in ('_identity',):          # this one hands it to its caller, which only checks the CSRF with it
                for sub in ast.walk(node.value):
                    if isinstance(sub, ast.Name) and sub.id == 'credential' and not any(isinstance(p, ast.Call) for p in ast.walk(node.value)):
                        bad.append((fn.name, 'returned'))
    assert bad == [], bad


# ======================================================================== the token's value ==========================================================================
def test_the_session_answer_for_the_deployment_token_holds_the_pair_and_a_derived_csrf_never_the_token():
    ns = dt.build()
    dt.reset()
    ns['inactivity'] = dt.types.SimpleNamespace(seen=lambda *a: None)
    ns['_csrf_for'] = lambda credential: 'csrf-derived-' + str(abs(hash(credential)))
    answer = ns['session'](dt.gated(dt.DEPLOYMENT()))
    assert answer['actor'] == 'session-token:deployment-token' and answer['auth_mode'] == 'deployment'
    assert dt.TOKEN not in repr(answer) and answer['csrf'] != dt.TOKEN
    dt.reset()


def test_the_audit_actor_of_a_machine_write_is_the_pair_and_not_more(monkeypatch):
    monkeypatch.delenv(dt.ENV, raising=False)
    ns = dt.build()
    dt.reset()
    assert ns['_budget_actor'](dt.gated(dt.DEPLOYMENT()), raises=False) == 'session-token:deployment-token'


def test_no_answer_of_any_route_to_the_deployment_token_or_to_the_loopback_token_holds_the_token(monkeypatch):
    """Every mutating route walked with the deployment session and with the loopback header: whatever it answers (a refusal's message and extras included) is free of the token's value."""
    monkeypatch.delenv(dt.ENV, raising=False)
    leaks = []
    for _method, _path, name in dt.MUTATING:
        for who in ('deployment', 'loopback'):
            ns = dt.build()
            req = {'deployment': lambda: dt.gated(dt.DEPLOYMENT()), 'loopback': dt.LOOPBACK}[who]()
            fn = ns[name]
            dt.reset()
            ns.update(dt.DRIVERS.get(name, {}))
            kwargs = {p.name: (req if p.name == 'request' else 'x') for p in dt.inspect.signature(fn).parameters.values() if p.name == 'request' or p.default is dt.inspect._empty}
            try:
                out = fn(**kwargs)
                if dt.inspect.isawaitable(out):
                    async def wait():
                        return await out
                    dt.asyncio.run(dt.asyncio.wait_for(wait(), 5))
            except dt.PluginError as error:
                if dt.TOKEN in f'{error} {error.code} {error.extra}':
                    leaks.append((name, who))
            except Exception as error:  # noqa: BLE001
                if dt.TOKEN in str(error):
                    leaks.append((name, who, 'exception'))
    assert leaks == [], leaks


def test_the_refusal_for_the_deployment_credential_is_one_fixed_sentence_with_no_value_in_it():
    refusal = identity.human_refusal('deployment', 'loopback words')
    assert refusal == ('credential_not_human', identity.CREDENTIAL_WORDS) and 'token' not in refusal[1].lower().replace('credential', '') or 'deployment' in refusal[1]
    assert dt.TOKEN not in str(refusal)


# ======================================================================== the opt-in and the closed function ===========================================================
@pytest.mark.parametrize('value', ['0', '01', 'true', 'True', 'yes', 'on', ' 1', '1 ', '1\n', chr(0xff11), chr(0x661), '', '11', 'one'])
def test_only_exactly_1_opens_a_loopback_dashboard_and_nothing_else_does(value, monkeypatch):
    monkeypatch.setenv(dt.ENV, value)
    ns = dt.build()
    with pytest.raises(dt.PluginError) as got:
        ns['_human'](dt.LOOPBACK())
    assert got.value.code == 'loopback_not_human'


def test_the_opt_in_opens_loopback_and_never_the_deployment_credential_in_any_gate(monkeypatch):
    monkeypatch.setenv(dt.ENV, '1')
    ns = dt.build()
    assert ns['_human'](dt.LOOPBACK()).kind == 'HUMAN'
    for call in (lambda: ns['_human'](dt.gated(dt.DEPLOYMENT())), lambda: ns['_budget_actor'](dt.gated(dt.DEPLOYMENT()), raises=True), lambda: ns['_human_actor'](dt.gated(dt.DEPLOYMENT()))):
        with pytest.raises(dt.PluginError) as got:
            call()
        assert got.value.code == 'credential_not_human'


class Odd:
    pass


class AlwaysEqual:
    def __eq__(self, other):
        return True

    def __hash__(self):
        return 1


@pytest.mark.parametrize('mode', [None, '', ' ', 'GATED', 'Gated', ' gated', 'gated ', 'gated\n', 'gated\x00', 'gäted', 'deployment', 'DEPLOYMENT', 'service', 'machine', 0, 1, True, False, [], ['gated'], ('gated',), {'gated'},
                                  b'gated', b'loopback', Odd(), 5.5, chr(0x261), 'ｇａｔｅｄ'], ids=lambda m: repr(m)[:20])
@pytest.mark.parametrize('loopback_ok', [False, True])
def test_every_value_that_is_not_one_of_the_three_words_is_refused_as_a_credential_even_with_the_opt_in(mode, loopback_ok):
    refusal = identity.human_refusal(mode, 'loopback words', loopback_ok=loopback_ok)
    assert refusal is not None and refusal[0] == 'credential_not_human', (mode, refusal)


def test_the_three_words_themselves():
    assert identity.human_refusal('gated', 'w') is None and identity.human_refusal('gated', 'w', loopback_ok=True) is None
    assert identity.human_refusal('loopback', 'w') == ('loopback_not_human', 'w') and identity.human_refusal('loopback', 'w', loopback_ok=True) is None
    assert identity.human_refusal('deployment', 'w', loopback_ok=True)[0] == 'credential_not_human'


def test_an_object_that_says_it_equals_gated_is_not_a_person():
    assert identity.human_refusal(AlwaysEqual(), 'w') is not None


@pytest.mark.parametrize('provider,user_id', [('session-token', 'deployment-token'), ('Session-Token', 'deployment-token'), ('session-token', 'Deployment-Token'), (chr(0x455) + 'ession-token', 'deployment-token'), ('session-token ', 'deployment-token'),
                                              ('session-token', 'deployment-token\n'), (None, None), (1, 2), (['session-token'], ['deployment-token']), (b'session-token', b'deployment-token')])
def test_mode_of_is_an_exact_allowlist_so_the_pair_a_lookalike_and_a_value_that_is_not_text_are_all_the_machine(provider, user_id):
    """DT-1b (contract v0.11 5.1): none of these providers is on the list (`basic`, `nous`, `self-hosted` and the operator's), so none is a person's login; a value that is not text is nobody's."""
    assert identity.mode_of(provider, user_id) == 'deployment'
