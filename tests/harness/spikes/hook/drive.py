"""Inside the container: measure what pre_tool_call really does on the API Server surfaces (T3.0c). Writes
/tmp/hook-spike/evidence.json and prints a table. Nothing here is LuveBot product code."""
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

BASE = Path("/tmp/hook-spike")
CREDS = json.loads((BASE / "creds.json").read_text())
PROFILE = {"name": "vendas"}
TERMINAL = {"run.completed", "run.failed", "run.cancelled", "done"}


def request(method, path, body=None, timeout=60):
    conn = http.client.HTTPConnection("127.0.0.1", 8642, timeout=timeout)
    headers = {"Authorization": "Bearer " + CREDS[PROFILE["name"] + "_key"], "Content-Type": "application/json"}
    conn.request(method, "/p/" + PROFILE["name"] + path, json.dumps(body) if body is not None else None, headers)
    return conn, conn.getresponse()


def api(method, path, body=None, timeout=60):
    conn, response = request(method, path, body, timeout)
    raw = response.read()
    conn.close()
    try:
        return response.status, json.loads(raw or b"{}")
    except ValueError:
        return response.status, {"raw": raw[:200].decode(errors="replace")}


def sse(method, path, body, on_frame, timeout=60):
    conn, response = request(method, path, body, timeout)
    if response.status != 200:
        return response.status, response.read()[:300].decode(errors="replace")
    event, data, deadline = None, [], time.time() + timeout
    while time.time() < deadline:
        try:
            line = response.fp.readline()
        except (TimeoutError, OSError):
            break
        if not line:
            break
        text = line.decode().rstrip("\n")
        if text.startswith("event:"):
            event = text[6:].strip()
        elif text.startswith("data:"):
            data.append(text[5:].strip())
        elif text == "" and (event or data):
            try:
                payload = json.loads("\n".join(data)) if data else {}
            except ValueError:
                payload = {"raw": "\n".join(data)[:200]}
            name = event or payload.get("event", "message")
            if on_frame(name, payload):
                break
            event, data = None, []
    conn.close()
    return 200, None


def calls():
    path = BASE / "calls.jsonl"
    return [json.loads(l) for l in path.read_text().splitlines()] if path.exists() else []


def clip(value, size=240):
    return value[:size] if isinstance(value, str) else value


def brief(name, data):
    if name in ("tool.started", "tool.completed", "tool.failed", "tool.progress"):
        return {k: clip(v) if not isinstance(v, (dict, list)) else clip(json.dumps(v)) for k, v in data.items()
                if k in ("tool", "name", "preview", "result", "output", "error", "duration", "status", "command", "args")}
    if name == "approval.request":
        return {k: data.get(k) for k in ("request_id", "choices", "command", "description", "pattern_key", "pattern_keys",
                                         "allow_permanent", "allow_session", "run_id")}
    if name in ("run.failed", "run.cancelled", "run.completed", "done"):
        return {k: clip(data.get(k)) for k in ("error", "status", "reason") if k in data}
    return None


def scenario(surface, mode, resolve=None):
    tag = uuid.uuid4().hex[:10]
    (BASE / "mode").write_text(mode)
    marker = BASE / ("ran-" + tag)
    before = len(calls())
    prompt = f"HOOK_TOUCH:{tag} use the local terminal tool."
    frames, state = [], {"run_id": None, "resolved": None}
    started = time.time()

    def on_frame(name, data):
        brief_ = brief(name, data)
        if not frames or frames[-1][0] != name or brief_:
            frames.append((name, brief_))
        state["run_id"] = state["run_id"] or data.get("run_id")
        if name == "approval.request" and resolve:
            status, body = api("POST", f"/v1/runs/{state['run_id']}/approval", {"choice": resolve, "request_id": data.get("request_id")})
            state["resolved"] = {"status": status, "body": body, "choice": resolve}
        return name in TERMINAL

    result = {"surface": surface, "mode": mode, "resolve": resolve}
    if surface == "run":
        status, body = api("POST", "/v1/runs", {"input": prompt})
        result["create_status"] = status
        state["run_id"] = body.get("run_id") or (body.get("run") or {}).get("id")
        sse("GET", f"/v1/runs/{state['run_id']}/events", None, on_frame, timeout=90)
    elif surface == "chat":
        status, body = api("POST", "/api/sessions", {})
        sid = body.get("id") or (body.get("session") or {}).get("id")
        result["create_status"], result["session_id"] = status, sid
        sse("POST", f"/api/sessions/{sid}/chat/stream", {"message": prompt}, on_frame, timeout=90)
    else:  # chat_completions: no event stream; the marker file is the evidence
        status, body = api("POST", "/v1/chat/completions", {"model": "fake-harness", "messages": [{"role": "user", "content": prompt}]}, timeout=90)
        result["http_status"] = status
        result["answer"] = clip(json.dumps(body.get("choices", [{}])[0].get("message", {}).get("content")))
    time.sleep(1.0)
    mine = [c for c in calls()[before:] if c["tool"] == "terminal" and (tag in (c.get("command") or ""))]
    result.update({"seconds": round(time.time() - started, 1), "ran": marker.exists(),
                   "hook_calls_for_terminal": len(mine), "hook_pids": sorted({c["pid"] for c in mine}),
                   "hook_sessions": sorted({c["session_id"] for c in mine}), "hook_extra_keys": mine[0]["extra_keys"] if mine else [],
                   "frames": [{"event": n, **({"data": b} if b else {})} for n, b in frames],
                   "run_id": state["run_id"], "resolve_response": state["resolved"]})
    return result


def tool_text(result):
    return " ".join(json.dumps(f.get("data", {})) for f in result["frames"] if f["event"].startswith("tool."))


def setup(root, profile, has, approvals="manual"):
    out = subprocess.run([sys.executable, "/tmp/hook-spike/setup_container.py", str(int(root)), str(int(profile)), str(int(has)), approvals],
                         check=True, capture_output=True, text=True).stdout.strip()
    return out.splitlines()[-1]


def row(r):
    approval = [f for f in r["frames"] if f["event"] == "approval.request"]
    tool_events = [f["event"] for f in r["frames"] if f["event"].startswith("tool.")]
    return (f"{r['profile']:8} {r['surface']:17} {r['mode']:8} {str(r['resolve']):5} ran={r['ran']!s:5} approval_frame={bool(approval)!s:5} "
            f"tool_frames={len(tool_events)} hook_calls={r['hook_calls_for_terminal']} in_gateway={r['hook_in_gateway']} {r['seconds']:>5}s")


def run_one(profile, surface, mode, resolve, want_ran, want_approval, want_hook=True):
    PROFILE["name"] = profile
    r = scenario(surface, mode, resolve)
    approval = [f for f in r["frames"] if f["event"] == "approval.request"]
    r["profile"] = profile
    r["expect"] = {"ran": want_ran, "approval_request": want_approval, "hook_called": want_hook}
    r["ok"] = (r["ran"] == want_ran and (bool(approval) == want_approval if surface != "chat_completions" else True)
               and (r["hook_calls_for_terminal"] >= 1) == want_hook)
    r["hook_in_gateway"] = r["hook_pids"] == [GATEWAY_PID["pid"]]
    print(row(r) + ("  OK" if r["ok"] else "  UNEXPECTED"), flush=True)
    return r


GATEWAY_PID = {"pid": 0}
# (surface, mode, resolve, ran expected by the ADR, approval.request expected)
MATRIX = [
    ("run", "off", None, True, False), ("chat", "off", None, True, False), ("chat_completions", "off", None, True, False),
    ("run", "block", None, False, False), ("chat", "block", None, False, False), ("chat_completions", "block", None, False, False),
    ("run", "approve", "once", True, True), ("run", "approve", "deny", False, True),
    ("chat", "approve", "once", True, True), ("chat", "approve", "deny", False, True),
    ("run", "raise", None, False, False), ("chat", "raise", None, False, False), ("chat_completions", "raise", None, False, False),
    ("run", "hang", None, False, False),
]


def main():
    out = {"phases": []}

    def phase(title, root, profile, has, rows, approvals="manual"):
        print(f"\n== {title}: {setup(root, profile, has, approvals)}", flush=True)
        GATEWAY_PID["pid"] = int((BASE / "gateway.pid").read_text())
        results = [run_one(*args) for args in rows]
        out["phases"].append({"title": title, "root_enabled": root, "profile_enabled": profile, "profile_has_plugin": has,
                              "gateway_pid": GATEWAY_PID["pid"], "scenarios": results})

    # Placement first: where must the root plugin live for a Bot's runs to see the hook?
    phase("A. plugin only in ~/.hermes/plugins, enabled in root and profile config", True, True, False,
          [("vendas", "run", "block", None, True, False, False), ("default", "run", "block", None, False, False, True)])
    phase("B. plugin copied into the profile's own plugins/, enabled only in the ROOT config", True, False, True,
          [("vendas", "run", "block", None, True, False, False)])
    phase("C. plugin copied into the profile's plugins/ and enabled in the profile config (the working placement)", True, True, True,
          [("vendas",) + m for m in MATRIX])
    phase("E. approvals.mode=off: an `approve` directive is auto-approved WITHOUT a human (ADR 4.4 strict mode is needed)", True, True, True,
          [("vendas", "run", "approve", "once", True, False), ("vendas", "chat", "approve", "once", True, False)], approvals="off")
    phase("F. approvals.mode=smart: `approve` from the hook", True, True, True,
          [("vendas", "run", "approve", "once", True, True)], approvals="smart")
    phase("D. mutation: plugin directory present but enabled nowhere", False, False, True,
          [("vendas", "run", "block", None, True, False, False), ("vendas", "chat", "block", None, True, False, False)])
    (BASE / "evidence.json").write_text(json.dumps(out, indent=2))
    bad = [s for p in out["phases"] for s in p["scenarios"] if not s["ok"]]
    print("\nALL AS EXPECTED" if not bad else f"{len(bad)} UNEXPECTED (see evidence)")


main()
