"""RX-1 (docs/contracts/voice-language-reactions-v0.md section 4, A-282, A-283): `reactions.with_announcements` (the Bot is told), `reactions.set_bot_sees` and `reactions.bot_sees` (the per-Bot switch), and the two sends that carry the notes.

The attack is the Lume's (test_redteam_reactions_announce.py and test_redteam_reactions_switch.py: each runs on a MODEL of the contract and on the real code). This file proves the guards of the CODE are held by those proofs: backend/reactions.py (or the
route source) with ONE defect each; the Lume's test that names the defect, run against it, must fail, and the same test against the code without the defect must pass. Then what her tests do not reach: the wiring of the two sends."""
import inspect
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import test_reactions as base  # noqa: E402  (the loader of a reactions.py with one defect, and the reader of plugin_api.py)
import test_redteam_reactions_announce as announce  # noqa: E402
import test_redteam_reactions_switch as switch  # noqa: E402

BACKEND = base.BACKEND
RED = (Exception, pytest.fail.Exception)        # a failed assertion, a `DID NOT RAISE` of the Lume's, or the defect itself raising


def run(module, name, variant, folder, monkeypatch, **extra):
    """One of the Lume's tests, written against `reactions`, run against `variant`: the fixtures it names, built here."""
    variant.PluginError = switch.PluginError                         # the variant is a copy of the package: its refusals must be the class the route and the tests catch
    monkeypatch.setattr(module, 'reactions', variant)
    folder.mkdir()
    function = getattr(module, name)
    wanted = inspect.signature(function).parameters
    given = {'tmp_path': folder, 'monkeypatch': monkeypatch}
    if module is announce:
        given.update(leg=announce.Real(), env=announce.Env(monkeypatch))
    else:
        given.update(leg=switch.Route(), env=switch.Env(folder, monkeypatch))
    function(**{key: value for key, value in {**given, **extra}.items() if key in wanted})


A, S = announce, switch
OFF0 = {'config': announce.OFF[0]}
T = {
    'switch': (A, 'test_with_the_switch_off_nothing_is_announced_and_hermes_is_never_asked', OFF0),
    'unreadable': (A, 'test_a_configuration_that_cannot_be_read_is_off_not_on_and_does_not_stop_the_send', {}),
    'cap': (A, 'test_never_more_than_five_notes_the_oldest_first_and_the_rest_wait_for_the_next_turns', {}),
    'outside': (A, 'test_a_set_mark_is_announced_next_to_an_outside_one_and_only_the_set_one', {}),
    'neutral': (A, 'test_a_hostile_message_is_one_note_that_closes_once_and_is_never_an_instruction_shape', {'content': announce.HOSTILE[0], 'role': 'assistant'}),
    'cut': (A, 'test_the_snippet_is_cut_at_120_characters_with_one_ellipsis_exactly_as_hermes_does', {}),
    'whole': (A, 'test_a_key_in_the_message_never_reaches_the_note_even_when_the_cut_would_split_it', {'role': 'assistant'}),
    'empty': (A, 'test_a_message_with_nothing_to_quote_says_earlier_message_and_never_an_empty_quote', {'content': ''}),
    'whose': (A, 'test_a_mark_on_the_persons_own_message_says_their_own_and_on_the_bots_says_your', {}),
    'audit': (A, 'test_the_audit_of_the_send_holds_the_count_and_never_the_text_the_snippet_or_the_emoji', {}),
    'failed': (A, 'test_a_send_that_fails_after_the_read_announces_again_next_time_and_keeps_the_persons_marks', {'error': announce.FAILURES[2]}),
    'current': (A, 'test_a_failure_does_not_bring_back_what_the_person_replaced_meanwhile', {}),
    'retry': (A, 'test_a_set_that_fails_once_after_the_clear_is_tried_again_and_the_mark_is_back', {}),
    'count': (A, 'test_a_set_that_fails_twice_is_counted_as_rearm_failed_hides_nothing_and_stops_no_other_reaction', {}),
    'locked': (A, 'test_a_locked_store_never_stops_the_send_and_consumes_nothing', {}),
    'order': (A, 'test_the_text_of_the_person_is_sent_unchanged_at_the_end_with_or_without_notes', {'text': 'oi'}),
    'profile': (A, 'test_the_switch_and_the_marks_are_the_bots_own_and_the_default_profile_never_answers_for_it', {}),
    'body': (S, 'test_an_object_that_is_not_exactly_the_one_key_is_422_and_nothing_else_of_the_configuration_can_be_sent', {'what': 'extra key'}),
    'boolean': (S, 'test_a_value_that_is_not_the_boolean_is_422_and_nothing_reaches_hermes_the_audit_or_the_answer', {'value': 1}),
    'write_profile': (S, 'test_the_write_names_the_bots_profile_and_never_the_default_one', {}),
    'audit_first': (S, 'test_the_audit_row_is_written_before_hermes_is_asked_and_holds_the_two_booleans_and_never_the_raw_value', {}),
    'kept': (S, 'test_a_value_hermes_did_not_keep_is_a_502_and_never_a_claimed_success', {}),
    'text': (S, 'test_a_write_hermes_refuses_is_a_502_with_none_of_its_text_the_config_unchanged_and_never_audited_as_done', {}),
    'absent': (S, 'test_the_object_is_absent_and_never_on_when_the_state_cannot_be_told', {}),
    'state': (S, 'test_the_state_is_the_boolean_only_an_unset_or_odd_key_reads_off_never_on', {'display': {'message_reactions': 'no'}, 'expected': False}),
    'loopback': (S, 'test_the_loopback_credential_is_no_person_and_is_refused', {}),
    'csrf': (S, 'test_without_the_csrf_header_the_answer_is_403_before_the_body_the_bot_and_any_effect', {}),
    'read': (S, 'test_the_state_read_after_a_write_is_the_state_written', {}),
}
OFF_ANCHOR = "    if not enabled(bot):\n        return send(text)\n"
MUTATIONS = [
    ('the switch is not read', 'switch', OFF_ANCHOR, ''),
    ('an unreadable configuration is on', 'unreadable', "    except Exception:  # noqa: BLE001  (an unreadable configuration is off, and Hermes is then never asked: asking consumes)\n        return False", "    except Exception:  # noqa: BLE001\n        return True"),
    ('the cap of five is gone', 'cap', "    now, later = shown[:NOTES_MAX], shown[NOTES_MAX:]", "    now, later = shown, []"),
    ('the rest is left marked as seen', 'cap', "    if later:\n        rearm(bot, later)\n", ""),
    ('an emoji outside the set is announced', 'outside', "entry['emoji'] in EMOJIS and type(entry.get('row_id')) is int", "type(entry.get('row_id')) is int"),
    ('the snippet is not neutralised', 'neutral', "    return out.strip()", "    return text.strip()"),
    ('the snippet is cut at 121', 'cut', "NOTES_MAX, SNIPPET_MAX, ELLIPSIS = 5, 120,", "NOTES_MAX, SNIPPET_MAX, ELLIPSIS = 5, 121,"),
    ('the message is cut before it is redacted', 'whole', "neutral(redact(text) if isinstance(text, str) and text else '')", "neutral(redact(text[:SNIPPET_MAX]) if isinstance(text, str) and text else '')"),
    ('an empty snippet is an empty quote', 'empty', "'message: \"%s\"' % snippet if snippet else 'earlier message'", "'message: \"%s\"' % snippet"),
    ('their own and your are swapped', 'whose', "'their own' if entry.get('role') == 'user' else 'your'", "'your' if entry.get('role') == 'user' else 'their own'"),
    ('the notes come after the text', 'order', "    return '\\n'.join(notes) + '\\n\\n' + text if notes else text", "    return text + '\\n\\n' + '\\n'.join(notes) if notes else text"),
    ('the audit has the snippet', 'audit', "payload={'notes': len(now)})", "payload={'notes': len(now), 'first': note(now[0], redact)})"),
    ('a failed send does not put the reactions back', 'failed', "        failed = rearm(bot, now)\n", "        failed = 0\n"),
    ('the error of the send is swallowed', 'failed', "                pass\n        raise\n", "                pass\n        return None\n"),
    ('a failure puts back a mark that is no longer the person\'s', 'current', "if not (mine and mine.get('emoji') == entry['emoji'] and mine.get('seen')):", "if not mine:"),
    ('a set that fails is not tried again', 'retry', "                for attempt in range(2):\n                    try:\n                        db.set_message_reaction(session, entry['row_id'], entry['emoji'], author='user')", "                for attempt in range(1):\n                    try:\n                        db.set_message_reaction(session, entry['row_id'], entry['emoji'], author='user')"),
    ('a mark that could not be put back is not counted', 'count', "                        failed += attempt", "                        failed += 0"),
    ('a read that fails stops the send', 'locked', "    except Exception:  # noqa: BLE001  (a locked store, or the second conversation", "    except ZeroDivisionError:  # noqa: BLE001  (a locked store, or the second conversation"),
    ('the default profile answers for a Bot', 'profile', "    return HermesAudio.config(bot)        #", "    return HermesAudio.config('default')        #"),
    ('a second key is accepted', 'body', "    if set(body) != {'enabled'} or type(body['enabled']) is not bool:", "    if 'enabled' not in body or type(body['enabled']) is not bool:"),
    ('a number is a boolean', 'boolean', "type(body['enabled']) is not bool:", "not isinstance(body['enabled'], (bool, int)):"),
    ('the write names no profile', 'write_profile', "HermesAudio.write_config(bot, {'display': {'message_reactions': enabled_}})", "HermesAudio.write_config(None, {'display': {'message_reactions': enabled_}})"),
    ('the audit is after the write', 'audit_first', "    audit.act(actor, 'reactions.bot_sees', bot, {'kind': 'ui', 'ref': ref}, effect, bot=bot, payload={'before': before, 'after': enabled_})", "    effect()\n    audit.act(actor, 'reactions.bot_sees', bot, {'kind': 'ui', 'ref': ref}, lambda: None, bot=bot, payload={'before': before, 'after': enabled_})"),
    ('the value is not read back', 'kept', "        if kept != enabled_:", "        if False:"),
    ('Hermes\'s text is forwarded', 'text', "            raise PluginError('hermes_error', 'Hermes could not change this setting.', 502) from None\n        try:\n            kept", "            raise PluginError('hermes_error', str(error), 502) from None\n        try:\n            kept"),
    ('before is the raw value', 'audit_first', "        before = is_on(_hermes_config(bot))\n    except Exception:  # noqa: BLE001\n        raise PluginError('hermes_error', 'Hermes could not read this setting.', 502) from None", "        before = _hermes_config(bot).get('display', {}).get('message_reactions')\n    except Exception:  # noqa: BLE001\n        raise PluginError('hermes_error', 'Hermes could not read this setting.', 502) from None"),
    ('the state is shown for a Hermes that cannot announce', 'absent', "    if not announces():\n        return None\n", ""),
    ('an unreadable configuration reads on', 'absent', "        return {'bot_sees': is_on(_hermes_config(bot))}\n    except Exception:  # noqa: BLE001\n        return None", "        return {'bot_sees': is_on(_hermes_config(bot))}\n    except Exception:  # noqa: BLE001\n        return {'bot_sees': True}"),
    ('a truthy value is on', 'state', "isinstance(display, dict) and display.get('message_reactions') is True", "isinstance(display, dict) and bool(display.get('message_reactions'))"),
]
ROUTE_MUTATIONS = [
    ('the person gate is the identity only', 'loopback', "    human = _human(request)\n    name = await _existing(bot)\n    enabled = reactions.switch_body", "    actor, credential, _mode = _identity(request)\n    human = type('H', (), {'id': actor})()\n    name = await _existing(bot)\n    enabled = reactions.switch_body"),
    ('the CSRF header is not asked', 'csrf', "    human = _human(request)\n    name = await _existing(bot)\n    enabled = reactions.switch_body", "    actor, credential, mode = _identity(request)\n    identity.require_person(mode, 'x', loopback_ok=False)\n    human = type('H', (), {'id': actor})()\n    name = await _existing(bot)\n    enabled = reactions.switch_body"),
    ('the body is not checked', 'body', "    enabled = reactions.switch_body(await _json_body(request))", "    enabled = (await _json_body(request)).get('enabled')"),
    ('the read leaves the state out', 'read', "    return {**detail, **({'reactions': state} if state is not None else {})}", "    return detail"),
    ('the read shows on when it cannot tell', 'absent', "    return {**detail, **({'reactions': state} if state is not None else {})}", "    return {**detail, 'reactions': state or {'bot_sees': True}}"),
]


@pytest.mark.parametrize('key', sorted({m[1] for m in MUTATIONS} | {m[1] for m in ROUTE_MUTATIONS}))
def test_the_proof_that_names_a_defect_passes_without_it(tmp_path, monkeypatch, key):
    module, name, extra = T[key]
    run(module, name, base.load(), tmp_path / key, monkeypatch, **extra)


@pytest.mark.parametrize('label,key,old,new', MUTATIONS, ids=[m[0] for m in MUTATIONS])
def test_each_defect_turns_the_proof_that_names_it_red(tmp_path, monkeypatch, label, key, old, new):
    variant = base.load((old, new))                                  # outside pytest.raises: a defect that does not apply is an error
    module, name, extra = T[key]
    with pytest.raises(RED):
        run(module, name, variant, tmp_path / key, monkeypatch, **extra)


@pytest.mark.parametrize('label,key,old,new', ROUTE_MUTATIONS, ids=[m[0] for m in ROUTE_MUTATIONS])
def test_each_defect_of_the_route_turns_the_proof_that_names_it_red(tmp_path, monkeypatch, label, key, old, new):
    assert switch.API.count(old) == 1, label                         # an anchor that moved fails HERE
    monkeypatch.setattr(switch, 'API', switch.API.replace(old, new))
    module, name, extra = T[key]
    with pytest.raises(RED):
        run(module, name, base.load(), tmp_path / key, monkeypatch, **extra)


# ---- the two sends: what the Bot receives, and what is kept of it ---------------------------------------------------------------------------------------------------------
def test_the_sends_carry_the_notes_in_the_body_and_keep_the_digest_of_what_the_person_wrote():
    api = base.api_source()
    run_route, turn = base.function(api, 'create_run'), base.function(api, '_chat_turn')
    assert "_announced(name, session_id, fields['input'], start, audit, actor, new_session)" in run_route
    assert "return reactions.with_announcements(name, session_id, text, send, audit, actor, _REDACT, tip=None if new_session else (lambda: _resume_tip(name, session_id)))" in base.function(api, '_announced')
    assert "body = {**{k: fields[k] for k in ('input', 'instructions') if fields[k] is not None}, 'input': text, 'session_id': session_id}" in run_route, 'the run carries what the wrapper hands it'
    assert "index.prompt_digest(fields['input'])" in run_route and "index.prompt_digest, fields['input']" in turn, 'the digest is the person\'s own text, never the notes'
    assert "{'message': text}" in turn and "{'message': fields['input']}" not in turn
    assert "audit, actor, False)" in turn
    assert "async def put_reactions_bot_sees" in api and "state = await run_in_threadpool(reactions.bot_sees, name)" in base.function(api, 'get_bot')


def test_a_new_conversation_is_not_asked_for_a_resume_tip_and_a_tip_that_cannot_be_found_never_fails_a_send():
    api = base.api_source()
    helper = base.function(api, '_resume_tip')
    assert 'except Exception' in helper and 'return None' in helper and 'bot_controls.owned_session(name, session_id)' in helper


def test_every_other_backend_module_is_unaware_of_reactions_and_the_set_is_in_one_place():
    source = (BACKEND / 'reactions.py').read_text()
    assert source.count('EMOJIS = (') == 1 and 'with_announcements' in source and source.count('ANNOUNCES =') == 1
    for path in BACKEND.glob('*.py'):
        if path.name not in ('reactions.py', 'bot_controls.py'):
            assert 'reaction' not in path.read_text().lower().replace('reactions_', ''), path.name
