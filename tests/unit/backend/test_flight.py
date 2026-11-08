"""Perf item 4: GET /bots shares one computation among the tabs that ask at the same time (backend/flight.py).

Perf item 5 adds `Memo` (a Flight that remembers the answer a few seconds, for the Today screen's second /activity call): used only while the epoch is
the one it was asked under and it is younger than its time-to-live; a failure is not remembered.

Pinned: callers that arrive while a read runs get ITS result and it runs once; a change in between (a new epoch) starts its own, so nobody gets an
answer computed before a change they made; a finished read is gone (no time-to-live: the next call recomputes); a failure reaches every waiter and
is forgotten; a caller that goes away does not cancel the read for the others. Mutations of flight.py are red."""
import asyncio
import importlib.util
from pathlib import Path

import pytest

import backend.flight as flight_module

SOURCE = Path(flight_module.__file__)
Flight = flight_module.Flight


def run(coro):
    return asyncio.run(coro)


class Slow:
    """A read that takes a moment and says how many times it ran."""

    def __init__(self):
        self.calls, self.release = 0, None

    async def make(self):
        self.calls += 1
        n = self.calls
        await self.release.wait()
        return {"read": n}


def test_callers_that_arrive_while_a_read_runs_share_it():
    async def main():
        slow, flight = Slow(), Flight()
        slow.release = asyncio.Event()
        tasks = [asyncio.ensure_future(flight.run("bots", 0, slow.make)) for _ in range(5)]
        await asyncio.sleep(0.01)
        slow.release.set()
        results = await asyncio.gather(*tasks)
        assert slow.calls == 1 and results == [{"read": 1}] * 5
    run(main())


def test_a_change_in_between_starts_its_own_read():
    async def main():
        slow, flight = Slow(), Flight()
        slow.release = asyncio.Event()
        before = asyncio.ensure_future(flight.run("bots", 0, slow.make))
        await asyncio.sleep(0.01)
        after = asyncio.ensure_future(flight.run("bots", 1, slow.make))                 # the dashboard bumped the epoch: a pause, a resume
        await asyncio.sleep(0.01)
        slow.release.set()
        assert await before == {"read": 1} and await after == {"read": 2} and slow.calls == 2
    run(main())


def test_a_finished_read_is_gone_so_the_next_call_reads_again_and_other_keys_do_not_share():
    async def main():
        slow, flight = Slow(), Flight()
        slow.release = asyncio.Event()
        slow.release.set()
        assert await flight.run("bots", 0, slow.make) == {"read": 1}
        assert await flight.run("bots", 0, slow.make) == {"read": 2}                     # no time-to-live: nothing here is ever stale
        assert flight._busy == {}
        slow.release = asyncio.Event()
        a = asyncio.ensure_future(flight.run("a", 0, slow.make))
        b = asyncio.ensure_future(flight.run("b", 0, slow.make))
        await asyncio.sleep(0.01)
        slow.release.set()
        assert {(await a)["read"], (await b)["read"]} == {3, 4}
    run(main())


def test_a_failure_reaches_every_waiter_and_is_forgotten():
    async def main():
        flight, started = Flight(), asyncio.Event()

        async def broken():
            await started.wait()
            raise RuntimeError("boom")
        tasks = [asyncio.ensure_future(flight.run("bots", 0, broken)) for _ in range(3)]
        await asyncio.sleep(0.01)
        started.set()
        results = await asyncio.gather(*tasks, return_exceptions=True)
        assert all(isinstance(r, RuntimeError) for r in results)
        await asyncio.sleep(0)
        assert flight._busy == {}
        ok = Slow()
        ok.release = asyncio.Event()
        ok.release.set()
        assert await flight.run("bots", 0, ok.make) == {"read": 1}                       # and the next call is a fresh read
    run(main())


def test_a_caller_that_goes_away_does_not_cancel_the_read_for_the_others():
    async def main():
        slow, flight = Slow(), Flight()
        slow.release = asyncio.Event()
        leader = asyncio.ensure_future(flight.run("bots", 0, slow.make))
        follower = asyncio.ensure_future(flight.run("bots", 0, slow.make))
        await asyncio.sleep(0.01)
        leader.cancel()                                                                  # a closed tab
        await asyncio.sleep(0.01)
        slow.release.set()
        assert await follower == {"read": 1} and slow.calls == 1
        with pytest.raises(asyncio.CancelledError):
            await leader
    run(main())


# ---- Memo --------------------------------------------------------------------------------------------------------------------------
Memo = flight_module.Memo


class Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


class Counter:
    def __init__(self):
        self.calls = 0

    async def make(self):
        self.calls += 1
        return {"read": self.calls}


def test_a_memo_answers_from_memory_within_its_time_and_epoch_and_reads_again_after():
    async def main():
        clock, count = Clock(), Counter()
        memo = Memo(3.0, clock)
        assert await memo.get("a", 0, count.make) == {"read": 1}
        clock.now += 2.9
        assert await memo.get("a", 0, count.make) == {"read": 1} and count.calls == 1             # kept
        clock.now += 0.2
        assert await memo.get("a", 0, count.make) == {"read": 2}                                    # older than its ttl
        assert await memo.get("a", 1, count.make) == {"read": 3}                                    # something changed (a new epoch)
        assert await memo.get("b", 1, count.make) == {"read": 4}                                    # another key
    run(main())


def test_a_memo_does_not_keep_a_failure_and_shares_a_read_in_flight():
    async def main():
        clock = Clock()
        memo, calls = Memo(3.0, clock), []

        async def flaky():
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("down")
            return "up"
        with pytest.raises(RuntimeError):
            await memo.get("a", 0, flaky)
        assert await memo.get("a", 0, flaky) == "up"                                                # not remembered: asked again at once
        slow, gate = Counter(), asyncio.Event()

        async def gated():
            await gate.wait()
            return await slow.make()
        first = asyncio.ensure_future(memo.get("g", 0, gated))
        second = asyncio.ensure_future(memo.get("g", 0, gated))
        await asyncio.sleep(0.01)
        gate.set()
        assert await first == await second == {"read": 1} and slow.calls == 1
    run(main())


def test_a_memo_stays_small():
    async def main():
        clock, count = Clock(), Counter()
        memo = Memo(3.0, clock)
        for i in range(200):
            clock.now += 10                                                                          # every entry is older than its ttl by the next one
            await memo.get(f"k{i}", 0, count.make)
        assert len(memo._kept) <= 65
    run(main())


# ---- mutations --------------------------------------------------------------------------------------------------------------------
def load(edits):
    source = SOURCE.read_text()
    for old, new in edits:
        assert source.count(old) == 1, old
        source = source.replace(old, new)
    spec = importlib.util.spec_from_loader("backend.flight_under_test", loader=None)
    module = importlib.util.module_from_spec(spec)
    exec(compile(source, str(SOURCE), "exec"), module.__dict__)
    return module


MUTATIONS = {
    "a change is ignored": ([("if hit is None or hit[0] != epoch:", "if hit is None:")], test_a_change_in_between_starts_its_own_read),
    "a finished read is kept": ([("        if self._busy.get(key, (None, None))[1] is task:\n            del self._busy[key]\n", "")],
                                test_a_finished_read_is_gone_so_the_next_call_reads_again_and_other_keys_do_not_share),
    "nobody is shielded": ([("        return await asyncio.shield(hit[1])", "        return await hit[1]")], test_a_caller_that_goes_away_does_not_cancel_the_read_for_the_others),
    "every call reads": ([("        if hit is None or hit[0] != epoch:", "        if True:")], test_callers_that_arrive_while_a_read_runs_share_it),
    "a memo ignores the epoch": ([("        if kept is not None and kept[0] == epoch and self._clock() - kept[1] < self._ttl:", "        if kept is not None and self._clock() - kept[1] < self._ttl:")],
                                 test_a_memo_answers_from_memory_within_its_time_and_epoch_and_reads_again_after, "Memo"),
    "a memo ignores its time-to-live": ([("        if kept is not None and kept[0] == epoch and self._clock() - kept[1] < self._ttl:", "        if kept is not None and kept[0] == epoch:")],
                                         test_a_memo_answers_from_memory_within_its_time_and_epoch_and_reads_again_after, "Memo"),
    "a memo never prunes": ([("        if len(self._kept) > 64:                # a few Bots and a few shapes: this only keeps the dict small\n", "        if False:\n")],
                            test_a_memo_stays_small, "Memo"),
    "the key is ignored": ([("        hit = self._busy.get(key)", "        hit = next(iter(self._busy.values()), None)")],
                           test_a_finished_read_is_gone_so_the_next_call_reads_again_and_other_keys_do_not_share),
}


@pytest.mark.parametrize("label", sorted(MUTATIONS))
def test_each_mutation_turns_its_test_red(label, monkeypatch):
    edits, check, *which = MUTATIONS[label]
    name = which[0] if which else "Flight"
    monkeypatch.setitem(check.__globals__, name, getattr(load(edits), name))
    with pytest.raises((AssertionError, asyncio.CancelledError)):                         # a cancelled shared read is a red result too
        check()
