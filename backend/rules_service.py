"""The rules API's service layer (contract v0.1 section 3; ADR-002 sections 4, 7, 8; D-012).

Pure of Hermes: the live state, the expansion maps and the human `Actor` come in as arguments, the engine (`rules.py`) decides
every lifecycle step and every seal, and storage is `rules_store` + the hook tables of `hook_store`. Four rules this module owns:

* E  a stored ACTIVE rule counts only if the audit log holds the human activation of exactly that content (`verified_active`);
     a row someone edited or inserted by hand is ignored, listed as broken, and never reaches the engine or the hook table.
* RT 6  an agent's proposal is a SUGGESTION whatever the request says; it must be reviewed into a draft and activated by a human.
* RT 8  a seal is computed from the live state at every read (`seal_for`), never stored, never inferred from the level.
* the hook table of a Bot is recompiled from builtins + verified active rules when a rule is activated or archived.
"""
import hashlib
import json
import time
import uuid

import sqlite3
from . import hook_store, rules, rules_store
from .api_errors import PluginError
from .audit import ActionDenied

MAX_ITEMS, MAX_TEXT = 50, 512


class RuleRefused(PluginError, ActionDenied):
    """A lifecycle step refused by a check: recorded as denied in the audit, answered with the contract error."""


def _bad(message='Invalid request body.', code='bad_request', status=400):
    return PluginError(code, message, status)


# --------------------------------------------------------------------------------------------------------------------
# E: activation bound to the audit log
# --------------------------------------------------------------------------------------------------------------------
def activation_payload(rule):
    """What the activation's audit row digests: the rule exactly as it becomes ACTIVE (state, version, updated_by included)."""
    return rules_store.rule_to_dict(rule)


def _digest(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()


def verify_activation(path, rule):
    """True when the audit log has a SUCCESSFUL `rule.activate` whose digest is this very content. The audit store is
    append-only and hash-chained; it is tamper-evident, not tamper-proof (threat model R4)."""
    conn = hook_store.connect(path)
    try:
        return conn.execute("SELECT 1 FROM audit_log WHERE action='rule.activate' AND target=? AND digest=? AND outcome='ok' AND detail='result' LIMIT 1",
                            (rule.id, _digest(activation_payload(rule)))).fetchone() is not None
    except sqlite3.OperationalError:
        return False  # no audit table, no activation
    finally:
        conn.close()


def stored_rules(path):
    """Every stored rule, oldest first, with whether an ACTIVE one is trusted: [(rule, trusted)]."""
    out = []
    for rule in rules_store.load(path):
        trusted = True if rule.state is not rules.RuleState.ACTIVE else verify_activation(path, rule)
        out.append((rule, trusted))
    return out


def verified_active(path):
    return [r for r, trusted in stored_rules(path) if r.state is rules.RuleState.ACTIVE and trusted]


def effective_rules(path, bot=None):
    """Built-ins + the human-activated stored rules that can apply to `bot` (all Bots when None). Drafts, suggestions,
    archived and unverified rows are not here."""
    chosen = [r for r in verified_active(path) if bot is None or applies_to(r, bot)]
    return [*rules.builtin_rules(), *chosen]


def applies_to(rule, bot):
    """Room and routine rules cannot be told apart by the hook, so they apply to every Bot (widened, and reported as such)."""
    return rule.scope.kind is not rules.ScopeKind.BOT or rule.scope.ref == bot


# --------------------------------------------------------------------------------------------------------------------
# the hook table of a Bot
# --------------------------------------------------------------------------------------------------------------------
def compile_for(path, bot, toolset_tools, mcp_server_tools):
    current = hook_store.read_table(path, bot)
    version = 1
    if current:
        try:
            version = rules.HookTable.from_json(current[1]).version
        except rules.RuleError:
            version = 1
    table = rules.compile_hook_table(effective_rules(path, bot), version=version, toolset_tools=toolset_tools, mcp_server_tools=mcp_server_tools)
    if current and current[0] == table.digest:
        return table
    return rules.HookTable(version + 1 if current else 1, table.digest, table.entries, table.problems)


def apply_table(path, bot, toolset_tools, mcp_server_tools):
    """Compile and store the Bot's table; the hook in the gateway reads it on its next call (no restart)."""
    table = compile_for(path, bot, toolset_tools, mcp_server_tools)
    stored = hook_store.read_table(path, bot)
    if not stored or stored[0] != table.digest:
        hook_store.put_table(path, bot, table)
    return table


# --------------------------------------------------------------------------------------------------------------------
# seals (RT 8)
# --------------------------------------------------------------------------------------------------------------------
def loaded_table(path, bot, state):
    """The table the hook says it runs (heartbeat digest), if it is the one we stored; otherwise unknown."""
    stored = hook_store.read_table(path, bot)
    if stored and state.hook.table_digest == stored[0]:
        try:
            return rules.HookTable.from_json(stored[1])
        except rules.RuleError:
            return None
    return None


def seal_for(path, rule, bot, state, *, now=None):
    """The live seal of `rule` on `bot`: the engine's, fed with the real state, the digest we expect and the ids / problems of
    the table the hook really loaded. Nothing about it is read from the rule's level or from anything stored."""
    now = time.time() if now is None else now
    stored = hook_store.read_table(path, bot)
    expected = stored[0] if stored else rules.compile_hook_table(rules.builtin_rules(), version=1, toolset_tools={}, mcp_server_tools={}).digest
    table = loaded_table(path, bot, state)
    return rules.compute_seal(rule, state, expected_hook_digest=expected, now=now,
                              hook_rule_ids=None if table is None else frozenset(e.rule_id for e in table.entries),
                              hook_problems=() if table is None else table.problems)


def aggregate(per_bot):
    """One SealResult for a rule that applies to several Bots: BROKEN if any Bot's is, otherwise the common seal. Problem
    details are prefixed with the Bot so the UI can say where."""
    if not per_bot:
        return rules.SealResult(rules.Seal.NONE, (), (), ())
    broken = {b: s for b, s in per_bot.items() if s.seal is rules.Seal.BROKEN}
    if len(per_bot) == 1 and not broken:
        return next(iter(per_bot.values()))
    problems = tuple(sorted({rules.Problem(p.code, f'{b}: {p.detail}') for b, s in per_bot.items() for p in s.problems},
                            key=lambda p: (p.code, p.detail)))
    seals = {s.seal for s in per_bot.values()}
    if broken:
        seal = rules.Seal.BROKEN
    elif len(seals) == 1:
        seal = next(iter(seals))
    else:
        seal, problems = rules.Seal.BROKEN, problems + (rules.Problem('no_mechanism', 'the Bots disagree on this rule\'s seal'),)
    merged = {}
    for s in per_bot.values():
        for m in s.mechanisms:
            old = merged.get(m.id)
            merged[m.id] = rules.Mechanism(m.id, m.verified and (old.verified if old else True), tuple(sorted(set(m.covers) | (set(old.covers) if old else set()))))
    quals = tuple(sorted({q for s in per_bot.values() for q in s.qualifiers}))
    return rules.SealResult(seal, tuple(sorted(merged.values(), key=lambda m: m.id.value)), problems, quals)


def untrusted_seal():
    return rules.SealResult(rules.Seal.BROKEN, (), (rules.Problem('activation_unverified', 'no human activation of exactly this content is on the audit log'),), ())


# --------------------------------------------------------------------------------------------------------------------
# JSON
# --------------------------------------------------------------------------------------------------------------------
def seal_to_dict(result):
    return {'seal': result.seal.value, 'mechanisms': [{'id': m.id.value, 'verified': m.verified, 'covers': list(m.covers)} for m in result.mechanisms],
            'problems': [{'code': p.code, 'detail': p.detail} for p in result.problems], 'qualifiers': list(result.qualifiers)}


def decision_to_dict(decision):
    return {'effect': decision.effect.value, 'winner': decision.winner, 'reason': decision.reason.value,
            'hits': [{'rule_id': h.rule_id, 'level': h.level.value, 'scope': {'kind': h.scope.kind.value, 'ref': h.scope.ref},
                      'builtin': h.builtin, 'matched_on': list(h.matched_on)} for h in decision.hits]}


# --------------------------------------------------------------------------------------------------------------------
# request bodies (pure)
# --------------------------------------------------------------------------------------------------------------------
def _strings(value, field):
    if value is None:
        return ()
    if not isinstance(value, list) or len(value) > MAX_ITEMS or not all(isinstance(v, str) and 0 < len(v) <= MAX_TEXT for v in value):
        raise _bad(f'{field} must be a list of up to {MAX_ITEMS} short texts.')
    return tuple(value)


def _conditions(value):
    if value is None:
        return ()
    pairs = list(value.items()) if isinstance(value, dict) else value
    if not isinstance(pairs, list) or len(pairs) > MAX_ITEMS:
        raise _bad('conditions must be an object or a list of [fact, value] pairs.')
    out = []
    for pair in pairs:
        if not (isinstance(pair, (list, tuple)) and len(pair) == 2 and all(isinstance(x, str) and 0 < len(x) <= MAX_TEXT for x in pair)):
            raise _bad('conditions must be an object or a list of [fact, value] pairs.')
        out.append((pair[0], pair[1]))
    return tuple(out)


def parse_match(value):
    if not isinstance(value, dict) or set(value) - {'tools', 'toolsets', 'mcp_servers', 'commands', 'conditions'}:
        raise _bad('match holds only tools, toolsets, mcp_servers, commands and conditions.')
    return rules.Match(tools=_strings(value.get('tools'), 'tools'), toolsets=_strings(value.get('toolsets'), 'toolsets'),
                       mcp_servers=_strings(value.get('mcp_servers'), 'mcp_servers'), commands=_strings(value.get('commands'), 'commands'),
                       conditions=_conditions(value.get('conditions')))


def parse_scope(value):
    if not isinstance(value, dict) or set(value) - {'kind', 'ref'}:
        raise _bad('scope holds kind and ref.')
    try:
        kind = rules.ScopeKind(value.get('kind'))
    except ValueError:
        raise _bad('Unknown scope kind.') from None
    ref = value.get('ref')
    if ref is not None and (not isinstance(ref, str) or not 0 < len(ref) <= 128):
        raise _bad('scope.ref must be a short text.')
    return rules.Scope(kind, ref)


def parse_level(value):
    try:
        return rules.Level(value)
    except ValueError:
        raise _bad('Unknown level.') from None


def _label(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 120:
        raise _bad('label must be 1 to 120 characters.')
    return value.strip()


def validate_create(body):
    allowed = {'label', 'level', 'scope', 'match', 'suggested_by_bot'}
    if not isinstance(body, dict) or set(body) - allowed or not {'label', 'level', 'scope', 'match'} <= set(body):
        raise _bad('A rule needs label, level, scope and match; state, origin and ids belong to the server.')
    out = {'label': _label(body['label']), 'level': parse_level(body['level']), 'scope': parse_scope(body['scope']), 'match': parse_match(body['match'])}
    suggested = body.get('suggested_by_bot')
    if suggested is not None and (not isinstance(suggested, str) or not 0 < len(suggested) <= 64):
        raise _bad('suggested_by_bot must be a Bot name.')
    out['suggested_by_bot'] = suggested
    return out


def validate_patch(body):
    allowed = {'id', 'version', 'state', 'label', 'level', 'scope', 'match', 'accept_unapplied'}
    if not isinstance(body, dict) or set(body) - allowed or not isinstance(body.get('id'), str) or isinstance(body.get('version'), bool) \
            or not isinstance(body.get('version'), int) or body['version'] < 1:
        raise _bad('A change needs the rule id and the version you saw.')
    edits = {k: body[k] for k in ('label', 'level', 'scope', 'match') if k in body}
    if 'state' in body and edits:
        raise _bad('Change the state or edit the fields, not both at once.')
    if 'state' in body and body['state'] not in ('draft', 'active', 'archived'):
        raise _bad('state must be draft, active or archived.')
    if not edits and 'state' not in body:
        raise _bad('Nothing to change.')
    if 'accept_unapplied' in body and not isinstance(body['accept_unapplied'], bool):
        raise _bad('accept_unapplied must be true or false.')
    parsed = {}
    if 'label' in edits:
        parsed['label'] = _label(edits['label'])
    if 'level' in edits:
        parsed['level'] = parse_level(edits['level'])
    if 'scope' in edits:
        parsed['scope'] = parse_scope(edits['scope'])
    if 'match' in edits:
        parsed['match'] = parse_match(edits['match'])
    return {'id': body['id'], 'version': body['version'], 'state': body.get('state'), 'edits': parsed,
            'accept_unapplied': bool(body.get('accept_unapplied'))}


def parse_action(body):
    allowed = {'bot', 'tool', 'toolset', 'mcp_server', 'command', 'room', 'routine', 'facts'}
    if not isinstance(body, dict) or set(body) - allowed or not isinstance(body.get('bot'), str) or not isinstance(body.get('tool'), str):
        raise _bad('An action needs bot and tool.')
    for key in allowed - {'facts'}:
        if key in body and body[key] is not None and (not isinstance(body[key], str) or len(body[key]) > 8192):
            raise _bad(f'{key} must be a text.')
    return rules.Action(bot=body['bot'], tool=body['tool'][:256], toolset=body.get('toolset'), mcp_server=body.get('mcp_server'),
                        command=body.get('command'), room=body.get('room'), routine=body.get('routine'), facts=_conditions(body.get('facts')))


# --------------------------------------------------------------------------------------------------------------------
# lifecycle (human steps run inside the route's audit.act; the engine decides each transition)
# --------------------------------------------------------------------------------------------------------------------
def new_rule_id():
    return 'r-' + uuid.uuid4().hex[:12]


def create(path, actor, fields, rule_id):
    """A human creates a DRAFT; an agent's proposal (suggested_by_bot) is a SUGGESTION whatever else the request says (RT 6)."""
    if fields['suggested_by_bot']:
        rule = rules.propose_from_agent(fields['label'], fields['level'], fields['scope'], fields['match'], bot=fields['suggested_by_bot'], rule_id=rule_id)
    else:
        rule = rules.Rule(id=rule_id, label=fields['label'], level=fields['level'], scope=fields['scope'], match=fields['match'],
                          state=rules.RuleState.DRAFT, origin=rules.Origin.HUMAN, builtin=False, version=1, updated_by=actor.id)
    problems = rules.validate_rule(rule)
    if problems:
        raise PluginError('invalid_field', 'This rule is not valid: ' + ', '.join(sorted({p.code for p in problems})) + '.', 422)
    rules_store.save(path, rule, bot=rule.scope.ref if rule.scope.kind is rules.ScopeKind.BOT else None)
    return rule


def get_rule(path, rule_id):
    for rule in rules_store.load(path):
        if rule.id == rule_id:
            return rule
    for rule in rules.builtin_rules():
        if rule.id == rule_id:
            return rule
    raise PluginError('rule_not_found', 'Rule not found.', 404)


def _fresh(rule, version):
    if rule.version != version:
        raise RuleRefused('stale', 'This rule changed since you loaded it; reload before changing it.', 409)


def _refusal(error):
    codes = {'human_required': 403, 'not_a_draft': 409, 'builtin_immutable': 409, 'not_a_suggestion': 409, 'stale_version': 409, 'invalid_rule': 422}
    code = error.args[0] if error.args else 'bad_request'
    return RuleRefused(code, {'human_required': 'Only a signed-in person can do this.', 'not_a_draft': 'Only a reviewed draft can be activated.',
                              'builtin_immutable': 'Built-in rules cannot be changed.', 'not_a_suggestion': 'Only a suggestion can be reviewed.',
                              'stale_version': 'This rule changed since you loaded it.', 'invalid_rule': 'This rule is not valid yet.'}.get(code, 'Refused.'),
                       codes.get(code, 400))


def review(path, actor, rule_id, version):
    rule = get_rule(path, rule_id)
    _fresh(rule, version)
    try:
        draft = rules.draft_from_suggestion(rule, actor=actor)
    except rules.RuleError as error:
        raise _refusal(error) from None
    rules_store.save(path, draft, bot=draft.scope.ref if draft.scope.kind is rules.ScopeKind.BOT else None)
    return draft


def edit(path, actor, rule_id, version, edits):
    rule = get_rule(path, rule_id)
    _fresh(rule, version)
    if rule.builtin:
        raise RuleRefused('builtin_immutable', 'Built-in rules cannot be changed.', 409)
    if rule.state is not rules.RuleState.DRAFT:
        raise RuleRefused('not_a_draft', 'Only a draft can be edited; archive this rule and create another.', 409)
    edited = rules.replace(rule, version=rule.version + 1, updated_by=actor.id, **edits)
    problems = rules.validate_rule(edited)
    if problems:
        raise PluginError('invalid_field', 'This rule is not valid: ' + ', '.join(sorted({p.code for p in problems})) + '.', 422)
    rules_store.save(path, edited, bot=edited.scope.ref if edited.scope.kind is rules.ScopeKind.BOT else None)
    return edited


def archive(path, actor, rule_id, version):
    """-> (archived rule, was_active). Archiving a built-in or by a non-human is refused by the engine."""
    rule = get_rule(path, rule_id)
    _fresh(rule, version)
    try:
        done = rules.archive(rule, actor=actor)
    except rules.RuleError as error:
        raise _refusal(error) from None
    rules_store.save(path, done, bot=done.scope.ref if done.scope.kind is rules.ScopeKind.BOT else None)
    return done, rule.state is rules.RuleState.ACTIVE


def plan_activation(path, actor, rule_id, version, *, applied=()):
    """The rule exactly as it will be once a human activated it (pure, nothing saved): its payload is what the route puts on the
    audit row BEFORE the effect, so the row's digest binds the activation to this content. -> (active rule, draft it came from)."""
    rule = get_rule(path, rule_id)
    _fresh(rule, version)
    try:
        active = rules.activate(rule, actor=actor, now_version=rule.version + 1)
    except rules.RuleError as error:
        raise _refusal(error) from None
    return rules.replace(active, applied=tuple(applied)), rule


def commit_activation(path, active):
    rules_store.save(path, active, bot=active.scope.ref if active.scope.kind is rules.ScopeKind.BOT else None)
