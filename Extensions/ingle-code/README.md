# ingle-code

Read-only code intelligence for small local models: **outline, definition, references, callers, callees, impact,
diagnostics** and **read_exhaustively**. Small models rarely fail for lack of brains — they miss things: a caller they
didn't look at, half a log they never read. ingle-code gives them complete, short, paged answers, and says whether each
answer is **exact** (from a language server) or **approximate** (from a text scan).

It is one engine used three ways:

1. a typed library (`src/engine/`) that Ingle for VS Code imports directly;
2. a helper process for Ingle for Mac (the same `bin/ingle-code`, tools shown as built-in tools);
3. a standard **MCP server** over stdio for any other app (Claude Code, Claude Desktop, Cursor, …).

- **No runtime dependencies.** Node 18+ only. The LSP and MCP clients are written by hand.
- **Uses the language servers you already have:** `sourcekit-lsp` (Xcode/Command Line Tools), TypeScript 7's
  `tsc --lsp` / `tsgo` or `typescript-language-server`, `pyright`, `gopls`, `rust-analyzer`. Servers are started on
  first use, kept warm per workspace, and stopped after 10 idle minutes and when the server exits.
- **Falls back** to `git grep` + patterns when a language has no server, and labels those results approximate.
- **Never edits** files (a language server may keep its own index, see below). `read_exhaustively` only talks to Ollama on this Mac; nothing else touches the network.

Full tool reference: [TOOLS.md](TOOLS.md). Background: [../../docs/ingle-code.md](../../docs/ingle-code.md).

## Build

```zsh
cd Extensions/ingle-code
npm install          # dev tools only (typescript, @types/node)
npm run build        # → out/
npm test             # node:test; language-server tests skip if the server isn't installed
./bin/ingle-code --help
```

## Use it as an MCP server

The server works on one workspace: `--root <folder>`, else the client's first MCP root, else the folder it was started
in. Replace `/path/to/Ingle` with where you cloned Ingle, and run `npm run build` first.

**Claude Code** (from inside your project, so `--root` can be the current folder):

```zsh
claude mcp add ingle-code -- node /path/to/Ingle/Extensions/ingle-code/bin/ingle-code --root "$PWD"
```

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ingle-code": {
      "command": "node",
      "args": ["/path/to/Ingle/Extensions/ingle-code/bin/ingle-code", "--root", "/path/to/your/project"]
    }
  }
}
```

**Cursor** — `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "ingle-code": {
      "command": "node",
      "args": ["/path/to/Ingle/Extensions/ingle-code/bin/ingle-code", "--root", "${workspaceFolder}"]
    }
  }
}
```

**Ingle** — `~/.ingle/mcp.json` (same format; until task 33b makes these built-in tools):

```json
{
  "mcpServers": {
    "ingle-code": {
      "command": "node",
      "args": ["/path/to/Ingle/Extensions/ingle-code/bin/ingle-code", "--root", "/path/to/your/project"]
    }
  }
}
```

GUI apps don't always get your shell's `PATH`. If a language shows as approximate in `code_status` although its server
is installed, add an `env` entry with your `PATH` (for example `"env": { "PATH": "/opt/homebrew/bin:/usr/bin:/bin" }`),
or give `node` as a full path.

### Options

| Option | Default | |
|---|---|---|
| `--root <folder>` | client root, then current folder (also `$INGLE_CODE_ROOT`) | Workspace to analyse |
| `--model <name>` | `$INGLE_CODE_MODEL`, else the smallest installed chat model (not embedding or `-base`) | Model for `read_exhaustively` notes |
| `--ollama-host <url>` | `$OLLAMA_HOST`, else `http://localhost:11434` | Must be a local address |
| `--idle-minutes <n>` | 10 | Stop a language server after this long unused |
| `--no-servers` | off | Scan only (every answer approximate) |
| `--verbose` | off (also `$INGLE_CODE_DEBUG`) | Log to stderr |

## Good to know

- **First query can be slow.** `sourcekit-lsp` indexes the package in the background the first time (about 15 s for a
  small package, about a minute for Ingle itself); later queries take milliseconds. sourcekit-lsp keeps that index
  in the package's `.build/index-build` folder (its fixed location, as with VS Code's Swift extension; `.build/` is
  normally git-ignored). Delete it to reclaim the space.
- **TypeScript.** TypeScript 7 has a native language server, used as `tsc --lsp --stdio`. With TypeScript 5 or 6, install
  `typescript-language-server` (it needs the workspace's `typescript`, or one installed next to it).
- **What "approximate" misses.** The scan matches whole words, so it can't tell two symbols with the same name apart,
  can't see calls made through a variable, and doesn't know about overloads or protocol conformances. It never misses
  a textual use, which is why it's still useful.
- **Process clean-up.** Servers get `shutdown`/`exit`, then SIGTERM, then SIGKILL. They also receive this process's PID
  and exit if it dies.

## Licence

PolyForm Noncommercial 1.0.0, like the rest of Ingle. See [../../LICENSING.md](../../LICENSING.md).
