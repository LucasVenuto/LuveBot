"""D-007: a Bot's live screen (Hermes Bot Desktop) behind the plugin. Proposal: docs/propostas/d007-aba-tela.md.

Every call to Hermes leaves the BACKEND, over its own connection to the dashboard's `/api/ws` with the server-internal
credential Hermes gives clients of its own process (hermes_cli/web_server_chat.py _server_internal_ws_url), and uses Hermes's own
methods (tui_gateway/methods_display.py). The browser only ever gets a single-use, 30 s ticket for `/api/display/ws`; the
`viewer_id` (a capability: whoever presents it drives or releases the lease, tools/bot_desktop/lease.py public_view) stays here.

* take = `display.observe` + `display.lease.acquire` on ONE connection (the id is bound to the connection that minted it).
* return = `display.lease.release(viewer_id, force)` for the viewer THIS person stored only; release(viewer_id) never touches
  another person's lease.
* start never calls `display.install` (it asks for the host's sudo password); stop never passes `force`.
* A lease Hermes gives back on its own (the viewer window closed) is found by `reconcile` and audited.
"""
import asyncio
import hashlib
import itertools
import json
import re
import time

from . import hook_store
from .api_errors import PluginError
from .audit import ActionDenied

TICKET_TTL = 30
SCHEMA = """
CREATE TABLE IF NOT EXISTS screen_viewers (
    bot TEXT NOT NULL, actor TEXT NOT NULL, viewer_id TEXT NOT NULL, since REAL NOT NULL, PRIMARY KEY (bot, actor)
);
"""


class Refused(PluginError, ActionDenied):
    """A screen action refused because it is not this person's to do: audited as denied, answered with the contract error."""


def not_yours():
    return Refused('screen_not_yours', 'You do not have control of this screen.', 409)


class RpcError(Exception):
    def __init__(self, code, message, data=None):
        super().__init__(message)
        self.code, self.message, self.data = code, message, data or {}


def viewer_hash(viewer_id):
    """The short hash Hermes publishes instead of the id (tools/bot_desktop/lease.py public_view)."""
    return hashlib.sha256(viewer_id.encode()).hexdigest()[:12]


def default_runner(fn):
    """Run `await fn(call)` over one `/api/ws` connection of this dashboard. `call(method, params)` -> result | RpcError."""
    try:
        import websockets
        from hermes_cli.web_server_chat import _server_internal_ws_url
        url = _server_internal_ws_url('/api/ws')
    except Exception:
        url = None
    if not url:
        raise PluginError('screen_unavailable', 'The live screen is not available in this installation (the dashboard cannot reach '
                          'its own gateway connection; Hermes needs the websockets package).', 503)

    async def main():
        async with websockets.connect(url, max_size=None, open_timeout=10) as ws:
            ids = itertools.count()

            async def call(method, params):
                rid = f'luvebot-screen-{next(ids)}'
                await ws.send(json.dumps({'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params}))
                while True:
                    raw = await asyncio.wait_for(ws.recv(), 30)
                    for line in (raw.decode() if isinstance(raw, bytes) else str(raw)).splitlines():
                        try:
                            data = json.loads(line)
                        except ValueError:
                            continue
                        if isinstance(data, dict) and data.get('id') == rid:
                            if 'error' in data:
                                error = data['error'] if isinstance(data['error'], dict) else {}
                                raise RpcError(error.get('code'), str(error.get('message') or ''), error.get('data'))
                            return data.get('result') or {}
            return await fn(call)
    try:
        return asyncio.run(main())
    except (PluginError, RpcError):
        raise
    except Exception:
        raise PluginError('hermes_unreachable', 'The dashboard could not reach Hermes for the screen.', 502) from None


def _text(value, limit):
    return str(value)[:limit] if isinstance(value, str) and value else None


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def hermes_needed_mb(bot):
    """Hermes's own floor for starting a screen (`bot_desktop.min_free_memory_mb`, tools/bot_desktop/resources.py), or None."""
    try:
        from hermes_cli.web_server_profiles import _config_profile_scope
        from tools.bot_desktop.resources import min_free_mb
        with _config_profile_scope(bot):
            return min_free_mb()
    except Exception:
        return None


class Screen:
    def __init__(self, path, runner=default_runner, *, needed_mb=hermes_needed_mb):
        self.path, self.runner, self.needed_mb = path, runner, needed_mb

    # ---- the stored viewers (one per person and Bot) ----
    def _connect(self):
        conn = hook_store.connect(self.path)   # the fleet database: 0700 directory, 0600 file, no symlinks
        conn.executescript(SCHEMA)
        return conn

    def viewer(self, bot, actor):
        conn = self._connect()
        try:
            row = conn.execute("SELECT viewer_id FROM screen_viewers WHERE bot=? AND actor=?", (bot, actor)).fetchone()
            return row['viewer_id'] if row else None
        finally:
            conn.close()

    def viewers(self, bot=None):
        conn = self._connect()
        try:
            sql, args = ("SELECT * FROM screen_viewers", ()) if bot is None else ("SELECT * FROM screen_viewers WHERE bot=?", (bot,))
            return [dict(r) for r in conn.execute(sql, args)]
        finally:
            conn.close()

    def _store(self, bot, actor, viewer_id):
        conn = self._connect()
        try:
            conn.execute("INSERT OR REPLACE INTO screen_viewers (bot, actor, viewer_id, since) VALUES (?,?,?,?)", (bot, actor, viewer_id, time.time()))
            conn.commit()
        finally:
            conn.close()

    def _forget(self, bot, actor):
        conn = self._connect()
        try:
            conn.execute("DELETE FROM screen_viewers WHERE bot=? AND actor=?", (bot, actor))
            conn.commit()
        finally:
            conn.close()

    # ---- reads ----
    def status(self, bot):
        async def run(call):
            return await call('display.status', {'profile': bot})
        try:
            return self.runner(run)
        except RpcError:
            raise PluginError('screen_unavailable', 'Hermes did not report this Bot\'s screen.', 503) from None

    def lease_view(self, bot, actor, lease):
        lease = lease if isinstance(lease, dict) else {}
        held = lease.get('holder') == 'human'
        current = lease.get('viewer_hash') if held else None
        mine = self.viewer(bot, actor)
        ours = {viewer_hash(v['viewer_id']) for v in self.viewers(bot)}
        return {'holder': 'human' if held else 'agent', 'since': _number(lease.get('since')),
                'mine': bool(current and mine and current == viewer_hash(mine)), 'by_luvebot': bool(current and current in ours)}

    def view(self, bot, actor, status=None):
        """What GET returns: Hermes's own reasons, never a guess, and no id of any viewer."""
        st = self.status(bot) if status is None else status
        missing = [m for m in (st.get('missing') or []) if isinstance(m, str)][:20]
        return {'supported': bool(st.get('supported')), 'installed': bool(st.get('installed')), 'missing': missing,
                'install_command': _text(st.get('install_command'), 500), 'running': bool(st.get('running')),
                'geometry': _text(st.get('geometry'), 32), 'placement': _text(st.get('placement'), 64),
                'memory': {'available_mb': _number(st.get('memory_available_mb')), 'limit_mb': _number(st.get('memory_limit_mb')),
                           'needed_mb': _number(self.needed_mb(bot))},
                'blocker': _text(st.get('blocker'), 300), 'lease': self.lease_view(bot, actor, st.get('lease'))}

    # ---- effects (each route wraps one of these in audit.act: the intent is written before) ----
    def start(self, bot, actor):
        st = self.status(bot)
        if not st.get('supported'):
            raise PluginError('screen_unsupported', 'This machine has no Bot screen (Linux gateway hosts only).', 409)
        if not st.get('installed'):
            raise PluginError('screen_not_installed', 'The screen packages are missing on the server; see the README section "Live screen".',
                              409, {'details': {'missing': self.view(bot, actor, st)['missing'], 'install_command': _text(st.get('install_command'), 500)}})
        if st.get('blocker') and not st.get('running'):
            raise PluginError('screen_no_memory', 'There is not enough free memory for a screen now.', 409,
                              {'details': {'available_mb': _number(st.get('memory_available_mb')), 'needed_mb': _number(self.needed_mb(bot))}})

        async def run(call):
            return await call('display.start', {'profile': bot})
        try:
            started = self.runner(run)
        except RpcError:
            raise PluginError('screen_start_failed', 'Hermes could not start the screen.', 409) from None
        return self.view(bot, actor, started)

    def stop(self, bot, actor):
        st = self.status(bot)
        if (st.get('lease') or {}).get('holder') == 'human':
            raise PluginError('screen_in_use', 'A person has control of this screen; it is not stopped under them.', 409)

        async def run(call):
            return await call('display.stop', {'profile': bot})   # never force (D-007 decision 2)
        try:
            stopped = self.runner(run)
        except RpcError as error:
            if (error.data or {}).get('code') == 'viewer_mismatch':
                raise PluginError('screen_in_use', 'A person has control of this screen; it is not stopped under them.', 409) from None
            raise PluginError('screen_stop_failed', 'Hermes could not stop the screen.', 409) from None
        return self.view(bot, actor, stopped)

    def _running(self, bot):
        st = self.status(bot)
        if not st.get('running'):
            raise PluginError('screen_not_running', 'The screen is not running.', 409)
        return st

    def watch(self, bot):
        """A ticket to WATCH. Never takes the lease."""
        self._running(bot)

        async def run(call):
            return await call('display.observe', {'profile': bot})
        try:
            observed = self.runner(run)
        except RpcError:
            raise PluginError('screen_not_running', 'The screen is not running.', 409) from None
        return {'ticket': observed['ticket'], 'path': '/api/display/ws', 'expires_in': TICKET_TTL}

    def take(self, bot, actor, reason=''):
        """observe + acquire on one connection; the viewer is stored BEFORE the lease is taken, so a lease LuveBot holds is always
        one it can give back (and reconcile can see)."""
        self._running(bot)
        note = re.sub(r'[\x00-\x1f\x7f]', ' ', f'LuveBot ({actor})' + (f': {reason}' if reason else ''))[:160]

        async def run(call):
            observed = await call('display.observe', {'profile': bot})
            self._store(bot, actor, observed['viewer_id'])
            try:
                acquired = await call('display.lease.acquire', {'profile': bot, 'viewer_id': observed['viewer_id'], 'reason': note})
            except BaseException:
                self._forget(bot, actor)
                raise
            return observed, acquired
        try:
            observed, acquired = self.runner(run)
        except RpcError:
            raise PluginError('screen_take_failed', 'Hermes did not give control of the screen.', 409) from None
        return {'ticket': observed['ticket'], 'path': '/api/display/ws', 'expires_in': TICKET_TTL,
                'lease': self.lease_view(bot, actor, acquired.get('lease'))}

    def give_back(self, bot, actor):
        viewer_id = self.viewer(bot, actor)
        if viewer_id is None:
            raise not_yours()
        lease = self.status(bot).get('lease') or {}
        if lease.get('holder') != 'human' or lease.get('viewer_hash') != viewer_hash(viewer_id):
            self._forget(bot, actor)   # someone else took over, or Hermes gave it back already
            raise not_yours()

        async def run(call):
            # force skips only "minted on THIS connection"; release(viewer_id) still changes nothing unless this viewer holds
            return await call('display.lease.release', {'profile': bot, 'viewer_id': viewer_id, 'force': True})
        try:
            released = self.runner(run)
        except RpcError:
            raise PluginError('screen_return_failed', 'Hermes did not take the screen back.', 409) from None
        # Hermes ignores a release by a viewer that no longer holds (someone took over between the check above and the release) and
        # answers with the lease AFTER its own atomic transition (tools/bot_desktop/lease.py release): only "agent" there is a return.
        after = released.get('lease') or self.status(bot).get('lease') or {}
        if after.get('holder') != 'agent':
            if after.get('viewer_hash') != viewer_hash(viewer_id):
                self._forget(bot, actor)
                raise not_yours()
            raise PluginError('screen_return_failed', 'Hermes did not take the screen back.', 409)
        self._forget(bot, actor)
        return {'lease': self.lease_view(bot, actor, after)}

    def reconcile(self, audit):
        """Leases Hermes gave back on its own (a viewer window closed cleanly releases, hermes_cli/web_routers/display.py): forget the
        viewer and leave a `screen.return` row, so no hand-back goes unaudited. -> [(bot, actor)] reconciled. Never raises."""
        done = []
        for row in self.viewers():
            try:
                lease = self.status(row['bot']).get('lease') or {}
            except Exception:
                continue
            if lease.get('holder') == 'human' and lease.get('viewer_hash') == viewer_hash(row['viewer_id']):
                continue
            try:
                audit.act('system', 'screen.return', row['bot'], {'kind': 'system'}, lambda r=row: self._forget(r['bot'], r['actor']),
                          bot=row['bot'], payload={'actor': row['actor'], 'reason': 'closed_by_hermes'})
                done.append((row['bot'], row['actor']))
            except Exception:
                continue
        return done
