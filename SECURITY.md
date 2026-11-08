# Security policy

## Reporting a vulnerability

**Report privately through GitHub:** https://github.com/LucasVenuto/LuveBot/security/advisories/new. No response-time or supported-release commitment has been established for this pre-release project.

Do not put secrets, exploit details or sensitive logs in a public issue. Include the affected LuveBot revision, Hermes version, deployment and authentication mode, impact, minimal reproduction steps and sanitized evidence. Remove credentials, session tokens, display tickets and private conversation content.

## Scope

Report LuveBot plugin vulnerabilities here: its UI, backend routes and proxy, handling of approvals and rules, spending controls, audit/database behavior, live Screen integration, and distribution of vendored code.

Hermes runtime, tool execution, execution isolation and upstream vulnerabilities belong to [Hermes Agent's security process](https://github.com/NousResearch/hermes-agent/security/policy). If the issue crosses both projects, describe the affected boundary through the respective private channels.

## Security model and limits

The controls listed here include planned work; they are not proof that every control is implemented. LuveBot is still under development.

- **The plugin shares the dashboard's privileges.** Its backend runs in the dashboard process, and browser plugins share the same page origin. There is no sandbox between LuveBot and Hermes. A compromised host, runtime or another trusted plugin can bypass this layer.
- **Dashboard access means full operator access.** The v0.1 design has no per-user role separation. Treat every authenticated dashboard user as trusted to operate every profile, including screen control.
- **A profile is not a sandbox.** Hermes profiles share the host user, filesystem and network. The operating system and deployment provide isolation; LuveBot supplies no new execution boundary. Hermes's approval heuristics and instructions are not a guarantee against an adversarial agent.
- **Agent content is untrusted data.** Messages, tool results, emails, files, memory and handoffs must not become UI instructions or executable HTML. Safe rendering and prompt-injection tests are required, but LuveBot cannot guarantee that an agent will resist prompt injection.
- **Authentication and secrets are release requirements.** Plugin API routes must inherit the dashboard authentication gate; credentials stay in the backend and must not appear in browser responses, errors or logs. A real authenticated human must resolve LuveBot approvals. “Always allow” must create a draft, requiring separate human activation. Native Hermes prompts outside the selected LuveBot approval path remain in their channel.
- **Rules must state their actual mechanism.** Disabling a toolset or MCP server, using an active Hermes approval gate, and adding advisory instructions to `SOUL.md` have different effects. Advisory instructions are not technical enforcement.
- **Budgets are not an exact billing ceiling.** The planned breach response pauses cron jobs, requests stops for active runs and refuses new LuveBot runs. Analytics arrive after calls; an in-flight call may exceed the cap. Direct API runs and work started outside LuveBot are not universally blocked by its checks. Gateway pause does not cover every API run, and pausing is not the same as killing ongoing work. A Bot paused by its cap still answers on Telegram and its other channels (its Hermes gateway): LuveBot closes only its own entry points and the Bot's cron jobs. Hermes's ESTOP is not engaged, because LuveBot could not lift it again without editing Hermes's files.
- **The planned audit trail is tamper-evident, not tamper-proof.** Append-only checks and a hash chain can detect some changes, but the Hermes host user owns the database file. Audit-write failures must prevent LuveBot actions; this does not protect against host compromise.
- **Live Screen is a work surface, not a private boundary.** A Bot and other processes under the gateway user can reach its display. Screen contents may expose passwords or authenticated sessions to viewers. The planned integration requires authenticated viewing/control and audited lease changes, and must not persist frames or thumbnails. These remain implementation and verification requirements.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the security invariants contributors must test. New routes, approval paths, rules, budget behavior or auditing changes require a threat-model review and relevant real-Hermes checks before release.
