import subprocess
CASES = [('local͏host', 'U+034F CGJ in localhost'), ('local᠋host', 'U+180B'), ('local᠌host', 'U+180C'), ('local᠍host', 'U+180D'),
         ('local️host', 'U+FE0F'), ('local­host', 'U+00AD soft hyphen'), ('local᠆host', 'U+1806 todo soft hyphen'),
         ('127。0。0。1', 'U+3002 as the dot of an IP'), ('127｡0｡0｡1', 'U+FF61 as the dot of an IP'),
         ('127．0．0．1', 'U+FF0E as the dot of an IP'), ('127.0.0.1', 'control: plain IP'), ('localhost', 'control: plain name')]
for flag in ('-N', '-T', '--no-tr46'):
    print('== idn2', flag)
    for host, label in CASES:
        r = subprocess.run(['idn2', '--quiet', flag, host], capture_output=True, text=True)
        out = r.stdout.strip() if r.returncode == 0 else 'REFUSED rc=%d (%s)' % (r.returncode, r.stderr.strip()[:60])
        print('  %-30s -> %s' % (label, out))
