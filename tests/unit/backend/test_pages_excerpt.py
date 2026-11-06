"""A-226 (F-BR-9, public code): `pages.excerpt`, the plain text of the first 200 characters of a memory page or of a note,
is called by an index for EVERY approved note, under the index lock, and by the memory pages (a page may hold 1 MiB). It was
quadratic in the text for every mark that closes nothing ('[', '![', '<', a blank line before a marker): 32 KB of '![' cost 3 s and a
note of 256 KiB minutes, and `re` holds the GIL, so one hostile page froze the whole panel.

Three invariants, each also run against variants of pages.py with one defect each (every one must go red):
* `excerpt_reads_markup_as_before`: a table of readings (each mark with a canary at the 200th character, a secret that is only known
  whole) and an exact differential against the function as it was (the old regexes, copied here) over 6,000 random strings of marks,
  brackets, spaces and newlines and 80 realistic pages of up to 200 KB (the same comparison over 240,000 strings and 1,500 pages was run once, 0 differences);
* `clean_cost_is_linear`: the worst text of each mark through the cleaner, which reads a window of the page;
* `excerpt_cost_is_bounded`: the worst text of each mark at 1 MiB through `excerpt`, with a limit that follows the load of the machine."""
import importlib
import itertools
import random
import re
import shutil
import sys
import time
from pathlib import Path

import pytest

import backend.pages as real

SRC = Path(real.__file__).parent
_n = itertools.count()
ELLIPSIS = chr(0x2026)
OLD_FENCE = re.compile(r'^(```|~~~).*?(^\1[^\n]*$|\Z)', re.S | re.M)


def old_excerpt(text, redact):
    """The function as it was before A-226: five regexes that scan to the end of the text from every opener that closes nothing."""
    lines = text.split('\n')
    title = next((i for i, l in enumerate(lines) if l.startswith('# ')), None)
    body = '\n'.join(l for i, l in enumerate(lines) if i != title)
    body = OLD_FENCE.sub(' ', body)
    body = re.sub(r'!\[([^\]]*)\]\([^)]*\)', r'\1', body)
    body = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', body)
    body = re.sub(r'<[^>\n]*>', ' ', body)
    body = re.sub(r'(?m)^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)', '', body)
    body = re.sub(r'[*_~`]', '', body)
    body = redact(' '.join(body.split()))
    return body if len(body) <= 200 else body[:199].rstrip() + ELLIPSIS


def keep(text):
    return text


def hide_key(text):
    return text.replace('KEY123', 'K')


def hide_block(text):
    return re.sub(r'BEGIN-.*?-END', '[PEM]', text, flags=re.S)         # a block that is only known whole, like a PEM key


READINGS = [
    ('# T\nbody', 'body', keep),                                                  # the first title line is not in the excerpt
    ('a\n# T\nb', 'a b', keep),                                                   # wherever it is
    ('a\n# T', 'a', keep),
    ('a **b** _c_ ~d~ `e`', 'a b c d e', keep),                                   # emphasis characters go
    ('[x](y) and ![i](j)', 'x and i', keep),                                      # a link is its text, an image its alt text
    ('a <b>c</b> d', 'a c d', keep),                                              # a tag is a space
    ('- um\n* dois\n+ tres\n1. quatro\n2) cinco\n> seis\n## sete x', 'um dois tres quatro cinco seis sete x', keep),
    ('antes\n```\ncodigo\n```\ndepois', 'antes depois', keep),                    # a fenced block is gone
    ('```\ncodigo\n```\ndepois', 'depois', keep),
    ('a ```x``` b', 'a x b', keep),                                               # three backticks that do not start a line are not a fence
    ('~~~\na\n```\nb\n~~~\nc', 'c', keep),                                        # only the same three characters close it
    ('x\n```\ny', 'x', keep),                                                     # unclosed: to the end
    ('a [b and ![c and <d e', 'a [b and ![c and <d e', keep),                     # an opener that closes nothing stays
    ('[[a](b)', '[a', keep),                                                      # the text of a link may hold an opener
    ('![a ![b](c)', 'a ![b', keep),
    ('a [b] [c](d) e', 'a [b] c e', keep),
    ('a\n\n\n  - b', 'a b', keep),                                                # blank lines before a marker
    ('a - b # c > d', 'a - b # c > d', keep),                                     # a marker in the middle of a line is text
    ('####### x', '####### x', keep),                                             # seven # are not a marker
    ('-\n\n## x', 'x', keep),                                                     # a marker may be followed by blank lines and another marker
    ('<a\nb> c', '<a b> c', keep),                                                # a tag does not cross a line
    ('[a](\n[b](c)', 'a', keep),                                                 # the first link takes everything up to the first ')'
    ('y' * 300, 'y' * 199 + ELLIPSIS, keep),                                      # 200 characters at most
    ('<b>' * 6000 + 'FINAL words', 'FINAL words', keep),                          # text after a window that cleaned to nothing
    ('x' * 50 + ' BEGIN-' + 'A' * 300 + '<b>' * 6000 + 'A' * 300 + '-END tail', 'x' * 50 + ' [PEM] tail', hide_block),   # a block that ends in the next window
]
for filler in (170, 185, 195, 199):                                               # redacted BEFORE it is cut, at the 200th character, through every mark
    for wrap in ('[KEY123](u)', '![KEY123](u)', '<i>KEY123</i>', '**KEY123**', '`KEY123`', '\n- KEY123', '\n> KEY123', '\n## KEY123', '\n1. KEY123', 'KEY123'):
        whole = 'w' * filler + ' K tail'                                          # what the reader sees when the key is replaced before the cut
        READINGS.append(('w' * filler + ' ' + wrap + ' tail', whole if len(whole) <= 200 else whole[:199].rstrip() + ELLIPSIS, hide_key))
ALPHABET = list('![]()<>#-*+1.`~ \n\tab_') + [chr(0xA0), chr(0x2028), chr(0x0B), '\r', '0', '9', chr(0x663)]
WORDS = ['alfa', 'beta', 'gama', 'plano', 'reuniao', 'cliente', 'nota', 'tarefa']


def a_page(rng):
    parts, size, target = [], 0, rng.choice((500, 2000, 6000, 30000, 90000, 200000))
    while size < target:
        kind = rng.choice(('p', 'p', 'p', 'h', 'li', 'code', 'link', 'img', 'tag', 'quote', 'blank', 'num'))
        words = ' '.join(rng.choice(WORDS) for _ in range(rng.randint(3, 40)))
        fence = rng.choice(('```', '~~~'))
        text = {'p': words, 'h': '#' * rng.randint(1, 4) + ' ' + words, 'li': '- ' + words, 'num': '%d. %s' % (rng.randint(1, 9), words),
                'quote': '> ' + words, 'link': 'veja [%s](https://x.test/%s) e mais' % (rng.choice(WORDS), rng.choice(WORDS)),
                'img': '![%s](img.png) %s' % (rng.choice(WORDS), words), 'tag': '<b>%s</b> <br> %s' % (rng.choice(WORDS), words), 'blank': '',
                'code': fence + '\n' + '\n'.join('x = %d' % i for i in range(rng.randint(1, 60))) + '\n' + fence}[kind]
        parts.append(text)
        size += len(text) + 1
    return '\n'.join(parts)


CLEAN_SHAPES = {'[': ('[', 16000, ''), '![': ('![', 8000, ''), '<': ('<', 16000, ''), 'blank lines': ('\n', 8000, ''), 'spaces and newlines': (' \n', 6000, ''),
                'links never closed': ('[a](', 24000, ''), 'tags never closed': ('<a', 10000, ''),
                '[ and a ) at the end': ('[', 16000, ')'), '![ and a ) at the end': ('![', 8000, ')'), '[a]( and a ) before': (')[a](', 24000, '')}
MIB = 1024 * 1024
PAGE_SHAPES = ['[', '![', '<', '\n', ' \n', '[a](', '<a', '<a\n', '```\n', '~~~\n```\n', '```x ', '- \n', '#######\n', '# t\n', '<b>x</b> ', '[a]x', '])']


def inv_excerpt_reads_markup_as_before(m, tmp_path_factory):
    for text, want, redact in READINGS:
        assert m.excerpt(text, redact) == want, text
    for seed in range(6000):
        rng = random.Random(seed)
        text = ''.join(rng.choice(ALPHABET) for _ in range(rng.choice((3, 6, 12, 25, 50, 90, 300))))
        for redact in (keep, lambda s: s.replace('ab', 'X').replace('[', '{')):
            assert m.excerpt(text, redact) == old_excerpt(text, redact), repr(text)
    for seed in range(80):
        text = a_page(random.Random(10000 + seed))
        assert m.excerpt(text, keep) == old_excerpt(text, keep), (seed, len(text))


def best_of_three(fn):
    runs = []
    for _ in range(3):
        started = time.perf_counter()
        fn()
        runs.append(time.perf_counter() - started)
    return min(runs)


def machine_speed():
    """How long the old function takes on 64 KiB of ordinary lines: a measure of this machine, and of its load, that does not depend on the
    module under test (a defect in the module would raise any baseline taken from it)."""
    text = ('palavra palavra palavra\n' * 2800)[:65536]
    return best_of_three(lambda: old_excerpt(text, keep))


def under(fn, limit):
    """Whether `fn` runs in less than `limit`: once when it does, twice (the better of the two) before saying it does not, so that a
    defect that costs seconds is not run three times and a busy moment of the machine is not taken for one."""
    started = time.perf_counter()
    fn()
    first = time.perf_counter() - started
    if first < limit:
        return True
    started = time.perf_counter()
    fn()
    return min(first, time.perf_counter() - started) < limit


def inv_clean_cost_is_linear(m, tmp_path_factory):
    limit = min(1.0, max(0.25, 60 * machine_speed()))      # follows the load: a defect costs 20 times that and more
    for label, (unit, count, tail) in CLEAN_SHAPES.items():
        text = unit * count + tail
        assert under(lambda: m._clean(text), limit), (label, limit)


def inv_excerpt_cost_is_bounded(m, tmp_path_factory):
    """The work of `excerpt` is bounded by the window whatever the size of the page, COUNTED in the characters it gives the cleaner (a clock follows the load of the
    machine: a defect here was "DID NOT RAISE" two times in three at load 27): at most the doublings 16 KiB + 32 KiB + 64 KiB. A loose clock stays for a blow up of seconds."""
    seen, original = [], m._clean
    m._clean = lambda text: (seen.append(len(text)), original(text))[1]
    try:
        for unit in PAGE_SHAPES:
            text = (unit * (MIB // len(unit) + 1))[:MIB]
            seen.clear()
            m.excerpt(text, keep)
            assert sum(seen) <= 16384 + 32768 + 65536, (unit, sum(seen))
    finally:
        m._clean = original
    limit = max(2.0, 60 * machine_speed())
    for unit in PAGE_SHAPES:
        text = (unit * (MIB // len(unit) + 1))[:MIB]
        assert under(lambda: m.excerpt(text, keep), limit), (unit, limit)


INVARIANTS = {f.__name__[4:]: f for f in (inv_excerpt_reads_markup_as_before, inv_clean_cost_is_linear, inv_excerpt_cost_is_bounded)}
LIMITS = "_WINDOW, _WINDOW_MAX, _MARGIN = 16384, 65536, 8192"
MUTATIONS = [
    ('clean_cost_is_linear', 'an image opener that closed nothing is scanned again',
     "_IMAGE = re.compile(r'(?:!\\[([^\\]]*)\\]\\([^)]*\\)|(!\\[[^\\]]*))')", "_IMAGE = re.compile(r'(?:!\\[([^\\]]*)\\]\\([^)]*\\)())')"),
    ('clean_cost_is_linear', 'a link opener that closed nothing is scanned again',
     "_LINK = re.compile(r'(?:\\[([^\\]]*)\\]\\([^)]*\\)|(\\[[^\\]]*))')", "_LINK = re.compile(r'(?:\\[([^\\]]*)\\]\\([^)]*\\)())')"),
    ('clean_cost_is_linear', 'a tag opener that closed nothing is scanned again',
     "_TAG = re.compile(r'<[^>\\n]*>|<[^>\\n]*')", "_TAG = re.compile(r'<[^>\\n]*>')"),
    ('clean_cost_is_linear', 'the text is not cut at the last )', "    cut = text.rfind(')') + 1\n", "    cut = len(text)\n"),
    ('clean_cost_is_linear', 'the blank lines before a marker are part of it', "_MARK = re.compile(r'^[^\\S\\n]*(?:", "_MARK = re.compile(r'^\\s*(?:"),
    ('excerpt_cost_is_bounded', 'the window grows without a limit', LIMITS, "_WINDOW, _WINDOW_MAX, _MARGIN = 16384, 1 << 40, 8192"),
    ('excerpt_cost_is_bounded', 'the whole page is the window', LIMITS, "_WINDOW, _WINDOW_MAX, _MARGIN = 1 << 40, 65536, 8192"),
    ('excerpt_reads_markup_as_before', 'a failed opener is dropped', "pattern.sub(r'\\1\\2', text[:cut])", "pattern.sub(r'\\1', text[:cut])"),
    ('excerpt_reads_markup_as_before', 'the last ) is not in the cut', "    cut = text.rfind(')') + 1\n", "    cut = text.rfind(')')\n"),
    ('excerpt_reads_markup_as_before', 'every tag text becomes a space', "' ' if found.group().endswith('>') else found.group()", "' '"),
    ('excerpt_reads_markup_as_before', 'a tag that closed nothing becomes a space',
     "' ' if found.group().endswith('>') else found.group()", "' ' if not found.group().endswith('>') else found.group()"),
    ('excerpt_reads_markup_as_before', 'seven # are a marker', "#{1,6}\\s+|>\\s?", "#{1,7}\\s+|>\\s?"),
    ('excerpt_reads_markup_as_before', 'a numbered list is text', "|[-*+]\\s+|\\d+[.)]\\s+)', re.M)", "|[-*+]\\s+)', re.M)"),
    ('excerpt_reads_markup_as_before', 'a marker in the middle of a line goes', "_MARK = re.compile(r'^[^\\S\\n]*(?:", "_MARK = re.compile(r'[^\\S\\n]*(?:"),
    ('excerpt_reads_markup_as_before', 'a fenced block stays', "    text = _FENCE.sub(' ', text)\n", ""),
    ('excerpt_reads_markup_as_before', 'the title stays', "    first = 0 if text.startswith('# ') else text.find('\\n# ') + 1 or -1\n", "    first = -1\n"),
    ('excerpt_reads_markup_as_before', 'only a title on the first line is one', "else text.find('\\n# ') + 1 or -1", "else -1"),
    ('excerpt_reads_markup_as_before', 'emphasis characters stay', "re.sub(r'[*_~`]', '', _MARK.sub('', text))", "_MARK.sub('', text)"),
    ('excerpt_reads_markup_as_before', 'links before images', "    text = _unwrap(_IMAGE, text)\n    text = _unwrap(_LINK, text)\n", "    text = _unwrap(_LINK, text)\n    text = _unwrap(_IMAGE, text)\n"),
    ('excerpt_reads_markup_as_before', 'a text after a window that cleaned to nothing is lost', "or window >= _WINDOW_MAX:", "or True:"),
    ('excerpt_reads_markup_as_before', 'the redactor reads only the first window', "> 200 + _MARGIN or", "> 200 or"),
    ('excerpt_reads_markup_as_before', 'cut before redacting',
     "    body = redact(' '.join(body.split()))\n    return body if len(body) <= 200 else body[:199].rstrip() + '" + ELLIPSIS + "'",
     "    body = ' '.join(body.split())[:199]\n    return redact(body)"),
]


def load_variant(tmp_path_factory, old, new):
    pkg = tmp_path_factory.mktemp('pagesvariant') / f'pgv{next(_n)}'
    pkg.mkdir()
    for name in ('__init__.py', 'api_errors.py', 'audit.py', 'dbfile.py', 'identity.py', 'workspace.py', 'pages.py'):
        shutil.copy(SRC / name, pkg / name)
    text = (pkg / 'pages.py').read_text(encoding='utf-8')
    assert text.count(old) == 1, old
    (pkg / 'pages.py').write_text(text.replace(old, new), encoding='utf-8')
    sys.path.insert(0, str(pkg.parent))
    try:
        return importlib.import_module(f'{pkg.name}.pages')
    finally:
        sys.path.remove(str(pkg.parent))


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(tmp_path_factory, name):
    INVARIANTS[name](real, tmp_path_factory)


def test_every_invariant_has_a_mutation():
    assert set(INVARIANTS) == {inv for inv, *_ in MUTATIONS}


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(tmp_path_factory, invariant, label, old, new):
    variant = load_variant(tmp_path_factory, old, new)       # outside pytest.raises: a mutation that does not apply is an error
    with pytest.raises(AssertionError):
        INVARIANTS[invariant](variant, tmp_path_factory)
