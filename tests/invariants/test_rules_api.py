"""T3.4: the rules API (contract v0.1 section 3), the human-only activation (D-012), the live seal and red team 6 and 8.

Part 1 runs the REAL backend/rules_service.py in-process against a scratch SQLite, and the same file with ONE deliberate
defect each (a mutation must turn its invariant red). Part 2 is the REAL harness: real Hermes, gateway, hook and dashboard;
seals are computed from what Hermes really says, never from a stored label.
"""
import hashlib
import importlib
import itertools
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import time
import types
import urllib.error
import urllib.request
import uuid

import pytest

from support import API, DASHBOARD, credentials, plugin
from test_bots import DB, audit_rows, csrf, error_of, post
from test_hook import backend, forget, loopback_request, native_bot, run_async, wait_for, wait_live
from test_plugin import PREFIX, no_secret
from test_runs import get

BACKEND = Path(plugin().__file__).parents[1] / 'backend'
NEEDED = ['__init__.py', 'api_errors.py', 'audit.py', 'dbfile.py', 'hook_store.py', 'rules.py', 'rules_types.py', 'rules_builtin.py', 'rules_store.py',
          'rules_service.py']
_counter = itertools.count()


# ---------------------------------------------------------------------------------------------------------------------
# Part 1: the service itself, with mutations
# ---------------------------------------------------------------------------------------------------------------------
def load(tmp_path, edit=None):
    pkg = tmp_path / f'rpkg{next(_counter)}'
    pkg.mkdir()
    for name in NEEDED:
        shutil.copy(BACKEND / name, pkg / name)
    if edit:
        target = pkg / ('rules_store.py' if (pkg / 'rules_store.py').read_text().count(edit[0]) else 'rules_service.py')
        text = target.read_text()
        assert text.count(edit[0]) == 1, edit[0]
        target.write_text(text.replace(*edit))
    sys.path.insert(0, str(pkg.parent))
    try:
        return importlib.import_module(f'{pkg.name}.rules_service')
    finally:
        sys.path.remove(str(pkg.parent))


def human(m, name='basic:harness-human'):
    return m.rules.Actor(m.rules.ActorKind.HUMAN, name)


def body(label='Block send_email', level='block', scope=None, match=None, **extra):
    return {'label': label, 'level': level, 'scope': scope if scope is not None else {'kind': 'bot', 'ref': 'vendas'},
            'match': match if match is not None else {'tools': ['send_email']}, **extra}


def make(m, db, **kw):
    fields = m.validate_create(body(**kw))
    return m.create(db, human(m), fields, m.new_rule_id())


def audit_activation(m, db, active):
    """What the route does: an audit.act whose payload is the rule as it becomes active; the row's digest is what the service trusts."""
    from importlib import import_module
    audit = import_module(m.__name__.rsplit('.', 1)[0] + '.audit').AuditLog(db)
    audit.act(active.updated_by, 'rule.activate', active.id, {'kind': 'ui'}, lambda: m.commit_activation(db, active), payload=m.activation_payload(active))


def activate(m, db, rule, actor=None):
    active, _ = m.plan_activation(db, actor or human(m), rule.id, rule.version)
    audit_activation(m, db, active)
    return active


def raw_save(m, db, rule, bot='vendas'):
    """What someone with the database file can do: write a row around the store's guard (M4 stops the code path, not the file)."""
    conn = m.rules_store.connect(db)
    try:
        conn.execute('INSERT OR REPLACE INTO rules (id, bot, state, version, updated_by, updated_at, rule_json) VALUES (?,?,?,?,?,?,?)',
                     (rule.id, bot, rule.state.value, rule.version, rule.updated_by, 1.0,
                      m.json.dumps(m.rules_store.rule_to_dict(rule), sort_keys=True, separators=(',', ':'))))
        conn.commit()
    finally:
        conn.close()


def refuses(m, code, fn, *args, **kw):
    try:
        fn(*args, **kw)
    except m.PluginError as error:
        assert error.code == code, f'expected {code}, got {error.code}'
        return error
    raise AssertionError(f'expected {code}')


def base_digest(m):
    return m.rules.compile_hook_table(m.rules.builtin_rules(), version=1, toolset_tools={}, mcp_server_tools={}).digest


def inv_rt6_an_agent_cannot_make_an_active_rule(m, tmp):
    db = tmp / 'a.db'
    # whatever else the request says, an agent proposal is a pending suggestion, never a draft or an active rule
    for smuggled in ({'state': 'active'}, {'origin': 'human'}, {'builtin': True}, {'version': 9}, {'id': 'builtin.mine'}):
        refuses(m, 'bad_request', m.validate_create, body(suggested_by_bot='vendas', **smuggled))
    suggestion = m.create(db, human(m), m.validate_create(body(suggested_by_bot='vendas')), m.new_rule_id())
    assert suggestion.state is m.rules.RuleState.SUGGESTION and suggestion.origin is m.rules.Origin.BOT_SUGGESTION and suggestion.updated_by == 'bot:vendas'
    # it decides nothing and changes no table
    assert suggestion.id not in [r.id for r in m.effective_rules(db, 'vendas')]
    assert m.compile_for(db, 'vendas', {}, {}).digest == base_digest(m)
    # it cannot jump to active, and only a human can review it into a draft
    refuses(m, 'not_a_draft', m.plan_activation, db, human(m), suggestion.id, suggestion.version)
    for caller in (m.rules.Actor(m.rules.ActorKind.AGENT, 'bot:vendas'), m.rules.Actor(m.rules.ActorKind.SYSTEM, 'system')):
        refuses(m, 'human_required', m.review, db, caller, suggestion.id, suggestion.version)
    draft = m.review(db, human(m), suggestion.id, suggestion.version)
    assert draft.state is m.rules.RuleState.DRAFT and draft.version == suggestion.version + 1
    refuses(m, 'human_required', m.plan_activation, db, m.rules.Actor(m.rules.ActorKind.AGENT, 'bot:vendas'), draft.id, draft.version)
    refuses(m, 'stale', m.plan_activation, db, human(m), draft.id, suggestion.version)             # the version you saw
    active = activate(m, db, draft)
    assert active.state is m.rules.RuleState.ACTIVE and active.id in [r.id for r in m.effective_rules(db, 'vendas')]
    assert m.compile_for(db, 'vendas', {}, {}).digest != base_digest(m)
    # the same human text as a plain create is a DRAFT: nothing is active without the activation step
    plain = make(m, db, label='Plain')
    assert plain.state is m.rules.RuleState.DRAFT and plain.origin is m.rules.Origin.HUMAN and plain.id not in [r.id for r in m.effective_rules(db, 'vendas')]


def inv_e_an_active_row_counts_only_with_its_human_activation(m, tmp):
    db = tmp / 'a.db'
    draft = make(m, db)
    # a row written ACTIVE by hand, with no activation on the audit log, is not a rule
    forged = m.rules.replace(draft, id='r-forged', state=m.rules.RuleState.ACTIVE, version=2, updated_by='basic:harness-human')
    raw_save(m, db, forged)
    assert forged.id not in [r.id for r in m.effective_rules(db, 'vendas')]
    assert [t for r, t in m.stored_rules(db) if r.id == 'r-forged'] == [False]
    # a real activation is trusted...
    real = activate(m, db, draft)
    assert real.id in [r.id for r in m.effective_rules(db, 'vendas')] and m.verify_activation(db, real)
    # ...until its content is touched in the database: then it is the same id but not the same activation
    tampered = m.rules.replace(real, label='Something else', match=m.rules.Match(tools=('*',)))
    raw_save(m, db, tampered)
    assert real.id not in [r.id for r in m.effective_rules(db, 'vendas')] and not m.verify_activation(db, tampered)
    raw_save(m, db, real)
    assert real.id in [r.id for r in m.effective_rules(db, 'vendas')]
    # an activation that failed (no ok result row) does not count
    other = make(m, db, label='Other')
    pending, _ = m.plan_activation(db, human(m), other.id, other.version)
    audit = importlib.import_module(m.__name__.rsplit('.', 1)[0] + '.audit').AuditLog(db)
    with pytest.raises(RuntimeError):
        audit.act(pending.updated_by, 'rule.activate', pending.id, {'kind': 'ui'}, lambda: (_ for _ in ()).throw(RuntimeError('boom')),
                  payload=m.activation_payload(pending))                                      # intent row, then an error result
    raw_save(m, db, pending)                                                                  # saved, but never audited
    assert other.id not in [r.id for r in m.effective_rules(db, 'vendas')]
    # drafts, suggestions and archived rules are never effective either
    archived, was_active = m.archive(db, human(m), real.id, real.version)
    assert was_active and archived.id not in [r.id for r in m.effective_rules(db, 'vendas')]
    # a rule of one Bot is not effective for another
    mine = activate(m, db, make(m, db, label='Vendas only'))
    assert mine.id in [r.id for r in m.effective_rules(db, 'vendas')] and mine.id not in [r.id for r in m.effective_rules(db, 'default')]


def inv_m4_the_store_does_not_write_active_rules_on_its_own(m, tmp):
    db = tmp / 'a.db'
    draft = make(m, db)
    sneaky = m.rules.replace(draft, state=m.rules.RuleState.ACTIVE, version=2, updated_by='basic:harness-human')
    # no activation on the audit log: the store refuses an ACTIVE rule, by any caller
    with pytest.raises(m.rules_store.StoreRefused):
        m.rules_store.save(db, sneaky, bot='vendas')
    assert [r.state for r in m.rules_store.load(db)] == [m.rules.RuleState.DRAFT]
    # with the human activation the same content goes in
    real = activate(m, db, draft)
    assert [r.state for r in m.rules_store.load(db)] == [m.rules.RuleState.ACTIVE]
    # an active rule is not replaced by anything but its archive, not even by an audited-looking copy of itself
    for other in (m.rules.replace(real, label='Quietly different'), m.rules.replace(real, state=m.rules.RuleState.DRAFT), real):
        with pytest.raises(m.rules_store.StoreRefused):
            m.rules_store.save(db, other, bot='vendas')
    archived, _ = m.archive(db, human(m), real.id, real.version)
    assert archived.state is m.rules.RuleState.ARCHIVED


def live(m, *, hook_digest, registered=True, tools=('terminal', 'web'), age=5.0):
    r = m.rules
    return r.LiveState(
        profile='vendas', surfaces=('api_server', 'cron', 'room'),
        platform_tools=(r.PlatformTools('api_server', frozenset(tools)), r.PlatformTools('cron', frozenset(tools))), mcp=(),
        approvals=r.ApprovalsState('manual', (), 'deny', 'deny', 60, '', None, frozenset()),
        hook=r.HookState(registered, age, hook_digest), soul=r.SoulState(False, None),
        room_policy=r.RoomPolicyState(frozenset({'bot_room'}), 'manual'), terminal_backend='local', read_at=1000.0)


def inv_rt8_the_seal_follows_the_live_state(m, tmp):
    db, S = tmp / 'a.db', m.rules.Seal
    rule = activate(m, db, make(m, db, label='No terminal', match={'toolsets': ['terminal'], 'tools': ['terminal']}))
    table = m.apply_table(db, 'vendas', {'terminal': ('terminal', 'process')}, {})
    assert [e.rule_id for e in table.entries if e.rule_id == rule.id]
    now = 1000.0
    ok = m.seal_for(db, rule, 'vendas', live(m, hook_digest=table.digest), now=now)
    assert ok.seal is S.LOCK and {x.id.value for x in ok.mechanisms if x.verified} == {'hook_block'}
    # the hook runs an older table: the rule is not in what it loaded, whatever the stored table says
    old = m.seal_for(db, rule, 'vendas', live(m, hook_digest='an-older-table'), now=now)
    assert old.seal is S.BROKEN and {p.code for p in old.problems} >= {'hook_rule_missing'}
    # hook gone, stale, or disabled in Hermes: the lock falls on the next read
    for state, code in ((live(m, hook_digest=table.digest, registered=False), 'hook_missing'),
                        (live(m, hook_digest=table.digest, age=900.0), 'hook_stale'),
                        (live(m, hook_digest=None), 'hook_rule_missing')):
        broken = m.seal_for(db, rule, 'vendas', state, now=now)
        assert broken.seal is S.BROKEN and code in {p.code for p in broken.problems}, code
    # F: what LuveBot says it configured (applied) against what Hermes says now: the toolset is still on, the seal is a lie
    claimed = m.rules.replace(rule, applied=('toolset_off:terminal@api_server',))
    lie = m.seal_for(db, claimed, 'vendas', live(m, hook_digest=table.digest, tools=('terminal', 'web')), now=now)
    assert lie.seal is S.BROKEN and 'applied_drift' in {p.code for p in lie.problems}
    honest = m.seal_for(db, claimed, 'vendas', live(m, hook_digest=table.digest, tools=('web',)), now=now)
    assert honest.seal is S.LOCK
    # inactive rules and drafts have nothing to seal; the level alone never makes a lock
    draft = make(m, db, label='Draft')
    assert m.seal_for(db, draft, 'vendas', live(m, hook_digest='x'), now=now).seal is S.NONE
    no_hook = m.seal_for(db, rule, 'vendas', live(m, hook_digest=None, registered=False), now=now)
    assert no_hook.seal is S.BROKEN
    # one Bot broken makes the rule broken, with the Bot named
    merged = m.aggregate({'vendas': ok, 'default': old})
    assert merged.seal is S.BROKEN and all(p.detail.startswith('default: ') for p in merged.problems)
    assert m.aggregate({'vendas': ok}).seal is S.LOCK and m.aggregate({}).seal is S.NONE


INVARIANTS = {n[4:]: f for n, f in globals().items() if n.startswith('inv_')}
MUTATIONS = [
    ('rt6_an_agent_cannot_make_an_active_rule', 'RT6: the agent proposal becomes a human draft', "    if fields['suggested_by_bot']:", "    if False:"),
    ('rt6_an_agent_cannot_make_an_active_rule', 'RT6: the request may name state and origin',
     "    allowed = {'label', 'level', 'scope', 'match', 'suggested_by_bot'}", "    allowed = {'label', 'level', 'scope', 'match', 'suggested_by_bot', 'state', 'origin', 'builtin', 'version', 'id'}"),
    ('rt6_an_agent_cannot_make_an_active_rule', 'RT6: a drafts-and-suggestions list counts as effective',
     "    chosen = [r for r in verified_active(path) if bot is None or applies_to(r, bot)]",
     "    chosen = [r for r, _ in stored_rules(path) if bot is None or applies_to(r, bot)]"),
    ('rt6_an_agent_cannot_make_an_active_rule', 'RT6: the version you saw is not checked', "    if rule.version != version:", "    if False:"),
    ('e_an_active_row_counts_only_with_its_human_activation', 'E: every active row is trusted', "    conn = hook_store.connect(path)\n    try:\n        return conn.execute(\"SELECT 1 FROM audit_log",
     "    return True\n    conn = hook_store.connect(path)\n    try:\n        return conn.execute(\"SELECT 1 FROM audit_log"),
    ('e_an_active_row_counts_only_with_its_human_activation', 'E: the digest of the activation is not compared',
     "WHERE action='rule.activate' AND target=? AND digest=? AND outcome='ok'", "WHERE action='rule.activate' AND target=? AND ? IS NOT NULL AND outcome='ok'"),
    ('e_an_active_row_counts_only_with_its_human_activation', 'E: an activation that did not succeed counts',
     "AND outcome='ok' AND detail='result' LIMIT 1", "LIMIT 1"),
    ('rt8_the_seal_follows_the_live_state', 'RT8: a block rule is always a lock',
     "    return rules.compute_seal(rule, state, expected_hook_digest=expected, now=now,",
     "    if rule.level is rules.Level.BLOCK:\n        return rules.SealResult(rules.Seal.LOCK, (), (), ())\n    return rules.compute_seal(rule, state, expected_hook_digest=expected, now=now,"),
    ('rt8_the_seal_follows_the_live_state', 'RT8: the stored table is taken for the one the hook loaded',
     "    if stored and state.hook.table_digest == stored[0]:", "    if stored:"),
    ('rt8_the_seal_follows_the_live_state', 'RT8: the hook table is not read for its rule ids',
     "                              hook_rule_ids=None if table is None else frozenset(e.rule_id for e in table.entries),",
     "                              hook_rule_ids=frozenset({rule.id}),"),
    ('rt8_the_seal_follows_the_live_state', 'RT8: one broken Bot is hidden by the others', "    if broken:\n        seal = rules.Seal.BROKEN\n",
     "    if False:\n        seal = rules.Seal.BROKEN\n    elif len(seals - {rules.Seal.BROKEN}) == 1:\n        seal = next(iter(seals - {rules.Seal.BROKEN}))\n"),
    ('m4_the_store_does_not_write_active_rules_on_its_own', 'M4: the store writes any ACTIVE rule', "        _guard(conn, rule)\n", "        pass\n"),
    ('m4_the_store_does_not_write_active_rules_on_its_own', 'M4: the audit intent is not required',
     "        if intent is None:\n            raise StoreRefused('no audited", "        if False:\n            raise StoreRefused('no audited"),
    ('m4_the_store_does_not_write_active_rules_on_its_own', 'M4: an active rule can be replaced',
     "and rule.state is not RuleState.ARCHIVED:", "and False:"),
]


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(tmp_path, name):
    INVARIANTS[name](load(tmp_path), tmp_path)


def test_every_invariant_has_a_mutation():
    assert {m[0] for m in MUTATIONS} == set(INVARIANTS)


RESULTS = []


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(tmp_path, invariant, label, old, new):
    variant = load(tmp_path, (old, new))
    try:
        INVARIANTS[invariant](variant, tmp_path)
    except BaseException as error:  # noqa: BLE001  (red = the invariant noticed)
        RESULTS.append((invariant, label, 'RED: ' + type(error).__name__))
        return
    RESULTS.append((invariant, label, 'SURVIVED'))
    pytest.fail(f'mutation survived: {invariant} / {label}')


# ---------------------------------------------------------------------------------------------------------------------
# Part 2: the real harness
# ---------------------------------------------------------------------------------------------------------------------
def rules_of(browser, **query):
    params = '&'.join(f'{k}={v}' for k, v in {'limit': 100, **query}.items() if v is not None)
    response = get(browser, '/rules?' + params)
    assert response.status == 200, response.text()
    return response.json()


def find(listing, rule_id):
    return next((i for i in listing['rules'] if i['rule']['id'] == rule_id), None)


def create(browser, **kw):
    response = post(browser, '/rules', body(**kw))
    assert response.status == 201, response.text()
    return response.json()['rule']


def patch(browser, payload, token='valid'):
    headers = {} if token is None else {'X-LuveBot-CSRF': csrf(browser) if token == 'valid' else token}
    return browser.request.patch(DASHBOARD + PREFIX + '/rules', data=payload, headers=headers)


def activate_rule(browser, rule, **extra):
    response = patch(browser, {'id': rule['id'], 'version': rule['version'], 'state': 'active', **extra})
    assert response.status == 200, response.text()
    return response.json()


def archive_rule(browser, rule_id):
    current = find(rules_of(browser), rule_id)['rule']
    response = patch(browser, {'id': rule_id, 'version': current['version'], 'state': 'archived'})
    assert response.status == 200, response.text()
    return response.json()


def simulate(browser, **action):
    response = post(browser, '/rules/simulate', {'bot': 'vendas', **action})
    assert response.status == 200, response.text()
    return response.json()


def table_digest(bot):
    conn = sqlite3.connect(DB)
    try:
        row = conn.execute('SELECT digest FROM hook_tables WHERE profile=?', (bot,)).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def wait_table_loaded(browser, bot, timeout=30):
    wait_for(lambda: (get(browser, f'/bots/{bot}').json()['hook']['table_digest'] == table_digest(bot)), timeout, f'{bot} hook to load its new table')


@pytest.fixture(autouse=True)
def clean_rules():
    yield
    conn = sqlite3.connect(DB)
    ids = [r[0] for r in conn.execute("SELECT id FROM rules")]
    conn.execute('DELETE FROM rules')
    conn.commit()
    conn.close()
    if ids:  # put every Bot's table back to the built-ins
        backend()
        import luvebot_backend.hook as hook
        import luvebot_backend.live_state as live_state
        import luvebot_backend.rules_service as service
        from hermes_cli.profiles import list_profiles
        for name in ('default', 'vendas'):
            tools, mcp = live_state.expansion_maps(name)
            service.apply_table(DB, name, tools, mcp)


def test_the_routes_are_in_the_router_so_the_401_sweep_covers_them():
    from test_plugin import routes
    found = set(routes())
    for item in (('GET', '/rules'), ('POST', '/rules'), ('PATCH', '/rules'), ('POST', '/rules/simulate')):
        assert (item[0], PREFIX + item[1]) in found, item


def test_the_builtin_rules_carry_a_live_seal_per_rule(human_browser):
    listing = rules_of(human_browser)
    built = {i['rule']['id']: i for i in listing['rules'] if i['rule']['builtin']}
    assert len(built) == 9 and all(i['rule']['state'] == 'active' and i['rule']['origin'] == 'builtin' for i in built.values())
    for rule_id, item in built.items():
        level, seal = item['rule']['level'], item['seal_result']
        assert seal['problems'] == [], (rule_id, seal)                      # both Bots have the hook live, approvals manual
        assert seal['seal'] == ('lock' if level == 'handback' else 'hand'), (rule_id, seal)
        if level == 'handback':
            assert 'handback' in seal['qualifiers']
        assert {m['id'] for m in seal['mechanisms'] if m['verified']} <= {'hook_block', 'hook_approve'}
        assert seal['mechanisms'] and all(m['covers'] for m in seal['mechanisms'] if m['verified'])
    assert 'yolo_session_invisible' in built['builtin.delete_permanent']['seal_result']['qualifiers']
    one = rules_of(human_browser, bot='vendas')
    assert {i['rule']['id'] for i in one['rules']} >= set(built)
    page = rules_of(human_browser, limit=4)
    assert len(page['rules']) == 4 and page['next_cursor'] == '4'
    rest = rules_of(human_browser, cursor='4')
    assert find(rest, page['rules'][0]['rule']['id']) is None
    for query in ('limit=0', 'limit=101', 'cursor=x', 'bot=../x'):
        assert get(human_browser, '/rules?' + query).status in (400, 404), query
    no_secret(json.dumps(listing), 'rules list')


def test_rt20_smart_mode_breaks_the_seal_of_an_ask_by_command(human_browser):
    """Red team RT20 (threat model RT16) on the REAL Hermes config: with `approvals.mode: smart` an auxiliary LLM may approve a
    command without a person, so every ask rule that matches COMMANDS shows BROKEN with `smart_mode` for that Bot; an ask that
    matches only tools stays HAND (ADR 3.3: smart touches commands only). Mutation: tests/harness/mutate_v04.py rt20_smart_ignored."""
    plugin()
    from hermes_cli.config import set_config_value
    from hermes_cli.web_server_profiles import _config_profile_scope
    with _config_profile_scope('vendas'):
        set_config_value('approvals.mode', 'smart')
    try:
        listing = rules_of(human_browser, bot='vendas')
        asks = [i for i in listing['rules'] if i['rule']['builtin'] and i['rule']['level'] == 'ask']
        by_command = [i for i in asks if i['rule']['match'].get('commands')]
        assert by_command, [i['rule']['id'] for i in asks]
        for item in asks:
            seal = item['seal_result']
            if item in by_command:
                assert seal['seal'] == 'broken' and 'smart_mode' in {p['code'] for p in seal['problems']}, (item['rule']['id'], seal)
            else:
                assert seal['seal'] == 'hand' and 'smart_mode' not in {p['code'] for p in seal['problems']}, (item['rule']['id'], seal)
    finally:
        with _config_profile_scope('vendas'):
            set_config_value('approvals.mode', 'manual')
    restored = rules_of(human_browser, bot='vendas')
    assert all(i['seal_result']['seal'] == 'hand' for i in restored['rules'] if i['rule']['builtin'] and i['rule']['level'] == 'ask')


def test_create_edit_and_validation_of_drafts(human_browser):
    before = table_digest('vendas')
    rule = create(human_browser)
    assert rule['state'] == 'draft' and rule['origin'] == 'human' and rule['version'] == 1 and rule['builtin'] is False
    assert rule['scope'] == {'kind': 'bot', 'ref': 'vendas'} and rule['match']['tools'] == ['send_email'] and rule['id'].startswith('r-')
    item = find(rules_of(human_browser), rule['id'])
    assert item['seal_result']['seal'] == 'none'
    assert table_digest('vendas') == before                                       # a draft changes nothing
    # edits only on a draft; the version you saw
    edited = patch(human_browser, {'id': rule['id'], 'version': 1, 'label': 'Renamed', 'match': {'tools': ['send_*'], 'conditions': {'recipient': 'external'}}})
    assert edited.status == 200 and edited.json()['rule']['version'] == 2 and edited.json()['rule']['label'] == 'Renamed'
    assert edited.json()['rule']['match']['conditions'] == [['recipient', 'external']]
    assert patch(human_browser, {'id': rule['id'], 'version': 1, 'label': 'Again'}).status == 409
    # validation
    for payload in (body(match={}), body(level='maybe'), body(scope={'kind': 'bot'}), body(scope={'kind': 'galaxy', 'ref': 'x'}), body(label=''),
                    body(match={'tools': 'send_email'}), body(match={'nope': ['x']}), {**body(), 'state': 'active'}, {**body(), 'origin': 'human'},
                    {**body(), 'id': 'builtin.x'}, {'label': 'x'}):
        response = post(human_browser, '/rules', payload)
        assert response.status in (400, 422) and error_of(response)['code'] in ('bad_request', 'invalid_field'), payload
    assert post(human_browser, '/rules', body(), None).status == 403 and post(human_browser, '/rules', body(), 'wrong').status == 403
    # built-ins and unknown ids
    builtin = find(rules_of(human_browser), 'builtin.delete_permanent')['rule']
    for state in ('archived', 'draft', 'active'):
        response = patch(human_browser, {'id': builtin['id'], 'version': builtin['version'], 'state': state})
        assert response.status == 409 and error_of(response)['code'] in ('builtin_immutable', 'not_a_draft'), state
    assert patch(human_browser, {'id': builtin['id'], 'version': 1, 'label': 'x'}).status == 409
    assert patch(human_browser, {'id': 'r-nope', 'version': 1, 'label': 'x'}).status == 404
    for bad in ({'id': rule['id'], 'version': 2}, {'id': rule['id'], 'version': 2, 'state': 'active', 'label': 'x'}, {'id': rule['id'], 'version': 2, 'state': 'wat'},
                {'id': rule['id'], 'version': 0, 'label': 'x'}, {'id': 5, 'version': 1, 'label': 'x'}, {'id': rule['id'], 'version': 2, 'zzz': 1}):
        assert patch(human_browser, bad).status == 400, bad


def test_activation_applies_the_table_the_hook_loads_and_archiving_takes_it_back(human_browser):
    base = table_digest('vendas')
    default_base = table_digest('default')
    rule = create(human_browser, label='Hand back send_email_x', level='handback', match={'tools': ['send_email_x']})
    result = activate_rule(human_browser, rule)
    active = result['rule']
    assert active['state'] == 'active' and active['version'] == 2 and active['updated_by'] == 'basic:harness-human'
    # audited with the digest of the rule exactly as it became active: that row is what makes it trusted
    rows = [r for r in audit_rows('rule.activate') if r[3] == rule['id']]
    assert [(r[1], r[2]) for r in rows] == [('ok', 'intent'), ('ok', 'result')]
    backend()
    import luvebot_backend.rules_service as service
    import luvebot_backend.rules_store as store
    stored = next(r for r in store.load(DB) if r.id == rule['id'])
    assert service.verify_activation(DB, stored)
    # the Bot's table changed (and only that Bot's), and the hook really loads it
    assert table_digest('vendas') != base and table_digest('default') == default_base
    wait_table_loaded(human_browser, 'vendas')
    assert result['seal_result']['seal'] in ('lock', 'broken')                    # read the moment it was applied
    wait_for(lambda: find(rules_of(human_browser, bot='vendas'), rule['id'])['seal_result']['seal'] == 'lock', 40, 'a live lock')
    seal = find(rules_of(human_browser, bot='vendas'), rule['id'])['seal_result']
    assert seal['problems'] == [] and 'handback' in seal['qualifiers']
    # simulation agrees with enforcement: the engine and the hook table say the same thing
    sim = simulate(human_browser, tool='send_email_x')
    assert sim['decision']['effect'] == 'handback' and sim['decision']['winner'] == rule['id'] and sim['decision']['reason'] == 'single_rule'
    assert sim['hook'] == {'action': 'block', 'rule_id': rule['id'], 'message': f"luvebot:handback:{rule['id']}", 'strict': False} and sim['hook_agrees'] is True
    assert sim['seals'][rule['id']]['seal'] == 'lock' and 'hook_block' in sim['effective_mechanisms']
    # the other Bot is untouched
    assert simulate(human_browser, bot='default', tool='send_email_x')['decision']['effect'] == 'allow'
    # archive: out of the table, out of the decision
    archived = archive_rule(human_browser, rule['id'])
    assert archived['rule']['state'] == 'archived' and archived['seal_result']['seal'] == 'none'
    assert table_digest('vendas') == base
    wait_table_loaded(human_browser, 'vendas')
    again = simulate(human_browser, tool='send_email_x')
    assert again['decision']['effect'] == 'allow' and again['hook']['action'] == 'none' and again['hook_agrees'] is True
    assert [r for r in audit_rows('rule.archive') if r[3] == rule['id']]


def test_activation_needs_a_human_csrf_and_a_dashboard_with_a_login(human_browser):
    rule = create(human_browser, label='Never active', level='ask', match={'tools': ['send_email_y']})
    payload = {'id': rule['id'], 'version': 1, 'state': 'active'}
    for token in (None, 'wrong'):
        response = patch(human_browser, payload, token)
        assert response.status == 403 and error_of(response)['code'] == 'csrf_required'
    # an agent holds at most its profile key: no session, no rule
    for key in (credentials()['vendas_api_key'], credentials()['api_key']):
        request = urllib.request.Request(DASHBOARD + PREFIX + '/rules', data=json.dumps(payload).encode(), method='PATCH',
                                         headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key})
        with pytest.raises(urllib.error.HTTPError) as refused:
            urllib.request.urlopen(request, timeout=10)
        assert refused.value.code == 401
    # loopback: the machine token cannot activate (D-012), though it may still create a draft (A-2)
    module = plugin()
    raw = json.dumps(payload).encode()
    with pytest.raises(module.PluginError) as refused:
        run_async(module.patch_rule(loopback_request(module, 'PATCH', '/rules', body=raw)))
    assert refused.value.code == 'loopback_not_human' and refused.value.status == 403
    assert find(rules_of(human_browser), rule['id'])['rule']['state'] == 'draft'
    drafted = run_async(module.create_rule(loopback_request(module, 'POST', '/rules', body=json.dumps(body(label='From loopback')).encode())))
    assert drafted.status_code == 201
    # not applied: a Bot without the hook cannot be silently given a rule that does not hold
    assert [r for r in audit_rows('rule.activate') if r[3] == rule['id']] == []


def test_loopback_cannot_archive_an_active_rule(human_browser):
    """Red team F2: archiving an ACTIVE ask/block rule loosens a control, so the loopback machine token gets 403 loopback_not_human
    (as for activating, D-012): the rule stays active and the Bot's hook table is unchanged. A draft can still be archived there."""
    rule = create(human_browser, label='Ask before send_email_f2', level='ask', match={'tools': ['send_email_f2']})
    active = activate_rule(human_browser, rule)['rule']
    assert active['state'] == 'active'
    before = table_digest('vendas')
    module = plugin()
    raw = json.dumps({'id': rule['id'], 'version': active['version'], 'state': 'archived'}).encode()
    with pytest.raises(module.PluginError) as refused:
        run_async(module.patch_rule(loopback_request(module, 'PATCH', '/rules', body=raw)))
    assert refused.value.code == 'loopback_not_human' and refused.value.status == 403
    assert find(rules_of(human_browser), rule['id'])['rule']['state'] == 'active'
    assert table_digest('vendas') == before and [r for r in audit_rows('rule.archive') if r[3] == rule['id']] == []
    # a draft loosens nothing: loopback may still archive it (A-2)
    draft = create(human_browser, label='Draft f2', level='ask', match={'tools': ['send_email_f2_draft']})
    done = run_async(module.patch_rule(loopback_request(module, 'PATCH', '/rules', body=json.dumps(
        {'id': draft['id'], 'version': draft['version'], 'state': 'archived'}).encode())))
    assert done.status_code == 200 and json.loads(done.body)['rule']['state'] == 'archived'
    # the person with a login can archive the active one
    assert archive_rule(human_browser, rule['id'])['rule']['state'] == 'archived'


def test_a_row_written_active_by_hand_is_not_a_rule(human_browser):
    backend()
    import luvebot_backend.rules as rules
    import luvebot_backend.rules_store as store
    base = table_digest('vendas')
    forged = rules.Rule('r-forged-by-hand', 'Forged', rules.Level.BLOCK, rules.Scope(rules.ScopeKind.BOT, 'vendas'), rules.Match(tools=('web_search',)),
                        rules.RuleState.ACTIVE, rules.Origin.HUMAN, version=2, updated_by='basic:harness-human')
    conn = sqlite3.connect(DB)
    conn.execute('INSERT OR REPLACE INTO rules (id, bot, state, version, updated_by, updated_at, rule_json) VALUES (?,?,?,?,?,?,?)',
                 (forged.id, 'vendas', 'active', 2, forged.updated_by, 1.0, json.dumps(store.rule_to_dict(forged), sort_keys=True, separators=(',', ':'))))
    conn.commit()
    conn.close()
    item = find(rules_of(human_browser), forged.id)
    assert item['seal_result']['seal'] == 'broken' and {p['code'] for p in item['seal_result']['problems']} == {'activation_unverified'}
    assert simulate(human_browser, tool='web_search')['decision']['effect'] == 'allow'
    other = create(human_browser, label='A real one', match={'tools': ['send_email_z']}, level='ask')
    activate_rule(human_browser, other)                                    # recompiles the table: the forged row must stay out of it
    backend()
    import luvebot_backend.hook_store as hook_store
    table = rules.HookTable.from_json(hook_store.read_table(DB, 'vendas')[1])
    assert forged.id not in [e.rule_id for e in table.entries] and other['id'] in [e.rule_id for e in table.entries]
    archive_rule(human_browser, other['id'])
    assert table_digest('vendas') == base


def test_rt6_a_proposal_from_the_agent_is_a_pending_suggestion(human_browser):
    before = simulate(human_browser, tool='send_email_s')['decision']
    digest = table_digest('vendas')
    # nobody but a signed-in person reaches the route; an agent has at most its profile key
    request = urllib.request.Request(DASHBOARD + PREFIX + '/rules', data=json.dumps(body(suggested_by_bot='vendas')).encode(), method='POST',
                                     headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + credentials()['vendas_api_key']})
    with pytest.raises(urllib.error.HTTPError) as refused:
        urllib.request.urlopen(request, timeout=10)
    assert refused.value.code == 401
    # what the person forwards from the agent's text is a suggestion, whatever the text claims
    for smuggled in ({'state': 'active'}, {'origin': 'human'}, {'builtin': True}):
        assert post(human_browser, '/rules', body(suggested_by_bot='vendas', level='allow', **smuggled)).status == 400
    response = post(human_browser, '/rules', body(label='Let me send mail', level='allow', match={'tools': ['send_email_s']}, suggested_by_bot='vendas'))
    assert response.status == 201, response.text()
    suggestion = response.json()['rule']
    assert suggestion['state'] == 'suggestion' and suggestion['origin'] == 'bot_suggestion' and suggestion['updated_by'] == 'bot:vendas'
    assert find(rules_of(human_browser), suggestion['id'])['seal_result']['seal'] == 'none'
    assert post(human_browser, '/rules', body(suggested_by_bot='no-such-bot')).status == 404
    # pending: no decision changes, no table changes; it cannot be activated, only reviewed by a person first
    assert simulate(human_browser, tool='send_email_s')['decision'] == before and table_digest('vendas') == digest
    refused = patch(human_browser, {'id': suggestion['id'], 'version': 1, 'state': 'active'})
    assert refused.status == 409 and error_of(refused)['code'] == 'not_a_draft'
    assert patch(human_browser, {'id': suggestion['id'], 'version': 1, 'label': 'edited while pending'}).status == 409
    reviewed = patch(human_browser, {'id': suggestion['id'], 'version': 1, 'state': 'draft'})
    assert reviewed.status == 200 and reviewed.json()['rule']['state'] == 'draft' and reviewed.json()['rule']['origin'] == 'bot_suggestion'
    assert simulate(human_browser, tool='send_email_s')['decision'] == before and table_digest('vendas') == digest   # a draft decides nothing either
    assert [r for r in audit_rows('rule.review') if r[3] == suggestion['id']] and not [r for r in audit_rows('rule.activate') if r[3] == suggestion['id']]



def test_g6_2_a_run_that_asks_to_change_a_rule_changes_nothing(human_browser):
    """Red team 6, gap G6.2: a page orders the Bot to activate a draft "allow" rule and to create an active one; the fake model
    obeys with its terminal and then says "rule activated". Nothing changes, and no rule.* row is written."""
    from test_approvals import injected_run
    draft = create(human_browser, label='G62 allow (draft)', level='allow', match={'tools': ['g62_no_such_tool']})
    digest, before = table_digest('vendas'), simulate(human_browser, tool='g62_no_such_tool')['decision']
    listing = [(i['rule']['id'], i['rule']['state'], i['rule']['version']) for i in rules_of(human_browser)['rules']]
    written = len([r for r in audit_rows() if r[0].startswith('rule.')])
    calls = [('activate', 'PATCH', '/rules', {'id': draft['id'], 'version': draft['version'], 'state': 'active'}),
             ('create', 'POST', '/rules', body(label='G62 allow everything', level='allow', match={'tools': ['terminal']}))]
    got = injected_run(human_browser, calls, 'g62')
    assert len(got) == 4 and set(got.values()) == {401}, got
    assert table_digest('vendas') == digest and simulate(human_browser, tool='g62_no_such_tool')['decision'] == before
    assert [(i['rule']['id'], i['rule']['state'], i['rule']['version']) for i in rules_of(human_browser)['rules']] == listing
    assert len([r for r in audit_rows() if r[0].startswith('rule.')]) == written
    # control: the same PATCH with the person's session activates it, so the 401s are the missing session, not a bad call
    assert activate_rule(human_browser, draft)['rule']['state'] == 'active'


def test_rt8_a_lock_that_the_world_contradicts_is_broken(human_browser, native_bot):
    # a Bot WITHOUT the hook: a rule about its toolset has nothing real behind it, whatever its level says
    rule = create(human_browser, label='No terminal for this Bot', level='block', scope={'kind': 'bot', 'ref': native_bot}, match={'toolsets': ['terminal']})
    refused = patch(human_browser, {'id': rule['id'], 'version': 1, 'state': 'active'})
    assert refused.status == 409 and error_of(refused)['code'] == 'not_applied' and error_of(refused)['bots'] == [native_bot]
    assert find(rules_of(human_browser), rule['id'])['rule']['state'] == 'draft'
    forced = activate_rule(human_browser, rule, accept_unapplied=True)             # the person accepts "activate without applying"
    codes = {p['code'] for p in forced['seal_result']['problems']}
    assert forced['seal_result']['seal'] == 'broken' and 'hook_missing' in codes and codes & {'toolset_still_enabled', 'uncovered_surface'}
    # install the hook: the table (with this rule) is applied and, once the gateway loads it, the lock becomes real
    assert post(human_browser, f'/bots/{native_bot}/hook/install', {}).status == 200
    wait_live(human_browser, native_bot, 90)
    wait_for(lambda: find(rules_of(human_browser, bot=native_bot), rule['id'])['seal_result']['seal'] == 'lock', 60, 'a live lock')
    # ...and when the mechanism disappears from Hermes, the very next read drops it
    from hermes_cli.plugins_cmd import dashboard_set_agent_plugin_enabled
    from hermes_cli.web_routers._common import config_write_scope
    with config_write_scope(native_bot):
        assert dashboard_set_agent_plugin_enabled('luvebot-hook', enabled=False)['ok']
    dropped = find(rules_of(human_browser, bot=native_bot), rule['id'])['seal_result']
    assert dropped['seal'] == 'broken' and 'hook_missing' in {p['code'] for p in dropped['problems']}


def test_f_what_luvebot_says_it_applied_is_checked_against_hermes(human_browser):
    backend()
    import luvebot_backend.live_state as live_state
    import luvebot_backend.rules as rules
    import luvebot_backend.rules_service as service
    state, toolset_tools, mcp_tools = live_state.read(DB, 'vendas')
    assert 'terminal' in next(p for p in state.platform_tools if p.platform == 'api_server').enabled_toolsets      # really on
    lie = rules.Rule('r-lie', 'No terminal (claimed applied)', rules.Level.BLOCK, rules.Scope(rules.ScopeKind.BOT, 'vendas'), rules.Match(toolsets=('terminal',)),
                     rules.RuleState.ACTIVE, rules.Origin.HUMAN, applied=('toolset_off:terminal@api_server',), version=2, updated_by='basic:harness-human')
    seal = service.seal_for(DB, lie, 'vendas', state)
    codes = {p.code for p in seal.problems}
    assert seal.seal is rules.Seal.BROKEN and 'applied_drift' in codes                  # the claim contradicts the live toolsets
    honest = rules.replace(lie, applied=())
    assert 'applied_drift' not in {p.code for p in service.seal_for(DB, honest, 'vendas', state).problems}


def test_the_live_state_is_read_from_hermes_and_carries_no_secret(human_browser):
    backend()
    import luvebot_backend.live_state as live_state
    state, toolset_tools, mcp_tools = live_state.read(DB, 'vendas')
    assert {'api_server', 'cron', 'room'} <= set(state.surfaces) and state.profile == 'vendas'
    platforms = {p.platform: p.enabled_toolsets for p in state.platform_tools}
    assert 'terminal' in platforms['api_server'] and 'cron' in platforms
    assert state.approvals.mode == 'manual' and state.approvals.cron_mode == 'deny' and state.terminal_backend == 'local'
    assert state.hook.registered and state.hook.table_digest == table_digest('vendas') and state.hook.heartbeat_age_s < 120
    assert state.room_policy is not None and 'bot_room' in state.room_policy.enabled_toolsets and state.room_policy.approval_mode == 'manual'
    assert state.soul.block_present is False and 'terminal' in toolset_tools and toolset_tools['terminal']
    assert state.mcp == () and mcp_tools == {}
    text = repr(state)
    for secret in ('api_key', 'vendas_api_key', 'extra_canary', 'password', 'signing_key'):
        assert credentials()[secret] not in text, secret
    # toolsets of the running API server, not the dashboard's CLI view: enabled sets come from /v1/toolsets
    code, payload = __import__('luvebot_backend.hermes_api', fromlist=['ApiClient']).ApiClient('vendas').call('GET', '/v1/toolsets', timeout=5)
    assert code == 200 and {t['name'] for t in payload['data'] if t['enabled']} == set(platforms['api_server'])


def test_simulate_decides_like_the_hook_and_fills_the_toolset(human_browser):
    sim = simulate(human_browser, tool='terminal', command='chpasswd --help')
    assert sim['decision']['effect'] == 'handback' and sim['decision']['winner'] == 'builtin.password_change.commands'
    assert sim['hook']['action'] == 'block' and sim['hook_agrees'] is True and sim['action']['toolset'] in ('terminal', None)
    ask = simulate(human_browser, tool='terminal', command='printf x > /tmp/f; chmod 600 /tmp/f')
    assert ask['decision']['effect'] == 'ask' and ask['hook']['action'] == 'approve' and ask['hook_agrees'] is True and ask['hook']['strict'] is True
    free = simulate(human_browser, tool='terminal', command='ls -la')
    assert free['decision']['effect'] == 'allow' and free['decision']['winner'] is None and free['hook']['action'] == 'none' and free['hook_agrees'] is True
    odd = simulate(human_browser, tool='terminal', command="'ls' -la")
    assert odd['decision']['effect'] == 'ask' and odd['decision']['reason'] == 'noncanonical_action' and odd['hook']['action'] == 'approve'
    assert simulate(human_browser, tool='make_payment')['decision']['effect'] == 'handback'
    assert simulate(human_browser, tool='terminal', toolset='terminal', facts={'recipient': 'external'})['action']['toolset'] == 'terminal'
    for payload in ({'tool': 'x'}, {'bot': 'vendas'}, {'bot': 'vendas', 'tool': 'x', 'zzz': 1}, {'bot': 'vendas', 'tool': 5}):
        response = post(human_browser, '/rules/simulate', payload)
        assert response.status == 400, payload
    assert post(human_browser, '/rules/simulate', {'bot': 'no-such-bot', 'tool': 'x'}).status == 404
    assert post(human_browser, '/rules/simulate', {'bot': 'vendas', 'tool': 'x'}, None).status == 403
    no_secret(json.dumps(sim), 'simulation')


def test_zz_print_the_mutation_table(capsys):
    with capsys.disabled():
        print('\n| invariant | mutation | result |\n|---|---|---|')
        for invariant, label, result in RESULTS:
            print(f'| {invariant} | {label} | {result} |')
