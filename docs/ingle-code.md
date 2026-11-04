# ingle-code — code intelligence for small models

`Extensions/ingle-code/` is a read-only analysis engine: **outline, definition, references, callers, callees, impact,
diagnostics** and **read_exhaustively**. It exists because small local models don't fail for lack of brains so much as
by **missing things** — a caller they didn't look at, a file they skipped, half a log they never read. Language
servers already know every definition, reference and type error exactly; ingle-code asks them, and gives the model
complete answers that fit a 16–32K context window.

Status: the engine and MCP server are built (task 33 in [improvement-plan.md](improvement-plan.md)). Wiring them into
both apps as built-in tools is task 33b; coverage checks that use them are task 34.

## One engine, three ways in

```
                       ┌──────────────────────────────────────────┐
  VS Code extension ──▶│ src/engine/  CodeEngine (typed library)   │──▶ sourcekit-lsp, tsc --lsp /
  (imports it, 33b)    │   outline · definition · references       │    typescript-language-server,
                       │   callers · callees · impact              │    pyright, gopls, rust-analyzer
  Mac app helper ─┐    │   diagnostics · read_exhaustively         │    (LSP over stdio, kept warm)
  (33b)           │    ├──────────────────────────────────────────┤
                  ├───▶│ src/mcp/  MCP server (stdio)               │──▶ git grep + patterns (fallback)
  Claude Code,    │    │ bin/ingle-code                            │
  Desktop, Cursor ┘    └──────────────────────────────────────────┘──▶ local Ollama /api/generate
                                                                         (read_exhaustively only)
```

- **VS Code** will import `CodeEngine` and `callTool` directly and register the tools as ordinary `ToolDef`s.
- **The Mac app** will start `bin/ingle-code` as a helper per project and show its tools as built-in tools (normal
  names, no `mcp_call` step, no approval inside the project — they are read-only).
- **Anything else** can use it as a standard MCP server. Set-up for Claude Code, Claude Desktop, Cursor and
  `~/.ingle/mcp.json` is in [../Extensions/ingle-code/README.md](../Extensions/ingle-code/README.md).

Why not only MCP: small models struggle with the two-step `mcp_tools` → `mcp_call` route and with an approval on every
call, and the coverage checks (task 34) need to understand the results. Why a separate engine at all: one
implementation, crash isolation, and use outside Ingle.

## Exact and approximate

Every answer says where it came from:

- **exact** — a language server answered (`textDocument/references`, `callHierarchy/*`, `workspace/symbol`,
  `documentSymbol`, pull or pushed diagnostics);
- **approximate** — no server is installed for that language (or it failed, timed out, or lacks the feature), so the
  text scan answered: `git grep -w` for the name, per-language definition patterns, brace/indent matching for ranges,
  and call sites mapped to their enclosing function. The reason is always given.

When a server answers `references`, ingle-code still greps for the name and lists matches the server didn't report as
**text only**: comments, strings, another symbol with the same name, or code not indexed yet. Nothing found by text is
dropped. Scan matches inside comments and strings are flagged; interpolated code (`"\(x)"`, `` `${x}` ``) counts as code.

A name defined in several languages (like `approvalScope`, in both `Tools.swift` and `chatEngine.ts`) is handled per
language: each gets its own server, or the scan.

`impact` adds the tests that cover the affected files, with the reason: same file name (`name`), imports it by resolved
path, Swift module, Python module or Go package (`import`), or uses the symbol (`uses`). Files with no test found are
listed, so the model can say so rather than assume.

## Small context windows first

- Lists are capped at 40 items with a plain footer: `showing 1–40 of 212 references; for more, call again with page: 2`.
- Lines are trimmed to about 110 characters; results group by file.
- `read_exhaustively` reads 12 chunks (≈6,000 characters each) per call and says how many are left, so a 50,000-line
  log becomes a few pages of one-line notes, and the model reads the notes, not the log.

## Servers, processes and privacy

- Servers are found on `PATH` and in the workspace's `node_modules/.bin` (and its parents). `code_status` lists what
  was found. TypeScript 7+ is used through its own `tsc --lsp --stdio` (or `tsgo`); older TypeScript needs
  `typescript-language-server`.
- One server per language per workspace, started on first use, stopped after 10 idle minutes (`--idle-minutes`) and
  when ingle-code exits (`shutdown`/`exit`, then SIGTERM, then SIGKILL). Servers get ingle-code's PID and exit if it dies.
- `sourcekit-lsp` indexes in the background on first use (seconds for a small package, about a minute for Ingle).
  It keeps that index in the package's `.build/index-build` folder — sourcekit-lsp fixes this location (a scratch path
  is ignored for background indexing), and it's the same folder VS Code's Swift extension uses. `.build/` is
  git-ignored in Swift projects, including Ingle. Delete it to reclaim the space; it is rebuilt when needed.
- ingle-code never edits source files and answers `workspace/applyEdit` with "read-only". The only thing a server
  writes is its own index (above).
- The only network use is `read_exhaustively` → Ollama on this Mac (`OLLAMA_HOST` or `localhost:11434`); non-loopback
  hosts are refused. No telemetry. This adds nothing to [../PRIVACY.md](../PRIVACY.md)'s list of network uses beyond the
  local engine Ingle already talks to.

## Files

| Path | What it does |
|---|---|
| `src/engine/engine.ts` | `CodeEngine`: target parsing, definition resolution, references, calls, impact + test finding, diagnostics |
| `src/engine/lsp.ts` | Hand-written LSP client (Content-Length JSON-RPC, document sync, progress tracking, diagnostics) |
| `src/engine/pool.ts` | Finds servers, starts one per language, idle shutdown, TypeScript server choice |
| `src/engine/languages.ts` | Extensions, server candidates, definition patterns, test-file naming |
| `src/engine/scan.ts` | The approximate path: comment/string masking, outlines with ranges, call scanning |
| `src/engine/files.ts` | File listing (`git ls-files`) and `git grep` (with a Node fallback) |
| `src/engine/exhaustive.ts` | Chunking, local-only Ollama host check, model choice, per-chunk notes |
| `src/engine/format.ts`, `tools.ts` | Text output, tool specs (JSON Schema) and `callTool` — shared by MCP and the apps |
| `src/mcp/server.ts`, `main.ts`, `bin/ingle-code` | MCP stdio server and its command line |
| `TOOLS.md` | The exact tool contract task 33b follows |
| `test/` | `node:test` suites with Swift and TypeScript fixture projects; LSP tests skip if a server is missing |

## Checking it

```zsh
cd Extensions/ingle-code && npm install && npm test        # tsc + node:test
node node_modules/typescript/bin/tsc -p . --noEmit
```
