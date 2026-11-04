# Building and releasing

Ingle has no signed download yet, so everyone builds it from source. This page covers building both apps, personal
build settings, making a clean release copy, and how changes get in.

## Prerequisites

| | Needed for |
|---|---|
| Apple Silicon Mac, macOS 14 or later | Both (the Mac app only runs on Apple Silicon) |
| Swift toolchain (`xcode-select --install`, or Xcode) | Mac app |
| Node.js 18+ and npm | VS Code extension |
| VS Code 1.85 or later | VS Code extension |
| About 32 GB of memory | The default models (smaller models work on less; see [engine.md](engine.md)) |

## The Mac app

```zsh
./build.sh              # build into ./build/Ingle.app and open it
./build.sh --install    # also copy it to /Applications and open it from there
```

What [`../build.sh`](../build.sh) does:

1. `swift build -c release`, then assembles `Ingle.app` with `Support/Info.plist`, the app icon (generated with
   `sips` and `iconutil`) and the legal documents in `Resources/Legal` (opened from Settings → About).
2. **Adds the Ollama engine** to `Contents/Resources/OllamaRuntime`, taking it from (in order) an installed
   `/Applications/Ollama.app`, the saved copy in `~/.local/share/ingle-runtime`, or the latest release on GitHub.
   It keeps a copy in `~/.local/share/ingle-runtime` so rebuilding works after you remove the Ollama app, and saves
   Ollama's MIT licence next to it.
3. **Slims the engine** for Apple Silicon (details in [engine.md](engine.md)). Choose the MLX library with
   `INGLE_MLX`:

   ```zsh
   INGLE_MLX=v3 ./build.sh    # both (default) | v3 (smallest that keeps MLX models — use for releases) | v4 | none
   ```

   If the slimmed engine won't start, the full one is restored automatically.
4. Ad-hoc signs the app (there's no Developer ID yet).
5. With `--install`: quits a running Ingle and the separate Ollama app, copies to `/Applications`, links
   `~/.local/bin/ollama` to Ingle's engine so the `ollama` command keeps working, and opens Ingle.

The first launch of an ad-hoc-signed app may need **right-click → Open**. macOS asks for Accessibility, Automation or
Screen Recording only when you first use Mac control (see [terminal-and-mac-control.md](terminal-and-mac-control.md)).

## The VS Code extension

```zsh
cd Extensions/vscode
./install.sh
```

[`../Extensions/vscode/install.sh`](../Extensions/vscode/install.sh) installs dev dependencies, compiles the
TypeScript, copies the terms, privacy policy and licence into the package, packages `ingle.vsix` with `vsce`, finds
VS Code's `code` command (on the `PATH`, in `/Applications` or `~/Applications`, or via Spotlight) and installs it.
It also removes the old `ingle-bridge` extension if present.

Checks without installing:

```zsh
cd Extensions/vscode && node node_modules/typescript/bin/tsc -p . --noEmit   # type-check
node --check Extensions/vscode/media/chat.js                                 # webview syntax
cd Extensions/vscode && npm test                                            # unit tests (offline)
```

The extension has **no runtime dependencies**; keep it that way.

## Personal build settings: `local.env`

Settings that are yours alone go in `local.env` at the repo root. It's git-ignored; copy
[`../local.env.example`](../local.env.example) to start.

| Variable | Used by | Why |
|---|---|---|
| `INGLE_BUNDLE_ID` | `build.sh` | Keep the bundle identifier you've always built with. macOS ties settings, permissions and launch-at-login to it; changing it makes a "new" app. Default: `app.ingle.mac`. |
| `VSCODE_PUBLISHER` | `install.sh` | Keep your old publisher name so VS Code treats your build as the same extension and keeps your chat history. `package.json` is restored afterwards. |
| `VSCODE_APP` | `install.sh` | Where VS Code lives if it's somewhere unusual. |
| `PRIVATE_WORDS` | `export-release.sh` | A regex of names, paths and emails that must never appear in a public release. |

Anything else personal (notes, drafts) goes in `private/`, which is also git-ignored.

## Making a clean release copy

```zsh
scripts/export-release.sh [destination]    # default: ../Ingle-release
```

[`../scripts/export-release.sh`](../scripts/export-release.sh) copies the source, `Support`, the extension sources,
`docs` and legal files, and leaves out build output, `node_modules`, `local.env` and `private/`. Nothing from
`~/.ingle` or `~/Library` is ever in the repo, so chats, memory, skills and settings stay yours. It then:

- warns about placeholders that still need filling in;
- **refuses** if anything matching `PRIVATE_WORDS` is found (except in `LICENSE.md`, where the copyright holder's name
  belongs).

Run it before publishing anywhere new, even if you think the repo is clean.

## Versioning

- Mac app: `CFBundleShortVersionString` / `CFBundleVersion` in [`../Support/Info.plist`](../Support/Info.plist).
- Extension: `version` in [`../Extensions/vscode/package.json`](../Extensions/vscode/package.json), shown at the bottom
  of the chat ("Ingle for VS Code X").
- Both are early preview. Bump the minor version for features and the patch version for fixes, and say what changed
  in the pull request.

## Contributing changes

Fork, branch, change, open a pull request. The full guide is [../CONTRIBUTING.md](../CONTRIBUTING.md); in short:

- Read [../CLAUDE.md](../CLAUDE.md) first, especially the **Swift pitfalls** — Swift can't be compiled on Linux, and
  those patterns have broken the build before.
- Build both apps and type-check the extension before opening a PR.
- If you change behaviour, update the prompt facts (`Persona.systemPrompt` and `personaPrompt`), `HelpTopics` and
  `docs/` in the same PR.
- Sign off commits (`git commit -s`). Contributions fall under the contributor terms in `CONTRIBUTING.md`.
- Never commit `local.env`, `private/`, build output or personal data.

## Signing, notarisation and downloads (not yet)

Planned in [roadmap.md](roadmap.md): Developer ID signing, notarisation, a downloadable `.dmg`, app self-update, and
publishing the extension to the VS Code Marketplace and Open VSX. Until then, the engine updates itself
(see [engine.md](engine.md)) but the app and extension update by pulling and rebuilding:

```zsh
git pull && ./build.sh --install && (cd Extensions/vscode && ./install.sh)
```

## Trade-offs

| We chose | We gave up | Why |
|---|---|---|
| Build from source | One-click install | Signing and notarisation need a paid Developer ID; source builds keep the preview honest and inspectable. |
| Bundling the engine | A small download | Works out of the box with a known engine; slimming claws most of the size back. |
| `local.env` for personal settings | One config for everyone | Lets the maintainer keep a long-standing bundle ID and publisher without leaking them into the public repo. |
| A private-word scan | Convenience | A cheap safety net against publishing names, paths or emails by accident. |
