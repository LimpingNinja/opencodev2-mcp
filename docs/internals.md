# Internals and lifecycle contracts

[Back to the README](../README.md) · [Configuration and permissions](configuration.md) · [Tool reference](tools.md)

This describes the implementation in [index.ts](../index.ts),
[runner.ts](../runner.ts), [contracts.ts](../contracts.ts), and
[models-list.ts](../models-list.ts). It is a maintenance reference, not a
separate API or a promise of automatic recovery from every process/filesystem failure.

## Process model

```text
MCP host --stdio--> index.ts (supervisor)
                       |
                       +-- detached Bun runner per member
                       |       +-- embedded OpenCode host + injected agent + session
                       |
                       +-- models-list.ts (short-lived discovery host)
```

The supervisor spawns runners with `detached: true`, ignored stdio, inherited
environment, and `unref()`. It uses its own Bun executable (`process.execPath`),
not a fresh `PATH` lookup. Each runner creates an `@opencode/sdk` host with a
plugin registering a hidden agent named `<name>--<task_id>`, pins its model,
and creates a session at the member workdir with the resolved permission
ruleset (mirrored on the agent; enforced at session level). The same plugin
also converts any residual permission `ask` to `deny`. Agent names are
namespaced per task to avoid collisions when display names are reused.

The SDK runs in-process without an HTTP listener. Provider requests can still
use the network. Both discovery and runners explicitly use the shared database
at `$HOME/.local/share/opencode/opencode.db`; panel control files are separate.

Task discovery is file-backed, not an in-memory registry. Restarting the MCP
server does not intentionally terminate detached runners, and a new supervisor
can inspect their files. This is **not runner resurrection**: there is no tool
to reopen a dead member's session. Persisted artifacts remain available until
removed; an OS restart or process termination can still end active work.

## On-disk layout

```text
~/.opencodev2-mcp/
  panels/<panel_id>.json
  tasks/<task_id>/
    meta.json
    agent.json
    packet.md
    inbox/followup-1.txt
    inbox/followup-2.txt
    ...
    CANCEL
    status.json
    result.md
    events.jsonl
```

Files appear as needed; a new or failed task may have no result or status yet.
Treat these as server-owned control files. Prompts and outputs are stored as
plain text, so protect the directory and redact sensitive content before sharing it.

### Supervisor files

| File | Contents |
| --- | --- |
| `meta.json` | `name`, `panel_id`, `model`, expanded `workdir`, `spawned_at`, `linger_secs`, `stall_secs`, and `pid` once known. |
| `agent.json` | `name`, optional `system` and `description`, `model: { id, providerID, variant? }`, `permission_preset` (informational), and the resolved `permissions` ruleset. |
| `packet.md` | Member's initial prompt: its packet override or the shared packet, as unparsed text. |
| `panels/<panel_id>.json` | `panel_id`, `spawned_at`, shared `packet`, original default `workdir`, timers, `status`, `complete`, `members`, and optional `error`. |

A manifest member records `task_id`, `panel_id`, `name`, `out_dir`, `model`,
expanded `workdir`, `spawn_state`, and `pid` when known. Manifest state is
`spawning`, `complete`, or `partial`; each member's spawn state is `pending`,
`starting`, `started`, or `failed`. “Complete” means spawning finished, **not**
that any model turn succeeded. Per-member packet overrides live in `packet.md`,
not the manifest's shared packet field.

The manifest is written with all assigned IDs before any member starts, then
updated around each spawn. Preparation creates the task directory exclusively,
writes metadata, makes the inbox/workdir, writes inputs, and launches the runner.
Failures caught in this spawn loop return an MCP error with the panel identity,
manifest path, and already-started members; those members are not cancelled
automatically. Failures before the initial manifest is written may return only
an error, without that structured recovery data.

Manifest and metadata updates use exclusive UUID temporary files followed by
rename. If a PID reached the manifest but not `meta.json`, task reads can fall
back to that manifest PID. A crash can still leave `status: spawning`; there is
no automatic spawn reconciliation. Ordinary panel listing scans task directories,
so planned members with no directory are visible only in the manifest.

### Runner status

`status.json` contains `task_id`, optional `session_id`, `status`, `turn`,
`updated_at`, `last_activity_at`, and optional `last_error`. It is replaced via
`status.json.tmp` and rename.

- `updated_at` is the last status write. During the turn wait loop, a heartbeat
  rewrites it roughly every five seconds. In a paused state it is the state-entry
  time used for linger expiry.
- `last_activity_at` records observed progress as of the last status write.
  Heartbeats do not advance the underlying activity clock.
- `turn` starts at zero and increments before prompt submission; it does not
  count only successful turns.
- `last_error` belongs to that snapshot, not a permanent error history. Consult
  `events.jsonl` for earlier errors.

MCP status responses merge that snapshot with metadata and compute:

| Field | Rule |
| --- | --- |
| `live` | PID probe says the stored process may still exist. Invalid PIDs and `ESRCH` mean dead; other errors, including `EPERM`, are treated conservatively as live. |
| `terminal` | PID is dead, or status is `cancelled`/`exited`. Means no follow-up is possible, not success. |
| `resumable` | PID is live and status is `ready`, `idle`, or `error`. |
| `stale` | Status is `running` and time since `last_activity_at` (fallback `updated_at`) exceeds `stall_secs`. Display only. |
| `linger_expires_at` | For live `ready`/`idle`/`error`, `updated_at + linger_secs`. |

Responses also expose `task_id`, `panel_id`, `name`, `model`, `workdir`, `out_dir`,
`pid`, and `spawned_at` when available. PIDs are probed, not authenticated by
process start time; these checks are not a general process-identity guarantee.

### Prompts, cancellation, and results

| File | Contract |
| --- | --- |
| `inbox/followup-N.txt` | UTF-8 prompt; canonical positive integer `N`. Runner expects `1, 2, …` and retains consumed files. |
| `CANCEL` | Existence requests interruption and exit; the supervisor writes an ISO timestamp as its contents. |
| `result.md` | Appended assistant text under one `## Turn N` heading per captured turn; empty captured turns get a placeholder. Not a live token stream. |
| `events.jsonl` | Append-only JSON records, each with ISO timestamp `t` and event `kind`. |

### Audit event formats

Optional fields can be absent when the SDK does not supply them. This is a
selected audit log, not a copy of every engine event.

| `kind` | Additional fields / purpose |
| --- | --- |
| `host_started`, `host_closed` | Start includes `workdir`, `agent`; close is logged after the host-close attempt, even if it throws. |
| `session_created` | `sessionID`, session `model`. |
| `prompt` | `turn`, `text` truncated to 4,000 characters. Full prompts remain in their input files. |
| `assistant` | `turn`, message `id`, `finish`, `tokens`, `cost`, `attempt` (total capture attempts minus one). Text is captured in `result.md`. |
| `idle` | `turn`, engine `outcome`. |
| `prior_turn_message` | `turn` of capture, `id`, `type`; assistant `finish`/`text` (up to 4,000 characters), or idle `outcome`. |
| `permission` | `turn`, engine `type`, `sessionID`; asked: `id`, `action`, up to 20 `resources`, up to 500 characters of `message`; replied: `id`, `reply`; session permission update: rule count `rules`. |
| `permission_ask_denied` | `sessionID`, `action`, up to 20 `resources`: an evaluation that ended in `ask` was converted to deny by the runner's hook. |
| `permission_hook_failed` | `error`: ask-deny hook registration failed at plugin setup; session rules still apply. |
| `events_connected` | Event stream connected. |
| `events_ended`, `events_failed` | `turn`; failure also includes `error`. |
| `stalled` | `turn`, `quiet_ms`, event-stream state `events`, `pending_permissions`. |
| `prompt_error`, `wait_error`, `capture_error` | `turn`, `error` when available. |
| `settle_timeout` | `turn`, `attempts`; last readable view was used without settling. |
| `cancelled`, `linger_timeout` | Runner-observed cancellation or idle exit. |
| `fatal` | `error`; bootstrap failures also set `phase: "bootstrap"`. |

## Runner lifecycle

Normal progression is `booting → ready → running → idle`. Follow-ups return
`idle` (or recoverable `error`) to `running` in the same session. `ready` means
session creation succeeded; it is not a completed first turn.

Prompt rejection, wait failure, stall, failed engine outcome, or capture failure
can produce `error`. A still-live runner waits for another prompt until linger
expires; a bootstrap/fatal error exits instead. Read `live` and `resumable`, not
the state string alone. Between turns, the runner checks its inbox every 500 ms;
with no queued prompt, elapsed linger time changes status to `exited`. A queued
prompt is checked before linger expiry, so `linger_expires_at` is not a strict
delivery cutoff or a promise that the process will still be live until then.

`--out-dir` is required for direct runner invocation. Missing/unresolvable output
paths report on stderr and exit with code 2. Once an output path is resolved,
bootstrap errors attempt to persist `error` status and a fatal event, then exit
with code 1. SDK imports happen inside the caught runtime path. Normal cancellation
and linger expiry exit with code 0; no general startup timeout is imposed.

## Multi-process-safe follow-ups

`panel_send` and `panel_broadcast` share the same publication function:

1. Write the entire prompt to an exclusive `.followup-<uuid>.tmp` inside the inbox.
2. Scan canonical `followup-N.txt` names and choose the first missing positive
   number, not the number of files plus one.
3. Publish with `linkSync(temp, target)`, an atomic, no-replace hard link. On
   `EEXIST`, rescan and retry, up to 128 attempts.
4. Remove the temporary name in a `finally` block.

There is deliberately no rename fallback that could overwrite another
supervisor's prompt. The local filesystem must support hard links; a regression
test checks complete publication and collision handling. Hidden temporary files
are ignored when allocating numbers. Do not delete consumed inbox files: the
runner advances an in-memory counter and numbering relies on retained history.

Sending is rejected for dead, `exited`, or `cancelled` members. It may queue during
an active turn, but there is a race with exit after the liveness check. This is
safe publication, not a delivery acknowledgement, exactly-once retry protocol,
or atomic broadcast across members.

## Watchdog and event classification

The runner—not the supervisor—owns stall detection. After submitting a prompt,
it races session completion against roughly one-second ticks, checks cancellation,
and interrupts when the no-progress window exceeds `stall_secs` (default 300).
This guards the turn wait loop, not SDK startup or a stuck prompt-submission call.

Progress sources share one clock:

- Prompt submission starts the clock; successful capture also marks activity.
- The event subscription tracks the main session and children announced by
  `session.created` with a tracked `parentID`. Events for tracked sessions count
  while a turn is active, including tool, text, and permission events.
- `server.connected` records connectivity only. `rpc.*`, events without a
  session ID, unrelated sessions, and SSE keepalives are not turn progress.
- Every fifth wait-loop tick, a bounded, non-blocking message-list probe checks
  for new IDs or larger JSON representations. The wait loop does not await it.
  Only one timeout-wrapped probe is pending at a time; its 15-second timeout
  releases the guard so another probe can start. The timeout stops waiting; it
  does **not** abort the underlying SDK request, which may still be in flight.
  Capture and interrupt calls use the same timeout helper.

The event stream is subscribed once. If it fails or ends, the audit log records
that fact and the probe remains as fallback; there is no automatic resubscription.
Permission evaluations cannot normally end in `ask`: the session ruleset
resolves every check and the evaluation hook denies any residual ask before a
request is created. If a request ever does pend (for example after a hook
registration failure), asks/replies are still tracked for diagnostics. A
stall writes `error` with `stalled: no events for Ns`, optionally naming pending
permission actions, and leaves the runner available for follow-ups.

No heartbeat grants extra stall time. Reasoning before the first event, or any
long operation that emits no observed progress, can still stall. Increase
`stall_secs` deliberately rather than assuming that a live PID implies progress.

## Turn capture

When the wait completes normally, the runner reads newest-first message pages
of up to 200 rows, at most ten pages, stopping when it reaches the current prompt
ID or an already-consumed row. Each list call has a 15-second timeout. It deduplicates
IDs, reverses to chronological order, and scopes the turn after the prompt ID
returned by `sessions.prompt`. If that ID is unavailable or absent from the
fetched window, capture uses all unconsumed fetched rows; earlier-turn output
can then be included.

Capture attempts up to six reads with 700 ms between attempts. A settled turn
requires two equal fingerprints (message IDs and serialized lengths), an idle
marker, terminal assistant rows, and some assistant text for a successful outcome.
If retries expire after at least one readable view, the last such view is used
and `settle_timeout` is logged; it is not a guarantee that every eventual message
has arrived. A settle timeout alone does **not** set `error`: without a captured
failure, status becomes `idle`, even with partial text or an empty-output
placeholder.

During capture, status remains `running`, but the wait loop's heartbeat, stall
checks, and cooperative cancellation checks are no longer running. Individual
list calls have timeouts; there is no single capture-wide deadline. Supervisor
cancellation can still escalate to `SIGTERM` during this phase.

Only assistant `text` parts become result text—not reasoning or tool payloads.
Multiple assistant messages share a single turn section. Assistant errors and
failed idle outcomes become `last_error`; if no capture read succeeds, the
result gets an error placeholder. Rows before a found prompt anchor are
consumed, with assistant and idle leftovers logged separately rather than added
to the follow-up's result. Rejected, stalled, wait-failed, and cancelled turns
can bypass capture entirely, leaving gaps in result headings.

## Cancellation state machine

The supervisor writes `CANCEL`, then polls the known PID every 250 ms for up to
ten seconds. If it is still live after about 2.5 seconds, it sends `SIGTERM`
once. It does not escalate to `SIGKILL` or signal the entire process group.
Panel cancellation processes members sequentially.

The runner checks `CANCEL` between turns and during its wait loop. It attempts
`sessions.interrupt` with a ten-second timeout, writes `cancelled`, stops the
event watch, closes the host, and exits. Forced termination may prevent those
writes; status strings alone cannot prove that the process stopped.

| Response field | Meaning |
| --- | --- |
| `process_stopped` | A known valid PID was observed stopped and the fresh task read is not live. |
| `cancellation_acknowledged` | Last runner snapshot says `cancelled`; not evidence of exit by itself. |
| `cancelled` | Both of the above are true. |
| `status` | Last runner snapshot; can still say `running` after a forced stop. |

The MCP result has `isError: true` if process stop cannot be confirmed. Forced
stop without acknowledgement reports `process_stopped: true` but `cancelled: false`.

## Cleanup eligibility

`panel_cleanup` defaults to `dry_run: true`, `older_than_days: 7`. Optional
`panel_id` narrows the scan. A dry-run's `deleted` array means **would delete**.

Cleanup skips manifests still marked `spawning`, panels with no discoverable
members, any live/non-terminal member, unknown ages, and panels newer than the
cutoff. Age uses each member's parseable `updated_at`, falling back to metadata
`spawned_at`; the youngest member determines panel eligibility. A zero-day cutoff
does not bypass missing timestamps or liveness checks.

Before actual deletion, the supervisor reads members again and rechecks PID
liveness. It removes their task directories and the panel manifest, **not**
member workdirs or sessions in the OpenCode database. Cleanup never cancels a
runner to make it eligible.

## Hardening notes and regression coverage

These are protections present in this snapshot, not a versioned release history:

| Concern | Implementation / coverage |
| --- | --- |
| Path traversal | Single-component ASCII identifiers with length limits; supervisor checks containment and rejects existing symlink components before task/manifest I/O. Identifier regressions are in `contracts.test.ts`. |
| Interrupted spawning | Manifest-first IDs, atomic metadata writes, partial-spawn reporting, PID fallback. |
| Concurrent follow-ups | Exclusive staging and no-replace hard links; numbering and local-filesystem collision regressions in `contracts.test.ts`. |
| Misleading cancellation | Separate process-stop and acknowledgement booleans, tested as pure outcomes. |
| Premature cleanup | Live/terminal/age checks, spawn-time fallback, unknown-age refusal, tested in `contracts.test.ts`. |
| Lost or mixed turn output | Chronological deduplication, anchoring when the prompt is found, bounded best-effort settle, single-section rendering, tested in `runner.test.ts`. |
| False liveness | Separate heartbeat/activity clocks, event filtering, permission diagnostics, bounded probes; helper tests in `runner.test.ts`. |
| Silent startup failure | Bootstrap validation and persisted fatal status when the output directory is known, tested in `runner.test.ts`. |

Path checks are not an OS sandbox or a race-free defense against a hostile local
filesystem actor. Tests of pure helpers do not establish full process-level
crash recovery or provider compatibility.

## Verification

Run from the repository directory; see [AGENTS.md](../AGENTS.md) for conventions.

```sh
bun test
bunx tsc --noEmit
```

`contracts.test.ts` and `runner.test.ts` cover helpers plus isolated filesystem
behavior. Runner imports are guarded so tests do not start an engine or make
model calls.

- `bun check-structured.ts` starts the stdio supervisor and calls `panel_list`,
  displaying human `content` and a summary of machine `structuredContent`. It
  reads the real panel store but does not spawn members.
- `bun test-mcp.ts` is a **live, credential-dependent smoke script**: it starts
  two members, polls, reads results, sends a follow-up, cancels the second member,
  previews cleanup, and enumerates models. It uses hard-coded Bedrock model IDs,
  `/tmp` as the workdir, and real panel storage. Review those assumptions before
  running; model calls may incur cost. It is not a hermetic assertion suite. On
  its normal path, it leaves the first member to exit via its linger timeout.
