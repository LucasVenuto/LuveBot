"""A-145 (contract v0.10 section 6), READ-ONLY: how many SOULs LuveBot would lock (`redacted`: a key, a line the real redactor takes for a secret, an inline image; `truncated`: over 64 KiB).

Prints, per profile, the NAME and two flags and the size, then the totals: never a SOUL's text, and it opens nothing for writing. Run it with the Hermes venv's python against any home:

    HERMES_HOME=~/.hermes <hermes-venv>/bin/python tests/harness/soul_redaction_count.py

The count uses LuveBot's OWN functions (`bot_controls.as_shown`, `capped`, `split_soul`) and the redactor the route uses (`plugin_api._REDACT`), so it says what `GET /bots/{bot}/soul` would say."""
import importlib.util
import os
import sys
from pathlib import Path


def load_plugin(root):
    spec = importlib.util.spec_from_file_location('luvebot_soul_count', Path(root) / 'dashboard/plugin_api.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    from luvebot_backend import bot_controls
    return module, bot_controls


def count_souls(home, redact, bot_controls):
    """-> [(profile, redacted, truncated, bytes)] for the default profile and every profile that has a SOUL.md."""
    home = Path(home)
    found = [('default', home / 'SOUL.md')] + [(p.name, p / 'SOUL.md') for p in sorted((home / 'profiles').glob('*')) if p.is_dir()]
    rows = []
    for name, path in found:
        if not path.is_file():
            continue
        user = bot_controls.split_soul(path.read_text(encoding='utf-8-sig'))[0]
        rows.append((name, bot_controls.as_shown(user, redact) != user, bot_controls.capped(user, redact, bot_controls.SOUL_MAX)[1], len(user.encode('utf-8'))))
    return rows


if __name__ == '__main__':
    root = Path(os.environ.get('LUVEBOT_ROOT') or Path(__file__).resolve().parents[2])
    module, controls = load_plugin(root)
    rows = count_souls(os.environ.get('HERMES_HOME') or Path.home() / '.hermes', module._REDACT, controls)
    for name, redacted, truncated, size in rows:
        print(f'{name}: redacted={redacted} truncated={truncated} bytes={size}')
    print(f'SOULs: {len(rows)}; redacted: {sum(r[1] for r in rows)}; truncated: {sum(r[2] for r in rows)}')
