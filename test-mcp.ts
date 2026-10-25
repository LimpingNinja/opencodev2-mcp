// test-mcp.ts — drives index.ts over real MCP stdio like a host would.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const transport = new StdioClientTransport({
  command: "bun",
  args: [join(HERE, "index.ts")],
  env: { ...process.env } as Record<string, string>,
});
const client = new Client({ name: "test-host", version: "0.0.1" });
await client.connect(transport);
console.log("== connected, tools:");
const tools = await client.listTools();
console.log(tools.tools.map((t) => t.name).join(", "));

const call = async (name: string, args: any) => {
  const r = (await client.callTool({ name, arguments: args })) as any;
  if (r.structuredContent) return r.structuredContent;
  const text = r.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

console.log("\n== spawn_panel (2 members)");
const spawned = await call("spawn_panel", {
  workdir: "/tmp",
  linger_secs: 90,
  stall_secs: 120,
  packet: "Reply now.",
  members: [
    {
      name: "alpha",
      system: "You are member ALPHA. Reply with exactly: ALPHA_OK",
      model: { id: "global.anthropic.claude-haiku-5-5", providerID: "amazon-bedrock" },
    },
    {
      name: "beta",
      system: "You are member BETA. Reply with exactly: BETA_OK",
      model: { id: "us.anthropic.claude-haiku-5-5", providerID: "amazon-bedrock" },
    },
  ],
});
console.log(JSON.stringify(spawned, null, 1));
const ids = spawned.spawned.map((s: any) => s.task_id);
console.log(`panel_id: ${spawned.panel_id}`);

console.log("\n== polling until idle/error (via panel_overview)");
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const st = await call("panel_overview", { panel_id: spawned.panel_id });
  const mine = st.tasks;
  console.log("  " + mine.map((t: any) => `${t.name}:${t.status}${t.stale ? "(stale)" : ""}${t.resumable ? "(resumable)" : ""}`).join("  "));
  if (mine.every((t: any) => ["idle", "error", "cancelled", "exited"].includes(t.status) && (t.turn ?? 0) >= 1)) break;
  await new Promise((r) => setTimeout(r, 3000));
}

console.log("\n== results");
for (const id of ids) {
  const r = await call("panel_result", { task_id: id });
  console.log(`${r.task_id} [${r.status}]: ${(r.result ?? "").trim().slice(0, 120)}`);
}

console.log("\n== panel_send follow-up to first member");
const fu = await call("panel_send", { task_id: ids[0], text: "Reply with exactly: FOLLOWUP_OK" });
console.log(JSON.stringify(fu));
await new Promise((r) => setTimeout(r, 20000));
const r2 = await call("panel_result", { task_id: ids[0] });
console.log(`follow-up result [${r2.status}]: ${(r2.result ?? "").trim().slice(-200)}`);

console.log("\n== panel_cancel on second member");
const cx = await call("panel_cancel", { task_id: ids[1] });
console.log(JSON.stringify(cx));

console.log("\n== panel_cleanup dry-run (live member must skip)");
const clean = await call("panel_cleanup", { panel_id: spawned.panel_id, older_than_days: 0 });
console.log(JSON.stringify(clean));

console.log("\n== panel_models (deduped, first 5)");
const models = await call("panel_models", {});
console.log(`total deduped: ${models.models?.length}`);
console.log(models.models?.slice(0, 5));

await client.close();
console.log("\nDONE");
process.exit(0);
