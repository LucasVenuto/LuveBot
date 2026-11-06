"""Pages review v0, step 21a (docs/contracts/pages-review-v0.md): "Revisar antes de salvar" and "Aprovar e salvar".

What lives here, all pure or reading the page's file only:
* `make_proposal`: what the hook (0.6.0) records for a write_file / patch call: the text, REDACTED FIRST and only then cut at 64 KiB (a secret
  across the cut must not survive), with its kind, tag and size. One implementation, called by the hook, so the order cannot drift.
* `clean_proposal`, `page_of`: what the approval row keeps, re-checked when read (a stored row is never half-trusted).
* `unchanged`: the sha check of "Aprovar e salvar": the file on disk today against the file at the request.
* `diff`: the plain unified diff of the page now against what the Bot wants to save (text lines, never HTML).
* `find_review_rule`: the switch, derived from the ACTIVE rule that has the exact shape the screen creates.
"""
import difflib
import re

from . import rules

PROPOSAL_MAX = 64 * 1024           # bytes of content kept, after redaction
PROPOSAL_INPUT_MAX = 1024 * 1024   # what is looked at before redacting (a secret cannot reach the 64 KiB kept from beyond this)
KINDS = ('whole', 'replace', 'v4a')
PAGE_TAG = re.compile(r'workspace:pages/([a-z0-9][a-z0-9-]{0,63})\.md', re.I)
REVIEW_TOOLS = frozenset({'write_file', 'patch'})
REVIEW_PATH = ('path:under', 'workspace:pages')
DIFF_MAX_LINES = 2000
MAX_TAG = 1024


def _cut(text):
    raw = text.encode('utf-8')
    return raw[:PROPOSAL_MAX].decode('utf-8', 'ignore'), len(raw) > PROPOSAL_MAX


def make_proposal(kind, path_tag, text, redact):
    """-> {kind, path_tag, size, truncated, content}. `content` is redacted FIRST, then cut at 64 KiB; `size` is the bytes the Bot sent."""
    if kind not in KINDS or not isinstance(text, str) or not isinstance(path_tag, str):
        raise ValueError('unusable proposal')
    content, truncated = _cut(redact(text[:PROPOSAL_INPUT_MAX]))
    return {'kind': kind, 'path_tag': path_tag[:MAX_TAG], 'size': len(text.encode('utf-8')), 'truncated': truncated or len(text) > PROPOSAL_INPUT_MAX,
            'content': content}


def clean_proposal(raw):
    """A stored proposal read back: the same shape or None. Anything off is no preview (the card says "sem prévia"), never a half-shown one."""
    if not isinstance(raw, dict) or set(raw) != {'kind', 'path_tag', 'size', 'truncated', 'content'}:
        return None
    if (raw['kind'] not in KINDS or not isinstance(raw['path_tag'], str) or len(raw['path_tag']) > MAX_TAG
            or isinstance(raw['size'], bool) or not isinstance(raw['size'], int) or raw['size'] < 0
            or not isinstance(raw['truncated'], bool) or not isinstance(raw['content'], str)):
        return None
    content, cut = _cut(raw['content'])  # a row that holds more than the limit is cut again, and says so
    return {'kind': raw['kind'], 'path_tag': raw['path_tag'], 'size': raw['size'], 'truncated': raw['truncated'] or cut, 'content': content}


def page_of(paths, bot, sha_of):
    """`{slug, base_sha}` when the call touches exactly ONE page (`workspace:pages/<slug>.md`), else None. `base_sha` is the file's sha on disk
    NOW (the moment of the request), None when the page does not exist (or cannot be read: it then reads as "not there" and any later page is a change)."""
    if not isinstance(paths, (list, tuple)) or len(paths) != 1 or not isinstance(paths[0], str):
        return None
    found = PAGE_TAG.fullmatch(paths[0])
    if not found:
        return None
    slug = found.group(1).lower()  # macOS ignores case: `Pages/Plan.md` is the page `plan`
    return {'slug': slug, 'base_sha': sha_of(bot, slug)}


def unchanged(page, bot, sha_of):
    """True while the page's file is what it was at the request. `base_sha` None and still no file is unchanged; a page created meanwhile is not."""
    return isinstance(page, dict) and sha_of(bot, page.get('slug')) == page.get('base_sha')


def diff(current_text, proposed_text):
    """`{format: 'unified', lines, truncated}`: the plain diff of what the page is now against what the Bot wants to save. Lines are text with their
    own `+`/`-`/` `/`@@` marker; the screen shows them as text. No page now = every line is an addition."""
    old = [] if current_text is None else current_text.splitlines()
    new = proposed_text.splitlines()
    lines = list(difflib.unified_diff(old, new, 'agora', 'proposta', lineterm='', n=3))
    return {'format': 'unified', 'lines': lines[:DIFF_MAX_LINES], 'truncated': len(lines) > DIFF_MAX_LINES}


def _is_review_shape(rule):
    m = rule.match
    return (rule.state is rules.RuleState.ACTIVE and rule.level is rules.Level.ASK and not rule.builtin
            and set(m.tools) == REVIEW_TOOLS and len(m.tools) == 2 and not m.toolsets and not m.mcp_servers and not m.commands
            and len(m.conditions) == 1 and (m.conditions[0][0].casefold(), m.conditions[0][1].casefold()) == REVIEW_PATH)


def find_review_rule(active_rules, bot):
    """The rule behind the switch: ACTIVE, `ask`, not built-in, tools exactly write_file and patch, nothing else in its match but ONE condition
    `path under workspace:pages`, and of the scope of THIS Bot or GLOBAL (it reviews this Bot's writes either way). A rule of a ROOM or a ROUTINE covers
    only part of the writes and does not count. With both, the Bot's own wins (the screen can archive that one). Any other shape is not the switch."""
    shaped = [r for r in active_rules if _is_review_shape(r)]
    own = next((r for r in shaped if r.scope.kind is rules.ScopeKind.BOT and r.scope.ref == bot), None)
    return own or next((r for r in shaped if r.scope.kind is rules.ScopeKind.GLOBAL), None)


def scope_of(rule):
    """`bot` (the screen may archive it) or `global` (a rule of every Bot: the screen says where to turn it off, and offers no archive button)."""
    return 'bot' if rule.scope.kind is rules.ScopeKind.BOT else 'global'
