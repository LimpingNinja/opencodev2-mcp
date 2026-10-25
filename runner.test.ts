import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrap,
  buildStatus,
  classifyEvent,
  denyPermissionAsk,
  errMsg,
  extractText,
  isTurnSettled,
  parseAgent,
  parseSeconds,
  persistBootstrapFailure,
  recordGrowth,
  renderTurnSection,
  resolveOutDir,
  scopeTurn,
  sessionPermissionsFrom,
  settleTurn,
  stallMessage,
  summarizeTurn,
  toChronological,
  withTimeout,
} from "./runner.ts";

// Importing runner.ts must not start the worker (guarded by import.meta.main); if it did,
// it would exit this process for lack of --out-dir before any test ran.

const tmpRoots: string[] = [];
function tmpTaskDir(name = "ocv2-test-task"): string {
  const root = mkdtempSync(join(tmpdir(), "runner-test-"));
  tmpRoots.push(root);
  return join(root, name);
}
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const asst = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "assistant",
  content: text ? [{ type: "text", text }] : [],
  ...extra,
});
const user = (id: string, text = "q") => ({ id, type: "user", text });
const idle = (id: string, outcome = "succeeded", extra: Record<string, unknown> = {}) => ({ id, type: "idle", outcome, ...extra });

describe("bootstrap (item 7)", () => {
  test("unresolvable out dir yields no path to write", () => {
    for (const argv of [[], ["--out-dir"], ["--out-dir", ""], ["--out-dir", "--workdir", "/x"], ["--out-dir", "/"]]) {
      const r = bootstrap(["bun", "runner.ts", ...argv], "/tmp");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.outDir).toBeUndefined();
        expect(r.statusFile).toBeUndefined();
      }
    }
  });

  test("resolveOutDir resolves relative to cwd", () => {
    expect(resolveOutDir(["--out-dir", "tasks/t1"], "/base")).toBe("/base/tasks/t1");
  });

  test("missing agent.json persists error status + fatal event", () => {
    const dir = tmpTaskDir("ocv2-missing-agent");
    const r = bootstrap(["--out-dir", dir], "/tmp");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.outDir).toBe(dir);
    expect(existsSync(join(dir, "inbox"))).toBe(true);
    const logs: string[] = [];
    const now = Date.parse("2026-10-24T12:00:00Z");
    expect(persistBootstrapFailure(r, now, (m) => logs.push(m))).toBe(true);
    const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
    expect(status).toMatchObject({ task_id: "ocv2-missing-agent", status: "error", turn: 0 });
    expect(status.last_error).toContain("agent.json");
    expect(status.updated_at).toBe("2026-10-24T12:00:00.000Z");
    expect(status.outcome).toBeUndefined();
    expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toContain('"kind":"fatal"');
    expect(logs[0]).toContain("fatal");
  });

  test("bad numeric option is a persisted bootstrap error, not a silently disabled timer", () => {
    const dir = tmpTaskDir();
    const first = bootstrap(["--out-dir", dir], "/tmp"); // creates dir
    expect(first.ok).toBe(false);
    writeFileSync(join(dir, "agent.json"), JSON.stringify({ name: "a" }));
    const r = bootstrap(["--out-dir", dir, "--stall", "abc"], "/tmp");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("--stall");
    persistBootstrapFailure(r, Date.now(), () => {});
    expect(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).last_error).toContain("--stall");
  });

  test("valid inputs produce a context", () => {
    const dir = tmpTaskDir("ocv2-ok");
    bootstrap(["--out-dir", dir], "/tmp");
    writeFileSync(join(dir, "agent.json"), JSON.stringify({ name: "alpha", model: { id: "m", providerID: "p" } }));
    const r = bootstrap(["--out-dir", dir, "--workdir", "w", "--linger", "1.5", "--stall", "0"], "/base");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ctx).toMatchObject({
      taskID: "ocv2-ok",
      workdir: "/base/w",
      lingerMs: 1500,
      stallMs: 0,
      agentName: "alpha",
      effectiveAgentName: "alpha--ocv2-ok",
      statusFile: join(dir, "status.json"),
    });
  });

  test("no out dir: stderr only, nothing written", () => {
    const logs: string[] = [];
    expect(persistBootstrapFailure({ ok: false, error: "--out-dir <dir> is required" }, 0, (m) => logs.push(m))).toBe(false);
    expect(logs.join("\n")).toContain("--out-dir");
  });

  test("parseSeconds / parseAgent validation", () => {
    expect(parseSeconds("linger", undefined, 3600)).toBe(3_600_000);
    expect(parseSeconds("linger", "2", 3600)).toBe(2000);
    for (const bad of ["", " ", "abc", "-1", "Infinity"]) expect(() => parseSeconds("stall", bad, 1)).toThrow("--stall");
    expect(() => parseAgent("{")).toThrow("not valid JSON");
    expect(() => parseAgent("[]")).toThrow("JSON object");
    expect(() => parseAgent(JSON.stringify({ model: { id: 1 } }))).toThrow("model");
    expect(parseAgent(JSON.stringify({ name: "x" })).name).toBe("x");
  });
});

describe("status freshness (item 6)", () => {
  test("updated_at tracks the write; last_activity_at tracks real progress", () => {
    const s = buildStatus({ task_id: "t", status: "running", turn: 2 }, { last_error: undefined }, 10_000, 4_000);
    expect(s.updated_at).toBe(new Date(10_000).toISOString());
    expect(s.last_activity_at).toBe(new Date(4_000).toISOString());
    expect(JSON.parse(JSON.stringify(s))).toEqual({
      task_id: "t",
      status: "running",
      turn: 2,
      updated_at: new Date(10_000).toISOString(),
      last_activity_at: new Date(4_000).toISOString(),
    });
  });
});

describe("result capture (item 4)", () => {
  test("toChronological reverses desc pages and dedupes", () => {
    const out = toChronological([{ id: "c" }, { id: "b" }, { id: "b" }, { id: "a" }, null, { nope: 1 }]);
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  test("scopeTurn splits leftovers from an earlier errored turn at this turn's prompt", () => {
    const list = [user("u1"), asst("a1", "old"), idle("i1"), user("u2"), asst("a2", "partial"), idle("i2", "interrupted"), user("u3"), asst("a3", "new"), idle("i3")];
    const v = scopeTurn(list, new Set(["u1", "a1", "i1"]), "u3");
    expect(v.prior.map((m) => m.id)).toEqual(["u2", "a2", "i2"]);
    expect(v.anchor?.id).toBe("u3");
    expect(v.messages.map((m) => m.id)).toEqual(["a3", "i3"]);
    expect(v.idle?.id).toBe("i3");
  });

  test("scopeTurn without a known anchor falls back to all unconsumed rows", () => {
    const v = scopeTurn([user("u1"), asst("a1", "x"), idle("i1")], new Set(["u1"]), "missing");
    expect(v.prior).toEqual([]);
    expect(v.messages.map((m) => m.id)).toEqual(["a1", "i1"]);
  });

  test("settle requires a repeated identical read, idle, terminal assistants", () => {
    const done = [user("u"), asst("a", "hi", { finish: "stop" }), idle("i")];
    const v = scopeTurn(done, new Set(), "u");
    expect(isTurnSettled(v, undefined)).toBe(false);
    expect(isTurnSettled(v, v.fingerprint)).toBe(true);
    const streaming = scopeTurn([user("u"), asst("a", "hi"), idle("i")], new Set(), "u");
    expect(isTurnSettled(streaming, streaming.fingerprint)).toBe(false);
    const noIdle = scopeTurn([user("u"), asst("a", "hi", { finish: "stop" })], new Set(), "u");
    expect(isTurnSettled(noIdle, noIdle.fingerprint)).toBe(false);
    const empty = scopeTurn([user("u"), asst("a", "", { finish: "stop" }), idle("i")], new Set(), "u");
    expect(isTurnSettled(empty, empty.fingerprint)).toBe(false); // succeeded but text not landed yet
    const failedEmpty = scopeTurn([user("u"), asst("a", "", { finish: "error" }), idle("i", "failed")], new Set(), "u");
    expect(isTurnSettled(failedEmpty, failedEmpty.fingerprint)).toBe(true);
  });

  test("delayed later assistant text is not lost to an early break", async () => {
    const reads = [
      [user("u"), asst("a1", "first", { finish: "tool-calls" }), asst("a2", "")],
      [user("u"), asst("a1", "first", { finish: "tool-calls" }), asst("a2", "second", { finish: "stop" }), idle("i")],
      [user("u"), asst("a1", "first", { finish: "tool-calls" }), asst("a2", "second", { finish: "stop" }), idle("i")],
    ];
    let n = 0;
    const naps: number[] = [];
    const r = await settleTurn(async () => reads[Math.min(n++, reads.length - 1)]!, new Set(), "u", {
      attempts: 6,
      delayMs: 700,
      sleep: async (ms) => void naps.push(ms),
    });
    expect(r.settled).toBe(true);
    expect(r.attempts).toBe(3);
    expect(naps).toEqual([700, 700]);
    const { texts, failed } = summarizeTurn(r.view!.messages);
    expect(texts).toEqual(["first", "second"]);
    expect(failed).toBeUndefined();
    const section = renderTurnSection(4, texts);
    expect(section.match(/## Turn /g)).toHaveLength(1);
    expect(section).toBe("\n\n## Turn 4\n\nfirst\n\nsecond");
  });

  test("settle is bounded and takes the last view as-is", async () => {
    let n = 0;
    const r = await settleTurn(async () => [user("u"), asst("a", "x".repeat(++n))], new Set(), "u", {
      attempts: 4,
      delayMs: 1,
      sleep: async () => {},
    });
    expect(r.settled).toBe(false);
    expect(r.attempts).toBe(4);
    expect(extractText(r.view!.messages[0])).toBe("xxxx");
  });

  test("read failures are contained and reported", async () => {
    const r = await settleTurn(async () => Promise.reject(new Error("boom")), new Set(), undefined, {
      attempts: 3,
      delayMs: 1,
      sleep: async () => {},
    });
    expect(r.view).toBeUndefined();
    expect(r.error).toBe("boom");
  });

  test("summarizeTurn reports failures; empty turns still get exactly one section", () => {
    const s = summarizeTurn([asst("a", "", { error: { type: "provider", message: "401" } }), idle("i", "failed", { error: { message: "bad" } })] as any);
    expect(s.texts).toEqual([]);
    expect(s.failed).toBe("bad");
    expect(renderTurnSection(2, [])).toBe("\n\n## Turn 2\n\n_(no assistant text)_");
    expect(renderTurnSection(2, ["  "], "no assistant text; bad")).toBe("\n\n## Turn 2\n\n_(no assistant text; bad)_");
  });

  test("extractText ignores non-text parts", () => {
    expect(extractText({ content: [{ type: "reasoning", text: "r" }, { type: "text", text: "a" }, { type: "text" }, { type: "tool" }] })).toBe("a");
    expect(extractText(undefined)).toBe("");
  });
});

describe("watchdog helpers (item 9)", () => {
  const tracked = new Set(["ses_me"]);

  test("only session-scoped real events count as activity", () => {
    expect(classifyEvent({ type: "server.connected", data: {} }, tracked)).toEqual({ activity: false, connected: true });
    expect(classifyEvent({ type: "rpc.ping", data: { sessionID: "ses_me" } }, tracked).activity).toBe(false);
    expect(classifyEvent({ type: "session.text.delta", data: { sessionID: "ses_me", delta: "x" } }, tracked)).toEqual({ activity: true });
    expect(classifyEvent({ type: "session.text.delta", data: { sessionID: "ses_other" } }, tracked).activity).toBe(false);
    expect(classifyEvent({ type: "filesystem.changed", data: { file: "a", event: "add" } }, tracked).activity).toBe(false);
    expect(classifyEvent({ type: "models-dev.refreshed", data: {} }, tracked).activity).toBe(false);
    expect(classifyEvent(null, tracked).activity).toBe(false);
    expect(classifyEvent({ data: { sessionID: "ses_me" } }, tracked).activity).toBe(false);
  });

  test("child sessions of tracked sessions are adopted", () => {
    expect(classifyEvent({ type: "session.created", data: { sessionID: "ses_child", parentID: "ses_me" } }, tracked)).toEqual({
      activity: true,
      child: "ses_child",
    });
    expect(classifyEvent({ type: "session.created", data: { sessionID: "ses_x", parentID: "ses_other" } }, tracked).child).toBeUndefined();
  });

  test("permission events are surfaced distinctly", () => {
    const asked = classifyEvent(
      { type: "permission.asked", data: { id: "per_1", sessionID: "ses_me", action: "bash", resources: ["rm -rf"], message: "ok?" } },
      tracked,
    );
    expect(asked).toEqual({
      activity: true,
      permission: { type: "permission.asked", sessionID: "ses_me", id: "per_1", action: "bash", resources: ["rm -rf"], message: "ok?" },
    });
    const replied = classifyEvent({ type: "permission.replied", data: { sessionID: "ses_me", requestID: "per_1", reply: "reject" } }, tracked);
    expect(replied.permission).toEqual({ type: "permission.replied", sessionID: "ses_me", id: "per_1", reply: "reject" });
    const rules = classifyEvent({ type: "session.permissions", data: { sessionID: "ses_me", permissions: [{}, {}] } }, tracked);
    expect(rules.permission).toEqual({ type: "session.permissions", sessionID: "ses_me", rules: 2 });
    expect(classifyEvent({ type: "permission.asked", data: { id: "p", sessionID: "ses_other" } }, tracked).permission).toBeUndefined();
  });

  test("size probe detects new and growing messages only", () => {
    const seen = new Map<string, number>();
    expect(recordGrowth(seen, [asst("a", "x")])).toBe(true);
    expect(recordGrowth(seen, [asst("a", "x")])).toBe(false);
    expect(recordGrowth(seen, [asst("a", "xy")])).toBe(true);
    expect(recordGrowth(seen, [null, { foo: 1 }])).toBe(false);
  });

  test("stall message names pending permissions", () => {
    expect(stallMessage(300_000, [])).toBe("stalled: no events for 300s");
    expect(stallMessage(5_000, ["bash", "bash", "edit"])).toBe("stalled: no events for 5s (awaiting permission: bash, edit)");
  });
});

describe("headless permission enforcement", () => {
  test("ask evaluations become denies; allow/deny pass through untouched", () => {
    const ask = { effect: "ask", message: undefined as string | undefined };
    denyPermissionAsk(ask as never);
    expect(ask.effect).toBe("deny");
    expect(ask.message).toContain("headless");
    for (const effect of ["allow", "deny"] as const) {
      const ev = { effect, message: "keep" };
      denyPermissionAsk(ev as never);
      expect(ev).toEqual({ effect, message: "keep" });
    }
  });

  test("session permissions copy the resolved agent rules; fallback denies secrets and question", () => {
    const resolved = [{ action: "read", resource: "*", effect: "allow" as const }];
    const copied = sessionPermissionsFrom(resolved);
    expect(copied).toEqual(resolved);
    expect(copied).not.toBe(resolved);
    for (const bad of [undefined, "rules", 42, null]) {
      const fallback = sessionPermissionsFrom(bad) as { action: string; effect: string }[];
      expect(fallback.length).toBeGreaterThan(1);
      expect(fallback.every((r) => r.effect === "deny")).toBe(true);
      expect(fallback.at(-1)).toMatchObject({ action: "question", effect: "deny" });
      expect(fallback.some((r) => r.action === "read")).toBe(true);
    }
  });
});

describe("small utilities", () => {
  test("errMsg", () => {
    expect(errMsg(new Error("e"))).toBe("e");
    expect(errMsg({ message: "m" })).toBe("m");
    expect(errMsg("s")).toBe("s");
  });

  test("withTimeout resolves or rejects deterministically", async () => {
    expect(await withTimeout(Promise.resolve(7), 1000, "x")).toBe(7);
    await expect(withTimeout(new Promise(() => {}), 5, "list")).rejects.toThrow("list timed out after 5ms");
  });
});
