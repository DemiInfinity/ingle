# Weaknesses and mitigations

An honest list of where Ingle is weak, the evidence, what we've done about each, and what's left.
Status key: **Done** · **Partly** · **Not yet**.

Most of the evidence comes from a research review done while building Ingle (November 2026). Figures marked
*estimate* weren't measured on real hardware.

---

## 1. Local models are less reliable with tools than Claude, Copilot or Claude Code

**The problem.** People will compare Ingle with cloud assistants. A 4-bit, ~30B-class local model picks the wrong
tool, malforms calls, repeats itself and forgets instructions far more often than a frontier model. Three causes
are under our control:

- **Too many tools.** The [RAG-MCP study](https://arxiv.org/abs/2505.03275) found tool-selection accuracy fell from **about 85% with 5 tools to about 45%
  with 20** (source needed); offering only the relevant tools roughly tripled accuracy (13.6% → 43.1%) and halved prompt tokens
  ([arXiv:2505.03275](https://arxiv.org/abs/2505.03275)).
  Ingle originally offered about 25 tools on every turn.
- **The engine fighting the model.** Ollama issue [#14493](https://github.com/ollama/ollama/issues/14493) showed Qwen models being parsed with the wrong tool-call
  format, recommended penalties being silently ignored, and `<think>` tags leaking. Overriding the parser in a
  Modelfile took one user's tool-call success from **2/5 to 4/5**.
- **Silent context loss.** Ollama has historically defaulted to a tiny context and dropped the rest without
  warning; long contexts also cost tool accuracy.

**What we did**

| Mitigation | Where | Status |
|---|---|---|
| **Fewer tools per turn** — core tools for the switches that are on; optional groups (past chats, help, helpers, memory editing, MCP, documents, images, links) only when the message calls for them | `ToolSelection.swift`, `toolsFor` in `chatEngine.ts` | Done |
| **Recommended sampling** sent on every request (Qwen thinking / non-thinking values) instead of Ollama's defaults | `ModelTuning` in `Ollama.swift`, `tuning()` in `ollama.ts` | Done |
| **Explicit `num_ctx`** per assistant on every request; compaction at ~75% of it, then trimming old tool output — never silent truncation | `ChatStore.compact`/`fit`, `chatEngine.ts` | Done |
| **Repeat-call guard** — the 3rd identical call is skipped with a nudge; 4 skips stops the request as "stuck" | `ChatStore.generate`, `runLoop` | Done |
| **Commands (the obedience layer)** — required tools always offered, banned ones blocked, can't finish until requirements are met | [commands.md](commands.md) | Done |
| **Repo map** — a ranked outline of the project so the model finds code without blind file reads | `repomap.ts` | Done (VS Code) |
| **Suggestions, not pasted context** — matched skills/rules/research are offered as one-line hints the model opens if relevant; matching skips chatty messages and needs a clear winner | `SemanticMatcher.swift`, `matcher.ts` | Done |
| **Honest chips** — the reply only lists what the model actually used, so you can see when it ignored a skill | `usedNames` / `used` | Done |
| **Qwen tool-call format** — checked on Ollama 0.40.14: library Qwen models are fixed upstream (XML calls, `</think>` closed); GGUF imports like Ember's default arrive with no parser, so Ingle gives them the built-in `qwen3.5` renderer/parser after a pull. Parser drift ([#16383](https://github.com/ollama/ollama/issues/16383)) is still open | `ModelTuning.formatFix`, `fixFormatIfNeeded` in `Ollama.swift`; [engine.md](engine.md#qwen-tool-call-format) | Done |
| An in-app tool-call test to compare quantisations (e.g. IQ4_XS vs Q4_K_XL) | — | Not yet |
| Optional "bring your own API key" fallback for the hardest jobs | — | Not yet |

**Trade-offs.** Keyword-based tool filtering is cheap and predictable but can hide a tool the model needed; commands
and the "N allowed" flow give you a way to force tools back. There's no small step cap (local steps are free), so a
confused model could run long — the repeat guard and stuck stop are the safety net, with a 200-step backstop.

**What's left.** Even with all of this, a local model won't match a frontier model on long multi-file refactors or
vague debugging. That's a hardware/model limit, not something the harness can fully fix.

---

## 2. The download is big (the bundled engine was 581 MB)

**The problem.** Ingle ships Ollama inside the app so you don't need a separate install. Ollama's macOS build is a
universal bundle: Intel and Apple Silicon code, Intel-only CPU libraries, two copies of the MLX GPU library
(`mlx_metal_v3` and `mlx_metal_v4`), a quantize tool Ollama never calls, and Ollama's own app images.

**What we did**

| Mitigation | Where | Status |
|---|---|---|
| Strip files with no Apple Silicon code, `llama-quantize` and Ollama's images; thin every binary to arm64 (`lipo -thin`) and re-sign | `build.sh` | Done |
| Choose the MLX library: `INGLE_MLX=v3` (macOS 14+, about **220–230 MB** engine — *estimate*), `v4` (macOS 26.2+), `both` (default), `none` (~50 MB, no MLX models) | `build.sh` | Done |
| If the slimmed engine won't start, restore the full one automatically | `build.sh` | Done |
| Updated engines are slimmed the same way after download | `EngineUpdater.slim()` | Done |
| Download the engine on first launch instead of bundling it | — | Not yet |

**Trade-offs.** `v3` only gives up a possible Metal 4 speed-up on macOS 26 in exchange for roughly a 60% smaller engine.
Bundling at all costs size but means the app works out of the box.

---

## 3. Keeping a bundled engine up to date

**The problem.** Ollama releases often (several patch releases a week in mid-2026 — see [Ollama's releases](https://github.com/ollama/ollama/releases)), and new model families need new
versions. Security fixes matter too: [CVE-2026-7482](https://www.cve.org/CVERecord?id=CVE-2026-7482) ("Bleeding Llama", CVSS 9.1) affected Ollama before
[0.17.1](https://github.com/ollama/ollama/releases/tag/v0.17.1).
An app that pins an old engine inherits its bugs and holes.

**What we did**

| Mitigation | Where | Status |
|---|---|---|
| **In-app engine updates** — checks GitHub once a day, notifies once per version, Update / Roll Back / Use Built-in in Settings | `EngineUpdater.swift` | Done |
| Downloads are **checked against Ollama's published SHA-256** before install; staged, test-run, then swapped in; the previous engine is kept | `EngineUpdater.update()` | Done |
| If you run your own Ollama, Ingle uses it instead of starting a second engine | `OllamaServer.swift` | Done |
| The engine only listens on `127.0.0.1` | `OllamaServer.swift` | Done |
| Warn when the user's own Ollama is older than a known-vulnerable version | — | Not yet |
| CI that builds, tests and publishes new engine versions automatically | — | Not yet |
| Developer ID signing and notarisation (needed for a proper download and app self-update) | — | Not yet |

**Trade-offs.** Updating the engine separately from the app means a new Ollama can change behaviour without an Ingle
release; Roll Back exists for that reason.

---

## 4. Mac-only

**The problem.** The native app only reaches Mac users (roughly a third of professional developers in the 2025
Stack Overflow survey: Windows 49.5%, macOS 32.9%). VS Code, by contrast, is used by about 76% of developers
([Stack Overflow Developer Survey 2025, Technology](https://survey.stackoverflow.co/2025/technology)).

**What we did**

| Mitigation | Where | Status |
|---|---|---|
| The VS Code extension is TypeScript with **no runtime dependencies**, so most of it runs anywhere VS Code does | `Extensions/vscode` | Partly |
| Mac-only pieces are isolated and documented: document/image reading (`sips`, `textutil`, PDFKit, Vision OCR), `/bin/zsh` for commands, the engine path inside `Ingle.app` | `documents.ts`, `command.ts`, `server.ts` | Partly |
| Cross-platform replacements (pdf.js, mammoth, exceljs, tesseract.js), PowerShell/bash, engine detection via `OLLAMA_HOST` | — | Not yet |
| Publish to the VS Code Marketplace **and** Open VSX (Cursor, Windsurf, VSCodium) | — | Not yet |

**Trade-offs.** Staying native on the Mac is a strength (menu bar, power awareness, Vision OCR, AppleScript control);
a Windows/Linux desktop app is a much bigger job and only worth it if the extension shows demand.
See [roadmap.md](roadmap.md).

---

## 5. Small context windows

**The problem.** Local assistants typically run with 16–32K tokens of context, versus hundreds of thousands for cloud
models. Long chats and big tool outputs fill it fast.

**What we did:** compaction at ~75% with a dense summary (Mac app and VS Code), keeping the last turns word for word;
`fit()` trims old tool output before anything is lost; the context meter shows how full it is; prompts are short;
skills and research are suggested rather than pasted; the repo map is capped (~1,500 tokens).
**Status:** Done. **Trade-off:** summaries lose detail — the full messages stay visible to you above the
"Earlier messages summarised" divider.

---

## 6. Letting a model act on your machine

**The problem.** An assistant that runs commands, edits files and drives apps can do damage if it misunderstands —
or if a web page or file it reads tries to instruct it.

**What we did:** every command, file change, app action, MCP call and out-of-workspace read needs approval
(Deny / Allow for This Session / Allow); session allowances are narrow — the exact command in the same folder, writes
in one folder, the same app action, one MCP `server/tool` — end when the app quits and can be cleared any time;
Terminal and Mac control are separate, and Mac control is off by default per chat; web access is read-only and blocks
local-network addresses; models are told never to work around a denial; commands can ban tools outright.
**Status:** Done. **Trade-off:** approvals interrupt you; "Allow for This Session" is the escape hatch, scoped to the
same command, folder, target or MCP tool (it used to cover every later action of that kind). See [terminal-and-mac-control.md](terminal-and-mac-control.md) and
[security-and-privacy.md](security-and-privacy.md).

---

## 7. Hard to install for non-developers

**The problem.** Ingle installs from source with Swift tools, isn't signed, and its default models need about 32 GB
of memory.

**Status:** Not yet. Planned: a first-run model picker based on your Mac's memory, Developer ID signing and
notarisation, and a downloadable build. Until then the README marks Ingle as an **early preview**.
