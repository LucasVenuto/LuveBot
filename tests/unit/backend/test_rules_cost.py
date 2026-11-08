"""A-203 (the Prumo; the cost of every matcher that reads text a Bot writes): each form a hostile text can take has a budget per command, for the engine and for the hook.

Why: the engine and the hook run for EVERY tool call, inside the Bot's process, on text the Bot wrote. R-7 shipped a regex whose scheme part was rescanned from every letter of a long run: 16 KiB of lowercase hex or base64 cost
0.35 to 0.9 s a command (8 ms before), and no test noticed because the hostile payloads of the red team match the URL at the first try. So three invariants, each running on the real `backend.rules` and going red on variants with one
deliberate defect:
1. STATIC (runs first, so that a variant with an exponential backtracking never executes): no regex of the engine or of the hook repeats a repeat or an alternation without a bound (`(a+)+`, `(a|aa)*`, the shapes of
   catastrophic backtracking), and every regex with an unbounded repeat is on the reviewed list: a new one fails here until somebody gives it a hostile form below. The unbounded ones of today read a command or a pattern; the
   others of the hook path (`{1,64}`, `{1,20}`...) are bounded by construction and need no form.
2. A COMMAND of up to 16 KiB (and one of 2 MiB: the engine cuts it first) built from a run of every character a regex or a splitter accepts or refuses, from many `://`, `@`, `a@`, user info with and without an end, nested shells,
   characters whose fold is longer than the character (the one that expands most on this Python: 18 characters, U+FDFA on Unicode 16), hidden characters and emoji selectors, is decided by the engine and by the hook in under BUDGET seconds (the worst measured on the development machine is 0.05).
3. A PATTERN (the text a person typed: 512 characters, or up to ~9000 after the NFKC fold) is read in under BUDGET seconds, and meets the hostile commands in under BUDGET seconds.
Measured on the development machine (x86, Python 3.14, 12 rules and 11 hook entries): the slowest command is 0.05 s (a chain of `env -S`; the character that expands most, 16 KiB of it, is 0.04 s now and was 0.25 s, 98% of the budget, before
the folded text was cut at MAX_COMMAND: the Lume's F-A203-1), the slowest pattern against a command 0.09 s (a tail of 64 characters), a pattern read alone 3 ms; BUDGET is 0.25 s (15 times a plain command, up to 1 s, when the machine is slow: `limit_of`), and the defects below are 1 to 7 s.
NOT bounded, and said: `glob_match` costs the text times the literal that follows the last `*` of the pattern (about 1.3 ms per character of that tail on 16 KiB, so 0.65 s for an adversarial tail of 500 characters, and 3 ms for
the patterns people write); it is a hostile PATTERN, not a hostile text, and the Architect decided to leave it and SAY it (A-204, docs/threat-model.md R-17): measured once for a table of 109 rules and 255 patterns against hostile
16 KiB commands, 0.09 s a call at most (0.21 s with a quarter of the patterns starting with `*`, 0.40 s with five patterns of a tail of 40 to 200 characters), under the 1 s at which the matcher would be changed. The path matcher is bounded
by MAX_PATH (a tag over 1024 characters is `unresolved`): 30 ms at most."""
from __future__ import annotations

import ast
import re
import sys
import time
from pathlib import Path

import pytest

try:
    from re import _constants as sre_constants, _parser as sre_parser
except ImportError:  # before Python 3.11 (the installs of Hermes run 3.11 to 3.14)
    import sre_constants
    import sre_parse as sre_parser

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_rules_paths', reason='the builders and the variant loader of the rules')

import backend.rules as real  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
BUDGET = 0.25                       # seconds a command or a pattern may cost, in the engine or in the hook, on a machine at rest
_LIMIT = [BUDGET]                   # what the dynamic invariant running now may cost: see `limit_of`
_MODULE = [None]                   # the module `limit_of` last took the limit for: `spent` takes it again
N = 16000


def worst_expander():
    """The character whose fold (NFKC and case) is longest on THIS Python, never a hard-coded one: U+FDFD is 18 characters up to Python 3.13 and ONE on 3.14 (Unicode 16), where U+FDFA is the 18 (the Lume's F-A203-1)."""
    return max((chr(c) for c in range(0x10000) if not 0xD800 <= c < 0xE000), key=lambda ch: len(real._fold(ch)))


EXPANDER = worst_expander()
MAXREPEAT = sre_constants.MAXREPEAT
HOOK_PATH_FILES = ('backend/hook.py', 'backend/hook_store.py', 'backend/recipients.py', 'backend/workspace.py', 'backend/unicode_invisible.py', 'hermes-plugin/__init__.py')
UNBOUNDED_REVIEWED = {'_ASSIGN', '_INTERPRETER', '_NUMERIC', '_SIMPLE_WORD', '_AUTHORITY', '_AUTHORITY_OF_A_PATTERN', '_IPV4_FORM', '_IPV4_TOKEN'}   # module-level, each with a hostile form in 2 or 3
INLINE_REVIEWED = {r'[a-z0-9.-]+'}                                                                                                                      # `re.fullmatch` in `_host_name`: a host run, in 2


def rep(token, n=N):
    return (token * (n // len(token) + 1))[:n]


# ---- 1. static -----------------------------------------------------------------------------------------------------------------------------------------------

def _walk(parsed, out, under_unbounded=False):
    """Collect (kind, unbounded, nested) for every repeat and branch of a parsed regex: `nested` = it sits under an unbounded repeat."""
    for op, av in parsed:
        if op in (sre_constants.MAX_REPEAT, sre_constants.MIN_REPEAT, getattr(sre_constants, 'POSSESSIVE_REPEAT', None)):
            low, high, body = av
            unbounded = high == MAXREPEAT
            if under_unbounded and high > 1:
                out.append(('a repeat inside an unbounded repeat', True))
            out.append(('repeat', unbounded))
            _walk(body, out, under_unbounded or unbounded)
        elif op == sre_constants.BRANCH:
            if under_unbounded:
                out.append(('an alternation inside an unbounded repeat', True))
            for branch in av[1]:
                _walk(branch, out, under_unbounded)
        elif op == sre_constants.SUBPATTERN:
            _walk(av[3], out, under_unbounded)
        elif op in (sre_constants.ASSERT, sre_constants.ASSERT_NOT):
            _walk(av[1], out, under_unbounded)
        elif op == getattr(sre_constants, 'ATOMIC_GROUP', None):
            _walk(av, out, under_unbounded)


def shape(pattern, flags=0):
    """(has an unbounded repeat, the dangerous shapes found) for the source text of a regex."""
    found = []
    _walk(sre_parser.parse(pattern, flags), found)
    return any(unbounded for kind, unbounded in found if kind == 'repeat'), sorted({kind for kind, danger in found if kind != 'repeat'})


def regexes_of(m):
    """([(name, source, flags)] of every module-level regex of the engine and of its table of invisible characters, [(where, source)] of every inline `re.<fn>(<literal>)` of the files the hook path loads).
    A `re.compile` call is not an inline one: what it makes is a module-level name, found above."""
    named = []
    for module in (m, m.unicode_invisible):
        for name, value in sorted(vars(module).items()):
            if isinstance(value, re.Pattern):
                named.append((name, value.pattern, value.flags & ~re.UNICODE))
    inline = []
    for path in [Path(m.__file__)] + [ROOT / rel for rel in HOOK_PATH_FILES]:
        for node in ast.walk(ast.parse(path.read_text(encoding='utf-8'))):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id == 're'
                    and node.func.attr in ('sub', 'subn', 'search', 'match', 'fullmatch', 'findall', 'finditer', 'split')
                    and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)):
                inline.append((f'{path.name}:{node.lineno}', node.args[0].value))
    return named, inline


def inv_no_regex_repeats_a_repeat_and_every_unbounded_one_is_reviewed(m):
    named, inline = regexes_of(m)
    seen = set()
    for name, source, flags in named:
        unbounded, dangers = shape(source, flags)
        assert not dangers, (name, source, dangers)                                                                   # the shapes of catastrophic backtracking
        if unbounded:
            assert name in UNBOUNDED_REVIEWED, f'{name}: an unbounded regex with no hostile form; give it one in the commands or the patterns below, then add it to UNBOUNDED_REVIEWED'
            seen.add(name)
    for where, source in inline:
        unbounded, dangers = shape(source)
        assert not dangers, (where, source, dangers)
        assert not unbounded or source in INLINE_REVIEWED, f'{where}: an inline unbounded regex with no hostile form: {source}'
    assert seen == UNBOUNDED_REVIEWED, sorted(UNBOUNDED_REVIEWED - seen)                                              # and no name on the list is a regex that is gone


# ---- 2. a command a Bot writes ---------------------------------------------------------------------------------------------------------------------------------

ATOMS = {
    'letters': 'a', 'digits': '7', 'dots': '.', 'hyphens': '-', 'plus signs': '+', 'underscores': '_', 'colons': ':', 'slashes': '/', 'percent signs': '%', 'escaped percent': '%41', 'hex prefixes': '0x', 'at signs': '@', 'a@': 'a@',
    'question marks': '?', 'hashes': '#', 'stars': '*', 'brackets': '[]', 'spaces': ' ', 'tabs': '\t', 'newlines': '\n', 'semicolons': ';', 'a;': 'a;', 'and-and': 'a&&', 'pipes': 'a|', 'double quotes': '"', 'single quotes': "'",
    'backslashes': '\\', 'dollar paren': '$(', 'backticks': '`', 'words': 'a ', 'assignments': 'x=1 ', 'dotted digits': '1.', 'dotted hex': '0x1.', 'scheme separators': '://', 'one-letter schemes': 'a://', 'http': 'http://',
    'user info': 'http://a@', 'two user infos': 'http://a@b@', 'empty user info': 'http://@', 'nested sh': "sh -c '", 'nested eval': 'eval "', 'xargs': 'xargs ', 'env -S': 'env -S "', 'find -exec': 'find . -exec ',
    'command substitution': 'bash -c "$(', 'wrappers': 'nice -n 1 ', 'env assignments': 'env A=1 ',
    'the character that expands most': EXPANDER, 'zero width spaces': chr(0x200B), 'emoji selectors': chr(0x2714) + chr(0xFE0F), 'combining marks': 'a' + chr(0x301), 'ligatures': chr(0xFB03), 'joiners': chr(0x200D),
    'fullwidth letters': chr(0xFF41), 'sharp s': chr(0xDF), 'squared units': chr(0x3392), 'tag characters': chr(0xE0041),
    'ideographic stops': chr(0x3002), 'dotted digits with stops': '1' + chr(0x3002), 'erased by IDNA': chr(0x1806),      # R-10: read as a dot in a host, and dropped
}
REFUSED = ('letters', 'digits', 'dots', 'hyphens', 'plus signs', 'underscores', 'colons', 'slashes', 'percent signs', 'at signs', 'a@', 'escaped percent')   # a run, then a character the class refuses: the classic trigger
URL_SHAPES = {
    'long host': lambda a: 'curl http://' + rep(a),
    'user info with no end': lambda a: 'curl http://' + rep(a, N // 2) + '@' + rep('b', N // 2),
    'user info to the last @': lambda a: 'curl http://' + rep(a) + '@x',
    'port': lambda a: 'curl http://x:' + rep(a) + '/',
    'path after': lambda a: 'curl http://x/' + rep(a),
}
URL_ATOMS = ('letters', 'digits', 'at signs', 'a@', 'escaped percent', 'dotted digits', 'hex prefixes', 'colons', 'scheme separators', 'dots', 'dotted digits with stops', 'erased by IDNA')


def hostile_commands():
    yield '2 MiB command', 'curl -d ' + 'a' * 2_000_000                                                         # the engine cuts the command before it reads it
    yield '2 MiB command of the character that expands most', 'curl -d ' + EXPANDER * (2 * 1024 * 1024)        # ...and what keeps that cut honest: an ASCII one folds fast either way, this one costs 10 s if it is folded first
    for name, atom in ATOMS.items():
        yield name, ('curl -d ' + rep(atom))[:16384]
        if name in REFUSED:
            yield f'{name} then a refused character', ('curl -d ' + rep(atom) + '!')[:16384]
    for shape_name, build in URL_SHAPES.items():
        for name in URL_ATOMS:
            yield f'{shape_name}: {name}', build(ATOMS[name])[:16384]


def realistic_rules(m):
    level = m.Level
    rules = [tp.rule(m, 'block', level.BLOCK, tools=('terminal',), commands=('curl *127.0.0.1*', 'curl *169.254.169.254*', 'rm -rf *')),
             tp.rule(m, 'ask', level.ASK, tools=('terminal',), commands=('curl *example.com/*', 'sudo *', 'git push *')),
             tp.rule(m, 'allow', level.ALLOW, tools=('terminal',), commands=('git commit *', 'ls *', 'curl *')),
             tp.rule(m, 'paths', level.ASK, conditions=(('path:glob', 'workspace:**/' + 'a/' * 100 + 'b'),))] + list(m.builtin_rules())
    return rules, m.compile_hook_table(rules, version=1, toolset_tools={}, mcp_server_tools={})


def limit():
    return _LIMIT[0]


def limit_of(m):
    """BUDGET, or 15 times what a plain 16 KiB command costs on THIS machine right now when that is more, and never over 1 s: a loaded machine slows everything alike (0.254 s was seen once for a case that takes 0.09 s at rest, with the load
    average at 14), and a defect is 20 times a plain command and more. Sets what `spent` and the assertions compare with."""
    rules = [tp.rule(m, 'b', m.Level.BLOCK, tools=('terminal',), commands=('curl *localhost*',))]
    plain = 'curl -d ' + 'abc ' * (N // 4)
    best = min(spent_once(lambda: m._evaluate_full(rules, m.Action(bot='v', tool='terminal', command=plain))) for _ in range(3))
    _LIMIT[0] = min(1.0, max(BUDGET, 15 * best))
    _MODULE[0] = m
    return _LIMIT[0]


def spent_once(fn):
    started = time.perf_counter()
    fn()
    return time.perf_counter() - started


def spent(fn):
    """Seconds fn takes; one that goes over the limit is measured once more and the smaller counts (a loaded machine has outliers), a defect is slow every time.
    The limit is taken again before the second measure: the load of a machine that other processes share comes in bursts (a case took 0.312 s against a limit of
    0.263 s taken when the machine was quieter, with the load average at 121), and a defect is still 20 times a plain command and more at any load."""
    best = spent_once(fn)
    if best < limit():
        return best
    limit_of(_MODULE[0])
    return min(best, spent_once(fn))


def inv_a_command_a_bot_writes_is_decided_within_the_budget(m):
    limit_of(m)
    text, clean = m._command_text('curl -d ' + EXPANDER * N)
    assert len(text) <= m.MAX_COMMAND and clean is False, (len(text), clean)                                       # the fold can make a command 18 times longer than the cap: the text is cut again and the action is asked about (F-A203-1)
    rules, table = realistic_rules(m)
    for name, command in hostile_commands():
        engine = spent(lambda: m._evaluate_full(rules, m.Action(bot='v', tool='terminal', command=command)))
        assert engine < limit(), f'engine, {name}: {engine:.3f} s'
        hook = spent(lambda: m.hook_verdict(table, tool='terminal', command=command))
        assert hook < limit(), f'hook, {name}: {hook:.3f} s'
    for tag in ('workspace:' + 'a/' * 500 + 'b', 'workspace:' + 'a' * 1000, 'workspace:' + '*/' * 500 + 'b'):     # the path tags: at most MAX_PATH, so bounded
        assert spent(lambda: m._evaluate_full(rules, m.Action(bot='v', tool='write_file', facts=(('path', tag),)))) < limit(), tag[:20]


# ---- 3. a pattern a person typed -------------------------------------------------------------------------------------------------------------------------------

LONG = 10000    # beyond the 512 characters a pattern may have and beyond the ~9000 an NFKC fold can make of them: a quadratic form shows
FOLDED_PATTERNS = {
    'long user info': 'curl http://' + rep('a@', LONG), 'many separators': rep('a://', LONG), 'many schemes': rep('http://h/', LONG), 'escaped percent': 'curl http://' + rep('%41', LONG),
    'dotted digits': 'curl *' + rep('1.', LONG), 'hex prefixes': 'curl *' + rep('0x', LONG), 'octets': 'curl *' + rep('127.', LONG), 'digits then a refused character': '*' + rep('1', LONG) + 'z',
    'letters then a refused character': '*' + rep('a', LONG) + '!', 'at signs': 'curl http://' + rep('@', LONG), 'colons': 'curl *' + rep(':', LONG), 'expanded by the fold': 'curl *' + rep(EXPANDER, LONG // 10),
    'port': 'curl http://x:' + rep('9', LONG), 'zeros port': 'curl http://x:' + rep('0', LONG) + '80/',
}
PATTERNS = {   # what a rule may hold (512 characters), against the hostile commands below; none has a literal tail of more than 64 characters after a `*` (the limit said above)
    'long user info': 'curl http://' + 'a@' * 240, 'many separators': 'a://' * 125, 'many schemes': 'http://h/' * 55, 'escaped percent': 'curl http://' + '%41' * 160, 'dotted digits': 'curl http://' + '1.' * 240,
    'hex prefixes': 'curl http://' + '0x' * 240, 'octets': 'curl http://' + '127.' * 120, 'a tail of 64': 'curl *' + 'a' * 63 + 'b', 'a tail of 64 with ?': '*' + 'a?' * 31 + 'b', 'stars': 'a*' * 250,
    'realistic': 'curl *169.254.169.254/latest/meta-data/*', 'expanded by the fold': 'curl *' + EXPANDER * 28,
}
COMMANDS = ('curl ' + 'a' * N, 'curl http://' + 'a@' * (N // 2), 'curl http://' + '1.' * (N // 2), 'curl ' + 'http://a@' * 1800, 'curl ' + EXPANDER * N)


def inv_a_pattern_is_read_within_the_budget(m):
    limit_of(m)
    for name, pattern in FOLDED_PATTERNS.items():
        assert spent(lambda: m._destination_forms(pattern)) < limit(), f'forms of a pattern, {name}'
    for name, pattern in PATTERNS.items():
        rule = tp.rule(m, 'r', m.Level.BLOCK, tools=('terminal',), commands=(pattern,))
        assert spent(lambda: m._destination_forms(m._squash(m._fold(pattern)))) < limit(), f'forms, {name}'
        assert spent(lambda: m.validate_rule(rule)) < limit(), f'validate, {name}'
        table = None

        def compiled():
            nonlocal table
            table = m.compile_hook_table([rule], version=1, toolset_tools={}, mcp_server_tools={})
        assert spent(compiled) < limit(), f'compile, {name}'
        for command in COMMANDS:
            engine = spent(lambda: m._evaluate_full([rule], m.Action(bot='v', tool='terminal', command=command[:16384])))
            assert engine < limit(), f'engine, {name} against {command[:14]!r}: {engine:.3f} s'
            hook = spent(lambda: m.hook_verdict(table, tool='terminal', command=command[:16384]))
            assert hook < limit(), f'hook, {name} against {command[:14]!r}: {hook:.3f} s'


INVARIANTS = {n[4:]: f for n, f in globals().items() if n.startswith('inv_')}
S, K, P = tuple(INVARIANTS)

LOOKBEHIND = r'r"(?<![0-9A-Za-z_:-])(?<![0-9A-Za-z_-]\.)("'
MUTATIONS = [
    (S, 'the user info is a repeated group', r'://(?:[^/?#\s]*@)?(?P<host>', r'://(?:[^/?#\s]*@)*(?P<host>'),
    (S, 'a regex repeats an alternation', r'_INTERPRETER = re.compile(r"(?:python|pypy)[0-9.]*|py")', r'_INTERPRETER = re.compile(r"(?:python|pypy|py)+[0-9.]*")'),
    (S, 'an unreviewed unbounded regex is added', r'_ASSIGN = re.compile(r"[a-z_][a-z0-9_]*=\S*")', '_ASSIGN = re.compile(r"[a-z_][a-z0-9_]*=\\S*")\n_UNREVIEWED = re.compile(r"[a-z]+x")'),
    (S, 'an unreviewed inline regex is added', 're.sub(r"[^A-Za-z0-9_]", "_", value)', 're.sub(r"[^A-Za-z0-9_]+", "_", value)'),
    (S, 'a reviewed regex is gone', r'_NUMERIC = re.compile(r"[0-9][0-9a-z.:]*")', r'_NUMERIC = re.compile(r"[0-9]{1,40}")'),
    (K, 'the scheme has no length bound', '{0,31})://', '*)://'),
    (K, 'the command is not cut before it is read', 'folded, simple = _fold_plain(raw[:MAX_COMMAND])', 'folded, simple = _fold_plain(raw)'),
    (K, 'the folded text is not cut', 'folded, clean = folded[:MAX_COMMAND], False', 'pass'),
    (K, 'the folded text is cut but the action stays clean', 'folded, clean = folded[:MAX_COMMAND], False', 'folded = folded[:MAX_COMMAND]'),
    (P, 'the IPv4 token has no lookbehind', LOOKBEHIND, r'r"(?<![0-9A-Za-z_-]\.)("'),
]


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(name):
    INVARIANTS[name](real)


def test_every_invariant_has_a_mutation():
    assert set(INVARIANTS) == {inv for inv, *_ in MUTATIONS}


def test_every_mutation_anchors_once():
    source = (ROOT / 'backend' / 'rules.py').read_text(encoding='utf-8')
    for _inv, label, old, _new in MUTATIONS:
        assert source.count(old) == 1, label


def test_the_hook_path_files_exist():
    assert all((ROOT / rel).is_file() for rel in HOOK_PATH_FILES)


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(tmp_path_factory, invariant, label, old, new):
    variant = tp.load_variant(tmp_path_factory, old, new)
    with pytest.raises(Exception):  # noqa: B017  (red = the invariant noticed; any failure of the check counts)
        INVARIANTS[invariant](variant)
