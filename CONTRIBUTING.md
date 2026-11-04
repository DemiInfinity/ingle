# Contributing to Ingle

Thanks for wanting to help. Please read the [Code of Conduct](CODE_OF_CONDUCT.md). Ingle is a native Mac app and a VS Code extension for local AI models — see
[README.md](README.md) for what it does and [docs/](docs/README.md) for how it works inside.

## Before you start

- **Small fixes** (typos, clear bugs, docs): open a pull request straight away.
- **Bigger changes** (new features, new tools, changes to the agent loop or file formats in `~/.ingle`): open an
  issue first to agree the approach. File formats are shared by both apps and by users' own files, so changes
  there need care.
- Check [docs/roadmap.md](docs/roadmap.md) — your idea may already be planned or have notes.

## Setting up

You need a Mac with Apple Silicon, macOS 14+, Swift (Xcode or `xcode-select --install`) and, for the extension, Node 18+.

```zsh
# Fork the repo on GitHub first (the Fork button), then:
git clone https://github.com/YOUR-NAME/ingle.git && cd ingle
git remote add upstream https://github.com/DemiInfinity/ingle.git
cp local.env.example local.env      # optional: your own bundle id, publisher, private words
./build.sh                          # builds into ./build and opens it (add --install to copy to /Applications)
cd Extensions/vscode && npm install && npm run compile   # or ./install.sh to package and install
```

Use your own bundle identifier in `local.env` while developing so your test builds don't mix with a released Ingle.

## How the code is organised

| Area | Where | Read first |
|---|---|---|
| Mac app | `Sources/Ingle/` | [docs/mac-app.md](docs/mac-app.md) |
| The agent loop (prompts, tools, compaction, commands) | `ChatStore.swift`, `Tools.swift`, `Commands.swift`; `Extensions/vscode/src/engine/` | [docs/agent-loop.md](docs/agent-loop.md) |
| VS Code extension | `Extensions/vscode/src/`, `media/` | [docs/vscode-extension.md](docs/vscode-extension.md) |
| Shared files in `~/.ingle` | both apps | [docs/ingle-home.md](docs/ingle-home.md) |
| Bundled engine and updates | `build.sh`, `OllamaServer.swift`, `EngineUpdater.swift` | [docs/engine.md](docs/engine.md) |

Features usually exist on both sides. If you change behaviour in one app, change the other to match (or say in
your pull request why it shouldn't).

## Style

- **Swift**: SwiftUI, macOS 14 APIs, Swift 5 language mode. Keep views small. The compiler struggles with long
  expressions — split big string or arithmetic expressions into `let` steps with explicit types, and don't put
  `await` inside `||`, `&&`, `??` or `where` clauses.
- **TypeScript**: strict mode, no runtime npm dependencies (Node and VS Code APIs only). `tsc --noEmit` must pass.
- **Webview** (`media/chat.js`): plain JavaScript, no frameworks or CDNs; escape all text before inserting HTML.
- **Words**: British English in the UI and in prompts. Write UI text for a non-technical reader: short, plain,
  and saying what happens ("Ember wants to run a command"), not how.
- **Prompts for the models** are part of the product: keep them short (local models have small context windows),
  concrete, and consistent between the Mac app and the extension.
- **Safety**: anything that changes files, runs commands, calls MCP tools or sends data off the Mac must go
  through an approval. Web access stays read-only. Don't weaken these without discussion.

## Checking your change

There's no automated test suite yet (help welcome). Before opening a pull request:

- [ ] `./build.sh` succeeds with no new warnings you introduced.
- [ ] `cd Extensions/vscode && node node_modules/typescript/bin/tsc -p . --noEmit` passes, and `node --check media/chat.js`.
- [ ] You tried it: a chat that uses tools, an approval (allow and deny), and anything your change touches.
- [ ] Both apps still read files in `~/.ingle` written by the other.
- [ ] Docs in `docs/` and the in-app help (`HelpTopics` in `Sources/Ingle/Manifest.swift`) are updated if behaviour changed —
      the assistants read that help to answer questions about Ingle, so it must stay accurate.

## The fork-and-pull-request workflow

1. **Fork** the repository on GitHub and clone your fork (above).
2. **Branch** from an up-to-date `main`:
   ```zsh
   git fetch upstream && git checkout -b my-change upstream/main
   ```
3. **Commit** your work in small, clear steps (`git commit -s -m "Explain what changed"`).
4. **Push** to your fork: `git push -u origin my-change`.
5. **Open a pull request** from your branch to `DemiInfinity/ingle:main`. The template asks how you checked it.
6. **Review** — expect questions or small requests; push more commits to the same branch to update the PR.
7. **Merge** — once it's approved, the maintainer merges it. Thank you!

Keep your fork current with `git fetch upstream && git rebase upstream/main` before starting new work.

## Pull requests

- One topic per pull request, with a short description of what and why, and screenshots for UI changes.
- Sign off each commit (`git commit -s`) to confirm you wrote it or have the right to submit it
  ([Developer Certificate of Origin](https://developercertificate.org/)).

## Contributor terms

Ingle is licensed for non-commercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE.md), and the
copyright holder may also offer it under separate commercial licences. So that contributions can be included
under both, by submitting a contribution you agree that:

1. You wrote it, or otherwise have the right to submit it under these terms.
2. You grant the copyright holder named in [LICENSE.md](LICENSE.md), and anyone who receives Ingle from them,
   a perpetual, worldwide, non-exclusive, royalty-free, irrevocable licence to use, copy, modify, distribute
   and sublicense your contribution, including under commercial licences.
3. You keep the copyright in your contribution, and you can still use it however you like.

If you can't agree to this (for example, your employer owns your work), say so in the pull request before it's merged.

## Reporting problems

Open an issue with your macOS version, Mac model (chip and memory), the Ingle and engine versions
(Settings → General), the model you were using, and the steps to reproduce. The engine log is at
`~/Library/Logs/Ingle/ollama.log`. **Don't paste chats or files that contain personal information.**
For security problems, please don't open a public issue — contact the maintainer privately first.
