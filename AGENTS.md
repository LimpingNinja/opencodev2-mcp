# Agent notes

## Runtime

Bun only — do not use Node.js, npm, yarn, or pnpm.

- `bun <file>` to run scripts (never `node` / `ts-node`)
- `bun test` for tests (never jest / vitest)
- `bun install` for dependencies
- `bunx <pkg> <cmd>` for one-off tools (never `npx`)

Bun loads `.env` automatically — do not add dotenv.

## Layout

- `index.ts` — MCP supervisor (stdio transport, 12 tools, spawns detached runners)
- `runner.ts` — per-member worker process (embedded `@opencode/sdk` host)
- `contracts.ts` — pure shared helpers, no I/O; keep testable logic here
- `models-list.ts` — one-shot model enumerator child
- `contracts.test.ts`, `runner.test.ts` — unit tests for pure helpers plus isolated filesystem behavior
- `test-mcp.ts` — end-to-end harness over real MCP stdio
- `check-structured.ts` — read-only smoke check of `content` vs `structuredContent`
- `docs/` — deeper technical reference
- `example_skills/` — host-specific consumption examples (devin, muse)

## Conventions

- Keep `contracts.ts` free of I/O so its helpers stay unit-testable.
- All persistent state lives under `~/.opencodev2-mcp/`; task writes are atomic
  (temp file + rename). Follow the same pattern for new file state.
- Member names, task IDs, and panel IDs are validated path components — never
  join raw user input into filesystem paths.
- Changes to status fields or tool outputs: update the header docs in
  `runner.ts` and the tool reference in `README.md`.

## Verification

```sh
bun test            # unit tests (no engine needed)
bunx tsc --noEmit   # typecheck
bun test-mcp.ts     # end-to-end over real stdio (spawns a real member)
```

Run `bun test` and `bunx tsc --noEmit` before considering work complete.
