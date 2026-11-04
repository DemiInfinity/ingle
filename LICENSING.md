# Licensing

Ingle is **open source** under the [GNU Affero General Public License, version 3](LICENSE) (AGPL-3.0-only), with
one additional term: **you must credit the author**. The exact terms are in [LICENSE.md](LICENSE.md). In plain
words (the licence text is what actually counts):

| You may | On these conditions |
|---|---|
| Use Ingle for anything: personal, education, **commercial** | Keep the credit (below) |
| Read, build, change and improve the code | If you share or sell your changed version, or run it as a service for others, **publish your changes under the same licence** |
| Build your own product or service on Ingle, and charge for it | Keep the credit **visible to your users**, and share your changes under the AGPL |
| Redistribute Ingle or your version | Include the licence, `LICENSE.md` and the `NOTICE` file |

**The credit.** Every copy and every work based on Ingle must keep this notice, in the source (a `NOTICE` or `README`
file) **and where users can see it** in the running program (an About screen, credits page, settings, or
`--version`):

> Based on Ingle by DemiInfinity — https://github.com/DemiInfinity/ingle

You can add to it ("…, modified by Acme"), but not remove or hide it.

**If you don't want to credit or share, pay instead.** To remove the credit, or to keep your changes private, you need
a **commercial licence**. Open an issue titled "Commercial licence" at https://github.com/DemiInfinity/ingle to ask.

**Earlier versions.** Versions published before 4 November 2026 were under the PolyForm Noncommercial License 1.0.0,
and copies of those stay under it.

## Third-party components

Ingle.app ships with the [Ollama](https://github.com/ollama/ollama) engine, which has its own licences.
These are **not** changed by Ingle's licence and stay under their own terms:

| Component | Licence | Where its licence is |
|---|---|---|
| Ollama | MIT | `Ingle.app/Contents/Resources/OllamaRuntime/LICENSE-ollama.txt` |
| llama.cpp (inside Ollama) | MIT | `OllamaRuntime/LLAMA_CPP_LICENSE`, `LLAMA_CPP_VENDORS_LICENSE` |
| MLX (inside Ollama) | MIT | `OllamaRuntime/MLX_C_LICENSE` and the MLX folders |
| Other bundled parts (Go runtime, JSON, fmt, cpp-httplib, xgrammar, …) | Their own (MIT, BSD, Apache-2.0) | the other `*_LICENSE` files in `OllamaRuntime/` |

`build.sh` copies these licence files into the app; don't remove them when slimming the engine.
Models you download are licensed by their makers (see each model's page) — Ingle doesn't ship any.

The VS Code extension has no runtime dependencies; its build tools (TypeScript, `@vscode/vsce`) are only used
to compile it.

## Contributions

By contributing you agree to the contributor terms in [CONTRIBUTING.md](CONTRIBUTING.md#contributor-terms),
which let the project keep offering Ingle under both the AGPL (with the attribution term) and separate commercial licences.

*This page explains the licence; it isn't legal advice.*
