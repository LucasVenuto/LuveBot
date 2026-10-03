"""Authenticated calls to ONE profile's local API Server (/p/<profile>/...). Credentials never enter values or errors.

Same pattern as HermesClient.capabilities (loopback numeric host, key from the profile's secret scope, no proxy,
no redirects, bounded response, errors that carry none of the upstream text), generalized to the few routes of
contract section 5. The caller maps HTTP statuses; this module never returns an upstream body on failure.
"""
import http.client
import json
import re
import socket
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

from .hermes_client import MAX_RESPONSE_BYTES, HermesClient, HermesError, _NoRedirect

ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}', re.ASCII)


def safe_id(value):
    """Ids from the browser or from Hermes go into a URL path: only this alphabet."""
    return value if isinstance(value, str) and ID.fullmatch(value) else None


class UpstreamStream:
    """An open SSE response. lines() blocks (run it in a worker thread); abort() may be called from any thread."""

    def __init__(self, conn, response):
        self.conn, self.response = conn, response

    def lines(self, limit):
        while True:
            line = self.response.readline(limit + 1)
            if not line:
                return
            if len(line) > limit:
                raise HermesError('hermes_error')
            yield line.decode('utf-8', 'replace').rstrip('\n')

    def abort(self):
        """Close the upstream connection (the run itself is not touched). shutdown() wakes a blocked read."""
        try:
            if self.conn.sock is not None:
                self.conn.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.response.close()
            self.conn.close()
        except Exception:
            pass


class ApiClient(HermesClient):
    # `_target()` is inherited: the one resolver of HermesClient (S10), the same for capabilities, REST and streams.

    def open_stream(self, method, path, body=None, *, headers=None, first_byte_timeout=30, idle_timeout=330):
        """-> (http_status, UpstreamStream|None). Same rules as call(); the body of a failure is never read or returned."""
        conn = None
        try:
            port, key = self._target()
            data = None if body is None else json.dumps(body).encode()
            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=first_byte_timeout)  # numeric loopback, no proxy
            conn.request(method, f'/p/{self.profile}{path}', body=data,
                         headers={'Authorization': 'Bearer ' + key, 'Accept': 'text/event-stream',
                                  **({'Content-Type': 'application/json'} if data else {}), **(headers or {})})
            response = conn.getresponse()  # redirects are not followed: a 3xx is just a status
            if response.status != 200:
                status = response.status
                response.close()
                conn.close()
                return status, None
            conn.sock.settimeout(idle_timeout)
            return 200, UpstreamStream(conn, response)
        except HermesError:
            raise
        except (TimeoutError, socket.timeout):
            if conn:
                conn.close()
            raise HermesError('hermes_timeout') from None
        except (OSError, http.client.HTTPException):
            if conn:
                conn.close()
            raise HermesError('hermes_unreachable') from None
        except Exception:
            if conn:
                conn.close()
            raise HermesError('hermes_unreachable') from None

    def call(self, method, path, body=None, *, headers=None, timeout=10):
        """-> (http_status, dict|None). Transport failures raise HermesError; HTTP errors return (status, None)."""
        try:
            port, key = self._target()
            raw_port = str(port)
            data = None if body is None else json.dumps(body).encode()
            request = Request(f'http://127.0.0.1:{int(raw_port)}/p/{self.profile}{path}', data=data, method=method,
                              headers={'Authorization': 'Bearer ' + key, **({'Content-Type': 'application/json'} if data else {}),
                                       **(headers or {})})
            with build_opener(ProxyHandler({}), _NoRedirect()).open(request, timeout=timeout) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise HermesError('hermes_error')
                payload = json.loads(raw)
                return response.status, payload if isinstance(payload, dict) else None
        except HermesError:
            raise
        except (TimeoutError, socket.timeout):
            raise HermesError('hermes_timeout') from None
        except HTTPError as error:
            status = error.code
            error.close()  # never read or return the upstream body, headers or URL
            return status, None
        except URLError as error:
            raise HermesError('hermes_timeout' if isinstance(error.reason, TimeoutError) else 'hermes_unreachable') from None
        except (ValueError, OSError, TypeError):
            raise HermesError('hermes_error') from None
        except Exception:
            raise HermesError('hermes_unreachable') from None
