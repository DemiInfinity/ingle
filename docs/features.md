# Features

Every feature in Ingle, in one table. **Where** says which app has it: **Mac** (the Mac app), **VS Code** (the
extension) or **Both**. Where a feature exists in both but behaves differently, the linked doc explains how.

| Feature | Where | What it does | Explained in |
|---|---|---|---|
| **Assistants and models** | | | |
| Named assistants (Ember and Flint) | Both | Two roles, *Daily coding* and *Hard jobs*, each with a name, a model, a personality and a context length. Edited in the Mac app; VS Code reads them from `~/.ingle/settings.json`. | [mac-app.md](mac-app.md#assistants-names-and-personalities) |
| Names and personalities for any model | Mac | `ModelProfiles`: give any other downloaded model its own name and character (Settings → Models → Other models). | [mac-app.md](mac-app.md#assistants-names-and-personalities) |
| Built-in facts in every prompt | Both | Whatever the name or character, every model is told the same facts about Ingle, its tools and approvals (`Persona.systemPrompt` / `personaPrompt`). | [agent-loop.md](agent-loop.md#1-prompt-assembly) |
| Companion awareness | Both | Each app knows whether the other is installed and may suggest it once per chat (`Companion`, `companionFact`). | [architecture.md](architecture.md#companion-each-app-knows-about-the-other) |
| Model switching and sleep timer | Mac | Switch assistant from the menu bar or the chat's model pill; models unload after a timer; "unload the other one" on switch. | [mac-app.md](mac-app.md#menu-bar-models-and-power) |
| Smart autocomplete pausing | Mac | Pauses the Continue autocomplete model while a big model is awake, reloads it when they sleep. | [mac-app.md](mac-app.md#menu-bar-models-and-power) |
| Battery warning | Mac | Asks before loading the *Hard jobs* model on battery; banner in the chat. | [mac-app.md](mac-app.md#menu-bar-models-and-power) |
| Get a model | Mac | Curated catalogue with a "fits this Mac" note, or any Ollama / Hugging Face tag; replace a role and optionally delete the old model. | [mac-app.md](mac-app.md#models-and-downloads) |
| Sampling settings per model (`ModelTuning`) | Both | Sends the model makers' recommended sampling (Qwen3 thinking / non-thinking presets) and `num_ctx` on every request. | [agent-loop.md](agent-loop.md#8-model-tuning) |
| Vision detection | Both | Asks Ollama's `/api/show` whether a model can see images; if not, images are read with on-device OCR instead. | [agent-loop.md](agent-loop.md#9-vision-and-images) |
| **Engine** | | | |
| Bundled, slimmed Ollama engine | Mac | `build.sh` copies Ollama into `Ingle.app`, strips Intel code, tray-app images and `llama-quantize`, and optionally one or both MLX libraries (`INGLE_MLX`). | [engine.md](engine.md#bundling-and-slimming) |
| Engine auto-start | Both | Starts the engine when the app opens, a chat opens, or a message is sent; uses an already-running Ollama if there is one. | [engine.md](engine.md#starting-the-engine) |
| Engine updates (`EngineUpdater`) | Mac | Daily check of Ollama's GitHub releases, notification, download with progress, SHA-256 check, staging, smoke test, swap, roll back, "Use Built-in". | [engine.md](engine.md#engineupdater-keeping-ollama-current) |
| Remote engine | Both | Point the server address at another computer running Ollama; Ingle won't try to start or manage it. | [engine.md](engine.md#remote-servers) |
| **Chat** | | | |
| Streaming chat with thinking | Both | Streams replies and the model's reasoning ("Thought for Ns"), speed in tokens per second, Copy and Regenerate. | [agent-loop.md](agent-loop.md#7-thinking) |
| Chat history and search | Both | Mac: all chats in a searchable sidebar grouped by date. VS Code: per-workspace history (last 50 chats). | [mac-app.md](mac-app.md#the-chat-window) · [vscode-extension.md](vscode-extension.md#chat-storage) |
| Multiple editor tabs | VS Code | Each click on the Ingle icon opens another tab with its own chat; tabs come back after a restart; ↗ pops a tab into its own window. | [vscode-extension.md](vscode-extension.md#tabs-chatpanels-and-chattab) |
| Auto-summarised tab titles | VS Code | After the first reply, the model names the chat in 2–6 words; the tab and history use it. | [vscode-extension.md](vscode-extension.md#tabs-chatpanels-and-chattab) |
| Attachments (documents, images, HEIC) | Both | Paperclip, drag and drop or paste: PDF, Word, RTF, Excel, Pages and code become text; images (including HEIC) are shown to vision models or OCR'd. | [mac-app.md](mac-app.md#documents-and-images) · [vscode-extension.md](vscode-extension.md#attachments-documents-and-images) |
| Slash menu | Both | Type `/`: `/compact`, `/new`, `/mcp`, `/skill-reload`, `/commands`, and every skill as `/skill-name`. | [mac-app.md](mac-app.md#slash-commands) |
| Compaction and context meter | Both | Long chats summarise their older part automatically at 75% of the context; meter under the message box; manual `/compact`. | [agent-loop.md](agent-loop.md#5-compaction-and-fitting-the-context) |
| Past-chat tools | Mac | `chat_list`, `chat_search`, `chat_read` let the assistant look back through other chats. | [agent-loop.md](agent-loop.md#2-the-tool-catalogue) |
| In-app help (`ingle_help`) | Mac | The assistant reads `HelpTopics` to answer questions about Ingle itself. | [mac-app.md](mac-app.md#in-app-help) |
| **Acting on your machine** | | | |
| Terminal tools | Both | Always available: list and read files (free inside workspace folders), write files and run commands (each approved). VS Code adds `find_files`, `search_code`, `get_problems`, `edit_file`, `open_url`. | [terminal-and-mac-control.md](terminal-and-mac-control.md) |
| Mac control | Mac | The **Mac** button in a chat adds `open`, `applescript` and `screenshot`, each approved. | [terminal-and-mac-control.md](terminal-and-mac-control.md#level-2-mac-control) |
| Approvals with session allowances | Both | Deny / Allow for This Session / Allow. Session allowances are narrow (exact command + folder, one folder for writes, `server/tool` for MCP), the card says what they cover, and they last until the app quits. Mac shows an "N allowed" badge; VS Code has **Ingle: Ask Before Every Action Again**. | [terminal-and-mac-control.md](terminal-and-mac-control.md#approvals) |
| Edits with diffs, Undo | VS Code | `edit_file` / `write_file` approvals show a unified diff and a **View Diff** button; edits go through a `WorkspaceEdit` so Undo works. | [vscode-extension.md](vscode-extension.md#editing-files-safely) |
| Tolerant edit matching | VS Code | `edit_file` matches exactly, then ignoring line endings and trailing spaces, and on failure shows the closest lines. | [vscode-extension.md](vscode-extension.md#editing-files-safely) |
| Insert / Apply code | VS Code | Code blocks in replies have Copy, Insert (at cursor) and Apply (replace selection, or whole-file diff then confirm). | [vscode-extension.md](vscode-extension.md#code-actions) |
| Repo map | VS Code | A ranked outline of the project's files and key symbols in every request, plus a `repo_map` tool. | [vscode-extension.md](vscode-extension.md#repo-map) |
| Problems panel and quick actions | VS Code | `get_problems`; right-click **Ask Ingle About This** (⌘⌥I), **Explain/Fix This Problem**. | [vscode-extension.md](vscode-extension.md#commands-and-keybindings) |
| **Knowledge and rules** | | | |
| Commands (the obedience layer) | Both | Rules Ingle *enforces*: required tools are always offered, banned tools are blocked, and the assistant can't finish until requirements are met (up to 2 nudges), with ⚑ / ⚠ chips. | [commands.md](commands.md) |
| Rules | Both | One Markdown file per rule; `always: true` rules go in every chat, others are listed and loaded on demand. Project rules in `<project>/.ingle/rules`. | [ingle-home.md](ingle-home.md#rules) |
| Skills | Both | Claude's `SKILL.md` format in `~/.ingle/skills` (and optionally `~/.claude/skills`); `/skill-name` forces one. | [ingle-home.md](ingle-home.md#skills) |
| Skill, rule and command builder | Both | Ask the assistant to make one; it drafts it with `skill_create` / `rule_create` / `command_create` and you approve the card. | [ingle-home.md](ingle-home.md#skills) · [commands.md](commands.md#creating-commands) |
| Project instructions | Both | `AGENTS.md`, `CLAUDE.md` and `.cursorrules` in the project root are added to the prompt. | [agent-loop.md](agent-loop.md#1-prompt-assembly) |
| Automatic matching (`SemanticMatcher`) | Both | Attaches the rules, skills, memories and reports that match a message, via `nomic-embed-text` embeddings or keyword overlap. | [agent-loop.md](agent-loop.md#matching-rules-skills-memory-and-reports) |
| `INGLE.md` index | Both | A short index of what the assistant can use; details load on demand. The Mac app writes `~/.ingle/INGLE.md` and keeps your notes at the bottom; VS Code builds the same index in memory. | [ingle-home.md](ingle-home.md#inglemd) |
| Memory with secret filter | Both | Plain Markdown facts about you in `~/.ingle/memory`; refuses anything that looks like a password, key or card number; optional "ask before saving". | [ingle-home.md](ingle-home.md#memory) · [security-and-privacy.md](security-and-privacy.md#memory-and-secrets) |
| Web search and fetch (read-only) | Both | `web_search` (DuckDuckGo, SearXNG or Brave) and `web_fetch`, per-chat **Web** switch, local network blocked. | [security-and-privacy.md](security-and-privacy.md#web-access) |
| Research reports | Both | After web research the assistant saves a short report in `~/.ingle/research` so it isn't redone. | [ingle-home.md](ingle-home.md#research-reports) |
| MCP servers | Both | stdio MCP servers from `~/.ingle/mcp.json` (plus Cursor and Claude Code configs), used via `mcp_tools` / `mcp_call` with approval; `/mcp` dialog. | [mac-app.md](mac-app.md#mcp-servers) · [vscode-extension.md](vscode-extension.md#mcp) |
| Sub-agents (`delegate`) | Both | Hands a self-contained job to a read-only helper with a fresh context, up to 10 steps. | [agent-loop.md](agent-loop.md#6-sub-agents) |
| **Built for small models** | | | |
| Per-turn tool selection | Both | Offers only the tools a message plausibly needs (keyword rules), because accuracy drops as the tool list grows. | [agent-loop.md](agent-loop.md#3-tool-selection) |
| Repeat-call guard and stuck detection | Both | The 3rd identical call is skipped with a note; after 4 skips the run stops and says so. | [agent-loop.md](agent-loop.md#4-the-loop-and-its-guards) |
| No small step cap | Both | Keeps going until done, stopped or stuck; 200 steps is only a backstop (VS Code: `ingle.maxSteps`, 0 = none). | [agent-loop.md](agent-loop.md#4-the-loop-and-its-guards) |
| **Integration** | | | |
| Settings mirror | Mac → VS Code | The Mac app writes `~/.ingle/settings.json` (0600) whenever a setting changes; the extension only reads it. | [architecture.md](architecture.md#the-settings-mirror) |
| Editor bridge | Both | VS Code tells the Mac app which project, file, selection and problems you have (`127.0.0.1:47123`, token in `~/.ingle/bridge-token`). | [architecture.md](architecture.md#the-editor-bridge) |
| Rider following | Mac | Reads JetBrains Rider's window title (Accessibility permission) to know the project and file. | [mac-app.md](mac-app.md#editor-context-vs-code-and-rider) |
| Menu bar app and Dock presence | Mac | Lives in the menu bar; shows in the Dock only while a window is open. | [mac-app.md](mac-app.md#menu-bar-models-and-power) |
| This Mac card | Mac | Live CPU, memory and GPU use in the sidebar. | [mac-app.md](mac-app.md#the-chat-window) |
| Launch at login | Mac | `SMAppService` toggle in Settings → General. | [mac-app.md](mac-app.md#settings) |
| About, Terms, Privacy, licences | Both | Mac: Settings → About opens the bundled legal files and Ollama's licences. VS Code: **Ingle: About / Terms of Use / Privacy Policy**. | [building-and-releasing.md](building-and-releasing.md#licence-and-legal-files) |
| **Project** | | | |
| Licence and contributions | — | PolyForm Noncommercial 1.0.0, contributor terms, DCO sign-off, issue and PR templates. | [building-and-releasing.md](building-and-releasing.md#licence-and-legal-files) |
| Release export | — | `scripts/export-release.sh` makes a clean copy and refuses if private words slipped in. | [building-and-releasing.md](building-and-releasing.md#making-a-clean-release-copy) |

See also [weaknesses-and-mitigations.md](weaknesses-and-mitigations.md) for what these features don't do yet, and
[roadmap.md](roadmap.md) for what's planned.
