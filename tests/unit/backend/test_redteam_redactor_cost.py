"""Red team (Lume, 31/10) of the cost of the REDACTOR that the Pages and the notes index hand every page and every note to (A-228 follow-up, after P-1).
P-1 made `pages.excerpt` linear, but the text still goes through `redact_sensitive_text`, which `page_view` runs over the WHOLE page (1 MiB) and `excerpt` over a window of 16 to 64 KiB, and which
Hermes writes itself. MEASURED ON THE REAL FUNCTION (Forja, Hermes v0.22.5, Python 3.14.5; evidence/a228-redact-cost/, rounds 1 and 2): it stalls or crawls on EIGHT shapes of text that the author of a page or a note controls.
`-----BEGIN PRIVATE KEY-----` lines with no END (a lazy `[\\s\\S]*?` that rescans to the end from every BEGIN): 64 KiB 1.5 s, 256 KiB 26 s, the longest gap of a 2 ms heartbeat thread is the whole call (`re` holds the GIL: the dashboard stops).
`a.token` x N + ` k=v` and `token.` x N + ` k=v` (`_CFG_DOTTED_RE`, CUBIC: 4 KiB 7 s and 10.6 s, 8 KiB does not answer in 30 s). The quadratic ones, at 16 KiB: `token` x N (`_CFG_ANCHORED_RE`) 2.6 s, `token_a` x N 3.3 s,
`a-token` x N 1.2 s, the YAML pass 0.7 s, `API_KEY=${A` + `a` x N (`_PATH_OR_VAR_VALUE_RE`) 0.4 to 0.7 s. The shapes carry the partner their gate needs (the secret word AND an `=` or a `:` somewhere in the text): the first
probe did not, and found nothing. The stand-in for Hermes is `redteam_wiring.cost_model` (the passes copied verbatim, behind the gates of the real function);
the redactor is the one dashboard/plugin_api.py hands over, rebuilt from the TEXT of that file, so a guard anywhere on the path (the lambda, a backend module, the Pages) is measured, and the
mechanism is not prescribed: process isolation with a deadline (P-3), an upstream fix and a version gate, bounding the input, are all acceptable. Two rules hold whatever the mechanism: the time is bounded
at 1 MiB, and the answer FAILS CLOSED: a key planted in the first line of the hostile page never shows (a guard that gives up and returns the raw text would leak it).
Each case runs in a CHILD with a time limit, because the unguarded code takes minutes: a child that does not answer in time is the failure. `xfail(strict=True)` = red today."""
import json
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from redteam_wiring import shaped  # noqa: E402

HERE = str(Path(__file__).resolve().parent)
ROOT = str(Path(__file__).resolve().parents[3])
TIMEOUT_S, BUDGET_S = 2.0, 1.0
KEY = 'sk-' + 'a1b2c3d4e5f6' * 3 + 'ZqXw'                                          # built here: no key lives in the repo
FIRST_LINE = 'chave: ' + KEY + chr(10)                                              # in the first 200 characters: the excerpt would show it

CHILD = textwrap.dedent('''
    import json, sys, threading, time
    sys.path[:0] = [%r, %r]
    import redteam_wiring as w
    import backend.pages as pg
    prefix, prim, suffix, size, key = json.loads(sys.argv[1])
    redact = w.redactor_named('_REDACT', w.cost_model)
    text = prefix + (prim * (size // len(prim) + 1))[:size] + suffix
    data = text.encode()
    stat = type('S', (), {'st_size': len(data), 'st_mtime': 0})()
    gaps, stop = [], []
    def beat():
        last = time.perf_counter()
        while not stop:
            time.sleep(0.002); now = time.perf_counter(); gaps.append(now - last); last = now
    threading.Thread(target=beat, daemon=True).start(); time.sleep(0.05); gaps.clear()
    started = time.perf_counter()
    view = pg.page_view('s', data, stat, None, ('a', 'b'), redact)
    out = {'seconds': time.perf_counter() - started, 'gap': max(gaps or [0]), 'leak': key in json.dumps(view)}
    stop.append(1); print(json.dumps(out))
''' % (ROOT, HERE))

# (the repeated unit, what the gate of the pass needs after it, and a line before it). The shapes of the second round on the REAL Hermes (Forja, v0.22.5; evidence/a228-redact-cost/round2.txt): the cubic ones stall at 8 KiB
# (`a.token` x N + ` k=v`: 4 KiB 7 s; `token.` x N: 4 KiB 10.6 s), the quadratic ones at 16 KiB cost 0.4 to 3.3 s.
KINDS = {
    'private-key-lines': ('-----BEGIN PRIVATE KEY-----' + chr(10), '', ''),
    'dotted-run': ('a.token', ' k=v', ''),
    'token-dot-run': ('token.', ' k=v', ''),
    'keyword-run': ('token', ' k=v', ''),
    'under-run': ('token_a', ' k=v', ''),
    'dash-run': ('a-token', ' k=v', ''),
    'yaml-run': ('a.token', ' k:v', ''),
    'envvar-ref-run': ('a', '', 'API_KEY=${A'),
}
SMALL = {'private-key-lines': 256 * 1024, 'dotted-run': 64 * 1024, 'keyword-run': 64 * 1024}      # the smaller case, for the three that differ most (a pattern each). The size is one at which the unguarded cost is far over the
# 2 s limit of the child at ANY load. A strict xfail on TIME must never pass by chance: the PEM shape costs 1.1 s at 64 KiB and 4.7 s at 128 KiB on this machine (a faster one, or a quiet moment, would bring 128 KiB near the limit), 35 s at
# 256 KiB (17 times the limit); the others cost 32 s at 64 KiB (keyword) or do not finish in 90 s at 16 KiB (dotted).


def measure(kind, size):
    prim, suffix, extra = KINDS[kind]
    try:
        done = subprocess.run([sys.executable, '-c', CHILD, json.dumps([FIRST_LINE + extra, prim, suffix, size, KEY])], capture_output=True, text=True, timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return None
    assert done.returncode == 0, done.stderr[-500:]
    return json.loads(done.stdout)


@pytest.mark.parametrize('kind', shaped(list(KINDS), 'page_view hands the redactor the whole page (1 MiB) and the dashboard freezes for as long'))
def test_a_hostile_page_of_1_mib_through_page_view_is_bounded_and_fails_closed(kind):
    out = measure(kind, 1024 * 1024)
    assert out is not None, f'{kind} x 1 MiB did not finish in {TIMEOUT_S} s: the dashboard is frozen for as long'
    assert out['seconds'] < BUDGET_S and out['gap'] < BUDGET_S, out
    assert not out['leak'], 'the planted key shows: the guard gave up and returned the raw text'


@pytest.mark.parametrize('kind', shaped(list(SMALL), 'the excerpt hands the redactor a window of up to 64 KiB of text the page author controls'))
def test_a_hostile_page_of_64_to_256_kib_is_bounded_too(kind):
    out = measure(kind, SMALL[kind])
    assert out is not None, f'{kind} x {SMALL[kind] // 1024} KiB did not finish in {TIMEOUT_S} s'
    assert out['seconds'] < BUDGET_S and out['gap'] < BUDGET_S, out
    assert not out['leak']


def test_an_ordinary_page_is_far_below_the_budget_and_its_key_is_redacted():
    prim = 'Uma frase comum, com [um link](http://x/y), **negrito**, `codigo` e <b>html</b>.' + chr(10)
    prefix = FIRST_LINE
    KINDS['ordinary'] = (prim, '', '')
    try:
        out = measure('ordinary', 1024 * 1024)
    finally:
        del KINDS['ordinary']
    assert out is not None and out['seconds'] < BUDGET_S and not out['leak'], out        # the control for the budget and for the stand-in: the key of the first line is redacted


# ---- F-RD-2: private-key blocks the redactor does not recognise (the same stand-in: `_PRIVATE_KEY_RE` verbatim) ---------------------------------------------------------------------
BODY = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo' * 2                                    # what must never show
BLOCKS = {
    'RSA': ('-----BEGIN RSA PRIVATE KEY-----' + chr(10) + BODY + chr(10) + '-----END RSA PRIVATE KEY-----', True),
    'PKCS8': ('-----BEGIN PRIVATE KEY-----' + chr(10) + BODY + chr(10) + '-----END PRIVATE KEY-----', True),
    'OPENSSH': ('-----BEGIN OPENSSH PRIVATE KEY-----' + chr(10) + BODY + chr(10) + '-----END OPENSSH PRIVATE KEY-----', True),
    'ENCRYPTED': ('-----BEGIN ENCRYPTED PRIVATE KEY-----' + chr(10) + BODY + chr(10) + '-----END ENCRYPTED PRIVATE KEY-----', True),
    'CRLF': ('-----BEGIN PRIVATE KEY-----' + chr(13) + chr(10) + BODY + chr(13) + chr(10) + '-----END PRIVATE KEY-----', True),
    'quoted lines': ('> -----BEGIN PRIVATE KEY-----' + chr(10) + '> ' + BODY + chr(10) + '> -----END PRIVATE KEY-----', True),
    'truncated paste (no END)': ('-----BEGIN PRIVATE KEY-----' + chr(10) + BODY + chr(10) + BODY, False),
    'PGP private key block': ('-----BEGIN PGP PRIVATE KEY BLOCK-----' + chr(10) + BODY + chr(10) + '-----END PGP PRIVATE KEY BLOCK-----', False),
    'lowercase header': ('-----begin private key-----' + chr(10) + BODY + chr(10) + '-----end private key-----', False),
}


@pytest.mark.parametrize('name', [n for n, (_t, known) in BLOCKS.items() if known])
def test_a_private_key_block_the_redactor_knows_is_not_shown(name):
    import redteam_wiring as w
    assert BODY not in w.redactor_named('_REDACT', w.cost_model)(BLOCKS[name][0])


@pytest.mark.xfail(strict=True, raises=AssertionError, reason='F-RD-2: the redactor of Hermes (v0.22.5) needs `-----BEGIN ... PRIVATE KEY-----` in capitals AND a `-----END ... PRIVATE KEY-----`: a truncated paste, a PGP private key block and a lowercase header are shown in full, in every field')
@pytest.mark.parametrize('name', [n for n, (_t, known) in BLOCKS.items() if not known])
def test_a_private_key_block_the_redactor_does_not_know_is_not_shown_either(name):
    import redteam_wiring as w
    assert BODY not in w.redactor_named('_REDACT', w.cost_model)(BLOCKS[name][0])
