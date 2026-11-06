"""P2-1 (contract v0.10 section 2): routine suggestions from Hermes: the adapter (in the Bot's store scope, with probes), the shaping and the `supported` verdict, and `GET /routine-suggestions`.
Everything in a record is text a model or a skill wrote: it is bounded, cleaned, redacted and plain; a spec that carries a key LuveBot's create path does not know, a delivery outside LuveBot, `no_agent`,
a spec the create path refuses, or text over the limits is `supported: false` with a reason in words and the key NAMES, never their values. The stand-ins for Hermes are the module `cron.suggestions`
and `hermes_cli.web_server_cron`; nothing here needs Hermes, fastapi or starlette.
Mutations: one line of each changed -> red."""
import asyncio
import contextlib
import importlib
import json
import re
import sys
import tempfile
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_config_boundary_threads as threads  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
HOSTILE = '<script>alert(1)</script> [Approve](https://evil.example) ' + 'x' * 10


def module(edits=()):
    """backend/routine_suggestions.py as a module of a package of its own (it imports `routines`), with `edits` applied (anchors must occur once)."""
    name, _ = threads.package()
    return threads.variant(name, 'routine_suggestions', edits)


def record(**fields):
    base = {'id': 'a1b2c3d4e5f6', 'title': 'Weekly review', 'description': 'Every Monday, a summary of the week.', 'source': 'catalog', 'dedup_key': 'weekly-review', 'status': 'pending',
            'created_at': 1000.0, 'job_spec': {'name': 'Weekly review', 'schedule': '0 9 * * 1', 'prompt': 'Summarize the week.'}}
    return {**base, **fields}


def spec(**extra):
    return {'name': 'Weekly review', 'schedule': '0 9 * * 1', 'prompt': 'Summarize the week.', **extra}


def checks(m):
    view = m.view
    # a plain suggestion: supported, the display subset, bounded
    item = view('vendas', record())
    assert item == {'bot': 'vendas', 'id': 'a1b2c3d4e5f6', 'title': 'Weekly review', 'description': 'Every Monday, a summary of the week.', 'source': 'catalog', 'created_at': 1000.0,
                    'spec': {'name': 'Weekly review', 'schedule': '0 9 * * 1', 'prompt': 'Summarize the week.'}, 'supported': True,
                    'truncated': {'title': False, 'description': False, 'prompt': False}}, item
    assert set(m.ACCEPTED_KEYS) == set(m.SPEC_KEYS) == {'name', 'schedule', 'prompt', 'skills', 'model', 'deliver', 'no_agent', 'enabled_toolsets'}

    # a key outside the allowlist: the NAMES, never the values
    for key in ('script', 'workdir', 'provider', 'base_url', 'start', 'template', 'bot', 'repeat'):
        item = view('vendas', record(job_spec=spec(**{key: 'S3CRET-VALUE /etc/passwd'})))
        assert item['supported'] is False and item['why_not'] == 'unsupported_fields' and item['fields'] == [key], (key, item)
        assert 'S3CRET-VALUE' not in json.dumps(item) and key not in item['spec'], item
    item = view('vendas', record(job_spec=spec(script='x', **{HOSTILE: 1, 'a b': 2})))
    assert item['why_not'] == 'unsupported_fields' and sorted(item['fields']) == ['other', 'other', 'script'] and HOSTILE not in json.dumps(item), item        # a hostile NAME is never said aloud
    assert len(view('vendas', record(job_spec=spec(**{f'k{i}': 1 for i in range(100)})))['fields']) == m.LIST_MAX

    # a delivery outside LuveBot is never created from here
    for deliver in ('telegram:123', 'slack:#general', 'origin', 'email:a@b.c'):
        item = view('vendas', record(job_spec=spec(deliver=deliver)))
        assert item['supported'] is False and item['why_not'] == 'delivery_outside', (deliver, item)
    assert view('vendas', record(job_spec=spec(deliver='local')))['supported'] is True
    assert view('vendas', record(job_spec=spec(no_agent=True)))['why_not'] == 'no_agent'
    assert view('vendas', record(job_spec=spec(no_agent=False)))['supported'] is True

    # a spec LuveBot's own create path refuses
    for bad in ({'name': 'x', 'prompt': 'p'}, {'name': 'x', 'schedule': {'kind': 'cron'}, 'prompt': 'p'}, {'name': 'x', 'schedule': '0 9 * * 1'}, {'name': 'x', 'schedule': '0 9 * * 1', 'prompt': '   '},
                {'name': 'x', 'schedule': '0 9 * * 1', 'prompt': 'p', 'skills': 'not-a-list'}, {'name': 7, 'schedule': '0 9 * * 1', 'prompt': 'p'}, {'name': 'x', 'schedule': '0 9 * * 1', 'prompt': 'p', 'deliver': None}):
        item = view('vendas', record(job_spec=bad))
        assert item['supported'] is False and item['why_not'] == 'invalid_spec', (bad, item)
    for not_a_spec in (None, 'text', ['x'], 7):
        assert view('vendas', record(job_spec=not_a_spec))['why_not'] == 'invalid_spec'
    assert view('vendas', record(job_spec=spec(skills=['a', 'b'], model='m', enabled_toolsets=['web', 'no_mcp'])))['spec']['skills'] == ['a', 'b']

    # the limits: over them it is `too_large` with the cut text, never a long one
    item = view('vendas', record(title='t' * 121))
    assert item['why_not'] == 'too_large' and item['truncated'] == {'title': True, 'description': False, 'prompt': False} and item['title'] == 't' * 120, item
    item = view('vendas', record(description='d' * 601))
    assert item['why_not'] == 'too_large' and item['truncated']['description'] is True and item['description'] == 'd' * 600
    item = view('vendas', record(job_spec=spec(prompt='p' * 5000)))
    assert item['why_not'] == 'too_large' and item['truncated']['prompt'] is True and item['spec']['prompt'] == 'p' * 4096, item
    item = view('vendas', record(job_spec=spec(prompt='é' * 3000)))                                              # the prompt is cut in BYTES, on a character
    assert item['truncated']['prompt'] is True and len(item['spec']['prompt'].encode()) <= 4096 and item['spec']['prompt'] == 'é' * 2048, len(item['spec']['prompt'])
    assert view('vendas', record(job_spec=spec(prompt='p' * 4096)))['supported'] is True
    assert view('vendas', record(job_spec=spec(prompt='x' * (1 << 20)), title='t' * (1 << 20)))['truncated']['title'] is True      # a megabyte is bounded
    assert view('vendas', record(job_spec=spec(extra=1) | {'prompt': 'p' * 5000}))['why_not'] == 'unsupported_fields'            # the first reason that holds, in the contract's order

    # text is data: no control character, no lone surrogate (it could not be encoded), no bidi override; never an HTML or Markdown that is rendered; a hostile text stays text
    item = view('vendas', record(title='a\x00b\x1b[31mc\u202ed\ud800e\nf', description='x\x07y\u2066z\u200ew\ttab\nline', job_spec=spec(prompt='p\x00q\u202e\ud800r\nline2')))
    assert item['title'] == 'ab[31mcde f', item['title']
    assert item['description'] == 'xyzw\ttab\nline', repr(item['description'])
    assert item['spec']['prompt'] == 'pqr\nline2', repr(item['spec']['prompt'])
    json.dumps(item, ensure_ascii=False).encode('utf-8')                                                          # encodable, whatever the record held
    item = view('vendas', record(title=HOSTILE, description=HOSTILE, job_spec=spec(prompt=HOSTILE)))
    assert item['title'] == HOSTILE and item['description'] == HOSTILE and item['supported'] is True            # shown as the text it is (the screen renders plain text)

    # redaction happens on the WHOLE text, before the cut: a secret cut in half would show its first half
    redact = lambda text: text.replace('SECRETVALUE', '***')  # noqa: E731
    item = view('vendas', record(title='x' * 115 + 'SECRETVALUE tail'), redact)
    assert 'SECRET' not in item['title'] and item['title'] == 'x' * 115 + '*** t', item['title']
    seen = []
    view('vendas', record(description='d' * (1 << 20)), lambda text: seen.append(len(text)) or text)           # and a megabyte never goes through the redactor whole
    assert max(seen) <= 65536, seen
    item = view('vendas', record(job_spec=spec(prompt='token SECRETVALUE', skills=['SECRETVALUE'], name='SECRETVALUE', deliver='local')), redact)
    assert 'SECRET' not in json.dumps(item), item                                                                  # every text of the spec, lists included

    # the id is the 12-hex id only: an index, a title, a path or an upper-case id is not an item
    for bad in ('1', 'Weekly review', '../x', 'A1B2C3D4E5F6', 'a1b2c3d4e5f', 'a1b2c3d4e5f67', 'a1b2c3d4e5f\n', None, 7, ['a1b2c3d4e5f6']):
        assert view('vendas', record(id=bad)) is None, bad
    for bad in (None, 'x', 7, ['x'], record(status='accepted'), record(status='dismissed'), record(status='anything')):
        assert view('vendas', bad) is None, bad
    assert view('vendas', record(status=None))['id'] == 'a1b2c3d4e5f6'

    # source and created_at
    assert [view('vendas', record(source=s))['source'] for s in ('catalog', 'blueprint', 'usage', 'integration', 'mine', None, 7)] == ['catalog', 'blueprint', 'usage', 'integration', 'other', 'other', 'other']
    assert [view('vendas', record(created_at=c))['created_at'] for c in (5, 5.5, float('nan'), float('inf'), True, None, {'a': 1}, '2026-10-30T10:00:00Z', 'x' * 100)] == \
           [5, 5.5, None, None, None, None, None, '2026-10-30T10:00:00Z', 'x' * 40]

    # the list: oldest first, at most 5 (Hermes's ceiling is shown, never raised), a record that is not usable is left out, a list that is not a list is nothing
    records = [record(id=f'{i:012x}', created_at=100 - i, title=f't{i}') for i in range(8)] + [record(id='bad'), 'x', None]
    got = m.items_of('vendas', records)
    assert [i['title'] for i in got] == ['t7', 't6', 't5', 't4', 't3'], [i['title'] for i in got]
    mixed = m.items_of('vendas', [record(id='000000000001', created_at='2026-02-01'), record(id='000000000002', created_at=5), record(id='000000000003', created_at=None)])
    assert [i['id'] for i in mixed] == ['000000000002', '000000000001', '000000000003'], mixed
    for not_a_list in (None, 'x', {'a': 1}, 7):
        assert m.items_of('vendas', not_a_list) == []
    assert m.items_of('vendas', []) == []


def test_the_shaping_and_the_verdict_of_a_suggestion():
    checks(module())


MUTATIONS = {
    'a key outside the allowlist is accepted': ('    odd = sorted(str(k) for k in job_spec if k not in ACCEPTED_KEYS)', '    odd = []'),
    'the values of the keys are said': ('return "unsupported_fields", [_field(k) for k in odd[:LIST_MAX]]', 'return "unsupported_fields", [f"{k}={job_spec[k]}" for k in odd[:LIST_MAX]]'),
    'any key name is said': ('return name if _FIELD.fullmatch(name) else "other"', 'return name'),
    'no ceiling on the names': ('[_field(k) for k in odd[:LIST_MAX]]', '[_field(k) for k in odd]'),
    'a delivery outside is created': ('if isinstance(deliver, str) and deliver != "local":', 'if False:'),
    'only telegram is outside': ('if isinstance(deliver, str) and deliver != "local":', 'if isinstance(deliver, str) and deliver.startswith("telegram"):'),
    'no_agent is created': ('    if job_spec.get("no_agent"):', '    if False:'),
    'the create path is not asked': ('        routines.validate_create({"bot": bot, **job_spec})', '        pass'),
    'a spec that is not an object is fine': ('    if not isinstance(job_spec, dict):\n        return "invalid_spec", None\n', ''),
    'too large is supported': ('    if too_large:\n        return "too_large", None\n', ''),
    'the prompt limit is characters not bytes': ('    size = len(shown.encode("utf-8", "ignore")) if utf8 else len(shown)', '    size = len(shown)'),
    'the cut of the prompt is not in bytes': ('shown = shown.encode("utf-8", "ignore")[:limit].decode("utf-8", "ignore") if utf8 else shown[:limit]', 'shown = shown[:limit]'),
    'a megabyte goes through the redactor': ('shown = _clean(redact(value[:_LOOKED_AT]), line)', 'shown = _clean(redact(value), line)'),
    'the text is cut before it is redacted': ('shown = _clean(redact(value[:_LOOKED_AT]), line)', 'shown = _clean(redact(value[:limit]), line)'),
    'a control character stays': ('unicodedata.category(c) not in ("Cc", "Cs")', 'unicodedata.category(c) not in ("Cs",)'),
    'a lone surrogate stays': ('unicodedata.category(c) not in ("Cc", "Cs")', 'unicodedata.category(c) not in ("Cc",)'),
    'a bidi override stays': ('and c not in _BIDI)', ')'),
    'the title keeps its newlines': ('return " ".join(kept.split()) if line else kept', 'return kept'),
    'any id is an item': ('ID = re.compile(r"[0-9a-f]{12}")', 'ID = re.compile(r".+")'),
    'a longer id is an item': ('ID = re.compile(r"[0-9a-f]{12}")', 'ID = re.compile(r"[0-9a-f]{12,}")'),
    'a record that is not pending is shown': ('    if not isinstance(record, dict) or record.get("status") not in (None, "pending"):', '    if not isinstance(record, dict):'),
    'a source that nobody knows is shown': ('"source": source if source in SOURCES else "other"', '"source": source'),
    'a time that is not finite is shown': ('elif isinstance(created, bool) or not (isinstance(created, (int, float)) and math.isfinite(created)):', 'elif False:'),
    'Hermes ceiling is raised': ('return sorted(items, key=_order)[:PENDING_MAX]', 'return sorted(items, key=_order)'),
    'newest first': ('return sorted(items, key=_order)[:PENDING_MAX]', 'return sorted(items, key=_order, reverse=True)[:PENDING_MAX]'),
    'a bad record breaks the list': ('    items = [item for item in (view(bot, record, redact) for record in records) if item is not None]', '    items = [view(bot, record, redact) for record in records]'),
    'the verdict is not shown when it fails': ('    if why is not None:\n        item["why_not"] = why\n', '    if why is not None:\n'),
}


@pytest.mark.parametrize('label', sorted(MUTATIONS))
def test_each_shaping_mutation_is_caught(label):
    old, new = MUTATIONS[label]
    m = module([(old, new)])                                           # an anchor that moved fails HERE, not inside the raises below
    with pytest.raises(BaseException):  # noqa: B017
        checks(m)


# ---- the adapter -----------------------------------------------------------------------------------------------------------------------------------
class Scope:
    """Stand-ins for `hermes_cli.web_server_cron` and `cron.suggestions`: every call of the suggestion module records WHERE it ran (inside which Bot's store scope, or none)."""
    def __init__(self, drop=()):
        self.inside, self.log, self.drop = None, [], set(drop)
        outer = self

        def home(bot):
            outer.log.append(('home', bot))
            return (bot, f'/homes/{bot}')          # Hermes's `_cron_profile_home` answers (profile name, HERMES_HOME), not the path alone

        @contextlib.contextmanager
        def store_scope(path):
            if not isinstance(path, (str, Path)):  # the real one wants a path: a tuple is the TypeError the Forja measured on v0.22.5
                raise TypeError(f'argument should be a str or an os.PathLike object, not {type(path).__name__}')
            outer.log.append(('enter', path))
            outer.inside = path
            try:
                yield
            finally:
                outer.inside = None
                outer.log.append(('exit', path))
        cron = types.ModuleType('hermes_cli.web_server_cron')
        cron._cron_profile_home, cron._cron_store_scope = home, store_scope
        suggestions = types.ModuleType('cron.suggestions')

        def make(name, result):
            def call(*args):
                outer.log.append((name, args, outer.inside))
                return result
            return call
        suggestions.list_pending = make('list_pending', [{'id': 'a1b2c3d4e5f6'}])
        suggestions.get_suggestion = make('get_suggestion', {'id': 'a1b2c3d4e5f6', 'status': 'pending'})
        suggestions.dismiss_suggestion = make('dismiss_suggestion', True)
        suggestions._set_status = make('_set_status', True)
        for name in self.drop:
            for target in (cron, suggestions):
                if hasattr(target, name):
                    delattr(target, name)
        self.modules = {'hermes_cli': types.ModuleType('hermes_cli'), 'hermes_cli.web_server_cron': cron, 'cron': types.ModuleType('cron'), 'cron.suggestions': suggestions}
        self.modules['hermes_cli'].web_server_cron = cron
        self.modules['cron'].suggestions = suggestions

    @contextlib.contextmanager
    def installed(self):
        saved = {k: sys.modules.get(k) for k in self.modules}
        sys.modules.update(self.modules)
        try:
            yield self
        finally:
            for key, previous in saved.items():
                if previous is None:
                    sys.modules.pop(key, None)
                else:
                    sys.modules[key] = previous


def adapter(edits=()):
    name, _ = threads.package()
    return threads.variant(name, 'hermes_cron', edits)


def adapter_checks(cron):
    with Scope().installed() as scope:
        assert [cron.suggestions_available(route) for route in ('list', 'dismiss', 'accept')] == [(True, [])] * 3
        assert cron.list_suggestions('vendas') == [{'id': 'a1b2c3d4e5f6'}]
        assert cron.get_suggestion('vendas', 'a1b2c3d4e5f6') == {'id': 'a1b2c3d4e5f6', 'status': 'pending'}
        assert cron.dismiss_suggestion('vendas', 'a1b2c3d4e5f6') is True
        assert cron.resolve_accepted('vendas', 'a1b2c3d4e5f6') is True
        calls = [entry for entry in scope.log if entry[0] in ('list_pending', 'get_suggestion', 'dismiss_suggestion', '_set_status')]
        assert [(c[0], c[1]) for c in calls] == [('list_pending', ()), ('get_suggestion', ('a1b2c3d4e5f6',)), ('dismiss_suggestion', ('a1b2c3d4e5f6',)), ('_set_status', ('a1b2c3d4e5f6', 'accepted'))], calls
        assert all(c[2] == '/homes/vendas' for c in calls), calls                                     # every call INSIDE the Bot's own store scope
        assert [e for e in scope.log if e[0] == 'enter'] == [('enter', '/homes/vendas')] * 4 and scope.inside is None
    with Scope().installed() as scope:                                                                # `list_pending` returning nothing is an empty list, not a failure
        sys.modules['cron.suggestions'].list_pending = lambda: None
        assert cron.list_suggestions('vendas') == []
    needs = {'list': ('list_pending',), 'dismiss': ('get_suggestion', 'dismiss_suggestion'), 'accept': ('get_suggestion', '_set_status')}
    for missing in ('_cron_profile_home', '_cron_store_scope', 'list_pending', 'get_suggestion', 'dismiss_suggestion', '_set_status'):
        with Scope(drop=[missing]).installed():
            for route, funcs in needs.items():                                                         # the scope helpers are needed by all; a function only by the routes that call it
                ok, names = cron.suggestions_available(route)
                assert ok is (missing not in (*funcs, '_cron_profile_home', '_cron_store_scope')) and names == ([missing] if not ok else []), (missing, route, names)
    saved = {k: sys.modules.pop(k, None) for k in ('hermes_cli', 'hermes_cli.web_server_cron', 'cron', 'cron.suggestions')}
    try:
        sys.modules['hermes_cli'] = None                                                              # no Hermes at all: every probe is missing, nothing raises
        sys.modules['cron'] = None
        for route, funcs in needs.items():
            ok, names = cron.suggestions_available(route)
            assert ok is False and sorted(names) == sorted(('_cron_profile_home', '_cron_store_scope', *funcs)), (route, names)
    finally:
        for key in ('hermes_cli', 'cron'):
            sys.modules.pop(key, None)
        for key, previous in saved.items():
            if previous is not None:
                sys.modules[key] = previous


def test_the_adapter_calls_the_suggestion_module_inside_the_bots_store_scope():
    adapter_checks(adapter())


ADAPTER_MUTATIONS = {
    'outside the store scope': ('    with cron._cron_store_scope(cron._cron_profile_home(bot)[1]):   # `_cron_profile_home(profile)` is (profile name, HERMES_HOME): the scope wants the Path (web_server_cron.py#L113-L124)\n        from cron import suggestions\n        return getattr(suggestions, name)(*args)',
                                '    with cron._cron_store_scope(cron._cron_profile_home(bot)[1]):\n        pass\n    from cron import suggestions\n    return getattr(suggestions, name)(*args)'),
    'the wrong Bot home': ('cron._cron_store_scope(cron._cron_profile_home(bot)[1])', 'cron._cron_store_scope(cron._cron_profile_home("default")[1])'),
    'the whole tuple is the home': ('cron._cron_store_scope(cron._cron_profile_home(bot)[1])', 'cron._cron_store_scope(cron._cron_profile_home(bot))'),
    'the name is the home': ('cron._cron_store_scope(cron._cron_profile_home(bot)[1])', 'cron._cron_store_scope(cron._cron_profile_home(bot)[0])'),
    'accept sets the wrong status': ('return _suggestion_call(bot, "_set_status", suggestion_id, "accepted")', 'return _suggestion_call(bot, "_set_status", suggestion_id, "dismissed")'),
    'accept calls Hermes accept_suggestion': ('return _suggestion_call(bot, "_set_status", suggestion_id, "accepted")', 'return _suggestion_call(bot, "accept_suggestion", suggestion_id)'),
    'accept does not need the private setter': ('"accept": ("get_suggestion", "_set_status")', '"accept": ("get_suggestion",)'),
    'list needs the private setter': ('"list": ("list_pending",)', '"list": ("list_pending", "_set_status")'),
    'dismiss needs nothing of its own': ('"dismiss": ("get_suggestion", "dismiss_suggestion")', '"dismiss": ("get_suggestion",)'),
    'the scope helpers are not probed': ('SUGGESTION_SCOPE = ("_cron_profile_home", "_cron_store_scope")', 'SUGGESTION_SCOPE = ("_cron_profile_home",)'),
    'a missing module is not missing': ('        missing += list(funcs)\n    return not missing, missing', '        pass\n    return not missing, missing'),
    'an empty answer fails': ('return list(_suggestion_call(bot, "list_pending") or [])', 'return list(_suggestion_call(bot, "list_pending"))'),
}


@pytest.mark.parametrize('label', sorted(ADAPTER_MUTATIONS))
def test_each_adapter_mutation_is_caught(label):
    old, new = ADAPTER_MUTATIONS[label]
    cron = adapter([(old, new)])
    with pytest.raises(BaseException):  # noqa: B017
        adapter_checks(cron)


# ---- the route ---------------------------------------------------------------------------------------------------------------------------------------
API = (ROOT / 'dashboard' / 'plugin_api.py').read_text()


def route_run(records_by_bot, *, names=('vendas', 'compras'), available=True, edits=(), epoch=None):
    """GET /routine-suggestions with stand-ins: the real route and `_need_suggestions` as written, the real Memo, the real shaping. -> (status of the answer or the error code, body)."""
    text = API
    for old, new in edits:
        assert text.count(old) == 1, old
        text = text.replace(old, new)
    route = re.search(r"@router\.get\('/routine-suggestions'\)\nasync def list_routine_suggestions.*?(?=\n\n\n@router)", text, re.S).group(0)
    need = re.search(r"async def _need_suggestions\(route='list'\):.*?(?=\n\n\ndef _cap_of)", text, re.S).group(0)
    deep = re.search(r"def _redact_deep\(value\):.*?(?=\n\n\nasync def _room_call)", text, re.S).group(0)
    pending = re.search(r"def _pending_suggestions\(name\):.*?(?=\n\n\n@router\.get\('/routine-suggestions'\))", text, re.S).group(0)
    name, _ = threads.package()
    pkg = importlib.import_module(name)
    flight = threads.variant(name, 'flight')
    shaping = threads.variant(name, 'routine_suggestions')
    calls = []

    class PluginError(Exception):
        def __init__(self, code, message, status):
            self.code, self.status = code, status
            super().__init__(message)

    async def run_in_threadpool(fn, *args):
        calls.append((fn.__name__, args))
        return fn(*args)

    async def direct(fn, *args):                                           # what a route that skips the pool would do: call it on the loop
        return fn(*args)

    def list_suggestions(bot):
        value = records_by_bot[bot]
        if isinstance(value, BaseException):
            raise value
        return value
    hermes_cron = types.SimpleNamespace(suggestions_available=lambda route='list': (available, [] if available else ['list_pending']), list_suggestions=list_suggestions)
    db = Path(tempfile.mkdtemp()) / 'luvebot.db'

    async def names_():
        return list(names)

    class Response:
        def __init__(self, content, headers=None):
            self.content = content
    ns = {'router': types.SimpleNamespace(get=lambda path: (lambda fn: fn)), 'Request': object, 'JSONResponse': Response, '_identity': lambda request: None, '_names': names_, '_EPOCH': epoch or [0],
          '_stores': lambda: (None, types.SimpleNamespace(path=db)), '_SUGGESTIONS': flight.Memo(15.0), 'run_in_threadpool': run_in_threadpool, '_direct': direct, 'hermes_cron': hermes_cron, 'routine_suggestions': shaping, 'PluginError': PluginError,
          '_REDACT': lambda text: text.replace('SECRETVALUE', '***'), '_HEADERS': {}}
    exec(deep, ns)
    exec(need, ns)
    exec(pending, ns)
    exec(route, ns)
    try:
        answer = asyncio.run(ns['list_routine_suggestions'](object()))
    except PluginError as error:
        return error.code, error.status, calls
    return answer.content, None, calls


def route_checks(edits=()):
    one = record()
    body, _, calls = route_run({'vendas': [one, record(id='b1b2c3d4e5f6', created_at=500.0)], 'compras': []}, edits=edits)
    assert [i['bot'] for i in body['items']] == ['vendas', 'vendas'] and [i['id'] for i in body['items']] == ['b1b2c3d4e5f6', 'a1b2c3d4e5f6'] and body['partial'] == [], body    # oldest first within a Bot
    assert [c[0] for c in calls] == ['_pending_suggestions', 'items_of', '_pending_suggestions', 'items_of'], calls                  # the read AND the shaping (P-3b: it redacts, so it can wait on the child) in the thread pool, once per Bot
    # a Bot whose file cannot be read is `partial`, the others are still listed: never a guess
    body, _, _ = route_run({'vendas': OSError('damaged SECRETVALUE'), 'compras': [one]}, edits=edits)
    assert body['partial'] == ['vendas'] and [i['bot'] for i in body['items']] == ['compras'] and 'SECRET' not in json.dumps(body), body
    body, _, _ = route_run({'vendas': ValueError('x'), 'compras': OSError('y')}, edits=edits)
    assert body == {'items': [], 'partial': ['vendas', 'compras']}, body                                                           # nothing listed is NOT "no suggestions": the Bots are named
    # a Hermes without the helpers: capability_missing, never an empty list that looks like "nothing to suggest"
    code, status, calls = route_run({'vendas': [one], 'compras': []}, available=False, edits=edits)
    assert (code, status, calls) == ('capability_missing', 409, []), (code, status, calls)
    # everything text is redacted again on the way out, and nothing is HTML
    body, _, _ = route_run({'vendas': [record(title='SECRETVALUE and <b>bold</b>')], 'compras': []}, edits=edits)
    assert body['items'][0]['title'] == '*** and <b>bold</b>', body
    # the cache: the Memo itself is proven in its own tests; here, that the route asks it under the epoch of the changes (accept and dismiss bump it)
    assert "_SUGGESTIONS.get(('routine-suggestions', name), _EPOCH[0]," in API


def test_get_routine_suggestions_lists_every_bot_names_the_unreadable_and_needs_the_helpers():
    route_checks()


ROUTE_MUTATIONS = {
    'an unreadable Bot is an empty list': [("        except Exception:\n            partial.append(name)\n            continue\n        items.extend(await run_in_threadpool(routine_suggestions.items_of, name, records, _REDACT))",
                                          "        except Exception:\n            continue\n        items.extend(await run_in_threadpool(routine_suggestions.items_of, name, records, _REDACT))")],
    'a failure breaks the whole list': [("        except Exception:\n            partial.append(name)\n            continue\n", "        except KeyError:\n            partial.append(name)\n            continue\n")],
    'the helpers are not needed': [("    await _need_suggestions()\n    items, partial = [], []", "    items, partial = [], []")],
    'not read in the thread pool': [("lambda name=name: run_in_threadpool(_pending_suggestions, name))", "lambda name=name: _direct(_pending_suggestions, name))")],
    'no partial in the answer': [("{'items': items, 'partial': partial}", "{'items': items}")],
    'the shaping is skipped': [("items.extend(await run_in_threadpool(routine_suggestions.items_of, name, records, _REDACT))", "items.extend(records)")],
    'the capability probe is not the suggestions one': [("    ok, _missing = hermes_cron.suggestions_available(route)\n    if not ok:\n        raise PluginError('capability_missing', 'This Hermes does not provide the suggestion helpers",
                                                     "    ok = True\n    if not ok:\n        raise PluginError('capability_missing', 'This Hermes does not provide the suggestion helpers")],
}


@pytest.mark.parametrize('label', sorted(ROUTE_MUTATIONS))
def test_each_route_mutation_is_caught(label):
    edits = ROUTE_MUTATIONS[label]
    assert all(API.count(old) == 1 for old, _ in edits), label                                         # an anchor that moved fails HERE
    with pytest.raises(BaseException):  # noqa: B017
        route_checks(edits)


def test_the_route_is_behind_the_session_and_reads_through_the_boundary_pool():
    route = re.search(r"@router\.get\('/routine-suggestions'\)\nasync def list_routine_suggestions.*?(?=\n\n\n@router)", API, re.S).group(0)
    assert route.index('_identity(request)') < route.index('_need_suggestions()') < route.index('_names()')                  # the session first (invariant 2), then the helpers, then Hermes
    assert 'run_in_threadpool(_pending_suggestions' in route and 'hermes_cron.list_suggestions(' not in route and '_pending_suggestions(' not in route.replace('run_in_threadpool(_pending_suggestions', '')


def test_luvebot_never_creates_or_accepts_a_suggestion_through_hermes():
    """It lists, dismisses, and resolves a record with the setter AFTER its own routine exists: never `add_suggestion` (nothing is made up here) and never `accept_suggestion` (it would create the job
    active, from a spec a model wrote)."""
    import ast
    for rel in ('dashboard/plugin_api.py', 'backend/hermes_cron.py', 'backend/routine_suggestions.py'):
        named = set()
        for node in ast.walk(ast.parse((ROOT / rel).read_text())):
            if isinstance(node, ast.Call):
                named.add(getattr(node.func, 'attr', getattr(node.func, 'id', '')))
                named |= {a.value for a in node.args if isinstance(a, ast.Constant) and isinstance(a.value, str)}
        assert not named & {'add_suggestion', 'accept_suggestion'}, (rel, named & {'add_suggestion', 'accept_suggestion'})
