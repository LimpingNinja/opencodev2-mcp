---
name: opencode-panel
description: Spawn and supervise OpenCode v2 agents via the opencodev2-panel MCP with model selection, polling, and cross-agent synthesis.
---

# OpenCode Panel

Run 1..x OpenCode v2 agents as a supervised panel through the `opencodev2-panel` MCP server. This skill targets Muse specifically.

## When to use

Use when the user asks for an opencode agent run, oc subagent, subagent panel, panel of models, cross-provider comparison, or a pinned-model run that should not require a Muse agent definition.

Prefer this skill when:

- the user names OpenCode providers or models (for example `amazon-bedrock`, `openai`);
- the point is provider or model diversity;
- members need injected system prompts plus pinned models;
- detached, file-backed runs that survive host restarts are useful.

Do not use for native Muse subagents, Workflow, or Muse-only models. If the user wants worktree isolation or shared Muse tools, use the native subagent path instead and say why.

If the MCP tools for this server are absent in the current session, say the panel MCP is not connected and stop. Do not fall back to inventing agent config.

## Tools and states

Server tools: `panel_models`, `spawn_panel`, `panel_status`, `panel_list`, `panel_result`, `panel_send`, `panel_cancel`, `panel_overview`, `panel_results`, `panel_broadcast`, `panel_cancel_panel`, `panel_cleanup`.

States: `booting` (starting), `ready` (session up, no turn yet), `running`, `idle` (paused-alive between turns, resumable), `error`, `cancelled`, `exited`.

Every status carries `live`, `terminal`, `resumable`, `stale`, `turn`, and `linger_expires_at` when paused. `terminal: true` means no follow-up is possible. A live `error` has `terminal: false` and `resumable: true`.

Treat `panel_id` as the panel identity and `task_id` as the member identity. Never invent a `panel_id`, `task_id`, `pid`, status, or result text.

## Member shape

| field | required | default | notes |
|---|---|---|---|
| `name` | yes | — | short kebab-case, unique in panel |
| `model.id` | yes | — | live id from `panel_models` |
| `model.providerID` | yes | — | live provider id |
| `model.variant` | no | server default | pin only when user asks |
| `system` | no | — | role, lens, output format |
| `description` | no | generated | display label |
| `packet` | no | shared packet | per-member prompt override |
| `workdir` | no | spawn workdir | supports `{taskid}`, `{panel_id}`, `{name}` |
| `permission_preset` | no | `editor` | `readonly` / `editor` / `full` |
| `permissions` | no | — | extra rules appended after the preset |

Spawn-level fields: `packet` (shared template below), `workdir` (workspace root unless given), `linger_secs` (3600, or 300 for one-shots), `stall_secs` (300).

## Permissions

The supervisor writes `agent.json` rules in order: `permission_preset` → custom `permissions` (may widen the preset) → `BASELINE_DENY` → question deny. The engine uses the last matching rule. The runner enforces this resolved ruleset at session level via `sessions.create`: session rules merge after all agent/config rules and child sessions inherit them at creation. Discovered `opencode.json(c)` and `.opencode/opencode.json(c)` documents in the workdir or **any ancestor through the filesystem root**, even above the Git root, still load and their permission rules append after the runner's agent transform — but they sit before the session rules, so **discovered config cannot widen, narrow, or ask-ify a member's policy**. Child (subagent) sessions run under the member's policy, not their agent persona's own rules. Machine-level managed policy can still deny more.

**Standard sets** (`permission_preset`):

- `readonly` — starts with catch-all deny, then allows `read`, `glob`, `grep`.
- `editor` (default) — starts with catch-all deny, then allows `read`, `glob`, `grep`, `edit`, `shell`, `webfetch`, `websearch`; explicitly denies `external_directory` and `subagent`. `question` is denied by the catch-all.
- `full` — starts with catch-all allow, then denies `question`. Broad access except baseline secret read/edit and question denies, **not unrestricted YOLO**. Custom rules cannot re-allow `question`; the question deny is appended last.

**Choosing a preset**: set `permission_preset` deliberately on every spawn — packet text enforces nothing. Review, research, and read-only tasks get `readonly`. Implementation and test runs in an assigned workdir get `editor`. Use `full` only when the task genuinely needs what `editor` denies or hides (subagents, MCP-generated tools, `todowrite`/`skill`, paths outside the worktree); otherwise add narrow custom `allow` rules. When in doubt choose the narrower preset: a denied tool fails cleanly and can be widened on respawn.

**Action vocabulary** includes `read`, `edit`, `glob`, `grep`, `shell`, `external_directory`, `webfetch`, `websearch`, `question`, `subagent`, `todowrite`, `skill`, generated MCP actions (`<server>_<tool>`-style names), and Code Mode `execute`. Under unmodified `readonly`/`editor` rules, wholly denied tools are hidden from the model, including `todowrite`, `skill`, generated MCP actions, and `execute` (and tools reachable only through it). Custom allows can make them available; `full` broadly allows them.

**Rules of engagement**: member `permissions` accept only `allow`/`deny`; the schema rejects `ask`. Headless members have no approver, so no check may end in `ask`: the session ruleset's catch-all resolves every action, and any residual `ask` from config rules or engine defaults is converted to an immediate deny by the runner (logged as `permission_ask_denied`). Nothing hangs waiting for approval. Saved "always allow" replies from interactive use of the same project can turn an `ask` into an `allow`, never override a deny.

File resources inside the active Location or its non-root project Git worktree are **workdir-relative**, possibly starting with `../`; external file resources are **absolute**. `external_directory` checks paths outside both boundaries, **not** containment within a member's workdir: files elsewhere in the same Git worktree are internal. `edit` covers edits, writes, and patches. Whole-value wildcards use `*` (including `/`) and `?`, not character classes. `shell` matches command text, `glob` the requested pattern, and `grep` the search expression, not the path.

**Exact baseline globs**: `BASELINE_DENY` denies `read` and `edit` on every following `SECRET_GLOBS` entry from `contracts.ts`:

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

This is an **accidental read/edit guardrail, not a secrets boundary**. `grep`, allowed by all presets, can dump `.env` because its resource is the search expression, not a path. `shell` under `editor`/`full` can `cat` secrets. On macOS, case-sensitive globs miss `.ENV`/`x.KEY` even on case-insensitive APFS; character classes such as `[eE]` are unsupported. An innocently named in-repo symlink to external secrets can bypass both read/edit globs and `external_directory`. The globs intentionally overcatch `.env.example` and `src/id_rsa_parser.ts`. **Keep secrets out of workdirs**; there is no filesystem sandbox, and trusted config/plugins and allowed shell have broader authority.

## Required packet template

Every packet uses this exact structure. Fill every section. Refuse to spawn with a missing section.

```text
Goal:
<one paragraph: what done looks like>

Context:
<absolute paths to read first, one per line>

Constraints:
- Read-only tasks run under the `readonly` preset; do not rely on this text to enforce it.
- Do not invent file contents, test results, or command output.
- <task-specific limits>

Output format:
<exact headings or shape every member returns>

Done criteria:
- <checkable completion conditions>
```

Per-member overrides keep the same template. Only Goal or Constraints may differ.

## Workflow

### 1. Parse the request

Extract task, member count, names or roles, models, and workdir. Create todos: model selection if needed, one per member, watch, synthesis.

Echo the spawn plan before spawning: members, models, workdirs, permission presets, linger, stall. Require explicit confirmation for more than 3 members or premium flagship models. If packet sections or workdir are missing, ask one short question and stop.

### 2. Choose models

If the user provided models, use exactly those. Map short names with `panel_models` only to disambiguate. Report misses. Never substitute silently.

If no models were provided:

1. Call `panel_models`. Output is already deduplicated by family: one row per family, `aliases` lists collapsed ids, `variants` lists display names. Prefer the returned `id`.
2. Analyze the task: coding, review, research, or fast sweep. Favor provider diversity. Exclude `opencode/*` free-tier models for embedded runs unless the user asks.
3. Offer presets as 2–3 options: Single (1 flagship), Fast sweep (2 small, cross-provider), Deep review (3 flagships, cross-provider). Name every member model plus speed and cost trade-off. Recommended first.
4. Present with `request_user_input` (`header: Models`, `id: panel-models`, first label suffixed `(Recommended)`). Wait. If unavailable, ask in chat and stop.
5. If no models return, say provider auth or env is likely missing and stop.

### 3. Spawn

Call `spawn_panel` once. Use per-member `packet` only for genuinely distinct tasks.

Workdir safety: read-only panels may share the workspace root. Any panel that edits code must give each writer its own workdir, for example `<scratch>/panel-work/{panel_id}/{taskid}` outside the repository under review, or a gitignored directory inside it. Never run parallel writers in one folder. The server expands `{taskid}`, `{panel_id}`, `{name}` and creates the directory.

On success, record `panel_id`, `manifest_path`, plus every `task_id`, `name`, `pid`, `out_dir`. The server owns the manifest; write no files yourself. Report panel id and members. On error, report and stop.

### 4. Watch until terminal

Stay in the watch loop. Never fire-and-forget. Poll with `panel_overview` on the `panel_id`. Sleep between polls with bash `sleep`: 15 s for 2 min, 30 s to 10 min, 60 s after. Cap the watch at 60 minutes, then report pending members and ask.

Report after spawn, on every status transition, and at 1, 5, 10 min then every 5 min. One line per member: name, status, turn, live or dead, terminal or resumable, expiry when paused, task_id.

Completion for a member requires `turn >= 1` and (`idle` or `terminal: true`). `ready` never counts as done. Live `error` (`terminal: false`) is resumable: report `last_error` and ask whether to follow up, cancel, or wait. `stale: true` is display only; the runner owns stall and will set `error`. Report stale once, keep polling.

Long runs over ~10 min: delegate polling to a native subagent watcher. In Muse, subagents inherit MCP tools (verified). Give the watcher the exact `panel_id`, the poll schedule, and instruction to return final statuses. Parent waits for the watcher result before synthesis. If spawning the watcher fails, stay in the parent loop.

Answer `status` mid-watch from the latest poll without breaking the loop. Map `result` to `panel_results`, `cancel panel` to `panel_cancel_panel`, and `follow up` to `panel_send` or `panel_broadcast`.

### 5. Progress updates and final answer

Write for a reader who has not seen any member output. The final answer is the deliverable itself, not a report about how the members compared. Never use **Agreed / Diverged / Unique / Errors-gaps** (or synonyms) as the organizing headings unless the user explicitly asked to compare agents or models.

When a subset finishes, fetch `panel_results` and give a short preliminary answer in the same shape as the final answer below. Label it `Preliminary — based on N of M members`, cover only verified finished work, end with one `Pending:` line (member, status, elapsed time, expiry), and keep watching. Batch finishes within 30 s into one update.

When every member satisfies the completion rule:

1. Fetch `panel_results`. Results accumulate per turn as `## Turn N`; for follow-up turns use only the new turn. Empty means `(no output yet)`.
2. Verify before writing: spot-check load-bearing claims against real files, command output, or tests. Correct wrong member or documentation claims from that evidence. Any claim you could not check stays labelled unverified in place.
3. Write one coherent, self-contained answer that mirrors the packet's **Output format** headings in the same order and wording. Open with the answer's main result, plus one short coverage sentence (what was read, run, or changed). Merge corroborated facts once; do not organize by member. Keep useful file/line or evidence citations inline.
4. Handle disagreement inside the relevant section, in plain words: state the supported conclusion, then only material alternatives with their evidence and impact. Put unresolved material questions under `Open questions` inside that section (or as the packet's limits/next-steps section if it has one). Fold verified single-member findings into the section they belong to. Attribute by member name and turn only where provenance changes how much to trust a claim.
5. End the substance with coverage and limits, using the packet's limits/done-criteria section when present: what was covered, skipped, or failed, how key claims were verified, and what remains uncertain. If the packet output has no place for changed files or test evidence, add one short `Evidence and verification` section.
6. Only after the substance, add a short `Run details` section: member table (name, model, final status, task_id), `panel_id`, server `manifest_path`, resumable members with `linger_expires_at`, and follow-up/stop options (`panel_send`, `panel_broadcast`, `panel_cancel_panel`). Never cancel without user request. Cancel means proven dead; report any timeout honestly.
7. Run `panel_cleanup` with defaults (dry-run, 7 days) and include its candidate counts in `Run details` only. Never run a non-dry-run cleanup without explicit user approval. Never delete files yourself.

If the user explicitly asks what each agent said or asks to compare models, still lead with the packet-shaped answer above, then add a clearly labelled per-member comparison appendix. A single-member run uses the same final-answer shape with no comparison language.

Never claim completion while any member is `booting`, `ready`, or `running`.

## Recovery and failure handling

- Lost context: `panel_list` to find the `panel_id`, then `panel_overview` on it. The server manifest under its panels store is the record; never recreate it client-side.
- Follow-up: `panel_send` to one live member, `panel_broadcast` to all live members. Check `resumable` first. Resume watching after sending.
- Unknown id: re-check manifest, then `panel_list`. Report unknown rather than guessing.
- Zero members, incomplete packet template, or missing workdir: refuse in one line. Do not call `spawn_panel`.
