"""Pure rules engine (ADR-002 section 8): rules + an action + a live-state snapshot in, decision / hook table / seal out.

Standard library only. No I/O, no clock (time is a parameter), no Hermes, no logging, no routes. Deterministic and
independent of the order of the rules. Nothing here approves anything: the only effect an action can get is a Level, and
the only way a rule becomes ACTIVE is `activate` by a human Actor (invariant 6).

Spelling is never a way around a rule: tool names, commands, facts and patterns pass through the same canonical form
(NFKC + case folding, invisible characters dropped). An action whose spelling is not canonical (control or format
characters, whitespace inside a tool name, oversize text) can never be matched by an `allow` or `explicit` rule and is
asked about at least (the old engine failed this once, task.md T-F2.1).
A command whose executable is not a plain word (quotes, backslash, expansion, glob or tilde stuck to the name) is not
canonical either (R-12 condition). Declared limit: indirection through an interpreter or an encoding (a script, a decoded
payload) cannot be seen in the text; there the defence is Hermes's own deny list (M4) and command gate (M8), not this engine.
Seals compare like Hermes does (case-exact MCP names, `approvals.deny` only stripped and lower-cased), never more loosely.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
import fnmatch
import hashlib
import json
import math
import re
import unicodedata

from . import unicode_invisible
from .rules_builtin import FAMILIES
from .rules_types import *  # noqa: F401,F403  (the public names of rules_types are part of this module's API)
from .rules_types import (Action, Actor, ActorKind, Level, Match, MechanismId, Origin, Rule, RuleState, Scope,
                          ScopeKind, Seal)

# --------------------------------------------------------------------------------------------------------------------
# canonical forms
# --------------------------------------------------------------------------------------------------------------------
MAX_TOOL = 128
MAX_PATTERN = 512
MAX_COMMAND = 16384
MAX_SEGMENTS = 64
MAX_DEPTH = 4         # nested commands read inside one segment (`sh -c`, `eval`, `find -exec`, `python -m`, a runner, `env -S`)
MAX_VARIANTS = 256    # spellings of one segment a restrictive rule is matched against
_INVISIBLE = frozenset({"Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp"})
_SYMBOL_BEFORE_SELECTOR = frozenset({"So", "Sk", "Sm", "No"})   # the symbols an emoji presentation selector may follow without dirtying the action (A-200)
_ERASED_BY_IDNA = frozenset({0x1806})   # MONGOLIAN TODO SOFT HYPHEN (category Pd): the one character of RFC 3454 B.1, "mapped to nothing" by IDNA 2003, that neither the categories nor the table cover; the Python codec erases it from a host (R-10, A-205)


def _invisible(char: str) -> bool:
    """ONE question for every place that drops or refuses an invisible character (A-198, R-5): the categories above, OR the single table of 3.4 (`unicode_invisible.kind_of`: it holds CGJ U+034F, U+180B-180D, U+FE00-FE0D and
    the rest of the table, which the category list never saw: the IDNA resolver erases them from a host, so `curl http://local<CGJ>host` reached localhost past a block on `*localhost*`), OR the two variation selectors the
    table leaves unmarked because they are legitimate in text (U+FE0E, U+FE0F: `mark_except`) but that the resolver erases all the same, OR U+1806 (`_ERASED_BY_IDNA`: the last one of RFC 3454 B.1). The matcher only COMPARES: it never changes the action it is shown."""
    code = ord(char)
    return unicodedata.category(char) in _INVISIBLE or unicode_invisible.kind_of(code) is not None or code in unicode_invisible.TABLE["mark_except"] or code in _ERASED_BY_IDNA
_TOOL_RE = re.compile(r"[a-z0-9][a-z0-9_.:/-]{0,%d}" % (MAX_TOOL - 1))
_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}")
_SEPARATORS = frozenset(";&|\n\r`(){}<>")
_WRAPPERS = frozenset({"sudo", "doas", "env", "nohup", "time", "command", "exec", "xargs", "nice", "stdbuf", "builtin",
                       "timeout", "setsid", "ionice", "busybox", "watch", "flock", "unbuffer", "taskset", "strace", "ltrace",
                       "chrt", "unshare", "nsenter", "chroot"})
_SHELLS = frozenset({"sh", "bash", "zsh", "dash", "ksh", "su", "eval", "script"})
_ASSIGN = re.compile(r"[a-z_][a-z0-9_]*=\S*")
_POSITIONAL = {"flock": 1, "chroot": 1}
# Wrapper options that may take the NEXT token as their value (casefolded, as commands are): without them `sudo -u root pip
# install x` read `root` as the executable. Casefolding merges some flags (`sudo -H` and `sudo -h host`), so a restrictive rule is
# matched against BOTH readings (value skipped and not skipped, see _expand): an ambiguity can only ask more, never less.
_VALUE_OPTS = {"sudo": {"-u", "-g", "-h", "-p", "-c", "-r", "-t", "-d", "--user", "--group", "--host", "--prompt", "--chdir"},
               "doas": {"-u", "-c"}, "env": {"-u", "--unset", "-c", "--chdir"}, "timeout": {"-s", "--signal", "-k", "--kill-after"},
               "stdbuf": {"-i", "-o", "-e"}, "time": {"-f", "--format", "-o", "--output"},
               "xargs": {"-a", "-d", "-e", "-i", "-l", "-n", "-p", "-s", "--arg-file", "--delimiter"},
               "strace": {"-e", "-o", "-p", "-s", "-u"}, "ltrace": {"-e", "-o", "-p", "-s", "-u"}, "taskset": {"-c", "--cpu-list"},
               "chrt": {"-p"}, "watch": {"-n", "-d"}, "flock": {"-w", "-e"}, "nsenter": {"-t", "--target"},
               "chroot": {"--userspec", "--groups"}, "exec": {"-a"}}
# `python -m <module> ...` runs <module> as the program (`python -m pip install x` is `pip install x`), and so does a script given by
# path (`python3 /usr/bin/pip install x`); the same for runners that execute a command inside an environment (`uv run pip ...`).
# Code given inline (`python -c '...'`) is not read: see `pattern`.
_INTERPRETER = re.compile(r"(?:python|pypy)[0-9.]*|py")
_RUNNERS = {"uv": "run", "poetry": "run", "pipenv": "run", "pdm": "run", "hatch": "run", "rye": "run", "conda": "run",
            "mamba": "run", "micromamba": "run", "pixi": "run"}
_RUNNER_VALUE_OPTS = {"-n", "--name", "-p", "--prefix", "--with", "--python", "--env", "-e"}
_NUMERIC = re.compile(r"[0-9][0-9a-z.:]*")           # a wrapper's value argument (a duration, a priority, a CPU mask)
_SIMPLE_WORD = re.compile(r"(?:\.{0,2}/)?[a-z0-9][a-z0-9_.+:@/-]*")  # an executable that is a plain word, as a shell would read it
_QUOTING = str.maketrans("", "", "'\"\\")


def _fold(text: str) -> str:
    return unicodedata.normalize("NFKC", text).casefold()


def _fold_plain(text: str) -> tuple[str, bool]:
    """-> (the fold, whether it is only what a simple lower case would also make). The FULL case fold takes the sharp s (U+00DF) and the capital sharp s (U+1E9E) to `ss` and the final sigma (U+03C2) to U+03C3, and the resolvers of a browser, Node and libidn2 (IDNA 2008, UTS 46 non-transitional)
    KEEP those characters: `stra<U+00DF>e.de` is xn--strae-oqa.de, not strasse.de. A text where the two differ names one host to the matcher and another to the tool, so a permission must not read it as clean (A-208)."""
    nfkc = unicodedata.normalize("NFKC", text)
    folded = nfkc.casefold()
    return folded, nfkc.lower() == folded


_FOLD_DIVERGENCE = ("a permission written with a character the resolvers do not fold as the matcher does (the sharp s, the final sigma) would cover another host or name than the one it writes: "
                    "write the address in ASCII (xn--...), or use the ask level")


def canon_name(raw) -> tuple[str, bool]:
    """Canonical form of a tool, toolset, server or fact name -> (name, clean). `clean` is False when anything but
    case/compatibility folding was needed or the result is not a plain identifier; the name is still usable for
    matching (invisible characters and spaces dropped) so a rule written for the plain name still hits."""
    if not isinstance(raw, str):
        return "", False
    folded = _fold(raw)
    plain = "".join(c for c in folded if not c.isspace() and not _invisible(c))
    return plain, _TOOL_RE.fullmatch(folded) is not None   # the full fold that is not a lower case is `allowable`'s business (a permission), not `clean`'s: the name was read whole (A-214)


def _canon_pattern(raw: str) -> str:
    folded = _fold(raw)
    return "".join(c for c in folded if not c.isspace() and not _invisible(c))


# ---- the DESTINATION of a URL, read in one canonical form (A-199, R-7; the Lume's F-R4-2 and F-R4-3) ------------------------------------------------------
# A resolver or a URL parser treats `2130706433`, `0x7f.1`, `localhost.` and `example.com:80` as the same host the matcher compares as different text, so a block or an ask on a destination was bypassed by a spelling.
# The action gets ONE variant more (its URL authorities in canonical form) and a pattern that spells a destination literally gets the same form NEXT TO the original. Only for rules that match MORE (block, ask, handback):
# an ALLOW rule keeps matching the EXACT text, because a canonicalizer that disagreed with a real resolver could allow ANOTHER host. Pure (no socket). NOT read, and not claimed: IPv6 (`[::1]`, `[::ffff:127.0.0.1]`),
# `0.0.0.0` (another address), a destination with no scheme (`curl 127.1:8080`) and a name that resolves to the address (threat model R-16).
# The user info runs to the LAST `@` of the authority, as the WHATWG parser and `urlsplit` read it (A-202). A scheme is at most 32 characters: the bound keeps the scan from each start constant (a long run of lowercase text,
# 16 KiB of hex or base64, was quadratic: 0.35 to 0.9 s a command); the text before a longer run is left as it is, so the canonical form is the same.
_AUTHORITY =re.compile(r"(?P<scheme>[a-z][a-z0-9+.-]{0,31})://(?:[^/?#\s]*@)?(?P<host>[^/@:?#\s*?\[\]]+)(?::(?P<port>[0-9]*))?(?=(?P<next>[/?#\s]|$))")
_AUTHORITY_OF_A_PATTERN = re.compile(_AUTHORITY.pattern.replace("(?P<next>[/?#\\s]|$)", "(?P<next>[/#\\s]|$)"))   # in a pattern `?` is a wildcard, never the start of a query
_PERCENT = re.compile(r"%([0-9a-f]{2})", re.I)
_IPV4_FORM = re.compile(r"(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+)){0,3}")
_IPV4_TOKEN = re.compile(r"(?<![0-9A-Za-z_:-])(?<![0-9A-Za-z_-]\.)(" + _IPV4_FORM.pattern + r")(?![0-9A-Za-z_-])(?!\.[0-9A-Za-z_-])")
_DEFAULT_PORT = {"http": 80, "https": 443}
_IDEOGRAPHIC_STOPS = {0x3002: ".", 0xFF61: "."}   # IDNA turns them into a dot (libidn2 and the Python codec: `127<U+3002>0<U+3002>0<U+3002>1` is 127.0.0.1); U+FF0E is a dot for NFKC already. Read in the host of the canonical variant only (R-10, A-205)


def _inet_aton(host: str) -> str | None:
    """libc `inet_aton` as a pure function: 1 to 4 parts, each decimal, `0x` hex or `0` octal, the last one filling the bytes that remain -> dotted decimal, or None when it is not an address (a part out of range, `08`,
    five parts): it then stays as it is."""
    parts = host.split(".")
    if not 1 <= len(parts) <= 4:
        return None
    try:
        nums = [int(x, 16) if x.startswith("0x") else int(x, 8) if len(x) > 1 and x.startswith("0") else int(x, 10) for x in parts]
    except ValueError:
        return None
    if any(n > 255 for n in nums[:-1]) or nums[-1] >= 256 ** (5 - len(nums)):
        return None
    value = 0
    for n in nums[:-1]:
        value = (value << 8) | n
    value = (value << (8 * (5 - len(nums)))) | nums[-1]
    return ".".join(str((value >> shift) & 255) for shift in (24, 16, 8, 0))


def _host_name(host: str) -> str:
    """A percent-encoded host (`local%68ost`, `127.0.0.%31`: curl decodes it) read once, in lower case, but ONLY when what comes out is still a host name (letters, digits, dots, hyphens): `%2f`, `%40`, `%00`, a non-ASCII
    byte or a double encoding stay as written."""
    if "%" not in host:
        return host
    decoded = _PERCENT.sub(lambda found: chr(int(found.group(1), 16)), host).lower()
    return decoded if re.fullmatch(r"[a-z0-9.-]+", decoded) else host


def _canon_authority(found: "re.Match[str]") -> str:
    """`scheme://host`, `:port` only when the port is not the default of the scheme, and a `/` when the URL has no path (`http://h`, `http://h?x`, `http://h#f`): no user info, no trailing dot, a percent-encoded host decoded when it
    stays a host name, a numeric IPv4 as dotted decimal (http 80 and https 443 are the defaults, written with any number of leading zeros, which the resolver reads as the same number: `http://h:443` keeps its port, `:0` and `:00` are port 0)."""
    host = _host_name(found.group("host").translate(_IDEOGRAPHIC_STOPS)).rstrip(".")
    if not host:
        return found.group(0)
    if _IPV4_FORM.fullmatch(host):
        host = _inet_aton(host) or host
    port, scheme = found.group("port"), found.group("scheme")
    keep = bool(port) and port.lstrip("0") != str(_DEFAULT_PORT.get(scheme))
    return f"{scheme}://{host}" + (f":{port}" if keep else "") + ("" if found.group("next") == "/" else "/")


def _canon_authorities(text: str, glob: bool = False) -> str:
    return (_AUTHORITY_OF_A_PATTERN if glob else _AUTHORITY).sub(_canon_authority, text)


def _literal_address(found: "re.Match[str]") -> str:
    """An IPv4 literal of a PATTERN in dotted decimal. A number with no dot is read as an address only when it cannot be a port or an id: `0x...` hex, or 8 digits and more (`2130706433`, `017700000001`)."""
    token = found.group(1)
    if "." not in token and not (token.startswith("0x") or len(token) >= 8):
        return token
    return _inet_aton(token) or token


def _destination_forms(pattern: str) -> tuple[str, ...]:
    """The pattern as written and, when it spells a destination literally, the same destination in canonical form: an IPv4 literal anywhere (`*2130706433*` also reads `*127.0.0.1*`) and the authority after `://` when
    it has no `*` or `?`. The original is always kept: the canonical form only ADDS what the rule matches."""
    canon = _canon_authorities(_IPV4_TOKEN.sub(_literal_address, pattern), glob=True)
    return (pattern,) if canon == pattern else (pattern, canon)


def _squash(text: str) -> str:
    return " ".join(text.split())


def _command_read(raw) -> tuple[str, bool, bool]:
    """Folded command with newlines kept (they separate commands) -> (text, clean, allowable). `clean` means READ WHOLE: a cap, a hidden character or a quoting may have let the action escape a restrictive rule, so it is asked about
    by default. `allowable` is False when the full case fold changed what a simple lower case would not (the sharp s, the final sigma: A-208): no permission covers the action, but nothing asks because of it, since a restrictive rule
    catches both spellings (A-212)."""
    if not isinstance(raw, str):
        return "", False, False
    clean = len(raw) <= MAX_COMMAND
    folded, simple = _fold_plain(raw[:MAX_COMMAND])
    if len(folded) > MAX_COMMAND:   # the fold can make the text up to 18 times longer than the cap (U+FDFA on Unicode 16): cut it too, and the action is no longer canonical, as one over the cap already is (A-203)
        folded, clean = folded[:MAX_COMMAND], False
    kept = []
    for index, char in enumerate(folded):
        if _invisible(char) and char not in "\t\n\r":
            # ONE variation selector directly after a NON-ASCII symbol is an emoji sequence: dropped for the match, but it cannot be part of an ASCII host, so it does not dirty the action (A-200)
            if not (0xFE00 <= ord(char) <= 0xFE0F and index and ord(folded[index - 1]) > 0x7F and unicodedata.category(folded[index - 1]) in _SYMBOL_BEFORE_SELECTOR):
                clean = False
            continue
        kept.append(char)
    return "".join(kept), clean, simple


def _command_text(raw) -> tuple[str, bool]:
    """(text, clean) of `_command_read`: the text the rules match and whether it was read whole."""
    text, clean, _allowable = _command_read(raw)
    return text, clean


def _split_segments(text: str) -> tuple[list[str], bool]:
    segments, current = [], []
    for char in text:
        if char in _SEPARATORS:
            segments.append("".join(current))
            current = []
        else:
            current.append(char)
    segments.append("".join(current))
    cleaned = [_squash(s) for s in segments if s.strip()]
    return cleaned[:MAX_SEGMENTS], len(cleaned) <= MAX_SEGMENTS


def _executable(tokens: list[str], values: bool = True) -> tuple[int, str] | None:
    """Index and text of the executable behind assignments, wrappers and their options / value arguments. `values=False` reads
    every wrapper option as a flag (the other reading of an ambiguous option)."""
    i, wrapped, skip, wrapper = 0, False, 0, None
    while i < len(tokens):
        token = tokens[i]
        if _ASSIGN.fullmatch(token):
            i += 1
        elif token.rsplit("/", 1)[-1] in _WRAPPERS:
            wrapped, wrapper = True, token.rsplit("/", 1)[-1]
            skip = _POSITIONAL.get(wrapper, 0)
            i += 1
        elif values and wrapped and token in _VALUE_OPTS.get(wrapper, ()):
            i += 2  # the option and its value (`sudo -u root`, `env -u NAME`, `exec -a NAME`)
        elif wrapped and skip and not token.startswith("-"):
            skip -= 1  # a wrapper's own positional argument (a lock file, a directory)
            i += 1
        elif wrapped and (token.startswith("-") or _NUMERIC.fullmatch(token)):
            i += 1
        else:
            return i, token
    return None


def _readings(tokens: list[str]) -> set[tuple[int, str]]:
    """The executable under BOTH readings of the wrapper options (value taken, value not taken). Every check uses both: one
    reading that is not canonical makes the command not canonical, and a restrictive rule is matched against both."""
    return {found for values in (True, False) if (found := _executable(tokens, values)) is not None}


def _interpreted(args: list[str]) -> list[str]:
    """The arguments of a Python interpreter -> the commands it runs: a module (`-m pip install x`, `-mpip`, `-Im pip`) -> "pip
    install x"; a script by path (`/usr/bin/pip install x`, `get-pip.py`) -> "pip install x", "get-pip.py". Inline code (`-c`) and
    stdin give nothing. Casefolded, `-X dev` / `-W x` (value) and `-x` (flag) are one spelling: both readings, each position once."""
    out, pending, seen = [], [0], set()
    while pending and len(out) <= MAX_VARIANTS:  # past the ceiling _expand stops INCOMPLETE and the action asks
        i = pending.pop()
        while i < len(args) and i not in seen:
            seen.add(i)
            arg = args[i]
            if arg == "--" or arg == "-" or not arg.startswith("-"):
                script = args[i + 1:] if arg == "--" else args[i:]
                if script and script[0] != "-":
                    out.append(" ".join([script[0].rsplit("/", 1)[-1]] + script[1:]))
                break
            flags, i = arg[1:], i + 1
            if arg.startswith("--"):
                continue  # a long option (`--isolated`)
            before, m, after = flags.partition("m")
            if "c" in before:
                break
            if m:
                module = ([after] if after else []) + args[i:]
                if module:
                    out.append(" ".join(module))
                break
            if flags in ("x", "w") and i < len(args):
                pending.append(i)  # -x as a flag: the next token is read as it stands
                i += 1             # -X / -W and their value
    return out


def _runner_command(args: list[str]) -> str | None:
    """`run [options] [--] <command>` of an environment runner (uv, poetry, pipenv, pdm, hatch, rye, conda) -> "<command>"."""
    i = 1
    while i < len(args):
        arg = args[i]
        if arg == "--":
            return " ".join(args[i + 1:]) or None
        if arg in _RUNNER_VALUE_OPTS:
            i += 2
            continue
        if arg.startswith("-"):
            i += 1
            continue
        return " ".join(args[i:])
    return None


def _env_split(tokens: list[str]) -> str | None:
    """`env -S 'pip install x'` (also `-S'…'`, `--split-string=…`): env splits that one string into the command it runs."""
    start = next((i for i, t in enumerate(tokens) if t.rsplit("/", 1)[-1] == "env"), None)
    i = len(tokens) if start is None else start + 1
    while i < len(tokens) and tokens[i].startswith("-"):
        token = tokens[i]
        if token in ("-s", "--split-string"):
            return " ".join(tokens[i + 1:]) or None
        glued = token[15:] if token.startswith("--split-string=") else token[2:] if token.startswith("-s") else None
        if glued is not None:
            return " ".join([glued] + tokens[i + 1:])
        i += 2 if token in _VALUE_OPTS["env"] else 1
    return None


def _glued_substitution(text: str) -> bool:
    """A backtick substitution stuck to the executable word (`name` immediately followed by it): the shell makes ONE
    word out of both, so the executable is not what it looks like."""
    for i, char in enumerate(text):
        if char != "`" or i == 0 or text[i - 1].isspace() or text[i - 1] in _SEPARATORS:
            continue
        start = max((text.rfind(sep, 0, i) for sep in _SEPARATORS), default=-1) + 1
        tokens = text[start:i].split()
        if any(index == len(tokens) - 1 for index, _ in _readings(tokens)):
            return True
    return False


def _expand(segment: str) -> tuple[set[str], bool]:
    """The segment plus what a shell would run behind wrappers, assignments, a path-qualified executable, quoting
    or backslashes, `sh -c` / `eval` / `su -c`, `find -exec`, `env -S`, a Python interpreter and an environment runner
    -> (variants, complete). Heuristic, like Hermes's own deny list. Breadth first and each text read once; past MAX_DEPTH
    nested commands or MAX_VARIANTS variants the reading stops INCOMPLETE, and the caller asks (fails closed)."""
    out, seen, queue, complete = set(), set(), [(segment, 0)], True
    for segment, depth in queue:
        if segment in seen:
            continue
        seen.add(segment)
        out.add(segment)
        deobfuscated = _squash(segment.translate(_QUOTING))
        out.add(deobfuscated)
        nested = []
        for text in {segment, deobfuscated}:
            tokens = text.split()
            nested.append(_env_split(tokens))
            for index, exe in _readings(tokens):
                rest = tokens[index:]
                out.add(" ".join(rest))
                head = exe.rsplit("/", 1)[-1]
                out.add(" ".join([head] + rest[1:]))
                if _INTERPRETER.fullmatch(head):
                    nested += _interpreted(rest[1:])                 # python -m pip install x  ->  pip install x
                elif _RUNNERS.get(head) and len(rest) > 1 and rest[1] == _RUNNERS[head]:
                    nested.append(_runner_command(rest[1:]))         # uv run pip install x  ->  pip install x
                if head in _SHELLS:
                    for i, token in enumerate(rest[1:], 1):
                        if (token.startswith("-") and token.endswith("c")) or head == "eval":
                            inner = " ".join(rest[i + (0 if head == "eval" else 1):]).strip("'\"")
                            out.add(_squash(inner))
                            nested += _split_segments(inner)[0]
                            break
            for i, token in enumerate(tokens):
                if token in ("-exec", "-execdir", "-ok", "-okdir") and i + 1 < len(tokens):
                    inner = _squash(" ".join(tokens[i + 1:]).rstrip("\\"))
                    out.add(inner)
                    nested.append(inner)  # a later -exec is inside this text: read when it is, never once per -exec here
                    break
        nested = [n for n in nested if n and n not in seen]
        if nested and depth >= MAX_DEPTH:
            complete = False
            continue
        queue += [(n, depth + 1) for n in nested]
        if len(out) > MAX_VARIANTS:
            return out, False
    return out, complete


def _tokens(pattern: str) -> list[str | None]:
    """Glob tokens: None = `*`, "?" = any one char (as the 1-tuple), literals as 1-char strings; `\\` escapes."""
    out, i = [], 0
    while i < len(pattern):
        char = pattern[i]
        if char == "\\" and i + 1 < len(pattern):
            out.append(("lit", pattern[i + 1]))
            i += 2
            continue
        out.append(None if char == "*" else ("one",) if char == "?" else ("lit", char))
        i += 1
    return out


def glob_match(pattern: str, text: str) -> bool:
    """`*`, `?` and `\\` escapes only (no character classes, no regex, so no catastrophic backtracking). It is NOT linear: the cost is the text times the literal that follows the last `*` of the pattern
    (about 1.3 ms per character of that tail on 16 KiB: 3 ms for the patterns people write, 0.65 s for an adversarial tail of 500 characters; a hostile PATTERN, never a hostile text; A-203)."""
    toks = _tokens(pattern)
    ti = pi = 0
    star, mark = -1, 0
    while ti < len(text):
        if pi < len(toks) and toks[pi] is not None and (toks[pi][0] == "one" or toks[pi][1] == text[ti]):
            pi += 1
            ti += 1
        elif pi < len(toks) and toks[pi] is None:
            star, mark = pi, ti
            pi += 1
        elif star != -1:
            pi = star + 1
            mark += 1
            ti = mark
        else:
            return False
    while pi < len(toks) and toks[pi] is None:
        pi += 1
    return pi == len(toks)


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("*", "\\*").replace("?", "\\?")


COMMAND_TOOLS = ("terminal", "execute_code")   # the tools whose call carries a command text (Action.command): a rule that names one and no command covers every call of it


def has_wildcard(pattern: str) -> bool:
    """An unescaped `*` or `?` in a glob of `tools` or `commands` (a backslash makes the next character a literal, as `_tokens` reads it)."""
    return any(token is None or token == ("one",) for token in _tokens(pattern))


def exact(match: Match) -> bool:
    """AA-1 (plugin-api v0.11 section 11, A-255): whether a rule covers ONE thing and nothing around it, computed here and never by the screen. True when it names a tool, no pattern of its tools or commands holds an unescaped wildcard, no `path` condition is a
    directory tree (`under`) or a glob with a `*` or `?`, and a tool that carries a command (`terminal`, `execute_code`) comes with the command (a rule that names it and no command covers every call of it). A condition on a fact other than the path (a recipient, any
    other fact) is an equality: it never widens. The "Always allow" draft (tool and command escaped, the facts the card showed) is exact; the same draft edited with a `*`, a folder or a missing command is not."""
    if not match.tools or any(has_wildcard(pattern) for pattern in (*match.tools, *match.commands)):
        return False
    for key, value in match.conditions:
        op = _path_key(key)
        if op == "under" or (op == "glob" and any(char in value for char in "*?")):
            return False
    names = ("".join(token[1] for token in _tokens(pattern)).strip().casefold() for pattern in match.tools)
    return bool(match.commands) or not any(name in COMMAND_TOOLS for name in names)


def covers(match: Match) -> str:
    """AA-1b (plugin-api v0.11 section 11, A-286): WHAT an exact rule covers, from the same reading as `exact` and in the same place, so the sentence of the screen is chosen by the server and never by the screen's own reading of the pattern. `"wider"` when the rule is not exact (and only then); otherwise `"command"` when it names a command, `"facts"` when it is narrowed only by a condition (a file or a recipient), `"tool"` when it is every call of one tool (`web_search`)."""
    if not exact(match):
        return "wider"
    return "command" if match.commands else "facts" if match.conditions else "tool"


@dataclass(frozen=True, slots=True)
class _View:
    """An Action in canonical form; computed once per evaluation."""
    tool: str
    toolset: str | None
    server: str | None
    whole: str | None          # whole command, whitespace squashed
    segments: tuple[str, ...]  # the raw segments
    variants: frozenset[str]   # every candidate a restrictive rule may match
    facts: tuple[tuple[str, str], ...]
    clean: bool
    paths: tuple[str, ...] = ()  # the `path` facts, NFC only: never folded or squashed (rules-conditions-v0 §3)
    recipients: tuple[str, ...] = ()  # the `recipient` facts, NFC only, for the same reason
    allowable: bool = True     # False when the command folds in a way the resolvers do not (A-212): only a permissive rule reads it, and it never matches


def _view(action: Action) -> _View:
    tool, clean = canon_name(action.tool)
    toolset = canon_name(action.toolset)[0] if isinstance(action.toolset, str) else None
    server = canon_name(action.mcp_server)[0] if isinstance(action.mcp_server, str) else None
    allowable = all(_fold_plain(name)[1] for name in (action.tool, action.toolset, action.mcp_server) if isinstance(name, str))   # the names are read like the command: no permission covers one, nothing asks because of it (A-214)
    whole, segments, variants = None, (), frozenset()
    if action.command is not None:
        text, command_clean, command_allowable = _command_read(action.command)
        allowable = allowable and command_allowable
        parts, parts_clean = _split_segments(text)
        clean = clean and command_clean and parts_clean
        whole = _squash(text)
        segments = tuple(parts)
        if _glued_substitution(text):
            clean = False
        for part in parts:  # R-12 condition: an executable that is not a plain word, under either reading, is not canonical
            if any(not _SIMPLE_WORD.fullmatch(exe) for _, exe in _readings(part.split())):
                clean = False
        found = {whole}
        for part in parts:
            expanded, complete = _expand(part)
            found |= expanded
            clean = clean and complete  # read only in part (too deep, too many variants): asked about, never allowed
        variants = frozenset(found | {_canon_authorities(v) for v in found})   # the destinations in canonical form: ONE variant more, for the rules that match MORE (A-199)
    facts, paths, recipients = [], [], []
    for pair in action.facts if isinstance(action.facts, tuple) else ():
        if isinstance(pair, tuple) and len(pair) == 2 and all(isinstance(x, str) for x in pair):
            if _squash(_fold(pair[0])) == PATH_FACT:
                paths.append(unicodedata.normalize("NFC", pair[1]))  # a path is not text to squash: `a b` and `a  b` are two files
            elif _squash(_fold(pair[0])) == RECIPIENT_FACT:
                recipients.append(unicodedata.normalize("NFC", pair[1]))
            else:
                facts.append((_squash(_fold(pair[0])), _squash(_fold(pair[1]))))
                allowable = allowable and _fold_plain(pair[0])[1] and _fold_plain(pair[1])[1]   # a fact of another name than path and recipient is folded on both sides, so it is read like the command (A-213)
    return _View(tool, toolset, server, whole, segments, variants, tuple(facts), clean, tuple(paths), tuple(recipients), allowable)


# --------------------------------------------------------------------------------------------------------------------
# evaluation
# --------------------------------------------------------------------------------------------------------------------
class ReasonCode(StrEnum):
    DEFAULT_ALLOW = "default_allow"
    SINGLE_RULE = "single_rule"
    ASK_BEATS_ALLOW = "ask_beats_allow"          # ask over allow/explicit, any scope
    STRICTER_WINS = "stricter_wins"              # block/handback over something less strict
    NONCANONICAL_ACTION = "noncanonical_action"  # Assumed R-12: unknown spelling is asked about, never allowed


@dataclass(frozen=True, slots=True)
class RuleHit:
    rule_id: str
    level: Level
    scope: Scope
    builtin: bool
    matched_on: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class Decision:
    effect: Level
    winner: str | None                  # rule id cited; None for DEFAULT_ALLOW
    hits: tuple[RuleHit, ...]           # every matching ACTIVE rule, most restrictive first, then narrowest scope, then id
    reason: ReasonCode


@dataclass(frozen=True, slots=True)
class Problem:
    code: str
    detail: str


class RuleError(Exception):
    """Refusals of the lifecycle; `args[0]` is the code ("human_required", "not_a_draft", ...)."""


RANK = {Level.ALLOW: 0, Level.EXPLICIT: 1, Level.ASK: 2, Level.HANDBACK: 3, Level.BLOCK: 4}
_SCOPE_ORDER = {ScopeKind.ROUTINE: 0, ScopeKind.BOT: 1, ScopeKind.ROOM: 2, ScopeKind.GLOBAL: 3}
_RESTRICTIVE = (Level.ASK, Level.HANDBACK, Level.BLOCK)


def _applies(rule: Rule, action: Action) -> bool:
    scope = rule.scope
    if scope.kind is ScopeKind.GLOBAL:
        return True
    ref = {ScopeKind.BOT: action.bot, ScopeKind.ROOM: action.room, ScopeKind.ROUTINE: action.routine}[scope.kind]
    return scope.ref is not None and ref is not None and scope.ref == ref


def _command_matches(patterns: Sequence[str], view: _View, restrictive: bool) -> str | None:
    if view.whole is None:
        return None
    pats = [_squash(_fold(p)) for p in patterns]
    if restrictive:
        for pat in pats:
            if any(glob_match(form, v) for form in _destination_forms(pat) for v in view.variants):
                return pat
        return None
    # allow/explicit: EVERY segment, as written, must match; a whole-string `*` never covers a second command
    if not view.segments:
        return None
    for segment in view.segments:
        if not any(glob_match(pat, segment) for pat in pats):
            return None
    return pats[0]


# ---- the `path` fact and its conditions (docs/contracts/rules-conditions-v0.md) ----------------------------------------------------
PATH_FACT = "path"
PATH_KEYS = {"path": "eq", "path:under": "under", "path:glob": "glob"}   # the operator lives in the key: storage stays (fact, value)
PATH_TOOLS = ("write_file", "patch")                                      # the tools with a path adapter, by exact name
READ_TOOLS = ("read_file", "search_files")                                # VR-1: the file READ tools carry the path fact too (backend/workspace.py) and are adapters of `ADAPTERS`
FACTS_VERSION = {"path": (0, 6, 0), "recipient": (0, 7, 0)}               # per fact: the first hook that extracts it (rules-conditions-v0 §10)
PATH_FACTS_VERSION = FACTS_VERSION["path"]
RECIPIENT_FACT = "recipient"
RECIPIENT_KEY = "recipient:eq"  # the only operator of 22b; any other `recipient:*` key is reserved (an unknown operator asks always)
RECIPIENT_WORDS = ("origin", "local", "all")
# tool (exact name) -> the facts its adapter extracts. A rule's condition needs an adapter for EVERY fact it uses on EVERY tool it names.
ADAPTERS = {"write_file": ("path",), "patch": ("path",), "read_file": ("path",), "search_files": ("path",), "kanban_create": ("recipient",), "cronjob_manage": ("recipient",)}
UNRESOLVED = "unresolved"
MAX_PATH = 1024
_PLATFORM = re.compile(r"[a-z0-9_-]{1,32}")
_CHAT_ID = re.compile(r"-?[0-9]{1,20}")
_PROFILE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")


def fact_of(key) -> str | None:
    """`path` or `recipient` when this condition key belongs to an adapter fact, else None (a fact with no adapter asks always)."""
    if _path_key(key) is not None:
        return PATH_FACT
    return RECIPIENT_FACT if isinstance(key, str) and _squash(_fold(key)) == RECIPIENT_KEY else None


def fact_name(key) -> str:
    """A fact's name as the engine reads it (folded, squashed): what the screen's simulator facts and a hook's `facts` are keyed by."""
    return _squash(_fold(key)) if isinstance(key, str) else ""


def _path_key(key) -> str | None:
    """The operator of a condition key (`eq`, `under`, `glob`), None when the key is not a path condition."""
    return PATH_KEYS.get(_squash(_fold(key))) if isinstance(key, str) else None


path_op = _path_key  # public: rules_store / rules_service read and write the operator that lives in the key


def _recipient_tag(tag):
    """`origin`, `local`, `all` (a cron job's delivery words), `bot:<profile>` (a handoff's assignee or a `bot-chat`, by the profile's real name) or
    `chat:<platform>:<chat_id>` (a plain integer; the thread dropped) -> (kind, rest); None for anything else (`unresolved` included)."""
    if not isinstance(tag, str) or not 0 < len(tag) <= 300 or "\x00" in tag:
        return None
    if tag in RECIPIENT_WORDS:
        return tag, ""
    kind, sep, rest = tag.partition(":")
    if sep and kind == "chat":
        platform, colon, chat = rest.partition(":")
        if colon and _PLATFORM.fullmatch(platform) and _CHAT_ID.fullmatch(chat):
            return kind, rest
    elif sep and kind == "bot" and _PROFILE_NAME.fullmatch(rest):
        return kind, rest
    return None


def recipient_pattern_ok(value) -> bool:
    return _recipient_tag(value) is not None


def _split_tag(tag) -> tuple[str, list[str]] | None:
    """`workspace:<rel>` / `abs:<path>` -> (kind, segments); None when it is not a well-formed tag (`unresolved` included).
    No empty, `.` or `..` segment, no NUL, no leading `/` after `workspace:`, a leading `/` after `abs:`."""
    if not isinstance(tag, str) or not 0 < len(tag) <= MAX_PATH or "\x00" in tag:
        return None
    kind, sep, rest = tag.partition(":")
    if not sep or kind not in ("workspace", "abs"):
        return None
    if kind == "abs":
        if not rest.startswith("/"):
            return None
        rest = rest[1:]
        if rest == "":
            return kind, []
    elif rest.startswith("/") or rest == "":
        return None
    segments = rest.split("/")
    if any(seg in ("", ".", "..") for seg in segments):
        return None
    return kind, segments


def path_pattern_ok(op: str, value) -> bool:
    """A condition value a rule may hold: tag-shaped; `under` has no wildcard; `glob` has `*` and `?` inside a segment and `**` only as
    a WHOLE segment; no backslash anywhere (no escapes: a literal `*` in a file name is not expressible, on purpose)."""
    parts = _split_tag(value)
    if parts is None or "\\" in value:
        return False
    if op in ("eq", "under"):
        return not any(c in value for c in "*?")
    if op != "glob":
        return False
    return all(seg == "**" or "**" not in seg for seg in parts[1])


def _seg_match(pattern: str, text: str) -> bool:
    return glob_match(pattern, text)  # `*` and `?` on ONE segment: linear, and a segment holds no `/`


def path_glob_match(pattern_segments: Sequence[str], segments: Sequence[str]) -> bool:
    """Segment-aware glob: `*` and `?` stay inside a segment, a whole-segment `**` takes zero or more segments. Linear in
    len(pattern) x len(path) (no backtracking blow-up)."""
    n, m = len(pattern_segments), len(segments)
    ahead = [False] * (m + 1)
    ahead[m] = True
    for i in range(n - 1, -1, -1):
        row = [False] * (m + 1)
        if pattern_segments[i] == "**":
            row[m] = ahead[m]
            for j in range(m - 1, -1, -1):
                row[j] = ahead[j] or row[j + 1]
            row[m] = ahead[m]
        else:
            for j in range(m - 1, -1, -1):
                row[j] = ahead[j + 1] and _seg_match(pattern_segments[i], segments[j])
        ahead = row
    return ahead[0]


def _fold_segment(text: str) -> str:
    return _fold(text)  # the engine's own fold (NFKC + case), applied to ONE segment, never to the whole path


def _tag_segments(text: str, restrictive: bool) -> tuple[str, list[str]] | None:
    """Split FIRST, fold each segment after: folding the whole text could turn a compatibility character (a fullwidth dot or slash) into
    `..` or `/` and make a real path under `pages/` unreadable (a bypass). RESTRICTIVE folds (NFKC + case: it matches more, so more is
    asked or blocked); PERMISSIVE keeps the exact NFC text (it matches less: a different spelling asks again). Never squashed."""
    parts = _split_tag(unicodedata.normalize("NFC", text))
    if parts is None:
        return None
    kind, segments = parts
    return (kind, [_fold_segment(x) for x in segments]) if restrictive else (kind, segments)


def _path_matches(op: str, value: str, tag: str, restrictive: bool) -> bool:
    want, got = _tag_segments(value, restrictive), _tag_segments(tag, restrictive)
    if want is None or got is None or want[0] != got[0]:
        return False
    if op == "eq":
        return want[1] == got[1]
    if op == "under":
        return got[1][:len(want[1])] == want[1]  # the directory itself or anything below it, by whole segments
    return path_glob_match(want[1], got[1])


def _paths_hold(conditions: Sequence[tuple[str, str]], tags: Sequence[str], restrictive: bool) -> bool:
    """All the path conditions against the call's path tags. A tag that is `unresolved`, malformed, or absent (no tags at all) resolves to
    the stricter outcome: a RESTRICTIVE rule matches it, a PERMISSIVE one does not. Several tags: restrictive = any, permissive = all."""
    tags = [unicodedata.normalize("NFC", t) if isinstance(t, str) else UNRESOLVED for t in tags] or [UNRESOLVED]
    for key, value in conditions:
        op = _path_key(key)
        if op is None:
            continue
        usable = path_pattern_ok(op, value)
        if restrictive:
            if not usable:
                continue  # a stored value that is not tag-shaped cannot be read: fail closed (the rule keeps asking)
            if not any(_split_tag(t) is None or _path_matches(op, value, t, True) for t in tags):
                return False
        else:
            if not usable or not all(_split_tag(t) is not None and _path_matches(op, value, t, False) for t in tags):
                return False
    return True


def _recipients_hold(conditions: Sequence[tuple[str, str]], tags: Sequence[str], restrictive: bool) -> bool:
    """The `recipient` conditions (equality) against the call's recipient tags: the same frame as the paths. A tag that is `unresolved`, malformed, or absent
    (no tag at all: an empty list is NEVER an empty truth that lets an allow through) resolves to the stricter outcome. Restrictive = any recipient, permissive
    = all of them; restrictive compares folded (NFKC + case), permissive the exact NFC text."""
    tags = [unicodedata.normalize("NFC", t) if isinstance(t, str) else UNRESOLVED for t in tags] or [UNRESOLVED]
    for _key, value in conditions:
        usable = recipient_pattern_ok(value)
        if restrictive:
            if not usable:
                continue  # a stored value that is not a tag cannot be read: fail closed (the rule keeps asking)
            if not any(_recipient_tag(t) is None or _fold_segment(value) == _fold_segment(t) for t in tags):
                return False
        elif not usable or not all(_recipient_tag(t) is not None and unicodedata.normalize("NFC", value) == t for t in tags):
            return False
    return True


def _conditions_hold(conditions: Sequence[tuple[str, str]], facts: tuple[tuple[str, str], ...], restrictive: bool,
                     paths: Sequence[str] = (), recipients: Sequence[str] = ()) -> bool:
    path_conditions = [c for c in conditions if _path_key(c[0]) is not None]
    if path_conditions and not _paths_hold(path_conditions, paths, restrictive):
        return False
    recipient_conditions = [c for c in conditions if fact_of(c[0]) == RECIPIENT_FACT]
    if recipient_conditions and not _recipients_hold(recipient_conditions, recipients, restrictive):
        return False
    for key, value in conditions:
        if fact_of(key) is not None:
            continue
        key, value = _squash(_fold(key)), _squash(_fold(value))
        seen = [v for k, v in facts if k == key]
        if not seen:
            if restrictive:
                continue            # missing fact: fail closed for ask/handback/block
            return False            # ...and no match for allow/explicit
        if restrictive:
            if value not in seen:
                return False
        elif any(v != value for v in seen):  # allow needs every reported value to agree
            return False
    return True


def _match(rule: Rule, view: _View) -> tuple[str, ...] | None:
    m = rule.match
    if not (m.tools or m.toolsets or m.mcp_servers or m.commands or m.conditions):
        return None
    restrictive = rule.level in _RESTRICTIVE
    if not restrictive and not (view.clean and view.allowable):
        return None
    if not restrictive and any(isinstance(p, str) and not _fold_plain(p)[1] for p in (*m.tools, *m.toolsets, *m.mcp_servers, *m.commands, *(text for key, value in m.conditions if fact_of(key) is None for text in (key, value)))):
        return None   # a permission written with such a character covers nothing, even when it was stored before validate_rule said so: it would cover ANOTHER host, name or fact than the one it writes (A-210, A-217)
    on: list[str] = []
    if m.tools:
        hit = next((p for p in (_canon_pattern(p) for p in m.tools) if glob_match(p, view.tool)), None)
        if hit is None:
            return None
        on.append("tool:" + hit)
    if m.toolsets:
        if view.toolset is None or view.toolset not in {canon_name(t)[0] for t in m.toolsets}:
            return None
        on.append("toolset:" + view.toolset)
    if m.mcp_servers:
        if view.server is None or view.server not in {canon_name(t)[0] for t in m.mcp_servers}:
            return None
        on.append("mcp:" + view.server)
    if m.commands:
        hit = _command_matches(m.commands, view, restrictive)
        if hit is None:
            return None
        on.append("command:" + hit)
    if m.conditions:
        if not _conditions_hold(m.conditions, view.facts, restrictive, view.paths, view.recipients):
            return None
        on.append("conditions")
    return tuple(sorted(on))


def _evaluate_full(rules: Sequence[Rule], action: Action) -> tuple[Decision, tuple[Rule, ...]]:
    if not isinstance(action, Action):
        return Decision(Level.ASK, None, (), ReasonCode.NONCANONICAL_ACTION), ()
    view = _view(action)
    found: list[tuple[tuple, RuleHit, Rule]] = []
    try:
        candidates = list(rules)
    except TypeError:
        return Decision(Level.ASK, None, (), ReasonCode.NONCANONICAL_ACTION), ()  # unreadable rules: fail closed
    for rule in candidates:
        if not isinstance(rule, Rule) or rule.state is not RuleState.ACTIVE or not _applies(rule, action):
            continue
        on = _match(rule, view)
        if on is None:
            continue
        hit = RuleHit(rule.id, rule.level, rule.scope, rule.builtin, on)
        key = (-RANK[rule.level], _SCOPE_ORDER[rule.scope.kind], rule.id, rule.scope.ref or "", on, rule.builtin)
        found.append((key, hit, rule))
    found.sort(key=lambda item: item[0])
    hits = tuple(item[1] for item in found)
    ordered = tuple(item[2] for item in found)
    if not hits:
        effect, winner, reason = Level.ALLOW, None, ReasonCode.DEFAULT_ALLOW
    else:
        top = hits[0]
        effect, winner = top.level, top.rule_id
        lower = any(RANK[h.level] < RANK[effect] for h in hits)
        if effect is Level.ASK and lower:
            reason = ReasonCode.ASK_BEATS_ALLOW
        elif effect in (Level.BLOCK, Level.HANDBACK) and lower:
            reason = ReasonCode.STRICTER_WINS
        else:
            reason = ReasonCode.SINGLE_RULE
    if not view.clean and RANK[effect] < RANK[Level.ASK]:
        effect, winner, reason = Level.ASK, None, ReasonCode.NONCANONICAL_ACTION
    return Decision(effect, winner, hits, reason), ordered


def evaluate(rules: Sequence[Rule], action: Action) -> Decision:
    return _evaluate_full(rules, action)[0]


# --------------------------------------------------------------------------------------------------------------------
# lifecycle: the only way a Rule changes state
# --------------------------------------------------------------------------------------------------------------------
def _require_human(actor) -> None:
    if not isinstance(actor, Actor) or actor.kind is not ActorKind.HUMAN:
        raise RuleError("human_required")
    if not isinstance(actor.id, str) or not actor.id.strip() or actor.id.startswith(("bot:", "system")):
        raise RuleError("human_required")


def _require_plain(rule: Rule) -> None:
    if rule.builtin or rule.origin is Origin.BUILTIN:
        raise RuleError("builtin_immutable")


def _usable_name(name) -> bool:
    """A RESTRICTIVE rule may name a toolset or an MCP server by its raw key whatever its letters (`cafe` with an accent, `gestao` with a tilde: the person's own text, and the matcher already reads it): not empty, not longer than a tool name, no
    invisible character, no space, and no glob character (a `*` here is read as a letter, so the rule would block nothing and say nothing) (A-216)."""
    return isinstance(name, str) and 0 < len(name) <= MAX_TOOL and not any(_invisible(c) or c.isspace() or c in "*?[]" for c in name)


def validate_rule(rule: Rule) -> tuple[Problem, ...]:
    """Never raises. Codes: malformed, bad_id, reserved_id, empty_match, bad_glob, scope_ref, builtin_mismatch,
    level_origin_mismatch."""
    problems: list[Problem] = []
    try:
        if not isinstance(rule, Rule):
            return (Problem("malformed", "not a Rule"),)
        if not isinstance(rule.id, str) or not _ID_RE.fullmatch(rule.id):
            problems.append(Problem("bad_id", "id must be 1-64 characters of letters, digits and ._:-"))
        elif rule.id.startswith("builtin.") and not rule.builtin:
            problems.append(Problem("reserved_id", "the builtin. namespace is reserved"))
        m = rule.match
        if not isinstance(m, Match) or not (m.tools or m.toolsets or m.mcp_servers or m.commands or m.conditions):
            problems.append(Problem("empty_match", "a rule that matches nothing"))
        else:
            for field, items in (("tools", m.tools), ("commands", m.commands)):
                for pattern in items:
                    text = pattern if isinstance(pattern, str) else ""
                    folded = _canon_pattern(text) if field == "tools" else _squash(_fold(text))
                    if (not folded or len(text) > MAX_PATTERN or text != text.strip()
                            or any(_invisible(c) for c in text)
                            or (field == "tools" and any(c.isspace() for c in text))):
                        problems.append(Problem("bad_glob", f"{field}: unusable pattern"))
                    if rule.level not in _RESTRICTIVE and not _fold_plain(text)[1]:
                        problems.append(Problem("fold_divergence", _FOLD_DIVERGENCE))   # a restrictive pattern is fine: it only matches more (A-210)
            for field, items in (("toolsets", m.toolsets), ("mcp_servers", m.mcp_servers)):
                for name in items:
                    permissive = rule.level not in _RESTRICTIVE
                    lossy = isinstance(name, str) and not _fold_plain(name)[1]
                    if lossy and permissive:
                        problems.append(Problem("fold_divergence", _FOLD_DIVERGENCE))
                    elif not (canon_name(name)[1] if permissive else _usable_name(name)):   # a restrictive rule takes any usable name, a permissive one only a plain identifier (A-216)
                        problems.append(Problem("bad_glob", f"{field}: not a plain name"))
            if rule.level not in _RESTRICTIVE:   # the key and the value of a condition on a fact other than path and recipient are folded on both sides, so the rule would cover another fact (A-217)
                for key, value in m.conditions:
                    if fact_of(key) is None and not all(_fold_plain(text)[1] for text in (key, value) if isinstance(text, str)):
                        problems.append(Problem("fold_divergence", _FOLD_DIVERGENCE))
            path_conditions = [c for c in m.conditions if _path_key(c[0]) is not None]
            for key, value in path_conditions:
                if not path_pattern_ok(PATH_KEYS[_squash(_fold(key))], value):
                    problems.append(Problem("bad_path_condition", "a path condition is a workspace:/abs: pattern: no .. segment, `**` only whole"))
            for _key, value in [c for c in m.conditions if fact_of(c[0]) == RECIPIENT_FACT]:
                if not recipient_pattern_ok(value):
                    problems.append(Problem("bad_recipient_condition", "a recipient condition is chat:<platform>:<chat id> or bot:<profile>"))
            families = {fact_of(c[0]) for c in m.conditions} - {None}
            if families and (not m.tools or m.toolsets or m.mcp_servers or m.commands
                             or any(canon_name(t)[0] != t or not families <= set(ADAPTERS.get(t, ())) for t in m.tools)):
                if families == {PATH_FACT}:
                    problems.append(Problem("path_condition_needs_file_tools",
                                            "a path condition goes with write_file, patch, read_file and/or search_files, by exact name: no toolset, server, command or glob"))
                else:  # every exact tool needs an adapter for EVERY fact the rule uses (no tool has both path and recipient)
                    problems.append(Problem("condition_needs_adapter_tools",
                                            "a recipient condition goes with kanban_create and/or cronjob_manage, by exact name, and every tool named needs an "
                                            "adapter for every fact the rule uses: no toolset, server, command or glob"))
        scope = rule.scope
        if (scope.kind is ScopeKind.GLOBAL) != (scope.ref is None):
            problems.append(Problem("scope_ref", "global rules have no ref; every other scope needs one"))
        if rule.builtin != (rule.origin is Origin.BUILTIN):
            problems.append(Problem("builtin_mismatch", "builtin flag and origin disagree"))
        if rule.origin is Origin.ALWAYS_ALLOW and rule.level not in (Level.ALLOW, Level.EXPLICIT):
            problems.append(Problem("level_origin_mismatch", "an always-allow draft is allow or explicit"))
    except Exception:  # noqa: BLE001  (a validator never raises; garbage is a finding)
        problems.append(Problem("malformed", "unreadable rule"))
    return tuple(sorted(set(problems), key=lambda p: (p.code, p.detail)))


def activate(rule: Rule, *, actor: Actor, now_version: int) -> Rule:
    _require_human(actor)
    _require_plain(rule)
    if rule.state is not RuleState.DRAFT:
        raise RuleError("not_a_draft")
    if isinstance(now_version, bool) or not isinstance(now_version, int) or now_version <= rule.version:
        raise RuleError("stale_version")
    if validate_rule(rule):
        raise RuleError("invalid_rule")
    return replace(rule, state=RuleState.ACTIVE, version=now_version, updated_by=actor.id)


def archive(rule: Rule, *, actor: Actor) -> Rule:
    _require_human(actor)
    _require_plain(rule)
    if rule.state is RuleState.ARCHIVED:
        return rule
    return replace(rule, state=RuleState.ARCHIVED, version=rule.version + 1, updated_by=actor.id)


def draft_from_suggestion(rule: Rule, *, actor: Actor) -> Rule:
    _require_human(actor)
    _require_plain(rule)
    if rule.state is not RuleState.SUGGESTION:
        raise RuleError("not_a_suggestion")
    return replace(rule, state=RuleState.DRAFT, version=rule.version + 1, updated_by=actor.id)


def _checked_id(rule_id: str) -> str:
    if not isinstance(rule_id, str) or not _ID_RE.fullmatch(rule_id):
        raise RuleError("bad_id")
    if rule_id.startswith("builtin."):
        raise RuleError("reserved_id")
    return rule_id


def draft_from_always_allow(action: Action, *, label: str, level: Level = Level.ALLOW, rule_id: str) -> Rule:
    """The card's "Always allow": a DRAFT for the Bot, matching exactly this tool and (escaped) command. Never active."""
    if level not in (Level.ALLOW, Level.EXPLICIT):
        raise RuleError("bad_level")
    if any(isinstance(text, str) and not _fold_plain(text[:MAX_COMMAND])[1] for text in (action.tool, action.toolset, action.mcp_server, action.command)):
        raise RuleError("fold_divergence")   # the draft would cover ANOTHER host or name than the one the person saw: refused at birth, with the code the card draws (A-211)
    view = _view(action)
    if not view.clean or not view.tool:
        raise RuleError("noncanonical_action")
    commands: tuple[str, ...] = ()
    if view.whole is not None:
        pattern = _escape(view.whole)
        if not view.whole or len(pattern) > MAX_PATTERN:
            raise RuleError("command_too_long")
        commands = (pattern,)
    conditions = tuple(dict.fromkeys(view.facts))
    if len(view.paths) > 1:
        raise RuleError("multiple_paths")  # two exact paths never hold together: no draft, the person is asked each time (fail closed)
    if view.paths:
        if not path_pattern_ok("eq", view.paths[0]):
            raise RuleError("unusable_path")  # `unresolved`, malformed or with a wildcard: not something a rule can name
        conditions += ((PATH_FACT, view.paths[0]),)
    if len(view.recipients) > 1:
        raise RuleError("multiple_recipients")  # two exact recipients never hold together: no draft, the person is asked each time
    if view.recipients:
        if not recipient_pattern_ok(view.recipients[0]):
            raise RuleError("unusable_recipient")
        conditions += ((RECIPIENT_KEY, view.recipients[0]),)
    return Rule(id=_checked_id(rule_id), label=str(label)[:120], level=level, scope=Scope(ScopeKind.BOT, action.bot),
                match=Match(tools=(_escape(view.tool),), commands=commands, conditions=conditions),
                state=RuleState.DRAFT, origin=Origin.ALWAYS_ALLOW, builtin=False)


def propose_from_agent(label: str, level: Level, scope: Scope, match: Match, *, bot: str, rule_id: str) -> Rule:
    """Whatever an agent asks for, the result is an inert SUGGESTION."""
    return Rule(id=_checked_id(rule_id), label=str(label)[:120], level=level, scope=scope, match=match,
                state=RuleState.SUGGESTION, origin=Origin.BOT_SUGGESTION, builtin=False, updated_by=f"bot:{bot}")


def builtin_rules() -> tuple[Rule, ...]:
    out = []
    for rule_id, label, level, tools, commands in FAMILIES:
        out.append(Rule(rule_id, label, Level(level), Scope(ScopeKind.GLOBAL), Match(tools=tools), RuleState.ACTIVE,
                        Origin.BUILTIN, builtin=True, updated_by="system"))
        if commands:
            out.append(Rule(rule_id + ".commands", label + " (commands)", Level(level), Scope(ScopeKind.GLOBAL),
                            Match(commands=commands), RuleState.ACTIVE, Origin.BUILTIN, builtin=True, updated_by="system"))
    return tuple(out)


# --------------------------------------------------------------------------------------------------------------------
# hook table
# --------------------------------------------------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class HookEntry:
    rule_id: str
    verdict: str                 # "approve" | "block"
    tools: tuple[str, ...]       # globs; toolsets / mcp_servers already expanded to tool names
    commands: tuple[str, ...]
    message: str                 # short code, e.g. "luvebot:ask:<rule_id>"; UI text lives in the UI
    strict: bool                 # ask rules: the hook must block if approvals are off (ADR 4.4)
    paths: tuple[tuple[str, str], ...] = ()  # rules-conditions-v0: (op, value) path conditions, all must hold; () = none (the key is then absent)
    recipients: tuple[tuple[str, str], ...] = ()  # §10: (`eq`, tag) recipient conditions, all must hold; () = none (the key is then absent)


_ENTRY_KEYS = frozenset({"rule_id", "verdict", "tools", "commands", "message", "strict"})


def _entry_dict(e: HookEntry) -> dict:
    out = {"rule_id": e.rule_id, "verdict": e.verdict, "tools": list(e.tools), "commands": list(e.commands),
           "message": e.message, "strict": e.strict}
    if e.paths:  # absent when empty, so a table with no path rule keeps its digest and a hook 0.5 keeps reading it (it rejects the key)
        out["paths"] = [list(c) for c in e.paths]
    if e.recipients:  # the same for recipients: a hook 0.6.0 rejects the key and asks about everything (the seal says hook_outdated)
        out["recipients"] = [list(c) for c in e.recipients]
    return out


def _table_digest(entries: Sequence[HookEntry]) -> str:
    ordered = sorted(entries, key=lambda e: (e.rule_id, e.verdict))
    return hashlib.sha256(json.dumps([_entry_dict(e) for e in ordered], sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=True).encode()).hexdigest()


def _bad_constant(_name):
    raise ValueError("non-finite number")


@dataclass(frozen=True, slots=True)
class HookTable:
    version: int
    digest: str                  # sha256 of the canonical JSON of the entries (sorted keys)
    entries: tuple[HookEntry, ...]
    problems: tuple[Problem, ...] = ()   # what could not be enforced (not part of the digest)

    def to_json(self) -> str:
        return json.dumps({"version": self.version, "digest": self.digest,
                           "entries": [_entry_dict(e) for e in self.entries],
                           "problems": [{"code": p.code, "detail": p.detail} for p in self.problems]},
                          sort_keys=True, separators=(",", ":"), ensure_ascii=True)

    @staticmethod
    def from_json(text: str) -> "HookTable":
        """Strict: anything malformed raises RuleError("bad_table"); the caller (the hook) then asks about everything."""
        try:
            data = json.loads(text, parse_constant=_bad_constant)
            if not isinstance(data, dict) or set(data) != {"version", "digest", "entries", "problems"}:
                raise ValueError("shape")
            version, digest = data["version"], data["digest"]
            if isinstance(version, bool) or not isinstance(version, int) or version < 0 or not isinstance(digest, str):
                raise ValueError("header")
            entries = []
            for raw in data["entries"]:
                if (not isinstance(raw, dict) or not _ENTRY_KEYS <= set(raw) <= _ENTRY_KEYS | {"paths", "recipients"}
                        or raw["verdict"] not in ("approve", "block") or not isinstance(raw["strict"], bool)
                        or not isinstance(raw["rule_id"], str) or not isinstance(raw["message"], str)
                        or not isinstance(raw["tools"], list) or not isinstance(raw["commands"], list)
                        or not all(isinstance(x, str) for x in raw["tools"] + raw["commands"])):
                    raise ValueError("entry")
                paths = raw.get("paths", [])
                if (not isinstance(paths, list) or ("paths" in raw and not paths)
                        or not all(isinstance(c, list) and len(c) == 2 and isinstance(c[0], str) and isinstance(c[1], str)
                                   and c[0] in ("eq", "under", "glob") and path_pattern_ok(c[0], c[1]) for c in paths)):
                    raise ValueError("paths")
                recipients = raw.get("recipients", [])
                if (not isinstance(recipients, list) or ("recipients" in raw and not recipients)
                        or not all(isinstance(c, list) and len(c) == 2 and c[0] == "eq" and isinstance(c[1], str) and recipient_pattern_ok(c[1])
                                   for c in recipients)):
                    raise ValueError("recipients")
                entries.append(HookEntry(raw["rule_id"], raw["verdict"], tuple(raw["tools"]), tuple(raw["commands"]),
                                         raw["message"], raw["strict"], tuple((c[0], c[1]) for c in paths),
                                         tuple((c[0], c[1]) for c in recipients)))
            problems = []
            for raw in data["problems"]:
                if not isinstance(raw, dict) or set(raw) != {"code", "detail"} or not all(isinstance(v, str) for v in raw.values()):
                    raise ValueError("problem")
                problems.append(Problem(raw["code"], raw["detail"]))
            table = HookTable(version, digest, tuple(entries), tuple(problems))
            if table.digest != _table_digest(table.entries):
                raise ValueError("digest")
            return table
        except (ValueError, TypeError, RecursionError):
            raise RuleError("bad_table") from None


def _expansion(names, mapping: dict[str, frozenset[str]], kind: str, problems: list[Problem]) -> set[str]:
    out: set[str] = set()
    for name in names:
        key = canon_name(name)[0]
        if key not in mapping:
            problems.append(Problem(kind, key))
        else:
            out |= mapping[key]
    return out


def compile_hook_table(rules: Sequence[Rule], *, version: int, toolset_tools: Mapping[str, tuple[str, ...]],
                       mcp_server_tools: Mapping[str, tuple[str, ...]]) -> HookTable:
    """`rules` must be the rules of ONE Bot (the hook cannot tell Bots apart). ROOM / ROUTINE rules are widened to the
    whole Bot (fail closed) and reported."""
    tmap = {canon_name(k)[0]: frozenset(canon_name(t)[0] for t in v) for k, v in toolset_tools.items()}
    smap = {canon_name(k)[0]: frozenset(canon_name(t)[0] for t in v) for k, v in mcp_server_tools.items()}
    entries: list[HookEntry] = []
    problems: list[Problem] = []
    seen: set[str] = set()
    for rule in rules:
        if not isinstance(rule, Rule) or rule.state is not RuleState.ACTIVE or rule.level not in _RESTRICTIVE:
            continue
        if rule.id in seen:
            raise RuleError("duplicate_rule_id")
        seen.add(rule.id)
        m = rule.match
        if not (m.tools or m.toolsets or m.mcp_servers or m.commands or m.conditions):
            continue
        if rule.scope.kind in (ScopeKind.ROOM, ScopeKind.ROUTINE):
            problems.append(Problem("scope_widened", rule.id))
        if any(fact_of(c[0]) is None for c in m.conditions):  # path (hook 0.6.0) and recipient (0.7.0) are enforced by the hook; any other fact is not
            problems.append(Problem("condition_not_enforceable", rule.id))
        paths = tuple((PATH_KEYS[_squash(_fold(c[0]))], c[1]) for c in m.conditions if _path_key(c[0]) is not None)
        recipients = tuple(("eq", c[1]) for c in m.conditions if fact_of(c[0]) == RECIPIENT_FACT)
        globs = {_canon_pattern(p) for p in m.tools}
        names: set[str] | None = None
        if m.toolsets:
            names = _expansion(m.toolsets, tmap, "unknown_toolset", problems)
        if m.mcp_servers:
            found = _expansion(m.mcp_servers, smap, "unknown_mcp_server", problems)
            names = found if names is None else names & found
        commands = tuple(sorted({form for c in m.commands for form in _destination_forms(_squash(_fold(c)))}))   # both forms of a destination pattern (A-199)
        if names is not None:
            tools = tuple(sorted(n for n in names if not globs or any(glob_match(g, n) for g in globs)))
            if not tools:
                problems.append(Problem("empty_expansion", rule.id))
                continue
        elif globs:
            tools = tuple(sorted(globs))
        elif commands:
            tools = ()
        else:
            tools = ("*",)  # conditions only: cannot be evaluated here, so it fires on every tool
        ask = rule.level is Level.ASK
        entries.append(HookEntry(rule.id, "approve" if ask else "block", tools, commands,
                                 f"luvebot:{rule.level.value}:{rule.id}", ask, paths, recipients))
    entries.sort(key=lambda e: (e.rule_id, e.verdict))
    return HookTable(version, _table_digest(entries), tuple(entries),
                     tuple(sorted(set(problems), key=lambda p: (p.code, p.detail))))


@dataclass(frozen=True, slots=True)
class HookVerdict:
    action: str                  # "none" | "approve" | "block"
    rule_id: str | None
    message: str | None
    strict: bool


def _fact_list(facts, name: str) -> tuple:
    """The tags the hook gave for one fact: from a mapping by name, from a plain list (the 0.6.0 form) for `path` only; anything else is none."""
    if isinstance(facts, Mapping):
        found = facts.get(name)
        return tuple(found) if isinstance(found, (list, tuple)) else ()
    return tuple(facts) if name == PATH_FACT and isinstance(facts, (list, tuple)) else ()


def hook_verdict(table: HookTable, *, tool: str, command: str | None,
                 facts: Mapping[str, Sequence[str]] | Sequence[str] | None = None) -> HookVerdict:
    """O(entries). block beats approve; the first entry in id order breaks ties; no match -> "none" unless the spelling
    of the call is not canonical (then approve: the old engine's lesson). `facts` = the path tags the hook extracted for this call
    (rules-conditions-v0 §2); None or empty means `unresolved` (one way to say it): an entry with path conditions then matches. From hook 0.7.0 `facts` is
    a mapping `{"path": [...], "recipient": [...]}`; a plain list is the path tags (0.6.0). A name missing from the mapping = no adapter = unresolved."""
    if not isinstance(table, HookTable):
        raise RuleError("bad_table")
    name, clean = canon_name(tool)
    view = _view(Action(bot="", tool=tool if isinstance(tool, str) else "", command=command))
    clean = clean and view.clean
    approve = None
    for entry in table.entries:
        if not entry.tools and not entry.commands:
            continue
        if entry.tools and not any(glob_match(g, name) for g in entry.tools):
            continue
        if entry.commands and not any(glob_match(c, v) for c in entry.commands for v in view.variants):
            continue
        if entry.paths and not _paths_hold(tuple(("path" if op == "eq" else f"path:{op}", value) for op, value in entry.paths),
                                           _fact_list(facts, PATH_FACT), True):
            continue
        if entry.recipients and not _recipients_hold(tuple((RECIPIENT_FACT, value) for _op, value in entry.recipients),
                                                     _fact_list(facts, RECIPIENT_FACT), True):
            continue
        if entry.verdict == "block":
            return HookVerdict("block", entry.rule_id, entry.message, entry.strict)
        if approve is None:
            approve = HookVerdict("approve", entry.rule_id, entry.message, entry.strict)
    if approve is not None:
        return approve
    if not clean:
        return HookVerdict("approve", None, "luvebot:noncanonical", True)
    return HookVerdict("none", None, None, False)


# --------------------------------------------------------------------------------------------------------------------
# live state and seals
# --------------------------------------------------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class PlatformTools:
    platform: str
    enabled_toolsets: frozenset[str]


@dataclass(frozen=True, slots=True)
class McpServerState:
    name: str
    enabled: bool
    trust: str
    include: tuple[str, ...] | None
    exclude: tuple[str, ...]
    tool_names: tuple[str, ...] | None = None  # RAW tool names the live server reports (T1.4c); None = no live list


@dataclass(frozen=True, slots=True)
class ApprovalsState:
    mode: str
    deny: tuple[str, ...]
    cron_mode: str
    unattended_mode: str
    timeout: int
    transport: str
    transport_fallback: str | None
    allowlist: frozenset[str]


@dataclass(frozen=True, slots=True)
class HookState:
    registered: bool
    heartbeat_age_s: float | None
    table_digest: str | None
    plugin_version: str | None = None  # from the heartbeat; None = unknown (proposal v0.5 2.7, S1)
    surface_digest: str | None = None  # the approval surface the hook says it applies (D-025)


@dataclass(frozen=True, slots=True)
class ApprovalSurfaceState:
    """D-025: where this Bot's approvals are answered. `mode` luvebot | channel | free; `approvers` named `<platform>:<id>`; `digest` of
    the stored configuration (None = the default, never stored); `allow_all` = the gateway lets every sender in (or unreadable)."""
    mode: str
    approvers: tuple[str, ...]
    digest: str | None
    allow_all: bool


@dataclass(frozen=True, slots=True)
class SoulState:
    block_present: bool
    block_digest: str | None


@dataclass(frozen=True, slots=True)
class RoomPolicyState:
    enabled_toolsets: frozenset[str]
    approval_mode: str


@dataclass(frozen=True, slots=True)
class LiveState:
    profile: str
    surfaces: tuple[str, ...]                   # "api_server", "cron", "telegram", ..., "room"
    platform_tools: tuple[PlatformTools, ...]   # one per non-room surface with toolsets
    mcp: tuple[McpServerState, ...]
    approvals: ApprovalsState
    hook: HookState
    soul: SoulState
    room_policy: RoomPolicyState | None
    terminal_backend: str
    read_at: float
    approval_surface: ApprovalSurfaceState | None = None  # None = not read: the S1 default (`luvebot`) applies
    session_authority: bool = False  # this Hermes runs the gateway's session authority (v0.22.3+): its requests carry only the hook's message


@dataclass(frozen=True, slots=True)
class Mechanism:
    id: MechanismId
    verified: bool               # holds on EVERY surface of the Bot (partial coverage is listed in `covers`, unverified)
    covers: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class SealResult:
    seal: Seal
    mechanisms: tuple[Mechanism, ...]
    problems: tuple[Problem, ...]
    qualifiers: tuple[str, ...]  # channels_block, channel_dm:<platform>, routine_block, pattern, writes_only, condition_ignored,
    #                              next_session, yolo_session_invisible, handback, hermes_may_ask, room_hermes_asks (free mode)


# Problem codes (closed list; the last three were added with Assumed R-13): uncovered_surface, toolset_still_enabled,
# mcp_still_enabled, hook_missing, hook_stale, hook_digest_mismatch, not_applied, approvals_off, smart_mode,
# allowlist_covers, cron_auto_approve, unattended_auto_approve, room_policy, transport_fallback_builtin,
# soul_block_missing, applied_drift, container_backend_skips_gate, no_mechanism, and with S1 (proposal v0.5 2.7)
# channel_approval_outside and permanent_allow_leak, and with D-025 channel_config_unsafe, and with the `free` surface free_mode
_CONTAINER_BACKENDS = frozenset({"docker", "singularity", "modal", "daytona", "vercel_sandbox"})
_NO_TOOLSETS = frozenset({"room"})


CHANNEL_BLOCK_VERSION = (0, 2, 0)  # the hook that turns an approval asked on a channel into a block (S1)
_NO_CHANNEL = frozenset({"api_server", "cron", "room"})


def _version(text: str | None) -> tuple[int, ...] | None:
    match = re.fullmatch(r"(\d{1,4})\.(\d{1,4})\.(\d{1,4})", text or "")
    return tuple(int(g) for g in match.groups()) if match else None


def _channel_problems(state: LiveState, surfaces: tuple[str, ...], hook_ok: bool) -> tuple[list[Problem], bool]:
    """S1 for an ASK rule: on a messaging channel Hermes would ask through a button in that channel, answered by whoever the
    channel allows. Only a LIVE hook at 0.2.0 or later turns that into a block (and says so); an older hook, one whose version is
    unknown, or one that is not live (an approval by MCP trust alone is Hermes's own channel prompt) leaves the approval outside
    LuveBot: BROKEN, never a quiet `note`. -> (problems, channels are blocked)."""
    channels = [s for s in surfaces if s not in _NO_CHANNEL]
    if not channels:
        return [], False
    version = _version(state.hook.plugin_version)
    if hook_ok and version is not None and version >= CHANNEL_BLOCK_VERSION:
        return [], True
    return [Problem("channel_approval_outside", ", ".join(channels))], False


CHANNEL_SURFACE_VERSION = (0, 3, 0)          # the hook that can send an approval to a named approver's private chat (D-025)
CHANNEL_APPROVAL_PLATFORMS = ("telegram",)  # the same list as hook_store.CHANNEL_APPROVAL_PLATFORMS (a test keeps them equal)
LINKED_APPROVAL_VERSION = (0, 8, 0)           # the hook that adds `#<event>.<nonce>` to its ask message: without it a canonical Hermes gives LuveBot no link to the call
FREE_VERSION = (0, 4, 0)                     # the hook that reads the `free` surface: it asks nothing of the Bot's own table


def _free(state: LiveState) -> bool:
    return state.approval_surface is not None and state.approval_surface.mode == "free"


def _free_applied(state: LiveState, hook_ok: bool) -> bool:
    """The owner set this Bot to `free` AND a live hook at 0.4.0+ reports this very configuration: then nothing of the Bot's own is
    asked (Block and Handback still stop). Anything less and the older hook is still asking (the seal says `not_applied`)."""
    version = _version(state.hook.plugin_version)
    surface = state.approval_surface
    return (_free(state) and hook_ok and version is not None and version >= FREE_VERSION and surface.digest is not None
            and state.hook.surface_digest == surface.digest)


def _channel_surface(state: LiveState, surfaces: tuple[str, ...], hook_ok: bool) -> tuple[list[Problem], set[str]] | None:
    """D-025, for an ASK rule of a Bot set to `channel` (None for any other Bot: S1 applies). On a supported platform the approval
    is answered in a named approver's private chat (`channel_dm:<platform>`); on any other channel the hook still blocks
    (`channels_block`). It holds only with a LIVE hook at 0.3.0+ that reports this very configuration, and only while the gateway
    does not let everyone in; otherwise BROKEN with the reason."""
    surface = state.approval_surface
    if surface is None or surface.mode != "channel":
        return None
    channels = [s for s in surfaces if s not in _NO_CHANNEL]
    if not channels:
        return [], set()
    problems: list[Problem] = []
    version = _version(state.hook.plugin_version)
    if not (hook_ok and version is not None and version >= CHANNEL_SURFACE_VERSION and surface.digest is not None
            and state.hook.surface_digest == surface.digest):
        problems.append(Problem("not_applied", "the hook does not run this approval surface"))
    if surface.allow_all:
        problems.append(Problem("channel_config_unsafe", "the gateway lets every sender in"))
    if not surface.approvers:
        problems.append(Problem("channel_config_unsafe", "no named approver"))
    quals = {f"channel_dm:{c}" if c in CHANNEL_APPROVAL_PLATFORMS else "channels_block" for c in channels}
    return problems, quals


def _allow_leaks(state: LiveState) -> list[Problem]:
    """A standing `plugin_rule:luvebot:...` entry without an event id (the fixed fail-closed key of hook 0.1.0) approves, in
    every session, whatever the hook sends to a person: every ASK rule of the Bot is then BROKEN until it is removed."""
    leaks = sorted(e for e in state.approvals.allowlist if e.startswith("plugin_rule:luvebot:") and "#" not in e)
    return [Problem("permanent_allow_leak", e) for e in leaks]


def _hook_problems(state: LiveState, expected: str | None, now: float, max_age: float) -> list[Problem]:
    out: list[Problem] = []
    hook = state.hook
    if not hook.registered:
        out.append(Problem("hook_missing", "the LuveBot hook is not registered in the Hermes process"))
    age = hook.heartbeat_age_s
    effective = None if age is None else age + max(0.0, now - state.read_at)
    if effective is None or not (effective <= max_age):  # NaN is stale
        out.append(Problem("hook_stale", "no recent heartbeat from the hook"))
    if expected is None or hook.table_digest is None or hook.table_digest != expected:
        out.append(Problem("hook_digest_mismatch", "the hook runs a different table than the current rules"))
    return out


def _ask_bypasses(rule: Rule, state: LiveState, surfaces: tuple[str, ...]) -> list[Problem]:
    a = state.approvals
    out: list[Problem] = []
    if a.mode == "smart":
        if rule.match.commands:
            out.append(Problem("smart_mode", "an auxiliary LLM may approve commands without a human"))
    elif a.mode != "manual":
        out.append(Problem("approvals_off", f"approvals.mode is {a.mode!r}, not manual"))
    if any(entry == f"plugin_rule:{rule.id}" for entry in a.allowlist) or any(
            _squash(_fold(entry)) == _squash(_fold(c)) for entry in a.allowlist for c in rule.match.commands):
        out.append(Problem("allowlist_covers", "the Hermes allowlist already approves this"))
    if "cron" in surfaces and a.cron_mode == "approve":
        out.append(Problem("cron_auto_approve", "routines approve automatically"))
    if "webhook" in surfaces and a.unattended_mode == "approve":
        out.append(Problem("unattended_auto_approve", "unattended contexts approve automatically"))
    if "room" in surfaces and state.room_policy is not None and (
            state.room_policy.approval_mode == "off" or (state.room_policy.approval_mode == "smart" and rule.match.commands)):
        out.append(Problem("room_policy", "the room policy approves without a human"))
    if a.transport_fallback == "builtin":
        out.append(Problem("transport_fallback_builtin", "the built-in prompt would answer if the transport failed"))
    return out


def _toolset_off(rule: Rule, state: LiveState, surfaces: tuple[str, ...], problems: list[Problem]) -> Mechanism:
    wanted = {canon_name(t)[0] for t in rule.match.toolsets}
    by_platform = {p.platform: {canon_name(t)[0] for t in p.enabled_toolsets} for p in state.platform_tools}
    covers: list[str] = []
    for surface in surfaces:
        if surface == "room":
            policy = state.room_policy
            if policy is None:
                problems.append(Problem("uncovered_surface", "room"))
            elif wanted & {canon_name(t)[0] for t in policy.enabled_toolsets}:
                problems.append(Problem("room_policy", "the room policy still enables the toolset"))
                problems.append(Problem("uncovered_surface", "room"))
            else:
                covers.append(surface)
            continue
        enabled = by_platform.get(surface)
        if enabled is None:
            problems.append(Problem("uncovered_surface", surface))
        elif wanted & enabled:
            problems.append(Problem("toolset_still_enabled", surface))
            problems.append(Problem("uncovered_surface", surface))
        else:
            covers.append(surface)
    return Mechanism(MechanismId.TOOLSET_OFF, len(covers) == len(surfaces) and bool(surfaces), tuple(covers))


def _mcp_off(rule: Rule, state: LiveState, surfaces: tuple[str, ...], problems: list[Problem]) -> Mechanism:
    servers = {canon_name(s.name)[0]: s for s in state.mcp}
    ok = True
    for name in rule.match.mcp_servers:
        s = servers.get(canon_name(name)[0])
        if s is None:
            problems.append(Problem("uncovered_surface", f"mcp server {canon_name(name)[0]} not reported"))
            ok = False
        elif s.enabled:
            problems.append(Problem("mcp_still_enabled", canon_name(name)[0]))
            ok = False
    return Mechanism(MechanismId.MCP_OFF, ok, surfaces if ok else ())


def _hermes_sanitize(value: str) -> str:
    """tools/mcp_tool_schema.py sanitize_mcp_name_component: every character outside [A-Za-z0-9_] becomes `_`."""
    return re.sub(r"[^A-Za-z0-9_]", "_", value)


_MCP_NAME_LIMIT = 64  # Hermes clamps longer registered names with a hash suffix
_MCP_HASH_LENGTH = 8


def hermes_mcp_name(server: str, tool: str) -> str:
    """The name Hermes registers for a server's tool (tools/mcp_tool_schema.py mcp_prefixed_tool_name): `mcp__<server>__<tool>`
    with both parts sanitized, clamped to 64 characters with a deterministic hash suffix."""
    full = f"mcp__{_hermes_sanitize(server)}__{_hermes_sanitize(tool)}"
    if len(full) <= _MCP_NAME_LIMIT:
        return full
    suffix = "_" + hashlib.sha256(full.encode("utf-8")).hexdigest()[:_MCP_HASH_LENGTH]
    return full[:_MCP_NAME_LIMIT - len(suffix)] + suffix


def _hermes_name_filter(name: str, patterns) -> bool:
    """tools/mcp_tool_schema.py matches_name_filter: exact names, or fnmatch globs (case-sensitive) when an entry has * ? [."""
    patterns = set(patterns or ())
    if not patterns:
        return False
    if name in patterns:
        return True
    return any(fnmatch.fnmatchcase(name, p) for p in patterns if "*" in p or "?" in p or "[" in p)


def _filtered_by_hermes(server: McpServerState, raw: str) -> bool:
    """True when Hermes does NOT register this tool (tools/mcp_tool_registration.py _make_tool_filter): the server is off, or an
    `include` list (even empty) exists and omits the RAW name, or there is no include and `exclude` matches the RAW name."""
    if not server.enabled:
        return True
    if server.include is not None:
        return not _hermes_name_filter(raw, server.include)
    return _hermes_name_filter(raw, server.exclude)


def _mcp_exclude(rule: Rule, state: LiveState, surfaces: tuple[str, ...]) -> Mechanism | None:
    """M3 against the LIVE tool list (T1.4c, condition B2 of the second review). Hermes filters MCP tools by the RAW name the
    server reports, not by the sanitized registered name, so the rule's pattern is checked against the registered name of every
    live tool and each tool it covers must be filtered out by include/exclude applied to its raw name. Verified only when at
    least one live tool is covered and none escapes; any server without a live list, or no covered tool at all, is not verified."""
    if not rule.match.tools:
        return None
    unverified = Mechanism(MechanismId.MCP_TOOL_EXCLUDE, False, ())
    if not state.mcp or any(s.tool_names is None for s in state.mcp):
        return unverified
    patterns = [_canon_pattern(p) for p in rule.match.tools]
    covered = False
    for server in state.mcp:
        for raw in server.tool_names or ():
            registered = _fold(hermes_mcp_name(server.name, raw))
            if any(glob_match(p, registered) for p in patterns):
                covered = True
                if not _filtered_by_hermes(server, raw):
                    return unverified
    return Mechanism(MechanismId.MCP_TOOL_EXCLUDE, True, surfaces) if covered else unverified


def _deny_key(glob: str) -> str:
    """tools/approval_floors.py _match_user_deny_rule: `pattern.strip().lower()` and nothing else (no Unicode
    normalization, no whitespace folding)."""
    return glob.strip().lower()


def _approvals_deny(rule: Rule, state: LiveState, surfaces: tuple[str, ...]) -> Mechanism:
    deny = {_deny_key(g) for g in state.approvals.deny}
    ok = all(_deny_key(c) in deny for c in rule.match.commands)
    return Mechanism(MechanismId.APPROVALS_DENY, ok, surfaces if ok else ())


def _drift(rule: Rule, state: LiveState) -> list[Problem]:
    """What LuveBot configured (rule.applied) against what Hermes says now. Never used to GRANT a seal."""
    out: list[Problem] = []
    by_platform = {p.platform: {canon_name(t)[0] for t in p.enabled_toolsets} for p in state.platform_tools}
    servers = {canon_name(s.name)[0]: s for s in state.mcp}
    deny = {_deny_key(g) for g in state.approvals.deny}
    for token in rule.applied:
        kind, _, rest = token.partition(":")
        drifted = False
        if kind == "toolset_off":
            toolset, _, platform = rest.partition("@")
            drifted = canon_name(toolset)[0] in by_platform.get(platform, set())
        elif kind == "mcp_off":
            s = servers.get(canon_name(rest)[0])
            drifted = s is not None and s.enabled
        elif kind == "mcp_exclude":
            server, _, pattern = rest.partition(":")
            s = servers.get(canon_name(server)[0])
            drifted = s is not None and (pattern not in s.exclude or s.include is not None)
        elif kind == "approvals_deny":
            drifted = _deny_key(rest) not in deny
        elif kind == "hook":
            drifted = state.hook.table_digest != rest
        elif kind == "soul":
            drifted = state.soul.block_digest != rest
        if drifted:
            out.append(Problem("applied_drift", token))
    return out


def _hook_table_problems(rule: Rule, hook_rule_ids, hook_problems) -> list[Problem]:
    """The hook route holds for THIS rule only if the compiled table has an entry for it and the compiler did not report
    that it could cover less than the rule says. `hook_rule_ids` None (unknown) is treated as absent: fail closed."""
    out: list[Problem] = []
    if hook_rule_ids is None or rule.id not in hook_rule_ids:
        out.append(Problem("hook_rule_missing", "the compiled hook table has no entry for this rule"))
    named = {canon_name(t)[0] for t in (*rule.match.toolsets, *rule.match.mcp_servers)}
    for problem in hook_problems or ():
        if problem.code in ("unknown_toolset", "unknown_mcp_server") and problem.detail in named:
            out.append(Problem("hook_table_problem", f"{problem.code}: {problem.detail}"))
    return out


def _fact_problems(rule: Rule, state: LiveState) -> list[Problem]:
    """A rule with a path (0.6.0) or recipient (0.7.0) condition needs a hook that sends that fact; an older one rejects the table entry and asks about
    everything, and one whose version is unknown cannot be trusted with it: the seal is BROKEN with `hook_outdated`, never a quiet note."""
    version = _version(state.hook.plugin_version)
    out = []
    for fact, needed in FACTS_VERSION.items():
        if any(fact_of(c[0]) == fact for c in rule.match.conditions) and not (version is not None and version >= needed):
            out.append(Problem("hook_outdated", f"the hook is older than {'.'.join(map(str, needed))} (or its version is unknown): it does not send {fact} facts"))
    return out


def _linked_problems(rule: Rule, state: LiveState) -> list[Problem]:
    """An `ask` rule on a Hermes with the session authority reaches LuveBot as a request that names its call only through the hook's message
    (contract v0.9 1.9). A hook older than LINKED_APPROVAL_VERSION (or of unknown version) does not add the link: each request would be
    `details_unavailable`, so the seal is BROKEN with `hook_outdated`, never a quiet note."""
    version = _version(state.hook.plugin_version)
    if rule.level is Level.ASK and state.session_authority and not (version is not None and version >= LINKED_APPROVAL_VERSION):
        return [Problem("hook_outdated", f"the hook is older than {'.'.join(map(str, LINKED_APPROVAL_VERSION))} (or its version is unknown): on this Hermes "
                                         "its requests would not say what they want to do")]
    return []


def compute_seal(rule: Rule, state: LiveState, *, expected_hook_digest: str | None, now: float,
                 hook_max_age_s: float = 120.0, hook_rule_ids: frozenset[str] | None = None,
                 hook_problems: Sequence[Problem] = ()) -> SealResult:
    """ADR 3.3 / 3.4: the seal of the best set of VERIFIED mechanisms that covers every surface; partial coverage, a
    missing mechanism or any contradiction with the live state is BROKEN with the reasons. Pure and recomputed on every
    read; it never reads `rule.applied` to grant LOCK or HAND, only to report drift."""
    if rule.state is not RuleState.ACTIVE or rule.level is Level.ALLOW:
        return SealResult(Seal.NONE, (), (), ())
    surfaces = tuple(dict.fromkeys(state.surfaces))
    problems: list[Problem] = []
    quals: set[str] = set()
    mechanisms: list[Mechanism] = []
    m = rule.match
    if any(fact_of(c[0]) is None for c in m.conditions):
        quals.add("condition_ignored")
    if any(_path_key(c[0]) is not None for c in m.conditions):
        quals.add("paths_file_tools_only")  # terminal (`echo > f`, `rm`), execute_code and MCP file servers are not seen (rules-conditions-v0 §5)
    if any(fact_of(c[0]) == RECIPIENT_FACT for c in m.conditions):
        quals.add("conditions_adapter_tools_only")  # only kanban_create and cronjob_manage are read: not terminal, execute_code, a mail or messaging MCP, the CLI, cron firing, the kanban notifier
    if rule.scope.kind in (ScopeKind.ROOM, ScopeKind.ROUTINE):
        quals.add("scope_widened")  # the hook cannot tell rooms or routines apart: it applies to the whole Bot
    if not (m.tools or m.toolsets or m.mcp_servers or m.commands or m.conditions):
        return SealResult(Seal.BROKEN, (), (Problem("no_mechanism", "the rule matches nothing"),), ())
    if not surfaces:
        problems.append(Problem("uncovered_surface", "no surface of the Bot is known"))

    if rule.level is Level.EXPLICIT:
        present = state.soul.block_present and bool(state.soul.block_digest)
        mechanisms.append(Mechanism(MechanismId.SOUL, present, surfaces if present else ()))
        if not present:
            problems.append(Problem("soul_block_missing", "the guidance is not written in SOUL.md"))
        problems += _drift(rule, state)
        return _result(Seal.NOTE, mechanisms, problems, quals)

    hook_found = _hook_problems(state, expected_hook_digest, now, hook_max_age_s) + _hook_table_problems(
        rule, hook_rule_ids, hook_problems) + _fact_problems(rule, state) + _linked_problems(rule, state)
    hook_ok = not hook_found
    toolish = bool(m.tools or m.toolsets or m.commands)
    if m.commands:
        # Invariant 8: a command is matched by PATTERN, after normalization (wrappers and both readings of their options,
        # assignments, paths, `python -m` and a script after an interpreter, runners, `env -S`, `exec -a`, segments). Not read,
        # declared: code given inline (`python -c '...'`, `node -e`), a command assembled at run time (`$CMD install x`) or
        # written to a file and then run, an alias or shell function, wrappers outside _WRAPPERS (runuser, systemd-run, fakeroot,
        # proxychains, torsocks, parallel, firejail, bwrap...), and installers of other ecosystems (cargo/gem/go install, conda
        # install, poetry/uv add, `python setup.py install`), text piped to a shell or interpreter (`echo pip install x | sh`,
        # `cat x | python3 -`: only a curl/wget download piped to one is listed), and `nix-shell --run '...'`. An ask/block by command is real for the spellings it reads, never for
        # every way to do the act. Said on every seal of such a rule, a HAND as much as a LOCK (the VPS case was a HAND with no caveat).
        quals.add("pattern")
    if rule.level is Level.ASK:
        quals.add("yolo_session_invisible")
        trust_ok = False
        if m.mcp_servers and not toolish:  # Hermes's own prompt for an untrusted server: the `free` surface does not touch it
            servers = {canon_name(s.name)[0]: s for s in state.mcp}
            trust_ok = bool(surfaces) and all(
                canon_name(n)[0] in servers and servers[canon_name(n)[0]].trust == "untrusted" for n in m.mcp_servers)
            mechanisms.append(Mechanism(MechanismId.MCP_TRUST, trust_ok, surfaces if trust_ok else ()))
            if trust_ok:
                quals.add("writes_only")
            else:
                problems.append(Problem("not_applied", "the MCP server is not marked untrusted"))
        free_live = _free_applied(state, hook_ok)
        freed = free_live and not trust_ok
        if freed:  # Invariant 8: an ask the hook no longer asks is a contradiction, never a HAND
            problems.append(Problem("free_mode", "the Bot is in free mode: LuveBot does not ask for this approval (Hermes still asks on its "
                                                 "own for commands it treats as dangerous, for approvals.deny and for its hard floors)"))
            quals.add("hermes_may_ask")  # the Hermes gate is untouched: its own prompts and floors still apply to this Bot
            if "room" in surfaces and state.room_policy is not None and state.room_policy.approval_mode != "off":
                quals.add("room_hermes_asks")  # a hosted room's policy overrides approvals.mode (tools/approval_context.py): it asks there
        elif free_live:  # only Hermes's own MCP prompt asks, and the hook no longer turns a channel's prompt into a block (S1)
            channels = [x for x in surfaces if x not in _NO_CHANNEL]
            if channels:
                problems.append(Problem("channel_approval_outside", ", ".join(channels)))
        else:
            if _free(state) and not trust_ok:
                problems.append(Problem("not_applied", "the hook does not run this approval surface"))
            surface = _channel_surface(state, surfaces, hook_ok)
            if surface is not None:
                problems += surface[0]
                quals |= surface[1]
            else:
                channel_problems, channels_blocked = _channel_problems(state, surfaces, hook_ok)
                if channels_blocked:
                    quals.add("channels_block")
                problems += channel_problems
            problems += _allow_leaks(state)
            if "cron" in surfaces and state.approvals.cron_mode == "deny":
                quals.add("routine_block")
        asks = hook_ok and not free_live  # a free Bot's hook asks nothing of its own table
        mechanisms.append(Mechanism(MechanismId.HOOK_APPROVE, asks and bool(surfaces), surfaces if asks else ()))
        if not (hook_ok or trust_ok):
            problems += hook_found
            if m.commands and state.terminal_backend in _CONTAINER_BACKENDS:
                problems.append(Problem("container_backend_skips_gate", "the command gate is skipped in this backend"))
        if not freed:
            problems += _ask_bypasses(rule, state, surfaces)
        problems += _drift(rule, state)
        return _result(Seal.HAND, mechanisms, problems, quals)

    # BLOCK and HANDBACK
    if rule.level is Level.HANDBACK:
        quals.add("handback")
    scratch: list[Problem] = []
    if m.toolsets and not (m.tools or m.mcp_servers or m.commands):
        mechanisms.append(_toolset_off(rule, state, surfaces, scratch))
    if m.mcp_servers and not (m.tools or m.toolsets or m.commands):
        mechanisms.append(_mcp_off(rule, state, surfaces, scratch))
        quals.add("next_session")
    if m.tools and not (m.toolsets or m.mcp_servers or m.commands):
        exclude = _mcp_exclude(rule, state, surfaces)
        if exclude is not None:
            mechanisms.append(exclude)
            quals.add("next_session")
    if m.commands and not (m.tools or m.toolsets or m.mcp_servers):
        mechanisms.append(_approvals_deny(rule, state, surfaces))
        quals.add("pattern")
    mechanisms.append(Mechanism(MechanismId.HOOK_BLOCK, hook_ok and bool(surfaces), surfaces if hook_ok else ()))
    covered = set().union(*(set(x.covers) for x in mechanisms)) if mechanisms else set()
    if not surfaces or not set(surfaces) <= covered:
        problems += scratch + hook_found
        for surface in surfaces:
            if surface not in covered and Problem("uncovered_surface", surface) not in problems:
                problems.append(Problem("uncovered_surface", surface))
        if not problems:
            problems.append(Problem("no_mechanism", "nothing enforces this rule"))
    problems += _drift(rule, state)
    return _result(Seal.LOCK, mechanisms, problems, quals)


def _result(good: Seal, mechanisms: list[Mechanism], problems: list[Problem], quals: set[str]) -> SealResult:
    """`good` when there is no problem at all; BROKEN otherwise (a seal never coexists with a contradiction)."""
    unique = tuple(sorted(set(problems), key=lambda p: (p.code, p.detail)))
    seal = good if not unique else Seal.BROKEN
    return SealResult(seal, tuple(sorted(mechanisms, key=lambda x: x.id.value)), unique, tuple(sorted(quals)))


@dataclass(frozen=True, slots=True)
class Simulation:
    decision: Decision
    seals: tuple[tuple[str, SealResult], ...]      # (rule_id, seal) for every hit
    effective_mechanisms: tuple[MechanismId, ...]  # what would actually stop or ask, from the winning rule


def simulate(rules: Sequence[Rule], state: LiveState, action: Action, *, expected_hook_digest: str | None,
             now: float, hook_table: HookTable | None = None) -> Simulation:
    """The same evaluate() and compute_seal() that enforcement uses; no second code path. Without the compiled
    `hook_table` no rule counts as present in the hook (fail closed)."""
    decision, ordered = _evaluate_full(rules, action)
    ids = None if hook_table is None else frozenset(e.rule_id for e in hook_table.entries)
    extra = {} if hook_table is None else {"hook_problems": hook_table.problems}
    seals = tuple((r.id, compute_seal(r, state, expected_hook_digest=expected_hook_digest, now=now,
                                      hook_rule_ids=ids, **extra)) for r in ordered)
    effective: tuple[MechanismId, ...] = ()
    if ordered and decision.winner is not None:
        effective = tuple(m.id for m in seals[0][1].mechanisms if m.verified)
    return Simulation(decision, seals, effective)
