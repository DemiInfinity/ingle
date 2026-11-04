# Ingle documentation

Ingle is a local-first AI assistant for Apple Silicon Macs, in two parts that share one brain:

- **Ingle for Mac** — a native SwiftUI menu-bar app with a chat window, a built-in (bundled, slimmed) Ollama engine,
  Terminal tools, optional Mac control, memory, web research, skills, rules, commands and MCP servers.
  Code: [`../Sources/Ingle/`](../Sources/Ingle/).
- **Ingle for VS Code** — a coding chat that opens as editor tabs, reads and edits your project (with diffs you
  approve), runs commands, and keeps a ranked repo map. Code: [`../Extensions/vscode/`](../Extensions/vscode/).

Both talk to the same local Ollama engine and share one folder, `~/.ingle`, so assistants, memory, rules, skills,
commands and MCP servers follow you between the Mac app and your editor.

> **Status: early preview.** Ingle builds from source, is ad-hoc signed (no Developer ID yet) and has only a first
> set of unit tests (VS Code extension). Read [weaknesses-and-mitigations.md](weaknesses-and-mitigations.md) for an honest account of where it
> falls short and what has been done about it.

## Where to start

### If you want to use Ingle

1. [features.md](features.md) — one table of everything Ingle does, and where it's explained.
2. [building-and-releasing.md](building-and-releasing.md) — how to build and install both apps (there's no signed download yet).
3. [terminal-and-mac-control.md](terminal-and-mac-control.md) — what the assistant can do on your Mac and how approvals work.
4. [commands.md](commands.md) — make the assistant *obey* rules ("always run the linter after editing").
5. [ingle-home.md](ingle-home.md) — every file in `~/.ingle`, so you can read and edit them by hand.
6. [security-and-privacy.md](security-and-privacy.md) — what leaves your Mac, when, and what protects you.
7. [troubleshooting.md](troubleshooting.md) — when something doesn't work.

### If you want to contribute

1. [../CONTRIBUTING.md](../CONTRIBUTING.md) and [../CLAUDE.md](../CLAUDE.md) — ground rules, style, the fork-and-PR flow, Swift pitfalls.
2. [architecture.md](architecture.md) — the big picture: the two apps, the engine, `~/.ingle`, the editor bridge, message flow.
3. [agent-loop.md](agent-loop.md) — the heart of Ingle: prompt assembly, tool selection, approvals, guards, compaction.
4. [mac-app.md](mac-app.md) — every Mac feature and a file-by-file map of `Sources/Ingle`.
5. [vscode-extension.md](vscode-extension.md) — extension architecture, the webview protocol, tools and settings.
6. [engine.md](engine.md) — how the Ollama engine is bundled, slimmed, started and updated.
7. [weaknesses-and-mitigations.md](weaknesses-and-mitigations.md) and [roadmap.md](roadmap.md) — what's left to do.

## All documents

| Document | What it covers |
|---|---|
| [features.md](features.md) | Every feature in one table: Mac app, VS Code or both, with links |
| [architecture.md](architecture.md) | Components, shared state, settings mirror, editor bridge, end-to-end message flow (with diagrams) |
| [mac-app.md](mac-app.md) | Mac app features and where each lives; file-by-file map of `Sources/Ingle` |
| [vscode-extension.md](vscode-extension.md) | `EngineShared` vs per-tab `ChatEngine`, webview protocol, tools, settings, `install.sh`, file map |
| [agent-loop.md](agent-loop.md) | Prompt assembly, tool selection, approvals, the loop and its guards, compaction, sub-agents, thinking, tuning, vision |
| [terminal-and-mac-control.md](terminal-and-mac-control.md) | The two levels of access, SSH to your own servers, approvals and session allowances, AppleScript, screenshots, macOS permissions |
| [commands.md](commands.md) | The obedience layer: concept, file format, enforcement, examples, Mac vs VS Code |
| [ingle-home.md](ingle-home.md) | Every file format in `~/.ingle`, with examples, and other data locations |
| [engine.md](engine.md) | Bundling and slimming Ollama (`INGLE_MLX`), auto-start, remote servers, `EngineUpdater` |
| [ingle-code.md](ingle-code.md) | Code intelligence engine + MCP server: exact (language servers) vs approximate answers, `impact`, `read_exhaustively` |
| [weaknesses-and-mitigations.md](weaknesses-and-mitigations.md) | Known weaknesses, the evidence, what was done, honest status, what's left |
| [security-and-privacy.md](security-and-privacy.md) | Data flows, approvals, web safety, secrets, bridge token, update verification, signing, threat model |
| [building-and-releasing.md](building-and-releasing.md) | Prerequisites, `build.sh`, `local.env`, the extension, `export-release.sh`, git flow, versioning, signing plans |
| [troubleshooting.md](troubleshooting.md) | Common problems and fixes |
| [roadmap.md](roadmap.md) | Known gaps and planned work, including the Ingle Knowledge Portal |
| [improvement-plan.md](improvement-plan.md) | The next concrete tasks, in waves, written so each can be handed to an agent (includes SSH access) |

## Conventions in these docs

- British English. Code identifiers are in `backticks`. Links to code are relative, e.g.
  [`../Sources/Ingle/ChatStore.swift`](../Sources/Ingle/ChatStore.swift).
- Paths use placeholders such as `~/Projects/your-project`.
- When these docs and the code disagree, **the code wins** — please fix the doc in the same pull request.
  The in-app help the assistants read (`HelpTopics` in [`../Sources/Ingle/Manifest.swift`](../Sources/Ingle/Manifest.swift))
  must be kept accurate too.
- Every feature-level document has a **Trade-offs** section: what we chose, what we gave up, and why.

## Legal

[Licence (PolyForm Noncommercial 1.0.0)](../LICENSE.md) · [Licensing in plain words](../LICENSING.md) ·
[Terms of Use](../TERMS.md) · [Privacy Policy](../PRIVACY.md) · [Code of Conduct](../CODE_OF_CONDUCT.md)
