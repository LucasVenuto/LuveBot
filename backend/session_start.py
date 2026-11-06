"""Starting a conversation in the same request as its first message (contract plugin-api v0.9, section 10; perf item 4).

Hermes's `/v1/runs` without a `session_id` keys the run's session by its own `run_id` (api_server_runs.py#L620): not a conversation a person
can reopen. So the id cannot be left out: LuveBot makes the session, AFTER the gates (a refusal leaves nothing behind) and never in place of
one the sender gave. A failure after the session exists leaves one empty conversation, accepted and never deleted by us (a destructive
write on Hermes). The routes in plugin_api.py only wire these two decisions to the audited effect; the decisions live here, testable.
"""
from .api_errors import PluginError
from .hermes_api import safe_id


def for_run(index, bot, key, session_id, gates, create):
    """-> the session id a run should use. `gates()` raises on a refusal; `create()` makes a session and returns its id.
    With an idempotency key and no session of the sender's, the SAME conversation is reused on a repeat, so Hermes sees the same request
    and replays its run (not blocking in the contract: without it the repeat made another session and Hermes refused the key)."""
    gates()
    if session_id is not None:
        return session_id
    again = index.session_for_key(key, bot) if key else None
    if again is not None:
        return again
    made = create()
    return index.remember_session(key, bot, made) if key else made   # two twins: the first stored wins, the other stays an empty conversation


def for_chat(index, client_message_id, gates, create, owns):
    """-> the session id a chat turn without a session should use. A `client_message_id` already claimed is a 409 BEFORE a session is made
    (a look at the index, no write; the claim itself stays atomic in the turn), carrying the first attempt's session so the screen can reopen it:
    only a well-formed id and only while it is still this Bot's (`owns`), or the refusal carries none."""
    gates()
    known = index.claimed_session(client_message_id) if client_message_id else None
    if known is not None:
        raise PluginError('duplicate', 'This message was already sent.', 409, {'details': {'session_id': known}} if safe_id(known) and owns(known) else None)
    return create()
