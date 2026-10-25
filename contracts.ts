/** Pure contract helpers shared by index.ts and tests. No I/O. */

/** Identifiers are single ASCII path components, never paths or hidden names. */
export function isValidMemberName(value: string): boolean {
  return value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

export function isValidTaskId(value: string): boolean {
  return value.length <= 255 && /^ocv2-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

export function isValidPanelId(value: string): boolean {
  // Leave room for the manifest's .json suffix on NAME_MAX=255 filesystems.
  return value.length <= 250 && /^panel-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

/** Runner waits for 1, 2, ... and retains consumed files. Fill gaps, never count files. */
export function nextFollowupNumber(filenames: readonly string[]): number {
  const used = new Set<number>();
  for (const filename of filenames) {
    const match = /^followup-([1-9][0-9]*)\.txt$/.exec(filename);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isSafeInteger(n)) used.add(n);
  }
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/** A stopped process is not evidence that the runner acknowledged cancellation. */
export function cancellationOutcome(processStopped: boolean, status?: string) {
  const cancellation_acknowledged = status === "cancelled";
  return {
    cancelled: processStopped && cancellation_acknowledged,
    process_stopped: processStopped,
    cancellation_acknowledged,
    status,
  };
}

// ---------------------------------------------------------------------------
// Permissions. The engine evaluates rules with findLast: the LAST matching rule
// wins, so BASELINE_DENY and QUESTION_DENY must always be appended after member
// rules. resolvePermissions() output is the member's single canonical ruleset.
// The runner enforces it at session level (merged after all agent/config
// rules, inherited by child sessions) and mirrors it on the agent for
// agent-scoped consumers (tool/subagent listing). Discovered config rules
// append to agents only, so they cannot change a member's effective policy.
// `ask` is unusable on headless runners (no approver, no timeout): presets
// never emit it, and the runner converts any residual ask to deny. File
// resources within the Location or project git worktree are workdir-relative;
// external files use absolute resources. Read/edit globs are case-sensitive on
// macOS/Linux and only guard accidental access, not secrets.
// ---------------------------------------------------------------------------

export type PermissionRule = { action: string; resource: string; effect: "allow" | "deny" | "ask" };

const SECRET_GLOBS = [
  ".env*", "**/.env*", "*.env",
  "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore",
  "id_rsa*", "**/id_rsa*", "id_ed25519*", "**/id_ed25519*",
  "id_ecdsa*", "**/id_ecdsa*", "id_dsa*", "**/id_dsa*",
  "credentials*", "**/credentials*",
  ".netrc", "**/.netrc", ".npmrc", "**/.npmrc", ".pypirc", "**/.pypirc",
  ".git-credentials", "**/.git-credentials",
  ".ssh/**", "**/.ssh/**", ".aws/**", "**/.aws/**", ".gnupg/**", "**/.gnupg/**",
  ".docker/**", "**/.docker/**", ".kube/**", "**/.kube/**", "*.tfvars",
];

/** Appended after member rules in the resolved ruleset; enforced at session level. */
export const BASELINE_DENY: readonly PermissionRule[] = [
  ...SECRET_GLOBS.map((resource): PermissionRule => ({ action: "read", resource, effect: "deny" })),
  ...SECRET_GLOBS.map((resource): PermissionRule => ({ action: "edit", resource, effect: "deny" })),
];

const rule = (action: string, effect: "allow" | "deny", resource = "*"): PermissionRule =>
  ({ action, resource, effect });
const allowAll = (...actions: string[]) => actions.map((a) => rule(a, "allow"));

/** Final rule of every resolved ruleset: interactive `question` can never be re-allowed. */
export const QUESTION_DENY: PermissionRule = rule("question", "deny");

/**
 * Named standard sets. evaluate() picks the LAST matching rule. readonly/editor
 * open with a catch-all deny and widen with specific allows; full opens with an
 * allow. All presets cover unlisted actions without ask (unanswerable headless).
 */
export const PERMISSION_PRESETS = {
  /** Inspect only: filesystem read/glob/grep. No writes, no shell, no network, no asking. */
  readonly: [rule("*", "deny"), ...allowAll("read", "glob", "grep")],
  /**
   * Files, shell, webfetch/websearch. Reads/edits outside the Location/project git worktree,
   * subagents, and interactive `question` stay denied (denied errors cleanly;
   * `question` allowed would hang forever with no approver).
   */
  editor: [
    rule("*", "deny"),
    ...allowAll("read", "glob", "grep", "edit", "shell", "webfetch", "websearch"),
    rule("external_directory", "deny"),
    rule("subagent", "deny"),
  ],
  /** Broad access except BASELINE_DENY and headless interactive questions. */
  full: [rule("*", "allow"), rule("question", "deny")],
} as const satisfies Record<string, readonly PermissionRule[]>;

export const PERMISSION_PRESET_NAMES = Object.keys(PERMISSION_PRESETS) as (keyof typeof PERMISSION_PRESETS)[];

/**
 * Resolve a member's canonical ruleset: preset (default "editor"), then custom
 * rules (may widen a preset), then BASELINE_DENY and QUESTION_DENY (win over
 * member rules). The runner passes this set to sessions.create, where it
 * merges after every agent/config rule and is inherited by child sessions:
 * the operator's spawn-time policy outranks discovered config and any child
 * agent's own ruleset. The leading catch-all in every preset resolves each
 * (action, resource) inside this set, so no config rule can be the last
 * match. Always returns an explicit set — an agent left without permissions
 * is deny-all in the engine, and unset rules depend on engine defaults.
 */
export function resolvePermissions(preset?: string, custom?: readonly PermissionRule[]): PermissionRule[] {
  const name = preset ?? "editor";
  if (!Object.hasOwn(PERMISSION_PRESETS, name)) throw new Error(`unknown permission_preset: ${JSON.stringify(name)} (expected ${PERMISSION_PRESET_NAMES.join(", ")})`);
  const rules = PERMISSION_PRESETS[name as keyof typeof PERMISSION_PRESETS];
  return [...rules, ...(custom ?? []), ...BASELINE_DENY, QUESTION_DENY];
}

export const REGION_PREFIXES = [
  "global.", "us-gov.", "us.", "eu.", "au.", "jp.", "in.", "apac.", "ca.",
];

export function stripRegion(id: string): string {
  for (const p of REGION_PREFIXES) if (id.startsWith(p)) return id.slice(p.length);
  return id;
}

/** Canonical family key: provider + id without region prefix. */
export function canonicalModelKey(m: { id: string; providerID: string }): string {
  return `${m.providerID}\0${stripRegion(m.id)}`;
}

function idRank(id: string): number {
  if (id.startsWith("global.")) return 0;
  if (!REGION_PREFIXES.some((p) => id.startsWith(p))) return 1;
  if (id.startsWith("us.")) return 2;
  return 3;
}

export type RawModel = { id: string; providerID: string; name?: string; family?: string };
export type DedupedModel = RawModel & { variants: string[]; aliases: string[] };

/** S5: one row per family. Distinct display names become variants, ids become aliases. */
export function dedupeModels(models: RawModel[]): DedupedModel[] {
  const groups = new Map<string, RawModel[]>();
  for (const m of models) {
    const k = canonicalModelKey(m);
    const g = groups.get(k) ?? [];
    g.push(m);
    groups.set(k, g);
  }
  const out: DedupedModel[] = [];
  for (const g of groups.values()) {
    const sorted = [...g].sort((a, b) => idRank(a.id) - idRank(b.id));
    const head = sorted[0]!;
    out.push({
      ...head,
      variants: [...new Set(g.map((m) => m.name ?? m.id))],
      aliases: [...new Set(g.map((m) => m.id))],
    });
  }
  return out.sort((a, b) => a.providerID.localeCompare(b.providerID) || a.id.localeCompare(b.id));
}

/** K3: expand workdir templates server-side after ids are minted. */
export function expandWorkdir(
  template: string,
  vars: { taskid: string; panel_id: string; name: string },
): string {
  return template
    .replaceAll("{taskid}", vars.taskid)
    .replaceAll("{task_id}", vars.taskid)
    .replaceAll("{panel_id}", vars.panel_id)
    .replaceAll("{name}", vars.name);
}

/** S2: terminal means no follow-up is possible. Live error/idle/ready stays resumable. */
export function computeTerminal(status: string | undefined, live: boolean): boolean {
  if (!live) return true;
  return status === "cancelled" || status === "exited";
}

export function computeResumable(status: string | undefined, live: boolean): boolean {
  return live && (status === "idle" || status === "error" || status === "ready");
}

export type CleanupTask = {
  status?: string;
  live: boolean;
  terminal: boolean;
  updated_at?: string;
  spawned_at?: string;
};

/** Prefer runner activity, then supervisor spawn time; unknown age stays unknown. */
export function cleanupActivityMs(task: Pick<CleanupTask, "updated_at" | "spawned_at">): number | undefined {
  for (const timestamp of [task.updated_at, task.spawned_at]) {
    if (typeof timestamp !== "string" || !timestamp.trim()) continue;
    const ms = Date.parse(timestamp);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

/** Cleanup eligibility: every member dead + terminal, and last activity older than cutoff. */
export function panelCleanupReason(
  tasks: CleanupTask[],
  olderThanDays: number,
  nowMs: number,
): string | undefined {
  if (!tasks.length) return "no members";
  if (tasks.some((t) => t.live)) return "live member";
  if (tasks.some((t) => !t.terminal)) return "non-terminal member";
  const activity = tasks.map(cleanupActivityMs);
  if (activity.some((ms) => ms === undefined)) return "missing activity timestamp";
  const last = Math.max(...activity as number[]);
  if (nowMs - last < olderThanDays * 86_400_000) return "too recent";
  return undefined;
}
