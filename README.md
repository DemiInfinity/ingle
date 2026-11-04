# Ingle

**Your AI, kept at home.** A native Mac app and VS Code extension for running local AI models with
[Ollama](https://ollama.com) — private, offline-capable and free per message.

Ingle gives your local models names and personalities (by default **Ember** for everyday coding and
**Flint** for hard problems), a proper chat window, a coding panel in VS Code, and the tools to actually
get things done — while managing memory and power so a big model doesn't sit on your RAM all day.

## Features

**Mac app**
- **Menu bar** — see which model is awake, switch models, put them to sleep, watch CPU, memory and GPU.
  Models unload after a timer; Ingle warns before loading a big model on battery.
- **Built-in engine** — ships with Ollama inside, starts it when you chat, and updates it from Settings
  (with a notification when a new version is out). Uses your own Ollama instead if one is running.
- **Chat** — streaming replies, thinking, code highlighting, chat history, regenerate, speed stats.
- **Files and images** — attach code, PDFs, Word, Excel, Pages and images (HEIC too). Models that can't see
  images get the text read from them on-device.
- **Mac access** (per chat, off by default) — read files; with your approval run commands, write files, open apps.
- **Web research** (read-only) — search and read pages, save short research reports for later.
- **Memory** — facts about you in plain Markdown files you can read and edit.
- **Skills, rules and MCP** — Claude-style `SKILL.md` skills, always-on or matched rules, MCP servers;
  all listed in a small index (`~/.ingle/INGLE.md`) so the model loads details only when needed.
- **Commands** — rules Ingle *enforces*, not just suggests: "always use the figma MCP for component builds",
  "never use write_file", "always run the linter after editing". Required tools are always offered, banned ones
  are blocked, and the assistant can't finish until it has complied. Ask for one in a chat, or write
  `~/.ingle/commands/<name>.md` yourself (`when`, `must_use`, `never_use`, `then_run`).
- **Helpers** — hand a self-contained job to a read-only sub-agent.
- **Long chats** compact themselves; `/` opens commands and skills (`/compact`, `/mcp`, `/skill-reload`, …).
- **Your own characters** — rename any model and write its personality. Ingle always adds what every
  model needs to know about itself and its tools.

**VS Code extension** (`Extensions/vscode`)
- An Ingle chat as an editor tab, opened from the icon in the editor title bar — as many tabs as you like.
- Reads your project, searches code, sees problems, edits files (you approve each change, with a diff),
  runs commands, and gets a **repo map** of your project ranked for each request.
- Shares assistants, rules, skills and memory with the Mac app through `~/.ingle`, and works without it open.

## Requirements

- A Mac with Apple Silicon and macOS 14 or later.
- Memory: 16 GB runs small models; 32 GB+ is comfortable for the 30B-class models Ingle defaults to.
- To build: Swift (Xcode, or `xcode-select --install`). For the VS Code extension: Node 18+.

## Build and install

```zsh
git clone https://github.com/OWNER/ingle.git && cd ingle
./build.sh --install                   # builds Ingle.app with the Ollama engine and copies it to /Applications
cd Extensions/vscode && ./install.sh   # optional: the VS Code extension
```

Then open Ingle from the menu bar → Settings → Models to download models.
`INGLE_MLX=v3 ./build.sh` makes a smaller build that runs on macOS 14+ (see `build.sh`).

## Privacy

Everything runs on your Mac. Ingle talks to the internet only when you switch on **Web** in a chat (read-only:
no logins, forms or local-network addresses), when you download models, and to check for engine updates
(GitHub, once a day — you can turn that off).

## Where things live

| What | Where |
|---|---|
| Rules, skills, commands, memory, research, MCP servers, index | `~/.ingle/` |
| Chats and attached images | `~/Library/Application Support/Ingle/` |
| Updated engine | `~/Library/Application Support/Ingle/Engine/` |
| Models | `~/.ollama/models` |
| Engine log | `~/Library/Logs/Ingle/ollama.log` |
| Settings shared with VS Code | `~/.ingle/settings.json` (written by the app) |

None of this is inside the project folder, so building, updating or publishing the code never touches it.

## Developing

- `Sources/Ingle/` — the SwiftUI app. Start with `IngleApp.swift`, `ChatStore.swift` (the agent loop),
  `Tools.swift`, `Prefs.swift` (personas and the built-in instructions) and `EngineUpdater.swift`.
- `Extensions/vscode/src/` — `engine/` (Ollama client, prompts, agent loop), `tools/`, `ui/`, and `media/` (the webview).
- Personal build settings (your bundle identifier, extension publisher) go in `local.env` — see `local.env.example`.
- `scripts/export-release.sh` makes a clean copy for publishing and checks it for any words you list as private.

## Documentation and contributing

- [docs/](docs/README.md) — how everything works, file formats, building and releasing.
- [CONTRIBUTING.md](CONTRIBUTING.md) — setting up, style, checks and contributor terms.

## Licence

**Free for personal and other non-commercial use** under the [PolyForm Noncommercial License 1.0.0](LICENSE.md);
commercial use needs a separate licence. See [LICENSING.md](LICENSING.md) for what that means in plain words and
for the licences of the bundled Ollama engine.

[Terms of Use](TERMS.md) · [Privacy Policy](PRIVACY.md) — in short: no accounts, no tracking, nothing leaves your Mac
unless you switch on Web, download a model or update the engine.

## Credits

Ingle is built on [Ollama](https://ollama.com) — the open-source engine by the Ollama team, which in turn builds on
[llama.cpp](https://github.com/ggml-org/llama.cpp) and [MLX](https://github.com/ml-explore/mlx). Ingle wouldn't exist
without them.
