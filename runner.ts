/**
 * runner.ts — per-member panel worker.
 *
 * Usage:
 *   bun runner.ts --out-dir <dir> [--workdir <dir>] [--linger <secs>] [--stall <secs>]
 *
 * Input files (written by the supervisor before spawn):
 *   <dir>/agent.json   { name, system, description?, model: {id, providerID, variant?}, permission_preset?, permissions? }
 *                      permission_preset is informational; the runner uses the resolved permissions.
 *   <dir>/packet.md    initial prompt text
 *
 * Control/output files:
 *   <dir>/inbox/followup-<n>.txt  follow-up prompts, consumed in numeric order
 *   <dir>/CANCEL                touch to cancel the current turn and exit
 *   <dir>/status.json           { task_id, session_id?, status, turn, last_error?, updated_at, last_activity_at }
 *   <dir>/result.md             assistant text, exactly one "## Turn N" section per completed turn
 *   <dir>/events.jsonl          audit log: prompts, per-message assistant/idle records (tokens, cost),
 *                               permission events, watchdog + event-stream lifecycle, fatal errors
 *
 * Status values: booting | ready | running | idle | error | cancelled | exited
 * ready = session created, no turn yet. idle = paused-alive between turns.
 *
 * status.json timestamps:
 *   updated_at        time of the last status write. While running, a heartbeat rewrites status.json
 *                     about every 5s, so a fresh updated_at proves the process is alive. In
 *                     ready/idle/error it is when that state was entered: the supervisor derives
 *                     linger_expires_at from it, and the runner's own linger timer uses the same basis.
 *   last_activity_at  time of the last real turn progress: prompt submitted, message growth seen by the
 *                     size probe, a session-scoped engine event, or the completed turn being captured.
 *                     Heartbeats never advance it, so a hung turn ages here while updated_at stays
 *                     fresh; the supervisor's display-only `stale` flag keys off this field.
 *
 * Stall watchdog (runner-owned): a running turn with no progress for --stall seconds is interrupted
 * and marked `error` with last_error "stalled: ...". Progress comes from the engine event stream
 * (primary) and a periodic message-size probe (fallback). SSE keepalives never count as progress.
 *
 * Permissions: the resolved ruleset from agent.json is enforced at session level via
 * sessions.create (merged after all agent/config rules, inherited by child sessions) and
 * mirrored on the agent for agent-scoped consumers. A permission.evaluate hook converts any
 * residual `ask` to deny — headless members have no approver — and logs `permission_ask_denied`.
 *
 * Exit codes: 0 normal exit (cancelled / linger timeout); 1 fatal error, with status.json set to
 * `error` + last_error whenever the output dir is known; 2 usage error (--out-dir missing/unusable),
 * reported on stderr only because there is no trustworthy place to write status.
 */

import type { OpenCode } from "@opencode/sdk";
import type { Plugin as PluginNS } from "@opencode/plugin";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { BASELINE_DENY, QUESTION_DENY, type PermissionRule } from "./contracts.ts";

type Client = OpenCode.Interface;
type Status = "booting" | "ready" | "running" | "idle" | "error" | "cancelled" | "exited";
/** Loose message row: the published types lag the embedded host, so read fields defensively. */
type Msg = { id: string; type?: string; [k: string]: any };

const HEARTBEAT_TICKS = 5; // ~5s at 1s watchdog ticks
const SETTLE_ATTEMPTS = 6; // max reads after turn end (~3.5s of settle delay worst case)
const SETTLE_DELAY_MS = 700;
const LIST_PAGE_SIZE = 200; // protocol maximum for message.list
const MAX_LIST_PAGES = 10;
const LIST_TIMEOUT_MS = 15_000;
const INTERRUPT_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return typeof m === "string" ? m : String(e);
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Bootstrap: argument + input parsing. Everything after --out-dir resolves runs
// in a caught path so failures persist as status.json `error` before exit.
// ---------------------------------------------------------------------------

export type AgentSpec = {
  name?: string;
  system?: string;
  description?: string;
  mode?: string;
  model?: { id: string; providerID: string; variant?: string };
  permissions?: unknown;
  [k: string]: unknown;
};

export type RunnerContext = {
  outDir: string;
  taskID: string;
  workdir: string;
  lingerMs: number;
  stallMs: number;
  inboxDir: string;
  cancelFile: string;
  statusFile: string;
  resultFile: string;
  eventsFile: string;
  agent: AgentSpec;
  agentName: string;
  effectiveAgentName: string;
};

export type BootstrapFailure = {
  ok: false;
  error: string;
  /** Set only when the output dir resolved; absent means "report on stderr, write nothing". */
  outDir?: string;
  statusFile?: string;
  taskID?: string;
};
export type BootstrapResult = { ok: true; ctx: RunnerContext } | BootstrapFailure;

/** Resolve --out-dir, never falling back to cwd: a missing/empty/flag-like value is unresolvable. */
export function resolveOutDir(argv: readonly string[], cwd: string): string | undefined {
  const i = argv.indexOf("--out-dir");
  if (i < 0) return undefined;
  const raw = argv[i + 1];
  if (raw === undefined || raw.trim() === "" || raw.startsWith("--")) return undefined;
  const dir = resolve(cwd, raw);
  // task_id is the dir basename; a root path has none and is not a usable task dir.
  return basename(dir) ? dir : undefined;
}

/** Value following --<name>; undefined when absent, throws when the flag has no value. */
export function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const raw = argv[i + 1];
  if (raw === undefined || raw.startsWith("--")) throw new Error(`--${name} requires a value`);
  return raw;
}

/** Seconds option → milliseconds. Rejects NaN/negative/empty instead of silently disabling timers. */
export function parseSeconds(name: string, raw: string | undefined, fallbackSecs: number): number {
  if (raw === undefined) return fallbackSecs * 1000;
  const n = raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative number of seconds (got ${JSON.stringify(raw)})`);
  }
  return n * 1000;
}

export function parseOptions(
  argv: readonly string[],
  cwd: string,
): { workdir: string; lingerMs: number; stallMs: number } {
  return {
    workdir: resolve(cwd, flagValue(argv, "workdir") ?? cwd),
    lingerMs: parseSeconds("linger", flagValue(argv, "linger"), 3600),
    stallMs: parseSeconds("stall", flagValue(argv, "stall"), 300),
  };
}

export function parseAgent(text: string): AgentSpec {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`agent.json is not valid JSON: ${errMsg(e)}`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("agent.json must be a JSON object");
  const a = v as Record<string, unknown>;
  if (a.name !== undefined && typeof a.name !== "string") throw new Error("agent.json: name must be a string");
  if (a.model !== undefined && a.model !== null) {
    const m = a.model as Record<string, unknown>;
    if (typeof m !== "object" || typeof m.id !== "string" || typeof m.providerID !== "string") {
      throw new Error("agent.json: model must be {id, providerID, variant?}");
    }
  }
  return a as AgentSpec;
}

export function bootstrap(argv: readonly string[], cwd: string): BootstrapResult {
  const outDir = resolveOutDir(argv, cwd);
  if (!outDir) return { ok: false, error: "--out-dir <dir> is required" };
  const taskID = basename(outDir);
  const statusFile = join(outDir, "status.json");
  try {
    const inboxDir = join(outDir, "inbox");
    // Create the dir first so later parse failures still have somewhere to persist status.
    mkdirSync(inboxDir, { recursive: true });
    const opts = parseOptions(argv, cwd);
    const agent = parseAgent(readFileSync(join(outDir, "agent.json"), "utf8"));
    const agentName = agent.name ?? "panel-member";
    return {
      ok: true,
      ctx: {
        outDir,
        taskID,
        ...opts,
        inboxDir,
        cancelFile: join(outDir, "CANCEL"),
        statusFile,
        resultFile: join(outDir, "result.md"),
        eventsFile: join(outDir, "events.jsonl"),
        agent,
        agentName,
        // S7: namespace registration per task so reused names never overwrite each other.
        effectiveAgentName: `${agentName}--${taskID}`,
      },
    };
  } catch (e) {
    return { ok: false, outDir, statusFile, taskID, error: `bootstrap: ${errMsg(e)}` };
  }
}

// ---------------------------------------------------------------------------
// status.json
// ---------------------------------------------------------------------------

export type StatusFields = { task_id: string; session_id?: string; status: Status; turn: number };

/** updated_at = this write; last_activity_at = last real turn progress (never the heartbeat). */
export function buildStatus(
  base: StatusFields,
  extra: Record<string, unknown>,
  nowMs: number,
  lastActivityMs: number,
): Record<string, unknown> {
  return {
    ...base,
    updated_at: new Date(nowMs).toISOString(),
    last_activity_at: new Date(lastActivityMs).toISOString(),
    ...extra,
  };
}

export function writeStatusFile(statusFile: string, payload: Record<string, unknown>) {
  const tmp = statusFile + ".tmp";
  writeFileSync(tmp, JSON.stringify(payload, null, 1));
  renameSync(tmp, statusFile);
}

/** Persist a bootstrap failure when the output dir is known; always reports on stderr. */
export function persistBootstrapFailure(
  f: BootstrapFailure,
  nowMs = Date.now(),
  log: (msg: string) => void = (m) => console.error(m),
): boolean {
  log(`[runner] fatal: ${f.error}`);
  if (!f.outDir || !f.statusFile) return false;
  try {
    writeStatusFile(
      f.statusFile,
      buildStatus({ task_id: f.taskID ?? basename(f.outDir), status: "error", turn: 0 }, { last_error: f.error }, nowMs, nowMs),
    );
  } catch (e) {
    log(`[runner] could not persist error status to ${f.statusFile}: ${errMsg(e)}`);
    return false;
  }
  try {
    appendFileSync(
      join(f.outDir, "events.jsonl"),
      JSON.stringify({ t: new Date(nowMs).toISOString(), kind: "fatal", phase: "bootstrap", error: f.error }) + "\n",
    );
  } catch {}
  return true;
}

// ---------------------------------------------------------------------------
// Result capture (pure helpers)
// ---------------------------------------------------------------------------

function isMessage(m: unknown): m is Msg {
  return !!m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string";
}

export function extractText(msg: any): string {
  return (msg?.content ?? [])
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("");
}

export function normalizeMessageList(raw: any): unknown[] {
  const list = Array.isArray(raw) ? raw : (raw?.data ?? raw?.messages ?? []);
  return Array.isArray(list) ? list : [];
}

/** Newest-first rows (one or more desc pages, store `seq` order) → deduped chronological order. */
export function toChronological(newestFirst: readonly unknown[]): Msg[] {
  const ids = new Set<string>();
  const out: Msg[] = [];
  for (const m of newestFirst) {
    if (!isMessage(m) || ids.has(m.id)) continue;
    ids.add(m.id);
    out.push(m);
  }
  return out.reverse();
}

export type TurnView = {
  /** Unconsumed rows before this turn's prompt (e.g. leftovers of a stalled/errored turn). */
  prior: Msg[];
  /** This turn's user message, when the prompt id was found. */
  anchor?: Msg;
  /** This turn's messages, chronological. */
  messages: Msg[];
  /** Last idle marker within the turn. */
  idle?: Msg;
  fingerprint: string;
};

/**
 * Scope a chronological list to the current turn: rows after the turn's own user message
 * (anchor = id returned by sessions.prompt). Without an anchor, fall back to every unconsumed row.
 */
export function scopeTurn(list: readonly unknown[], emitted: ReadonlySet<string>, anchorID?: string): TurnView {
  const fresh = list.filter(isMessage).filter((m) => !emitted.has(m.id));
  const at = anchorID ? fresh.findIndex((m) => m.id === anchorID) : -1;
  const messages = at >= 0 ? fresh.slice(at + 1) : fresh;
  const idle = [...messages].reverse().find((m) => m.type === "idle");
  return {
    prior: at >= 0 ? fresh.slice(0, at) : [],
    anchor: at >= 0 ? fresh[at] : undefined,
    messages,
    idle,
    fingerprint: messages.map((m) => `${m.id}:${JSON.stringify(m).length}`).join(","),
  };
}

export function isAssistantTerminal(m: Msg): boolean {
  return m.finish != null || m.time?.completed != null || m.error != null;
}

/**
 * A turn is settled when two consecutive reads are identical, the idle marker is present,
 * every assistant row is terminal, and a succeeded turn has produced some text (assistant
 * content can lag the idle marker). Callers stop retrying after a bounded number of reads.
 */
export function isTurnSettled(view: TurnView, prevFingerprint: string | undefined): boolean {
  if (prevFingerprint === undefined || view.fingerprint !== prevFingerprint) return false;
  if (!view.idle) return false;
  const assistants = view.messages.filter((m) => m.type === "assistant");
  if (assistants.some((m) => !isAssistantTerminal(m))) return false;
  if (view.idle.outcome === "succeeded" && !assistants.some((m) => extractText(m).trim())) return false;
  return true;
}

export type SettleResult = { view?: TurnView; settled: boolean; attempts: number; error?: string };

/** Re-read until the turn settles or attempts run out; the last good view is taken as-is. */
export async function settleTurn(
  read: () => Promise<readonly unknown[]>,
  emitted: ReadonlySet<string>,
  anchorID: string | undefined,
  opts: { attempts: number; delayMs: number; sleep?: (ms: number) => Promise<unknown> },
): Promise<SettleResult> {
  const nap = opts.sleep ?? sleep;
  let view: TurnView | undefined;
  let prev: string | undefined;
  let error: string | undefined;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    if (attempt > 0) await nap(opts.delayMs);
    let list: readonly unknown[];
    try {
      list = await read();
    } catch (e) {
      error = errMsg(e);
      continue;
    }
    const v = scopeTurn(list, emitted, anchorID);
    if (isTurnSettled(v, prev)) return { view: v, settled: true, attempts: attempt + 1 };
    prev = v.fingerprint;
    view = v;
  }
  return { view, settled: false, attempts: opts.attempts, error: view ? undefined : error };
}

/** Ordered assistant texts + failure reason for one turn's messages. */
export function summarizeTurn(messages: readonly Msg[]): { texts: string[]; failed?: string } {
  const texts: string[] = [];
  let failed: string | undefined;
  for (const m of messages) {
    if (m.type === "assistant") {
      const text = extractText(m);
      if (text.trim()) texts.push(text);
      if (m.error) failed = `${m.error.type ?? "error"}: ${m.error.message ?? "unknown"}`;
    } else if (m.type === "idle" && m.outcome === "failed") {
      failed = m.error?.message ?? "turn failed";
    }
  }
  return { texts, failed };
}

/** Exactly one section per completed turn; empty turns get a placeholder to keep numbering visible. */
export function renderTurnSection(turn: number, texts: readonly string[], note?: string): string {
  const body = texts.filter((t) => t.trim()).join("\n\n") || `_(${note ?? "no assistant text"})_`;
  return `\n\n## Turn ${turn}\n\n${body}`;
}

// ---------------------------------------------------------------------------
// Watchdog (pure helpers)
// ---------------------------------------------------------------------------

/** Size probe: true when any message is new or larger than last seen. */
export function recordGrowth(seen: Map<string, number>, list: readonly unknown[]): boolean {
  let grew = false;
  for (const m of list) {
    if (!isMessage(m)) continue;
    const size = JSON.stringify(m).length;
    if ((seen.get(m.id) ?? 0) < size) {
      seen.set(m.id, size);
      grew = true;
    }
  }
  return grew;
}

export type PermissionNote = {
  type: string;
  sessionID: string;
  id?: string;
  action?: string;
  resources?: string[];
  reply?: string;
  message?: string;
  rules?: number;
};

export type EventClass = {
  /** Real progress for a tracked session; bumps the stall clock while a turn runs. */
  activity: boolean;
  connected?: boolean;
  /** Child session (e.g. subagent) to track from now on. */
  child?: string;
  permission?: PermissionNote;
};

/**
 * Classify one engine event for the watchdog. Only events for tracked sessions (ours plus
 * children it spawns) count; `server.connected` and `rpc.*` are transport plumbing, and global
 * events without a sessionID (model refreshes, config, etc.) say nothing about this turn.
 */
export function classifyEvent(ev: unknown, tracked: ReadonlySet<string>): EventClass {
  const e = ev as { type?: unknown; data?: any } | null | undefined;
  const type = typeof e?.type === "string" ? e.type : undefined;
  if (!type) return { activity: false };
  if (type === "server.connected") return { activity: false, connected: true };
  if (type.startsWith("rpc.")) return { activity: false };
  const data = e?.data && typeof e.data === "object" ? e.data : {};
  const sid = typeof data.sessionID === "string" ? data.sessionID : undefined;
  if (!sid) return { activity: false };
  if (type === "session.created" && typeof data.parentID === "string" && tracked.has(data.parentID)) {
    return { activity: true, child: sid };
  }
  if (!tracked.has(sid)) return { activity: false };
  if (type === "permission.asked") {
    return {
      activity: true,
      permission: {
        type,
        sessionID: sid,
        id: data.id,
        action: data.action,
        resources: Array.isArray(data.resources) ? data.resources.slice(0, 20) : undefined,
        message: typeof data.message === "string" ? data.message.slice(0, 500) : undefined,
      },
    };
  }
  if (type === "permission.replied") {
    return { activity: true, permission: { type, sessionID: sid, id: data.requestID, reply: data.reply } };
  }
  if (type === "session.permissions") {
    const rules = Array.isArray(data.permissions) ? data.permissions.length : undefined;
    return { activity: true, permission: { type, sessionID: sid, rules } };
  }
  return { activity: true };
}

export function stallMessage(stallMs: number, pendingPermissions: readonly string[]): string {
  const base = `stalled: no events for ${stallMs / 1000}s`;
  const pending = [...new Set(pendingPermissions)];
  return pending.length ? `${base} (awaiting permission: ${pending.join(", ")})` : base;
}

export const ASK_DENY_MESSAGE = "headless panel runner: permission asks are denied (no approver)";

/** Terminal headless rule for the permission.evaluate hook: ask becomes a clean deny. */
export function denyPermissionAsk(event: { effect: string; message?: string }): void {
  if (event.effect !== "ask") return;
  event.effect = "deny";
  event.message = ASK_DENY_MESSAGE;
}

/**
 * Session-level enforcement copy of the resolved agent ruleset. A hand-written
 * agent.json without resolved rules falls back to baseline + question denies
 * rather than the engine's allow-all agent default.
 */
export function sessionPermissionsFrom(agentPermissions: unknown): PermissionRule[] {
  return Array.isArray(agentPermissions)
    ? [...(agentPermissions as PermissionRule[])]
    : [...BASELINE_DENY, QUESTION_DENY];
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

let ctx: RunnerContext | undefined;
let sessionID: string | undefined;
let turn = 0;
/** True between prompt submission and turn capture; gates event/probe activity. */
let turnActive = false;
/** In-memory stall clock and source of status.json last_activity_at. */
let lastActivity = Date.now();
/** Last status.json write; basis for linger, mirroring the supervisor's updated_at + linger. */
let lastStatusWriteAt = Date.now();

function runtime(): RunnerContext {
  if (!ctx) throw new Error("runner context not initialised");
  return ctx;
}

function markActivity() {
  lastActivity = Date.now();
}

function setStatus(status: Status, extra: Record<string, unknown> = {}) {
  const c = runtime();
  const now = Date.now();
  writeStatusFile(c.statusFile, buildStatus({ task_id: c.taskID, session_id: sessionID, status, turn }, extra, now, lastActivity));
  lastStatusWriteAt = now;
}

function logEvent(obj: unknown) {
  appendFileSync(runtime().eventsFile, JSON.stringify({ t: new Date().toISOString(), ...(obj as object) }) + "\n");
}

function logEventQuiet(obj: unknown) {
  try {
    logEvent(obj);
  } catch {}
}

async function interruptQuietly(oc: Client, sid: string) {
  try {
    await withTimeout(oc.sessions.interrupt({ sessionID: sid }), INTERRUPT_TIMEOUT_MS, "interrupt");
  } catch {}
}

function makeAgentPlugin(P: typeof PluginNS, c: RunnerContext) {
  const agent: any = c.agent;
  return P.define({
    id: "panel-agent",
    async setup(pctx) {
      await pctx.agent.transform((editor) => {
        editor.update(c.effectiveAgentName, (a) => {
          a.description = agent.description ?? `Panel agent ${c.agentName}`;
          a.mode = agent.mode ?? "primary";
          a.hidden = true;
          if (agent.system) a.system = agent.system;
          if (agent.model) {
            // SDK runtime shape; published types lag the embedded host.
            (a as any).model = {
              providerID: agent.model.providerID,
              model: agent.model.id,
              variant: agent.model.variant,
            };
          }
          // Mirror of the session-enforced ruleset for agent-scoped consumers.
          // Config transforms append in place; never hand them the parsed source array.
          if (agent.permissions) a.permissions = [...agent.permissions];
        });
      });
      // Headless terminal rule: no evaluation may end in ask (no approver exists).
      // Session rules already resolve every check; this converts residual asks
      // from any other source. Failure to register is logged, not fatal.
      try {
        await pctx.permission.hook("evaluate", (event) => {
          if (event.effect !== "ask") return;
          denyPermissionAsk(event);
          logEventQuiet({
            kind: "permission_ask_denied",
            sessionID: event.sessionID,
            action: event.action,
            resources: [...event.resources].slice(0, 20),
          });
        });
      } catch (e) {
        logEventQuiet({ kind: "permission_hook_failed", error: errMsg(e) });
      }
    },
  });
}

/**
 * Turn-scoped messages, newest-first pages until this turn's user message (or an already
 * consumed row) is seen, returned chronologically. message.list defaults to desc/50, which both
 * reversed multi-message turns and could drop the start of long turns.
 */
async function listTurnWindow(
  oc: Client,
  sid: string,
  anchorID: string | undefined,
  emitted: ReadonlySet<string>,
): Promise<Msg[]> {
  const rows: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const raw: any = await withTimeout(
      cursor
        ? oc.message.list({ sessionID: sid, cursor, limit: LIST_PAGE_SIZE })
        : oc.message.list({ sessionID: sid, order: "desc", limit: LIST_PAGE_SIZE }),
      LIST_TIMEOUT_MS,
      "message.list",
    );
    const data = normalizeMessageList(raw);
    rows.push(...data);
    const reachedKnown = data.some((m) => isMessage(m) && (m.id === anchorID || emitted.has(m.id)));
    const next = raw?.cursor?.next;
    if (reachedKnown || data.length < LIST_PAGE_SIZE || typeof next !== "string" || !next) break;
    cursor = next;
  }
  return toChronological(rows);
}

type EventWatch = {
  state(): string;
  pendingPermissions(): string[];
  beginTurn(): void;
  stop(): Promise<void>;
};

/**
 * Event-driven watchdog input. Subscribed once per session; real events for tracked sessions
 * bump the same in-memory stall clock as the size probe. The embedded host serves the stream
 * in-process (GET /api/event via host.fetch). If it never connects or fails later, that is logged
 * (events_failed / events_ended) and the size probe keeps guarding the turn; there is no resubscribe.
 */
function startEventWatch(oc: Client, sid: string): EventWatch {
  const abort = new AbortController();
  const tracked = new Set<string>([sid]);
  const pending = new Map<string, string>();
  let state: "connecting" | "live" | "ended" | "failed" | "stopped" = "connecting";
  const pump = (async () => {
    try {
      // Deliberately no onActivity: SSE keepalive frames prove the connection is alive, not that
      // the turn is progressing; counting them would keep a hung turn looking healthy forever.
      for await (const ev of oc.events.subscribe({ signal: abort.signal })) {
        const c = classifyEvent(ev, tracked);
        if (c.connected && state === "connecting") {
          state = "live";
          logEventQuiet({ kind: "events_connected" });
        }
        if (c.child) tracked.add(c.child);
        if (c.permission) {
          const p = c.permission;
          if (p.type === "permission.asked" && p.id) pending.set(p.id, p.action ?? "unknown");
          if (p.type === "permission.replied" && p.id) pending.delete(p.id);
          logEventQuiet({ kind: "permission", turn, ...p });
        }
        if (c.activity && turnActive) markActivity();
      }
      if (!abort.signal.aborted) {
        state = "ended";
        logEventQuiet({ kind: "events_ended", turn });
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        state = "failed";
        logEventQuiet({ kind: "events_failed", turn, error: errMsg(e) });
      }
    }
  })();
  return {
    state: () => state,
    pendingPermissions: () => [...pending.values()],
    beginTurn: () => pending.clear(),
    async stop() {
      state = "stopped";
      abort.abort();
      await Promise.race([pump, sleep(1000)]);
    },
  };
}

async function main(c: RunnerContext) {
  setStatus("booting");
  // Loaded lazily so a module-load failure lands in the caught, status-persisting path
  // (and so tests can import the pure helpers above without loading the SDK).
  const [{ OpenCode }, { Plugin }] = await Promise.all([import("@opencode/sdk"), import("@opencode/plugin")]);
  const oc = await OpenCode.create({
    plugins: [makeAgentPlugin(Plugin, c)],
    database: {
      path: `${process.env.HOME}/.local/share/opencode/opencode.db`,
    },
  });
  logEvent({ kind: "host_started", workdir: c.workdir, agent: c.agentName });

  let watch: EventWatch | undefined;
  try {
    const s = await oc.sessions.create({
      title: `${c.taskID} (${c.agentName})`,
      agent: c.effectiveAgentName,
      model: c.agent.model
        ? { id: c.agent.model.id, providerID: c.agent.model.providerID, variant: c.agent.model.variant }
        : undefined,
      location: { directory: c.workdir },
      // Enforcement copy: session rules merge after all agent/config rules and
      // are inherited by child sessions, so discovered config cannot widen,
      // narrow, or ask-ify the operator's resolved member policy.
      permissions: sessionPermissionsFrom(c.agent.permissions),
    });
    sessionID = s.id;
    setStatus("ready");
    logEvent({ kind: "session_created", sessionID: s.id, model: s.model });
    const events = startEventWatch(oc, s.id);
    watch = events;

    const seen = new Map<string, number>();
    const emitted = new Set<string>();
    let nextInbox = 1;
    let probeInFlight = false;
    // Fallback liveness: fire-and-forget (bounded) so a hung list() can never block the stall check.
    const probe = (forTurn: number) => {
      if (probeInFlight) return;
      probeInFlight = true;
      withTimeout(oc.message.list({ sessionID: s.id }), LIST_TIMEOUT_MS, "probe")
        .then((raw) => {
          if (recordGrowth(seen, normalizeMessageList(raw)) && turnActive && turn === forTurn) markActivity();
        })
        .catch(() => {})
        .finally(() => {
          probeInFlight = false;
        });
    };

    while (true) {
      if (existsSync(c.cancelFile)) {
        await interruptQuietly(oc, s.id);
        setStatus("cancelled");
        logEvent({ kind: "cancelled" });
        return;
      }

      const inboxPath = join(c.inboxDir, `followup-${nextInbox}.txt`);
      let promptText: string | undefined;
      if (turn === 0) {
        promptText = readFileSync(join(c.outDir, "packet.md"), "utf8");
      } else if (existsSync(inboxPath)) {
        promptText = readFileSync(inboxPath, "utf8");
        nextInbox++;
      } else {
        if (Date.now() - lastStatusWriteAt > c.lingerMs) {
          setStatus("exited");
          logEvent({ kind: "linger_timeout" });
          return;
        }
        await sleep(500);
        continue;
      }

      turn++;
      turnActive = true;
      events.beginTurn();
      markActivity();
      setStatus("running", { last_error: undefined });
      logEvent({ kind: "prompt", turn, text: promptText.slice(0, 4000) });

      let anchorID: string | undefined;
      try {
        const queued: any = await oc.sessions.prompt({ sessionID: s.id, text: promptText });
        anchorID = typeof queued?.id === "string" ? queued.id : undefined;
      } catch (e) {
        turnActive = false;
        setStatus("error", { last_error: `prompt rejected: ${errMsg(e)}` });
        logEvent({ kind: "prompt_error", turn, error: errMsg(e) });
        continue;
      }

      // Wait for turn end, racing cancel + stall watchdog.
      let errored = false;
      let done = false;
      let ticks = 0;
      while (!done) {
        done = await Promise.race([
          oc.sessions.wait({ sessionID: s.id }).then(() => true),
          sleep(1000).then(() => false),
        ]).catch((e) => {
          setStatus("error", { last_error: `wait failed: ${errMsg(e)}` });
          logEvent({ kind: "wait_error", turn, error: errMsg(e) });
          errored = true;
          return true;
        });
        if (existsSync(c.cancelFile)) {
          await interruptQuietly(oc, s.id);
          setStatus("cancelled");
          logEvent({ kind: "cancelled" });
          return;
        }
        // S3: runner owns stall. Heartbeat refreshes updated_at only (process observable);
        // last_activity_at keeps the last real progress so the supervisor can see a hung turn.
        if (!done && ++ticks % HEARTBEAT_TICKS === 0) {
          setStatus("running", { last_error: undefined });
          probe(turn);
        }
        const quietMs = Date.now() - lastActivity;
        if (!done && quietMs > c.stallMs) {
          const pendingPerms = events.pendingPermissions();
          await interruptQuietly(oc, s.id);
          setStatus("error", { last_error: stallMessage(c.stallMs, pendingPerms) });
          logEvent({ kind: "stalled", turn, quiet_ms: quietMs, events: events.state(), pending_permissions: pendingPerms });
          errored = true;
          break;
        }
      }
      if (errored) {
        turnActive = false;
        continue;
      }

      // Settle, then capture the whole turn at once: assistant content can lag the idle marker,
      // and a turn may span several assistant messages, so nothing is appended until reads agree.
      const cap = await settleTurn(() => listTurnWindow(oc, s.id, anchorID, emitted), emitted, anchorID, {
        attempts: SETTLE_ATTEMPTS,
        delayMs: SETTLE_DELAY_MS,
      });
      let texts: string[] = [];
      let failed: string | undefined;
      let note: string | undefined;
      if (cap.view) {
        const v = cap.view;
        // Leftovers of an earlier stalled/errored turn: consumed so they never pollute this
        // turn's section, but kept (bounded) in the audit log rather than silently dropped.
        for (const m of v.prior) {
          emitted.add(m.id);
          if (m.type === "assistant") {
            logEvent({ kind: "prior_turn_message", turn, id: m.id, type: m.type, finish: m.finish, text: extractText(m).slice(0, 4000) });
          } else if (m.type === "idle") {
            logEvent({ kind: "prior_turn_message", turn, id: m.id, type: m.type, outcome: m.outcome });
          }
        }
        if (v.anchor) emitted.add(v.anchor.id);
        for (const m of v.messages) {
          emitted.add(m.id);
          if (m.type === "assistant") {
            logEvent({ kind: "assistant", turn, id: m.id, finish: m.finish, tokens: m.tokens, cost: m.cost, attempt: cap.attempts - 1 });
          } else if (m.type === "idle") {
            logEvent({ kind: "idle", turn, outcome: m.outcome });
          }
        }
        ({ texts, failed } = summarizeTurn(v.messages));
        if (failed) note = `no assistant text; ${failed}`;
        if (!cap.settled) logEvent({ kind: "settle_timeout", turn, attempts: cap.attempts });
      } else {
        failed = `result capture failed: ${cap.error ?? "no messages"}`;
        note = failed;
        logEvent({ kind: "capture_error", turn, error: cap.error });
      }
      appendFileSync(c.resultFile, renderTurnSection(turn, texts, note));
      turnActive = false;
      markActivity(); // completed turn output is real activity
      setStatus(failed ? "error" : "idle", failed ? { last_error: failed } : { last_error: undefined });
    }
  } finally {
    turnActive = false;
    await watch?.stop();
    try {
      await oc.close();
    } catch {}
    logEventQuiet({ kind: "host_closed" });
  }
}

function persistFatal(message: string, e: unknown) {
  try {
    setStatus("error", { last_error: message });
  } catch (w) {
    console.error(`[runner] could not persist error status: ${errMsg(w)}`);
  }
  logEventQuiet({ kind: "fatal", error: String((e as { stack?: unknown } | null)?.stack ?? e) });
  console.error(`[runner] ${message}`);
}

async function start(argv: readonly string[]): Promise<never> {
  const boot = bootstrap(argv, process.cwd());
  if (!boot.ok) {
    // Persists status.json only when the out dir resolved; otherwise stderr only, never a guessed path.
    persistBootstrapFailure(boot);
    process.exit(boot.outDir ? 1 : 2);
  }
  ctx = boot.ctx;
  try {
    await main(boot.ctx);
  } catch (e) {
    persistFatal(`fatal: ${errMsg(e)}`, e);
    process.exit(1);
  }
  // Exit explicitly so a lingering host handle (e.g. the event stream) can't leave a zombie runner.
  process.exit(0);
}

if (import.meta.main) void start(process.argv);
