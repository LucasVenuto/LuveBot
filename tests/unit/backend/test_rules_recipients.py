"""Rules conditions v0, step 22b (docs/contracts/rules-conditions-v0.md §10): the `recipient` fact and its equality condition in the pure engine, built on
the frame of the `path` fact (test_rules_paths.py). One fact, one operator (`eq`), two adapters (kanban_create, cronjob_manage). `value` and `recipient:domain`
are NOT here: their keys are reserved and an unknown operator asks always. Every invariant `inv_<name>(m)` runs on the real `backend.rules` and goes red on
variants with ONE defect each. The hook that EXTRACTS the facts (0.7.0, the Forja) is proven by the harness, not here."""
from __future__ import annotations

import hashlib
import importlib
import itertools
import json
from pathlib import Path
import shutil
import sys

import pytest

import backend.rules as real

SRC = Path(real.__file__).parent
NOW = 1000.0
A, B, C = 'chat:telegram:111', 'chat:telegram:222', 'bot:vendas'


def rule(m, id, level, *, tools=('cronjob_manage',), conditions=(), toolsets=(), servers=(), commands=()):
    return m.Rule(id=id, label=id, level=level, scope=m.Scope(m.ScopeKind.GLOBAL),
                  match=m.Match(tools=tuple(tools), toolsets=tuple(toolsets), mcp_servers=tuple(servers), commands=tuple(commands),
                                conditions=tuple(conditions)),
                  state=m.RuleState.ACTIVE, origin=m.Origin.HUMAN)


def act(m, *tags, tool='cronjob_manage', facts=()):
    return m.Action(bot='vendas', tool=tool, facts=tuple(('recipient', t) for t in tags) + tuple(facts))


def effect(m, rules, *tags, tool='cronjob_manage', facts=()):
    """The level of the rule that decided, or 'none' when no rule matched."""
    decision, _ordered = m._evaluate_full(rules, act(m, *tags, tool=tool, facts=facts))
    winner = next((r for r in rules if r.id == decision.winner), None)
    return winner.level.value if winner is not None else 'none'


def live(m, version='0.7.0'):
    return m.LiveState(
        profile='vendas', surfaces=('api_server',), platform_tools=(m.PlatformTools('api_server', frozenset({'cronjob_manage', 'write_file'})),), mcp=(),
        approvals=m.ApprovalsState('manual', (), 'deny', 'deny', 60, 'luvebot', None, frozenset()),
        hook=m.HookState(True, 5.0, 'd1', version), soul=m.SoulState(False, None), room_policy=None, terminal_backend='local',
        read_at=NOW, approval_surface=None)


def seal(m, r, st):
    return m.compute_seal(r, st, expected_hook_digest='d1', now=NOW, hook_rule_ids=frozenset({r.id}), hook_problems=())


def table(m, *rules):
    return m.compile_hook_table(list(rules), version=1, toolset_tools={}, mcp_server_tools={})


def must_raise(m, code, fn):
    try:
        fn()
    except m.RuleError as error:
        assert error.args[0] == code, (code, error.args[0])
        return
    raise AssertionError(f'expected RuleError({code})')


ASK_A = lambda m: rule(m, 'ask-a', m.Level.ASK, conditions=(('recipient:eq', A),))
ALLOW_A = lambda m: rule(m, 'allow-a', m.Level.ALLOW, conditions=(('recipient:eq', A),))


def inv_the_tag_grammar(m):
    for good in ('chat:telegram:111', 'chat:telegram:-1001234567890', 'chat:discord:123456789012345678', 'chat:whatsapp:5511999990000',
                 'origin', 'local', 'all', 'bot:vendas', 'bot:Vendas-2', 'bot:a'):
        assert m.recipient_pattern_ok(good), good
    for bad in ('unresolved', '', None, 7, 'chat:telegram', 'chat:telegram:', 'chat::111', 'chat:Telegram:111', 'chat:tele gram:111', 'chat:telegram:1 1',
                'chat:telegram:' + '1' * 21, 'chat:slack:C0123ABC', 'chat:telegram:@canal', 'chat:signal:+5511999990000', 'chat:matrix:#sala:servidor.org',
                'chat:telegram:111:17585', 'chat:telegram:--1', 'chat:telegram:1.5', 'bot:', 'bot:-x', 'bot:a b', 'bot:' + 'a' * 65, 'bot-chat:vendas', 'bot-chat',
                'ORIGIN', 'Local', 'origin,all', 'all ', ' local', 'email:a@b.c', 'telegram:111', 'chat:telegram:111\x00', 'bot:vendas:1', '#geral'):
        assert not m.recipient_pattern_ok(bad), bad


def inv_several_recipients_restrictive_any_permissive_all(m):
    ask, allow = [ASK_A(m)], [ALLOW_A(m)]
    assert effect(m, ask, A) == 'ask' and effect(m, ask, B) == 'none'
    assert effect(m, ask, B, A) == 'ask'                                                       # any
    assert effect(m, allow, A) == 'allow' and effect(m, allow, A, A) == 'allow'
    assert effect(m, allow, A, B) == 'none' and effect(m, allow, B) == 'none'                  # all


def inv_a_delivery_that_also_posts_elsewhere_is_not_local(m):
    """`allow` on `local` (or on `origin`) over cronjob_manage: a job that also posts to a chat, or to `origin` and `local` at once, has two tags and the
    permissive rule needs ALL of them to match, so it asks. (Each word is its own `allow` rule: there is no "local or origin" operator yet.)"""
    local = [rule(m, 'only-local', m.Level.ALLOW, conditions=(('recipient:eq', 'local'),))]
    origin = [rule(m, 'only-origin', m.Level.ALLOW, conditions=(('recipient:eq', 'origin'),))]
    assert effect(m, local, 'local') == 'allow' and effect(m, origin, 'origin') == 'allow'
    assert effect(m, local, 'local', A) != 'allow' and effect(m, local, 'local', 'origin') != 'allow' and effect(m, origin, 'origin', 'local') != 'allow'
    assert effect(m, local, 'all') != 'allow' and effect(m, local, 'Local') != 'allow' and effect(m, local, 'local ') != 'allow'
    ask = [rule(m, 'ask-all', m.Level.ASK, conditions=(('recipient:eq', 'all'),))]
    assert effect(m, ask, 'origin', 'all') == 'ask' and effect(m, ask, 'origin', 'local') == 'none'
    assert effect(m, ask, 'ALL') == 'ask'                                                       # a word in another case is unresolved: asked about, never read as `all`


def inv_unresolved_resolves_to_the_stricter_outcome(m):
    ask, allow = [ASK_A(m)], [ALLOW_A(m)]
    for tags in (('unresolved',), ('nonsense',), ('chat:telegram',), (B, 'unresolved'), (), (None,)):
        assert effect(m, ask, *[t for t in tags if t is not None]) == 'ask', tags             # a restriction matches what it cannot read
        assert effect(m, allow, *[t for t in tags if t is not None]) != 'allow', tags         # a permission does not; an empty list is NO empty truth
    assert effect(m, [rule(m, 'blk', m.Level.BLOCK, conditions=(('recipient:eq', A),))], 'unresolved') == 'block'
    assert effect(m, ask, tool='cronjob_manage') == 'ask' and effect(m, allow, tool='cronjob_manage') != 'allow'   # no recipient fact at all


def inv_restrictive_folds_permissive_is_exact(m):
    ask = [rule(m, 'ask-b', m.Level.ASK, tools=('kanban_create',), conditions=(('recipient:eq', C),))]
    allow = [rule(m, 'allow-b', m.Level.ALLOW, tools=('kanban_create',), conditions=(('recipient:eq', C),))]
    assert effect(m, ask, 'bot:Vendas', tool='kanban_create') == 'ask'                       # a block on `vendas` must not be dodged with `Vendas`
    assert effect(m, allow, 'bot:Vendas', tool='kanban_create') != 'allow'                   # ...and an allow is not earned by another spelling
    assert effect(m, allow, 'bot:vendas', tool='kanban_create') == 'allow'


def inv_hook_verdict_reads_the_recipient_facts(m):
    t = table(m, ASK_A(m))
    assert m.hook_verdict(t, tool='cronjob_manage', command=None, facts={'recipient': [A]}).action == 'approve'
    assert m.hook_verdict(t, tool='cronjob_manage', command=None, facts={'recipient': [B]}).action == 'none'
    assert m.hook_verdict(t, tool='cronjob_manage', command=None, facts={'recipient': [B, A]}).action == 'approve'
    assert m.hook_verdict(t, tool='web_search', command=None, facts={'recipient': [A]}).action == 'none'        # the rule looks at its tools only
    for facts in (None, {}, {'recipient': []}, {'recipient': ['unresolved']}, {'recipient': [B, 'unresolved']}, {'path': ['workspace:pages/a.md']},
                  [B], (B,)):                                                                                   # a name not given, or the 0.6.0 list: no recipient
        assert m.hook_verdict(t, tool='cronjob_manage', command=None, facts=facts).action == 'approve', facts
    paths = table(m, rule(m, 'pg', m.Level.ASK, tools=('write_file',), conditions=(('path:under', 'workspace:pages'),)))
    assert m.hook_verdict(paths, tool='write_file', command=None, facts=['workspace:pages/a.md']).action == 'approve'              # 22a, unchanged
    assert m.hook_verdict(paths, tool='write_file', command=None, facts={'path': ['workspace:docs/a.md']}).action == 'none'


def inv_the_table_entry_and_its_json(m):
    t = table(m, ASK_A(m), rule(m, 'blk', m.Level.BLOCK, tools=('kanban_create',), conditions=(('recipient:eq', C),)))
    raw = json.loads(t.to_json())
    assert all(e['recipients'] for e in raw['entries']) and 'paths' not in raw['entries'][0]
    assert m.HookTable.from_json(t.to_json()) == t
    assert next(e for e in t.entries if e.rule_id == 'ask-a').recipients == (('eq', A),)
    plain = table(m, m.replace(ASK_A(m), id='plain', match=m.Match(tools=('terminal',), commands=('rm *',))))
    assert set(json.loads(plain.to_json())['entries'][0]) == {'rule_id', 'verdict', 'tools', 'commands', 'message', 'strict'}   # no key: same digest as before
    broken = json.loads(t.to_json())
    for bad in ([], [['eq']], [['under', A]], [['eq', 'unresolved']], [['eq', 'email:a@b.c']], [['eq', 7]], 'x'):
        broken['entries'][0]['recipients'] = bad
        ordered = sorted(({k: v for k, v in e.items() if not (k in ('paths', 'recipients') and v == [])} for e in broken['entries']),
                         key=lambda e: (e['rule_id'], e['verdict']))   # the digest follows the raw entries: only the shape can be the reason to refuse
        broken['digest'] = hashlib.sha256(json.dumps(ordered, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()
        try:
            m.HookTable.from_json(json.dumps(broken))
        except m.RuleError as error:
            assert error.args[0] == 'bad_table', bad
        else:
            raise AssertionError(f'a table with recipients={bad!r} was accepted')


def inv_every_tool_needs_an_adapter_for_every_fact(m):
    cond = (('recipient:eq', A),)
    assert m.validate_rule(rule(m, 'ok', m.Level.ASK, tools=('cronjob_manage',), conditions=cond)) == ()
    assert m.validate_rule(rule(m, 'ok2', m.Level.ASK, tools=('kanban_create', 'cronjob_manage'), conditions=(('recipient:eq', C),))) == ()
    both = (('recipient:eq', A), ('path:under', 'workspace:pages'))
    for label, bad, code in (('a file tool', rule(m, 'x', m.Level.ASK, tools=('write_file',), conditions=cond), 'condition_needs_adapter_tools'),
                             ('a mix of tools', rule(m, 'x', m.Level.ASK, tools=('cronjob_manage', 'write_file'), conditions=cond), 'condition_needs_adapter_tools'),
                             ('send_message is not model-callable', rule(m, 'x', m.Level.ASK, tools=('send_message',), conditions=cond), 'condition_needs_adapter_tools'),
                             ('star', rule(m, 'x', m.Level.ASK, tools=('*',), conditions=cond), 'condition_needs_adapter_tools'),
                             ('glob', rule(m, 'x', m.Level.ASK, tools=('cronjob_*',), conditions=cond), 'condition_needs_adapter_tools'),
                             ('no tool', rule(m, 'x', m.Level.ASK, tools=(), conditions=cond), 'condition_needs_adapter_tools'),
                             ('terminal', rule(m, 'x', m.Level.ASK, tools=('terminal',), conditions=cond), 'condition_needs_adapter_tools'),
                             ('toolset', rule(m, 'x', m.Level.ASK, tools=('cronjob_manage',), toolsets=('messaging',), conditions=cond), 'condition_needs_adapter_tools'),
                             ('server', rule(m, 'x', m.Level.ASK, tools=('cronjob_manage',), servers=('crm',), conditions=cond), 'condition_needs_adapter_tools'),
                             ('command', rule(m, 'x', m.Level.ASK, tools=('cronjob_manage',), commands=('rm *',), conditions=cond), 'condition_needs_adapter_tools'),
                             ('upper case', rule(m, 'x', m.Level.ASK, tools=('Cronjob_Manage',), conditions=cond), 'condition_needs_adapter_tools'),
                             ('path + recipient on one tool', rule(m, 'x', m.Level.ASK, tools=('cronjob_manage',), conditions=both), 'condition_needs_adapter_tools'),
                             ('path + recipient on a file tool', rule(m, 'x', m.Level.ASK, tools=('write_file',), conditions=both), 'condition_needs_adapter_tools'),
                             ('a path on a chat tool', rule(m, 'x', m.Level.ASK, tools=('cronjob_manage',), conditions=(('path:under', 'workspace:pages'),)),
                              'path_condition_needs_file_tools')):
        assert code in {p.code for p in m.validate_rule(bad)}, label
    for value in ('unresolved', 'email:a@b.c', 'chat:Telegram:1', 'bot:', 'telegram:111', '#geral', 'chat:telegram:*', 'origin,all'):
        assert 'bad_recipient_condition' in {p.code for p in m.validate_rule(rule(m, 'x', m.Level.ASK, conditions=(('recipient:eq', value),)))}, value


def inv_compile_enforces_recipients_and_leaves_other_facts(m):
    assert 'condition_not_enforceable' not in {p.code for p in table(m, ASK_A(m)).problems}
    other = m.replace(ASK_A(m), id='other', match=m.Match(tools=('cronjob_manage',), conditions=(('audience', 'internal'),)))
    assert 'condition_not_enforceable' in {p.code for p in table(m, other).problems}
    mixed = m.replace(ASK_A(m), id='mixed', match=m.Match(tools=('cronjob_manage',), conditions=(('recipient:eq', A), ('audience', 'internal'))))
    assert 'condition_not_enforceable' in {p.code for p in table(m, mixed).problems}
    assert table(m, ASK_A(m)).entries[0].recipients == (('eq', A),) and table(m, ASK_A(m)).entries[0].paths == ()


def inv_always_allow_names_one_recipient(m):
    one = m.draft_from_always_allow(act(m, A), label='x', rule_id='sg-1')
    assert one.match.conditions == (('recipient:eq', A),) and m.validate_rule(one) == ()
    must_raise(m, 'multiple_recipients', lambda: m.draft_from_always_allow(act(m, A, B), label='x', rule_id='sg-2'))
    for tag in ('unresolved', 'nonsense', 'chat:telegram'):
        must_raise(m, 'unusable_recipient', lambda t=tag: m.draft_from_always_allow(act(m, t), label='x', rule_id='sg-3'))
    activated = m.replace(one, state=m.RuleState.ACTIVE)
    assert effect(m, [activated], A) == 'allow' and effect(m, [activated], B) != 'allow'


def inv_the_seal_needs_the_hook_that_sends_the_fact(m):
    r = ASK_A(m)
    ok = seal(m, r, live(m, '0.7.0'))
    assert ok.seal is m.Seal.HAND and 'hook_outdated' not in {p.code for p in ok.problems}
    assert 'conditions_adapter_tools_only' in ok.qualifiers and 'condition_ignored' not in ok.qualifiers
    for version in ('0.6.0', '0.5.0', None, 'garbage'):
        old = seal(m, r, live(m, version))
        assert old.seal is m.Seal.BROKEN and 'hook_outdated' in {p.code for p in old.problems}, version
        assert any('0.7.0' in p.detail for p in old.problems if p.code == 'hook_outdated'), version
    path = rule(m, 'pg', m.Level.ASK, tools=('write_file',), conditions=(('path:under', 'workspace:pages'),))
    assert seal(m, path, live(m, '0.6.0')).seal is m.Seal.HAND                                  # each fact has its own version: 0.6.0 serves the path rule
    assert seal(m, path, live(m, '0.5.0')).seal is m.Seal.BROKEN
    blk = rule(m, 'blk', m.Level.BLOCK, conditions=(('recipient:eq', A),))
    assert seal(m, blk, live(m, '0.6.0')).seal is m.Seal.BROKEN and 'conditions_adapter_tools_only' in seal(m, blk, live(m, '0.7.0')).qualifiers


def inv_value_and_domain_are_reserved_and_ask_always(m):
    for key, value in (('value:lte', 'usd:10000'), ('value:gt', 'usd:100'), ('recipient:domain', 'example.org'), ('value', 'usd:5'), ('recipient', A), ('recipient:neq', A)):
        ask = [rule(m, 'r', m.Level.ASK, conditions=((key, value),))]
        allow = [rule(m, 'r', m.Level.ALLOW, conditions=((key, value),))]
        assert effect(m, ask, A) == 'ask' and effect(m, ask) == 'ask', key                       # an operator nobody reads asks always
        assert effect(m, allow, A) != 'allow' and effect(m, allow) != 'allow', key
        assert m.fact_of(key) is None, key
        assert 'condition_ignored' in seal(m, ask[0], live(m, '0.7.0')).qualifiers, key
        assert 'condition_not_enforceable' in {p.code for p in table(m, ask[0]).problems}, key


INVARIANTS = {f.__name__[4:]: f for f in (
    inv_the_tag_grammar, inv_several_recipients_restrictive_any_permissive_all, inv_a_delivery_that_also_posts_elsewhere_is_not_local, inv_unresolved_resolves_to_the_stricter_outcome,
    inv_restrictive_folds_permissive_is_exact, inv_hook_verdict_reads_the_recipient_facts, inv_the_table_entry_and_its_json,
    inv_every_tool_needs_an_adapter_for_every_fact, inv_compile_enforces_recipients_and_leaves_other_facts, inv_always_allow_names_one_recipient,
    inv_the_seal_needs_the_hook_that_sends_the_fact, inv_value_and_domain_are_reserved_and_ask_always)}

MUTATIONS = [
    ('the_tag_grammar', 'platform in capitals', '_PLATFORM = re.compile(r"[a-z0-9_-]{1,32}")', '_PLATFORM = re.compile(r"[A-Za-z0-9_-]{1,32}")'),
    ('the_tag_grammar', 'the words matched in any case', 'if tag in RECIPIENT_WORDS:', 'if tag.lower() in RECIPIENT_WORDS:'),
    ('the_tag_grammar', 'a chat id of any text', '_CHAT_ID = re.compile(r"-?[0-9]{1,20}")', '_CHAT_ID = re.compile(r".{1,2000}")'),
    ('the_tag_grammar', 'any profile text', '_PROFILE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")', '_PROFILE_NAME = re.compile(r".{1,200}")'),
    ('several_recipients_restrictive_any_permissive_all', 'restrictive needs all',
     'if not any(_recipient_tag(t) is None or _fold_segment(value) == _fold_segment(t) for t in tags):',
     'if not all(_recipient_tag(t) is None or _fold_segment(value) == _fold_segment(t) for t in tags):'),
    ('several_recipients_restrictive_any_permissive_all', 'permissive needs any',
     'all(_recipient_tag(t) is not None and unicodedata.normalize("NFC", value) == t for t in tags)',
     'any(_recipient_tag(t) is not None and unicodedata.normalize("NFC", value) == t for t in tags)'),
    ('a_delivery_that_also_posts_elsewhere_is_not_local', 'permissive needs any',
     'all(_recipient_tag(t) is not None and unicodedata.normalize("NFC", value) == t for t in tags)',
     'any(_recipient_tag(t) is not None and unicodedata.normalize("NFC", value) == t for t in tags)'),
    ('unresolved_resolves_to_the_stricter_outcome', 'a restriction does not match what it cannot read',
     'if not any(_recipient_tag(t) is None or _fold_segment(value) == _fold_segment(t) for t in tags):',
     'if not any(_recipient_tag(t) is not None and _fold_segment(value) == _fold_segment(t) for t in tags):'),
    ('unresolved_resolves_to_the_stricter_outcome', 'an empty list is an empty truth',
     'for t in tags] or [UNRESOLVED]\n    for _key, value in conditions:', 'for t in tags]\n    for _key, value in conditions:'),
    ('unresolved_resolves_to_the_stricter_outcome', 'a permission matches what it cannot read',
     'elif not usable or not all(_recipient_tag(t) is not None and unicodedata.normalize("NFC", value) == t for t in tags):',
     'elif not usable or not all(_recipient_tag(t) is None or unicodedata.normalize("NFC", value) == t for t in tags):'),
    ('restrictive_folds_permissive_is_exact', 'restrictive not folded', 'if not any(_recipient_tag(t) is None or _fold_segment(value) == _fold_segment(t) for t in tags):',
     'if not any(_recipient_tag(t) is None or value == t for t in tags):'),
    ('restrictive_folds_permissive_is_exact', 'permissive folded too', 'unicodedata.normalize("NFC", value) == t for t in tags):\n            return False',
     '_fold_segment(value) == _fold_segment(t) for t in tags):\n            return False'),
    ('hook_verdict_reads_the_recipient_facts', 'the recipient facts are not read',
     '_fact_list(facts, RECIPIENT_FACT), True):\n            continue\n', '_fact_list(facts, RECIPIENT_FACT), True) or True:\n            continue\n'),
    ('hook_verdict_reads_the_recipient_facts', 'a plain list is taken as recipients',
     'return tuple(facts) if name == PATH_FACT and isinstance(facts, (list, tuple)) else ()', 'return tuple(facts) if isinstance(facts, (list, tuple)) else ()'),
    ('hook_verdict_reads_the_recipient_facts', 'a missing name is a match for nothing',
     'return tuple(found) if isinstance(found, (list, tuple)) else ()', 'return tuple(found) if isinstance(found, (list, tuple)) else ("chat:telegram:999",)'),
    ('the_table_entry_and_its_json', 'an empty `recipients` key always written', '    if e.recipients:  # the same for recipients', '    if True:  # the same for recipients'),
    ('the_table_entry_and_its_json', 'an empty `recipients` accepted', 'if (not isinstance(recipients, list) or ("recipients" in raw and not recipients)',
     'if (not isinstance(recipients, list)'),
    ('the_table_entry_and_its_json', 'another operator accepted', 'c[0] == "eq" and isinstance(c[1], str) and recipient_pattern_ok(c[1])',
     'isinstance(c[0], str) and isinstance(c[1], str) and recipient_pattern_ok(c[1])'),
    ('the_table_entry_and_its_json', 'an unreadable tag accepted', 'c[0] == "eq" and isinstance(c[1], str) and recipient_pattern_ok(c[1])', 'c[0] == "eq" and isinstance(c[1], str)'),
    ('every_tool_needs_an_adapter_for_every_fact', 'any tool has every adapter', 'or not families <= set(ADAPTERS.get(t, ())) for t in m.tools)):',
     'for t in m.tools)):'),
    ('every_tool_needs_an_adapter_for_every_fact', 'any recipient value', 'if not recipient_pattern_ok(value):\n                    problems.append(Problem("bad_recipient_condition"',
     'if False:\n                    problems.append(Problem("bad_recipient_condition"'),
    ('compile_enforces_recipients_and_leaves_other_facts', 'recipients not carried by the entry',
     'recipients = tuple(("eq", c[1]) for c in m.conditions if fact_of(c[0]) == RECIPIENT_FACT)', 'recipients = ()'),
    ('compile_enforces_recipients_and_leaves_other_facts', 'every condition unenforceable',
     'if any(fact_of(c[0]) is None for c in m.conditions):  # path (hook 0.6.0)', 'if m.conditions:  # path (hook 0.6.0)'),
    ('always_allow_names_one_recipient', 'several recipients named', 'if len(view.recipients) > 1:', 'if False:'),
    ('always_allow_names_one_recipient', 'an unresolved recipient named', 'if not recipient_pattern_ok(view.recipients[0]):', 'if False:'),
    ('the_seal_needs_the_hook_that_sends_the_fact', 'the recipient fact served by 0.6.0', '"recipient": (0, 7, 0)}', '"recipient": (0, 6, 0)}'),
    ('the_seal_needs_the_hook_that_sends_the_fact', 'an old hook trusted',
     'if any(fact_of(c[0]) == fact for c in rule.match.conditions) and not (version is not None and version >= needed):', 'if False:'),
    ('the_seal_needs_the_hook_that_sends_the_fact', 'no qualifier', 'quals.add("conditions_adapter_tools_only")', 'pass'),
    ('value_and_domain_are_reserved_and_ask_always', 'recipient:domain read as a recipient',
     'return RECIPIENT_FACT if isinstance(key, str) and _squash(_fold(key)) == RECIPIENT_KEY else None',
     'return RECIPIENT_FACT if isinstance(key, str) and _squash(_fold(key)).startswith(RECIPIENT_FACT) else None'),
]

_counter = itertools.count()


def load_variant(tmp_path_factory, old, new):
    source = (SRC / 'rules.py').read_text()
    assert source.count(old) == 1, f'mutation target must appear exactly once: {old[:70]!r} ({source.count(old)})'
    pkg = tmp_path_factory.mktemp('mut') / f'rcpmut{next(_counter)}'
    pkg.mkdir()
    (pkg / '__init__.py').write_text('')
    for name in ('rules.py', 'rules_types.py', 'rules_builtin.py', 'unicode_invisible.py', 'unicode_invisible.json'):
        shutil.copy(SRC / name, pkg / name)
    (pkg / 'rules.py').write_text(source.replace(old, new))
    sys.path.insert(0, str(pkg.parent))
    try:
        return importlib.import_module(f'{pkg.name}.rules')
    finally:
        sys.path.remove(str(pkg.parent))


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(name):
    INVARIANTS[name](real)


def test_every_invariant_has_a_mutation():
    assert set(INVARIANTS) == {inv for inv, *_ in MUTATIONS}


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(tmp_path_factory, invariant, label, old, new):
    variant = load_variant(tmp_path_factory, old, new)
    with pytest.raises(Exception):  # noqa: B017  (red = the invariant noticed; any failure of the check counts)
        INVARIANTS[invariant](variant)


def test_the_adapters_are_exactly_the_six_tools_and_the_versions_are_per_fact():
    assert real.ADAPTERS == {'write_file': ('path',), 'patch': ('path',), 'read_file': ('path',), 'search_files': ('path',), 'kanban_create': ('recipient',), 'cronjob_manage': ('recipient',)}   # VR-1 added the two READ tools to the path family
    assert 'send_message' not in real.ADAPTERS                                                  # not a model-callable tool: nothing to protect
    assert real.FACTS_VERSION == {'path': (0, 6, 0), 'recipient': (0, 7, 0)}
    assert real.PATH_FACTS_VERSION == (0, 6, 0)
    assert 'value' not in {fact for facts in real.ADAPTERS.values() for fact in facts}           # `value` waits for a real tool (22c)


# ---- the API form ---------------------------------------------------------------------------------------------------------------
@pytest.fixture
def service(monkeypatch):
    import types
    modules = {'agent': {}, 'agent.secret_scope': {'current_secret_scope': lambda: None, 'get_secret': lambda *a: None},
               'hermes_cli': {}, 'hermes_cli.profiles': {'list_profile_names': lambda: []},
               'hermes_cli.web_server_profiles': {'_config_profile_scope': None}}
    for name, attrs in modules.items():
        module = types.ModuleType(name)
        module.__dict__.update(attrs)
        monkeypatch.setitem(sys.modules, name, module)
    import backend.rules_service as rules_service
    import backend.rules_store as rules_store
    return rules_service, rules_store


def test_a_recipient_condition_is_stored_with_its_operator_in_the_key(service):
    svc, store = service
    stored = (('recipient:eq', A),)
    assert svc._conditions([{'fact': 'recipient', 'op': 'eq', 'value': A}]) == stored
    assert svc._conditions([{'fact': 'recipient', 'value': A}]) == stored and svc._conditions([['recipient', A]]) == stored
    assert svc._conditions({'recipient': A}) == stored and svc._conditions([['recipient:eq', A]]) == stored
    for bad in ([{'fact': 'recipient', 'op': 'domain', 'value': 'example.org'}], [{'fact': 'recipient', 'op': 'under', 'value': A}],
                [{'fact': 'recipient', 'op': 'lte', 'value': A}]):
        with pytest.raises(Exception) as error:
            svc._conditions(bad)
        assert error.value.status == 422, bad
    r = rule(real, 'r1', real.Level.ASK, tools=('cronjob_manage',), conditions=stored)
    assert store.api_dict(r)['match']['conditions'] == [{'fact': 'recipient', 'op': 'eq', 'value': A}]
    assert svc._conditions(store.api_dict(r)['match']['conditions']) == stored                    # what the screen reads it sends back
    assert store.rule_to_dict(r)['match']['conditions'] == [['recipient:eq', A]]                   # storage: the pair, the operator in the key


def test_the_facts_of_a_simulated_action_are_plain_pairs(service):
    svc, _store = service
    assert svc._conditions([{'fact': 'recipient', 'value': A}, ['recipient', B]], facts=True) == (('recipient', A), ('recipient', B))
    for bad in ([{'fact': 'recipient', 'op': 'eq', 'value': A, 'x': 1}], [['recipient:eq', A]], [{'fact': 'recipient', 'op': 'domain', 'value': 'x'}]):
        with pytest.raises(Exception) as error:
            svc._conditions(bad, facts=True)
        assert error.value.status in (400, 422), bad
    action = svc.parse_action({'bot': 'vendas', 'tool': 'cronjob_manage', 'facts': [{'fact': 'recipient', 'value': A}]})
    assert action.facts == (('recipient', A),)


def test_an_invalid_recipient_rule_is_refused_under_its_own_code(service):
    svc, _store = service
    for tools, value, code in ((('write_file',), A, 'condition_needs_adapter_tools'), (('cronjob_manage',), '#geral', 'bad_recipient_condition')):
        bad = rule(real, 'x', real.Level.ASK, tools=tools, conditions=(('recipient:eq', value),))
        with pytest.raises(Exception) as error:
            svc._refuse_invalid(real.validate_rule(bad))
        assert (error.value.code, error.value.status) == (code, 422)
    for code in ('multiple_recipients', 'unusable_recipient'):
        refusal = svc._refusal(real.RuleError(code))
        assert refusal.status == 422 and refusal.code == code


def test_the_simulator_route_reads_recipient_facts():
    source = (SRC.parent / 'dashboard' / 'plugin_api.py').read_text()
    assert "'recipient': [v for k, v in action.facts if rules.fact_name(k) == 'recipient']}" in source
    assert "('recipients_lexical', any(rules.fact_name(k) == 'recipient' for k, _ in action.facts))" in source
