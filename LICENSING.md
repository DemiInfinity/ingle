# Licensing

Ingle is **source-available** under the [PolyForm Noncommercial License 1.0.0](LICENSE.md).
In plain words (the licence text is what actually counts):

| You may | You may not, without a separate licence |
|---|---|
| Use Ingle for yourself — personal projects, learning, hobby work | Sell Ingle, or a product or service built on it |
| Read, build and change the code | Use it inside a business for commercial work |
| Share it, or your changed version, with others **for non-commercial use**, keeping the licence and the Required Notice line | Remove the licence or the Required Notice |
| Use it at charities, schools, public research and government bodies (the licence explicitly allows these) | Offer it as a paid or ad-supported service |

Because commercial use isn't allowed, Ingle is not "open source" by the Open Source Initiative's definition —
it's free to use and modify for non-commercial purposes, with the code fully visible.

**Commercial use:** if you'd like to use Ingle commercially, open an issue titled "Commercial licence" or
contact the copyright holder named in [LICENSE.md](LICENSE.md) to arrange a commercial licence.

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
which let the project keep offering Ingle under both the non-commercial licence and separate commercial licences.

*This page explains the licence; it isn't legal advice.*
