# Configuration and host usage

[Back to the README](../README.md) · [Tool reference](tools.md) · [Internals](internals.md)

The MCP schemas in [index.ts](../index.ts) define the public inputs. OpenCode
provides the model runtime and permission evaluator; this wrapper supplies
member configuration and supervises processes.

## Credentials

The wrapper has no credential store of its own. Both [runner.ts](../runner.ts)
and [models-list.ts](../models-list.ts) explicitly open:

```text
$HOME/.local/share/opencode/opencode.db
```

That is separate from panel artifacts under `~/.opencodev2-mcp/`. The database
path is hard-coded in these two entrypoints, not exposed as an MCP option.
Do not assume a custom database path used by another OpenCode installation will
also be used here. `opencode debug paths db` reports the CLI's database path;
compare it with the path above if saved accounts seem to be missing.

- **Stored OpenCode accounts:** configure providers with `opencode auth login`
  and inspect them with `opencode auth list`. Run the MCP server under the same
  user and normal `HOME`. See the official [V2 account guide](https://opencode.ai/v2/docs/cli/providers).
- **Environment credentials:** the supervisor passes `process.env` to runners
  and model discovery. Supply provider variables through your MCP host's secure
  environment mechanism. Shell variables absent from the host process will not
  magically reach a runner; interpolation syntax belongs to the host, not this server.
- **Cloud credentials:** provider-specific ambient authentication, such as AWS
  profiles for Bedrock, must be reachable from that environment and home directory.
  See [OpenCode providers](https://opencode.ai/v2/docs/providers) for supported setup.

An enumerated model is not a successful inference or an account entitlement
check. This matters especially for subscription/OAuth access, which need not
permit the provider's whole catalog. Validate access with a small panel and
inspect its status and result; do not silently substitute another model.

## MCP host registration

The launch command is `bun /absolute/path/to/opencodev2-mcp/index.ts`; transport
is stdio. The README shows the `mcpServers` shape used by some hosts. OpenCode
v2 instead uses [`mcp.servers`](https://opencode.ai/v2/docs/mcp-servers) in its
`opencode.json` or `opencode.jsonc` configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "opencodev2-panel": {
        "type": "local",
        "command": ["bun", "/absolute/path/to/opencodev2-mcp/index.ts"]
      }
    }
  }
}
```

Merge the entry into your existing host configuration, then restart the host.
If Bun is not on its `PATH`, replace `bun` with its absolute executable path.
Once running, the supervisor uses `process.execPath` for its child processes.

## Model selection

Call `panel_models` with no arguments. Use its returned `providerID` and `id`
in each member's `model`. Discovery runs an embedded host in a child process;
each supervisor caches the deduplicated response for 60 seconds. The tool has
no `workdir` input: the discovery child starts in this repository's directory,
not a prospective member's workdir.

Rows are grouped by provider plus model ID with a recognized region prefix
removed, not by the `family` metadata field. Recognized prefixes are `global.`,
`us-gov.`, `us.`, `eu.`, `au.`, `jp.`, `in.`, `apac.`, and `ca.`. The preferred
ID is `global.*`, then an unprefixed ID, then `us.*`, then another regional ID.
`aliases` contains the grouped raw IDs.

**The returned `variants` are distinct display names (falling back to IDs), not
validated values for `model.variant`.** The latter is an optional runtime
variant passed through to OpenCode. Omit it unless you know the selected model's
supported variant ID. The wrapper does not preflight model access during
`spawn_panel`.

## Spawning members

Arguments for `spawn_panel` (replace placeholders before calling):

```json
{
  "workdir": "/absolute/path/to/project",
  "packet": "Goal: Review correctness.\nContext: Read src/ and tests/.\nConstraints: Do not edit files. Cite evidence.\nOutput format: Findings, then verification limits.\nDone criteria: Each finding identifies a file and a concrete failure case.",
  "members": [
    {
      "name": "reviewer",
      "model": { "providerID": "<providerID from panel_models>", "id": "<id from panel_models>" },
      "system": "You are a correctness reviewer. Verify claims against source."
    }
  ]
}
```

This is a prompt example, **not enforced read-only access**. Use permission
rules below for tool restrictions. Add more members for parallel roles or
models; the server accepts one or more.

| Field | Meaning |
| --- | --- |
| `packet` | Required shared initial prompt string. |
| `workdir` | Required default working directory. Use an absolute path. |
| `linger_secs` | Seconds to wait between turns before exiting; default `3600`. |
| `stall_secs` | No-progress window during the turn wait loop; default `300`. |
| `members[].name` | Required: 1–128 ASCII letters, digits, dots, underscores, or hyphens; starts with a letter or digit. Use distinct descriptive names. |
| `members[].model` | Required `{ providerID, id, variant? }`. |
| `members[].system` | Optional system prompt defining the member's role. |
| `members[].description` | Optional agent description; otherwise generated. |
| `members[].packet` | Optional replacement for the shared packet, not an addition to it. |
| `members[].workdir` | Optional replacement for the default workdir. |
| `members[].permission_preset` | Optional named base ruleset: `readonly`, `editor` (default), or `full`. See [Permissions](#permissions). |
| `members[].permissions` | Optional array of `{ action, resource, effect }` appended after the preset; may widen it. `effect` accepts only `allow`/`deny`, not `ask`; baseline/question denies are appended last and still win. The resolved ruleset is enforced at session level and cannot be overridden by discovered config. |

Use finite, non-negative timer values. The runner rejects invalid values during
bootstrap; the supervisor's spawn schema does not reject negative numbers.
Consequently, a spawn can report a started process that then fails timer
validation. Zero is a zero-length window, **not** a way to disable either timer.
These values apply to all members of the spawn call, not per member. Check
`panel_overview` after spawning: a successful spawn response confirms process
launch, not SDK startup, model access, or completion of the task.

Packets are ordinary text, not parsed documents. For reproducible assignments,
include Goal, Context with exact paths, Constraints, Output format, and Done
criteria. The [Devin](../example_skills/devin/opencode-panel/SKILL.md) and
[Muse](../example_skills/muse/opencode-panel/SKILL.md) skills describe stricter
host-side conventions; those are not additional server validation.

### Working directories

Both shared and per-member workdirs expand `{taskid}` (also `{task_id}`),
`{panel_id}`, and `{name}` after IDs are assigned. For example:

```text
/absolute/scratch/panels/{panel_id}/{taskid}
```

Only these substitutions are performed; `~` and unknown placeholders are not
expanded. Use absolute paths. A relative path is especially risky: directory
creation is relative to the supervisor's current directory, while the runner
resolves its workdir from the repository directory where it is launched.

The supervisor creates the directory recursively; it does not populate it with
project files, clone a repository, create a Git worktree, or isolate filesystem
access.

Read-only panels can share a checkout. Prepare separate checkouts/worktrees
outside this server before assigning concurrent editing tasks. A different
workdir alone is not a security boundary, and a prompt saying “read-only” does
not enforce permissions.

## Permissions

### Rule ordering and config discovery

The supervisor resolves each member's ruleset at spawn in this order:
`permission_preset` → custom `permissions` (may widen the preset) →
`BASELINE_DENY` → question deny. The engine picks the **last** matching rule,
so the baseline and question denies win over member rules in that array.

The runner enforces this resolved ruleset **at session level**: it is passed to
`sessions.create`, where session rules merge **after all agent/config rules**,
and child sessions inherit them at creation. The same set is mirrored on the
agent for agent-scoped consumers (tool/subagent listing), but the session copy
decides every check. The engine still discovers `opencode.json(c)` and
`.opencode/opencode.json(c)` documents in the workdir and **every ancestor
through the filesystem root**, including above the detected project/Git root,
plus global and managed config. Their permission rules append after the
runner's agent transform, so they sit *before* the session rules: because every
preset leads with a catch-all, each (action, resource) resolves inside the
member's ruleset and no config rule can be the last match. **Discovered config
cannot widen, narrow, or ask-ify a member's preset/custom policy**, including
under `full` or in a child session running a different agent: child sessions
run under the member's policy, not their agent persona's own rules. Config
still supplies providers, models, MCP servers, agents, skills, and plugins —
only its permission rules cannot change member outcomes. Machine-level managed
policy, where present, can still deny more.

### Standard sets and headless behavior

`permission_preset` defaults to `editor`:

- `readonly` — starts with catch-all deny, then allows `read`, `glob`, `grep`.
- `editor` — starts with catch-all deny, then allows `read`, `glob`, `grep`,
  `edit`, `shell`, `webfetch`, `websearch`; explicitly denies
  `external_directory` and `subagent`. `question` is denied by the catch-all.
- `full` — starts with catch-all allow, then denies `question`. Broad access
  except baseline secret read/edit and question denies, **not unrestricted
  YOLO**. Custom rules cannot re-allow `question` because the question deny is
  appended last.

Custom member rules can widen a preset, but the MCP schema accepts only
`allow`/`deny` and **rejects `ask`**. **Headless runners cannot answer asks**
(there is no permission-reply MCP tool), so no check is allowed to end in
`ask`: the session ruleset's catch-all resolves every (action, resource), and
as a backstop the runner's `permission.evaluate` hook converts any residual
`ask` — from config rules, engine defaults, or future rule sources — into an
immediate deny with a "headless panel runner" reason, logged as
`permission_ask_denied` in `events.jsonl`. A denied tool call fails cleanly and
the turn continues; nothing waits for an approval that cannot arrive. Saved
"always allow" replies from interactive use of the same project can still
turn an `ask` into an `allow` before the hook runs, but they can never
override a deny.

**Action vocabulary** includes `read`, `edit`, `glob`, `grep`, `shell`,
`external_directory`, `webfetch`, `websearch`, `question`, `subagent`,
`todowrite`, `skill`, generated MCP-tool actions (`<server>_<tool>`-style names),
and Code Mode `execute`. With unmodified `readonly`/`editor` rules, wholly
denied tools are **hidden from the model**, including `todowrite`, `skill`,
generated MCP actions, and `execute` (and tools reachable only through it).
Custom allows can make them available; `full` broadly allows them.

### File resources and boundaries

For `read` and `edit` checks **inside the active Location or its non-root
project Git worktree**, resources are relative to the member's `workdir` and
may begin with `../`. With `/work/repo/pkg` as workdir, a read of
`/work/repo/src/main.ts` in the same worktree checks `../src/main.ts`.
`external_directory` checks paths outside **both** the Location and non-root
project worktree, not containment in the member's workdir. Files elsewhere in
the same Git worktree are internal, even outside that workdir. External file
resources are absolute; relative-path advice is not a blanket rule for them.

`edit` covers edits, writes, and patches. Other actions have different resources:
`shell` matches command text, `glob` matches the requested pattern, and `grep`
matches the search expression, **not the search path**. Rules use whole-value
wildcards: `*` includes `/` (so `src/*.ts` matches nested TypeScript files),
`?` matches one character, and character classes such as `[eE]` are not
supported. Matching is case-sensitive on macOS even with case-insensitive APFS.

### Exact baseline globs and limits

`BASELINE_DENY` denies both `read` and `edit` for these **exact `SECRET_GLOBS`**
from [`contracts.ts`](../contracts.ts):

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

This is an **accidental read/edit guardrail, not a secrets boundary**:

- `grep`, allowed in all presets, can dump `.env` because its resource is a
  search expression, not a path. These read/edit denies do not filter its output.
- `shell`, allowed in `editor`/`full`, can `cat` secrets; file-read denies do not
  constrain shell's filesystem authority.
- Case-sensitive globs do not cover `.ENV` or `x.KEY` on macOS, even when APFS
  resolves those case variants to the same files. Character classes cannot fix
  this with patterns like `[eE]`.
- An innocently named in-repo symlink pointing to external secrets can bypass
  both the read/edit globs and `external_directory` checks.

The broad globs intentionally overcatch `.env.example` and
`src/id_rsa_parser.ts`. **Keep secrets out of workdirs.** There is no filesystem
sandbox; trusted config/plugins and allowed shell have broader authority than
file-read rules. A separate member workdir is not a containment boundary.

Use explicit allow/deny rules for the work you authorize. For example, this
member-level policy denies everything except TypeScript file reads under
`src/` (baseline denies still apply):

```json
[
  { "action": "*", "resource": "*", "effect": "deny" },
  { "action": "read", "resource": "src/*.ts", "effect": "allow" }
]
```

This is intentionally narrow, not a complete review policy. Add only required
actions and resources. A resource of `"*"` can avoid path mismatches for an
intentionally broad grant, but is not a substitute for choosing safe actions.
Discovered config permission rules cannot change this policy; the resolved
ruleset is enforced at session level.

To diagnose a denied ask, inspect `last_error` and the task's `events.jsonl`
for `permission_ask_denied` records. A follow-up changes prompt text, not the
member's permission rules. Correct the member rules and spawn a new member
when the policy is wrong.

## Follow-ups and recovery

- Keep the returned `panel_id`, `manifest_path`, and each member's `task_id` and
  `out_dir`. After losing host context, use `panel_list` and `panel_overview`;
  do not invent identifiers or recreate manifests yourself.
- Prefer sending when `resumable` is true. `panel_send` can also queue while a
  member runs; follow-ups execute serially in that member's existing session.
  Publication is safe across MCP processes, but acceptance does not guarantee
  execution before a runner exits. Record the current `turn`, then watch for a
  later turn and its result; an unchanged `idle` snapshot is not completion of
  the follow-up.
- `panel_broadcast` publishes separately to each eligible member, not as a
  panel-wide transaction. Do not assume retries are idempotent.
- `panel_result` and `panel_results` return accumulated text, not just the newest
  turn. A blank result during a turn is not proof of inactivity.
- For partial spawns, recover assigned IDs and known PIDs from the server-owned
  manifest before deciding what to retry or cancel. Already-started members are
  not automatically rolled back.

See [internals](internals.md) for exact file contracts, cancellation outcomes,
and conservative cleanup rules.
