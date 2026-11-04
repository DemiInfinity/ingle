# Ingle for Mac

A native SwiftUI app for macOS 14+ on Apple Silicon. It lives in the menu bar, has a chat window and a Settings
window, runs the bundled Ollama engine, and writes the shared files the VS Code extension reads.

Built with Swift Package Manager ([`../Package.swift`](../Package.swift), one executable target, Swift 5 language
mode) and bundled into `Ingle.app` by [`../build.sh`](../build.sh). See
[building-and-releasing.md](building-and-releasing.md).

## Features and where they live

### Menu bar, models and power

- **Menu bar icon** (`MenuBarLabel`, `MenuIcon` in [`Theme.swift`](../Sources/Ingle/Theme.swift)): three connected
  dots and "AI" — hollow and faded when asleep, top dot filled when the daily model is awake, all filled for the
  hard-jobs model. Optional model name next to it.
- **Menu** (`MenuContent` in [`MenuBar.swift`](../Sources/Ingle/MenuBar.swift)): status line, switch between the two
  assistants, autocomplete state, memory in use, **Sleep Now**, **Open Chat** (⌘O), **Settings…** (⌘,), and **More**:
  Download Models, Restart AI Engine, Update AI Engine (when an update is out), Open Model Folder, engine name and
  version.
- **Dock presence** (`DockPresence` in [`DockPresence.swift`](../Sources/Ingle/DockPresence.swift)): the app is an
  accessory (menu bar only) until a titled window is open, then becomes a regular app with a Dock icon and ⌘-Tab
  entry; closing the last window drops it back.
- **Model state** (`ModelManager` in [`ModelManager.swift`](../Sources/Ingle/ModelManager.swift)): polls `/api/ps`
  every 5 s to know which model is loaded (`offline`, `off`, `daily`, `hard`, `other`), and restarts the bundled
  engine if it disappears.
- **Switching** (`activate`): optionally unloads other models first (Settings → General → When switching models:
  *Unload the other one* (default) or *Keep both loaded*), then loads the chosen one with the right `num_ctx`.
- **Sleep timer:** `keep_alive` on every request; Settings → General → Sleep models after.
- **Autocomplete** (for the Continue extension, not Ingle itself): *Smart* (default) unloads the small autocomplete
  model while a big assistant is awake and reloads it when they sleep; *Always loaded*; *On demand*.
- **Battery** (`Power.onBattery`, `confirmHardOnBattery`): asks before loading the hard-jobs model on battery, and
  shows a banner in a chat using it.

### Models and downloads

- **Settings → Models** ([`SettingsViews.swift`](../Sources/Ingle/SettingsViews.swift) `ModelSettings`,
  `GetModelSection`): which model each role uses, each assistant's context length, downloaded models (delete).
- **Get a model:** the curated list in `ModelCatalog` ([`ModelCatalog.swift`](../Sources/Ingle/ModelCatalog.swift))
  with a **fits this Mac / very tight / too big** note (budget ≈ 72% of physical memory), or any Ollama or
  Hugging Face tag. Choose *Replace Ember*, *Replace Flint*, *Replace Autocomplete* or *New model*, optionally delete
  the old one. `ModelManager.install` streams `/api/pull` with progress.
- **Download Models** fetches any of the three configured models that are missing.

### Assistants, names and personalities

- Two roles: **Daily coding** (default name *Ember*, default model `hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS`)
  and **Hard jobs** (*Flint*, `qwen3.8:27b-mlx`). Defaults are in `Prefs.defaults`
  ([`Prefs.swift`](../Sources/Ingle/Prefs.swift)); the default characters are `Persona.dailyDefault` and
  `Persona.hardDefault`.
- **Any other model** can be given a name and character in Settings → Models → Other models (`ModelProfiles`,
  stored in the `modelProfiles` preference). Unnamed models get `Persona.otherDefault` and a pretty name from
  `ModelNames.pretty`.
- **The same facts for every model:** `Persona.systemPrompt(for:web:)` always adds how Ingle works — local engine,
  Web on/off, Terminal and Mac control, approvals, commands, the companion app, `ingle_help` — so renaming a model or
  rewriting its character never breaks the tools.

### The chat window

- **Layout** ([`ChatViews.swift`](../Sources/Ingle/ChatViews.swift)): `NavigationSplitView` with a searchable
  sidebar that follows the mode (Chat: chats grouped Today / Yesterday / Previous 7 days / Older; Code: Code chats
  grouped by project folder; right-click to delete), a status card, and the
  **This Mac** card (`SystemCard` in [`SystemMonitor.swift`](../Sources/Ingle/SystemMonitor.swift): CPU, memory,
  GPU utilisation from `IOAccelerator`, 80 s GPU sparkline).
- **Message bar:** paperclip, model pill (`ModelMenu`), **Think**, **Web**, **Mac** (hidden in Code mode), the "N allowed" badge, a
  hand icon explaining what asks first, Send/Stop. Above it: the editor chip (`EditorChip`) or, in Code mode, the
  project chip (`ProjectChip`), and the slash menu;
  below it: the context meter (`ContextMeter`) with **Compact**.
- **Messages** ([`MessageViews.swift`](../Sources/Ingle/MessageViews.swift)): `MessageRow` renders user and
  assistant bubbles, tool rows (icon, title, detail, collapsible output, denied state), nudge notes, the compaction
  divider ("Earlier messages summarised · N messages", expandable), image thumbnails, the "used context" chips
  (matched rules/skills/memories, ⚑ commands, ⚠ not followed), "Thought for Ns", tokens per second, Copy and
  Regenerate. `MarkdownView` is a small Markdown renderer; `CodeBlock` uses `CodeHighlight`
  ([`CodeHighlight.swift`](../Sources/Ingle/CodeHighlight.swift)) for syntax colouring.
- **Approval card** (`ApprovalCard`): Deny / Allow for This Session / Allow — see
  [terminal-and-mac-control.md](terminal-and-mac-control.md#approvals).
- **Shortcuts:** ⌘N new chat (a Code chat on the same project when you're in one), ⇧⌘C switch Chat / Code,
  ⇧⌘K compact chat (`IngleApp.swift` commands).
- **Storage:** `ChatStore.save()` writes all conversations to `~/Library/Application Support/Ingle/chats.json`
  atomically after each step.

### Code mode

A chat can belong to a project folder, the way Claude Code works, while normal chats stay simple.
[`Project.swift`](../Sources/Ingle/Project.swift) has the folder logic; views are in
[`CodeViews.swift`](../Sources/Ingle/CodeViews.swift).

- **Switch:** **Chat / Code** at the top of the window (`ModeSwitch`), or ⇧⌘C. A new Code chat asks for a folder
  (`ProjectPicker`: Choose Folder…, drop a folder in, or a recent project — the last eight, `Prefs.K.recentProjects`).
  The folder shows as a chip with its git branch; it can be changed until the first message. A Code chat is blank
  and unsaved until its first message, like any new chat.
- **Storage:** `Conversation.mode` (`"code"`, nil = Chat) and `Conversation.projectPath`, both optional so older
  `chats.json` still decodes. `Conversation.codeFolder` is the one place that says "this chat is Code mode on
  folder X"; approvals, the prompt and the tools all go by it. (Roadmap Phase 3 may move Code chats to
  `~/.ingle/coding/<project>/`.)
- **Workspace and approvals:** the project folder is the workspace. `MacTools.needsApproval(_:codeFolder:)`:
  `list_files` / `read_file` inside it need no approval, outside it they ask (the workspace folders setting doesn't
  apply); writes and commands always ask, with the usual scoped allowances. `Project.prepare` makes relative paths and
  a missing `cwd` mean the project folder, before approval, so the card, the session scope and the tool agree.
  Helpers (`delegate`) read only inside the project.
- **Prompt:** the coding persona (`Persona.systemPrompt(…, codeFolder:)` + `MacTools.codePrompt`, the same meaning
  as `personaPrompt` + `guidancePrompt` in the VS Code extension's `engine/prompt.ts` — keep them in step), plus
  `Project.promptSection`: folder, git branch, short `git status`, and the project's `AGENTS.md` / `CLAUDE.md` /
  `.cursorrules` (`Project.instructions`, shared with the editor bridge). The project's `.ingle/rules` and
  `.ingle/commands` apply. The editor chip isn't used in Code mode.
- **Off in Code mode:** Mac control (the pill is hidden and its tools aren't offered). Web stays opt-in per chat.
- Coding tools (`search_code`, `edit_file`, repo map) and the task list / plan mode / changes panel come in tasks 31
  and 32.

### Slash commands

Type `/` in the message box ([`SlashCommands.swift`](../Sources/Ingle/SlashCommands.swift)): a menu of commands and
skills, filtered as you type (↑↓, Tab/Return, Esc).

| Command | Does |
|---|---|
| `/compact` | Summarise the chat now |
| `/new` | New chat |
| `/mcp` | The MCP servers dialog (`MCPSheet`): source, on/off, Connect/Reconnect/Disconnect, tools, Edit mcp.json, Reload, Connect all |
| `/skill-reload` (also `/skills-reload`, `/reload`) | Re-read skills, rules and MCP servers; clear the embedding cache |
| `/commands` | List commands Ingle enforces |
| `/<skill-name> …` | Send the message with that skill attached in full |

### Documents and images

[`Documents.swift`](../Sources/Ingle/Documents.swift):

- `DocumentReader.text(at:)`: PDF via PDFKit (page by page; scanned PDFs get a hint to attach as images), Word,
  RTF, ODT, HTML and web archives via `NSAttributedString`, `.xlsx` via a minimal reader (shared strings plus the
  first five sheets as tab-separated rows, using `/usr/bin/unzip`), Pages/Numbers/Keynote via their embedded
  QuickLook preview PDF, anything else as UTF-8 or Latin-1 text if it isn't binary. Trimmed at 60,000 characters.
- `ImageStore`: any image ImageIO can read (PNG, JPEG, HEIC, …) is converted to a JPEG of at most 1,600 px
  (respecting rotation) and stored in `~/Library/Application Support/Ingle/images`; `recognizeText` runs Vision OCR.
- Attach with the paperclip or drag and drop. Text attachments are added to the message as fenced blocks; images are
  shown to vision models or OCR'd for others.

### Editor context (VS Code and Rider)

- `EditorBridge` ([`EditorBridge.swift`](../Sources/Ingle/EditorBridge.swift)) receives the current project, file,
  language, selection and problems from the VS Code extension — see
  [architecture.md](architecture.md#the-editor-bridge). **Ask Ingle** requests from the editor open a new chat with
  the selection attached (`ChatStore.receiveFromEditor`).
- **Rider:** with Settings → Extensions → **Follow Rider** and Accessibility permission, every 3 s the bridge reads
  the frontmost Rider window's title ("Project – File.cs"), finds a folder with that project name in your workspace
  folders (or one level below) and builds a context from it.
- The chip above the message box shows "Working in project · file · selection · N problems"; click it to leave the
  editor out of that chat (`Conversation.useEditor`).

### MCP servers

`MCPManager` and `MCPConnection` in [`Extensions.swift`](../Sources/Ingle/Extensions.swift):

- Reads `~/.ingle/mcp.json`, then `~/.cursor/mcp.json` and `~/.claude.json` (Ingle's wins on a clash).
- Starts a server **lazily** on first use (or **Connect** in `/mcp`), through `/bin/zsh -lc "exec <command> <args>"`
  so it gets your Terminal `PATH` (`npx`, `uvx`, `node`), with the configured `env`.
- Speaks newline-delimited JSON-RPC 2.0: `initialize` (protocol `2025-06-18`), `notifications/initialized`,
  `tools/list`, `tools/call`; answers server pings; 60 s timeout per request; results truncated at 30,000
  characters; `isError` results prefixed "Tool error:".
- The model uses two generic tools: `mcp_tools(server)` to see a server's tools and input schemas, and
  `mcp_call(server, tool, arguments)` (approved per call). Only offered when your message mentions MCP or a server's
  name, or a command requires it.
- Per-server on/off switches (Settings → Extensions → MCP, or `/mcp`), **Import from Claude Desktop**. Status is
  mirrored to `settings.json` so VS Code's `/mcp` can show it.

### Memory, web, research, skills, rules and commands

- Memory: `MemoryStore` ([`Memory.swift`](../Sources/Ingle/Memory.swift)). Web: `WebTools`
  ([`WebTools.swift`](../Sources/Ingle/WebTools.swift)). Research reports and the skill/rule builder: `ReportStore`,
  `Builder`, `KnowledgeTools` ([`Knowledge.swift`](../Sources/Ingle/Knowledge.swift)). Skills and rules:
  `SkillStore`, `RuleStore` ([`Extensions.swift`](../Sources/Ingle/Extensions.swift)). Commands:
  [`Commands.swift`](../Sources/Ingle/Commands.swift). Matching: [`SemanticMatcher.swift`](../Sources/Ingle/SemanticMatcher.swift).
- File formats: [ingle-home.md](ingle-home.md). Behaviour: [agent-loop.md](agent-loop.md), [commands.md](commands.md),
  [security-and-privacy.md](security-and-privacy.md).

### In-app help

`HelpTopics` in [`Manifest.swift`](../Sources/Ingle/Manifest.swift) is a short guide to Ingle split into topics
(overview, assistants, menu-bar, sleep, autocomplete, chat, mac-access, settings, models, extensions, web, memory,
reports, history, builder, commands, helpers, editors, engine, files, ssh, secrets, code). The model reads it with `ingle_help(topic)`
when you ask about Ingle. **Keep it accurate when behaviour changes** — it's what the assistants believe about the app.

### Settings

`SettingsView` ([`SettingsViews.swift`](../Sources/Ingle/SettingsViews.swift)), all stored in UserDefaults
(`Prefs`) and mirrored to `~/.ingle/settings.json`:

| Tab | Contents |
|---|---|
| General | Sleep timer, switching, autocomplete mode, battery warning, menu-bar name, **Launch at login** (`SMAppService`), engine status and Start/Restart, server address, **Engine updates** |
| Models | Which model each role uses, context lengths, Get a model, names and personalities, Other models, downloaded models |
| Mac Access | Workspace folders, Read files here without asking, what always asks |
| Web & Memory | Web on by default, search provider (DuckDuckGo, SearXNG URL, Brave key), memory on/off, Ask before saving, memory files, Forget Everything, research reports folder |
| Extensions | `INGLE.md`, editors (Follow Rider, Accessibility), smart matching (download `nomic-embed-text`), Commands (switches), Rules, Skills (include `~/.claude/skills`), MCP servers |
| About | Version, Ollama credit, Terms, Privacy, Licence, third-party licences (`Contents/Resources/Legal`, `OllamaRuntime`) |

### Start-up

`AppDelegate.applicationDidFinishLaunching` ([`IngleApp.swift`](../Sources/Ingle/IngleApp.swift)) ignores
`SIGPIPE` (for MCP pipes) and starts `EditorBridge`, `SettingsMirror`, `DockPresence` and `EngineUpdater`.
`ModelManager`'s init starts the engine; `MCPManager`'s init migrates old files into `~/.ingle`. On quit, MCP
servers and the engine Ingle started are stopped.

## File-by-file map of `Sources/Ingle`

| File | Lines (approx.) | What's in it |
|---|---|---|
| [`IngleApp.swift`](../Sources/Ingle/IngleApp.swift) | 60 | `@main IngleApp` (chat `Window`, `Settings`, `MenuBarExtra`), `AppDelegate`, ⌘N and ⇧⌘K |
| [`ChatStore.swift`](../Sources/Ingle/ChatStore.swift) | 990 | `ChatMessage`, `Conversation`, `Attachment`, `PendingApproval`; **the agent loop** `generate(in:)`; approvals and `sessionAllowed`; `runTool` (Mac-control gate, screenshots, image reads), `chatTool` (past chats), `runSubAgent`, `toolPool`; vision detection; `historyJSON`, `fit`, `compact`, `contextUsage`; slash commands; persistence |
| [`ChatViews.swift`](../Sources/Ingle/ChatViews.swift) | 660 | `ChatRoot`, `Sidebar`, `StatusCard`, `ChatDetail` (composer, pills, attachments, drag and drop, slash keys), `ContextMeter`, `EditorChip`, `ModelMenu`, `ThinkToggle`, `Banner`, `ApprovalCard`, `EmptyChat` |
| [`MessageViews.swift`](../Sources/Ingle/MessageViews.swift) | 450 | `MessageRow`, `ThinkSplitter`, `TypingDots`, `CopyButton`, a small Markdown parser (`Markdown`, `MDBlock`, `MarkdownView`), `CodeBlock` |
| [`Tools.swift`](../Sources/Ingle/Tools.swift) | 270 | `MacTools`: Terminal and Mac-control definitions, `ingle_help`, `mcp_tools`/`mcp_call`, prompts, `describe`, `needsApproval`, `run`, shell, AppleScript, `open` quoting |
| [`ToolSelection.swift`](../Sources/Ingle/ToolSelection.swift) | 50 | Per-turn keyword filtering of optional tools |
| [`Commands.swift`](../Sources/Ingle/Commands.swift) | 230 | `IngleCommand`, `CommandStore` (load, prompt block, index, enable, create), `CommandTracker` |
| [`Prefs.swift`](../Sources/Ingle/Prefs.swift) | 320 | `Prefs` keys and defaults, `Persona` (defaults and `systemPrompt`), `ModelNames`, `ModelProfiles`, `Companion` |
| [`Manifest.swift`](../Sources/Ingle/Manifest.swift) | 170 | `IngleManifest` (`INGLE.md`), `HelpTopics` |
| [`Project.swift`](../Sources/Ingle/Project.swift) | 140 | Code mode: project folder, path resolving, git info, rules files, prompt section, recent projects |
| [`CodeViews.swift`](../Sources/Ingle/CodeViews.swift) | 150 | Code mode views: `ModeSwitch`, `ProjectPicker`, `ProjectChip` |
| [`Ollama.swift`](../Sources/Ingle/Ollama.swift) | 270 | `OllamaClient` (version, tags, ps, load/unload, delete, capabilities, pull, streaming chat with think retry), `ToolCall`, `ModelTuning` |
| [`OllamaServer.swift`](../Sources/Ingle/OllamaServer.swift) | 90 | Start/stop the bundled engine; local vs remote |
| [`EngineUpdater.swift`](../Sources/Ingle/EngineUpdater.swift) | 370 | Update checks, notifications, download, SHA-256, staging, slimming, swap, roll back, `Downloader` |
| [`ModelManager.swift`](../Sources/Ingle/ModelManager.swift) | 280 | Model state polling, switching, sleep, autocomplete pausing, downloads, install/delete, battery |
| [`ModelCatalog.swift`](../Sources/Ingle/ModelCatalog.swift) | 70 | Curated models and the "fits this Mac" estimate |
| [`Extensions.swift`](../Sources/Ingle/Extensions.swift) | 630 | `IngleHome` (paths, migration), `RuleStore`, `SkillStore` (+ frontmatter parser), `MCPConnection`, `MCPManager` |
| [`Knowledge.swift`](../Sources/Ingle/Knowledge.swift) | 190 | `ReportStore`, `Builder` (skill/rule create), `KnowledgeTools` (chat, report, builder, delegate definitions; sub-agent allow-list) |
| [`Memory.swift`](../Sources/Ingle/Memory.swift) | 180 | `MemoryStore` (save, rewrite, forget, read, search, secret filter, index, prompt, tools) |
| [`WebTools.swift`](../Sources/Ingle/WebTools.swift) | 190 | `web_search` (DuckDuckGo HTML, SearXNG JSON, Brave API), `web_fetch`, `isPrivate`, `HTMLText` |
| [`SemanticMatcher.swift`](../Sources/Ingle/SemanticMatcher.swift) | 90 | Embedding and keyword matching |
| [`Documents.swift`](../Sources/Ingle/Documents.swift) | 210 | `DocumentReader`, `ImageStore`, `Attachment.from` |
| [`EditorBridge.swift`](../Sources/Ingle/EditorBridge.swift) | 285 | `EditorContext`, the loopback HTTP listener, token, Rider watcher, `AppActions` |
| [`SettingsMirror.swift`](../Sources/Ingle/SettingsMirror.swift) | 100 | Writes `~/.ingle/settings.json` |
| [`SettingsViews.swift`](../Sources/Ingle/SettingsViews.swift) | 980 | All Settings tabs |
| [`SlashCommands.swift`](../Sources/Ingle/SlashCommands.swift) | 245 | Slash items and filtering, `SlashMenu`, `MCPSheet` |
| [`MenuBar.swift`](../Sources/Ingle/MenuBar.swift) | 90 | `MenuBarLabel`, `MenuContent` |
| [`DockPresence.swift`](../Sources/Ingle/DockPresence.swift) | 45 | Dock / accessory switching |
| [`SystemMonitor.swift`](../Sources/Ingle/SystemMonitor.swift) | 160 | CPU, memory and GPU sampling; `SystemCard` |
| [`Theme.swift`](../Sources/Ingle/Theme.swift) | 140 | `Ember` palette, `NetworkMark` logo, `MenuIcon`, button and pill styles |
| [`CodeHighlight.swift`](../Sources/Ingle/CodeHighlight.swift) | 145 | Lightweight syntax colouring for code blocks |

Supporting files: [`../Support/Info.plist`](../Support/Info.plist) (bundle id `app.ingle.mac`, macOS 14, local
networking for ATS, Apple Events and folder usage descriptions) and [`../Support/AppIcon.png`](../Support/AppIcon.png).

## Trade-offs

| We chose | We gave up | Why |
|---|---|---|
| **SwiftUI, macOS 14+, Apple Silicon only** | Intel Macs, older macOS, other platforms | Observation, `MenuBarExtra`, `SMAppService` and good local-model performance all point at recent Apple Silicon. Reach beyond the Mac is the extension's job ([weaknesses-and-mitigations.md](weaknesses-and-mitigations.md#4-mac-only-reach)). |
| **Swift Package Manager + a shell script**, no Xcode project | Xcode's signing UI, asset catalogues, entitlements editor | Builds anywhere with the command-line tools, diffs cleanly, easy for contributors. Signing and notarisation will be scripted ([building-and-releasing.md](building-and-releasing.md#future-signing-notarisation-and-sparkle)). |
| **All chats in one `chats.json`** | Scalability for thousands of long chats | Simple, atomic and easy to back up; images are stored separately so it stays small. A shared, per-chat store is on the [roadmap](roadmap.md). |
| **Menu-bar first, Dock only while a window is open** | A conventional always-in-Dock app | Ingle is mostly a background companion (model state, sleep); it shouldn't take a Dock slot all day. |
| **Two roles (Daily/Hard)** plus optional profiles | Arbitrary numbers of assistants | Only one big model fits in memory at a time on most Macs; two clear roles make switching obvious, and any other model can still be named. |
| **Polling `/api/ps` every 5 s** | Instant state updates | Ollama has no event stream; 5 s is cheap and good enough for a menu bar. |
| A **hand-written Markdown renderer and highlighter** | Full CommonMark and grammar-accurate highlighting | No third-party packages; the subset models use (headings, lists, code, emphasis, links) renders well. |
| **`/bin/zsh -lc` for MCP servers** | Fast, isolated start-up | GUI apps don't get your Terminal `PATH`; a login shell finds `npx`/`uvx` reliably. |
