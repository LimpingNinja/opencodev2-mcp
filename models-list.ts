// models-list.ts — boot embedded host, dump model list as JSON, exit.
import { OpenCode } from "@opencode/sdk";

const oc = await OpenCode.create({
  database: {
    path: `${process.env.HOME}/.local/share/opencode/opencode.db`,
  },
});
try {
  const raw = (await oc.model.list({})) as any;
  const arr = Array.isArray(raw) ? raw : (raw?.data ?? []);
  const out = arr.map((m: any) => ({
    id: m.modelID ?? m.id,
    providerID: m.providerID,
    name: m.name,
    family: m.family,
  }));
  process.stdout.write(JSON.stringify(out));
} finally {
  await oc.close();
}
