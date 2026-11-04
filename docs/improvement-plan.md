# Improvement plan

A working to-do list for the next round of work, written so each task can be handed to an agent (or a contributor)
on its own. [roadmap.md](roadmap.md) is the long-term direction; this file is the next concrete steps.

**How to use it.** Tasks are grouped into **waves**. Tasks in the same wave touch different files and can run at the
same time, each in its own worktree/branch. A wave starts once the tasks it depends on have merged. Tick a task off
(`[x]`) when its branch is merged into `main`.

**Rules for every task** (include these when you brief an agent):

- Read [../CLAUDE.md](../CLAUDE.md) first. British English, short UI text, short prompts.
- Keep the two apps consistent. If behaviour changes, update `Persona.systemPrompt` (Swift) **and** `personaPrompt`
  (`prompt.ts`), `HelpTopics` in `Manifest.swift`, and the matching page in `docs/`.
- Checks before finishing: `./build.sh` (Mac app), `cd Extensions/vscode && node node_modules/typescript/bin/tsc -p . --noEmit`,
  `node --check Extensions/vscode/media/chat.js`, plus any tests the task adds.
- Codable structs: new stored properties are optional. Follow the Swift pitfalls in `CLAUDE.md`.
- Commit with `git commit -s` on your own branch. Don't push, don't merge, don't touch `local.env` or `private/`.
- Finish with a short report: what changed, what was checked, what wasn't.

---

## Wave 1 — safety, tests, tidy-up (all in parallel)

### [ ] 1. Narrow "Allow for This Session"
**Why.** Session allowances are keyed by tool name only (`ChatStore.resolve`, `chatEngine.ts` `approve`). Allowing
one `run_command` silently allows every later command (`rm -rf`, `curl … | sh`) in every chat until the app quits.
With Web on, a page that tries to instruct the model could take advantage of this.
**Do.**
- Key allowances on an **approval scope** instead of a bare tool name:
  - `run_command` → the exact command text + working folder;
  - `write_file` / `edit_file` → the folder of the file;
  - `open`, `applescript` → the exact target / script;
  - MCP calls → `server/tool`;
  - out-of-workspace reads → the folder;
  - `ssh_command` (task 6/7) → host + exact command.
- One helper per app to build the scope (`MacTools.approvalScope(_:)`, `approvalScope()` in `chatEngine.ts`), so new
  tools must choose one.
- The approval card says what "Allow for This Session" covers (e.g. "Allow `npm test` in Ingle for this session").
**Files.** `Sources/Ingle/ChatStore.swift` (approvals section only), `Sources/Ingle/Tools.swift`,
`Sources/Ingle/MessageViews.swift` (approval card), `Extensions/vscode/src/engine/chatEngine.ts` (approvals only),
`Extensions/vscode/media/chat.js`, `docs/terminal-and-mac-control.md`, `docs/security-and-privacy.md`,
`docs/weaknesses-and-mitigations.md` §6.
**Done when.** Allowing one command doesn't allow a different one; both apps behave the same; the docs describe the
new scope.

### [ ] 2. Test suite for the VS Code extension
**Why.** There are no tests, so the two apps drift apart and changes break quietly.
**Do.** Use Node's built-in `node:test` and `assert`. No new runtime deps; dev-only is fine but avoid it if you can.
Compile the tests with the existing `tsc`. Cover the pure logic: command parsing and matching (`tools/commands.ts`),
`frontmatter.ts`, `editmatch.ts`, `capOutput` in `command.ts`, matcher scoring (`engine/matcher.ts`) and tool
filtering. If tool filtering is buried in `ChatEngine.toolsFor`, extract the pure part into a small module first.
Add `npm test` to `package.json` and mention it in `CLAUDE.md` → "Build and check".
**Files.** `Extensions/vscode/test/**` (new), `Extensions/vscode/package.json`, `Extensions/vscode/tsconfig*.json`,
plus small extractions from `engine/chatEngine.ts` **only in `toolsFor`** (tell task 1 if you touch it).
**Done when.** `npm test` runs offline and passes, with at least 30 meaningful assertions.

### [ ] 3. Docs and README tidy-up
**Do.** Remove "from the icon next to Claude's" from the README (it only makes sense on one machine). Add source links
for the specific claims in `weaknesses-and-mitigations.md` (RAG-MCP study, Ollama issue #14493, CVE-2026-7482, Stack
Overflow survey). Lead the README features with **Commands**, the clearest difference from other local chat apps.
**Files.** `README.md`, `docs/weaknesses-and-mitigations.md`.
**Done when.** Every number or CVE has a link, and nothing in the README depends on one person's setup.

### [ ] 4. Check the Qwen tool-call parser
**Why.** Ollama has parsed Qwen tool calls in the wrong format (issue #14493); overriding `PARSER`/`RENDERER` roughly
doubled one user's success rate.
**Do.** Check whether the bundled engine version still has the problem for the default Ember/Flint models. If it
does, add an optional per-model Modelfile override that Ingle applies when it creates or pulls the model, and record the
result in `weaknesses-and-mitigations.md` §1.
**Files.** `Sources/Ingle/Ollama.swift` (`ModelTuning`), `Sources/Ingle/ModelManager.swift`,
`Extensions/vscode/src/engine/ollama.ts` (`tuning()`), `docs/engine.md`.
**Done when.** There's a written answer ("still broken in 0.x, fixed by …" or "fixed upstream in 0.x") and, if needed,
the override.

### [ ] 5. Research: VS Code Remote-SSH and dev containers (read-only)
**Why.** When a workspace is opened over Remote-SSH, VS Code may run the extension **on the remote machine**, where
`localhost:11434`, `~/.ingle` and the macOS-only tools don't exist.
**Do.** Find out which side the extension runs on (check `extensionKind` in `package.json` and the VS Code docs) and
what breaks. Recommend a fix (probably `"extensionKind": ["ui"]`, plus file access through the VS Code workspace
API). Write it up in `docs/vscode-extension.md` under a new "Remote workspaces" heading. No code changes.
**Done when.** The doc section exists and says exactly what to change.

---

## Wave 2 — SSH access (after task 1 merges; 6 and 7 in parallel)

Ingle can already run local commands. SSH access lets an assistant run commands on **your own servers**: a home
server, a NAS, a dev box, a Raspberry Pi.

### Shared design (both tasks follow this exactly)

- **New tool `ssh_command`**: `{ host: string, command: string, cwd?: string }`. Description: *"Run a shell command on
  one of the user's SSH hosts and return its output. The user must approve."*
- **Hosts come from the user, never the model.** Only aliases that are **both** a `Host` entry in `~/.ssh/config`
  (no wildcards) **and** switched on in Ingle's settings. Any other host is refused with "That host isn't set up for
  Ingle. Add it in Settings → Mac Access → SSH." Raw `user@ip` addresses aren't accepted.
- **Runs the system client**: `/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes -T
  <alias> -- <command>` (with `cd <cwd> &&` added before the command, shell-quoted, when `cwd` is given).
  `BatchMode` means keys or ssh-agent only: **Ingle never asks for, stores or types passwords**. An unknown or
  changed host key fails safely; the message tells the user to connect once in Terminal first.
- **Same limits as `run_command`**: 120-second timeout, output trimmed to the start and end (`capOutput`), ANSI codes
  removed, stops when you press Stop.
- **Always needs approval.** The card shows the **host name prominently** ("on **homelab**"). Session allowances
  use host + exact command (task 1).
- **Offered only when relevant.** Tool selection adds `ssh_command` when SSH is on **and** the message mentions `ssh`,
  `server`, `remote` or one of the enabled host names. Commands can force it with `must_use: ssh_command`.
- **Settings.** A switch to turn SSH on (off by default) and a list of the `~/.ssh/config` hosts with a checkbox each.
  Stored in the Mac app's prefs and mirrored to `~/.ingle/settings.json` as:
  ```json
  "ssh": { "enabled": false, "hosts": ["homelab", "nas"] }
  ```
  VS Code reads it from there (defaults: off, no hosts). VS Code also gets `ingle.ssh.enabled` /
  `ingle.ssh.hosts` settings that override the mirror when set.
- **Prompt fact** (both apps, same meaning): *"If SSH is on, you can run commands on the user's own servers with
  ssh_command, using only the host names listed. Each call needs approval. Never try to reach other hosts."*
  Followed by the list of enabled host names.
- **Privacy.** Add to `PRIVACY.md` and `docs/security-and-privacy.md`: SSH connects only to hosts you configured,
  only when you approve a command, and Ingle sends nothing anywhere else.

### [ ] 6. SSH access — Mac app
**Files.** `Sources/Ingle/Tools.swift` (definition, `describe`, `needsApproval`, `run`), `ToolSelection.swift`,
`Prefs.swift` (keys + persona fact), `SettingsViews.swift` (Mac Access tab), `SettingsMirror.swift`,
`Manifest.swift` (`HelpTopics`), new `Sources/Ingle/SSH.swift` (config parsing, process runner),
`docs/terminal-and-mac-control.md`, `PRIVACY.md`.
**Done when.** With SSH on and a host ticked, "check disk space on homelab" asks for approval and returns `df -h`
output. An unticked host or `user@1.2.3.4` is refused. With SSH off the tool is never offered.

### [ ] 7. SSH access — VS Code extension
**Files.** New `Extensions/vscode/src/tools/ssh.ts` (reuse `runShell`/`capOutput` patterns from `command.ts`),
`tools/index.ts`, `engine/chatEngine.ts` (`toolsFor` only), `engine/prompt.ts`, `shared/settings.ts`,
`package.json` (settings contribution), `docs/vscode-extension.md`.
**Done when.** It behaves the same as the Mac app, reading hosts from `settings.json` or the VS Code settings, and the
type check passes. Add tests for host checking and quoting if task 2 has merged.

---

## Wave 3 — make the apps agree (after waves 1–2)

### [ ] 8. Unify command behaviour
**Do.** Remove every row in the "Mac vs VS Code differences" table in [commands.md](commands.md). Suggested choices:
`always` must be the only value; `never_use` accepts `mcp:` in both apps; a required tool that isn't available is added
anyway, and if it can't be, the command gets ⚠ straight away; `then_run` is triggered by every file-changing tool;
all owed commands go in one nudge; `command_create` refuses advice-only commands in both apps. (Already done: helpers
obey bans in both apps, and project commands are kept alongside yours as `project/<name>` in both, since the prefix means
they can't clash.)
**Files.** `Sources/Ingle/Commands.swift`, `ChatStore.swift` (commands section), `tools/commands.ts`,
`engine/chatEngine.ts` (commands section), `docs/commands.md`.
**Done when.** The differences table is gone (or empty) and task 2's tests cover each rule.

### [ ] 9. One spec both apps test against
**Do.** Create `spec/` with JSON fixtures: input message + command files + tool list → expected selected commands,
offered tools, nudges. Run them from the extension's `npm test`. For Swift, move the pure logic (`Commands.swift`
parsing, `ToolSelection.swift`, frontmatter) into a small `IngleCore` library target with an XCTest target that reads
the same fixtures (`swift test`).
**Files.** `spec/**` (new), `Package.swift`, `Sources/IngleCore/**` (moved files), `Tests/IngleCoreTests/**`,
`Extensions/vscode/test/**`, `CLAUDE.md`.
**Done when.** `swift test` and `npm test` both pass on the same fixtures.

---

## Wave 4 — evidence and install (after wave 3)

### [ ] 10. Benchmark harness
15–25 scripted tasks (see [roadmap.md](roadmap.md) Phase 1). Each run records success, steps, nudges, approvals and
tokens, **with and without** Ingle's compensations. A headless runner using the VS Code engine code is the quickest
route. Results go in `bench/results/` and a summary goes in the README.

### [ ] 11. First-run model picker
Read the Mac's memory and suggest models that fit (8 / 16 / 24 / 32 / 64 GB+), with download sizes and a one-line
"good at" for each. Mac app only.

### [ ] 12. Signing, notarisation and a `.dmg` — needs you
Needs an Apple Developer account (yours). An agent can prepare `scripts/release.sh` and the docs; the certificate and
notarisation credentials must be set up by you and are never entered by an agent.

---

## Waves 5–8 — making it better to use

These are proposals, not commitments. Their order is flexible, but within a wave the tasks don't share files. The same rules
apply: both apps consistent where both are touched, prompt facts + `HelpTopics` + docs updated, nothing new goes
online without `PRIVACY.md`.

### Wave 5 — faster and smarter (after wave 3)

#### [ ] 13. Prompts that reuse the engine's cache
**Why.** Ollama reuses its KV cache only for an **identical prompt prefix**. Ingle changes the tool list and the
COMMANDS block per message, and both sit near the top of the prompt. That likely forces the whole prompt to be
re-read every turn, which is slow on a laptop with a 20K-token context.
**Do.** First measure time-to-first-token and `prompt_eval_count` across a 10-turn chat. Then reorder the prompt:
stable parts first (persona, facts, index), per-message parts last (commands, suggestions, editor context). Try
keeping the tool list fixed for the rest of a chat once a tool has been offered. Keep whichever changes help.
**Files.** Prompt assembly in `ChatStore.swift` (`generate`), `ToolSelection.swift`, `engine/prompt.ts`,
`toolsFor` in `chatEngine.ts`, `docs/agent-loop.md`.
**Done when.** Before/after numbers are in `docs/agent-loop.md`, with no loss of tool accuracy (check with task 10's
benchmark).

#### [ ] 14. Inline code completions in VS Code
**Why.** Copilot-style ghost text is the feature people use most, and a 1–3B fill-in-the-middle model (e.g.
`qwen2.5-coder:1.5b`) runs it locally.
**Do.** A `vscode.InlineCompletionItemProvider` using `/api/generate` with `suffix`. Debounce (~300 ms), cancel on
typing, keep the context small (current file around the cursor plus open-tab snippets), and pause when the chat model
is generating, on battery, or under memory pressure. Off by default, with a status-bar toggle. Ask before
downloading the model.
**Files.** New `Extensions/vscode/src/completion/*.ts`, `extension.ts` (register only), `package.json`
(settings, command), `shared/settings.ts`, `docs/vscode-extension.md`.
**Done when.** Completions appear in under a second on an M-series Mac, and nothing runs while the switch is off.

#### [ ] 15. Checkpoints: undo a whole run
**Why.** Approvals stop bad changes one at a time. Checkpoints make *all* of a run's changes reversible in one click.
This pulls roadmap Phase 3 forward.
**Do.** Before the first change to each file in a run, copy the original to `~/.ingle/checkpoints/<chat>/<run>/`
(new files are recorded as "didn't exist"). Add an **Undo this run** button under the reply, with a preview of the
files it will restore. Old checkpoints are pruned after 14 days or 500 MB. Remote (SSH) changes are out of scope; say
so in the UI.
**Files.** New `Sources/Ingle/Checkpoints.swift`, the write path in `Tools.swift`, `MessageViews.swift`, new
`Extensions/vscode/src/tools/checkpoints.ts`, the write paths in `tools/files.ts`, `media/chat.js`,
`shared/protocol.ts`, `docs/ingle-home.md`.
**Done when.** A run that edited three files and created one can be fully undone in both apps.

### Wave 6 — feels like a Mac app (in parallel; 16 and 17 both touch `IngleApp.swift`, so agree who registers what)

#### [ ] 16. Quick Ask panel
A floating Spotlight-style panel on a global shortcut (default ⌥Space, can be changed in Settings). Type, get an answer
from Ember, press ⏎ to continue in the full chat window, Esc to dismiss. **Files:** new `QuickAsk.swift`,
`IngleApp.swift` (registration only), `SettingsViews.swift` (General). **Done when** it opens in under 200 ms from
any app and doesn't steal the Dock.

#### [ ] 17. Services menu and Shortcuts
"Ask Ingle", "Explain with Ingle" and "Summarise with Ingle" in every app's **Services** menu for selected text, and an
App Intent **Ask Ingle** (text in, text out) so it works in Shortcuts and Siri. No tools run from these without the
usual approvals. **Files:** new `Services.swift`, new `Intents.swift`, the app's `Info.plist` (wherever
`build.sh` makes it), `docs/mac-app.md`. **Done when** selecting text in Safari → Services → Ask Ingle opens a chat
with it.

#### [ ] 18. Local voice
Dictation in the composer with `SFSpeechRecognizer` and `requiresOnDeviceRecognition = true` (refuse rather than fall
back to Apple's servers), plus optional spoken replies with `AVSpeechSynthesizer`. **Files:** new `Voice.swift`,
composer in `ChatViews.swift`, `Info.plist` usage strings, `PRIVACY.md`. **Done when** it works with Wi-Fi off.

#### [ ] 19. Notifications for long runs
When the chat window isn't focused, notify when a run finishes, gets stuck, or needs approval. Approval
notifications have **Allow** / **Deny** actions. Off switch in Settings. **Files:** new `RunNotifications.swift`,
small hooks in `ChatStore.swift`, `SettingsViews.swift`. **Done when** you can approve a command from Notification
Centre.

### Wave 7 — trust and polish (in parallel)

#### [ ] 20. Sandboxed commands
An optional **Sandboxed** mode for `run_command` (per chat; always on for helpers). It runs commands under a
`sandbox-exec` profile: no network, writes only inside the workspace and a temp folder. Clear message when the
sandbox blocks something. `sandbox-exec` is deprecated but still works; note that trade-off. **Files:** new
`Sources/Ingle/Sandbox.swift` + profile in `Support/`, `Tools.swift` (`shell`), `tools/command.ts`,
`docs/terminal-and-mac-control.md`. **Done when** `curl example.com` and `touch ~/x` fail inside the sandbox while
`npm test` in the project passes.

#### [ ] 21. Accessibility audit
VoiceOver labels (none exist today: no `accessibilityLabel` anywhere), full keyboard use of the approval card and
pills, contrast of the ember palette in light and dark, Reduce Motion, and ARIA roles in the webview. Use the
`ui-design-audit` skill. **Files:** `ChatViews.swift`, `MessageViews.swift`, `Theme.swift`,
`media/chat.js`, `media/chat.css`. **Done when** a chat can be held and an approval answered with VoiceOver alone.

#### [ ] 22. "Copy diagnostics" for bug reports
A button in Settings → About that copies app/engine/model versions, the macOS version, memory, the last 200 engine
log lines and settings with anything secret-looking removed. Shown before copying; nothing is sent. Add a GitHub issue
template that asks for it. **Files:** new `Diagnostics.swift`, `SettingsViews.swift` (About),
`.github/ISSUE_TEMPLATE/bug.yml`, `docs/troubleshooting.md`.

#### [ ] 23. Escalate when stuck
When a run hits the stuck stop or a command's ⚠, offer **Try with Flint**: the same chat continues on the bigger
model with a short summary of what was tried. Roadmap's optional bring-your-own-key fallback can plug in here later.
**Files:** stop paths in `ChatStore.swift` and `runLoop` in `chatEngine.ts`, `MessageViews.swift`,
`media/chat.js`. **Done when** both apps offer it in the same situations.

### Wave 8 — the learning loop (after the benchmark, task 10)

Roadmap Phase 2, split into agent-sized pieces. Each one is measured with the benchmark, learning on vs off.

- [ ] **24. "Save as a rule?"** After you correct the assistant ("no, use pnpm"), or deny a call and say why, it
  offers a drafted rule you can edit before saving. The same lesson ignored twice → offer a command.
- [ ] **25. Scorecards.** Count, per rule/command/skill: matched, used, nudges, run finished without you stepping in.
  Stored in `~/.ingle/stats.json`, shown in Settings → Extensions with "fired 12 times, ignored 9".
- [ ] **26. Worked examples.** Save a short record of each successful run (steps, files, checks). Offer the closest
  one or two as examples on similar requests.
- [ ] **27. "What Ingle learned".** One review screen for everything learned: approve, edit, merge, delete.

### Ideas not yet briefed

Rider/JetBrains plugin over the existing editor bridge · an Ingle-aware `git` helper (commit messages from the diff,
`/review` of local changes) · chat export to Markdown · per-project `.ingle/` folders checked into repos so a team
shares rules and commands · a planner model with a fast worker model · an iPhone companion via the Knowledge Portal.

---

## Briefing an agent

Copy this and fill in the task number:

> Work on task **N** in `docs/improvement-plan.md` in the Ingle repo. Read `CLAUDE.md` and the task's section, plus
> the "Rules for every task" and (for SSH) "Shared design" sections. Work in your own branch, touch only the files the
> task lists unless you must (say so if you do), run the checks, commit with `git commit -s`, and report what changed,
> what you checked and what you couldn't.
