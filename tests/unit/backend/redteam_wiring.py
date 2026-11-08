"""Shared by the red-team cost tests of the redactor (Lume, 31/10): NOT a test module (no `test_` in the name, pytest does not collect it).
`redactor_named` rebuilds the redactor dashboard/plugin_api.py hands to the Pages and to the notes index from the TEXT of that file around a stand-in for Hermes's `redact_sensitive_text`,
so a guard added anywhere on the path (in the lambda, in a backend module the lambda calls, in the Pages or in the notes index) is part of what is measured. Nothing else of the plugin runs.
`cost_model` is that stand-in: the passes of agent/redact.py (Hermes v0.22.5) whose cost is NOT linear, with their patterns copied verbatim (lines 226-292, 521) and their gates and order
kept (lines 893-1010, 823-872); the rest of the function is linear and left out. Measured from the source text (never by running Hermes): _CFG_ANCHORED_RE on a run of `token` is quadratic (16 KiB: 2.7 s); on a run of `a.token` _CFG_DOTTED_RE costs x8 per
doubling (4 KiB: 5 s, 8 KiB: more than 25 s), _YAML_ASSIGN_RE x4 (the same run, 4 KiB: 28 ms; a line of `a.token`: 32 KiB 1.7 s), and _PRIVATE_KEY_RE x4 on `-----BEGIN PRIVATE KEY-----`
lines with no END (32 KiB: 0.43 s). Forja's probe (evidence/a228/redact_cost_probe.py) measures the real function; this model is what the unit suite can run without Hermes."""
import ast
import builtins
import importlib
import importlib.util
import re
import tempfile
import textwrap
import time

import pytest
from pathlib import Path

PLUGIN_API = Path(__file__).resolve().parents[3] / 'dashboard' / 'plugin_api.py'
REDACTION = PLUGIN_API.parents[1] / 'backend' / 'redaction.py'

_SECRET_CFG_NAMES = r"(?:api[ _.\-]?key|token|secret|passwd|password|credential|auth)"
_LINE_NUMBER_GUTTER = r"(?:[0-9]+(?:[|:\-]|\t)[ \t]*)?"
_CFG_VALUE = r"(['\"]?)([^\s&]+?)\2(?=[\s&]|$)"
_YAML_CFG_NAMES = r"(?:api[ _.\-]?key|token|secret|passwd|password|credential)"
_CFG_SECRET_WORD_RE = re.compile(_SECRET_CFG_NAMES, re.IGNORECASE)
_CFG_DOTTED_RE = re.compile(
    rf"(?<![A-Za-z0-9_.\-])"
    rf"([A-Za-z0-9_\-]++\.[A-Za-z0-9_.\-]*{_SECRET_CFG_NAMES}[A-Za-z0-9_.\-]*+"
    rf"|[A-Za-z0-9_.\-]*{_SECRET_CFG_NAMES}[A-Za-z0-9_.\-]*\.[A-Za-z0-9_.\-]++)"
    rf"={_CFG_VALUE}",
    re.IGNORECASE,
)
_YAML_ASSIGN_RE = re.compile(
    rf"(^[ \t]*+{_LINE_NUMBER_GUTTER}[A-Za-z0-9_.\-]*{_YAML_CFG_NAMES}[A-Za-z0-9_.\-]*+)(:[ \t]*+)(?!['\"])([^\s&]++)",
    re.IGNORECASE | re.MULTILINE,
)
_CFG_ANCHORED_RE = re.compile(
    rf"(^[ \t]*{_LINE_NUMBER_GUTTER}(?:export[ \t]+)?[A-Za-z0-9_\-]*{_SECRET_CFG_NAMES}[A-Za-z0-9_\-]*)={_CFG_VALUE}",
    re.IGNORECASE | re.MULTILINE,
)
_SECRET_ENV_NAMES = r"(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PW|CREDENTIAL|AUTH)"
_ENV_ASSIGN_RE = re.compile(rf"([A-Z0-9_]{{0,50}}{_SECRET_ENV_NAMES}[A-Z0-9_]{{0,50}})\s*=\s*(['\"]?)(\S+)\2")
_SHELL_VAR_REF = r"\$(?:\{[A-Za-z_]\w*[^}]*\}|[A-Za-z_]\w*)"
_PATH_OR_VAR_VALUE_RE = re.compile(rf"^(?:{_SHELL_VAR_REF}|\$\(|~|/)(?:[\w./:-]|{_SHELL_VAR_REF})*$")
_PRIVATE_KEY_RE = re.compile(r"-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----")
_PREFIX_RE = re.compile(r"(?<![A-Za-z0-9_-])(sk-[A-Za-z0-9_-](?:\.?[A-Za-z0-9_-]){9,})(?![A-Za-z0-9_-])")      # `_PREFIX_PATTERNS[0]` (line 147) inside `_PREFIX_RE` (589-593)
SENTINEL = chr(0xAB) + 'redacted:sk-' + chr(0x2026) + chr(0xBB)                                                      # `_mask_token_nonreusable` (line 800), under file_read


def _env_assignment(found):
    """`_should_redact_assignment` (lines 396-427) down to what costs: a value that is a path or a variable reference is tested with `_PATH_OR_VAR_VALUE_RE` before it is masked."""
    _PATH_OR_VAR_VALUE_RE.match(found.group(3))
    return found.group(0)


def cost_model(text, *, force=False, code_file=False, file_read=False, secret_file=False, redact_url_credentials=False):
    """The non-linear passes of `redact_sensitive_text`, in its order and behind its gates. Returns the text with a match replaced by itself (the cost is the scan)."""
    code_file = (code_file or file_read) and not secret_file
    text = _PREFIX_RE.sub(lambda found: SENTINEL if file_read else found.group(1)[:6] + '...' + found.group(1)[-4:], text)    # the first pass of the real function (linear): a key shape, to see that a guard does not let one through
    if not code_file:                                                        # _redact_assignments(): its `_CFG_*` passes sit behind the `=` gate and the keyword gate
        if '=' in text:
            text = _ENV_ASSIGN_RE.sub(_env_assignment, text)
        if '=' in text and '://' not in text and _CFG_SECRET_WORD_RE.search(text):
            text = _CFG_DOTTED_RE.sub(lambda found: found.group(0), text)
            text = _CFG_ANCHORED_RE.sub(lambda found: found.group(0), text)
        if ':' in text and '://' not in text:
            text = _YAML_ASSIGN_RE.sub(lambda found: found.group(0), text)
    if 'BEGIN' in text and '-----' in text:
        text = _PRIVATE_KEY_RE.sub('[REDACTED PRIVATE KEY]', text)
    return text


def _top(tree):
    return tree.body


def _import_of(tree, name):
    """The object a top-level `from luvebot_backend[.mod] import name` of plugin_api.py names, imported from the repo's `backend` package; None when it is not one."""
    for node in _top(tree):
        if isinstance(node, ast.ImportFrom) and node.module and node.module.split('.')[0] == 'luvebot_backend':
            for alias in node.names:
                if (alias.asname or alias.name) == name:
                    base = 'backend' + node.module[len('luvebot_backend'):]
                    module = importlib.import_module(base)
                    return getattr(module, alias.name) if hasattr(module, alias.name) and node.module != 'luvebot_backend' else importlib.import_module(base + '.' + alias.name)
    return None


def redaction_for(hermes):
    """backend/redaction.py in a copy of its own (no state shared with the module the rest of the suite uses), wired to the stand-in `hermes` for `redact_sensitive_text` (P-3: the
    plugin reaches Hermes's redactor only through it). A text of up to 256 bytes runs the stand-in in the process, as the real one does. A longer text goes to a worker: for the
    stand-in that is SLOW (`cost_model`) a REAL child process whose `agent.redact` is the stand-in, so the deadline and the kill that are measured are the real ones; for any other
    stand-in a worker that runs it in the process (what the test asks is what is redacted, not how long it takes)."""
    spec = importlib.util.spec_from_file_location(f'redaction_wired_{id(hermes)}', REDACTION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module._FUNCTIONS.update({'default': lambda text: hermes(text, force=True), 'file': module.masking(hermes)})
    if hermes is cost_model:
        root = Path(tempfile.mkdtemp())
        (root / 'agent').mkdir()
        (root / 'agent' / '__init__.py').write_text('')
        (root / 'agent' / 'redact.py').write_text(textwrap.dedent(f'''
            import sys
            sys.path.insert(0, {str(Path(__file__).resolve().parent)!r})
            from redteam_wiring import cost_model as redact_sensitive_text


            def redact_registered_vault_values(text):
                return text
        '''))
        module._agent_root = lambda: str(root)
        module.set_worker_factory(module._ChildWorker)
    else:
        class Inline:
            def redact(self, text, mode, deadline_s):
                return module._FUNCTIONS[mode](text)
        module.set_worker_factory(Inline)
    module.warm()
    waited = time.monotonic()
    while module._STATE['worker'] is None and time.monotonic() - waited < 15:                # the child is started before anything is measured: the route starts it on the first request
        time.sleep(0.02)
    return module


def _space(tree, node, hermes):
    space = {'redact_sensitive_text': hermes}
    for child in ast.walk(node):
        if isinstance(child, ast.Name) and child.id not in space and not hasattr(builtins, child.id):
            found = _import_of(tree, child.id)
            if found is not None:
                space[child.id] = redaction_for(hermes) if child.id == 'redaction' else found
    return space


def _evaluate(tree, node, hermes):
    space = _space(tree, node, hermes)
    return eval(compile(ast.fix_missing_locations(ast.Expression(node)), 'plugin_api', 'eval'), space)


def redactor_named(name, hermes):
    """The module-level `name` of plugin_api.py (a lambda assignment or a function), rebuilt around `hermes` (the stand-in for redact_sensitive_text)."""
    tree = ast.parse(PLUGIN_API.read_text())
    for node in _top(tree):
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return _evaluate(tree, node.value, hermes)
        if isinstance(node, ast.FunctionDef) and node.name == name:
            space = _space(tree, node, hermes)
            exec(compile(ast.fix_missing_locations(ast.Module([node], [])), 'plugin_api', 'exec'), space)
            return space[name]
    raise AssertionError(f'{name} is not defined at the top of plugin_api.py')


def redactor_of_call(factory, call_text, index, hermes):
    """The `index`-th argument of the call `call_text(...)` inside the function `factory` of plugin_api.py, rebuilt around `hermes` (a lambda, or the name of a top-level definition)."""
    tree = ast.parse(PLUGIN_API.read_text())
    function = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == factory)
    call = next(n for n in ast.walk(function) if isinstance(n, ast.Call) and ast.unparse(n.func) == call_text)
    given = call.args[index]
    if isinstance(given, ast.Name):
        return redactor_named(given.id, hermes)
    return _evaluate(tree, given, hermes)


# What each slow shape is, in the words of the report each one has upstream (NousResearch/hermes-agent): the PEM shape is issues/147242, the four of the assignment passes are issues/147257.
UPSTREAM = {'private-key-lines': 'issues/147242 (the private-key pass is lazy and rescans to the end from every BEGIN: 64 KiB 1.5 s, 256 KiB 26 s)'}
OTHER = 'issues/147257 (the config/YAML/variable assignment passes: _CFG_DOTTED_RE cubic, _CFG_ANCHORED_RE, _YAML_ASSIGN_RE and the variable reference quadratic)'


def shaped(kinds, why):
    """One pytest.param per kind. It carried its OWN strict xfail (raises=AssertionError) that named the Hermes report of that shape (`UPSTREAM`, `why`); P-3 runs the redactor in a child
    with a deadline, every shape is bounded and fails closed, and an unexpected pass is red: the kinds are plain tests now."""
    return [pytest.param(kind, id=kind) for kind in kinds]
