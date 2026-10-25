import { describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Package export resolves to @opencode/core/dist/permission.js (not a local matcher).
import { evaluate } from "@opencode/core/permission";
import {
  BASELINE_DENY, PERMISSION_PRESETS, PERMISSION_PRESET_NAMES, QUESTION_DENY, cancellationOutcome, cleanupActivityMs,
  computeResumable, computeTerminal, dedupeModels, expandWorkdir,
  isValidMemberName, isValidTaskId, isValidPanelId, nextFollowupNumber, panelCleanupReason,
  resolvePermissions,
} from "./contracts.ts";

describe("path-safe identifiers", () => {
  test("accepts ordinary names and discoverable single-component IDs", () => {
    for (const name of ["de-astra", "Agent_2.v1", "a..b", "0", "a".repeat(128)]) {
      expect(isValidMemberName(name)).toBe(true);
      expect(isValidTaskId(`ocv2-${name}-m123-abcd`)).toBe(true);
    }
    expect(isValidPanelId("panel-m123-abcd")).toBe(true);
    expect(isValidTaskId("ocv2-" + "a".repeat(250))).toBe(true);
    expect(isValidPanelId("panel-" + "a".repeat(244))).toBe(true);
  });

  test("rejects traversal, nesting, absolute paths, hidden/empty names and control characters", () => {
    for (const name of ["", ".", "..", "../escape", "safe/../../escape", "nested/name", "/absolute", "a\\b", "C:drive", ".hidden", "with space", "a\0b", "a\nb", "a\n", "a\r", "a\u2028", "é"]) {
      expect(isValidMemberName(name)).toBe(false);
    }
    for (const id of ["", "ocv2-", "../ocv2-a", "/ocv2-a", "ocv2-../../escape", "ocv2-a/nested", "ocv2-a/../b", "ocv2-a\\b", "ocv2-a\0", "ocv2-a\n", "other-a"]) {
      expect(isValidTaskId(id)).toBe(false);
    }
    for (const id of ["", "panel-", "../panel-a", "panel-../../escape", "panel-a/nested", "panel-a\\b", "panel-a\n", "ocv2-a"]) {
      expect(isValidPanelId(id)).toBe(false);
    }
  });

  test("bounds component lengths before filesystem operations", () => {
    expect(isValidMemberName("a".repeat(129))).toBe(false);
    expect(isValidTaskId("ocv2-" + "a".repeat(251))).toBe(false);
    expect(isValidPanelId("panel-" + "a".repeat(245))).toBe(false);
  });
});

describe("follow-up numbering policy", () => {
  test("uses contiguous positive numeric slots and fills the first gap", () => {
    expect(nextFollowupNumber([])).toBe(1);
    expect(nextFollowupNumber(["followup-1.txt", "followup-2.txt"])).toBe(3);
    expect(nextFollowupNumber(["followup-3.txt", "followup-1.txt", "followup-10.txt"])).toBe(2);
    expect(nextFollowupNumber(["followup-2.txt"])).toBe(1);
    expect(nextFollowupNumber(Array.from({ length: 12 }, (_, i) => `followup-${i + 1}.txt`))).toBe(13);
  });

  test("ignores temps, malformed names, noncanonical numbers and unsafe integers", () => {
    expect(nextFollowupNumber([
      ".followup-unique.tmp", "followup-1.txt.tmp", "followup-1.txt\n", "followup-01.txt", "followup-0.txt",
      "followup--1.txt", "followup-1.0.txt", "followup-1e0.txt", "followup-9007199254740993.txt", "notes.txt",
    ])).toBe(1);
  });

  test(`hard-link publication is complete and no-replace (${process.release.name}/${process.platform})`, () => {
    // Isolated local filesystem probe only: never imports index.ts or starts a runner.
    const dir = mkdtempSync(join(import.meta.dir, ".contracts-followup-"));
    try {
      const first = join(dir, ".followup-first.tmp");
      const second = join(dir, ".followup-second.tmp");
      const target = join(dir, "followup-1.txt");
      const firstText = "first complete prompt\n".repeat(4096);
      writeFileSync(first, firstText, { flag: "wx" });
      writeFileSync(second, "second complete prompt", { flag: "wx" });
      expect(existsSync(target)).toBe(false);
      expect(nextFollowupNumber(readdirSync(dir))).toBe(1);
      linkSync(first, target);
      expect(statSync(first).ino).toBe(statSync(target).ino);
      expect(readFileSync(target, "utf8")).toBe(firstText);
      let collision: NodeJS.ErrnoException | undefined;
      try { linkSync(second, target); } catch (error) { collision = error as NodeJS.ErrnoException; }
      expect(collision?.code).toBe("EEXIST");
      expect(readFileSync(target, "utf8")).toBe(firstText);
      // Losing publisher retries the numbering policy, retaining its complete staged data.
      const retry = nextFollowupNumber(readdirSync(dir));
      expect(retry).toBe(2);
      linkSync(second, join(dir, `followup-${retry}.txt`));
      unlinkSync(first);
      unlinkSync(second);
      expect(readFileSync(target, "utf8")).toBe(firstText);
      expect(readFileSync(join(dir, "followup-2.txt"), "utf8")).toBe("second complete prompt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dedupeModels (S5)", () => {
  test("collapses regions, prefers global, collects variants", () => {
    const out = dedupeModels([
      { id: "us.anthropic.claude-opus-5-5", providerID: "amazon-bedrock", name: "Opus (US)" },
      { id: "global.anthropic.claude-opus-5-5", providerID: "amazon-bedrock", name: "Opus (Global)" },
      { id: "gpt-5.5", providerID: "openai", name: "GPT-5.5" },
      { id: "gpt-5.5", providerID: "openai", name: "GPT-5.5 Fast" },
    ]);
    expect(out).toHaveLength(2);
    const opus = out.find((m) => m.providerID === "amazon-bedrock")!;
    expect(opus.id).toBe("global.anthropic.claude-opus-5-5");
    expect(opus.aliases).toHaveLength(2);
    const gpt = out.find((m) => m.providerID === "openai")!;
    expect(gpt.variants).toEqual(["GPT-5.5", "GPT-5.5 Fast"]);
  });
});

describe("expandWorkdir (K3)", () => {
  test("expands all tokens", () => {
    expect(expandWorkdir("/tmp/{panel_id}/{taskid}-{name}", { taskid: "t1", panel_id: "p1", name: "a" }))
      .toBe("/tmp/p1/t1-a");
  });
});

describe("panelCleanupReason", () => {
  const now = Date.parse("2026-10-24T00:00:00Z");
  const old = "2026-10-01T00:00:00Z";
  test("live, resumable, recent blocked; old terminal passes", () => {
    expect(panelCleanupReason([{ live: true, terminal: false, updated_at: old }], 7, now)).toBe("live member");
    expect(panelCleanupReason([{ live: false, terminal: true, updated_at: "2026-10-23T00:00:00Z" }], 7, now)).toBe("too recent");
    expect(panelCleanupReason([{ live: false, terminal: true, updated_at: old }], 7, now)).toBeUndefined();
    expect(panelCleanupReason([], 7, now)).toBe("no members");
    expect(panelCleanupReason([{ live: false, terminal: false, updated_at: old }], 7, now)).toBe("non-terminal member");
  });
  test("uses meta spawn time when status is missing or invalid", () => {
    const recent = "2026-10-23T00:00:00Z";
    expect(panelCleanupReason([{ live: false, terminal: true, spawned_at: recent }], 7, now)).toBe("too recent");
    expect(panelCleanupReason([{ live: false, terminal: true, updated_at: "invalid", spawned_at: recent }], 7, now)).toBe("too recent");
    expect(panelCleanupReason([{ live: false, terminal: true, spawned_at: old }], 7, now)).toBeUndefined();
    expect(panelCleanupReason([{ live: false, terminal: true, updated_at: recent, spawned_at: old }], 7, now)).toBe("too recent");
  });
  test("unknown age on ANY member blocks cleanup, even with a zero cutoff", () => {
    for (const days of [0, 7]) {
      expect(panelCleanupReason([{ live: false, terminal: true }], days, now)).toBe("missing activity timestamp");
      expect(panelCleanupReason([
        { live: false, terminal: true, updated_at: old },
        { live: false, terminal: true, updated_at: "invalid", spawned_at: "" },
      ], days, now)).toBe("missing activity timestamp");
    }
  });
  test("uses the youngest member and keeps the cutoff deterministic", () => {
    expect(panelCleanupReason([
      { live: false, terminal: true, updated_at: old },
      { live: false, terminal: true, spawned_at: "2026-10-23T00:00:00Z" },
    ], 7, now)).toBe("too recent");
    expect(panelCleanupReason([{ live: false, terminal: true, spawned_at: "2026-10-17T00:00:00Z" }], 7, now)).toBeUndefined();
    expect(panelCleanupReason([{ live: false, terminal: true, spawned_at: "2026-10-25T00:00:00Z" }], 0, now)).toBe("too recent");
  });
});

describe("cleanupActivityMs", () => {
  test("prefers activity, falls back to spawn time, and preserves epoch zero", () => {
    expect(cleanupActivityMs({ updated_at: "2026-10-23T00:00:00Z", spawned_at: "2026-10-01T00:00:00Z" })).toBe(Date.parse("2026-10-23T00:00:00Z"));
    expect(cleanupActivityMs({ spawned_at: "2026-10-23T00:00:00Z" })).toBe(Date.parse("2026-10-23T00:00:00Z"));
    expect(cleanupActivityMs({ updated_at: "invalid", spawned_at: "1970-01-01T00:00:00Z" })).toBe(0);
    expect(cleanupActivityMs({ updated_at: "1970-01-01T00:00:00Z", spawned_at: "2026-10-23T00:00:00Z" })).toBe(0);
    expect(cleanupActivityMs({})).toBeUndefined();
    expect(cleanupActivityMs({ updated_at: "", spawned_at: "invalid" })).toBeUndefined();
  });
});

describe("cancellation outcomes", () => {
  test("forced stop never claims runner cancellation from a stale running snapshot", () => {
    expect(cancellationOutcome(true, "running")).toEqual({
      cancelled: false, process_stopped: true, cancellation_acknowledged: false, status: "running",
    });
    expect(computeTerminal("running", false)).toBe(true);
    expect(computeResumable("running", false)).toBe(false);
  });
  test("requires BOTH acknowledgement and proven process stop for cancelled", () => {
    expect(cancellationOutcome(true, "cancelled")).toEqual({
      cancelled: true, process_stopped: true, cancellation_acknowledged: true, status: "cancelled",
    });
    expect(cancellationOutcome(false, "cancelled")).toEqual({
      cancelled: false, process_stopped: false, cancellation_acknowledged: true, status: "cancelled",
    });
    expect(cancellationOutcome(false, "running").cancelled).toBe(false);
    expect(cancellationOutcome(true).cancelled).toBe(false);
    expect(cancellationOutcome(true, "exited").cancelled).toBe(false);
    expect(computeResumable("error", true)).toBe(true);
  });
});

describe("terminal/resumable (S2)", () => {
  test("live error is resumable, dead is terminal", () => {
    expect(computeTerminal("error", true)).toBe(false);
    expect(computeResumable("error", true)).toBe(true);
    expect(computeTerminal("error", false)).toBe(true);
    expect(computeTerminal("cancelled", true)).toBe(true);
    expect(computeResumable("ready", true)).toBe(true);
  });
});

describe("permission presets", () => {
  test("baseline deny and question deny always sit last so member rules cannot override them", () => {
    for (const preset of PERMISSION_PRESET_NAMES) {
      const rules = resolvePermissions(preset);
      expect(rules.at(-1)).toEqual(QUESTION_DENY);
      expect(rules.slice(-BASELINE_DENY.length - 1, -1)).toEqual([...BASELINE_DENY]);
      expect(BASELINE_DENY.every((r) => r.effect === "deny")).toBe(true);
    }
    const widened = resolvePermissions("full", [{ action: "question", resource: "*", effect: "allow" }]);
    expect(evaluate("question", "*", widened).effect).toBe("deny");
  });

  test("member rules cannot re-allow secrets even under 'full'", () => {
    const rules = resolvePermissions("full", [{ action: "read", resource: ".env", effect: "allow" }]);
    expect(evaluate("read", ".env", rules).effect).toBe("deny");
    expect(evaluate("edit", "pkg/.env.production", rules).effect).toBe("deny");
  });

  test("presets never emit ask (headless runners cannot answer)", () => {
    for (const preset of Object.values(PERMISSION_PRESETS)) {
      expect(preset.some((r) => r.effect === "ask")).toBe(false);
      expect(evaluate("unknown-action", "anything", preset).effect).toMatch(/allow|deny/);
    }
  });

  test("default preset is editor; presets scope as advertised", () => {
    const d = resolvePermissions();
    expect(d.slice(0, -BASELINE_DENY.length - 1)).toEqual([...PERMISSION_PRESETS.editor!]);
    const ro = resolvePermissions("readonly");
    expect(evaluate("read", "src/x.ts", ro).effect).toBe("allow");
    expect(evaluate("edit", "src/x.ts", ro).effect).toBe("deny");
    expect(evaluate("shell", "ls", ro).effect).toBe("deny");
    expect(evaluate("webfetch", "https://x", ro).effect).toBe("deny");
    const ed = resolvePermissions("editor");
    expect(evaluate("edit", "src/x.ts", ed).effect).toBe("allow");
    expect(evaluate("shell", "bun test", ed).effect).toBe("allow");
    expect(evaluate("external_directory", "/tmp/x", ed).effect).toBe("deny");
    expect(evaluate("subagent", "*", ed).effect).toBe("deny");
    expect(evaluate("question", "*", ed).effect).toBe("deny");
    const full = resolvePermissions("full");
    expect(evaluate("subagent", "*", full).effect).toBe("allow");
    expect(evaluate("question", "*", full).effect).toBe("deny");
    for (const rules of [ro, ed]) {
      for (const action of ["todowrite", "skill", "example_tool", "execute"]) {
        expect(evaluate(action, "*", rules).effect).toBe("deny");
      }
    }
  });

  test("custom rules extend the preset but sit before baseline", () => {
    const rules = resolvePermissions("readonly", [{ action: "edit", resource: "*.md", effect: "allow" }]);
    const idx = rules.findIndex((r) => r.resource === "*.md");
    expect(idx).toBeGreaterThan(PERMISSION_PRESETS.readonly!.length - 1);
    expect(idx).toBeLessThan(rules.length - BASELINE_DENY.length - 1);
    expect(evaluate("edit", "docs/nested/guide.md", rules).effect).toBe("allow");
    expect(evaluate("edit", "docs/x.ts", rules).effect).toBe("deny");
  });

  test("secret read/edit coverage includes root, nested and absolute resources", () => {
    const secrets = [
      ".env", ".envrc", ".env-prod", ".env_local", "prod.env", "config/app.env", "pkg/.envrc",
      "credentials-prod.json", "credentials_backup", "pkg/credentials-prod.json",
      "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "pkg/id_ecdsa.pub", "pkg/id_dsa.pub",
      "x.pem", "x.key", "x.p12", "x.pfx", "x.jks", "x.keystore",
      "nested/x.pem", "nested/x.key", "nested/x.p12", "nested/x.pfx", "nested/x.jks", "nested/x.keystore",
      ".netrc", ".npmrc", ".pypirc", ".git-credentials", "pkg/.netrc", "pkg/.npmrc", "pkg/.pypirc", "pkg/.git-credentials",
      ".ssh/config", "pkg/.ssh/config", ".aws/config", "pkg/.aws/config", ".gnupg/key", "pkg/.gnupg/key",
      ".docker/config.json", "pkg/.docker/config.json", ".kube/config", "pkg/.kube/config",
      "prod.tfvars", "config/prod.tfvars", "/Users/x/.aws/credentials", "/Users/x/.envrc", "/Users/x/key.pfx",
      // Intentional over-catches: safety takes priority over example/public/parser files.
      ".env.example", "src/id_rsa_parser.ts",
    ];
    for (const preset of PERMISSION_PRESET_NAMES) {
      const rules = resolvePermissions(preset);
      for (const resource of secrets) {
        for (const action of ["read", "edit"]) {
          expect(evaluate(action, resource, rules).effect).toBe("deny");
        }
      }
    }
  });

  test("resolved ruleset at session level wins over config rules and child agent rules", () => {
    // Engine stack: agent rules (child agent + config pushes), then session rules.
    const childAgent = [
      { action: "*", resource: "*", effect: "deny" },
      { action: "external_directory", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "ask" },
    ] as const;
    const config = [
      { action: "shell", resource: "*", effect: "ask" },
      { action: "edit", resource: "*", effect: "ask" },
      { action: "read", resource: ".env", effect: "allow" },
      { action: "subagent", resource: "*", effect: "allow" },
      { action: "question", resource: "*", effect: "allow" },
    ] as const;
    const session = resolvePermissions("editor");
    // Without the session segment the hostile config reaches ask (the headless hang).
    expect(evaluate("shell", "ls", childAgent, config).effect).toBe("ask");
    // With it, the operator's preset decides every check; ask is unreachable by rules.
    expect(evaluate("shell", "ls", childAgent, config, session).effect).toBe("allow");
    expect(evaluate("edit", "src/x.ts", childAgent, config, session).effect).toBe("allow");
    expect(evaluate("read", ".env", childAgent, config, session).effect).toBe("deny");
    expect(evaluate("read", "src/x.ts", childAgent, config, session).effect).toBe("allow");
    expect(evaluate("subagent", "explore", childAgent, config, session).effect).toBe("deny");
    expect(evaluate("question", "*", childAgent, config, session).effect).toBe("deny");
    // Member policy also overrides child-agent shaping: explore's external allow loses.
    expect(evaluate("external_directory", "/etc/*", childAgent, config, session).effect).toBe("deny");
    expect(evaluate("unknown-action", "anything", childAgent, config, session).effect).toBe("deny");
  });

  test("baseline is not a secrets boundary: search, shell and case variants remain allowed", () => {
    expect(evaluate("grep", "SECRET", resolvePermissions("readonly")).effect).toBe("allow");
    expect(evaluate("shell", "cat .env", resolvePermissions("editor")).effect).toBe("allow");
    expect(evaluate("read", "innocent-symlink.txt", resolvePermissions("editor")).effect).toBe("allow");
    if (process.platform !== "win32") {
      for (const resource of [".ENV", "x.KEY"]) {
        expect(evaluate("read", resource, resolvePermissions("editor")).effect).toBe("allow");
      }
    }
  });

  test("real wildcard semantics apply to custom action/resource rules", () => {
    const rules = resolvePermissions("readonly", [
      { action: "ed?t", resource: "src\\*.ts", effect: "allow" },
      { action: "shell", resource: "bun test *", effect: "allow" },
    ]);
    expect(evaluate("edit", "src\\nested\\x.ts", rules).effect).toBe("allow");
    expect(evaluate("shell", "bun test", rules).effect).toBe("allow");
    expect(evaluate("shell", "bun test --help", rules).effect).toBe("allow");
    expect(evaluate("shell", "bun test-mcp.ts", rules).effect).toBe("deny");
  });

  test("unknown and inherited-object preset names throw a useful error", () => {
    expect(Object.keys(PERMISSION_PRESETS)).toEqual(PERMISSION_PRESET_NAMES);
    for (const name of ["nope", "__proto__", "toString", "constructor", "hasOwnProperty"]) {
      expect(() => resolvePermissions(name)).toThrow("unknown permission_preset");
    }
  });
});
