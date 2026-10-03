"""Read-only local API Server client. Credentials never enter return values/errors."""
import json
import re
import socket
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from agent.secret_scope import current_secret_scope, get_secret
from hermes_cli.profiles import list_profile_names
from hermes_cli.web_server_profiles import _config_profile_scope

PROFILE_NAME = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}', re.ASCII)
TIMEOUT_SECONDS = 3
MAX_RESPONSE_BYTES = 1024 * 1024

_MESSAGES = {
    'bot_not_found': (404, 'Bot not found.'),
    'hermes_error': (502, 'Hermes returned an unexpected response.'),
    'hermes_unreachable': (503, 'The local Hermes API Server is unavailable.'),
    'hermes_timeout': (504, 'The local Hermes API Server did not respond in time.'),
}


class HermesError(Exception):
    def __init__(self, code):
        self.code = code
        self.status, self.message = _MESSAGES[code]
        super().__init__(self.message)


def profile_names():
    """Names only, on every route that validates a Bot: Hermes's cheap listing (hermes_cli/profiles.py list_profile_names) reads no
    per-profile config and builds no alias map. Same profiles as list_profiles: the same iterator (identity marker, tombstones
    skipped); `default` only when its home exists, as list_profiles does."""
    try:
        from hermes_constants import get_default_hermes_root
        names = list_profile_names()
        if not get_default_hermes_root().is_dir():
            names = [name for name in names if name != 'default']
    except Exception:
        raise HermesError('hermes_unreachable') from None
    return [name for name in names if PROFILE_NAME.fullmatch(name)]


def validate_profile(profile):
    # No stripping, Unicode normalization or case folding.
    if not isinstance(profile, str) or not PROFILE_NAME.fullmatch(profile):
        raise HermesError('bot_not_found')
    if profile not in profile_names():
        raise HermesError('bot_not_found')
    return profile


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


DEFAULT_PORT = '8642'


class HermesClient:
    def __init__(self, profile):
        self.profile = validate_profile(profile)

    def _target(self):
        """The ONE place that decides where a profile's API Server is: -> (port, key). Capabilities, REST and SSE all call this.

        Inside the profile's own scope (`_config_profile_scope`, web_server_profiles.py#L277):
        * the KEY is `get_secret('API_SERVER_KEY')`: a credential, so it reads the profile's scope and a miss never falls to
          another profile's environment (agent/secret_scope.py#L219-L236, `API_SERVER_KEY` is not in the global list, L187);
        * the PORT is read from the SAME scope mapping first. `get_secret('API_SERVER_PORT')` cannot do it: that name is in
          `_GLOBAL_ENV_EXACT` (agent/secret_scope.py#L189) so `get_secret` returns the process `os.environ` value, or the default
          8642, whatever the profile's own `.env` says. The process-wide value (then 8642) is only the fallback when the
          profile does not say.
        An explicit value that is not a port is an error (fail closed): it never silently becomes another Bot's port."""
        try:
            with _config_profile_scope(self.profile):
                key = get_secret('API_SERVER_KEY', '')
                scoped = current_secret_scope()
                raw_port = scoped.get('API_SERVER_PORT') if scoped is not None else None
                if raw_port is None:
                    raw_port = get_secret('API_SERVER_PORT', DEFAULT_PORT)
        except HermesError:
            raise
        except Exception:
            raise HermesError('hermes_unreachable') from None
        if not key or not isinstance(raw_port, str) or not re.fullmatch(r'[0-9]{1,5}', raw_port.strip()):
            raise HermesError('hermes_unreachable')
        port = int(raw_port.strip())
        if not 1 <= port <= 65535:
            raise HermesError('hermes_unreachable')
        return port, key

    def capabilities(self):
        try:
            port, key = self._target()
            # Numeric loopback only. Ignore HTTP_PROXY/ALL_PROXY; refuse redirects.
            url = f'http://127.0.0.1:{port}/p/{self.profile}/v1/capabilities'
            request = Request(url, headers={'Authorization': 'Bearer ' + key})
            opener = build_opener(ProxyHandler({}), _NoRedirect())
            with opener.open(request, timeout=TIMEOUT_SECONDS) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if response.status != 200 or len(raw) > MAX_RESPONSE_BYTES:
                    raise HermesError('hermes_error')
                payload = json.loads(raw)
            if not isinstance(payload, dict) or payload.get('object') != 'hermes.api_server.capabilities':
                raise HermesError('hermes_error')
            # Internal only. Handlers select booleans; never proxy this whole payload.
            return payload
        except HermesError:
            raise
        except (TimeoutError, socket.timeout):
            raise HermesError('hermes_timeout') from None
        except HTTPError as error:
            error.close()  # Do not read/return upstream body, headers, URL or exception text.
            raise HermesError('hermes_error') from None
        except URLError as error:
            code = 'hermes_timeout' if isinstance(error.reason, TimeoutError) else 'hermes_unreachable'
            raise HermesError(code) from None
        except (ValueError, OSError, TypeError):
            raise HermesError('hermes_error') from None
        except Exception:
            raise HermesError('hermes_unreachable') from None


def feature_states(capabilities, baseline_ok):
    """Conservative feature detection; unknown/missing flags never enable a feature."""
    flags = capabilities.get('features', {})
    endpoints = capabilities.get('endpoints', {})
    if not isinstance(flags, dict) or not isinstance(endpoints, dict):
        flags, endpoints = {}, {}
    requirements = {
        'runs': (('run_submission', 'run_events_sse', 'run_stop'), {
            'runs': ('POST', '/v1/runs'), 'run_events': ('GET', '/v1/runs/{run_id}/events'),
            'run_stop': ('POST', '/v1/runs/{run_id}/stop')}),
        'session_chat_stream': (('session_resources', 'session_chat_streaming'), {
            'session_chat_stream': ('POST', '/api/sessions/{session_id}/chat/stream')}),
    }
    result = {}
    for feature, (required_flags, required_endpoints) in requirements.items():
        available = baseline_ok and all(flags.get(flag) is True for flag in required_flags)
        for name, (method, path) in required_endpoints.items():
            endpoint = endpoints.get(name)
            available = available and isinstance(endpoint, dict) and endpoint.get('method') == method and endpoint.get('path') == path
        result[feature] = 'ok' if available else 'unavailable'
    return result
