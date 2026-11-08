"""Pages review v0, step 21a (docs/contracts/pages-review-v0.md): "Revisar antes de salvar" and "Aprovar e salvar", the backend half.
The proposal is redacted FIRST and cut at 64 KiB after (one function, called by the hook); the approval of a page write keeps the page's sha at
the request and is refused with `page_changed` (nothing decided) when the file moved, while a denial is never blocked; a page review is not
batchable; the card says "Aprovar e salvar" only with a preview; the diff is plain text; the switch is the ACTIVE rule of the exact shape. The
hook that RECORDS the proposal (0.6.0, the Forja) is proven by the harness, not here. Mutations edit the source of the module under test."""
import importlib
import importlib.util
import itertools
import json
import logging
from pathlib import Path
import re
import sqlite3
import sys
import time
import types

import pytest

ROOT = Path(__file__).resolve().parents[3]
BACKEND = ROOT / 'backend'
_n = itertools.count()
SHA1, SHA2 = 'a' * 64, 'b' * 64


def load(edit=None, which='pages_review'):
    """The backend package as its own import; with `edit` = (old, new), module `which` is the real source with ONE replacement."""
    name = f'pr_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    pkg = importlib.util.module_from_spec(spec)
    sys.modules[name] = pkg
    spec.loader.exec_module(pkg)
    if edit:
        source = (BACKEND / f'{which}.py').read_text()
        assert source.count(edit[0]) == 1, edit[0]
        module = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.{which}', loader=None))
        module.__package__ = name
        sys.modules[f'{name}.{which}'] = module
        exec(compile(source.replace(*edit), str(BACKEND / f'{which}.py'), 'exec'), module.__dict__)
    return {m: importlib.import_module(f'{name}.{m}') for m in ('pages_review', 'approvals', 'hook_store', 'rules', 'pages')}


def redact(text):
    return re.sub(r'sk-[A-Za-z0-9]{12,}', '[redacted]', text)


def refused(call):
    try:
        call()
    except Exception as error:  # noqa: BLE001
        return error
    raise AssertionError('not refused')


# ---- the proposal -------------------------------------------------------------------------------------------------------------
def inv_redacted_first_then_cut(m):
    pr = m['pages_review']
    secret = 'sk-' + 'Z9' * 20
    text = 'a' * (pr.PROPOSAL_MAX - 5) + secret + 'tail'           # the secret straddles the 64 KiB cut
    got = pr.make_proposal('whole', 'workspace:pages/a.md', text, redact)
    assert 'sk-' not in got['content'] and 'Z9Z9' not in got['content'] and got['truncated'] is True
    assert len(got['content'].encode()) <= pr.PROPOSAL_MAX and got['size'] == len(text.encode())
    small = pr.make_proposal('v4a', 'workspace:pages/a.md', 'oi ' + secret, redact)
    assert small['content'] == 'oi [redacted]' and small['truncated'] is False and small['kind'] == 'v4a'
    huge = pr.make_proposal('replace', 'workspace:pages/a.md', 'x' * (pr.PROPOSAL_INPUT_MAX + 50), redact)
    assert huge['truncated'] is True and len(huge['content'].encode()) <= pr.PROPOSAL_MAX


def inv_an_unreadable_proposal_is_no_preview(m):
    pr = m['pages_review']
    ok = {'kind': 'whole', 'path_tag': 'workspace:pages/a.md', 'size': 3, 'truncated': False, 'content': 'abc'}
    assert pr.clean_proposal(ok) == ok
    for bad in (None, 'x', {**ok, 'kind': 'html'}, {**ok, 'size': -1}, {**ok, 'size': True}, {**ok, 'truncated': 1}, {**ok, 'content': 7},
                {**ok, 'path_tag': 'x' * 2000}, {**ok, 'extra': 1}, {k: v for k, v in ok.items() if k != 'size'}):
        assert pr.clean_proposal(bad) is None, bad
    long = pr.clean_proposal({**ok, 'content': 'y' * (pr.PROPOSAL_MAX + 5)})
    assert len(long['content']) == pr.PROPOSAL_MAX and long['truncated'] is True          # a row holding more is cut again


def inv_the_page_of_a_call(m):
    pr = m['pages_review']
    sha = lambda bot, slug: {'plan': SHA1}.get(slug)
    assert pr.page_of(['workspace:pages/plan.md'], 'v', sha) == {'slug': 'plan', 'base_sha': SHA1}
    assert pr.page_of(['workspace:Pages/Plan.md'], 'v', sha) == {'slug': 'plan', 'base_sha': SHA1}          # macOS ignores case
    assert pr.page_of(['workspace:pages/novo.md'], 'v', sha) == {'slug': 'novo', 'base_sha': None}          # a page that does not exist yet
    for paths in ([], ['workspace:pages/a.md', 'workspace:pages/b.md'], ['workspace:docs/a.md'], ['unresolved'], ['workspace:pages/sub/a.md'],
                  ['workspace:pages/a.txt'], ['abs:/pages/a.md'], None, 'workspace:pages/a.md'):
        assert pr.page_of(paths, 'v', sha) is None, paths


def inv_the_sha_check(m):
    pr = m['pages_review']
    assert pr.unchanged({'slug': 'plan', 'base_sha': SHA1}, 'v', lambda b, s: SHA1) is True
    assert pr.unchanged({'slug': 'plan', 'base_sha': SHA1}, 'v', lambda b, s: SHA2) is False             # a person saved meanwhile
    assert pr.unchanged({'slug': 'plan', 'base_sha': SHA1}, 'v', lambda b, s: None) is False             # the page went away
    assert pr.unchanged({'slug': 'novo', 'base_sha': None}, 'v', lambda b, s: None) is True              # still no page
    assert pr.unchanged({'slug': 'novo', 'base_sha': None}, 'v', lambda b, s: SHA1) is False             # a person created it meanwhile
    assert pr.unchanged(None, 'v', lambda b, s: None) is False and pr.unchanged('x', 'v', lambda b, s: None) is False


def inv_the_diff_is_plain_text(m):
    pr = m['pages_review']
    got = pr.diff('linha 1\nlinha 2\nlinha 3', 'linha 1\n<script>alert(1)</script>\nlinha 3')
    assert got['format'] == 'unified' and got['truncated'] is False
    assert '-linha 2' in got['lines'] and '+<script>alert(1)</script>' in got['lines'] and ' linha 1' in got['lines']
    assert all(isinstance(line, str) for line in got['lines'])
    fresh = pr.diff(None, 'a\nb')
    assert [l for l in fresh['lines'] if l.startswith(('+', '-')) and not l.startswith(('+++', '---'))] == ['+a', '+b']
    big = pr.diff('', '\n'.join(str(i) for i in range(pr.DIFF_MAX_LINES + 100)))
    assert big['truncated'] is True and len(big['lines']) == pr.DIFF_MAX_LINES


def rule_of(m, *, id='rv', level=None, tools=('write_file', 'patch'), conditions=(('path:under', 'workspace:pages'),), scope=None, state=None, **match):
    r = m['rules']
    return r.Rule(id=id, label='Revisar antes de salvar', level=level or r.Level.ASK, scope=scope or r.Scope(r.ScopeKind.BOT, 'vendas'),
                  match=r.Match(tools=tuple(tools), conditions=tuple(conditions), **match), state=state or r.RuleState.ACTIVE, origin=r.Origin.HUMAN)


def inv_the_switch_is_the_exact_rule(m):
    pr, r = m['pages_review'], m['rules']
    assert pr.find_review_rule([rule_of(m)], 'vendas').id == 'rv'
    assert pr.find_review_rule([rule_of(m, scope=r.Scope(r.ScopeKind.GLOBAL))], 'vendas') is not None
    own, glob = rule_of(m, id='own'), rule_of(m, id='glob', scope=r.Scope(r.ScopeKind.GLOBAL))
    assert pr.find_review_rule([glob, own], 'vendas').id == 'own' and pr.find_review_rule([own, glob], 'vendas').id == 'own'     # the Bot's own wins
    assert pr.find_review_rule([glob, own], 'suporte').id == 'glob'                                                              # another Bot sees the global one
    assert (pr.scope_of(own), pr.scope_of(glob)) == ('bot', 'global')
    assert pr.find_review_rule([rule_of(m, tools=('patch', 'write_file'))], 'vendas') is not None
    for label, rule in (('only write_file', rule_of(m, tools=('write_file',))), ('only patch', rule_of(m, tools=('patch',))),
                        ('block', rule_of(m, level=r.Level.BLOCK)), ('allow', rule_of(m, level=r.Level.ALLOW)),
                        ('draft', rule_of(m, state=r.RuleState.DRAFT)), ('archived', rule_of(m, state=r.RuleState.ARCHIVED)),
                        ('another Bot', rule_of(m, scope=r.Scope(r.ScopeKind.BOT, 'suporte'))),
                        ('a room', rule_of(m, scope=r.Scope(r.ScopeKind.ROOM, 'sala-1'))),                  # it covers only the writes of that room
                        ('a routine', rule_of(m, scope=r.Scope(r.ScopeKind.ROUTINE, 'job-1'))),
                        ('another path', rule_of(m, conditions=(('path:under', 'workspace:docs'),))),
                        ('glob', rule_of(m, conditions=(('path:glob', 'workspace:pages/**'),))),
                        ('two conditions', rule_of(m, conditions=(('path:under', 'workspace:pages'), ('path:glob', 'workspace:pages/a*')))),
                        ('no condition', rule_of(m, conditions=())), ('a toolset too', rule_of(m, toolsets=('file',))),
                        ('a command too', rule_of(m, commands=('rm *',))), ('extra tool', rule_of(m, tools=('write_file', 'patch', 'terminal')))):
        assert pr.find_review_rule([rule], 'vendas') is None, label


INVARIANTS = {f.__name__[4:]: f for f in (inv_redacted_first_then_cut, inv_an_unreadable_proposal_is_no_preview, inv_the_page_of_a_call,
                                          inv_the_sha_check, inv_the_diff_is_plain_text, inv_the_switch_is_the_exact_rule)}
MUTATIONS = [
    ('redacted_first_then_cut', 'cut, then redact', 'content, truncated = _cut(redact(text[:PROPOSAL_INPUT_MAX]))',
     'content, truncated = _cut(text[:PROPOSAL_INPUT_MAX]); content = redact(content)'),
    ('redacted_first_then_cut', 'no cut', 'return raw[:PROPOSAL_MAX].decode("utf-8", "ignore"), len(raw) > PROPOSAL_MAX', 'return text, False'),
    ('an_unreadable_proposal_is_no_preview', 'any kind accepted', "if (raw['kind'] not in KINDS or", 'if (False or'),
    ('an_unreadable_proposal_is_no_preview', 'a stored row is not cut again', "content, cut = _cut(raw['content'])", "content, cut = raw['content'], False"),
    ('the_page_of_a_call', 'several pages taken as one', 'len(paths) != 1 or not isinstance(paths[0], str)', 'not paths or not isinstance(paths[0], str)'),
    ('the_page_of_a_call', 'case taken literally', 'slug = found.group(1).lower()', 'slug = found.group(1)'),
    ('the_sha_check', 'always unchanged', "return isinstance(page, dict) and sha_of(bot, page.get('slug')) == page.get('base_sha')", 'return True'),
    ('the_sha_check', 'a missing page never changes', "== page.get('base_sha')", "== page.get('base_sha') or page.get('base_sha') is None"),
    ('the_diff_is_plain_text', 'no cap', 'lines[:DIFF_MAX_LINES], \'truncated\': len(lines) > DIFF_MAX_LINES', 'lines, \'truncated\': False'),
    ('the_switch_is_the_exact_rule', 'one tool is enough', 'set(m.tools) == REVIEW_TOOLS and len(m.tools) == 2', 'bool(set(m.tools) & REVIEW_TOOLS)'),
    ('the_switch_is_the_exact_rule', 'any level', 'rule.level is rules.Level.ASK and not rule.builtin', 'not rule.builtin'),
    ('the_switch_is_the_exact_rule', 'a draft counts', 'rule.state is rules.RuleState.ACTIVE and rule.level', 'rule.level'),
    ('the_switch_is_the_exact_rule', 'another Bot counts', 'r.scope.kind is rules.ScopeKind.BOT and r.scope.ref == bot', 'r.scope.kind is rules.ScopeKind.BOT'),
    ('the_switch_is_the_exact_rule', 'a room or routine rule counts', 'return own or next((r for r in shaped if r.scope.kind is rules.ScopeKind.GLOBAL), None)',
     'return own or next(iter(shaped), None)'),
    ('the_switch_is_the_exact_rule', 'the global rule wins over the Bot\'s', 'return own or next((r for r in shaped if r.scope.kind is rules.ScopeKind.GLOBAL), None)',
     'return next((r for r in shaped if r.scope.kind is rules.ScopeKind.GLOBAL), None) or own'),
    ('the_switch_is_the_exact_rule', 'every rule is the Bot\'s', "return 'bot' if rule.scope.kind is rules.ScopeKind.BOT else 'global'", "return 'bot'"),
]


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(name):
    INVARIANTS[name](load())


def test_every_invariant_has_a_mutation():
    assert set(INVARIANTS) == {inv for inv, *_ in MUTATIONS}


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(invariant, label, old, new):
    with pytest.raises(Exception):  # noqa: B017  (red = the invariant noticed)
        INVARIANTS[invariant](load((old, new)))


# ---- the approval of a page write, on a real SQLite -----------------------------------------------------------------------------
HOOK_RULE = 'rv'


def seed(m, path, *, tool='write_file', detail=None, bot='vendas', paths=('workspace:pages/plan.md',), proposal=True, request_id='req1', text='novo texto da página'):
    """A hook 0.6.0 event and the Hermes request that names it: what record_request joins."""
    hs, ap, pr = m['hook_store'], m['approvals'], m['pages_review']
    if detail is None and proposal is not None:
        body = {'paths': list(paths), 'proposal': pr.make_proposal('whole', paths[0], text, redact) if proposal else None}
        detail = json.dumps(body)
    event = hs.record_event(path, bot, tool, HOOK_RULE, 'approve', f'luvebot:ask:{HOOK_RULE}', 't1', 's1', 'call1', None, detail=detail)
    data = {'request_id': request_id, 'description': 'save', 'choices': ['once', 'deny'],
            'pattern_keys': [f'{ap.HOOK_PREFIX}{HOOK_RULE}#{event}.abcdef12']}
    return ap.record_request(path, bot, 'run1', 'api_server', data)


def human(m):
    r = m['rules']
    return r.Actor(r.ActorKind.HUMAN, 'maria')


def decide(m, path, row, choice, delivered=True, sha=None):
    pages = m['pages']
    pages.current_sha = lambda bot, slug: sha
    sent = []
    return m['approvals'].resolve(path, lambda *a: sent.append(a) or delivered, human(m), row['request_id'], digest=row['digest'], choice=choice), sent


def inv_a_page_write_is_decided_only_if_the_page_did_not_move(m, tmp_path):
    ap, pages = m['approvals'], m['pages']
    path = tmp_path / 'luvebot.db'
    pages.current_sha = lambda bot, slug: SHA1                                                       # the file at the request
    row = seed(m, path)
    assert json.loads(row['page_json']) == {'slug': 'plan', 'base_sha': SHA1} and json.loads(row['paths_json']) == ['workspace:pages/plan.md']
    view, sent = decide(m, path, row, 'once', sha=SHA1)
    assert view[0]['status'] == 'consumed' and len(sent) == 1                                        # same sha: decided once
    row = seed(m, path, request_id='req2')
    error = refused(lambda: decide(m, path, row, 'once', sha=SHA2))
    assert (error.code, error.status) == ('page_changed', 409)
    assert ap.get(path, 'req2')['status'] == 'pending'                                               # nothing was resolved: the Bot keeps waiting
    sent_before = []
    view, sent = decide(m, path, row, 'deny', sha=SHA2)                                              # a denial is never blocked
    assert view[0]['status'] == 'consumed' and view[0]['decided_choice'] == 'deny' and len(sent) == 1
    pages.current_sha = lambda bot, slug: None                                                       # the page did not exist at the request
    fresh = seed(m, path, request_id='req3', paths=('workspace:pages/novo.md',))
    assert json.loads(fresh['page_json']) == {'slug': 'novo', 'base_sha': None}
    assert refused(lambda: decide(m, path, fresh, 'once', sha=SHA1)).code == 'page_changed'         # a person created it meanwhile
    assert decide(m, path, fresh, 'once', sha=None)[0][0]['status'] == 'consumed'                    # still not there: fine
    assert sent_before == []


def inv_a_page_review_is_not_batchable(m, tmp_path):
    ap, pages = m['approvals'], m['pages']
    path = tmp_path / 'luvebot.db'
    pages.current_sha = lambda bot, slug: SHA1
    page_row = seed(m, path)
    plain = seed(m, path, tool='terminal', detail=json.dumps({}), request_id='req9')
    error = refused(lambda: ap.check_pending(path, page_row['request_id'], page_row['digest']))
    assert (error.code, error.status) == ('not_batchable', 422)
    assert ap.check_pending(path, plain['request_id'], plain['digest'])['request_id'] == 'req9'    # any other approval batches as before


def inv_the_card_says_approve_and_save_only_with_a_preview(m, tmp_path):
    ap, pages = m['approvals'], m['pages']
    path = tmp_path / 'luvebot.db'
    pages.current_sha = lambda bot, slug: SHA1
    with_preview = ap.view(seed(m, path))
    assert with_preview['review'] == {'preview': True, 'label': 'approve_and_save'}
    assert with_preview['page'] == {'slug': 'plan', 'base_sha': SHA1} and with_preview['proposal']['kind'] == 'whole'
    old_hook = ap.view(seed(m, path, detail='', request_id='req5'))                                   # a hook before 0.6.0 recorded no detail
    assert old_hook['review'] == {'preview': False, 'label': 'approve'} and old_hook['page'] is None and old_hook['proposal'] is None
    no_text = ap.view(seed(m, path, proposal=False, request_id='req6'))
    assert no_text['review'] == {'preview': False, 'label': 'approve'} and no_text['page']['slug'] == 'plan'
    other = ap.view(seed(m, path, tool='terminal', detail=json.dumps({}), request_id='req7'))
    assert other['review'] is None and other['page'] is None
    assert ap.view(seed(m, path, tool='patch', request_id='req8'))['review']['label'] == 'approve_and_save'
    cut = ap.view(seed(m, path, request_id='req10', text='x' * (m['pages_review'].PROPOSAL_MAX + 10)))   # the Bot sent more than 64 KiB
    assert cut['proposal']['truncated'] is True and cut['review'] == {'preview': False, 'label': 'approve'}   # not the whole change: never "Aprovar e salvar"


def inv_always_allow_names_the_page_or_refuses(m, tmp_path):
    ap, pages = m['approvals'], m['pages']
    path = tmp_path / 'luvebot.db'
    pages.current_sha = lambda bot, slug: SHA1
    one = seed(m, path)
    rule, error = ap._draft(path, one, {'label': 'Pode salvar o plano', 'level': 'allow'})
    assert error is None and rule['match']['conditions'] == [{'fact': 'path', 'op': 'eq', 'value': 'workspace:pages/plan.md'}]
    assert rule['state'] == 'draft' and rule['match']['tools'] == ['write_file']                    # a draft, never active
    two = seed(m, path, paths=('workspace:pages/a.md', 'workspace:pages/b.md'), request_id='req2')
    assert ap._draft(path, two, {'label': 'x', 'level': 'allow'}) == (None, 'multiple_paths')
    assert json.loads(two['page_json'] or 'null') is None                                           # two pages: no single sha to keep


PAGE_INVARIANTS = {f.__name__[4:]: f for f in (inv_a_page_write_is_decided_only_if_the_page_did_not_move, inv_a_page_review_is_not_batchable,
                                               inv_the_card_says_approve_and_save_only_with_a_preview, inv_always_allow_names_the_page_or_refuses)}
PAGE_MUTATIONS = [
    ('a_page_write_is_decided_only_if_the_page_did_not_move', 'decided anyway', "if choice == 'once' and row['page_json']:", "if False and row['page_json']:"),
    ('a_page_write_is_decided_only_if_the_page_did_not_move', 'a denial is blocked too', "if choice == 'once' and row['page_json']:", "if row['page_json']:"),
    ('a_page_write_is_decided_only_if_the_page_did_not_move', 'the sha check cannot fail',
     'if not pages_review.unchanged(page, row[\'bot\'], pages.current_sha):', 'if False:'),
    ('a_page_review_is_not_batchable', 'a page review in a batch', "if row['page_json']:  # 21a: a page review", "if False:  # 21a: a page review"),
    ('the_card_says_approve_and_save_only_with_a_preview', 'always "Aprovar e salvar"', "'label': 'approve_and_save' if whole else 'approve'", "'label': 'approve_and_save'"),
    ('the_card_says_approve_and_save_only_with_a_preview', 'a cut proposal still says save', "whole = proposal is not None and not proposal['truncated']", "whole = proposal is not None"),
    ('the_card_says_approve_and_save_only_with_a_preview', 'an old row has a preview', "pages_review.clean_proposal(_json_of(row, 'proposal_json'))", "_json_of(row, 'proposal_json') or {'kind': 'whole'}"),
    ('always_allow_names_the_page_or_refuses', 'the path is not in the draft', "facts=tuple(('path', t) for t in paths if isinstance(t, str)))", 'facts=())'),
]


@pytest.mark.parametrize('name', sorted(PAGE_INVARIANTS))
def test_page_invariant_holds_on_the_real_module(name, tmp_path):
    PAGE_INVARIANTS[name](load(), tmp_path)


def test_every_page_invariant_has_a_mutation():
    assert set(PAGE_INVARIANTS) == {inv for inv, *_ in PAGE_MUTATIONS}


@pytest.mark.parametrize('invariant,label,old,new', PAGE_MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in PAGE_MUTATIONS])
def test_each_page_mutation_turns_its_invariant_red(invariant, label, old, new, tmp_path):
    with pytest.raises(Exception):  # noqa: B017
        PAGE_INVARIANTS[invariant](load((old, new), 'approvals'), tmp_path)


# ---- the storage and the routes ---------------------------------------------------------------------------------------------------
def test_the_hook_event_keeps_the_detail_and_an_older_database_gets_the_column(tmp_path):
    m = load()
    path = tmp_path / 'old.db'
    conn = sqlite3.connect(path)
    conn.executescript('CREATE TABLE hook_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, profile TEXT NOT NULL, tool TEXT NOT NULL,'
                       ' rule_id TEXT, verdict TEXT NOT NULL, message TEXT, task_id TEXT, session_id TEXT, tool_call_id TEXT, command TEXT);')
    conn.close()
    event = m['hook_store'].record_event(path, 'vendas', 'write_file', 'rv', 'approve', 'm', 't', 's', 'c', None, detail='{"paths": []}')
    row = sqlite3.connect(path).execute('SELECT detail FROM hook_events WHERE id=?', (event,)).fetchone()
    assert row[0] == '{"paths": []}'
    plain = m['hook_store'].record_event(path, 'vendas', 'terminal', None, 'none', None, 't', 's', 'c2', 'ls')
    assert sqlite3.connect(path).execute('SELECT detail FROM hook_events WHERE id=?', (plain,)).fetchone()[0] is None


def test_the_page_current_sha_reads_the_file_on_disk_or_says_nothing(tmp_path, monkeypatch):
    m = load()
    pages = m['pages']
    pages_dir = tmp_path / 'pages'
    pages_dir.mkdir()
    (pages_dir / 'plan.md').write_bytes('# Plano\n'.encode())
    (pages_dir / 'link.md').symlink_to(pages_dir / 'plan.md')
    monkeypatch.setattr(pages, 'workspace', lambda bot: ('ready', str(tmp_path)))
    assert pages.current_sha('vendas', 'plan') == pages.sha256('# Plano\n'.encode()) and pages.current_text('vendas', 'plan') == '# Plano\n'
    assert pages.current_sha('vendas', 'link') is None and pages.current_sha('vendas', 'nao-existe') is None      # a link is not a page
    for bad in ('../x', 'A', '', None, 'a/b'):
        assert pages.current_sha('vendas', bad) is None
    monkeypatch.setattr(pages, 'workspace', lambda bot: ('unavailable', None))
    assert pages.current_sha('vendas', 'plan') is None
    monkeypatch.setattr(pages, 'workspace', lambda bot: (_ for _ in ()).throw(OSError('boom')))
    assert pages.current_sha('vendas', 'plan') is None
    assert pages.slug_of('Review') == 'review-page' and pages.slug_of('Plano') == 'plano'                       # `review` is the switch's URL


def api_source():
    return (ROOT / 'dashboard' / 'plugin_api.py').read_text()


def function(source, name):
    return re.search(rf'(?:async )?def {name}\(.*?(?=\n(?:@router|def |async def |class )|\Z)', source, re.S).group(0)


def check_routes(source):
    review, by_slug = source.index("@router.get('/bots/{bot}/pages/review')"), source.index("@router.get('/bots/{bot}/pages/{slug}')")
    assert review < by_slug                                                                  # `review` is not a page: registered first
    body = function(source, 'pages_review_state')
    assert 'pages_review.find_review_rule(' in body and 'rules_service.effective_rules' in body and '_seal_of(' in body and "'enabled': False" in body
    assert "'scope': pages_review.scope_of(rule)" in body and "'scope': None" in body
    assert body.index('_identity(request)') < body.index('_existing(bot)')
    listing = function(source, 'list_approvals')
    assert '_with_page_diffs' in listing
    diffs = function(source, '_with_page_diffs')
    assert "item.get('status') != 'pending'" in diffs and "proposal['kind'] != 'whole'" in diffs and 'pages_review.diff(' in diffs and '_REDACT(now)' in diffs


def run_diffs(source, items):
    """The route's own `_with_page_diffs`, run with a stand-in page on disk: the page now is two lines."""
    ns = {'pages': types.SimpleNamespace(current_text=lambda bot, slug: 'linha 1\nlinha 2'), 'pages_review': load()['pages_review'],
          '_REDACT': lambda text: text, 'logging': logging}
    exec(function(source, '_with_page_diffs'), ns)
    return ns['_with_page_diffs'](items)


def item(content, truncated):
    return {'status': 'pending', 'bot': 'vendas', 'page': {'slug': 'plan', 'base_sha': SHA1},
            'proposal': {'kind': 'whole', 'path_tag': 'workspace:pages/plan.md', 'size': len(content), 'truncated': truncated, 'content': content}}


def check_the_diff(source):
    whole, cut = run_diffs(source, [item('linha 1\nlinha 2\nlinha 3', False), item('linha 1', True)])   # the second: the Bot's text was cut after line 1
    assert '+linha 3' in whole['diff']['lines']
    assert 'diff' not in cut                                    # compared with the cut text, line 2 would read as DELETED: no diff at all


def test_a_cut_proposal_gets_no_diff():
    check_the_diff(api_source())
    with pytest.raises(AssertionError):
        check_the_diff(api_source().replace(" or proposal['truncated']:", ':'))


def test_route_wiring():
    check_routes(api_source())


def test_route_wiring_mutations():
    source = api_source()
    body = function(source, 'pages_review_state')
    moved = source.replace("@router.get('/bots/{bot}/pages/review')\n" + body, '')
    moved = moved.replace("@router.get('/bots/{bot}/pages/{slug}')", "@router.get('/bots/{bot}/pages/{slug}')", 1) + "\n@router.get('/bots/{bot}/pages/review')\n" + body
    with pytest.raises(AssertionError):
        check_routes(moved)
    with pytest.raises(AssertionError):
        check_routes(source.replace("proposal['kind'] != 'whole'", 'False'))
    with pytest.raises(AssertionError):
        check_routes(source.replace("item.get('status') != 'pending'", 'False'))
    with pytest.raises(AssertionError):
        check_routes(source.replace('pages_review.diff(None if now is None else _REDACT(now), proposal', 'pages_review.diff(now, proposal'))
