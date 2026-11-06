"""What a text that anyone can write can cost the panel, through `isolated_redact` on the REAL redactor of Hermes and the REAL child process (this runs against
whichever Hermes the harness boots; nothing is faked).

Hermes's `redact_sensitive_text` is superlinear on a few kilobytes of the right shape and holds the GIL while it runs (upstream: issues/147242 for the private-key `BEGIN`
run; issues/147257 for the four assignment forms, v0.22.5: DOTTED cubic; ANCHORED, YAML and the shell-variable reference quadratic). The defence is not a model of the cost
but a DEADLINE on a child process that can be killed. This is the standing guard of it, on the eight slow shapes at 4 KiB, 64 KiB and 1 MiB, in both modes:
each returns within its deadline plus a margin; a key planted in the first line is never in what comes back; the call after a kill works; benign texts of 100,000
characters, 256 KiB and 1 MiB come back REDACTED and not as the placeholder (a defence that answers the placeholder to everything is an outage); one request cannot spend
more than its budget; one hostile caller does not turn the other requests' texts into the placeholder; and there is one child, and none left behind.
Measured when this was written (a laptop at a load of 6 to 7 on 8 cores): the child starts in 0.08 s and holds 24 MiB idle and 54 MiB after one 1 MiB text; a deadline is
overrun by up to 0.5 s (the kill and the wait for the next child); a benign 256 KiB text with an assignment on every line took 0.17 s quiet and up to 0.66 s against a deadline of 0.64 s
while other programs used the machine (Telegram at 100% of a core, another agent's tests): a margin of 2x on the median was too strict there, 0.8 of the deadline is what is held."""
import os
import statistics
import subprocess
import threading
import time

import pytest

from support import plugin

plugin()                                                                                      # puts luvebot_backend on the path
from luvebot_backend import redaction  # noqa: E402

CANARY = 'sk-' + 'p3guardA1b2C3d4E5f6G7h8I9j0'
KEY_LINE = f'OPENAI_API_KEY={CANARY}\n'
SHAPES = {                                  # name: (prefix, the repeated run, suffix); the EIGHT slow shapes: the run of the issue, the five assignment forms, the YAML one and the variable one
    'pem': ('', '-----BEGIN PRIVATE KEY-----\n', ''),
    'dotted': ('', 'a.token', ' k=v'),
    'token-dot': ('', 'token.', ' k=v'),
    'anchored': ('', 'token', ' k=v'),
    'anchored-under': ('', 'token_a', ' k=v'),
    'anchored-dash': ('', 'a-token', ' k=v'),
    'yaml': ('', 'token', ' k:v'),
    'path': ('API_KEY=${A', 'a', ''),
}
SIZES = {'4KiB': 4 * 1024, '64KiB': 64 * 1024, '1MiB': 1024 * 1024}
MODES = ('default', 'file')
MARGIN = 1.0                          # seconds past the deadline: the kill, and the wait for the next child (the measured worst was 0.5 s on a loaded machine)
HEARTBEAT = 0.25                      # the longest the OTHER thread of this process may stand still while the redactor works


BASE_S, PER_BYTE_S, MAX_S = 0.25, 1.5e-6, 2.5            # THE CONTRACT's deadline, written here and not read from the module: a mutation of the module's number must not move the ruler


def deadline(size):
    return min(MAX_S, BASE_S + PER_BYTE_S * size)


@pytest.fixture(autouse=True, scope='module')
def real_child():
    redaction.set_worker_factory(None)
    yield
    redaction.set_worker_factory(None)


class Beat:
    """A thread that sleeps 2 ms and records how long each sleep really took: a call that holds the GIL shows up as one long gap."""
    def __enter__(self):
        self.gaps, self._stop = [], threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        time.sleep(0.05)
        self.gaps.clear()
        return self

    def _run(self):
        last = time.perf_counter()
        while not self._stop.is_set():
            time.sleep(0.002)
            now = time.perf_counter()
            self.gaps.append(now - last)
            last = now

    def __exit__(self, *exc):
        self._stop.set()
        self._thread.join()

    @property
    def worst(self):
        return max(self.gaps or [0])


def hostile(shape, size):
    prefix, run, suffix = SHAPES[shape]
    return KEY_LINE + prefix + (run * (size // len(run) + 1))[:size] + suffix


def benign(size, assignments=False):
    line = 'line {} = value of the setting number {} and some more words\n' if assignments else 'line {}: the quick brown fox jumps over the lazy dog, and the dog does not mind\n'
    body, n = [], 0
    while sum(map(len, body)) < size:
        body.append(line.format(n, n) if assignments else line.format(n))
        n += 1
    body.insert(len(body) // 2, KEY_LINE)
    return ''.join(body)


@pytest.mark.parametrize('mode', MODES)
@pytest.mark.parametrize('size', SIZES.values(), ids=SIZES.keys())
@pytest.mark.parametrize('shape', SHAPES)
def test_a_hostile_text_returns_in_time_and_never_raw(shape, size, mode):
    text = hostile(shape, size)
    with Beat() as beat:
        started = time.perf_counter()
        out = redaction.isolated_redact(text, mode)
        took = time.perf_counter() - started
    assert took <= deadline(len(text.encode())) + MARGIN, f'{shape} {len(text)} B in {mode}: {took:.2f} s (deadline {deadline(len(text.encode())):.2f} s)'
    assert beat.worst <= HEARTBEAT, f'the other thread stood still for {beat.worst:.2f} s: the call held the GIL of the panel'
    assert isinstance(out, str) and CANARY not in out, 'the key planted in the first line came back raw'
    assert out == redaction.PLACEHOLDER or out != text, 'the text came back unchanged, key and all'


def test_the_call_after_a_kill_works():
    assert redaction.isolated_redact(hostile('dotted', 4 * 1024), 'default') == redaction.PLACEHOLDER      # 7 s of work upstream: the deadline kills the child
    after = redaction.isolated_redact(f'OPENAI_API_KEY={CANARY} ' + 'x' * 400, 'default')              # over 256 bytes: it goes to the next child
    assert after != redaction.PLACEHOLDER and CANARY not in after and 'OPENAI_API_KEY' in after


@pytest.mark.parametrize('mode', MODES)
@pytest.mark.parametrize('size', (100000, 256 * 1024, 1024 * 1024), ids=('100KB', '256KiB', '1MiB'))
def test_a_benign_long_text_comes_back_redacted_not_as_the_placeholder(size, mode):
    text, times = benign(size), []
    for _ in range(3):
        started = time.perf_counter()
        out = redaction.isolated_redact(text, mode)
        times.append(time.perf_counter() - started)
        assert out != redaction.PLACEHOLDER, f'a benign text of {len(text)} B was answered with the placeholder after {times[-1]:.2f} s'
        assert CANARY not in out and 'quick brown fox' in out
    assert statistics.median(times) <= deadline(len(text.encode())) * 0.8, f'the deadline is too close to the cost: median {statistics.median(times):.2f} s, deadline {deadline(len(text.encode())):.2f} s'


def test_a_note_with_an_assignment_on_every_line_is_redacted_most_of_the_time():
    """The worst benign shape for the cost (measured 0.23 to 0.66 s for 256 KiB against a deadline of 0.64 s on a loaded laptop): most runs must finish."""
    text = benign(256 * 1024, assignments=True)
    answers = [redaction.isolated_redact(text, 'file') for _ in range(5)]
    assert sum(a != redaction.PLACEHOLDER for a in answers) >= 4, 'the deadline is too close to the cost of a benign note'
    assert all(CANARY not in a for a in answers)


def test_the_budget_of_one_request_bounds_the_sum_of_hostile_texts():
    started = time.perf_counter()
    with redaction.request_budget(3.0):
        answers = [redaction.isolated_redact(hostile('token-dot', 4 * 1024), 'default') for _ in range(20)]
    took = time.perf_counter() - started
    assert took <= 3.0 + MARGIN, f'20 hostile texts in one request took {took:.2f} s'
    assert answers.count(redaction.PLACEHOLDER) == 20 and all(CANARY not in a for a in answers)


def test_a_spent_budget_makes_even_a_short_text_the_placeholder():
    """A request that has spent its redactor time gets the placeholder for EVERY further text, the short ones included, at once (the long ones are already refused for want
    of time: this is the part that only the early return of `isolated_redact` holds). A new request starts with a new budget."""
    with redaction.request_budget(0.2):
        assert redaction.isolated_redact(hostile('dotted', 4 * 1024), 'default') == redaction.PLACEHOLDER      # the deadline is the 0.2 s that were left: the budget is spent
        assert redaction.isolated_redact('OPENAI_API_KEY=' + CANARY, 'default') == redaction.PLACEHOLDER        # a text of 50 bytes, which would have run in this process
    again = redaction.isolated_redact('OPENAI_API_KEY=' + CANARY, 'default')
    assert again != redaction.PLACEHOLDER and CANARY not in again


def test_one_hostile_caller_does_not_turn_the_other_requests_into_the_placeholder():
    """The child is ONE and its lock is ONE, and the frames of a stream come after the handler returned, with no budget: one caller that sends hostile texts one after
    another must slow the others (measured: 2 ms to 0.3 s a call) and must not make them the placeholder."""
    stop, seen = threading.Event(), []

    def attacker():
        while not stop.is_set():
            redaction.isolated_redact(hostile('dotted', 4 * 1024), 'default')
    thread = threading.Thread(target=attacker, daemon=True)
    thread.start()
    end = time.time() + 6
    while time.time() < end:
        with redaction.request_budget():
            started = time.perf_counter()
            out = redaction.isolated_redact(benign(2048), 'default')
            seen.append((time.perf_counter() - started, out == redaction.PLACEHOLDER or CANARY in out))
        time.sleep(0.1)
    stop.set()
    thread.join(10)
    assert len(seen) >= 8 and not any(bad for _, bad in seen), [round(t, 2) for t, bad in seen if bad]
    assert max(t for t, _ in seen) <= 1.5, f'a request waited {max(t for t, _ in seen):.2f} s for the child'


def children():
    pids = subprocess.run(['pgrep', '-P', str(os.getpid())], capture_output=True, text=True).stdout.split()
    return [pid for pid in pids if '--child' in subprocess.run(['ps', '-o', 'command=', '-p', pid], capture_output=True, text=True).stdout]


def test_there_is_one_child_and_none_is_left_behind():
    redaction.isolated_redact(benign(2048), 'default')
    for _ in range(5):
        redaction.isolated_redact(hostile('dotted', 4 * 1024), 'default')
    time.sleep(0.8)
    assert len(children()) <= 1, children()
    redaction.set_worker_factory(None)                                                            # drops the worker in use
    time.sleep(0.5)
    assert children() == [], children()
