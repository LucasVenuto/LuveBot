"""R-4 (contract v0.11 section 8, A-196): what a rule's server accepts follows what its matcher does, and this file pins the ASYMMETRY so nobody "fixes" one side later.

* A field the matcher DROPS characters from refuses them: a command or tool pattern, and the plain names of toolsets and servers, because `_command_text` and `canon_name` remove the invisible
  characters of the ACTION, so a pattern that holds one could never match: `422 bad_glob`.
* A field the matcher compares LITERALLY accepts them: a path condition (`_fold_segment` is NFKC and case, nothing is dropped), so a Persian file name with a ZWNJ is expressible, and so is the defensive rule
  "block any file name that holds a bidi override"; and the rule matches a path that has EXACTLY that character and no other.
* A display text accepts them: the label, which the hook never sends to the Bot.

The server is not changed: the asymmetry is the rule. Every invariant runs on the real `backend.rules` and goes red on variants with one deliberate defect (the command accepting the invisible character; the path
refusing it; the matchers no longer dropping or dropping too much)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_rules_paths', reason='the builders and the variant loader of the path rules')

import backend.rules as real  # noqa: E402
import backend.rules_service as service  # noqa: E402

ZWNJ, ZWSP, ZWJ, RLO, BOM, TAG_A = chr(0x200C), chr(0x200B), chr(0x200D), chr(0x202E), chr(0xFEFF), chr(0xE0041)
HIDDEN = (ZWNJ, ZWSP, ZWJ, RLO, BOM, TAG_A, chr(0xAD), chr(0x2066), chr(0x85))        # format, bidi, tag, soft hyphen, a C1 control: all in the matcher's invisible set
PERSIAN = ''.join(chr(c) for c in (0x645, 0x6CC)) + ZWNJ + ''.join(chr(c) for c in (0x62E, 0x648, 0x627, 0x647, 0x645)) + '.txt'     # "mi" + ZWNJ + "khaham.txt": a real Persian name


def codes(m, r):
    return [p.code for p in m.validate_rule(r)]


def decided(m, rules, action):
    decision, _ordered = m._evaluate_full(rules, action)
    return decision.winner


def inv_a_pattern_the_matcher_drops_characters_from_refuses_them(m):
    plain = (tp.rule(m, 'cmd', m.Level.BLOCK, tools=('terminal',), commands=('rm -rf *',)), tp.rule(m, 'tool', m.Level.BLOCK, tools=('write_file',)),
             tp.rule(m, 'set', m.Level.BLOCK, tools=(), toolsets=('web',)), tp.rule(m, 'srv', m.Level.BLOCK, tools=(), servers=('crm',)))
    assert all(codes(m, r) == [] for r in plain), [codes(m, r) for r in plain]            # the plain versions are valid: the cases below mean something
    for ch in HIDDEN:
        assert codes(m, tp.rule(m, 'c', m.Level.BLOCK, tools=('terminal',), commands=('rm' + ch + ' -rf *',))) == ['bad_glob'], ('command', hex(ord(ch)))      # a command pattern
        assert codes(m, tp.rule(m, 'c', m.Level.BLOCK, tools=('terminal',), commands=('rm -rf *' + ch,))) == ['bad_glob'], ('command end', hex(ord(ch)))
        assert codes(m, tp.rule(m, 't', m.Level.BLOCK, tools=('write' + ch + '_file',))) == ['bad_glob'], ('tool', hex(ord(ch)))                               # a tool pattern
        assert codes(m, tp.rule(m, 's', m.Level.BLOCK, tools=(), toolsets=('web' + ch,))) == ['bad_glob'], ('toolset', hex(ord(ch)))                           # the plain names
        assert codes(m, tp.rule(m, 'v', m.Level.BLOCK, tools=(), servers=('cr' + ch + 'm',))) == ['bad_glob'], ('server', hex(ord(ch)))
    # why: the matcher drops the invisible characters of the ACTION, so the plain pattern still hits it (and a pattern that held one could never match)
    action = m.Action(bot='vendas', tool='terminal', command='r' + ZWSP + 'm -rf /tmp/x')
    assert decided(m, [plain[0]], action) == 'cmd'
    assert decided(m, [plain[1]], m.Action(bot='vendas', tool='write' + ZWSP + '_file')) == 'tool'


def inv_a_path_condition_accepts_a_hidden_character_and_matches_exactly_it(m):
    def path_rule(rule_id, level, key, value):
        return tp.rule(m, rule_id, level, conditions=((key, value),))
    eq = path_rule('eq', m.Level.BLOCK, 'path', 'workspace:docs/' + PERSIAN)                # a Persian file name with a ZWNJ
    assert codes(m, eq) == [] and m.path_pattern_ok('eq', 'workspace:docs/' + PERSIAN)       # accepted
    assert tp.effect(m, [eq], 'workspace:docs/' + PERSIAN) == 'block'                       # and it matches exactly that name
    for other in (PERSIAN.replace(ZWNJ, ''), PERSIAN.replace(ZWNJ, ZWSP), PERSIAN.replace(ZWNJ, ZWJ), PERSIAN.replace(ZWNJ, ZWNJ * 2), PERSIAN.replace(ZWNJ, ' ')):
        assert tp.effect(m, [eq], 'workspace:docs/' + other) == 'none', repr(other)           # ...and no other: the hidden character is NEVER dropped, doubled or swapped
    for ch in HIDDEN:                                                                       # every kind of hidden character is expressible in a path
        name = 'workspace:docs/a' + ch + 'b.txt'
        r = path_rule('eq', m.Level.BLOCK, 'path', name)
        assert codes(m, r) == [] and tp.effect(m, [r], name) == 'block' and tp.effect(m, [r], 'workspace:docs/ab.txt') == 'none', hex(ord(ch))
    allow = path_rule('allow', m.Level.ALLOW, 'path', 'workspace:docs/' + PERSIAN)          # the permissive side compares the exact text as well
    assert codes(m, allow) == [] and tp.effect(m, [allow], 'workspace:docs/' + PERSIAN) == 'allow' and tp.effect(m, [allow], 'workspace:docs/' + PERSIAN.replace(ZWNJ, '')) == 'none'
    under = path_rule('under', m.Level.BLOCK, 'path:under', 'workspace:docs/a' + ZWNJ + 'b')
    assert codes(m, under) == [] and tp.effect(m, [under], 'workspace:docs/a' + ZWNJ + 'b/x.txt') == 'block' and tp.effect(m, [under], 'workspace:docs/ab/x.txt') == 'none'
    # the defensive rule: "block any file name that holds a bidi override"
    defence = path_rule('defence', m.Level.BLOCK, 'path:glob', 'workspace:**/*' + RLO + '*')
    assert codes(m, defence) == [] and m.path_pattern_ok('glob', 'workspace:**/*' + RLO + '*')
    for name in ('workspace:docs/a' + RLO + 'txt.exe', 'workspace:docs/sub/' + RLO + 'x', 'workspace:' + RLO + 'top'):
        assert tp.effect(m, [defence], name) == 'block', repr(name)
    for name in ('workspace:docs/a.txt.exe', 'workspace:docs/a' + ZWNJ + 'b', 'workspace:docs/sub/x'):
        assert tp.effect(m, [defence], name) == 'none', repr(name)                           # a name WITHOUT the override, or with another hidden character, is not blocked by it


def inv_a_label_accepts_a_hidden_character(m):
    label = 'Bloquear nome com ' + ZWNJ + 'RLO ' + RLO + 'txt'
    r = m.Rule(id='lab', label=label, level=m.Level.BLOCK, scope=m.Scope(m.ScopeKind.GLOBAL), match=m.Match(tools=('write_file',)), state=m.RuleState.ACTIVE, origin=m.Origin.HUMAN)
    assert codes(m, r) == [] and r.label == label                                           # the rule validates with it
    assert service._label(label) == label and service._label(' ' + label + ' ') == label     # the API takes it, whole (only whitespace is trimmed)
    assert service._label('Pagina' + ZWSP) == 'Pagina' + ZWSP
    for bad in ('', '   ', 'x' * 121, None, 5):
        with pytest.raises(Exception):  # noqa: B017  (the closed refusal of a label stays: empty, too long, not text)
            service._label(bad)
    draft = m.draft_from_always_allow(m.Action(bot='vendas', tool='write_file'), label=label, rule_id='draft')
    assert draft.label == label and codes(m, draft) == []                                    # and so does the draft the card's "always allow" makes


INVARIANTS = {n[4:]: f for n, f in globals().items() if n.startswith('inv_')}
A, P, L = tuple(INVARIANTS)
INVISIBLE_LINE = '                            or any(_invisible(c) for c in text)\n'
MUTATIONS = [
    (A, 'a pattern accepts a hidden character', INVISIBLE_LINE, ''),
    (A, 'the command accepts a hidden character', INVISIBLE_LINE, '                            or (field == "tools" and any(_invisible(c) for c in text))\n'),
    (A, 'the tool accepts a hidden character', INVISIBLE_LINE, '                            or (field == "commands" and any(_invisible(c) for c in text))\n'),
    (A, 'a plain name accepts a hidden character', '                    elif not (canon_name(name)[1] if permissive else _usable_name(name)):', '                    elif False:'),
    (A, 'the matcher keeps the invisible characters of a command', '            clean = False\n            continue\n', '            clean = False\n'),
    (A, 'the matcher keeps the invisible characters of a tool', '    plain = "".join(c for c in folded if not c.isspace() and not _invisible(c))', '    plain = "".join(c for c in folded if not c.isspace())'),
    (P, 'a path condition refuses a hidden character', '    if parts is None or "\\\\" in value:\n        return False\n    if op in ("eq", "under"):',
     '    if parts is None or "\\\\" in value or any(unicodedata.category(c) in _INVISIBLE for c in value):\n        return False\n    if op in ("eq", "under"):'),
    (P, 'a path name drops its hidden characters', '    return _fold(text)  # the engine\'s own fold (NFKC + case), applied to ONE segment, never to the whole path',
     '    return "".join(c for c in _fold(text) if unicodedata.category(c) not in _INVISIBLE)'),
    (P, 'a path name keeps only the letters', '    return _fold(text)  # the engine\'s own fold (NFKC + case), applied to ONE segment, never to the whole path', '    return "".join(c for c in _fold(text) if c.isalnum() or c in "._-")'),
    (L, 'the draft drops the hidden character of the label', 'label=str(label)[:120], level=level, scope=Scope(ScopeKind.BOT, action.bot)',
     'label="".join(c for c in str(label)[:120] if unicodedata.category(c) not in _INVISIBLE), level=level, scope=Scope(ScopeKind.BOT, action.bot)'),
]


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(name):
    INVARIANTS[name](real)


def test_every_invariant_has_a_mutation():
    assert set(INVARIANTS) == {inv for inv, *_ in MUTATIONS}


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(tmp_path_factory, invariant, label, old, new):
    variant = tp.load_variant(tmp_path_factory, old, new)
    with pytest.raises(Exception):  # noqa: B017  (red = the invariant noticed; any failure of the check counts)
        INVARIANTS[invariant](variant)
