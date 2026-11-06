"""Hermes's own docs warn: a plugin handler that blocks holds the whole dashboard (and the Desktop) on its event loop. Every `async`
route and helper of dashboard/plugin_api.py must keep file, SQLite, subprocess and HTTP work in a worker thread
(`await run_in_threadpool(...)`, or a nested function handed to it). Static, by AST: a call made DIRECTLY in an `async def` body (not
awaited, not inside a nested def or lambda) to one of the blocking primitives below fails the test. It is a heuristic for the
regression, not a proof: blocking code reached through a helper is not seen (the helper is a plain def, called in a thread).
Mutation: a handler that opens a file directly -> red."""
import ast
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PLUGIN = REPO / "dashboard" / "plugin_api.py"
BLOCKING_NAMES = {"open", "sleep", "urlopen"}
BLOCKING_MODULES = {"subprocess", "sqlite3", "requests", "shutil", "http", "socket"}   # urllib.parse is pure: see blocking()
BLOCKING_DOTTED = {"time.sleep", "os.listdir", "os.scandir", "os.walk", "os.stat", "os.replace", "os.remove", "os.rename", "os.makedirs",
                   "os.unlink", "os.fsync"}
BLOCKING_METHODS = {"read_text", "read_bytes", "write_text", "write_bytes", "iterdir", "rglob", "unlink", "mkdir", "touch", "rename",
                    "replace_file"}
BLOCKING_STORES = {"AuditLog", "BotMeta", "RunIndex", "Budget"}   # their constructors open SQLite (RunIndex even migrates it)
CLIENTS = {"ApiClient", "HermesClient"}   # the constructor only names a profile; every METHOD is a call to Hermes
# Known and judged: (async function, call) -> why it is safe. Empty today; a new entry needs a reason.
ALLOWED = {}


def dotted(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    return ".".join(reversed(parts))


def blocking(call):
    name = dotted(call.func)
    root = name.split(".")[0]
    if name in BLOCKING_NAMES or name in BLOCKING_DOTTED or name in BLOCKING_STORES or root in BLOCKING_MODULES \
            or name.startswith("urllib.request"):
        return name
    receiver = call.func.value if isinstance(call.func, ast.Attribute) else None
    if isinstance(receiver, ast.Call) and dotted(receiver.func) in CLIENTS:
        return f"{dotted(receiver.func)}(...).{call.func.attr}"
    if isinstance(call.func, ast.Attribute) and call.func.attr in BLOCKING_METHODS:
        return name or call.func.attr
    return None


class Direct(ast.NodeVisitor):
    """The calls made directly in one async function: not awaited, not under a nested def or lambda."""

    def __init__(self):
        self.calls, self.awaited = [], set()

    def visit_FunctionDef(self, node):
        pass

    visit_AsyncFunctionDef = visit_Lambda = visit_FunctionDef

    def visit_Await(self, node):
        if isinstance(node.value, ast.Call):
            self.awaited.add(id(node.value))
        self.generic_visit(node)

    def visit_Call(self, node):
        self.calls.append(node)
        self.generic_visit(node)


def offenders(source):
    found = []
    for function in ast.walk(ast.parse(source)):
        if not isinstance(function, ast.AsyncFunctionDef):
            continue
        walker = Direct()
        for statement in function.body:
            walker.visit(statement)
        for call in walker.calls:
            what = blocking(call)
            if what and id(call) not in walker.awaited and (function.name, what) not in ALLOWED:
                found.append((function.name, what, call.lineno))
    return found


def test_no_async_handler_blocks_the_event_loop():
    assert offenders(PLUGIN.read_text()) == []


def test_the_heuristic_sees_the_ways_a_handler_can_block():
    for body in ("open('x').read()", "Path('x').read_text()", "time.sleep(1)", "subprocess.run(['ls'])", "sqlite3.connect('x')",
                 "AuditLog(path)", "ApiClient(name).call('GET', '/x')", "HermesClient(name).capabilities()", "shutil.copy(a, b)",
                 "os.listdir('.')", "RunIndex(path)._exec('x')", "urllib.request.urlopen(u)"):
        assert offenders(f"async def handler(request):\n    {body}\n"), body
    for body in ("await run_in_threadpool(lambda: open('x').read())", "await run_in_threadpool(AuditLog, path)", "await run_in_threadpool(ApiClient(name).call, 'GET', '/x')",
                 "urllib.parse.quote(name)", "index = await run_in_threadpool(RunIndex, path)",
                 "def inner():\n        open('x')\n    await run_in_threadpool(inner)", "await asyncio.sleep(1)", "x = {'a': 1}.get('a')"):
        assert not offenders(f"async def handler(request):\n    {body}\n"), body


def test_the_mutation_a_handler_that_reads_a_file_directly_is_red():
    source = PLUGIN.read_text()
    anchor = "async def get_approval_surface(bot: str, request: Request):\n"
    assert source.count(anchor) == 1
    mutated = source.replace(anchor, anchor + "    Path('/etc/hosts').read_text()\n")
    assert [found[:2] for found in offenders(mutated)] == [("get_approval_surface", "read_text")]
