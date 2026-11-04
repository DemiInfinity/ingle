# CLAUDE.md — Ingle

Read this first. It's a map of the product and the code so you don't have to rediscover it. Deeper detail is in
`docs/` (start at `docs/README.md`); when this file and the code disagree, the code wins — then fix this file.

## What Ingle is

A local-first AI assistant for Apple Silicon Macs, in two parts that share one brain:

1. **Mac app** (`Sources/Ingle/`, SwiftUI, macOS 14+, Swift 5 language mode) — menu-bar app + chat window.
   Bundles the **Ollama** engine inside `Ingle.app/Contents/Resources/OllamaRuntime` and talks to it over HTTP
   (`http://localhost:11434`, `/api/chat` streaming with tools and `think`, `/api/show`, `/api/pull`, `/api/ps`, `/api/embed`).
2. **VS Code extension** (`Extensions/vscode/`, TypeScript, **no runtime npm deps**) — coding chat as editor tabs.
   Talks to the same engine directly; works without the Mac app open.

Shared state lives in **`~/.ingle/`** (rules, skills, commands, memory, research, `mcp.json`, `secrets.json` names only, generated `INGLE.md`
index, `settings.json` written by the Mac app). Status: **early preview**. Licence: **PolyForm Noncommercial 1.0.0**
(not MIT — see `LICENSING.md`). Default assistants: **Ember** (daily coding) and **Flint** (hard jobs).

## Build and check

```zsh
./build.sh                    # swift build -c release → build/Ingle.app (+ copies & slims the Ollama runtime)
./build.sh --install          # also copies to /Applications and opens it
INGLE_MLX=v3 ./build.sh       # keep only mlx_metal_v3 (smaller; macOS 14+). Options: both (default) | v3 | v4 | none
cd Extensions/vscode && node node_modules/typescript/bin/tsc -p . --noEmit   # type-check the extension
node --check Extensions/vscode/media/chat.js                                 # syntax-check the webview
cd Extensions/vscode && npm test              # extension unit tests (node:test, offline; output in out-test/)
cd Extensions/vscode && ./install.sh          # compile, package ingle.vsix, install into VS Code
```

Only the extension has tests (`Extensions/vscode/test/`, pure logic: commands, frontmatter, edit matching, matcher,
tool selection); the Mac app has none. You can't compile Swift on Linux — be careful (see Swift pitfalls below).
Personal build settings go in git-ignored `local.env` (`INGLE_BUNDLE_ID`, `VSCODE_PUBLISHER`, `PRIVATE_WORDS`).
`scripts/export-release.sh` makes a clean publishable copy and scans it for private words.

## Mac app — file map (`Sources/Ingle/`)

| File | What it does |
|---|---|
| `IngleApp.swift` | `@main`, scenes (chat `Window`, `Settings`, `MenuBarExtra`), `AppDelegate` starts EditorBridge, SettingsMirror, DockPresence, EngineUpdater; ⌘N, ⇧⌘K compact |
| `ChatStore.swift` | **The agent loop.** Conversations, `send`, `generate` (prompt assembly → tool selection → commands → compaction → stream → tools → completion check), approvals (`sessionAllowed`), `runTool`, `chatTool`, `runSubAgent`, compaction (`compact`, `fit`, `historyJSON`), vision detection, slash commands |
| `ChatViews.swift` / `MessageViews.swift` | Chat UI: sidebar, composer (pills: model, **Effort**, Web, **Mac** = Mac control), slash menu, attachments, context meter, approval card, message rows (tool rows, nudges, compaction divider, images) |
| `Tools.swift` | `MacTools`: Terminal tools (`list_files`, `read_file`, `write_file`, `run_command` — always available) and **Mac control** (`controlDefinitions`: `open`, `applescript`, `screenshot` — only when the Mac button is on); `describe`, `needsApproval`, `run`, prompts |
| `ToolSelection.swift` | Per-turn tool filtering by keywords (fewer tools → better accuracy for small models) |
| `Project.swift` / `CodeViews.swift` | **Code mode**: `Conversation.codeFolder` is the one switch; project folder, path resolving (`prepare`), git info, rules files, prompt section, recent projects; `ModeSwitch` (Chat / Code, ⇧⌘C), `ProjectPicker`, `ProjectChip` |
| `Effort.swift` | **Effort levels** table (`EffortLevel`, in step with `effort.ts`), check-command detection, built-in `verify` command, `OllamaThink`, Max's plan + review |
| `WorkMode.swift` | **Modes** (Ask · Edit · Auto · Plan · Debug): `riskyCommand`, `autoApproval`, `DebugState`, `ModeMenu`, `ModeBadge` — in step with `modes.ts` |
| `TaskList.swift` | **Task list** (`update_tasks`, `TaskListView`), **plan mode** (`planModeTools`, refusal, `PlanApproveBar`), steering text — rules in step with `tasks.ts` |
| `ChangesPanel.swift` | **Changes panel** under a run's last reply (diffs, Open in editor, Undo this run, Commit) and `GitCommit` (commit exactly the run's files, never push) — in step with `gitCommit.ts` |
| `Checkpoints.swift` | **Undo this run**: `snapshot(path:run:)` (called by every file-changing tool; the one list is `fileChangingTools`), `finish`, `changes`, `restore(force:)`, pruning — same format as `checkpoints.ts` |
| `Commands.swift` | **Commands** (obedience layer): `CommandStore` (files in `~/.ingle/commands`), `CommandTracker` (requirements, blocking, nudges) |
| `Prefs.swift` | UserDefaults keys/defaults, `Persona` (default characters + `systemPrompt(for:web:)` with the built-in facts every model gets), `ModelNames`, `ModelProfiles` (names/personas for any model), `Companion` (does the other app exist?) |
| `Manifest.swift` | `IngleManifest.refresh` builds the `INGLE.md` index; `HelpTopics` = in-app help the model reads via `ingle_help` — **keep it accurate** |
| `Ollama.swift` | HTTP client, streaming chat, `think` as level/on/off with retry, `capabilities`, `ModelTuning` (per-model sampling, e.g. Qwen) |
| `OllamaServer.swift` | Starts/stops the bundled engine (`builtInBinary` prefers an updated engine), local vs remote server |
| `EngineUpdater.swift` | Checks GitHub releases daily, notifications, download (progress) → sha256 verify → stage → slim → swap `current`/`previous`, roll back |
| `ModelManager.swift` / `ModelCatalog.swift` | Model state, switching, sleep timer, smart autocomplete pausing, downloads |
| `Extensions.swift` | `IngleHome` paths, `RuleStore`, `SkillStore`, `MCPManager` + `MCPConnection` (stdio JSON-RPC) |
| `Secrets.swift` | Secrets store: Keychain (service `Ingle`), `secrets.json` names, composer detection, `{{secret:name}}` substitution (env vars for commands), output scrubbing, Touch ID, `secret_list` |
| `Knowledge.swift` / `Memory.swift` / `WebTools.swift` | Research reports + builders (skill/rule create); memory store (secret filter, index); read-only web search/fetch with private-host blocking |
| `Documents.swift` | Document→text (PDFKit, NSAttributedString, xlsx), `ImageStore` (HEIC→JPEG, Vision OCR), attachments |
| `SemanticMatcher.swift` | Attaches matching rules/skills/memory/reports (nomic-embed-text embeddings, keyword fallback) |
| `SlashCommands.swift` | `/` menu items, `MCPSheet` (`/mcp` dialog) |
| `SettingsViews.swift` | Settings tabs (General incl. engine updates, Models incl. personas, Mac Access, Web & Memory, Extensions incl. Commands, About with Ollama credit + legal links) |
| `SettingsMirror.swift` | Writes `~/.ingle/settings.json` (assistants, models, web, memory, MCP status) for VS Code |
| `EditorBridge.swift` | Local HTTP listener (127.0.0.1:47123, token `~/.ingle/bridge-token`) — editor context from VS Code / Rider |
| `DockPresence.swift` | Shows in Dock only while a window is open |
| `MenuBar.swift`, `SystemMonitor.swift`, `Theme.swift`, `CodeHighlight.swift` | Menu, CPU/GPU/memory card, ember palette/components, syntax colouring |

## VS Code extension — file map (`Extensions/vscode/src/`)

| Path | What it does |
|---|---|
| `extension.ts` | Activation: commands (`ingle.newTab`, `focus`, `popOut`, `newChat`, `askSelection`, `explain/fixProblem`, `forgetApprovals`, `terms`, `privacy`, `about`), bridge to the Mac app |
| `ui/chatView.ts` | `ChatPanels` (all tabs, serializer restore, `lastActive`) and `ChatTab` (one webview panel + one `ChatEngine`); tab title = chat title |
| `engine/chatEngine.ts` | `EngineShared` (one ChatStore, EngineServer, Matcher, DiffProvider, `sessionAllowed`, MCP) + per-tab `ChatEngine` (agent loop `runLoop`, `toolsFor`, approvals, commands enforcement, compaction, sub-agents, attachments, slash, `/mcp`) |
| `engine/toolSelection.ts` | Per-turn tool filtering (`selectTools`, pure — called by `toolsFor`) |
| `engine/effort.ts` | Effort levels table (in step with `Effort.swift`), think mapping, check-command detection, verify command (pure, tested) |
| `engine/prompt.ts` | Persona/facts (mirrors `Persona.systemPrompt`), index, editor context, guidance, companion fact |
| `engine/ollama.ts`, `server.ts`, `chatStore.ts`, `matcher.ts`, `names.ts`, `diff.ts` | Client + `tuning()`, engine start, per-workspace chat storage, matching, model names, diff documents |
| `engine/modes.ts`, `tools/tasks.ts`, `engine/steer.ts`, `tools/gitCommit.ts` | Task list + plan mode filter, steering queue, commit a run's files (all pure, tested in `test/workflow.test.ts`) |
| `tools/checkpoints.ts` | **Undo this run** (pure, tested): `snapshot()` from every file-changing tool (`FILE_CHANGING_TOOLS` lives here), `finish`, `changes`, `restore`, `prune` |
| `tools/secretsCore.ts`, `secrets.ts` | Secrets store (pure logic, tested) and `secret_list` + getting values from the Mac app / `security` |
| `tools/*.ts` | `ToolDef`s: files (read/list/find/search/problems/edit with diff/write), command, documents/images (macOS tools), web, memory, knowledge, `commands.ts`, `mcp.ts`, `repomap.ts`, `stores.ts` (reads `~/.ingle`) |
| `shared/protocol.ts` | **Webview ↔ extension message contract** — both sides must match |
| `shared/settings.ts` | Reads `~/.ingle/settings.json` with defaults |
| `../media/chat.js`, `chat.css` | The webview UI (plain JS, no frameworks) |

## Key behaviours (keep both apps consistent)

- **Approvals:** every command, file write, app action, MCP call and out-of-workspace read asks: Deny / Allow for This
  Session / Allow. Session allowances are in memory only (until the app quits).
- **Secrets:** values only in the Keychain; the model sees `{{secret:name}}`. Calls using one always ask (no session
  allowance, Touch ID if on), values are put in after approval, and tool output is scrubbed back to placeholders.
- **Checkpoints:** each run (one reply) copies a file's original to `~/.ingle/checkpoints/<chat>/<run>/` before its
  first change; **Undo this run** under the reply restores them all, refusing ("Undo anyway") if a file changed after
  the run. Not `run_command`/MCP/SSH changes. Pruned after 14 days or above 500 MB.
- **Workflow (task 32):** `update_tasks` task list pinned under the latest reply (Max's plan becomes it); plan mode per
  chat is now one of the **Mode** pill's five modes (Ask · Edit · Auto · Plan · Debug, ⇧Tab cycles, `WorkMode.swift` /
  `modes.ts`; Edit/Auto auto-approve inside the project, Auto's risky-command list in one function per app, tested);
  changes panel + Commit (exactly the run's files, approval, never
  pushes, sign-off off by default); typing during a run queues the message for the model's next step. Per chat state.
- **Terminal vs Mac control:** Terminal tools always on; the Mac button only gates `open`/`applescript`/`screenshot`.
- **Code mode (Mac app):** a chat on a project folder. Reads inside it are free, outside ask; writes/commands ask. Coding
  persona = the extension's `personaPrompt` + `guidancePrompt` meaning (keep in step). Mac control off.
- **Commands:** `~/.ingle/commands/*.md` with `when`, `must_use` (tool | `mcp:server[/tool]` | `skill:name`), `never_use`,
  `then_run`, `enabled`. Enforced: required tools offered, banned blocked, ≤2 nudges before finishing, ⚑/⚠ chips.
- **Effort:** Low · Medium · High · Max per chat (pill; ⌘⇧E on Mac), default per assistant (Ember Medium, Flint High).
  Sets `think` (level only for models that take one), a prompt line, tool-filter strictness, guard limits; High/Max
  must run the project's check command after editing (built-in `verify` command via the command checks); Max plans
  first and a read-only helper reviews the diff. Both tables live in `Effort.swift` / `effort.ts` — change both.
- **Small-model tuning:** per-turn tool filtering; Qwen sampling settings; repeat-call guard (3rd identical call skipped,
  4th at High/Max); stuck stop after 4 skips (6 at High/Max); no small step cap (200 backstop); compaction at ~75% of context, then `fit()` trimming.
- **Prompt facts:** every model gets the same Ingle facts (`Persona.systemPrompt` / `personaPrompt`) whatever its name.
  If you change behaviour, update those facts **and** `HelpTopics` **and** `docs/`.
- **Privacy:** no telemetry. Network only for Web (opt-in per chat), model downloads, daily engine-update check. Don't add others
  without updating `PRIVACY.md`.

## Swift pitfalls (these broke the build before)

- Long expressions time out the type-checker → split into `let` steps with explicit types (`let x: Int = …`).
- No `await` inside `||`, `&&`, `??` or `where` clauses — compute it first (`let up = await …`).
- No tuple destructuring in `guard let`/`if let` (`if let (a, b) = …`) — bind the tuple, then use `.0`/`.1`.
- `@MainActor` things (e.g. `MCPManager.shared`) can't be used from non-isolated autoclosures; mark callers `@MainActor`.
- Codable structs: new stored properties must be **optional** or old `chats.json` fails to decode.
- No duplicate keys in Set/Dictionary literals (crashes at runtime).

## Conventions

British English everywhere (UI, prompts, docs). UI text is plain and short. Prompts are short (small context windows)
and identical in meaning between the two apps. TypeScript strict, no runtime deps. Never commit `local.env`, `private/`,
build output or personal data. Commits are signed off (`git commit -s`); contributions fall under the contributor terms in
`CONTRIBUTING.md`.

## Roadmap pointers

Direction: *models are replaceable engines; Ingle is the part that knows you* (knowledge in files, not weights).
Phases: 1 benchmark + signed install + model picker · 2 learning loop (rules drafted from corrections, scorecards,
worked examples, model playbooks, knowledge packs) · 3 projects, scheduled tasks, shared chat storage, checkpoints ·
4 Windows/Linux extension, **Ingle Knowledge Portal** (LAN sync + web UI), encryption · 5 open design system.
See `docs/roadmap.md`.
