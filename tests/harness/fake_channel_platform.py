"""A messaging platform for tests (red team gap G15.1), installed as a REAL Hermes platform plugin (`kind: platform`), so the real
`python -m gateway.run` discovers it, builds the adapter through its platform registry and installs its own message handler,
the path every adapter takes. Nothing in Hermes is patched. Written against Hermes's public adapter API
(gateway/platforms/base.py BasePlatformAdapter, the plugin context's register_platform).

Wire to the test: two JSON-lines files named by environment variables. The test appends {"text": ...} to LBFAKE_INBOX; the adapter
appends {"ev": "ready"} once connected and {"ev": "send", "text": ...} for EVERY message the gateway asks it to send or edit, so
the test sees exactly what the person in the chat would see.
"""
import asyncio
import json
import os
import uuid

from gateway.config import Platform
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.platforms.event import MessageEvent, MessageType

PLATFORM_NAME = "lbfake"


class FakeChannelAdapter(BasePlatformAdapter):
    def __init__(self, config):
        super().__init__(config=config, platform=Platform(PLATFORM_NAME))
        self._task = None
        self._seq = 0

    def _emit(self, payload):
        with open(os.environ["LBFAKE_OUTBOX"], "a", encoding="utf-8") as out:
            out.write(json.dumps(payload) + "\n")

    async def _read_inbox(self):
        done = 0
        while True:
            try:
                with open(os.environ["LBFAKE_INBOX"], encoding="utf-8") as inbox:
                    lines = inbox.read().splitlines()
            except FileNotFoundError:
                lines = []
            for line in lines[done:]:
                done += 1
                text = str(json.loads(line).get("text") or "")
                message_id = uuid.uuid4().hex
                source = self.build_source(chat_id="lbfake-chat", chat_name="lbfake-chat", chat_type="dm",
                                           user_id="lbfake-user", user_name="lbfake-user", message_id=message_id)
                await self.handle_message(MessageEvent(text=text, message_type=MessageType.TEXT, source=source, message_id=message_id))
            await asyncio.sleep(0.2)

    async def connect(self, *, is_reconnect=False):
        self._task = asyncio.create_task(self._read_inbox(), name="lbfake-inbox")
        self._mark_connected()
        self._emit({"ev": "ready", "pid": os.getpid()})
        return True

    async def disconnect(self):
        self._mark_disconnected()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        self._seq += 1
        self._emit({"ev": "send", "text": content})
        return SendResult(success=True, message_id=f"lbfake-{self._seq}")

    async def edit_message(self, chat_id, message_id, content, **_kw):
        self._emit({"ev": "send", "text": content, "edit": True})
        return SendResult(success=True, message_id=message_id)

    async def get_chat_info(self, chat_id):
        return {"name": chat_id, "type": "dm"}


def register(ctx):
    ctx.register_platform(name=PLATFORM_NAME, label="LuveBot test channel", adapter_factory=FakeChannelAdapter,
                          check_fn=lambda: True, validate_config=lambda _cfg: True, is_connected=lambda _cfg: True,
                          allow_all_env="LBFAKE_ALLOW_ALL_USERS")
