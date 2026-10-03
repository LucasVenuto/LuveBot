"""DISPOSABLE fake OpenAI-compatible model for the hook spike (the harness fake is not touched).
A user prompt containing HOOK_TOUCH:<tag> makes the model call `terminal` with `touch /tmp/hook-spike/ran-<tag>`;
after the tool result it answers. The marker file is the proof that the tool really ran."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import time


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def _json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/v1/models":
            return self._json(200, {"object": "list", "data": [{"id": "fake-harness", "object": "model", "owned_by": "spike"}]})
        self._json(200, {"ok": True})

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        messages = payload.get("messages", [])
        prompt = " ".join(str(m.get("content", "")) for m in messages if m.get("role") == "user")
        tool_reply = any(m.get("role") == "tool" for m in messages)
        tag = re.search(r"HOOK_TOUCH:(\w+)", prompt)
        message = {"role": "assistant", "content": "done"}
        finish = "stop"
        if tag and not tool_reply:
            message = {"role": "assistant", "content": "Running the tool.", "tool_calls": [{
                "id": "call_hook_spike", "type": "function", "function": {
                    "name": "terminal", "arguments": json.dumps({"command": "touch /tmp/hook-spike/ran-" + tag.group(1)})}}]}
            finish = "tool_calls"
        response = {"id": "chatcmpl-spike", "object": "chat.completion", "created": int(time.time()),
                    "model": payload.get("model", "fake-harness"),
                    "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
        if not payload.get("stream"):
            return self._json(200, response)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        deltas = [{"role": "assistant"}, {"content": message["content"]}]
        if "tool_calls" in message:
            deltas.append({"tool_calls": [{"index": 0, **message["tool_calls"][0]}]})
        deltas.append({})
        for delta in deltas:
            chunk = {**response, "object": "chat.completion.chunk",
                     "choices": [{"index": 0, "delta": delta, "finish_reason": finish if not delta else None}]}
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


ThreadingHTTPServer(("127.0.0.1", 8000), Handler).serve_forever()
