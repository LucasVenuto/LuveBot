"""R-6: does a host with an invisible character, or an ideographic full stop as the dot of an IP, reach a local server through this machine's curl? One loopback server on a free port logs
the Host header of every request it gets; curl is given the raw UTF-8 URL, as a Bot's command would carry it."""
import http.server, subprocess, threading, sys

seen = []
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        seen.append(self.headers.get('Host'))
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
CASES = [('local͏host', 'U+034F CGJ'), ('local᠋host', 'U+180B'), ('local᠌host', 'U+180C'), ('local᠍host', 'U+180D'), ('local️host', 'U+FE0F'),
         ('local­host', 'U+00AD'), ('local᠆host', 'U+1806'), ('127。0。0。1', 'U+3002 as dot'), ('127｡0｡0｡1', 'U+FF61 as dot'),
         ('127．0．0．1', 'U+FF0E as dot'), ('localhost', 'control: localhost'), ('127.0.0.1', 'control: 127.0.0.1')]
curl = sys.argv[1] if len(sys.argv) > 1 else 'curl'
print(subprocess.run([curl, '--version'], capture_output=True, text=True).stdout.splitlines()[0])
for host, label in CASES:
    before = len(seen)
    r = subprocess.run([curl, '-sS', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}', f'http://{host}:{port}/'], capture_output=True, text=True)
    arrived = len(seen) > before
    print('%-20s curl rc=%-2d http=%s arrived=%-5s host-header=%r %s' % (label, r.returncode, r.stdout.strip() or '-', arrived, seen[-1] if arrived else None, r.stderr.strip()[:60]))
