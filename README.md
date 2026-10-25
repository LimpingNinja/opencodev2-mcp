# opencodev2-mcp

Run a panel of pinned-model **OpenCode v2 agents from any MCP host**.

`opencodev2-panel` is a Bun/TypeScript MCP server for parallel reviews, delegated
tasks, and cross-model comparisons. Give each member a role, model, and task;
your host agent supervises the panel and brings the results together. Each
member embeds `@opencode/sdk` in its own process — no HTTP listener or separate
OpenCode server required.

## Quickstart

You need [Bun](https://bun.sh) and provider access configured for local OpenCode
v2. Runners inherit the MCP server's environment and use OpenCode's local
database; see [credentials and configuration](docs/configuration.md#credentials).

1. Install dependencies in this repository:

   ```sh
   bun install
   ```

2. Register `bun /absolute/path/to/opencodev2-mcp/index.ts` as a local stdio MCP
   server. For hosts using an `mcpServers` configuration:

   ```json
   {
     "mcpServers": {
       "opencodev2-panel": {
         "command": "bun",
         "args": ["/absolute/path/to/opencodev2-mcp/index.ts"]
       }
     }
   }
   ```

   Use an absolute Bun executable path if your host cannot find `bun` on `PATH`.
   [OpenCode v2 hosts use a different configuration wrapper](docs/configuration.md#mcp-host-registration).

3. Restart your MCP host. Confirm the panel tools are available, then call
   `panel_models` to discover models.

## How panels work

A **panel** is one or more independent members working under a shared
`panel_id`. Each member has its own `task_id`, OpenCode session, pinned model,
and optional system prompt, permissions, packet override, and working directory.
Members do not coordinate automatically; the host collects and synthesizes their work.

The supervisor launches detached runners and keeps prompts, statuses, results,
and manifests under `~/.opencodev2-mcp/`. Runners can outlive an MCP-server
restart; use `panel_list` to rediscover them. Persisted results remain readable
after a runner exits, but this server does **not** restart dead runners.

Between turns, runners wait for follow-ups for `linger_secs` (default 3600
seconds). `idle` means the turn finished, not that the process exited.

## Using a panel

1. **Choose live model IDs.** Take `providerID` and `id` from
   `panel_models`, not remembered model names. Enumeration is **not entitlement**:
   test a newly selected model with a small one-turn panel before relying on it.
2. **Write a useful packet.** Include **Goal**, **Context** (paths to read),
   **Constraints**, **Output format**, and **Done criteria**. These are prompt
   conventions, not a server-enforced format.
3. **Call `spawn_panel`** with `packet`, an absolute `workdir`, and a `members`
   array. Each member needs `name` and `model: { providerID, id }`; use `system`
   for its role and `packet` for a distinct assignment.
   See the [spawn example](docs/configuration.md#spawning-members).
4. **Watch, then collect.** Poll `panel_overview` until members reach `idle`
   with `turn >= 1`, or report their errors/exits. `ready` is not completion;
   a live `error` can accept a follow-up. Fetch `panel_results`, verify important
   claims, and synthesize the answer. Results accumulate across turns.
5. **Continue or stop.** Check `resumable` and `linger_expires_at` before sending
   follow-ups, then watch for a new turn—not the previous turn's `idle` status.
   Cancel members when you no longer need them.

## Tools

The server exposes **12 tools**, grouped by purpose. See the
[tool reference](docs/tools.md) for inputs, outputs, and error handling.

### Discover and start

- `panel_models` — list deduplicated models; cached for 60 seconds.
- `spawn_panel` — launch members; return `panel_id`, `manifest_path`, and member IDs.

### Watch and collect

- `panel_list` — rediscover tasks, optionally filtered by `panel_id`.
- `panel_status` / `panel_overview` — inspect one `task_id` / an entire `panel_id`.
- `panel_result` / `panel_results` — retrieve accumulated text for one member / a panel.

### Continue

- `panel_send` — queue a follow-up for one live member.
- `panel_broadcast` — queue the same follow-up for all eligible live panel members.

### Stop and clean up

- `panel_cancel` / `panel_cancel_panel` — request cancellation and wait for process stop.
- `panel_cleanup` — remove old, stopped panels' task directories and manifests.
  **Dry-run by default**, with a seven-day cutoff; inspect candidates before
  setting `dry_run: false`. Live members are always skipped.

## Permissions

Every member has a `permission_preset` (default `editor`):

- `readonly` starts with catch-all deny, then allows `read`, `glob`, `grep`.
- `editor` starts with catch-all deny, then allows `read`, `glob`, `grep`,
  `edit`, `shell`, `webfetch`, `websearch`; explicitly denies
  `external_directory` and `subagent`. `question` is denied by the catch-all.
- `full` starts with catch-all allow, then denies `question`. It is broad
  access, **not unrestricted YOLO**: baseline secret read/edit denies still apply.

The supervisor writes `agent.json` rules in order: preset → custom
`permissions` (may widen the preset) → `BASELINE_DENY` → question deny. The
engine uses the last matching rule. The runner enforces this resolved ruleset at
session level via `sessions.create`: it merges after all agent/config rules and
child sessions inherit it at creation. Discovered config documents in the
workdir or **any ancestor up to the filesystem root**, including above the Git
root, still load (providers, MCP servers, skills), and their permission rules
append after the runner's agent transform — but they cannot override the
member's effective policy or make it ask. Child (subagent) sessions run under
the member's policy, not their agent persona's own rules.

Member `permissions` accept only `allow`/`deny`; the schema rejects `ask`. If
any evaluation still ends in `ask` (config rules, engine defaults), the runner
denies it immediately — headless members have no approver, so nothing hangs
waiting for one. Under unmodified `readonly`/`editor` rules, wholly denied
tools are hidden from the model, including `todowrite`, `skill`, generated MCP
actions, and Code Mode `execute`; custom allows can make them available.

`BASELINE_DENY` denies `read` and `edit` for these **exact globs** from
[`contracts.ts`](contracts.ts):

```text
".env*", "**/.env*", "*.env"
"*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore"
"id_rsa*", "**/id_rsa*", "id_ed25519*", "**/id_ed25519*"
"id_ecdsa*", "**/id_ecdsa*", "id_dsa*", "**/id_dsa*"
"credentials*", "**/credentials*"
".netrc", "**/.netrc", ".npmrc", "**/.npmrc", ".pypirc", "**/.pypirc"
".git-credentials", "**/.git-credentials"
".ssh/**", "**/.ssh/**", ".aws/**", "**/.aws/**", ".gnupg/**", "**/.gnupg/**"
".docker/**", "**/.docker/**", ".kube/**", "**/.kube/**", "*.tfvars"
```

File resources inside the active Location or its non-root project Git worktree
are workdir-relative (possibly `../...`); external file resources are absolute.
`external_directory` checks paths outside **both** boundaries, not containment
within a member's workdir: files elsewhere in the same Git worktree are internal.
Whole-value wildcards use `*` (including `/`) and `?`, not character classes.

This is an **accidental read/edit guardrail, not a secrets boundary**. `grep`,
allowed by all presets, matches the search expression rather than the path and
can dump `.env`; `shell` under `editor`/`full` can `cat` secrets. On macOS,
case-sensitive globs miss `.ENV`/`x.KEY` even on case-insensitive APFS. An
innocently named in-repo symlink to external secrets can bypass both read/edit
globs and `external_directory`. Intentional overcatch includes `.env.example`
and `src/id_rsa_parser.ts`. **Keep secrets out of workdirs**; there is no
filesystem sandbox, and trusted config/plugins and allowed shell have broader
authority. See [permission guidance](docs/configuration.md#permissions).

## Important pitfalls

- **Give reasoning time.** `stall_secs` defaults to 300 seconds without progress,
  not total runtime. Increase it for reasoning-heavy models: silent thinking
  before the first event can look stalled. `stale` is only a display flag.
- **Separate writers.** Read-only members may share a workdir. Give concurrent
  writers separate prepared checkouts. The server creates directories, not
  worktrees or copies; it provides no filesystem sandbox.
- **Use the follow-up tools.** Publication is multi-process-safe: concurrent MCP
  servers do not overwrite each other's prompts. A queued prompt is not proof
  of execution; dead or exited members cannot be resumed.

## Examples and further reading

- Ready-made host skills: [Devin](example_skills/devin/opencode-panel/SKILL.md)
  and [Muse](example_skills/muse/opencode-panel/SKILL.md), including model selection,
  watching, and synthesis conventions.
- [Configuration](docs/configuration.md): authentication, member options, packets,
  workdirs, and permissions.
- [Tool reference](docs/tools.md): all 12 tools and their response contracts.
- [Internals](docs/internals.md): file formats, lifecycle, watchdog, cancellation,
  cleanup, and regression coverage.

## Development

```sh
bun test                 # helper and local-filesystem tests; no model calls
bunx tsc --noEmit         # typecheck
```

Read [AGENTS.md](AGENTS.md) for repository conventions and
[integration checks](docs/internals.md#verification) before running the
credential-dependent smoke test.

## License

MIT — see [LICENSE](LICENSE).
