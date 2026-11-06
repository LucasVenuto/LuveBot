"""Rules conditions v0, step 22a (docs/contracts/rules-conditions-v0.md): the `path` fact and its conditions in the pure engine.

Every invariant is a function `inv_<name>(m)` over a rules MODULE `m`: it must hold on the real `backend.rules` and go red on
variants of the module with ONE deliberate defect each (the real source with one exact replacement, loaded as its own package), the way
test_rules.py does. The hook that EXTRACTS the facts (0.6.0, the Forja) is proven by the harness, not here: this file proves what the
engine does with the tags it is given: whole-segment `under`, segment-aware glob, fold on the restrictive side and exact text on the
permissive one, any/all over several paths, `unresolved` resolving to the stricter outcome, the table entry and its JSON, the
validation, the always-allow draft and the seal."""
from __future__ import annotations

import hashlib
import importlib
import itertools
import json
from pathlib import Path
import shutil
import sys
import types

import pytest

import backend.rules as real

SRC = Path(real.__file__).parent
NOW = 1000.0
FULLWIDTH_DOTS = '．．'   # two FULLWIDTH full stops: NFKC turns them into `..`


# ---------------------------------------------------------------------------------------------------------------------
# builders
# ---------------------------------------------------------------------------------------------------------------------
def rule(m, id, level, *, tools=('write_file', 'patch'), conditions=(), toolsets=(), servers=(), commands=()):
    return m.Rule(id=id, label=id, level=level, scope=m.Scope(m.ScopeKind.GLOBAL),
                  match=m.Match(tools=tuple(tools), toolsets=tuple(toolsets), mcp_servers=tuple(servers), commands=tuple(commands),
                                conditions=tuple(conditions)),
                  state=m.RuleState.ACTIVE, origin=m.Origin.HUMAN)


def act(m, *paths, tool='write_file'):
    return m.Action(bot='vendas', tool=tool, facts=tuple(('path', p) for p in paths))


def effect(m, rules, *paths, tool='write_file'):
    """The level of the rule that decided ('ask', 'allow', 'block', ...), or 'none' when no rule matched (the default is Hermes's own)."""
    decision, _ordered = m._evaluate_full(rules, act(m, *paths, tool=tool))
    winner = next((r for r in rules if r.id == decision.winner), None)
    return winner.level.value if winner is not None else 'none'


def live(m, version='0.6.0'):
    surfaces = ('api_server',)
    return m.LiveState(
        profile='vendas', surfaces=surfaces, platform_tools=(m.PlatformTools('api_server', frozenset({'write_file', 'patch'})),), mcp=(),
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


ASK_PAGES = lambda m: rule(m, 'ask-pages', m.Level.ASK, conditions=(('path:under', 'workspace:pages'),))
ALLOW_PAGES = lambda m: rule(m, 'allow-pages', m.Level.ALLOW, conditions=(('path:under', 'workspace:pages'),))


# ---------------------------------------------------------------------------------------------------------------------
# invariants
# ---------------------------------------------------------------------------------------------------------------------
def inv_under_is_by_whole_segments(m):
    ask = [ASK_PAGES(m)]
    for tag in ('workspace:pages/a.md', 'workspace:pages/sub/deep/a.md', 'workspace:pages'):
        assert effect(m, ask, tag) == 'ask', tag
    for tag in ('workspace:pagesX/a.md', 'workspace:docs/pages/a.md', 'abs:/pages/a.md', 'workspace:page'):
        assert effect(m, ask, tag) == 'none', tag


def inv_glob_is_segment_aware(m):
    single = [rule(m, 'g1', m.Level.ASK, conditions=(('path:glob', 'workspace:pages/*.md'),))]
    assert effect(m, single, 'workspace:pages/a.md') == 'ask'
    assert effect(m, single, 'workspace:pages/sub/a.md') != 'ask'            # `*` stays inside ONE segment
    assert effect(m, single, 'workspace:pages/a.txt') != 'ask'
    deep = [rule(m, 'g2', m.Level.ASK, conditions=(('path:glob', 'workspace:pages/**'),))]
    for tag in ('workspace:pages/a.md', 'workspace:pages/x/y/z.md'):
        assert effect(m, deep, tag) == 'ask', tag
    assert effect(m, deep, 'workspace:docs/a.md') != 'ask'
    middle = [rule(m, 'g3', m.Level.ASK, conditions=(('path:glob', 'workspace:**/secret.md'),))]
    assert effect(m, middle, 'workspace:a/b/secret.md') == 'ask' and effect(m, middle, 'workspace:secret.md') == 'ask'
    assert effect(m, middle, 'workspace:a/b/other.md') != 'ask'
    one = [rule(m, 'g4', m.Level.ASK, conditions=(('path:glob', 'workspace:a?.md'),))]
    assert effect(m, one, 'workspace:ab.md') == 'ask' and effect(m, one, 'workspace:abc.md') != 'ask'


def inv_double_star_only_as_a_whole_segment(m):
    for bad in ('workspace:pa**ges/a.md', 'workspace:pages/**.md', 'workspace:pages/a**'):
        assert not m.path_pattern_ok('glob', bad), bad
    for good in ('workspace:pages/**', 'workspace:**/a.md', 'workspace:pages/*.md', 'abs:/etc/*'):
        assert m.path_pattern_ok('glob', good), good


def inv_restrictive_folds_permissive_is_exact(m):
    ask, allow = [ASK_PAGES(m)], [ALLOW_PAGES(m)]
    assert effect(m, ask, 'workspace:Pages/A.md') == 'ask'                    # macOS volumes ignore case: a restriction must not slip
    assert effect(m, allow, 'workspace:Pages/A.md') != 'allow'                # ...and a permission must not be earned by a different spelling
    assert effect(m, allow, 'workspace:pages/a.md') == 'allow'
    glob = [rule(m, 'gp', m.Level.ASK, conditions=(('path:glob', 'workspace:pages/*.md'),))]
    assert effect(m, glob, 'workspace:PAGES/A.MD') == 'ask'


def inv_a_compatibility_character_cannot_hide_a_path(m):
    # a real directory named with fullwidth dots under pages/: folded as a WHOLE text it would read as `..` and escape the rule
    tag = f'workspace:pages/{FULLWIDTH_DOTS}/x.md'
    assert effect(m, [ASK_PAGES(m)], tag) == 'ask'
    assert m._split_tag(tag) is not None


def inv_a_path_is_never_squashed(m):
    exact = [rule(m, 'only-one', m.Level.ALLOW, conditions=(('path', 'workspace:pages/a b.md'),))]
    assert effect(m, exact, 'workspace:pages/a b.md') == 'allow'
    assert effect(m, exact, 'workspace:pages/a  b.md') != 'allow'            # two spaces is ANOTHER file
    ask = [rule(m, 'ask-one', m.Level.ASK, conditions=(('path', 'workspace:pages/a b.md'),))]
    assert effect(m, ask, 'workspace:pages/a  b.md') != 'ask'                # and it is not folded into this one either


def inv_several_paths_restrictive_any_permissive_all(m):
    ask, allow = [ASK_PAGES(m)], [ALLOW_PAGES(m)]
    assert effect(m, ask, 'workspace:docs/a.md', 'workspace:pages/b.md') == 'ask'          # any
    assert effect(m, ask, 'workspace:docs/a.md', 'workspace:docs/b.md') != 'ask'
    assert effect(m, allow, 'workspace:docs/a.md', 'workspace:pages/b.md') != 'allow'      # all
    assert effect(m, allow, 'workspace:pages/a.md', 'workspace:pages/b.md') == 'allow'


def inv_unresolved_resolves_to_the_stricter_outcome(m):
    ask, allow = [ASK_PAGES(m)], [ALLOW_PAGES(m)]
    for tags in (('unresolved',), ('workspace:../etc/passwd',), ('nonsense',), ('workspace:pages/a.md', 'unresolved'), ()):
        assert effect(m, ask, *tags) == 'ask', tags                                       # a restriction matches what it cannot read
        assert effect(m, allow, *tags) != 'allow', tags                                   # a permission does not
    assert effect(m, [rule(m, 'blk', m.Level.BLOCK, conditions=(('path:under', 'workspace:pages'),))], 'unresolved') == 'block'


def inv_hook_verdict_reads_the_facts(m):
    t = table(m, ASK_PAGES(m))
    assert m.hook_verdict(t, tool='write_file', command=None, facts=['workspace:pages/a.md']).action == 'approve'
    assert m.hook_verdict(t, tool='write_file', command=None, facts=['workspace:docs/a.md']).action == 'none'
    assert m.hook_verdict(t, tool='write_file', command=None, facts=['workspace:docs/a.md', 'workspace:pages/b.md']).action == 'approve'
    assert m.hook_verdict(t, tool='patch', command=None, facts=['workspace:pages/a.md']).action == 'approve'
    assert m.hook_verdict(t, tool='read_file', command=None, facts=['workspace:pages/a.md']).action == 'none'   # the rule looks at its tools only
    for facts in (None, [], ['unresolved'], ['workspace:docs/a.md', 'unresolved']):                           # one way to say "could not say"
        assert m.hook_verdict(t, tool='write_file', command=None, facts=facts).action == 'approve', facts
    assert m.hook_verdict(t, tool='write_file', command=None).action == 'approve'                              # a hook that sends nothing
    blk = table(m, rule(m, 'blk', m.Level.BLOCK, conditions=(('path:glob', 'workspace:pages/**'),)))
    assert m.hook_verdict(blk, tool='write_file', command=None, facts=['workspace:pages/x/y.md']).action == 'block'


def inv_the_table_entry_and_its_json(m):
    plain = rule(m, 'plain', m.Level.ASK, tools=('write_file',), conditions=())
    plain = m.replace(plain, match=m.Match(tools=('terminal',), commands=('rm *',)))
    t_plain = table(m, plain)
    raw = json.loads(t_plain.to_json())
    assert set(raw['entries'][0]) == {'rule_id', 'verdict', 'tools', 'commands', 'message', 'strict'}      # no `paths` key: the digest is unchanged
    assert m.HookTable.from_json(t_plain.to_json()) == t_plain
    t = table(m, ASK_PAGES(m), rule(m, 'glob', m.Level.BLOCK, conditions=(('path:glob', 'workspace:docs/**'), ('path:under', 'workspace:pages'))))
    assert m.HookTable.from_json(t.to_json()) == t
    entry = next(e for e in t.entries if e.rule_id == 'ask-pages')
    assert entry.paths == (('under', 'workspace:pages'),) and entry.tools == ('patch', 'write_file')
    broken = json.loads(t.to_json())
    for bad in ([], [['under']], [['regex', 'workspace:pages']], [['under', 'workspace:../etc']], [['glob', 'workspace:pa**/x']], 'x', [['under', 7]]):
        broken['entries'][0]['paths'] = bad
        # the digest is recomputed over the raw entries, so only the `paths` shape can be the reason to refuse the table
        ordered = sorted(({k: v for k, v in e.items() if not (k == 'paths' and v == [])} for e in broken['entries']),
                         key=lambda e: (e['rule_id'], e['verdict']))   # an empty `paths` is not part of any digest, as in the real table
        broken['digest'] = hashlib.sha256(json.dumps(ordered, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()
        try:
            m.HookTable.from_json(json.dumps(broken))
        except m.RuleError as error:
            assert error.args[0] == 'bad_table', bad
        else:
            raise AssertionError(f'a table with paths={bad!r} was accepted')


def inv_validation_of_a_path_condition(m):
    ok = rule(m, 'ok', m.Level.ASK, tools=('write_file',), conditions=(('path:under', 'workspace:pages'),))
    assert m.validate_rule(ok) == ()
    assert m.validate_rule(rule(m, 'both', m.Level.ASK, conditions=(('path:glob', 'workspace:pages/**'), ('path', 'workspace:pages/a.md')))) == ()
    cond = (('path:under', 'workspace:pages'),)
    for label, bad in (('star tool', rule(m, 'x', m.Level.ASK, tools=('*',), conditions=cond)),
                       ('glob tool', rule(m, 'x', m.Level.ASK, tools=('write_*',), conditions=cond)),
                       ('another tool', rule(m, 'x', m.Level.ASK, tools=('terminal',), conditions=cond)),
                       ('a tool with no adapter next to a file tool', rule(m, 'x', m.Level.ASK, tools=('write_file', 'terminal'), conditions=cond)),    # VR-1: the READ tools have the path adapter now (test_vr1_read_tools.py)
                       ('no tool', rule(m, 'x', m.Level.ASK, tools=(), conditions=cond)),
                       ('toolset', rule(m, 'x', m.Level.ASK, tools=('write_file',), toolsets=('file',), conditions=cond)),
                       ('server', rule(m, 'x', m.Level.ASK, tools=('write_file',), servers=('crm',), conditions=cond)),
                       ('command', rule(m, 'x', m.Level.ASK, tools=('write_file',), commands=('rm *',), conditions=cond)),
                       ('upper case name', rule(m, 'x', m.Level.ASK, tools=('Write_File',), conditions=cond))):
        assert {p.code for p in m.validate_rule(bad)} == {'path_condition_needs_file_tools'}, label
    for label, value, key in (('dotdot', 'workspace:pages/../x', 'path:under'), ('no kind', 'pages/a.md', 'path:under'),
                              ('wildcard in under', 'workspace:pages/*', 'path:under'), ('double star inside', 'workspace:pa**/x', 'path:glob'),
                              ('backslash', 'workspace:pages\\a', 'path:under'), ('empty segment', 'workspace:pages//a', 'path:under'),
                              ('abs relative', 'abs:etc/passwd', 'path:under'), ('too long', 'workspace:' + 'a' * 1100, 'path:under')):
        bad = rule(m, 'x', m.Level.ASK, tools=('write_file',), conditions=((key, value),))
        assert 'bad_path_condition' in {p.code for p in m.validate_rule(bad)}, label


def inv_compile_leaves_only_other_facts_unenforceable(m):
    assert 'condition_not_enforceable' not in {p.code for p in table(m, ASK_PAGES(m)).problems}
    other = m.replace(ASK_PAGES(m), id='other', match=m.Match(tools=('terminal',), conditions=(('audience', 'internal'),)))
    assert 'condition_not_enforceable' in {p.code for p in table(m, other).problems}
    mixed = m.replace(ASK_PAGES(m), id='mixed', match=m.Match(tools=('write_file',), conditions=(('path:under', 'workspace:pages'), ('audience', 'internal'))))
    assert 'condition_not_enforceable' in {p.code for p in table(m, mixed).problems}


def inv_always_allow_names_one_exact_file(m):
    one = m.draft_from_always_allow(act(m, 'workspace:pages/a.md'), label='x', rule_id='sg-1')
    assert one.match.conditions == (('path', 'workspace:pages/a.md'),) and m.validate_rule(one) == ()
    must_raise(m, 'multiple_paths', lambda: m.draft_from_always_allow(act(m, 'workspace:pages/a.md', 'workspace:pages/b.md'), label='x', rule_id='sg-2'))
    for tag in ('unresolved', 'workspace:../x', 'workspace:pages/*.md'):
        must_raise(m, 'unusable_path', lambda t=tag: m.draft_from_always_allow(act(m, t), label='x', rule_id='sg-3'))
    activated = m.replace(one, state=m.RuleState.ACTIVE)
    assert effect(m, [activated], 'workspace:pages/a.md') == 'allow' and effect(m, [activated], 'workspace:pages/b.md') != 'allow'


def inv_the_seal_says_file_tools_only_and_needs_the_hook(m):
    r = ASK_PAGES(m)
    ok = seal(m, r, live(m, '0.6.0'))
    assert 'paths_file_tools_only' in ok.qualifiers and 'condition_ignored' not in ok.qualifiers
    assert ok.seal is m.Seal.HAND and 'hook_outdated' not in {p.code for p in ok.problems}
    for version in ('0.5.0', '0.4.0', None, 'garbage'):
        old = seal(m, r, live(m, version))
        assert old.seal is m.Seal.BROKEN and 'hook_outdated' in {p.code for p in old.problems}, version
    blk = rule(m, 'blk', m.Level.BLOCK, conditions=(('path:under', 'workspace:pages'),))
    assert seal(m, blk, live(m, '0.5.0')).seal is m.Seal.BROKEN and 'paths_file_tools_only' in seal(m, blk, live(m, '0.6.0')).qualifiers
    other = m.replace(r, id='other', match=m.Match(tools=('terminal',), conditions=(('audience', 'internal'),)))
    assert 'condition_ignored' in seal(m, other, live(m, '0.6.0')).qualifiers and 'paths_file_tools_only' not in seal(m, other, live(m, '0.6.0')).qualifiers
    no_path = rule(m, 'plain', m.Level.ASK, tools=('terminal',), commands=('rm *',))
    assert 'hook_outdated' not in {p.code for p in seal(m, no_path, live(m, '0.4.0')).problems}


INVARIANTS = {f.__name__[4:]: f for f in (
    inv_under_is_by_whole_segments, inv_glob_is_segment_aware, inv_double_star_only_as_a_whole_segment,
    inv_restrictive_folds_permissive_is_exact, inv_a_compatibility_character_cannot_hide_a_path, inv_a_path_is_never_squashed,
    inv_several_paths_restrictive_any_permissive_all, inv_unresolved_resolves_to_the_stricter_outcome, inv_hook_verdict_reads_the_facts,
    inv_the_table_entry_and_its_json, inv_validation_of_a_path_condition, inv_compile_leaves_only_other_facts_unenforceable,
    inv_always_allow_names_one_exact_file, inv_the_seal_says_file_tools_only_and_needs_the_hook)}

MUTATIONS = [
    ('under_is_by_whole_segments', 'a string prefix', 'return got[1][:len(want[1])] == want[1]', 'return "/".join(got[1]).startswith("/".join(want[1]))'),
    ('glob_is_segment_aware', '`*` crosses `/`', 'return path_glob_match(want[1], got[1])', 'return glob_match("/".join(want[1]), "/".join(got[1]))'),
    ('glob_is_segment_aware', '`**` takes at least one segment', 'row[j] = ahead[j] or row[j + 1]', 'row[j] = row[j + 1] or (ahead[j + 1] and j < m)'),
    ('double_star_only_as_a_whole_segment', 'any `**` accepted', 'return all(seg == "**" or "**" not in seg for seg in parts[1])', 'return True'),
    ('restrictive_folds_permissive_is_exact', 'restrictive not folded',
     'return (kind, [_fold_segment(x) for x in segments]) if restrictive else (kind, segments)', 'return kind, segments'),
    ('restrictive_folds_permissive_is_exact', 'permissive folded too',
     'return (kind, [_fold_segment(x) for x in segments]) if restrictive else (kind, segments)', 'return kind, [_fold_segment(x) for x in segments]'),
    ('a_compatibility_character_cannot_hide_a_path', 'the whole text folded before the split',
     'parts = _split_tag(unicodedata.normalize("NFC", text))', 'parts = _split_tag(_fold_segment(text) if restrictive else unicodedata.normalize("NFC", text))'),
    ('a_path_is_never_squashed', 'the path squashed like a fact', 'paths.append(unicodedata.normalize("NFC", pair[1]))',
     'paths.append(_squash(unicodedata.normalize("NFC", pair[1])))'),
    ('several_paths_restrictive_any_permissive_all', 'restrictive needs all',
     'if not any(_split_tag(t) is None or _path_matches(op, value, t, True) for t in tags):',
     'if not all(_split_tag(t) is None or _path_matches(op, value, t, True) for t in tags):'),
    ('several_paths_restrictive_any_permissive_all', 'permissive needs any',
     'all(_split_tag(t) is not None and _path_matches(op, value, t, False) for t in tags)',
     'any(_split_tag(t) is not None and _path_matches(op, value, t, False) for t in tags)'),
    ('unresolved_resolves_to_the_stricter_outcome', 'a restriction does not match what it cannot read',
     'if not any(_split_tag(t) is None or _path_matches(op, value, t, True) for t in tags):',
     'if not any(_split_tag(t) is not None and _path_matches(op, value, t, True) for t in tags):'),
    ('unresolved_resolves_to_the_stricter_outcome', 'no tag at all is not unresolved',
     'for t in tags] or [UNRESOLVED]\n    for key, value in conditions:\n        op = _path_key(key)', 'for t in tags]\n    for key, value in conditions:\n        op = _path_key(key)'),
    ('unresolved_resolves_to_the_stricter_outcome', 'a permission matches what it cannot read',
     'if not usable or not all(_split_tag(t) is not None and _path_matches(op, value, t, False) for t in tags):',
     'if not usable or not all(_split_tag(t) is None or _path_matches(op, value, t, False) for t in tags):'),
    ('hook_verdict_reads_the_facts', 'the facts are not read',
     '_fact_list(facts, PATH_FACT), True):\n            continue\n', '_fact_list(facts, PATH_FACT), True) or True:\n            continue\n'),
    ('hook_verdict_reads_the_facts', 'no facts is a match for nothing',
     '_fact_list(facts, PATH_FACT), True):\n            continue', '_fact_list(facts, PATH_FACT) or ("workspace:none",), True):\n            continue'),
    ('the_table_entry_and_its_json', 'an empty `paths` key always written', '    if e.paths:  # absent when empty', '    if True:  # absent when empty'),
    ('the_table_entry_and_its_json', 'an empty `paths` accepted', 'if (not isinstance(paths, list) or ("paths" in raw and not paths)', 'if (not isinstance(paths, list)'),
    ('the_table_entry_and_its_json', 'an unreadable value accepted', 'and c[0] in ("eq", "under", "glob") and path_pattern_ok(c[0], c[1]) for c in paths)',
     'and c[0] in ("eq", "under", "glob") for c in paths)'),
    ('validation_of_a_path_condition', 'any tool accepted',
     'or any(canon_name(t)[0] != t or not families <= set(ADAPTERS.get(t, ())) for t in m.tools)):', '):'),
    ('validation_of_a_path_condition', 'a toolset accepted', 'if families and (not m.tools or m.toolsets or m.mcp_servers or m.commands',
     'if families and (not m.tools or m.mcp_servers or m.commands'),
    ('validation_of_a_path_condition', 'a `..` value accepted', 'if parts is None or "\\\\" in value:', 'if "\\\\" in value:'),
    ('compile_leaves_only_other_facts_unenforceable', 'every condition unenforceable',
     'if any(fact_of(c[0]) is None for c in m.conditions):  # path (hook 0.6.0)', 'if m.conditions:  # path (hook 0.6.0)'),
    ('always_allow_names_one_exact_file', 'several paths named', 'if len(view.paths) > 1:', 'if False:'),
    ('always_allow_names_one_exact_file', 'an unresolved path named', 'if not path_pattern_ok("eq", view.paths[0]):', 'if False:'),
    ('the_seal_says_file_tools_only_and_needs_the_hook', 'an old hook trusted', 'if any(fact_of(c[0]) == fact for c in rule.match.conditions) and not (version is not None and version >= needed):', 'if False:'),
    ('the_seal_says_file_tools_only_and_needs_the_hook', 'no qualifier', 'quals.add("paths_file_tools_only")', 'pass'),
    ('the_seal_says_file_tools_only_and_needs_the_hook', 'path conditions called ignored', 'if any(fact_of(c[0]) is None for c in m.conditions):\n        quals.add("condition_ignored")',
     'if m.conditions:\n        quals.add("condition_ignored")'),
]

_counter = itertools.count()


def load_variant(tmp_path_factory, old, new):
    source = (SRC / 'rules.py').read_text()
    assert source.count(old) == 1, f'mutation target must appear exactly once: {old[:60]!r} ({source.count(old)})'
    pkg = tmp_path_factory.mktemp('mut') / f'pathmut{next(_counter)}'
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


# ---------------------------------------------------------------------------------------------------------------------
# the API form (rules_store / rules_service): `{fact, op, value}` out, objects / pairs / dict in, the operator in the stored key
# ---------------------------------------------------------------------------------------------------------------------
@pytest.fixture
def service(monkeypatch):
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


def test_conditions_in_every_accepted_form_become_stored_pairs(service):
    svc, store = service
    assert svc._conditions(None) == ()
    assert svc._conditions({'audience': 'internal'}) == (('audience', 'internal'),)
    assert svc._conditions([['audience', 'internal']]) == (('audience', 'internal'),)
    assert svc._conditions([{'fact': 'path', 'op': 'under', 'value': 'workspace:pages'}, {'fact': 'path', 'op': 'glob', 'value': 'workspace:docs/**'},
                            {'fact': 'path', 'value': 'workspace:pages/a.md'}, {'fact': 'path', 'op': 'eq', 'value': 'workspace:x'},
                            {'fact': 'audience', 'op': 'eq', 'value': 'internal'}]) == (
        ('path:under', 'workspace:pages'), ('path:glob', 'workspace:docs/**'), ('path', 'workspace:pages/a.md'), ('path', 'workspace:x'),
        ('audience', 'internal'))
    for bad in ([{'fact': 'path', 'op': 'regex', 'value': 'x'}], [{'fact': 'audience', 'op': 'under', 'value': 'x'}],
                [{'fact': 'path', 'op': 'under'}], [{'fact': 'path', 'op': 'under', 'value': 'x', 'extra': 1}], 'x', [[1, 2]]):
        with pytest.raises(Exception) as error:
            svc._conditions(bad)
        assert getattr(error.value, 'status', 0) in (400, 422), bad


def test_facts_of_a_simulated_action_take_no_operator(service):
    svc, _store = service
    assert svc._conditions([{'fact': 'path', 'value': 'workspace:pages/a.md'}, ['path', 'workspace:pages/b.md']], facts=True) == (
        ('path', 'workspace:pages/a.md'), ('path', 'workspace:pages/b.md'))
    for bad in ([{'fact': 'path', 'op': 'under', 'value': 'workspace:pages'}], [['path:under', 'workspace:pages']], [['path:glob', 'x']]):
        with pytest.raises(Exception) as error:
            svc._conditions(bad, facts=True)
        assert error.value.status == 422, bad
    action = svc.parse_action({'bot': 'vendas', 'tool': 'write_file', 'facts': [{'fact': 'path', 'value': 'workspace:pages/a.md'}]})
    assert action.facts == (('path', 'workspace:pages/a.md'),)


def test_the_api_form_round_trips_and_storage_is_untouched(service):
    svc, store = service
    m = real
    r = rule(m, 'r1', m.Level.ASK, tools=('write_file',),
             conditions=(('path:under', 'workspace:pages'), ('path', 'workspace:pages/a.md'), ('audience', 'internal')))
    api = store.api_dict(r)
    assert api['match']['conditions'] == [{'fact': 'path', 'op': 'under', 'value': 'workspace:pages'},
                                          {'fact': 'path', 'op': 'eq', 'value': 'workspace:pages/a.md'},
                                          {'fact': 'audience', 'op': 'eq', 'value': 'internal'}]
    assert svc._conditions(api['match']['conditions']) == r.match.conditions                 # what the screen reads it sends back
    stored = store.rule_to_dict(r)
    assert stored['match']['conditions'] == [['path:under', 'workspace:pages'], ['path', 'workspace:pages/a.md'], ['audience', 'internal']]
    assert store.rule_from_dict(stored) == r                                                  # the stored form and its digest did not change
    assert store.api_dict(rule(m, 'r2', m.Level.ASK, tools=('terminal',), commands=('rm *',)))['match']['conditions'] == []


def test_an_invalid_path_rule_is_refused_under_its_own_code(service):
    svc, _store = service
    m = real
    bad = rule(m, 'x', m.Level.ASK, tools=('*',), conditions=(('path:under', 'workspace:pages'),))
    with pytest.raises(Exception) as error:
        svc._refuse_invalid(m.validate_rule(bad))
    assert (error.value.code, error.value.status) == ('path_condition_needs_file_tools', 422)
    worse = rule(m, 'x', m.Level.ASK, tools=('write_file',), conditions=(('path:under', 'workspace:../x'),))
    with pytest.raises(Exception) as error:
        svc._refuse_invalid(m.validate_rule(worse))
    assert (error.value.code, error.value.status) == ('bad_path_condition', 422)
    svc._refuse_invalid(m.validate_rule(rule(m, 'ok', m.Level.ASK, tools=('write_file',), conditions=(('path:under', 'workspace:pages'),))))
    refusal = svc._refusal(real.RuleError('multiple_paths'))
    assert refusal.status == 422 and refusal.code == 'multiple_paths'


def test_the_simulator_route_wires_the_facts_and_the_caveat():
    source = (SRC.parent / 'dashboard' / 'plugin_api.py').read_text()
    assert "given = {'path': [v for k, v in action.facts if rules.path_op(k) == 'eq']," in source
    assert "facts={k: v for k, v in given.items() if v} or None)" in source and "('paths_lexical', any(rules.path_op(k) for k, _ in action.facts))" in source
    assert source.count('rules_store.api_dict(rule)') >= 2 and "'rule': rules_store.rule_to_dict(" not in source
