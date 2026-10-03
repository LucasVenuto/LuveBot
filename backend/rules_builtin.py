"""Built-in rules as DATA (ADR-002 4.5, Assumed R-2). Owner of the lists: the Architect; change them by ADR only.

Each family is two Rules (ids below): a tool-name rule and a `.commands` rule, because a Match is all-of across its
fields and the ADR lists "tools OR commands" (Assumed R-13). Deliberately broad: a false positive costs one click.
"""
from __future__ import annotations

# (id, label, level, tool globs, command globs)
FAMILIES = (
    ("builtin.delete_permanent", "Permanent deletion", "ask",
     ("*delete*", "*destroy*", "*purge*", "*wipe*"),
     ("rm *-r*", "rm *-f*", "find * -delete*", "shred *", "truncate *")),
    ("builtin.unknown_software", "Unknown software", "ask",
     ("*install*",),
     ("pip install *", "pip3 install *", "pip* install *", "pip* install", "python* -m pip install *", "uv pip install *", "uv tool install *",
      "pipx install *", "pipx run *", "uv tool run *", "uvx *", "get-pip*", "npm install *", "npm i *", "npm add *",
      "yarn add *", "pnpm add *", "bun add *", "npx *", "apt* install *", "brew install *",
      "curl *|*sh*", "wget *|*sh*", "docker run *",
      "curl *|*python*", "wget *|*python*", "pnpm install *", "bun install *", "yarn global add *", "npm in *",
      "npm install", "npm i", "npm ci", "yarn", "yarn install", "pnpm install", "bun install",
      "npm exec *", "pnpm dlx *", "yarn dlx *", "bunx *",
      "npm ci *", "yarn install *", "yarn --frozen-lockfile*", "yarn --immutable*")),
    ("builtin.sensitive_access", "Sensitive access", "ask",
     ("*grant*", "*permission*", "*share*", "*oauth*", "*token*"),
     ("chmod *", "chown *", "*authorized_keys*", "ssh-keygen *")),
    ("builtin.password_change", "Password change", "handback",
     ("*password*", "*passwd*", "*2fa*", "*mfa*"),
     ("passwd *", "chpasswd *")),
    ("builtin.money_transfer", "Money transfer", "handback",
     ("*transfer*", "*payment*", "*payout*", "*wire*", "*refund*", "*charge*"),
     ()),
)
