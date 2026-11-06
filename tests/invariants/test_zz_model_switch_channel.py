"""M-6 (a) (contract v0.11 section 1.1): does a CHANNEL conversation (Telegram, Slack, ...) keep the model it started with after the Bot's model is switched? M-2 measured the API Server (a LuveBot conversation: the agent of
every run is built from the config as it is then); Hermes's docstring "applies to new sessions only" is about the gateway's channel sessions, which keep a cached agent per session (`gateway/run.py`, `_agent_cache`).
The card can say more than "in LuveBot" only if this is measured.

A REAL gateway (`python -m gateway.run`) in its own throw-away home, whose messaging platform is the test platform plugin of tests/harness/fake_channel_platform.py (the way `channel_turn` of test_hook.py does it),
and the fake model, which says the model NAME it received (`M2_MODEL_PROBE`). The "switch" is what LuveBot's route does to the Bot's `config.yaml` (`model.default` changes; the provider and the endpoint stay):
  1. a message in the channel: the fake says the model the conversation started with;
  2. `model.default` changes in the config file;
  3. ANOTHER message in the SAME channel conversation: which model does the (cached?) agent send now?;
  4. `/new` (a new channel session), then a message: a new session must use the new model.
MEASURED (v0.22.5): the same channel conversation says the NEW model on its next message, and so does a new session after `/new`: the gateway's cached agent does not keep the old model across a change of `model.default`, so the card may say
"from the next message" for LuveBot conversations and for channels alike. What the gateway does is Hermes's: the asserts PIN it, so a Hermes that changes turns this red on purpose and the card's words can be reviewed. It needs the stack's fake model (the harness lane)."""
import json
import os
import shutil
import subprocess
import sys
import time

import hermes_yaml as yaml

from test_hook import REPO, wait_for

OLD, NEW = 'fake-harness', 'fake-harness-switched'


def note(line):
    print(line)
    try:
        from support import STATE
        with open(STATE / 'logs' / 'm6-channel-timeline.txt', 'a') as handle:
            handle.write(time.strftime('%H:%M:%S ') + line + '\n')
    except OSError:
        pass


def test_a_channel_conversation_after_a_model_switch(tmp_path):
    root = tmp_path / 'gw'
    home = root / '.hermes'
    plugins = home / 'plugins'
    (plugins / 'lbfake').mkdir(parents=True)
    (plugins / 'lbfake' / 'plugin.yaml').write_text('name: lbfake\nlabel: LuveBot test channel\nkind: platform\nversion: 0.0.1\n')
    shutil.copy(REPO / 'tests' / 'harness' / 'fake_channel_platform.py', plugins / 'lbfake' / '__init__.py')
    config = {'model': {'provider': 'custom', 'base_url': 'http://fake-openai:8000/v1', 'default': OLD, 'context_length': 128000},
              'agent': {'api_max_retries': 0, 'max_turns': 6}, 'compression': {'enabled': False}, 'memory': {'memory_enabled': False},
              'plugins': {'enabled': ['lbfake']}, 'platforms': {'lbfake': {'enabled': True}}, 'platform_toolsets': {'lbfake': ['terminal']}, 'terminal': {'backend': 'local'}}
    (home / 'config.yaml').write_text(yaml.safe_dump(config))
    (home / '.env').write_text('OPENAI_API_KEY=sk-fake-m6\n')
    inbox, outbox = root / 'inbox.jsonl', root / 'outbox.jsonl'
    env = {k: v for k, v in os.environ.items() if not k.startswith(('HERMES_', 'OPENAI', 'LUVEBOT_')) and not k.endswith(('_API_KEY', '_TOKEN'))}
    env.update({'HOME': str(root), 'HERMES_HOME': str(home), 'OPENAI_API_KEY': 'sk-fake-m6', 'PYTHONPATH': '/opt/hermes', 'HERMES_STATE_DB_GUARD_BYPASS': '1',
                'HERMES_GATEWAY_LOCK_DIR': str(root / 'locks'), 'HERMES_GATEWAY_MAX_STARTS': '0', 'LBFAKE_ALLOW_ALL_USERS': 'true', 'LBFAKE_INBOX': str(inbox), 'LBFAKE_OUTBOX': str(outbox)})

    def sent():
        if not outbox.exists():
            return []
        return [str(e.get('text')) for e in (json.loads(line) for line in outbox.read_text().splitlines()) if e.get('ev') == 'send']

    def ready():
        return outbox.exists() and any(json.loads(line).get('ev') == 'ready' for line in outbox.read_text().splitlines())

    def say(text):
        before = len([t for t in sent() if t.startswith('MODEL:')])
        with open(inbox, 'a', encoding='utf-8') as handle:
            handle.write(json.dumps({'text': text}) + '\n')
        return before

    def next_model(before, what):
        wait_for(lambda: len([t for t in sent() if t.startswith('MODEL:')]) > before or None, 90, what)
        return [t for t in sent() if t.startswith('MODEL:')][before]

    with open(root / 'gateway.log', 'wb') as log:
        gateway = subprocess.Popen([sys.executable, '-m', 'gateway.run'], cwd=str(root), env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
    try:
        wait_for(lambda: ready() or gateway.poll() is not None, 180, 'the test channel connected')
        assert gateway.poll() is None, (root / 'gateway.log').read_text()[-3000:]
        first = next_model(say('M2_MODEL_PROBE: first message of the conversation'), 'the first answer')
        config['model']['default'] = NEW                                                                       # what LuveBot's switch writes: the model, nothing else
        (home / 'config.yaml').write_text(yaml.safe_dump(config))
        same_session = next_model(say('M2_MODEL_PROBE: second message, same conversation'), 'the answer after the switch')
        before = say('/new')
        time.sleep(3)
        new_session = next_model(say('M2_MODEL_PROBE: first message of a new session'), 'the answer of a new session')
        note(f'CHANNEL: started with {first!r}; config switched to {NEW!r}; same conversation says {same_session!r}; after /new says {new_session!r}')
        assert first == 'MODEL:' + OLD, first
        assert new_session == 'MODEL:' + NEW, new_session                                                     # a new channel session reads the config as it is now
        assert same_session == 'MODEL:' + NEW, same_session                                                   # MEASURED on v0.22.5: the SAME channel conversation follows the switch on its next message (no cached agent keeps the old model)
    finally:
        gateway.terminate()
        try:
            gateway.wait(timeout=60)
        except subprocess.TimeoutExpired:
            gateway.kill()
