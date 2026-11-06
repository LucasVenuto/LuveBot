"""AV-3b (contract v0.11 section 2.2, A-184): SafeRoute puts `Cache-Control: no-store` on every answer that did not bring a `Cache-Control` of its own (`X-LuveBot-API` is always forced), and the ONE route that
brings its own is `GET /avatars/{id}`: `private, no-cache` with a strong ETag, also on the 304. Before this, `response.headers.update(_HEADERS)` overwrote the avatar's header with `no-store`; and the value it
meant (`max-age=3600`) would have shown a removed image, or one a login can no longer read, for an hour: `no-cache` asks every time, the 304 is cheap, and the owner rule runs at every draw."""
import ast
from pathlib import Path
import re
import textwrap

import pytest
from starlette.responses import Response

API = (Path(__file__).resolve().parents[3] / 'dashboard' / 'plugin_api.py').read_text()
HEADERS = {'X-LuveBot-API': '0', 'Cache-Control': 'no-store'}
MERGE = re.compile(r"^( +)response = await original\(request\)\n(.*?)\n\1if 'Server-Timing' not in response.headers", re.S | re.M)


def routes(source):
    """[(verb, path, name, source of the handler)] for every `@router.<verb>(path)` of the file."""
    found = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for decorator in node.decorator_list:
                if (isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Attribute) and isinstance(decorator.func.value, ast.Name) and decorator.func.value.id == 'router'
                        and decorator.args and isinstance(decorator.args[0], ast.Constant)):
                    found.append((decorator.func.attr, decorator.args[0].value, node.name, ast.get_source_segment(source, node)))
    return found


def merged(source, response):
    """What SafeRoute's two lines after the handler did to `response`."""
    snippet = textwrap.dedent(MERGE.search(source).group(2))
    exec(snippet, {'response': response, '_HEADERS': HEADERS})
    return response.headers


def checks(source):
    own = [(verb, path, name) for verb, path, name, text in routes(source) if re.search('cache-control', text, re.I)]
    assert own == [('get', '/avatars/{avatar_id}', 'get_avatar')], own                                    # the only route that says its own: a new one is a decision, not an accident
    assert len(routes(source)) > 80 and sum('Cache-Control' in line for line in source.splitlines()) == 3   # three lines in the file: `_HEADERS`, SafeRoute's default and the avatar's own
    assert 'APIRouter(route_class=SafeRoute)' in source                                                      # every route above goes through SafeRoute
    bare = merged(source, Response())
    assert bare.get('Cache-Control') == 'no-store' and bare.get('X-LuveBot-API') == '0'                              # every route but the avatar: no-store
    own = merged(source, Response(headers={'Cache-Control': 'private, no-cache', 'X-LuveBot-API': 'evil', 'ETag': '"x"'}))
    assert own.get('Cache-Control') == 'private, no-cache' and own.get('ETag') == '"x"' and own.get('X-LuveBot-API') == '0'   # its own survives, ours is still forced
    cached = merged(source, Response(status_code=304, headers={'Cache-Control': 'private, no-cache', 'ETag': '"x"'}))
    assert cached.get('Cache-Control') == 'private, no-cache' and cached.get('ETag') == '"x"'                         # also on the 304
    getter = next(text for verb, path, name, text in routes(source) if name == 'get_avatar')
    assert "'Cache-Control': 'private, no-cache'" in getter and 'max-age' not in getter and "'ETag': f'\"{sha256}\"'" in getter and 'Response(status_code=304, headers=headers)' in getter


def test_every_route_answers_no_store_except_the_avatar_which_asks_every_time():
    checks(API)


@pytest.mark.parametrize('old,new', [
    ("                response.headers['X-LuveBot-API'] = _HEADERS['X-LuveBot-API']", "                response.headers.update(_HEADERS)\n                response.headers['X-LuveBot-API'] = _HEADERS['X-LuveBot-API']"),
    ("                response.headers.setdefault('Cache-Control', _HEADERS['Cache-Control'])", "                response.headers['Cache-Control'] = _HEADERS['Cache-Control']"),
    ("                response.headers.setdefault('Cache-Control', _HEADERS['Cache-Control'])", "                pass"),
    ("                response.headers['X-LuveBot-API'] = _HEADERS['X-LuveBot-API']", "                response.headers.setdefault('X-LuveBot-API', _HEADERS['X-LuveBot-API'])"),
    ("'Cache-Control': 'private, no-cache', 'ETag'", "'Cache-Control': 'no-store', 'ETag'"),
    ("'Cache-Control': 'private, no-cache', 'ETag'", "'Cache-Control': 'private, max-age=3600', 'ETag'"),
    ("@router.get('/avatars/{avatar_id}')", "@router.get('/avatars/{avatar_id}', response_class=Response)\nasync def a_second_route_with_its_own_cache(request: Request):\n    return Response(headers={'Cache-Control': 'public'})\n\n\n@router.get('/avatars/{avatar_id}')"),
    ("route_class=SafeRoute)", "route_class=APIRoute)"),
], ids=['the_header_is_overwritten_again', 'no_store_always', 'no_default_no_store', 'our_api_header_is_not_forced', 'the_avatar_is_no_store', 'max_age_is_back', 'another_route_sets_its_own', 'a_router_without_saferoute'])
def test_each_cache_control_mutation_is_caught(old, new):
    assert API.count(old) == 1, old
    with pytest.raises(AssertionError):
        checks(API.replace(old, new))
