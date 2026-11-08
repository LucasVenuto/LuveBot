"""A-96 (contract v0.6, section 14.1; Lume's B3): `read_workspace_file` decides "text" by the BYTES, not the name. Every file
whose bytes decode as UTF-8 goes through the redaction refusal (409 file_redacted), so a key or an SVG saved as `.png`, `.gif`,
`.pdf` or `.zip` never leaves unchecked; real binary bytes (not UTF-8) are still served, and a text-named file that does not
decode stays 404. A-96b (Lume): the check runs on EVERY file, decoded with invalid bytes replaced, so one invalid byte (a PNG
signature before `API_KEY=…`, a `\xff`, a tEXt chunk) does not skip it. Limit: a secret in compressed bytes is not seen.
Hermes's sensitive-name guard and the workspace lookup are stubbed (the harness runs the real ones:
tests/invariants/test_files.py). Mutations: the check by extension only (before A-96), and the check only when the bytes are
valid UTF-8 (67eaba3), must go red.
"""
import importlib
import importlib.util
import itertools
from pathlib import Path
import re
import sys
import types

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
_n = itertools.count()
KEY = 'sk-' + 'a1b2c3d4e5f6' * 3
PNG = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR' + bytes(range(256))
SVG = f'<svg xmlns="http://www.w3.org/2000/svg"><text>{KEY}</text></svg>'.encode()
FIXED = (
    "    if parts[-1].rsplit('.', 1)[1].lower() in TEXT_TYPES:\n"
    "        try:\n"
    "            data.decode('utf-8')\n"
    "        except UnicodeDecodeError:\n"
    "            raise file_not_found() from None\n"
    "    text = data.decode('utf-8', 'replace')  # A-96b: EVERY file, so one invalid byte (a PNG signature) cannot skip the check\n"
    "    if redact(text) != text:\n"
    "        raise Refused("
)
BY_EXTENSION = (FIXED, (  # the code before A-96
    "    if parts[-1].rsplit('.', 1)[1].lower() in TEXT_TYPES:\n"
    "        try:\n"
    "            text = data.decode('utf-8')\n"
    "        except UnicodeDecodeError:\n"
    "            raise file_not_found() from None\n"
    "        if redact(text) != text:\n"
    "            raise Refused("
))
VALID_UTF8_ONLY = (FIXED, (  # 67eaba3: redaction only when the bytes are VALID UTF-8 (Lume: one invalid byte skipped it)
    "    try:\n"
    "        text = data.decode('utf-8')\n"
    "    except UnicodeDecodeError:\n"
    "        if parts[-1].rsplit('.', 1)[1].lower() in TEXT_TYPES:\n"
    "            raise file_not_found() from None\n"
    "    else:\n"
    "        if redact(text) != text:\n"
    "            raise Refused("
))


def redact(text):
    return re.sub(r'sk-[A-Za-z0-9]{20,}', 'sk-***', text)


def load(edit=None):
    name = f'bytes_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    if not edit:
        return importlib.import_module(f'{name}.pages')
    source = (BACKEND / 'pages.py').read_text()
    assert source.count(edit[0]) == 1, edit[0]
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.pages', loader=None))
    module.__package__ = name
    sys.modules[module.__name__] = module
    exec(compile(source.replace(*edit), str(BACKEND / 'pages.py'), 'exec'), module.__dict__)
    return module


@pytest.fixture
def ws(tmp_path, monkeypatch):
    files = types.ModuleType('hermes_cli.web_routers.files')
    files._is_sensitive_path = lambda path: False
    for name, module in (('hermes_cli', types.ModuleType('hermes_cli')),
                         ('hermes_cli.web_routers', types.ModuleType('hermes_cli.web_routers')),
                         ('hermes_cli.web_routers.files', files)):
        monkeypatch.setitem(sys.modules, name, module)
    for name, data in (('leak.png', PNG[:8] + f'API_KEY={KEY}'.encode()), ('texto.pdf', b'texto \xff no meio ' + KEY.encode()),
                       ('tEXt.png', PNG + b'\x00\x00\x00\x2ctEXtComment\x00' + KEY.encode() + b'\xde\xad\xbe\xef'),
                       ('latin-chave.md', 'caf\xe9 '.encode('latin-1') + KEY.encode()),
                       ('chave.png', f'chave {KEY}\n'.encode()), ('desenho.gif', SVG), ('nota.pdf', KEY.encode()),
                       ('pacote.zip', b'PK' + KEY.encode()), ('limpo.png', b'<svg xmlns="http://www.w3.org/2000/svg"/>'),
                       ('foto.png', PNG), ('latin.md', 'caf\xe9'.encode('latin-1')), ('segredo.md', KEY.encode())):
        (tmp_path / name).write_bytes(data)
    return tmp_path


def code_of(pages, path):
    try:
        pages.read_workspace_file('vendas', path, redact)
    except pages.PluginError as error:
        return error.code
    return 'served'


def checks(pages, root, monkeypatch):
    monkeypatch.setattr(pages, 'workspace', lambda bot: ('ready', str(root)))
    for path in ('chave.png', 'desenho.gif', 'nota.pdf', 'pacote.zip', 'segredo.md', 'leak.png', 'texto.pdf', 'tEXt.png'):
        assert code_of(pages, path) == 'file_redacted', path               # a key in the bytes: refused, whatever the name and
                                                                           # even after invalid UTF-8 (a PNG signature, a \xff)
    assert pages.read_workspace_file('vendas', 'foto.png', redact) == ('foto.png', PNG)   # real image bytes: served as they are
    assert code_of(pages, 'limpo.png') == 'served'                         # UTF-8 with nothing to redact: served
    assert code_of(pages, 'latin.md') == 'file_not_found'                  # a text name that does not decode: 404, as before
    assert code_of(pages, 'latin-chave.md') == 'file_not_found'            # (with a key too: never served)


def test_view_text_by_bytes_redacted(ws, monkeypatch):
    checks(load(), ws, monkeypatch)


@pytest.mark.parametrize('edit', [BY_EXTENSION, VALID_UTF8_ONLY], ids=['by_extension_only', 'valid_utf8_only'])
def test_each_mutation_is_caught(ws, monkeypatch, edit):
    with pytest.raises(AssertionError):
        checks(load(edit), ws, monkeypatch)


def view_checks(pages, root, monkeypatch):
    monkeypatch.setattr(pages, 'workspace', lambda bot: ('ready', str(root)))
    assert code_of_action(pages, None) == 'file.download' and code_of_action(pages, 'view') == 'file.view'
    for bad in ('download', 'VIEW', '', 'view '):
        assert code_of_action(pages, bad) == 'bad_request', bad                 # anything else: 400 (A-82)
    clean = b'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'
    (root / 'grafico.svg').write_bytes(clean)
    (root / 'chave.svg').write_bytes(SVG)
    (root / 'quebrado.svg').write_bytes(b'<svg>\xff</svg>')
    assert code_of(pages, 'grafico.svg') == 'served'                          # the Bot's own SVG is served (A-86)
    assert code_of(pages, 'chave.svg') == 'file_redacted'                     # with a key: refused
    assert code_of(pages, 'quebrado.svg') == 'file_not_found'                 # a text kind that is not UTF-8: 404


def code_of_action(pages, purpose):
    try:
        return pages.file_action(purpose)
    except Exception as error:  # noqa: BLE001  (a defect shows as a failed assertion)
        return getattr(error, 'code', type(error).__name__)


def test_view_purpose_and_svg(ws, monkeypatch):
    view_checks(load(), ws, monkeypatch)


@pytest.mark.parametrize('edit', [
    ("    if purpose not in FILE_ACTIONS:\n        raise PluginError(", "    if False:\n        raise PluginError("),
    ("'csv', 'json', 'svg'))", "'csv', 'json'))"),
], ids=['any_purpose_accepted', 'svg_left_out'])
def test_each_view_mutation_is_caught(ws, monkeypatch, edit):
    with pytest.raises(AssertionError):
        view_checks(load(edit), ws, monkeypatch)
