# ingle-code tools

The contract for task 33b (VS Code and the Mac app) and for any MCP client. Tool names, arguments and output are
exactly as below. The source of truth in code is `src/engine/tools.ts` (`TOOL_SPECS`, `callTool`) and
`src/engine/types.ts` (result types); change them together with this file.

All tools are **read-only**. Paths are relative to the workspace root, use `/`, and must stay inside the workspace.
Lines and columns are **1-based** (columns count UTF-16 units, as LSP does).

## Common rules

- **Exact or approximate.** Every result says where it came from. *Exact* = a language server answered.
  *Approximate* = the text scan (`git grep` + per-language patterns) answered, because no server is installed, it
  failed to start, it timed out, or it doesn't support that request. The reason is always given.
- **Text only.** When a server answered, `references` also lists text matches of the name in that language that the
  server did *not* report, marked `text only` (`unconfirmed: true`). These are comments, strings, a different symbol
  with the same name, or code the server hasn't indexed yet. Nothing found by text is hidden.
- **Comment/string.** Scan matches inside a comment or string literal are marked `comment/string` (`inComment: true`).
  Code inside Swift `"\(…)"` and JavaScript `` `${…}` `` interpolation counts as code.
- **Paging.** Lists hold at most 40 items per call (`pageSize`). Text output says
  `showing 41–80 of 212 references; for more, call again with page: 3`. `page` past the end is clamped to the last page.
- **`symbol`** is a name (`approvalScope`), a qualified name (`MacTools.approvalScope`, `Cart::total`; the qualifier
  narrows to definitions inside that type when it can) or a position `file:line:col` (`src/a.ts:21:18`; with no
  column, the name declared on that line, else the first identifier). A trailing `(...)` is ignored.
- **`file`** (optional, on symbol tools) prefers the definition in that file when a name is defined more than once.
- **`format`** (optional, every tool): `"text"` (default, short, for the model) or `"json"` (the typed result below,
  pretty-printed). Library callers get the typed result directly.
- **Errors** come back as an MCP tool result with `isError: true` and one plain sentence (for example
  `src/x.ts doesn't exist in /path`, `Missing argument: symbol`). `callTool` never throws.

Languages: Swift (`.swift`), TypeScript/JavaScript (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`), Python (`.py .pyi`),
Go (`.go`), Rust (`.rs`). Servers looked for, on `PATH` and in the workspace's `node_modules/.bin` (and its parents):

| Language | Server |
|---|---|
| swift | `sourcekit-lsp` (Xcode or Command Line Tools) |
| typescript | `tsgo --lsp --stdio`; or `tsc --lsp --stdio` from TypeScript 7+; or `typescript-language-server --stdio` with TypeScript ≤6 (workspace's own TypeScript first) |
| python | `pyright-langserver`, `basedpyright-langserver`, `pylsp` |
| go | `gopls` |
| rust | `rust-analyzer` |

## `code_status`

Arguments: `format?`.

Which languages get exact answers and whether `read_exhaustively` can run. Type `StatusResult`:
`{ root, git, languages: [{ language, extensions, server?, serverPath?, running, files, exactness, note? }], ollama: { host, reachable, model?, error? } }`.

```
workspace: /Users/me/Ingle (git)
swift: 35 files, exact (sourcekit-lsp)
typescript: 65 files, approximate (no server)
install for exact results: typescript: no typescript-language-server or tsc --lsp (TypeScript 7+) on PATH
also installed (no files here): rust-analyzer
read_exhaustively: ready (http://localhost:11434, model qwen3:1.7b)
```

## `outline`

Arguments: `file` (required), `page?`, `format?`.

Symbols in one file with line ranges, nested by depth (locals inside functions left out). Type `OutlineResult`:
`{ file, source: { language, exactness, via, reason? }, items: [{ name, kind, startLine, endLine, depth, container? }], page, pageSize, pages, total, from, to }`.

```
outline of Sources/Shop/Cart.swift: 10 symbols, exact (sourcekit-lsp)
struct Item  1-4
  property name  2-2
class Cart  6-23
  method total()  19-22
function checkout(_:)  26-28
showing 1–10 of 10 symbols
```

## `definition`

Arguments: `symbol` (required), `file?`, `page?`, `format?`.

Type `DefinitionResult`: `{ target, sources: Source[], items: [{ name, kind, file, line, col, text, language, exactness, container? }], …page }`.

```
definition of Cart.total: 1 found
sources: swift exact (sourcekit-lsp)
Sources/Shop/Cart.swift:19:17 method in Cart [exact]  public func total() -> Double {
showing 1–1 of 1 definitions
```

## `references`

Arguments: `symbol` (required), `file?`, `page?`, `format?`.

**Every** use, grouped by file, with a total. For a name, each language is handled on its own: with a server, the
server's references from each definition (up to 6) plus `text only` matches; without one, every whole-word match in
that language's files. Files in no known language (docs) aren't listed. Type `ReferencesResult`:
`{ target, definitions: DefinitionItem[], sources: Source[], files, exactCount, approximateCount, items: [{ file, line, col, text, language, exactness, definition?, unconfirmed?, inComment? }], …page }`.

```
references to approvalScope: 11 in 5 files (6 exact, 5 approximate)
sources: swift exact (sourcekit-lsp); typescript exact (tsc --lsp)
defined at: Extensions/vscode/src/engine/chatEngine.ts:70, Sources/Ingle/Tools.swift:163
"text only" = a text match the language server did not report (comment, string, other symbol, or not indexed yet)
showing 1–11 of 11 references
Sources/Ingle/ChatStore.swift
  115:42 [text only, comment/string] /// scope key → label. See `MacTools.approvalScope`.
  311:54 [exact] let scope: MacTools.ApprovalScope = MacTools.approvalScope(call)
…
```

## `callers` / `callees`

Arguments: `symbol` (required), `file?`, `depth?` (1 or 2, default 1), `page?`, `format?`.

`callers`: functions that call the symbol (code outside any function shows as `(top level)`). `callees`: functions
**in this workspace** that it calls (library calls are left out). With `depth: 2`, level-2 items carry `via` (the
level-1 function they go through). Exact via LSP call hierarchy; approximate via the scan (call sites mapped to the
enclosing function). Type `CallsResult`:
`{ target, direction, depth, definitions, sources, items: [{ name, kind, file, line, level, via?, callLines: number[], exactness, language }], …page }`.
For callers `callLines` are lines in `file`; for callees they are lines inside the target.

```
callers of discount: 3 (depth 2)
sources: swift exact (sourcekit-lsp)
showing 1–3 of 3 callers
Cart.total() (method) Sources/Shop/Cart.swift:19 [exact] — calls at line 21
  checkout(_:) (function) Sources/Shop/Cart.swift:26 [exact] via Cart.total() — calls at line 27
```

## `impact`

Arguments: `symbol` (required), `file?`, `page?`, `format?`.

Everything a change could affect: the files that use the symbol (from `references`), its direct callers, and the
tests that cover those files. A test is listed with its reasons: `name` (same file stem, same language:
`cart.test.ts`↔`cart.ts`, `CartTests.swift`↔`Cart.swift`), `import` (it imports the file by a resolved relative path,
or imports its Swift module / Python module / Go package), `uses` (it uses the symbol itself). Affected files with no
test found are listed as `untested`. `page` applies to the files, callers and tests lists together. Type `ImpactResult`:
`{ target, definitions, sources, references: { total, exactCount, approximateCount, files: [{ file, count, exactCount }], mentionedOnly: string[] }, callers: CallItem[], callersTotal, tests: [{ file, reasons, covers }], untested: string[], page, pageSize, pages }`.
Files whose only matches are scan hits inside comments or strings are left out of `files` (and of the test search) and listed in `mentionedOnly`.

```
impact of changing discount
sources: typescript exact (tsc --lsp)
references: 7 (5 exact, 2 approximate); defined at src/pricing.ts:2
files that use it:
  src/cart.ts (3: 2 exact, 1 approx)
only mentioned in comments/strings: docs-helper.ts
callers: 2
  total src/cart.ts:19 [exact]
tests that cover these files (name = file name matches, import = imports it, uses = uses the symbol):
  test/cart.test.ts (name, import) → src/cart.ts
no test found for: src/other.ts
```

## `diagnostics`

Arguments: `paths?` (list of files or folders; a single string is accepted), `page?`, `format?`.

Compiler and type errors from the language server, without a build. With no `paths`: files changed since the last
commit (modified, added, untracked; needs git). Folders expand to their source files; at most 60 files per call
(the rest are listed under "not checked"). Files with no server are listed under "not checked" with the reason —
there is no approximate diagnostics. Errors first. Type `DiagnosticsResult`:
`{ checked: string[], skipped: [{ file, reason }], errors, warnings, sources, scope?, items: [{ file, line, col, severity: 'error'|'warning'|'info'|'hint', message, source?, code? }], …page }`.

```
diagnostics: 2 errors, 0 warnings in 1 checked files (files changed since the last commit)
sources: swift exact (sourcekit-lsp)
showing 1–2 of 2 diagnostics
Sources/Ingle/BrokenScratch.swift:3:25 error: Cannot convert value of type 'Int' to specified type 'String' (SourceKit)
```

## `read_exhaustively`

Arguments: `path` (required), `question` (required), `page?`, `format?`.

Walks a big file in chunks of about 6,000 characters (on line boundaries, each line numbered) and asks the **local**
Ollama for a JSON note per chunk (`{"relevant": bool, "note": "…"}`). One call reads one page of 12 chunks; the
output says how many are left and which page to ask for, so nothing is skipped silently. Engine: `/api/generate` at
`OLLAMA_HOST` (or `--ollama-host`), default `http://localhost:11434`; anything that isn't loopback is refused. Model:
`--model`, else `$INGLE_CODE_MODEL`, else the smallest installed chat model (embedding and `-base` models are skipped; a small instruct model such as `qwen3:1.7b` works best). If Ollama isn't reachable:
`Ollama isn't reachable at http://localhost:11434. Start Ingle (or run "ollama serve") and try again.`
Type `ReadExhaustivelyResult`:
`{ file, question, model, totalLines, chunks, fromChunk, toChunk, page, pages, notes: [{ chunk, startLine, endLine, relevant, note }] }`.

```
read app.log for: Why did it crash?
3000 lines in 7 chunks; this call read chunks 1–7 (model qwen3:1.7b)
relevant:
  lines 2190-2630: FATAL "disk full" at line 2501, right after the backup job started (2498).
other chunks (not relevant):
  lines 1-440: routine INFO request lines.
finished: every chunk has been read.
```

## In Ingle's apps (task 33b)

The apps offer every tool above except `code_status` as built-in tools, without `format` (the model gets text). Their
`symbol` is optional there, and so are `outline`'s `file` and `diagnostics`' `paths`: left out, they default to the
user's working set (selection, then the symbols the uncommitted changes touch; the open file; the open, changed and
mentioned files), and the output starts with a line in brackets saying what was used. See
[docs/ingle-code.md](../../docs/ingle-code.md#in-ingle-task-33b).

## Library use (task 33b)

```ts
import { CodeEngine, callTool, TOOL_SPECS } from 'ingle-code';
const engine = new CodeEngine({ root: workspaceRoot, log: console.debug });
const out = await callTool(engine, 'references', { symbol: 'approvalScope' }); // { text, isError, data }
const typed = await engine.impact('approvalScope', { page: 1 });
await engine.dispose(); // stops every language server
```

`CodeEngine` options: `root` (required), `ollamaHost?`, `model?`, `idleMs?` (default 10 min), `pageSize?` (40),
`noServers?`, `onlyLanguages?`, `indexWaitMs?` (120 s), `log?`.
