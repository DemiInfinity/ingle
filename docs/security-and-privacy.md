# Security and privacy

Ingle runs models on your own Mac, has no accounts, no servers, no analytics and no telemetry. This page explains,
for contributors and careful users, exactly what leaves the Mac and when, what stops the assistant doing harm, and
where the limits are. The user-facing summary is [../PRIVACY.md](../PRIVACY.md); the legal terms are
[../TERMS.md](../TERMS.md).

## What leaves your Mac, and when

| When | What is sent | To | Code |
|---|---|---|---|
| **Web is on** in a chat and the assistant searches | The search words | DuckDuckGo (default), your SearXNG server, or Brave Search (with your key) | `WebTools.search`, [`web.ts`](../Extensions/vscode/src/tools/web.ts) |
| **Web is on** and the assistant reads a page | A plain GET (no cookies, no logins, browser-like user agent) | That website | `WebTools.fetch`, `web_fetch` |
| You **download a model** | A pull request for that model | Ollama's registry or Hugging Face (via the engine) | `OllamaClient.pull` |
| **Engine update check** (daily; can be turned off) | A request for the latest release | `api.github.com` | `EngineUpdater.check` |
| You **update the engine** | Downloads of the release and its checksum file | GitHub | `EngineUpdater.update` |
| **Building** Ingle (`build.sh`) | Downloads of Ollama's release (if not cached) and its licence | GitHub | [`../build.sh`](../build.sh) |
| You **approve** a command, MCP call or link | Whatever that command, server or website does | Wherever it talks to | approval card |
| You **approve** an SSH command (SSH on, host ticked) | That command, over your own SSH setup (keys or ssh-agent; never a password) | Only that host from `~/.ssh/config` | `SSH.run`, approval card |
| The **server address** points at another computer | Your prompts, including file contents the model reads | That computer | `Prefs.serverURL` |

Nothing else: no crash reports, usage statistics, identifiers or "phone home". **Contributors:** don't add a new
network connection without updating [../PRIVACY.md](../PRIVACY.md) in the same pull request ([../CLAUDE.md](../CLAUDE.md)).

Like any website visit, sites and search engines see your IP address. MCP servers are separate programs that may
talk to the network on their own.

## Approvals

Every action that changes something, runs code, controls an app, uses an MCP tool or reads outside your workspace
folders goes through an approval card showing the exact detail. Session allowances ("Allow for This Session") are
narrow — the exact command in the same folder, writes in the same folder, the same app, link or script, the same MCP
`server/tool`, the same command on the same SSH host — and the card says what they cover. They are kept in memory only and cleared on quit or with one click. Full rules:
[terminal-and-mac-control.md](terminal-and-mac-control.md#approvals).

**Approving is the trust boundary.** Ingle shows you exactly what will happen; it can't judge whether a command is
safe. Local models make mistakes, and text the model reads (web pages, files, MCP results) can contain instructions
meant to mislead it (prompt injection). Read the card before pressing Allow. A session allowance for one command
doesn't allow any other command, but a folder allowance for writes covers every file in that folder.

## Web access

The web tools are **read-only** by design: GET requests only, no cookies, no credentials, no forms, no JavaScript.
The system prompt also tells models that web pages are untrusted data, never to follow instructions in them, and
never to put your personal details, memories or file contents into a URL or search.

**Private-host blocking** stops a web page from pointing the assistant at your router, NAS or homelab:

| Check | Mac (`WebTools.isPrivate`) | VS Code (`isPrivateHost`, `isPrivateAddress`) |
|---|---|---|
| Names | `localhost`, `*.local`, `*.lan`, `*.internal`, `*.home`, `*.ts.net`, names without a dot | same |
| IPv4 ranges | 10/8, 127/8, 0/8, 169.254/16, 192.168/16, 172.16/12, 100.64/10 (CGNAT, Tailscale) | same |
| IPv6 | any literal IPv6 address is refused | any literal IPv6 address is refused; resolved addresses are checked for loopback, link-local, unique-local and IPv4-mapped private ranges |
| **DNS answer** | not checked | **checked**: every resolved address must be public (the check and the request resolve separately, so a fast-changing DNS answer could still slip through) |
| Links with passwords | allowed | refused |
| **Redirects** | followed automatically; refused if the **final** host is private (the request to it has already been made, but nothing is returned) | followed manually (up to 5 hops), **each hop checked before** it's requested |
| Size and type | ≤ 4 MB, PDFs refused, text truncated at 20,000 characters | similar |

The Mac app's weaker checks (no DNS check, automatic redirects) mean a public name that resolves to a private
address, or a redirect chain, can reach a local device with a GET request. Porting the extension's approach is an
open item ([weaknesses-and-mitigations.md](weaknesses-and-mitigations.md#6-safety-of-letting-a-model-act-on-your-machine)).

## Memory and secrets

- Memory is plain Markdown in `~/.ingle/memory` that you can read, edit or delete; **Forget Everything** wipes it;
  memory can be switched off or set to **Ask before saving** (Settings → Web & Memory).
- **Secret filter** (`MemoryStore.looksSecret`, `looksSecret` in
  [`frontmatter.ts`](../Extensions/vscode/src/tools/frontmatter.ts)): `memory_save` and `memory_rewrite` refuse text
  containing "password", "passcode", "pin code", "api key", "secret key", "private key" or "token:", or a run of
  13–19 digits after removing spaces and dashes (card numbers).
- **Limits:** it's a heuristic. It won't recognise a bare API key such as `sk-…` or `ghp_…` without one of those
  words, an IBAN or a short PIN. The prompt also tells models never to save passwords, keys, card or bank numbers.
  Research reports and skills have no filter.

## MCP servers and commands

- MCP servers are programs **you** configure; Ingle starts them with your user's permissions and environment. Only
  stdio servers are supported. Every `mcp_call` is approved, showing the server, tool and JSON arguments; `mcp_tools`
  (listing a server's tools) isn't, but it does start the server.
- Servers configured for Cursor (`~/.cursor/mcp.json`) and Claude Code (`~/.claude.json`) are picked up too —
  review those files if you don't want Ingle to see them, or switch servers off in Settings → Extensions.
- Creating a skill, rule or command always needs approval; the card shows the exact file. Commands can make the
  assistant *use* tools more, but each tool call is still approved as usual.
- Project files are trusted as instructions: `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `<project>/.ingle/rules` and
  `<project>/.ingle/commands` from any project you open are added to the prompt. Be careful with projects you didn't
  write.

## The editor bridge

- Listens on **127.0.0.1:47123**, loopback interface only (`NWParameters.requiredInterfaceType = .loopback`).
- Every request must carry `X-Ingle-Token` equal to `~/.ingle/bridge-token` — 64 random hex characters (two UUIDs),
  file mode `0600`. Requests without it get `401`.
- It accepts only editor context and "ask" requests (text and a selection to start a new chat). It can't run tools
  or approve anything.
- **Limits:** any process running as you can read the token. The comparison isn't constant-time (low risk on
  loopback). Requests are capped at 2 MB.

## Settings file

`~/.ingle/settings.json` can contain your Brave Search key, so it's written with mode `0600`. It also contains your
full name (from macOS) so the assistant can address you.

## Engine and update verification

- The bundled engine is started with `OLLAMA_HOST=127.0.0.1:<port>`, so it isn't reachable from the network.
- Engine updates come from Ollama's GitHub releases over HTTPS and are checked against the release's published
  `sha256sum.txt` before being unpacked; the new engine must start (`ollama -v`) before it replaces the old one,
  and the previous engine is kept for **Roll Back**.
- **Limits:** if a release has no checksum file, the update installs unverified; the checksum comes from the same
  release as the download, so it protects against corruption and tampering in transit or at the CDN, not against a
  compromised release. Keeping Ollama current matters: old versions have had serious flaws (for example
  CVE-2026-7482, "Bleeding Llama", CVSS 9.1, memory disclosure via a crafted GGUF on `/api/create`, fixed in 0.17.1).

## Code signing

During the early preview Ingle is **ad-hoc signed** (`codesign --sign -`) by `build.sh`, including every binary in the
slimmed engine. That means:

- no Developer ID, no notarisation, no hardened runtime — macOS Gatekeeper treats it as an app you built yourself;
- macOS privacy permissions (Automation, Accessibility, Screen Recording) are tied to the bundle identifier and the
  ad-hoc signature, so they may need re-granting after a rebuild;
- engine updates are not re-signed.

Developer ID signing and notarisation are the first step of the release plan
([building-and-releasing.md](building-and-releasing.md#future-signing-notarisation-and-sparkle)).

## Threats and limits

| Threat | What helps | What doesn't (yet) |
|---|---|---|
| A confused or misled model runs a harmful command or edits the wrong file | Approval cards with exact detail; diffs in VS Code; Undo for VS Code edits; Mac control off by default; prompts forbid `sudo`, deletes and system changes unless asked | A session allowance skips the card for that exact scope; no sandbox; no per-command allow-list; no checkpoints/rewind on the Mac ([roadmap.md](roadmap.md#checkpoints-and-rewind)) |
| Prompt injection from web pages, files, MCP results or project files | Read-only web; untrusted-data warnings in prompts; approvals on every action | Models can still be persuaded to *ask* for harmful actions; project instruction files are trusted |
| Exfiltration of your data through the web | No cookies or logins; prompt forbids putting personal data in URLs; local network blocked | A model could still put text into a search query or URL; web reads don't need approval when Web is on — switch Web off for sensitive work |
| A model running commands on your servers | SSH off by default; only hosts you tick from `~/.ssh/config`; raw addresses refused; `BatchMode` (no passwords) and strict host keys; every command asks and the card names the host | Anything an approved command does on that server; agent forwarding or other options set in your own `~/.ssh/config` still apply |
| Reaching devices on your network | Private-host blocking (VS Code also checks DNS and every redirect) | Mac app: DNS-based and redirect-based bypasses |
| Other local apps abusing Ingle | Loopback-only bridge with a `0600` token; engine bound to 127.0.0.1 | Anything running as you can read `~/.ingle` and talk to Ollama on port 11434 |
| A malicious or vulnerable engine | Updates from Ollama's GitHub with checksum, staging and roll back | No independent signature; no CI smoke tests; unverified install when no checksum file |
| Secrets saved to memory | Keyword and card-number filter; ask-first option | Bare tokens without keywords |
| Tampered app | — | Ad-hoc signing only |

**Reporting a security problem:** don't open a public issue — contact the maintainer privately first
([../CONTRIBUTING.md](../CONTRIBUTING.md#reporting-problems)).

## Trade-offs

| We chose | We gave up | Why |
|---|---|---|
| **Approvals, not a sandbox** | OS-level containment of what the model can touch | An App Sandbox would block the very things Ingle is for (your projects, Terminal, AppleScript). Approvals keep you in the loop with the exact detail; the cost is that a careless Allow is still an Allow. |
| **Read-only web without approval** when Web is on | Per-request consent | Research needs dozens of fetches; per-fetch cards would be unusable. Web is a visible per-chat switch instead. |
| **Session-wide allowances** | Least privilege | Reduces approval fatigue on long tasks; memory-only, badged and one click to clear. |
| **Heuristic secret filter** | Catching every secret | Simple, predictable and identical in both apps; it stops the common cases ("my password is…", card numbers) without false confidence elsewhere. |
| **Checksum-verified updates from GitHub** | Signed, CI-tested engine builds | Works today without a Developer ID or CI; roll back covers bad releases. |
| **Ad-hoc signing during preview** | Gatekeeper-friendly downloads, stable permissions | A Developer ID costs money and needs a release pipeline; the preview installs from source. |
| **Trusting project instruction files** | Protection from hostile repositories | `AGENTS.md`/`CLAUDE.md` conventions are how projects tell assistants their rules; approvals still gate every action. |
