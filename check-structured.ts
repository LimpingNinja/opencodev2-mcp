// check-structured.ts — start the stdio supervisor, call panel_list, and show
// human-readable content next to the machine structuredContent. Read-only.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(HERE, "index.ts")],
  env: { ...process.env } as Record<string, string>,
});
const client = new Client({ name: "check", version: "0" });
await client.connect(transport);
const res = await client.callTool({ name: "panel_list", arguments: {} }) as any;
console.log("===== USER SEES (content) =====");
console.log(res.content[0].text);
console.log("===== AGENT GETS (structuredContent) =====");
console.log("tasks:", res.structuredContent?.tasks?.length, "| first status:", res.structuredContent?.tasks?.[0]?.status);
await client.close();
process.exit(0);
