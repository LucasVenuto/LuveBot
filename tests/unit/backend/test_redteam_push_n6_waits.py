"""Red team (Lume, 31/10) of N-3 (428a67e: the `question` kind from the hook's waits, contract v0.11 7.6): `_notify_new_waits` in dashboard/plugin_api.py and the dedupe memory of
backend/push.py. It reuses the Brasa's rig (FakeWaiting, wait_item, the `exec` of the extracted tick) so the same code is attacked, not a copy.

HELD (plain tests; the mutations below turn each red): nothing of the wait (its text, its request id, the key) is in the events, the audit, the log of deliveries, `latest`, `status` or the
headers, for every kind of item the reader derives (a clarify with a secret, a kind that is not one of the three, the longest request id the reader accepts); one wait announced by eight
threads at once is ONE event and ONE wake (the unique index decides, not the look before it).

FIXED IN N-3b (the tests that were `xfail(strict=True)` are plain tests now, and each has a mutation below):
  F-N6-7 (Media): the tick KEEPS the `waiting.marker` of a Bot BEFORE it has announced the waits it read, and a tick reads a Bot only when its marker moved, so one transient failure while
          announcing (the `Push` constructor that opens luvebot.db and meets `database is locked` after its 5 s, or the audit row of `notifications.push` that cannot be written: `notify`
          swallows it and returns None, and nothing looks at the answer) loses that wait for good: the marker is the same on every later tick, nothing is read, and ten minutes later the wait is
          too old to be announced. The person who must answer a question is never told outside the browser, which is the whole point of the kind. The pauses have no such memory (they are
          retried every tick, and the key makes that safe). Reference fix: keep the marker only when every wait read is either too old or already in the memory of what was said.
  F-N6-8 (Baixa): "once per wait" lives in `push_events.dedupe`, and `notify` keeps only the last 50 rows of that table whatever their kind: an approval (no key) is a row, so is every pause and
          every wait. After 50 other events the key of a wait that is STILL within its 10 minutes is gone, and the next marker move (any new wait of that Bot) announces it again: the same
          question wakes the same phones twice. The same for a pause key (`pause:<bot>:<since>`, retried every tick for 10 minutes). 49 other events: still said once; the 50th: said again.
          Reference fix: the cap keeps every keyed row younger than an hour, besides the last 50.
  F-N6-9 (Info, observation only, no test): `notify` says "a second caller with the same key records nothing, writes no audit row and wakes nobody", and that holds only when the look before it
          (`_notified`) sees the key; two callers that both look before either inserts both write the intent and the result of `notifications.push` (the loser's effect returns nothing): eight
          threads, one event, one wake, EIGHT audit intents (measured). Claiming the key before the intent would break "no audit row, no effect", so the honest fix may be the sentence.
NOT CLAIMED, in the report: a tick announces every new wait of a Bot (up to the reader's 50) with one thread and one wake per wait per device, so a Bot with many live waits makes a burst against
the one VAPID identity every person shares (the push is empty and the Topic coalesces only what a device has not received yet): one wake per Bot per tick would say the same; `latest` shows the 5
newest events, so a run of `question` events can bury an `approval` one from the lock screen's list."""
import json
import logging
import re
import sqlite3
import sys
import threading
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_push', reason='the Brasa rig of N-1 and N-3')

real = tp.real
FCM, MOZ = tp.FCM, tp.MOZ


class Rig:
    """The tick of `_notify_new_waits`, exec'd from plugin_api.py with fakes; `flaky` makes ONE announcement fail once, the way a locked database would."""
    def __init__(self, tmp, flaky=None, source=None, module=None, status=201):
        m = module or real
        self.m, self.path, self.now, self.flaky = m, tmp / 'luvebot.db', [1_000_000.0], flaky
        self.sender = tp.Sender(status)
        self.audit_real = tp.sibling(m, 'audit').AuditLog(self.path)
        self.box = m.Push(self.path, subject='https://luve.app', source='public_url', sender=self.sender, clock=lambda: self.now[0])
        tp.sub(m, self.audit_real, self.box, FCM, kinds=['question'])
        self.fake, self.joined, self.counts = tp.FakeWaiting(), [], {'push': 0, 'act': 0}
        rig = self

        class Audit:
            def act(self, actor, action, *a, **k):
                if action == 'notifications.push':
                    rig.counts['act'] += 1
                    if rig.flaky == 'audit' and rig.counts['act'] == 2:
                        raise sqlite3.OperationalError('database is locked')
                return rig.audit_real.act(actor, action, *a, **k)

        class Pusher:
            def __getattr__(self, name):                                      # whatever the tick asks of the box (notify, a look at what was said): the real one answers
                return getattr(rig.box, name)

            def notify(self, audit, kind, bot, key=None):
                thread = rig.box.notify(audit, kind, bot, key)
                rig.joined.append(thread)
                return thread

        def push_factory(_path):
            rig.counts['push'] += 1
            if rig.flaky == 'push' and rig.counts['push'] == 2:
                raise sqlite3.OperationalError('database is locked')
            return Pusher()
        self.audit = Audit()
        ns = {'waiting': self.fake, '_REDACT': lambda t: t, '_push': push_factory, 'time': types.SimpleNamespace(time=lambda: self.now[0]), 'logging': logging}
        exec((source or tp.WAIT_SOURCE_RE.search(tp.API_SOURCE).group(0)), ns)
        self.tick = ns['_notify_new_waits']
        self.markers = ns['_WAIT_MARKERS']

    def run(self, *bots):
        self.tick(self.audit, self.path, list(bots or ['vendas']))
        for thread in [t for t in self.joined if t]:
            thread.join(5)
        self.joined.clear()

    def said(self):
        return sorted(r[0] for r in tp.rows_of(self.path, 'SELECT dedupe FROM push_events WHERE dedupe IS NOT NULL'))


# ---------------------------------------------------------------- held: nothing of the wait leaves the database --------------------------------------------
SECRET_PROMPT = 'Qual a senha do banco? hunter2-da-cliente-9941'
LONG_ID = 'a' + 'b' * 60 + ':' + 'c.d_e-' * 10 + 'z' * 5


def check_nothing_of_the_wait_is_shown(m, tmp, source=None):
    rig = Rig(tmp, module=m, source=source, status=lambda url: m._status(403, 'bad_jwt'))      # refused wakes, so the log and the delivery rows exist to be read
    rig.fake.markers['vendas'] = 'm1'
    rig.fake.items['vendas'] = [dict(tp.wait_item('req_secretid_77', 5), prompt=SECRET_PROMPT), dict(tp.wait_item(LONG_ID, 6, kind='sudo'), prompt=None),
                                dict(tp.wait_item('req_other_kind', 7, kind='other'), prompt=SECRET_PROMPT)]
    with tp.Lines() as lines:
        rig.run()
    assert len(rig.said()) == 3, rig.said()                                                   # the case is only worth something if the three were announced
    for _url, headers in rig.sender.sent:                                                      # the wake itself (its URL and token are the sender's business) never carries the text
        assert 'hunter2' not in json.dumps(headers) and 'senha' not in json.dumps(headers)
    shown = json.dumps([lines, rig.box.latest('basic:ana'), rig.box.status(), rig.box.mine('basic:ana'), tp.rows_of(rig.path, 'SELECT * FROM audit_log'),
                        tp.rows_of(rig.path, 'SELECT * FROM push_log'), tp.rows_of(rig.path, 'SELECT kind, bot, created_at FROM push_events')], default=str)
    for secret in ('hunter2', 'senha', 'req_secretid_77', 'req_other_kind', LONG_ID[:20], 'wait:', 'dEvIcE', 'APA91b', '/fcm/send', 'vapid'):
        assert secret not in shown, secret
    assert re.search(r'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}', shown) is None      # a JWT (the three letters alone are base64 of `{"` and turn up by chance)
    for key in rig.said():                                                                     # the key (the only place the request id lives) never holds the agent's text
        assert 'hunter2' not in key and 'senha' not in key, key


def test_nothing_of_the_wait_is_shown_on_the_real_module(tmp_path):
    check_nothing_of_the_wait_is_shown(real, tmp_path)


def check_one_wait_announced_by_eight_threads_is_one_event_and_one_wake(m, tmp):
    rig = Rig(tmp, module=m)
    bar, errors = threading.Barrier(8), []

    def go():
        bar.wait()
        try:
            thread = rig.box.notify(rig.audit_real, 'question', 'vendas', 'wait:vendas:req_race')
            if thread:
                thread.join(5)
        except Exception as error:  # noqa: BLE001
            errors.append(error)
    threads = [threading.Thread(target=go) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert errors == [] and rig.said() == ['wait:vendas:req_race']
    assert len(rig.sender.sent) == 1, len(rig.sender.sent)                                    # one wake for the one device, however many watchers said it at once


def test_one_wait_announced_by_eight_threads_on_the_real_module(tmp_path):
    check_one_wait_announced_by_eight_threads_is_one_event_and_one_wake(real, tmp_path)


def check_a_failed_announcement_is_read_again(m, tmp, source=None):
    for flaky in ('push', 'audit'):
        folder = tmp / flaky
        folder.mkdir()
        rig = Rig(folder, flaky=flaky, source=source, module=m)
        rig.fake.markers['vendas'] = 'm1'
        rig.fake.items['vendas'] = [tp.wait_item('req_a', 30), tp.wait_item('req_b', 20)]
        with tp.Lines():
            rig.run()
            rig.run()
            rig.run()
        assert rig.said() == ['wait:vendas:req_a', 'wait:vendas:req_b'], (flaky, rig.said())
        assert len(rig.fake.reads) >= 2, (flaky, rig.fake.reads)                                  # the marker was NOT kept: it read again
    folder = tmp / 'quiet'
    folder.mkdir()
    rig = Rig(folder, source=source, module=m)                                                    # no failure: ONE read, the marker is kept, and a wait that is too old counts as told
    rig.fake.markers['vendas'] = 'm1'
    rig.fake.items['vendas'] = [tp.wait_item('req_a', 30), tp.wait_item('req_old', 601)]
    rig.run()
    rig.run()
    assert rig.said() == ['wait:vendas:req_a'] and len(rig.fake.reads) == 1, (rig.said(), rig.fake.reads)


def check_the_key_of_a_live_event_survives_fifty_others(m, tmp, source=None):
    folder = tmp / 'wait'
    folder.mkdir()
    rig = Rig(folder, source=source, module=m)
    rig.fake.markers['vendas'] = 'm1'
    rig.fake.items['vendas'] = [tp.wait_item('req_a', 30)]
    rig.run()
    for _ in range(60):
        thread = rig.box.notify(rig.audit_real, 'approval', 'caixa')
        thread and thread.join(5)
    rig.sender.sent.clear()
    rig.fake.markers['vendas'], rig.fake.items['vendas'] = 'm2', [tp.wait_item('req_a', 30), tp.wait_item('req_new', 2)]
    rig.run()
    assert len(rig.sender.sent) == 1 and 'wait:vendas:req_a' in rig.said(), len(rig.sender.sent)       # ONE wake, for the new one
    folder = tmp / 'pause'
    folder.mkdir()
    rig = Rig(folder, module=m)
    tp.sub(m, rig.audit_real, rig.box, MOZ, kinds=['budget', 'approval'])
    for kind, bot, key in [('budget', 'vendas', 'pause:vendas:1000000.0')] + [('approval', 'caixa', None)] * 60 + [('budget', 'vendas', 'pause:vendas:1000000.0')]:
        thread = rig.box.notify(rig.audit_real, kind, bot, key)
        thread and thread.join(5)
    assert [h['Topic'] for _u, h in rig.sender.sent].count('budget') == 1                               # said once, then 60 others, then the same key: still once


def check_the_keys_are_kept_for_an_hour_and_five_hundred(m, tmp, source=None):
    now = [2_000_000.0]
    path = tmp / 'luvebot.db'
    audit = tp.sibling(m, 'audit').AuditLog(path)
    box = m.Push(path, subject='https://luve.app', source='public_url', sender=tp.Sender(), clock=lambda: now[0])
    tp.sub(m, audit, box, FCM)
    import sqlite3
    conn = sqlite3.connect(path)
    for i in range(600):                                                                              # 600 live keys (the age of each is one second apart)
        conn.execute('INSERT INTO push_events (kind, bot, created_at, dedupe) VALUES (?,?,?,?)', ('budget', 'vendas', now[0] - 600 + i * 0.5, f'pause:vendas:{i}'))
    conn.execute("INSERT INTO push_events (kind, bot, created_at, dedupe) VALUES ('budget', 'vendas', ?, 'pause:vendas:old')", (now[0] - 4000,))     # a key of more than an hour
    conn.commit()
    conn.close()
    thread = box.notify(audit, 'approval', 'caixa')
    thread and thread.join(5)
    keys = [r[0] for r in tp.rows_of(path, 'SELECT dedupe FROM push_events WHERE dedupe IS NOT NULL')]
    assert len(keys) == 500 and 'pause:vendas:599' in keys and 'pause:vendas:100' in keys and 'pause:vendas:99' not in keys and 'pause:vendas:old' not in keys, (len(keys), 'pause:vendas:old' in keys)
    assert len(tp.rows_of(path, 'SELECT id FROM push_events WHERE dedupe IS NULL')) == 1                 # the 50 latest still hold the plain event


CHECKS = {'shown': check_nothing_of_the_wait_is_shown, 'race': check_one_wait_announced_by_eight_threads_is_one_event_and_one_wake, 'again': check_a_failed_announcement_is_read_again,
          'survive': check_the_key_of_a_live_event_survives_fifty_others, 'kept': check_the_keys_are_kept_for_an_hour_and_five_hundred}
MUTANTS = [   # (check, label, old, new, where): `push` changes backend/push.py, `tick` changes the extracted `_notify_new_waits`
    ('shown', 'the log line of a failed wake carries the endpoint', "logging.getLogger('luvebot.push').warning('push refused by %s: status %s, reason %s', host, status, reason)",
     "logging.getLogger('luvebot.push').warning('push refused by %s: status %s, reason %s %s', host, status, reason, target['endpoint'])", 'push'),
    ('shown', 'the audit target is the key', "targets = audit.act('system', 'notifications.push', bot, {'kind': 'system'}, effect, bot=bot, payload={'kind': kind})",
     "targets = audit.act('system', 'notifications.push', key or bot, {'kind': 'system'}, effect, bot=bot, payload={'kind': kind})", 'push'),
    ('shown', 'the clarify text is in the key', "wait:{bot}:{item['request_id']}", "wait:{bot}:{item['request_id']}:{item['prompt']}", 'tick'),
    ('shown', 'the clarify text is the Bot of the event', ".notify(audit, 'question', bot, ", ".notify(audit, 'question', item['prompt'] or bot, ", 'tick'),
    ('race', 'a lost INSERT OR IGNORE still wakes', "VALUES (?,?,?,?)', (kind, bot, self.clock(), key)).rowcount == 0:", "VALUES (?,?,?,?)', (kind, bot, self.clock(), key)).rowcount == -1:", 'push'),
    ('again', 'the marker is kept before the waits are told', "            settled = True\n", "            settled = True\n            _WAIT_MARKERS[(str(path), bot)] = marker\n", 'tick'),
    ('again', 'a failure of one wait counts as told', "                    said = False\n", "                    said = True\n", 'tick'),
    ('again', 'the marker is kept whatever happened', "            if settled:", "            if True:", 'tick'),
    ('again', 'a wait is told because notify was called', "                    said = box._notified(key)", "                    said = True", 'tick'),
    ('again', 'a wait that is too old holds the marker back', "                if time.time() - item['since'] > _WAIT_WINDOW_S:\n                    continue\n", "                if time.time() - item['since'] > _WAIT_WINDOW_S:\n                    settled = False\n                    continue\n", 'tick'),
    ('survive', 'the plain 50 are all the memory there is', "'AND id NOT IN (SELECT id FROM push_events WHERE dedupe IS NOT NULL AND created_at >= ? ORDER BY id DESC LIMIT ?)',", "'AND id NOT IN (SELECT id FROM push_events WHERE 1=0 AND created_at >= ? ORDER BY id DESC LIMIT ?)',", 'push'),
    ('kept', 'only the key of the last second is kept', "(self.clock() - KEYED_SECONDS, KEYED_KEEP))", "(self.clock() - 1, KEYED_KEEP))", 'push'),
    ('kept', 'a key of any age is kept', "(self.clock() - KEYED_SECONDS, KEYED_KEEP))", "(self.clock() - 10 ** 9, KEYED_KEEP))", 'push'),
    ('kept', 'every key is kept', "(self.clock() - KEYED_SECONDS, KEYED_KEEP))", "(self.clock() - KEYED_SECONDS, 10 ** 6))", 'push'),
    ('kept', 'the oldest keys are the ones kept', "WHERE dedupe IS NOT NULL AND created_at >= ? ORDER BY id DESC LIMIT ?)", "WHERE dedupe IS NOT NULL AND created_at >= ? ORDER BY id ASC LIMIT ?)", 'push'),
    ('kept', 'the cap is fifty', "KEYED_KEEP = 500 ", "KEYED_KEEP = 50 ", 'push'),
]


def test_every_check_has_a_mutant():
    assert set(CHECKS) == {name for name, *_ in MUTANTS}


@pytest.mark.parametrize('name,label,old,new,where', MUTANTS, ids=[f'{n}|{l}' for n, l, *_ in MUTANTS])
def test_each_mutant_turns_its_check_red(tmp_path_factory, tmp_path, name, label, old, new, where):
    if where == 'push':
        with pytest.raises(AssertionError):
            CHECKS[name](tp.load_variant(tmp_path_factory, old, new), tmp_path)
    else:
        source = tp.WAIT_SOURCE_RE.search(tp.API_SOURCE).group(0)
        assert source.count(old) == 1, old
        with pytest.raises(AssertionError):
            CHECKS[name](real, tmp_path, source.replace(old, new))


# ---------------------------------------------------------------- open: F-N6-7 a transient failure loses the wait for good --------------------------------
@pytest.mark.parametrize('flaky', ['push', 'audit'])
def test_a_wait_whose_announcement_failed_once_is_announced_on_a_later_tick(tmp_path, flaky):
    rig = Rig(tmp_path, flaky=flaky)
    rig.fake.markers['vendas'] = 'm1'
    rig.fake.items['vendas'] = [tp.wait_item('req_a', 30), tp.wait_item('req_b', 20)]
    with tp.Lines():
        rig.run()
        assert 'wait:vendas:req_a' in rig.said()                                              # the first was told; the second met the locked database
        rig.run()                                                                             # the hook wrote nothing new: the same marker
        rig.run()
    assert rig.said() == ['wait:vendas:req_a', 'wait:vendas:req_b'], rig.said()               # a person must not lose the question because a lock lasted five seconds


def test_the_control_without_a_failure_announces_both(tmp_path):
    rig = Rig(tmp_path)
    rig.fake.markers['vendas'] = 'm1'
    rig.fake.items['vendas'] = [tp.wait_item('req_a', 30), tp.wait_item('req_b', 20)]
    rig.run()
    assert rig.said() == ['wait:vendas:req_a', 'wait:vendas:req_b'] and len(rig.fake.reads) == 1


# ---------------------------------------------------------------- open: F-N6-8 "once" does not survive 50 other events -------------------------------------
def test_a_wait_still_within_its_ten_minutes_is_not_said_again_after_fifty_other_events(tmp_path):
    rig = Rig(tmp_path)
    rig.fake.markers['vendas'] = 'm1'
    rig.fake.items['vendas'] = [tp.wait_item('req_a', 30)]
    rig.run()
    assert len(rig.sender.sent) == 1
    for _ in range(60):                                                                       # approvals have no key: each is a row; 50 of them push the key out of the last 50
        thread = rig.box.notify(rig.audit_real, 'approval', 'caixa')
        thread and thread.join(5)
    rig.sender.sent.clear()
    rig.fake.markers['vendas'], rig.fake.items['vendas'] = 'm2', [tp.wait_item('req_a', 30), tp.wait_item('req_new', 2)]       # another wait of the Bot: the list is read again
    rig.run()
    assert [h['Topic'] for _u, h in rig.sender.sent] == ['question'] and 'wait:vendas:req_a' in rig.said()
    assert len(rig.sender.sent) == 1, len(rig.sender.sent)                                    # ONE wake, for the new one: req_a was said already


def test_a_pause_key_is_not_said_again_after_fifty_other_events(tmp_path):
    rig = Rig(tmp_path)
    tp.sub(real, rig.audit_real, rig.box, MOZ, kinds=['budget', 'approval'])                    # the device that hears pauses (the rig's own asks for `question` only)
    for kind, bot, key in [('budget', 'vendas', 'pause:vendas:1000000.0')] + [('approval', 'caixa', None)] * 60 + [('budget', 'vendas', 'pause:vendas:1000000.0')]:
        thread = rig.box.notify(rig.audit_real, kind, bot, key)
        thread and thread.join(5)
    assert [h['Topic'] for _u, h in rig.sender.sent].count('budget') == 1, [h['Topic'] for _u, h in rig.sender.sent].count('budget')        # said once, then 60 others, then the same key: still once

