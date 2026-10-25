# MCP tool reference

[Back to the README](../README.md) · [Configuration](configuration.md) · [Internals](internals.md)

These are the 12 tools registered by [index.ts](../index.ts). A host may display
them with a server-name prefix. Inputs and object shapes below use `?` to mark
optional fields; identifiers and prompt text are strings.

## Reading responses

Tools return human-readable text in `content[].text` and machine data in
`structuredContent`. The shapes below describe **`structuredContent`**, not
JSON embedded in the human text.

Check `isError` before treating a call as successful. Some errors return only
text; partial-spawn and unconfirmed-cancellation errors can also carry useful
structured data. A successful tool call is not a successful model turn:
`panel_result`, for example, can successfully retrieve a member in `error`.

Keep the returned `panel_id` and `task_id` values rather than constructing them.
The former identifies a group; the latter identifies one member's task.

## Discover and start

### `panel_models`

- **Input:** `{}`.
- **Output:** `{ models: ModelInfo[] }`. Each row has `providerID`, `id`, optional
  `name` and `family`, plus `variants` and `aliases` arrays.

Read the rows from `structuredContent.models[]` and copy a row's `providerID`
and `id` into `members[].model`. The deduplicated response is cached for 60
seconds per supervisor. This is enumeration, not an inference or entitlement
check. `variants` contains display names (falling back to IDs), **not runtime
variant IDs**; see [model selection](configuration.md#model-selection).

### `spawn_panel`

- **Required input:** `packet`, `workdir`, and a nonempty `members` array.
- **Optional input:** numeric `linger_secs` (default `3600`) and `stall_secs`
  (default `300`). See [member fields and examples](configuration.md#spawning-members).
- **Output:** `{ panel_id, manifest_path, spawned }`. Each `spawned` entry has
  `task_id`, `panel_id`, `name`, numeric `pid`, and `out_dir`.

The call waits for process creation, not for member readiness or model output.
Use status tools next. On a caught partial-spawn failure, `isError` is true and
the same output shape identifies already-started members and the server-owned
manifest. Those members are not rolled back; the manifest also records planned
IDs. Failures before manifest creation may return only an error.

## Watch and collect

| Tool | Input | Output |
| --- | --- | --- |
| `panel_list` | `{ panel_id? }` | `{ tasks: TaskInfo[] }` |
| `panel_status` | `{ task_id }` | One `TaskInfo` object |
| `panel_overview` | `{ panel_id }` | `{ panel_id, tasks: TaskInfo[] }` |
| `panel_result` | `{ task_id }` | One `MemberResult` object |
| `panel_results` | `{ panel_id }` | `{ panel_id, results: MemberResult[] }` |

### Task status

`TaskInfo` always includes `task_id`, `out_dir`, and the booleans `live`, `stale`,
`terminal`, and `resumable`. When available, it also includes:

- Metadata: `panel_id`, `name`, `model`, `workdir`, `pid`, `spawned_at`.
- Runner snapshot: `session_id`, `status`, `turn`, `updated_at`,
  `last_activity_at`, `last_error`.
- `linger_expires_at` for live `ready`, `idle`, or `error` members.

Early or failed starts may have no runner snapshot. A dead member is terminal
even if its last snapshot still says `running`; `ready` is not turn completion.
See [status field semantics](internals.md#runner-status) for the exact rules.

Listing scans task directories, not the manifest's planned-member array.
`panel_list` returns `tasks: []` when nothing matches, including an unknown
but valid `panel_id`. `panel_overview` and `panel_results` return an error when
the panel has no discoverable members; task-specific tools error on an unknown
task.

### Member results

`MemberResult` contains `task_id`, optional `status` and `last_error`, and a
`result` string holding the accumulated `result.md` contents. If that file does
not yet exist, `result` is `""`; the human rendering says “no output yet.”

Results are captured turn sections, not a live token stream or just the newest
turn. They do not include liveness or turn counters; use a status tool to
interpret them. Review [capture limits](internals.md#turn-capture) before
treating an empty result or an `idle` status as evidence of complete output.

## Continue

| Tool | Input | Output |
| --- | --- | --- |
| `panel_send` | `{ task_id, text }` | `{ task_id, queued }` |
| `panel_broadcast` | `{ panel_id, text }` | `{ panel_id, queued: [{ task_id, queued }] }` |

Each `queued` token is a string such as `followup-1`, without the file's `.txt`
extension. It acknowledges prompt publication, not execution. Sends require a
live PID and reject `exited` or `cancelled` snapshots. They may queue while a
member is running, even though `resumable` is then false.

Broadcast targets only eligible live members and errors if none qualify.
Publication is [multi-process-safe](internals.md#multi-process-safe-follow-ups),
but broadcast is not a transaction: an error may leave earlier members queued.
Retries are not deduplicated. Record the current turn before sending and watch
for a later turn; a queued prompt does not extend the linger timer by itself or
restart a dead runner.

## Stop and clean up

### `panel_cancel` and `panel_cancel_panel`

| Tool | Input | Output |
| --- | --- | --- |
| `panel_cancel` | `{ task_id }` | One `CancelResult` object |
| `panel_cancel_panel` | `{ panel_id }` | `{ panel_id, results: CancelResult[] }` |

`CancelResult` contains `task_id`, optional `status`, and three booleans:

- `process_stopped`: the known PID was observed stopped.
- `cancellation_acknowledged`: the last runner snapshot says `cancelled`.
- `cancelled`: **both** conditions hold.

The supervisor requests cancellation, waits up to ten seconds per member, and
may send `SIGTERM`. Panel cancellation is sequential. A forced stop can leave
`status: "running"` and `cancelled: false` even when `process_stopped: true`.
The response has `isError: true` if process stop cannot be confirmed for any
target. See the [cancellation state machine](internals.md#cancellation-state-machine).

### `panel_cleanup`

| Input | Default | Meaning |
| --- | --- | --- |
| `older_than_days?` | `7` | Non-negative number; `0` accepts any known age at or before now. |
| `panel_id?` | All panels | Restrict cleanup to one panel. |
| `dry_run?` | `true` | Boolean; report candidates without deleting them. |

**Output:** `{ dry_run, deleted: string[], skipped: [{ panel_id, reason }] }`.
In a dry-run, `deleted` lists panels that **would** be deleted.

Cleanup is panel-wide: every discoverable member must be non-live, terminal,
and old enough, with a known timestamp. In-progress spawns are skipped. It
removes task directories and manifests, not workdirs or OpenCode database
sessions, and never cancels live members to make them eligible. Inspect the
dry-run before setting `dry_run: false`; see [eligibility rules](internals.md#cleanup-eligibility).
