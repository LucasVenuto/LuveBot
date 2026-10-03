"""Run by scripts/install.sh with the Python that runs Hermes: `check`, `enable` or `disable` the luvebot dashboard plugin, and
`upgrade` the Bots that already exist (T12: the Markdown platform hint, never over a hint the owner wrote; audited).

Uses Hermes's own activation transaction (hermes_cli.plugins_cmd), never an edit of its config files. `check` only proves
that this interpreter is the right one: it imports the activation code and changes nothing.
"""
import sys

try:
    from hermes_cli.plugins_cmd import _set_plugin_enabled
except Exception as error:  # noqa: BLE001  (any import failure means this is not the Python that runs Hermes)
    sys.exit(f"this Python cannot import hermes_cli.plugins_cmd ({type(error).__name__})")



def upgrade():
    """Each existing Bot through the installed backend (the same package the dashboard loads), audited as `installer`."""
    import importlib.util
    import os
    from pathlib import Path
    home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    backend = home / "plugins" / "luvebot" / "backend"
    spec = importlib.util.spec_from_file_location("luvebot_backend", backend / "__init__.py", submodule_search_locations=[str(backend)])
    package = importlib.util.module_from_spec(spec)
    sys.modules["luvebot_backend"] = package
    spec.loader.exec_module(package)
    from luvebot_backend.audit import AuditLog
    from luvebot_backend.bot_controls import ensure_markdown_hint
    from luvebot_backend.bots import profile_infos
    audit = AuditLog(home / "luvebot" / "luvebot.db")
    for info in profile_infos():
        print(f"LuveBot: {info['name']}: markdown hint {ensure_markdown_hint(info['name'], audit, 'installer')}")


action = sys.argv[1] if len(sys.argv) > 1 else ""
if action in ("enable", "disable"):
    _set_plugin_enabled("luvebot", enable=action == "enable")
elif action == "upgrade":
    upgrade()
elif action != "check":
    sys.exit("usage: plugin_state.py check|enable|disable|upgrade")
