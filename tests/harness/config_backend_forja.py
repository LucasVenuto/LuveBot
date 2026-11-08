"""A TEST config backend for Hermes `main` (the `ConfigBackend` seam of hermes_cli/config_backend.py): the default file backend, plus an outage and locks on demand.

`HERMES_CONFIG_BACKEND=forja` selects it (Hermes imports `plugins.config_backends.forja` and calls `get_backend()`): the harness lane copies this file there as `__init__.py`. It is the
situation `HERMES_CONFIG_BACKEND=remote` creates when the config service is down or an administrator locked a key, with Hermes's OWN exception classes, raised from the places Hermes
itself calls the backend. Flag files in the stack's state folder (`$HARNESS_STATE`, `/fixtures` in the container) turn each one on:

  config-outage      any read of a profile's config raises ConfigBackendUnavailable (a SystemExit), with a message that names a URL and a password: nothing of it may reach a response
  config-write       `locked` | `invalid` | `failed`: a write raises ConfigLockedError / ConfigValueError / ConfigWriteError (messages carry hostile text too)
Nothing else changes: with no flag it behaves exactly as the file backend.
"""
import os
from pathlib import Path

from hermes_cli.config_backend import (ConfigBackendUnavailable, ConfigLockedError, ConfigValueError, ConfigWriteError, FileBackend)

LOCKED_KEY = 'voice.client_direct'
HOSTILE = 'https://admin:hostile-pass@config.example.test/v1/profile?token=hostile-token'


def flag(name):
    try:
        return (Path(os.environ.get('HARNESS_STATE', '/fixtures')) / name).read_text().strip() or '1'
    except OSError:
        return None


class ForjaBackend(FileBackend):
    def read_user_doc(self, home):
        if flag('config-outage'):
            raise ConfigBackendUnavailable(f'the config service did not answer: {HOSTILE}')
        return super().read_user_doc(home)

    def read_user_doc_readonly(self, home):
        if flag('config-outage'):
            raise ConfigBackendUnavailable(f'the config service did not answer: {HOSTILE}')
        return super().read_user_doc_readonly(home)

    def locked(self, home, dotted):
        return 'administrator' if flag('config-write') == 'locked' and dotted == LOCKED_KEY else None

    def write_changes(self, home, changes):
        mode = flag('config-write')
        if mode == 'locked':
            raise ConfigLockedError(LOCKED_KEY, 'administrator', f'locked by {HOSTILE}')
        if mode == 'invalid':
            raise ConfigValueError(f'cannot store this value: {HOSTILE}')
        if mode == 'failed':
            raise ConfigWriteError(f'the plane refused: {HOSTILE}')
        return super().write_changes(home, changes)

    def describe(self, home):
        return 'forja test backend (file + flags)'


_BACKEND = ForjaBackend()


def get_backend():
    return _BACKEND
