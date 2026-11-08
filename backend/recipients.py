"""The `recipient` facts of the hook (0.7.0, docs/contracts/rules-conditions-v0.md section 10): who a model-callable tool sends something to, as
tags the engine matches (`origin`, `local`, `all`, `bot:<profile>`, `chat:<platform>:<chat_id>`, or `unresolved`).

Only the two tools a model can call that name a recipient have an adapter, by exact name:
* `kanban_create`: `assignee` -> `bot:<profile>`, the profile's REAL name from Hermes's own profile list (an assignee that is not a profile, or
  a list that cannot be read, is `unresolved`);
* `cronjob_manage`: on `create` and `update`, the tags of `deliver` and of `failure_deliver`, each a comma-list, read by a LEXICAL parse of the
  grammar the tool documents ('local', 'all', 'origin', 'bot-chat:<profile>', 'platform:chat_id[:thread_id]'; comma-combined). No Hermes
  resolver and no plugin discovery (that code runs plugins with no deadline: it has no place in a hook). Anything outside the grammar is
  `unresolved`, which a restrictive rule matches and a permissive one does not: a channel name, '#general', a bare 'bot-chat', an unknown shape.
`send_message` is NOT an adapter: Hermes does not register it as a model tool (tools/send_message_tool.py:28, toolsets.py:189 in v0.22.5).

The tags keep what the grammar gave (no folding: the engine folds on the restrictive side). Pure: Hermes's profile list comes in as a callable,
so this module loads and is tested without Hermes."""
import re

ADAPTER_TOOLS = ("kanban_create", "cronjob_manage")   # the same names as the `recipient` entries of rules.ADAPTERS (a test pins it)
UNRESOLVED = "unresolved"
WORDS = ("origin", "local", "all", "bot-chat")
_PROFILE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", re.ASCII)
_PLATFORM = re.compile(r"[a-z0-9_-]{1,32}", re.ASCII)
_CHAT_ID = re.compile(r"-?[0-9]{1,20}", re.ASCII)


def _token(raw):
    """The tag of ONE element of a deliver list."""
    token = raw.strip()
    if token.lower() == "origin":                       # Hermes reads `origin` case-insensitively (cronjob_job_args.py `_resolve_cron_context_deliver`)
        return "origin"
    if token in ("local", "all"):
        return token
    if token.startswith("bot-chat:"):
        profile = token[len("bot-chat:"):].strip()
        return f"bot:{profile}" if _PROFILE.fullmatch(profile) else UNRESOLVED
    parts = token.split(":")
    if 2 <= len(parts) <= 3 and parts[0] not in WORDS and _PLATFORM.fullmatch(parts[0]) and _CHAT_ID.fullmatch(parts[1]) \
            and (len(parts) == 2 or parts[2].strip()):
        return f"chat:{parts[0]}:{parts[1]}"            # the thread is dropped: a rule on a chat covers every thread of it
    return UNRESOLVED                                    # a bare `bot-chat`, a channel name, an unknown platform, anything else


def deliver_tags(value):
    """Tags of a `deliver` / `failure_deliver` value: a string (a comma-list) or a list of strings (Hermes joins those). Anything else, or a list
    with nothing in it, is `unresolved`. Order kept, duplicates dropped."""
    if isinstance(value, (list, tuple)) and all(isinstance(item, str) for item in value):
        value = ",".join(value)
    if not isinstance(value, str):
        return [UNRESOLVED]
    elements = [piece for piece in value.split(",") if piece.strip()]
    return list(dict.fromkeys(_token(piece) for piece in elements)) or [UNRESOLVED]


def _blank(value):
    return value is None or (isinstance(value, str) and not value.strip()) or (isinstance(value, (list, tuple)) and not value)


def _cron_tags(args):
    action = args.get("action")
    action = action.strip().lower() if isinstance(action, str) else None
    if action not in ("create", "update"):
        return [UNRESOLVED]                              # list, pause, resume, remove, run: no new recipient. A rule on this tool asks (noisy, safe)
    deliver, failure = args.get("deliver"), args.get("failure_deliver")
    if action == "create":
        tags = ["origin"] if _blank(deliver) else deliver_tags(deliver)   # omitted = the chat the job was made from
    else:
        tags = [UNRESOLVED] if _blank(deliver) else deliver_tags(deliver)  # an update without it keeps the old target, which the hook cannot know
    if not _blank(failure):                              # omitted (or cleared on update): failures follow `deliver`, nothing new is posted elsewhere
        tags += deliver_tags(failure)
    return list(dict.fromkeys(tags))


def _kanban_tags(args, profiles):
    assignee = args.get("assignee")
    if not isinstance(assignee, str) or not assignee.strip():
        return [UNRESOLVED]
    try:
        names = [name for name in profiles() if isinstance(name, str)]
    except Exception:  # noqa: BLE001  (the list cannot be read: nothing can be said)
        return [UNRESOLVED]
    real = next((name for name in names if name.lower() == assignee.strip().lower()), None)   # Hermes lowercases profile ids
    return [f"bot:{real}"] if real and _PROFILE.fullmatch(real) else [UNRESOLVED]


def recipient_facts(tool_name, args, profiles):
    """-> the list of tags of this call, or None for a tool with no adapter. `profiles` = a callable returning Hermes's profile names."""
    if tool_name not in ADAPTER_TOOLS:
        return None
    args = args if isinstance(args, dict) else {}
    try:
        return _kanban_tags(args, profiles) if tool_name == "kanban_create" else _cron_tags(args)
    except Exception:  # noqa: BLE001
        return [UNRESOLVED]
