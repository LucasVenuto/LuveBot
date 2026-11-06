"""Concurrent identical reads share ONE computation (perf item 4): every open tab polls GET /bots every 15 s, and each poll used to recompute the
whole fleet (a dozen SQLite connections and three Hermes session stores per Bot). Calls that arrive while the same read is running wait for it
instead of starting their own.

Never older than the call that asked: a call joins a running read only if nothing was CHANGED since that read began (`epoch`: the dashboard bumps it
on every non-GET request, before and after), so a person who just paused a Bot does not get the answer computed before the pause. The result is
not kept after it is delivered (no time-to-live: a read that finished is gone), so nothing here makes an answer stale."""
import asyncio
import time

from .hermes_boundary import guarded


class Flight:
    def __init__(self):
        self._busy = {}   # key -> (epoch, task)

    async def run(self, key, epoch, make):
        """-> what `make()` (a coroutine function) returns, started now or already running for this key and epoch. The computation is shielded: a
        caller that goes away (a closed tab) does not cancel it for the others."""
        hit = self._busy.get(key)
        if hit is None or hit[0] != epoch:
            task = asyncio.ensure_future(guarded(make()))   # a SystemExit out of a Task is re-raised by asyncio into the event loop: the config outage becomes an ordinary error here
            hit = self._busy[key] = (epoch, task)
            task.add_done_callback(lambda done, key=key: self._finished(key, done))
        return await asyncio.shield(hit[1])

    def _finished(self, key, task):
        if self._busy.get(key, (None, None))[1] is task:
            del self._busy[key]
        if not task.cancelled():
            task.exception()   # retrieved: a failure reaches the callers that await it, never a "never retrieved" warning


class Memo:
    """A `Flight` that also remembers the answer for a few seconds, for the reads a poll repeats (the Today screen asks for the activity twice, the
    running tab and the done tab, one right after the other). The memory is never older than `ttl` and never older than a change: an entry is used
    only while the epoch (the dashboard's count of non-GET requests) is the one it was asked under. A failure is not remembered. The value is
    SHARED between callers: a caller that changes it must copy it first."""

    def __init__(self, ttl, clock=time.monotonic):
        self._flight, self._ttl, self._clock, self._kept = Flight(), ttl, clock, {}

    async def get(self, key, epoch, make):
        kept = self._kept.get(key)
        if kept is not None and kept[0] == epoch and self._clock() - kept[1] < self._ttl:
            return kept[2]
        value = await self._flight.run(key, epoch, make)
        now = self._clock()
        self._kept[key] = (epoch, now, value)   # stamped with the epoch the CALL was made under: a change since reads as older
        if len(self._kept) > 64:                # a few Bots and a few shapes: this only keeps the dict small
            self._kept = {k: v for k, v in self._kept.items() if now - v[1] < self._ttl}
        return value
