"""The Bot's workspace root, defined ONCE for Pages (`backend/pages.py`) and for the hook's path facts (hermes-plugin 0.6.0), and the
extraction of those facts (docs/contracts/rules-conditions-v0.md sections 2 and 3).

A fact is one TAG per file a call touches: `workspace:<rel>` (under the root), `abs:<path>` (outside it) or `unresolved`. The path comes
from Hermes's OWN resolver (`tools.file_tools_paths`: task cwd, `~`, relative paths, host symlinks), never from a normalizer of ours,
and a V4A patch is read by Hermes's own parser (`tools.patch_parser.parse_v4a_patch`, the one that applies it), so the files we name are
the files that get written. The tag keeps the case and form Hermes gave: the engine folds, on the restrictive side only.

Everything that cannot be said is `unresolved`, which a restrictive rule matches (fail closed): a missing or non-string path, a sandbox
(container) backend, a patch that does not parse, a resolver that is not there or raises. Hermes names are imported inside the functions,
so this module loads (and is tested) without Hermes."""
import json
import os
import pathlib

# The tools with a path adapter, by exact name. Kept here, not imported from `rules` (rules.PATH_TOOLS is the same tuple, pinned equal by
# tests/unit/backend/test_hook_0_6.py): Pages loads this module and must not pull the whole rules engine in with it.
PATH_TOOLS = ('write_file', 'patch')
# VR-1: the file READ tools get the same fact. A separate tuple on purpose: PATH_TOOLS is what the review card of a WRITE and the pin with `rules` mean, and it does not widen.
READ_TOOLS = ('read_file', 'search_files')

NOT_SET = ('', '.', 'auto', 'cwd')
UNRESOLVED = 'unresolved'


def cwd_root(terminal):
    """realpath of the profile's `terminal.cwd` when it is an absolute, existing directory other than `/`; else None. This is the root
    Pages works in and the root of a `workspace:` tag."""
    cwd = terminal.get('cwd') if isinstance(terminal, dict) else None
    if not isinstance(cwd, str) or cwd.strip() in NOT_SET:
        return None
    cwd = os.path.expanduser(cwd.strip())
    if not os.path.isabs(cwd):
        return None
    real = os.path.realpath(cwd)
    return None if real == '/' or not os.path.isdir(real) else real


def path_tag(resolved, root):
    """The tag of ONE path Hermes resolved on the host. A sandbox path (a pure path, not a concrete one), a relative or NUL-carrying text, a
    `.`/`..`/empty segment (a resolved path has none) and the root itself (no file is written there) are `unresolved`."""
    if not isinstance(resolved, pathlib.Path):
        return UNRESOLVED
    text = str(resolved)
    if not text.startswith('/') or '\0' in text or any(part in ('', '.', '..') for part in text.split('/')[1:]):
        return UNRESOLVED
    if root:
        base = root.rstrip('/')
        if text == base:
            return UNRESOLVED
        if text.startswith(base + '/'):
            return 'workspace:' + text[len(base) + 1:]
    return 'abs:' + text


def _wanted(tool_name, args):
    """[(path text or None, is a directory ENTRY)] for what the call writes. The entry form keeps a symlink in the last component: a delete
    or a rename acts on the link itself (Hermes resolves those paths the same way, `_collect_v4a_header_paths`)."""
    if tool_name in READ_TOOLS or tool_name == 'write_file' or args.get('mode', 'replace') != 'patch':
        return [(args.get('path'), False)]      # a read has one path, and `search_files` may have none (it searches the task's cwd): `unresolved`, which a restrictive rule matches
    text = args.get('patch')
    if not isinstance(text, str) or not text:
        return [(None, False)]
    from tools.patch_parser import parse_v4a_patch
    operations, error = parse_v4a_patch(text)
    if error or not operations:
        return [(None, False)]
    out = []
    for op in operations:
        kind = op.operation.value
        out.append((op.file_path, kind in ('delete', 'move')))
        if kind == 'move':
            out.append((op.new_path, True))
    return out


def path_facts(tool_name, args, task_id, terminal):
    """The `facts` for `rules.hook_verdict`: a list of tags, or None for a tool with no adapter. `terminal` is a callable that returns the
    profile's `terminal` config (a raising one is `unresolved`)."""
    if tool_name not in PATH_TOOLS and tool_name not in READ_TOOLS:
        return None
    try:
        from tools import file_tools_paths as hermes
        tid = task_id if isinstance(task_id, str) and task_id else 'default'
        if hermes.container_backend_for_task(tid) is not None:   # its paths belong to a sandbox: the host cannot say where they land
            return [UNRESOLVED]
        root = cwd_root(terminal())
        tags = []
        for text, entry in _wanted(tool_name, args if isinstance(args, dict) else {}):
            if not isinstance(text, str) or not text.strip():
                tags.append(UNRESOLVED)
                continue
            try:
                tags.append(path_tag((hermes._resolve_entry_for_task if entry else hermes._resolve_path_for_task)(text, tid), root))
            except Exception:  # noqa: BLE001
                tags.append(UNRESOLVED)
        return tags or [UNRESOLVED]
    except BaseException:  # noqa: BLE001  (no resolver, no parser, no config: nothing can be said)
        return [UNRESOLVED]


def _proposal_text(tool_name, args):
    """(kind, text) of what a file tool wants to save, for the card that lets a person review it first (docs/contracts/pages-review-v0.md):
    `whole` = write_file's content, `v4a` = the patch text, `replace` = the old and new strings as `- ` / `+ ` lines. A call that does not
    carry that text as a string raises: no preview, never a half-built one."""
    if tool_name == 'write_file':
        kind, text = 'whole', args.get('content')
    elif args.get('mode', 'replace') == 'patch':
        kind, text = 'v4a', args.get('patch')
    else:
        old, new = args.get('old_string'), args.get('new_string')
        if not isinstance(old, str) or not isinstance(new, str):
            raise ValueError('no old/new text')
        kind, text = 'replace', '\n'.join([f'- {line}' for line in old.splitlines()] + [f'+ {line}' for line in new.splitlines()])
    if not isinstance(text, str):
        raise ValueError('no text')
    return kind, text


def review_detail(tool_name, args, paths, redact):
    """The JSON TEXT for `hook_events.detail` on the approve row of a file tool: `{"paths": [tag, ...], "proposal": {...}}`. `paths` are the
    tags the hook passes as facts (`unresolved` stays as such). The proposal is built by `pages_review.make_proposal`, which redacts FIRST and
    cuts after (a secret across the cut does not survive); any failure leaves it out, and the card says it has no preview. No `base_sha`:
    the backend reads the page's file when it captures the request."""
    detail = {'paths': [p for p in paths if isinstance(p, str)]}
    try:
        from .pages_review import make_proposal
        kind, text = _proposal_text(tool_name, args if isinstance(args, dict) else {})
        detail['proposal'] = make_proposal(kind, detail['paths'][0] if detail['paths'] else UNRESOLVED, text, redact)
    except Exception:  # noqa: BLE001
        pass
    return json.dumps(detail, ensure_ascii=False, separators=(',', ':'))
