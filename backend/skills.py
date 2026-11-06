"""Skills per Bot (contract plugin-api v0.6, Part A): read, the Bot x Skill matrix, the global on/off, SKILL.md as text.

Everything goes through Hermes's own code, in process (A-75), under the Bot's profile (f8489405):
  hermes_cli/web_routers/skills.py  get_skills (L344: the whole catalog; `enabled` = the GLOBAL list only), toggle_skill (L375:
                                    writes `skills.disabled` under config_write_scope), get_skill_content (L393: SKILL.md)
  hermes_cli/skills_config.py       get_disabled_skills(config, platform) (L28: global + `platform_disabled.<platform>`, minus
                                    the essential skills), read-only here
  agent/skill_utils.py              ESSENTIAL_SKILLS: Hermes drops them from any disabled list, so LuveBot refuses to turn one off
LuveBot never writes config.yaml (invariant 4), and per-platform state is shown, never written (Hermes has no route for it).
Every string from Hermes is redacted (invariant 1); a Hermes error's text never leaves.
"""
import asyncio
import hashlib
import re

from . import hermes_boundary
from .api_errors import PluginError

SKILL_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}')   # A-80: anything else is 404, like a missing skill
DESCRIPTION_MAX = 300
CONTENT_MAX = 256 * 1024
MATRIX_BOTS, MATRIX_SKILLS = 50, 500                            # A-81
PLATFORM = re.compile(r'[a-z0-9_-]{1,32}')                      # F7: a platform name comes from a config KEY; anything else is shown as `other`
PLATFORMS_MAX = 20
NOTES = {'on_applies_to_new_conversations': True, 'fail_open': True, 'catalog_may_omit': True}


def feature():
    """`features.skills` of /health: Hermes has the skills handlers this module calls."""
    try:
        from agent.skill_utils import ESSENTIAL_SKILLS  # noqa: F401
        from hermes_cli.skills_config import get_disabled_skills  # noqa: F401
        from hermes_cli.web_models import SkillToggle  # noqa: F401
        from hermes_cli.web_routers.skills import get_skill_content, get_skills, toggle_skill  # noqa: F401
    except Exception:
        return 'unavailable'
    return 'ok'


def _need():
    if feature() != 'ok':
        raise PluginError('capability_missing', 'This Hermes does not provide skills; update Hermes.', 409, {'feature': 'skills'})


def not_found():
    return PluginError('skill_not_found', 'Skill not found.', 404)


def digest(text):
    """sha256 of a text as UTF-8 (a lone surrogate is three bytes, never an encoder error): the editor's `expected_digest` is of the REAL text, never of what the person is shown."""
    return hashlib.sha256(text.encode('utf-8', 'surrogatepass')).hexdigest()


def _hermes_error():
    return PluginError('hermes_error', 'Hermes could not read or change the skills of this Bot.', 502)


def _read(bot):
    """(platforms, {name: entry}) from Hermes, unredacted (never returned as is). An entry's `enabled` has `all` (Hermes's global
    state) and one key per platform: api_server (LuveBot's own surface) + every key of `skills.platform_disabled` (A-76)."""
    _need()
    from agent.skill_utils import ESSENTIAL_SKILLS
    from hermes_cli.config import load_config
    from hermes_cli.skills_config import get_disabled_skills
    from hermes_cli.web_routers.skills import get_skills
    from hermes_cli.web_server_profiles import _profile_scope
    try:
        listed = asyncio.run(get_skills(profile=bot))
        with _profile_scope(bot):
            config = load_config()
    except Exception:
        raise _hermes_error() from None
    section = config.get('skills') if isinstance(config.get('skills'), dict) else {}
    keys = section.get('platform_disabled') if isinstance(section.get('platform_disabled'), dict) else {}
    named = sorted(k for k in keys if isinstance(k, str) and k != 'api_server' and PLATFORM.fullmatch(k))[:PLATFORMS_MAX]
    odd = [k for k in keys if k != 'api_server' and k not in named]                  # not a name (a token, a path, too many): never shown, only counted as `other`
    platforms = ['api_server'] + named + (['other'] if odd and 'other' not in named else [])
    off = {platform: get_disabled_skills(config, platform) for platform in ['api_server'] + named}
    if 'other' in platforms and 'other' not in named:
        off['other'] = set().union(*(get_disabled_skills(config, k) for k in odd if isinstance(k, str)))   # off in ANY of them: never claims `on` for a skill one of them turns off
    entries = {}
    for skill in listed:
        name = skill.get('name')
        if not isinstance(name, str):
            continue
        enabled = {'all': bool(skill.get('enabled')), **{p: name not in off[p] for p in platforms}}
        states = set(enabled.values())
        entries[name] = {**skill, 'enabled': enabled, 'essential': name in ESSENTIAL_SKILLS,
                         'state': 'on' if states == {True} else 'off' if states == {False} else 'partial'}
    return platforms, entries


def view(entry, redact):
    name = redact(entry['name'])
    usage = entry.get('usage')
    return {'name': name, 'description': redact(str(entry.get('description') or ''))[:DESCRIPTION_MAX],
            'category': redact(str(entry['category'])) if entry.get('category') else None,
            'provenance': entry.get('provenance') if entry.get('provenance') in ('hub', 'bundled', 'agent') else 'agent',
            'usage': usage if type(usage) is int and usage >= 0 else 0, 'essential': entry['essential'],
            'enabled': entry['enabled'], 'state': entry['state'],
            'toggle': bool(SKILL_NAME.fullmatch(entry['name'])) and name == entry['name'] and not entry['essential']}


def bot_skills(bot, redact):
    """2.1 GET /bots/{bot}/skills."""
    platforms, entries = _read(bot)
    return {'bot': bot, 'platforms': platforms, 'skills': [view(entries[n], redact) for n in sorted(entries)], 'notes': NOTES}


def matrix(bots, redact):
    """2.2 GET /skills/matrix: every Bot x every skill seen in any of them; an unreadable Bot is a row with `error`, never guessed."""
    rows, seen, states = [], {}, {}
    for bot in bots[:MATRIX_BOTS]:
        try:
            _platforms, entries = _read(bot)
        except PluginError:
            rows.append({'bot': bot, 'error': 'unreadable'})
            continue
        rows.append({'bot': bot})
        for name, entry in entries.items():
            shown = view(entry, redact)
            seen.setdefault(shown['name'], shown['provenance'])
            states[(bot, shown['name'])] = entry['state']
    skills = sorted(seen)[:MATRIX_SKILLS]
    truncated = {'bots': len(bots) > MATRIX_BOTS, 'skills': len(seen) > MATRIX_SKILLS}  # F6: the matrix says when it cut, never looks complete by silence
    cells = [{'bot': row['bot'], 'skill': name, 'state': states.get((row['bot'], name), 'absent')}
             for row in rows if 'error' not in row for name in skills]
    return {'bots': rows, 'skills': [{'name': name, 'provenance': seen[name]} for name in skills], 'cells': cells, 'truncated': truncated}


def _entry(bot, skill):
    if not isinstance(skill, str) or not SKILL_NAME.fullmatch(skill):
        raise not_found()
    platforms, entries = _read(bot)
    if skill not in entries:
        raise not_found()
    return platforms, entries[skill]


def validate_toggle(body):
    """{"enabled": true | false}, nothing else."""
    if not isinstance(body, dict) or set(body) != {'enabled'} or type(body['enabled']) is not bool:
        raise PluginError('bad_request', 'Send {"enabled": true} or {"enabled": false}.', 400)
    return body['enabled']


def toggle(audit, actor, bot, skill, enabled, origin_ref, redact):
    """2.3: 404 and 409 from the read BEFORE the audit (Hermes's toggle does not check that the skill exists); audited first;
    Hermes's own toggle_skill in the Bot's profile; re-read, and `enabled.all` must be what was asked, else 502 (the audit result
    says error). Loopback rules (enable needs a person) are the route's."""
    _platforms, entry = _entry(bot, skill)
    if entry['essential'] and not enabled:
        raise PluginError('skill_essential', 'Hermes keeps this skill on in every Bot; it cannot be turned off.', 409)

    def effect():
        from hermes_cli.web_models import SkillToggle
        from hermes_cli.web_routers.skills import toggle_skill
        try:
            asyncio.run(toggle_skill(SkillToggle(name=skill, enabled=enabled, profile=bot), profile=bot))
        except Exception as error:
            if hermes_boundary.config_write_refusal(error) is not None:
                raise  # `skills.disabled` locked above, a value Hermes cannot store: SafeRoute says which (409/422/502), in our words
            raise _hermes_error() from None
        platforms, after = _entry(bot, skill)
        if after['enabled']['all'] is not enabled:
            raise _hermes_error()
        return platforms, after
    platforms, after = audit.act(actor, 'skill.enable' if enabled else 'skill.disable', f'{bot}:{skill}', {'kind': 'ui', 'ref': origin_ref},
                                 effect, bot=bot, payload={'enabled': enabled})
    return {'skill': view(after, redact), 'notice': 'on_applies_to_new_conversations' if enabled else None,
            'still_off_on': [p for p in platforms if not after['enabled'][p]] if enabled else []}


def content(bot, skill, redact):
    """2.4: SKILL.md through Hermes's reader in the Bot's profile, redacted BEFORE it is cut at 256 KiB; never the path. `digest` is of the REAL text and `editable` is true only for a skill of
    `provenance: agent` that the person is shown whole and unchanged (a text the redactor changes, or that was cut, is read-only: the editor never writes back a text it did not fully show; v0.11 3.3)."""
    _platforms, entry = _entry(bot, skill)
    from hermes_cli.web_routers.skills import get_skill_content
    try:
        found = asyncio.run(get_skill_content(name=skill, profile=bot))
    except Exception as error:
        if getattr(error, 'status_code', None) == 404:
            raise not_found() from None
        raise _hermes_error() from None
    text = found.get('content') if isinstance(found, dict) else None
    if not isinstance(text, str):
        raise _hermes_error()
    shown = redact(text)
    raw = shown.encode('utf-8')
    cut = raw[:CONTENT_MAX].decode('utf-8', 'ignore')
    redacted, truncated = shown != text, len(raw) > CONTENT_MAX
    return {'name': redact(skill), 'content': cut, 'redacted': redacted, 'truncated': truncated, 'digest': digest(text),
            'editable': entry.get('provenance') == 'agent' and not redacted and not truncated}
