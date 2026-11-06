"""Threat-model section 8, item 22: a process that only IMPORTS `hermes_cli.web_server` (a gateway) mounts the plugin's router and, until now, started a second budget watcher.
`hermes_compat.serving` says whether THIS process serves LuveBot's routes: the dashboard's lifespan ran (`event_lock` on `app.state`, set by both Hermes lifespans) and the
router is mounted. It answers FALSE only POSITIVELY (a build the harness pinned, a readable `app.state`, no lifespan mark); any other case is True or unknown and the watcher
RUNS, so a Hermes that renames the mark never leaves the budget without a watcher (invariant 7: fail toward the cap). The tick leaves before opening the database on False.
Mutations: always true (an importer runs a pass), always false (a server runs none), a build that is not pinned (it would answer False)."""
from pathlib import Path
import logging
import re
import sys
import types

import pytest

import backend.hermes_compat as compat

ROOT = Path(__file__).resolve().parents[3]
API = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
COMPAT = (ROOT / 'backend' / 'hermes_compat.py').read_text()
PROVEN = ('feedface' + '0' * 32,)           # what a build the harness proved would look like: a FULL commit, compared for equality (the real list is in hermes_compat, with its evidence file)
PINNED = {'commit': 'feedface' + '0' * 32}
OTHER = {'commit': '9a8b7c6d' + '0' * 32}
TESTED = {'commit': compat.TESTED_COMMITS[0]}   # a build the BANNER trusts: that is not the same as proven for this check


def app(*, started=True, routes=('/api/plugins/luvebot/health',)):
    state = types.SimpleNamespace(**({'event_lock': object()} if started else {}))
    return types.SimpleNamespace(state=state, routes=[types.SimpleNamespace(path=p) for p in routes])


class Hostile:
    @property
    def state(self):
        raise RuntimeError('unreadable')


def table(mod):
    serving = mod.serving
    assert serving(PINNED, app(started=False)) == (False, 'no_lifespan')                       # a pinned Hermes, a readable app, no lifespan: it only imported
    assert serving(PINNED, app()) == (True, 'lifespan_ran')                                    # the lifespan ran and the router is mounted
    assert serving(PINNED, app(routes=('/api/plugins/luvebot',))) == (True, 'lifespan_ran')    # a Mount carries the same `path`
    assert serving(PINNED, app(routes=('/api/status', '/api/plugins/other/x'))) == (None, 'router_not_seen')   # a hot mount not through yet: unknown, never False
    assert serving(PINNED, app(routes=())) == (None, 'router_not_seen')
    for identity in (OTHER, TESTED, {}, None, {'commit': None}):                                       # any build the harness did not pin: the watcher runs as today
        assert serving(identity, app(started=False)) == (None, 'hermes_not_pinned'), identity
        assert serving(identity, app()) == (None, 'hermes_not_pinned'), identity
    assert serving(PINNED, None) == (None, 'app_unreadable')                                   # no app at all
    assert serving(PINNED, object()) == (None, 'app_unreadable')                               # no `state`
    assert serving(PINNED, Hostile()) == (None, 'app_unreadable')                              # `state` raises
    assert serving(PINNED, types.SimpleNamespace(state=types.SimpleNamespace(event_lock=1), routes=None)) == (None, 'router_not_seen')


def load(old=None, new=None):
    text = re.search(r'LIFESPAN_MARK = .*?(?=\n\ndef session_authority)', COMPAT, re.S).group(0)
    if old is not None:
        assert text.count(old) == 1, old
        text = text.replace(old, new)
    ns = {'sys': sys}
    exec(text, ns)
    ns['SERVING_PROVEN'] = PROVEN                                              # whatever the source's own list holds, these tests use a fixed build
    return types.SimpleNamespace(**{k: ns[k] for k in ('serving', 'pinned', 'read_app')})


def test_serving_is_false_only_positively():
    table(load())


@pytest.mark.parametrize('old,new', [
    ("    return (bool(identity) and isinstance(identity.get(\"commit\"), str) and identity[\"commit\"] in SERVING_PROVEN and not identity.get(\"dirty\"))", "    return True"),
    ("    if not started:\n        return False, \"no_lifespan\"", "    if not started:\n        return None, \"no_lifespan\""),
    ("    return (True, \"lifespan_ran\") if mounted else (None, \"router_not_seen\")", "    return (True, \"lifespan_ran\") if mounted else (False, \"router_not_seen\")"),
    ("    except Exception:  # noqa: BLE001\n        return None, \"app_unreadable\"\n    if not started:", "    except Exception:  # noqa: BLE001\n        return False, \"app_unreadable\"\n    if not started:"),
    ("        started = hasattr(state, LIFESPAN_MARK)", "        started = True"),
], ids=['every_build_is_pinned', 'no_lifespan_is_unknown', 'router_not_seen_is_false', 'unreadable_is_false', 'the_mark_is_not_looked_at'])
def test_each_predicate_mutation_is_caught(old, new):
    with pytest.raises(Exception):  # noqa: B017
        table(load(old, new))


def tick_of(source, monkeypatch, identity, the_app, *, served=False, raises=None):
    """The watcher's own `_background_tick`, run from its source with stand-ins; -> how many times it opened the database (a pass began)."""
    text = re.search(r'def _background_tick\(\):.*?(?=\n\n\ndef _background_loop)', source, re.S).group(0)
    opened = []
    fake_hermes = types.ModuleType('hermes_cli.web_server_profiles')
    fake_hermes.get_process_hermes_home = lambda: Path('/nonexistent-luvebot-home')
    monkeypatch.setitem(sys.modules, 'hermes_cli', types.ModuleType('hermes_cli'))
    monkeypatch.setitem(sys.modules, 'hermes_cli.web_server_profiles', fake_hermes)

    def watch_pass():
        opened.append(1)
        raise RuntimeError('stop here: a pass began')
    def boom():
        raise RuntimeError('the check itself failed')
    monkeypatch.setattr(compat, 'SERVING_PROVEN', PROVEN)
    wrapped = types.SimpleNamespace(read=boom if raises == 'read' else (lambda: (identity, 'in_process')), read_app=boom if raises == 'read_app' else (lambda: the_app),
                                    serving=(lambda *_a: boom()) if raises == 'serving' else compat.serving)
    ns = {'hermes_compat': wrapped, '_watch_pass': watch_pass, '_lease_for': lambda path: None, 'logging': logging, '_SERVED': [served]}   # no lease here: it is tested apart
    exec(text, ns)
    ns['_background_tick']()
    return len(opened)


def tick_checks(source, monkeypatch):
    assert tick_of(source, monkeypatch, PINNED, app(started=False)) == 0       # the importer (a pinned gateway that never served): no pass, no database, no heartbeat
    assert tick_of(source, monkeypatch, PINNED, app()) == 1                    # the process that serves: a pass
    assert tick_of(source, monkeypatch, OTHER, app(started=False)) == 1        # a build not pinned: the watcher runs as it did before this check
    assert tick_of(source, monkeypatch, PINNED, None) == 1                     # an app that cannot be read: runs
    assert tick_of(source, monkeypatch, PINNED, app(routes=())) == 1           # a router not seen yet (a hot mount): runs
    assert tick_of(source, monkeypatch, PINNED, app(started=False), served=True) == 1   # a request reached this process: it serves, whatever the check says
    for raised in ('read', 'read_app', 'serving'):
        assert tick_of(source, monkeypatch, PINNED, app(started=False), raises=raised) == 1, raised   # the check failing never takes the pass down: unknown, runs


def test_the_tick_leaves_only_for_a_process_that_positively_does_not_serve(monkeypatch):
    tick_checks(API, monkeypatch)


@pytest.mark.parametrize('old,new', [
    ("        if serving is False and not _SERVED[0]:  # POSITIVELY", "        if False and not _SERVED[0]:  # POSITIVELY"),
    ("        if serving is False and not _SERVED[0]:  # POSITIVELY", "        if True and not _SERVED[0]:  # POSITIVELY"),
    ("        if serving is False and not _SERVED[0]:  # POSITIVELY", "        if not serving and not _SERVED[0]:  # POSITIVELY"),
    ("        if serving is False and not _SERVED[0]:  # POSITIVELY", "        if serving is False:  # POSITIVELY"),
    ("        try:\n            serving = hermes_compat.serving(hermes_compat.read()[0], hermes_compat.read_app())[0]\n        except Exception:  # noqa: BLE001  (a check that cannot be made is \"unknown\": the watcher runs, it never takes the pass down)\n            serving = None\n",
     "        serving = hermes_compat.serving(hermes_compat.read()[0], hermes_compat.read_app())[0]\n"),
], ids=['always_true_an_importer_runs', 'always_false_a_server_runs_none', 'unknown_also_leaves', 'the_served_flag_is_ignored', 'the_check_can_take_the_pass_down'])
def test_each_tick_mutation_is_caught(monkeypatch, old, new):
    assert API.count(old) == 1, old
    with pytest.raises(Exception):  # noqa: B017
        tick_checks(API.replace(old, new), monkeypatch)


def test_health_says_whether_this_process_serves():
    health = API.split('async def health(', 1)[1].split('\n@router', 1)[0]
    assert "serving, serving_why = hermes_compat.serving(identity, request.app)" in health and "'watcher': {'serving': serving, 'reason': serving_why" in health
    assert "hermes_compat.serving(hermes_compat.read()[0], hermes_compat.read_app())" in API


def health_wired(text):
    health = text.split('async def health(', 1)[1].split('\n@router', 1)[0]
    order = [health.find(x) for x in ("    try:\n        serving, serving_why = hermes_compat.serving(identity, request.app)\n    except Exception:", "    if serving is False:",
                                       "'code': 'watcher_misdetected'", "        serving = None\n    return {'ok'", "'watcher': {'serving': serving, 'reason': serving_why")]
    return all(i >= 0 for i in order) and order == sorted(order)


def test_health_never_says_false_here_and_says_so_out_loud():
    """This process ANSWERED, so it serves: a False computed in /health is the check being wrong, reported as the problem `watcher_misdetected` with `serving` null."""
    assert health_wired(API)
    for old, new in (("'code': 'watcher_misdetected'", "'code': 'watcher_ok'"), ("        serving = None\n    return {'ok'", "        pass\n    return {'ok'"),
                     ("    except Exception:  # noqa: BLE001\n        serving, serving_why = None, 'app_unreadable'", "    except ZeroDivisionError:\n        serving, serving_why = None, 'app_unreadable'")):
        assert API.count(old) == 1, old
        assert not health_wired(API.replace(old, new)), old


def served_wired(text):
    handle = text.split('        async def handle(request):', 1)[1].split('\n        return handle', 1)[0]
    return '_SERVED = [False]' in text and handle.lstrip().startswith('_SERVED[0] = True') and handle.index('_SERVED[0] = True') < handle.index('_identity(request)')


def test_a_request_that_reaches_the_router_marks_the_process_as_serving():
    assert served_wired(API)
    assert not served_wired(API.replace('            _SERVED[0] = True\n', '', 1))
    assert not served_wired(API.replace('_SERVED = [False]', '_SERVED = [True]').replace('            _SERVED[0] = True\n', ''))


EVIDENCE = ROOT / 'tests' / 'harness' / 'evidence'


def serving_gaps(entries, root=EVIDENCE):
    """The SERVING_PROVEN entries with no `serving-<entry>.txt` that says `code: serving_proven`, `result: pass` and a `hermes_commit` EQUAL to the entry, which is itself a FULL commit (40 hex):
    the comparison in `pinned` is equality, so a short or prefix entry would never match (an inert predicate dressed as a proof)."""
    gaps = []
    for entry in entries:
        path = Path(root) / f'serving-{entry}.txt'
        fields = dict(line.split(': ', 1) for line in (path.read_text(errors='replace') if path.is_file() else '').splitlines() if ': ' in line)
        commit = fields.get('hermes_commit', '')
        if not (fields.get('code') == 'serving_proven' and fields.get('result') == 'pass' and re.fullmatch(r'[0-9a-f]{40}', entry) and commit == entry):
            gaps.append(entry)
    return gaps


def test_the_predicate_is_inert_until_the_proof_is_in():
    """GATE: a commit is in SERVING_PROVEN only with its evidence file (the three cases, the pin of `event_lock` and the lease run on that build: changing this list is that decision, in
    review; it is NOT TESTED_COMMITS, which the banner grows). Any build not listed says unknown, and the watcher runs as before."""
    assert serving_gaps(compat.SERVING_PROVEN) == [], 'SERVING_PROVEN names a build with no evidence file in tests/harness/evidence/'
    assert compat.serving(TESTED, app(started=False)) == (None, 'hermes_not_pinned')
    assert compat.serving({'commit': 'f8489405' + '0' * 32}, app(started=False)) == (None, 'hermes_not_pinned')


def test_the_serving_evidence_check_bites(tmp_path):
    entry = 'feedface' + '0' * 32
    good = 'code: serving_proven\nresult: pass\nhermes_commit: ' + entry + '\n'
    cases = {'absent': None, 'empty': '', 'another code': good.replace('serving_proven', 'run_unknown'), 'failed': good.replace('pass', 'fail'), 'no commit': 'code: serving_proven\nresult: pass\n',
             'short commit': good.replace('0' * 32, ''), 'another build': good.replace('feedface', 'deadbeef'), 'bad hex': good.replace('feedface', 'NOTHEX!!')}
    for label, text in cases.items():
        if text is not None:
            (tmp_path / f'serving-{entry}.txt').write_text(text)
        assert serving_gaps((entry,), tmp_path) == [entry], label
    (tmp_path / f'serving-{entry}.txt').write_text(good)
    assert serving_gaps((entry,), tmp_path) == []
    (tmp_path / 'serving-feedface.txt').write_text(good)                         # a SHORT entry never counts, even with the full commit inside its file
    assert serving_gaps(('feedface',), tmp_path) == ['feedface']
