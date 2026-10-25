/**
 * index.ts — opencodev2-panel MCP server (thin supervisor).
 *
 * Spawns detached `bun runner.ts` processes; all state lives on disk under
 * TASKS_ROOT so this server is restartable and crash-safe.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  cancellationOutcome, computeResumable, computeTerminal, dedupeModels, expandWorkdir,
  isValidMemberName, isValidTaskId, isValidPanelId, nextFollowupNumber, panelCleanupReason,
  PERMISSION_PRESET_NAMES, resolvePermissions,
} from "./contracts.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "runner.ts");
const MODELS = join(HERE, "models-list.ts");
// process.execPath is the bun binary itself under `bun index.ts`; using it
// means spawned runners don't depend on PATH containing homebrew etc.
const BUN = process.execPath;
const TASKS_ROOT = join(homedir(), ".opencodev2-mcp", "tasks");
const PANELS_ROOT = join(homedir(), ".opencodev2-mcp", "panels");
mkdirSync(TASKS_ROOT, { recursive: true });
mkdirSync(PANELS_ROOT, { recursive: true });

/** Check containment and reject existing symlinks, including leaf files, before I/O. */
function confinedPath(root: string, ...parts: string[]): string {
  const base = realpathSync(root);
  const path = resolve(base, ...parts);
  const rel = relative(base, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`refusing path outside ${root}: ${path}`);
  }
  let current = base;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`refusing symlink: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return path;
}

function panelManifestPath(panel_id: string) {
  if (!isValidPanelId(panel_id)) throw new Error("invalid panel_id");
  return confinedPath(PANELS_ROOT, `${panel_id}.json`);
}

function writePanelManifest(manifest: Record<string, unknown>) {
  const path = panelManifestPath(String(manifest.panel_id));
  const tmp = confinedPath(PANELS_ROOT, `.manifest-${randomUUID()}.tmp`);
  writeAtomicJSON(path, tmp, manifest);
}

function writeAtomicJSON(path: string, tmp: string, value: unknown) {
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 1), { flag: "wx" });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

const log = (...a: unknown[]) => console.error("[opencodev2]", ...a);

const MemberName = z.string().refine(isValidMemberName, "Use 1-128 ASCII letters/digits, dots, underscores or hyphens; start with a letter/digit");
const TaskId = z.string().refine(isValidTaskId, "Invalid task_id: expected a single ocv2- identifier");
const PanelId = z.string().refine(isValidPanelId, "Invalid panel_id: expected a single panel- identifier");

const ModelRef = z.strictObject({
  id: z.string().describe("Model ID, e.g. global.anthropic.claude-sonnet-5-5"),
  providerID: z.string().describe("Provider ID, e.g. amazon-bedrock"),
  variant: z.string().optional().describe("Model variant, e.g. default / high / max"),
});

const Member = z.strictObject({
  name: MemberName.describe("Agent/task name, e.g. de-astra (single path-safe identifier)"),
  system: z.string().optional().describe("System prompt for this member"),
  description: z.string().optional(),
  model: ModelRef.describe("Model to pin this member to"),
  packet: z.string().optional().describe("Per-member prompt override; falls back to shared packet"),
  workdir: z.string().optional().describe("Override working directory; supports {taskid}, {panel_id}, {name}"),
  permissions: z
    .array(z.object({ action: z.string(), resource: z.string(), effect: z.enum(["allow", "deny"]) }))
    .optional()
    .describe("Extra allow/deny rules appended after the preset (may widen it); ask is rejected. File resources within the Location/project git worktree are workdir-relative globs; external files use absolute resources. Baseline secret read/edit and question denies are appended last and still win. The resolved ruleset is enforced at session level: discovered config permission rules cannot override it, and any residual permission ask is denied headless instead of hanging."),
  permission_preset: z
    .enum(PERMISSION_PRESET_NAMES)
    .optional()
    .describe("Named base ruleset (default 'editor': read/glob/grep/edit/shell/web allowed; external_directory outside the Location/project git worktree, subagent and question denied). 'readonly' = read/glob/grep; 'full' = broad access except secret read/edit and question denies. The resolved ruleset is enforced at session level and inherited by child sessions: discovered config and child-agent rules cannot override it, and permission asks are denied headless instead of hanging. The baseline is an accidental read/edit guardrail, NOT a secrets boundary: grep, shell, case variants and symlinks can bypass it. Keep secrets out of workdirs."),
});

const ModelInfo = z
  .object({
    id: z.string(),
    providerID: z.string(),
    name: z.string().optional(),
    family: z.string().optional(),
    variants: z.array(z.string()).optional().describe("Distinct display names collapsed into this family"),
    aliases: z.array(z.string()).optional().describe("All raw ids collapsed into this family"),
  })
  .passthrough();

const TaskInfo = z
  .object({
    task_id: z.string(),
    panel_id: z.string().optional(),
    name: z.string().optional(),
    model: ModelRef.passthrough().optional(),
    workdir: z.string().optional(),
    out_dir: z.string(),
    pid: z.number().optional(),
    live: z.boolean(),
    stale: z.boolean(),
    terminal: z.boolean(),
    resumable: z.boolean(),
    linger_expires_at: z.string().optional(),
    session_id: z.string().optional(),
    status: z.string().optional(),
    turn: z.number().optional(),
    updated_at: z.string().optional(),
    spawned_at: z.string().optional().describe("Supervisor spawn time; cleanup fallback when runner activity is unavailable"),
    last_error: z.string().optional(),
  })
  .passthrough();

// Human-readable text renderings for tool results (content[] is what the host
// displays; structuredContent is the machine channel).
const shortTime = (iso?: string) => (iso ? iso.replace("T", " ").replace(/\.\d+Z$/, "Z") : "?");

function taskLine(t: any): string {
  return `- \`${t.task_id}\` **${t.name ?? "?"}** on \`${t.model?.id ?? "?"}\` — ${t.status ?? "?"}${t.turn ? `, turn ${t.turn}` : ""} · pid ${t.pid}${t.live ? "" : " (dead)"}${t.stale ? " · **stale**" : ""}`;
}

function taskDir(id: string) {
  return taskPath(id);
}

function taskPath(id: string, ...parts: string[]) {
  if (!isValidTaskId(id)) throw new Error("invalid task_id");
  return confinedPath(TASKS_ROOT, id, ...parts);
}

function writeTaskMeta(id: string, meta: Record<string, unknown>) {
  writeAtomicJSON(taskPath(id, "meta.json"), taskPath(id, `.meta-${randomUUID()}.tmp`), meta);
}

function taskIds() {
  return readdirSync(TASKS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isValidTaskId(d.name)).map((d) => d.name);
}

function readJSON(p: string): any {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number | undefined): boolean {
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM (and other unknown failures) do not prove that a process has stopped.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readTask(id: string) {
  const dir = taskDir(id);
  if (!existsSync(dir)) return undefined;
  const meta = readJSON(taskPath(id, "meta.json")) ?? {};
  const status = readJSON(taskPath(id, "status.json")) ?? {};
  const panel_id = typeof meta.panel_id === "string" && isValidPanelId(meta.panel_id) ? meta.panel_id : undefined;
  // Partial spawn may have persisted the pid in the manifest but not meta.json.
  const manifest = !meta.pid && panel_id ? readJSON(panelManifestPath(panel_id)) : undefined;
  const pid = meta.pid ?? (Array.isArray(manifest?.members) ? manifest.members.find((m: any) => m.task_id === id)?.pid : undefined);
  const live = pidAlive(pid);
  const running = status.status === "running";
  const stallMs = (meta.stall_secs ?? 300) * 1000;
  // S3: runner owns stall outcome; stale here is display-only, keyed to its heartbeat.
  const lastBeat = status.last_activity_at ?? status.updated_at;
  const stale = running && lastBeat ? Date.now() - Date.parse(lastBeat) > stallMs : false;
  const terminal = computeTerminal(status.status, live);
  const resumable = computeResumable(status.status, live);
  const linger_expires_at =
    live && (status.status === "idle" || status.status === "error" || status.status === "ready") && status.updated_at
      ? new Date(Date.parse(status.updated_at) + (meta.linger_secs ?? 3600) * 1000).toISOString()
      : undefined;
  return {
    ...status,
    task_id: id,
    panel_id,
    name: meta.name,
    model: meta.model,
    workdir: meta.workdir,
    out_dir: dir,
    pid,
    live,
    stale,
    terminal,
    resumable,
    linger_expires_at,
    spawned_at: meta.spawned_at,
  };
}

function readPanel(panel_id: string) {
  if (!isValidPanelId(panel_id)) throw new Error("invalid panel_id");
  return taskIds().map(readTask).filter((t: any) => t && t.panel_id === panel_id);
}

/** Resolve task_id xor panel_id to a task list, or an error string. */
function resolveTargets(task_id?: string, panel_id?: string): { tasks: any[] } | { error: string } {
  if (!!task_id === !!panel_id) return { error: "provide exactly one of task_id or panel_id" };
  if (task_id) {
    const t = readTask(task_id);
    return t ? { tasks: [t] } : { error: `unknown task_id: ${task_id}` };
  }
  const tasks = readPanel(panel_id!);
  return tasks.length ? { tasks } : { error: `unknown panel_id: ${panel_id}` };
}

async function spawnRunner(dir: string, workdir: string, linger: number, stall: number): Promise<number> {
  const child = spawn(
    BUN,
    [RUNNER, "--out-dir", dir, "--workdir", workdir, "--linger", String(linger), "--stall", String(stall)],
    { detached: true, stdio: "ignore", cwd: HERE, env: process.env },
  );
  return new Promise((resolvePid, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePid(child.pid!);
    });
  });
}

/** Fully write a hidden temp, then publish a complete prompt without overwriting. */
function publishFollowup(task_id: string, text: string): string {
  const tmpName = `.followup-${randomUUID()}.tmp`;
  const tmp = taskPath(task_id, "inbox", tmpName);
  try {
    writeFileSync(tmp, text, { flag: "wx" });
    // linkSync is atomic/no-replace on Bun/macOS (covered by a local fs regression).
    // Never fall back to rename, which could overwrite another supervisor's prompt.
    for (let attempt = 0; attempt < 128; attempt++) {
      const n = nextFollowupNumber(readdirSync(taskPath(task_id, "inbox")));
      const target = taskPath(task_id, "inbox", `followup-${n}.txt`);
      try {
        linkSync(tmp, target);
        return `followup-${n}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new Error("follow-up publication contention: retry the send");
  } finally {
    rmSync(tmp, { force: true });
  }
}

const server = new McpServer({ name: "opencodev2-panel", version: "0.1.0" });

server.registerTool(
  "spawn_panel",
  {
    description:
      "Spawn a panel of opencode agents as detached processes. Each member gets an injected system prompt, a pinned model, and its own working directory. Returns task IDs for polling. Results are written to <out_dir>/result.md on disk and also retrievable via panel_result.",
    inputSchema: {
      members: z.array(Member).min(1).describe("Panel members to spawn in parallel"),
      packet: z.string().describe("Initial prompt text sent to every member"),
      workdir: z.string().describe("Default working directory for all members"),
      linger_secs: z.number().optional().describe("Idle seconds a member stays alive for follow-ups (default 3600)"),
      stall_secs: z.number().optional().describe("Seconds without message activity before a turn is declared stalled (default 300)"),
    },
    outputSchema: {
      panel_id: z.string().describe("Panel grouping id for all members in this call"),
      manifest_path: z.string().describe("Server-owned panel manifest (no client write needed)"),
      spawned: z
        .array(
          z.object({
            task_id: z.string(),
            panel_id: z.string(),
            name: z.string(),
            pid: z.number(),
            out_dir: z.string(),
          }),
        )
        .describe("One entry per spawned member"),
    },
  },
  async ({ members, packet, workdir, linger_secs, stall_secs }) => {
    const linger = linger_secs ?? 3600;
    const stall = stall_secs ?? 300;
    // Validate again at the runtime boundary before minting paths or starting anyone.
    for (const m of members) if (!isValidMemberName(m.name)) throw new Error("invalid member name");
    const panel_id = `panel-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const spawned: any[] = [];
    const planned = members.map((m) => {
      // Resolve every policy before any manifest/task writes or runner starts.
      const permissions = resolvePermissions(m.permission_preset, m.permissions);
      const id = `ocv2-${m.name}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      const dir = taskDir(id);
      const memberWorkdir = expandWorkdir(m.workdir ?? workdir, { taskid: id, panel_id, name: m.name });
      const entry = {
        task_id: id, panel_id, name: m.name, out_dir: dir, model: m.model, workdir: memberWorkdir,
        spawn_state: "pending", pid: undefined as number | undefined,
      };
      return { m, entry, permissions };
    });
    const manifest_path = panelManifestPath(panel_id);
    const manifest = {
      panel_id,
      spawned_at: new Date().toISOString(),
      packet,
      workdir,
      linger_secs: linger,
      stall_secs: stall,
      status: "spawning",
      complete: false,
      members: planned.map(({ entry }) => entry),
      error: undefined as string | undefined,
    };
    // Persist ALL assigned IDs first. A crash or partial failure must not look complete.
    writePanelManifest(manifest);
    let active: typeof planned[number] | undefined;
    try {
      for (const member of planned) {
        active = member;
        const { m, entry, permissions } = member;
        const id = entry.task_id;
        entry.spawn_state = "starting";
        writePanelManifest(manifest);
        const meta = {
          name: m.name, panel_id, model: m.model, workdir: entry.workdir,
          spawned_at: new Date().toISOString(), linger_secs: linger, stall_secs: stall,
          pid: undefined as number | undefined,
        };
        // Exclusive creation prevents collisions; metadata makes preparation failures discoverable.
        mkdirSync(taskDir(id));
        writeTaskMeta(id, meta);
        mkdirSync(taskPath(id, "inbox"));
        mkdirSync(entry.workdir, { recursive: true });
        // Persist the prevalidated set: preset + member rules + baseline deny.
        writeFileSync(taskPath(id, "agent.json"), JSON.stringify({
          name: m.name, system: m.system, description: m.description, model: m.model,
          permission_preset: m.permission_preset ?? "editor", permissions,
        }));
        writeFileSync(taskPath(id, "packet.md"), m.packet ?? packet);
        const pid = await spawnRunner(taskDir(id), entry.workdir, linger, stall);
        entry.pid = meta.pid = pid;
        entry.spawn_state = "started";
        spawned.push({ task_id: id, panel_id, name: m.name, pid, out_dir: taskDir(id) });
        writePanelManifest(manifest);
        writeTaskMeta(id, meta);
      }
      manifest.status = "complete";
      manifest.complete = true;
      writePanelManifest(manifest);
    } catch (error) {
      if (active && active.entry.spawn_state !== "started") active.entry.spawn_state = "failed";
      manifest.status = "partial";
      manifest.complete = false;
      manifest.error = String(error);
      try { writePanelManifest(manifest); } catch (persistError) { log("partial manifest update failed", panel_id, persistError); }
      log("partial spawn", panel_id, error);
      return {
        structuredContent: { panel_id, manifest_path, spawned },
        content: [{ type: "text", text: `Panel \`${panel_id}\` only partially spawned (${spawned.length}/${members.length}). Recover member IDs from \`${manifest_path}\`. Error: ${String(error)}` }],
        isError: true,
      };
    }
    log("spawned", panel_id, spawned.map((s) => s.task_id).join(", "));
    const text = `Spawned ${spawned.length} member${spawned.length === 1 ? "" : "s"} in panel \`${panel_id}\`:\n${spawned
      .map((s: any) => `- \`${s.task_id}\` **${s.name}** (pid ${s.pid})`)
      .join("\n")}`;
    return { structuredContent: { panel_id, manifest_path, spawned }, content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "panel_status",
  {
    description: "Get status of a spawned panel member. stale=true means a running member has produced no message activity for its stall window.",
    inputSchema: { task_id: TaskId },
    outputSchema: TaskInfo.shape,
  },
  async ({ task_id }) => {
    const t = readTask(task_id);
    if (!t) return { content: [{ type: "text", text: `unknown task_id: ${task_id}` }], isError: true };
    const text = [
      `**${t.name ?? task_id}** — ${t.status ?? "?"}${t.turn ? ` (turn ${t.turn})` : ""}${t.resumable ? " · resumable" : ""}${t.terminal ? " · terminal" : ""}`,
      `task: \`${t.task_id}\`${t.panel_id ? ` · panel: \`${t.panel_id}\`` : ""} · model: \`${t.model?.providerID ?? "?"}/${t.model?.id ?? "?"}\` · session: \`${t.session_id ?? "—"}\``,
      `pid ${t.pid} ${t.live ? "live" : "dead"}${t.stale ? " · **stale**" : ""} · updated ${shortTime(t.updated_at)}${t.linger_expires_at ? ` · expires ${shortTime(t.linger_expires_at)}` : ""}${t.last_error ? `\nerror: ${t.last_error}` : ""}`,
    ].join("\n");
    return { structuredContent: t, content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "panel_list",
  {
    description: "List panel members and statuses (scans task directory). Pass panel_id to list one panel.",
    inputSchema: { panel_id: PanelId.optional().describe("Filter to one panel") },
    outputSchema: { tasks: z.array(TaskInfo) },
  },
  async ({ panel_id }) => {
    const ids = taskIds();
    const tasks = ids.map(readTask).filter((t: any) => t && (!panel_id || t.panel_id === panel_id));
    const counts = new Map<string, number>();
    for (const t of tasks) counts.set(t.status ?? "?", (counts.get(t.status ?? "?") ?? 0) + 1);
    const summary = [...counts.entries()].map(([s, n]) => `${n} ${s}`).join(", ");
    const text = tasks.length
      ? `${tasks.length} task${tasks.length === 1 ? "" : "s"} (${summary}):\n${tasks.map(taskLine).join("\n")}`
      : "No tasks.";
    return { structuredContent: { tasks }, content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "panel_result",
  {
    description: "Fetch a member's accumulated result text (result.md) plus its status.",
    inputSchema: { task_id: TaskId },
    outputSchema: {
      task_id: z.string(),
      status: z.string().optional(),
      last_error: z.string().optional(),
      result: z.string(),
    },
  },
  async ({ task_id }) => {
    const t = readTask(task_id);
    if (!t) return { content: [{ type: "text", text: `unknown task_id: ${task_id}` }], isError: true };
    const resultFile = taskPath(task_id, "result.md");
    const result = existsSync(resultFile) ? readFileSync(resultFile, "utf8") : "";
    const out = { task_id, status: t.status, last_error: t.last_error, result };
    const meta = `_**${t.name ?? task_id}** — ${t.status ?? "?"}${t.last_error ? ` — ${t.last_error}` : ""}_`;
    const text = `${meta}\n${result.trim() || "_(no output yet)_"}`;
    return {
      structuredContent: out,
      content: [{ type: "text", text }],
    };
  },
);

server.registerTool(
  "panel_send",
  {
    description: "Send a follow-up prompt to a live panel member (continues its session).",
    inputSchema: { task_id: TaskId, text: z.string() },
    outputSchema: { task_id: z.string(), queued: z.string() },
  },
  async ({ task_id, text }) => {
    const t = readTask(task_id);
    if (!t) return { content: [{ type: "text", text: `unknown task_id: ${task_id}` }], isError: true };
    if (["exited", "cancelled"].includes(t.status) || !t.live) {
      return {
        content: [{ type: "text", text: `task ${task_id} is ${t.status ?? "dead"}; cannot send follow-up` }],
        isError: true,
      };
    }
    const queued = publishFollowup(task_id, text);
    const out = { task_id, queued };
    const msg = `Queued \`${queued}\` for **${t.name ?? task_id}** (${t.status ?? "?"})`;
    return { structuredContent: out, content: [{ type: "text", text: msg }] };
  },
);

server.registerTool(
  "panel_cancel",
  {
    description: "Request cancellation and wait for process stop. process_stopped proves exit; cancelled additionally requires runner acknowledgement. status is the last runner snapshot, which may be stale after forced termination.",
    inputSchema: { task_id: TaskId },
    outputSchema: {
      task_id: z.string(),
      cancelled: z.boolean().describe("True only when stopped AND runner status acknowledges cancellation"),
      process_stopped: z.boolean().describe("Known runner PID was observed stopped"),
      cancellation_acknowledged: z.boolean().describe("Last runner status is cancelled; does not alone prove exit"),
      status: z.string().optional().describe("Last runner-written status; may remain running after forced stop"),
    },
  },
  async ({ task_id }) => {
    const t = readTask(task_id);
    if (!t) return { content: [{ type: "text", text: `unknown task_id: ${task_id}` }], isError: true };
    const r = await cancelTask(task_id);
    const out = { task_id, ...r };
    const outcome = r.cancelled ? "Cancelled (runner acknowledged, process stopped)"
      : r.process_stopped ? "Process stopped; runner did not acknowledge cancellation"
      : r.cancellation_acknowledged ? "Runner acknowledged cancellation; process stop unconfirmed"
      : "Cancellation requested; process stop unconfirmed";
    const msg = `${outcome} for **${t.name ?? task_id}** — last runner status: ${r.status ?? "?"}`;
    return { structuredContent: out, content: [{ type: "text", text: msg }], isError: !r.process_stopped };
  },
);

/** Poll to exit, escalate once; never conflate forced stop with runner acknowledgement. */
async function cancelTask(task_id: string) {
  const before = readTask(task_id);
  if (!before) throw new Error(`unknown task_id: ${task_id}`);
  writeFileSync(taskPath(task_id, "CANCEL"), new Date().toISOString());
  const pid = before.pid;
  const deadline = Date.now() + 10_000;
  let signalled = false;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) break;
    if (!signalled && Date.now() > deadline - 7_500) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      signalled = true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const after = readTask(task_id);
  const processStopped = Number.isSafeInteger(pid) && pid > 0 && !pidAlive(pid) && !after?.live;
  return cancellationOutcome(processStopped, after?.status);
}

server.registerTool(
  "panel_overview",
  {
    description: "Get statuses for every member of one panel (by panel_id from spawn_panel).",
    inputSchema: { panel_id: PanelId },
    outputSchema: { panel_id: z.string(), tasks: z.array(TaskInfo) },
  },
  async ({ panel_id }) => {
    const tasks = readPanel(panel_id);
    if (!tasks.length) return { content: [{ type: "text", text: `unknown panel_id: ${panel_id}` }], isError: true };
    const text = `Panel \`${panel_id}\` — ${tasks.length} member(s):\n${tasks.map(taskLine).join("\n")}`;
    return { structuredContent: { panel_id, tasks }, content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "panel_results",
  {
    description: "Fetch accumulated results for every member of one panel.",
    inputSchema: { panel_id: PanelId },
    outputSchema: {
      panel_id: z.string(),
      results: z.array(z.object({ task_id: z.string(), status: z.string().optional(), last_error: z.string().optional(), result: z.string() })),
    },
  },
  async ({ panel_id }) => {
    const tasks = readPanel(panel_id);
    if (!tasks.length) return { content: [{ type: "text", text: `unknown panel_id: ${panel_id}` }], isError: true };
    const results = tasks.map((t: any) => {
      const f = taskPath(t.task_id, "result.md");
      return { task_id: t.task_id, status: t.status, last_error: t.last_error, result: existsSync(f) ? readFileSync(f, "utf8") : "" };
    });
    const text = results.map((r: any) => `_**${r.task_id}** — ${r.status ?? "?"}_\n${r.result.trim() || "_(no output yet)_"}`).join("\n\n");
    return { structuredContent: { panel_id, results }, content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "panel_broadcast",
  {
    description: "Send the same follow-up prompt to every live member of one panel.",
    inputSchema: { panel_id: PanelId, text: z.string() },
    outputSchema: { panel_id: z.string(), queued: z.array(z.object({ task_id: z.string(), queued: z.string() })) },
  },
  async ({ panel_id, text }) => {
    const tasks = readPanel(panel_id).filter((t: any) => t.live && !["exited", "cancelled"].includes(t.status));
    if (!tasks.length) return { content: [{ type: "text", text: `no live members in panel: ${panel_id}` }], isError: true };
    const queued = tasks.map((t: any) => {
      return { task_id: t.task_id, queued: publishFollowup(t.task_id, text) };
    });
    const msg = `Broadcast queued for ${queued.length} member(s) in \`${panel_id}\``;
    return { structuredContent: { panel_id, queued }, content: [{ type: "text", text: msg }] };
  },
);

server.registerTool(
  "panel_cancel_panel",
  {
    description: "Request cancellation for every member and wait for process stop. Each result separates process_stopped from cancellation_acknowledged; cancelled requires both.",
    inputSchema: { panel_id: PanelId },
    outputSchema: {
      panel_id: z.string(),
      results: z.array(z.object({
        task_id: z.string(),
        cancelled: z.boolean().describe("Stopped AND acknowledged by runner"),
        process_stopped: z.boolean().describe("Known runner PID observed stopped"),
        cancellation_acknowledged: z.boolean().describe("Last runner status is cancelled"),
        status: z.string().optional().describe("Last runner snapshot; may be stale after forced stop"),
      })),
    },
  },
  async ({ panel_id }) => {
    const tasks = readPanel(panel_id);
    if (!tasks.length) return { content: [{ type: "text", text: `unknown panel_id: ${panel_id}` }], isError: true };
    const results: any[] = [];
    for (const t of tasks) {
      const r = await cancelTask(t.task_id);
      results.push({ task_id: t.task_id, ...r });
    }
    const ok = results.every((r) => r.process_stopped);
    const msg = `Panel \`${panel_id}\` cancel: ${results.filter((r) => r.process_stopped).length}/${results.length} stopped; ${results.filter((r) => r.cancellation_acknowledged).length}/${results.length} runner-acknowledged. Status fields are last runner snapshots.`;
    return { structuredContent: { panel_id, results }, content: [{ type: "text", text: msg }], isError: !ok };
  },
);

server.registerTool(
  "panel_cleanup",
  {
    description:
      "Delete terminal panel task dirs + server manifests. Defaults to dry-run: reports candidates, deletes nothing. Live or resumable members are always skipped.",
    inputSchema: {
      older_than_days: z.number().nonnegative().optional().describe("Only panels idle this long qualify (default 7; 0 = any known age). Unknown ages are always skipped."),
      panel_id: PanelId.optional().describe("Restrict to one panel"),
      dry_run: z.boolean().optional().describe("Report only, delete nothing (default true)"),
    },
    outputSchema: {
      dry_run: z.boolean(),
      deleted: z.array(z.string()).describe("Panel ids deleted (or that would be deleted when dry_run)"),
      skipped: z.array(z.object({ panel_id: z.string(), reason: z.string() })),
    },
  },
  async ({ older_than_days, panel_id, dry_run }) => {
    const days = older_than_days ?? 7;
    const dry = dry_run ?? true;
    const panelIds = new Set<string>();
    for (const f of readdirSync(PANELS_ROOT)) {
      if (f.endsWith(".json") && isValidPanelId(f.slice(0, -5))) panelIds.add(f.slice(0, -5));
    }
    for (const d of taskIds()) {
      const pid2 = readTask(d)?.panel_id;
      if (pid2) panelIds.add(pid2);
    }
    const targets = panel_id ? [panel_id] : [...panelIds];
    const deleted: string[] = [];
    const skipped: { panel_id: string; reason: string }[] = [];
    for (const pid of targets) {
      if (readJSON(panelManifestPath(pid))?.status === "spawning") {
        skipped.push({ panel_id: pid, reason: "panel spawn incomplete" });
        continue;
      }
      const tasks = readPanel(pid);
      const reason = panelCleanupReason(tasks, days, Date.now());
      if (reason) {
        skipped.push({ panel_id: pid, reason });
        continue;
      }
      if (dry) {
        deleted.push(pid);
        continue;
      }
      // Re-verify death immediately before deleting; never delete under a live pid.
      const fresh = readPanel(pid);
      if (panelCleanupReason(fresh, days, Date.now()) || fresh.some((t: any) => pidAlive(t.pid))) {
        skipped.push({ panel_id: pid, reason: "became live" });
        continue;
      }
      for (const t of fresh) {
        rmSync(taskDir(t.task_id), { recursive: true, force: true });
      }
      rmSync(panelManifestPath(pid), { force: true });
      deleted.push(pid);
    }
    const text = dry
      ? `Dry-run cleanup: ${deleted.length} panel(s) would be deleted, ${skipped.length} skipped.`
      : `Cleanup: deleted ${deleted.length} panel(s), skipped ${skipped.length}.`;
    return { structuredContent: { dry_run: dry, deleted, skipped }, content: [{ type: "text", text }] };
  },
);

let modelsCache: { at: number; data: unknown } | undefined;
server.registerTool(
  "panel_models",
  {
    description: "List models available to opencode on this machine (cached 60s).",
    inputSchema: {},
    outputSchema: { models: z.array(ModelInfo) },
  },
  async () => {
    const render = (models: any[]) => {
      const byProv = new Map<string, any[]>();
      for (const m of models) {
        const arr = byProv.get(m.providerID) ?? [];
        arr.push(m);
        byProv.set(m.providerID, arr);
      }
      const groups = [...byProv.entries()].map(
        ([p, ms]) => `**${p}** (${ms.length})\n${ms.map((m) => `- \`${m.id}\`${m.name && m.name !== m.id ? ` — ${m.name}` : ""}`).join("\n")}`,
      );
      return `${models.length} models available:\n\n${groups.join("\n\n")}`;
    };
    if (modelsCache && Date.now() - modelsCache.at < 60_000) {
      return {
        structuredContent: { models: modelsCache.data },
        content: [{ type: "text", text: render(modelsCache.data as any[]) }],
      };
    }
    const out = await new Promise<string>((resolveP, reject) => {
      const child = spawn(BUN, [MODELS], { cwd: HERE, env: process.env });
      let buf = "";
      child.stdout.on("data", (d) => (buf += d));
      child.on("error", reject);
      child.on("exit", (c) => (c === 0 ? resolveP(buf) : reject(new Error(`models-list exited ${c}`))));
    });
    const data = dedupeModels(JSON.parse(out));
    modelsCache = { at: Date.now(), data };
    return {
      structuredContent: { models: data },
      content: [{ type: "text", text: render(data) }],
    };
  },
);

await server.connect(new StdioServerTransport());
log("server up");
