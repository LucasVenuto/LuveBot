"""DISPOSABLE spike (T3.0c). A root plugin whose only job is to answer pre_tool_call as /tmp/hook-spike/mode says.

modes: off (no directive) | block | approve | raise | hang. It reads the mode on EVERY call, so the test flips it
without restarting Hermes. Every call is appended to /tmp/hook-spike/calls.jsonl (tool, task/session ids, pid).
"""
import json
import os
import threading
import time

BASE = "/tmp/hook-spike"


def _mode():
    try:
        with open(BASE + "/mode") as stream:
            return stream.read().strip() or "off"
    except OSError:
        return "off"


def pre_tool_call(tool_name, args, task_id="", session_id="", **kwargs):
    mode = _mode()
    command = args.get("command") if isinstance(args, dict) else None
    record = {"t": time.time(), "mode": mode, "tool": tool_name, "command": command, "task_id": task_id,
              "session_id": session_id, "tool_call_id": kwargs.get("tool_call_id", ""),
              "pid": os.getpid(), "thread": threading.current_thread().name, "extra_keys": sorted(kwargs)}
    with open(BASE + "/calls.jsonl", "a") as stream:
        stream.write(json.dumps(record) + "\n")
    if tool_name != "terminal":
        return None
    if mode == "block":
        return {"action": "block", "message": "hook-spike: terminal is blocked by the LuveBot spike rule"}
    if mode == "approve":
        return {"action": "approve", "message": "hook-spike: this terminal call needs a human", "rule_key": "hook-spike:terminal"}
    if mode == "raise":
        raise RuntimeError("hook-spike: deliberate failure inside the hook")
    if mode == "hang":
        time.sleep(120)
    return None


def register(ctx):
    ctx.register_hook("pre_tool_call", pre_tool_call)
