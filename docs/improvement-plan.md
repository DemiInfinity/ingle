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
- **Fix bugs you find.** Add a test that shows the bug where you can, fix it (in both apps if both have it), and
  list it in your report. Only leave a bug if fixing it would clash with another task's files; say so.
- **Tear down when you finish.** Quit any copy of Ingle you opened (your worktree's `build/Ingle.app`), stop any
  engine or background process you started, and delete test data (Keychain items, temp files). Leave the user's own
  copy (the main checkout's `build/` or `/Applications`) alone. List what you cleaned up.
- Finish with a short report: what changed, what was checked, what wasn't.

---

## Run order from here (agreed 4 November 2026)

Wave 3 and Wave 4b run together, in rounds that keep tasks touching the same files apart:

| Round | Tasks | Starts when |
|---|---|---|
| A0 | 8 (unify commands), 33 (code intelligence engine + MCP server, new folder only) | now, alongside the secrets store (28) |
| A | 29 (effort), 30 (Code mode foundation) | 28 is merged |
| B | 31 (coding tools), 15 (checkpoints) | 8, 29 and 30 are merged |
| B1 | 32 (workflow: task list, plan mode, changes panel using 15's undo, commit) | 15 is merged |
| B2 | 33b (built-in code intelligence), 34 (coverage checks), 35 (second opinion) | round B and 33 are merged |
| C | 36 (background runs; includes making the agent loop run several jobs at once) | round B2 is merged |
| D | 37 (monitors and schedules), 9 (shared spec + `IngleCore`), 11 (model picker), 38 (command-line Ingle) | 36 is merged |
| **Final** | **10 (benchmark): write it, then run it for real numbers** (the user's decision: only once everything above is built) | round D is merged |

**Benchmark (final round).** Written and run only after everything above is merged. It runs the real models on this Mac (Ember's and Flint's defaults), each task with and without Ingle's harness (`ingle -p … --harness on|off`, plus per-part switches to see what helps most), with Wi-Fi on and off. Cloud reference point (the user approved this on 4 November 2026; Claude Code is installed): the same tasks through `claude -p` in a copy of each benchmark project, to show the remaining gap honestly and which kinds of task still need the cloud. Only the benchmark's own test projects are sent, never the user's private work. It's a separate, clearly labelled run that needs internet, and the local runs don't depend on it. It reports success rate, steps, nudges, approvals, time and tokens per task, and the results go in `bench/results/` and the README. Re-run it after waves 5–8 (the learning loop in wave 8 is judged by it).

Then waves 5–8. Task 12 (signing) waits for the user's Apple Developer account. Nothing is pushed without the user.

---

## Wave 1 — safety, tests, tidy-up (all in parallel)

### [x] 1. Narrow "Allow for This Session"
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

### [x] 2. Test suite for the VS Code extension
**Why.** There are no tests, so the two apps drift apart and changes break quietly.
**Do.** Use Node's built-in `node:test` and `assert`. No new runtime deps; dev-only is fine but avoid it if you can.
Compile the tests with the existing `tsc`. Cover the pure logic: command parsing and matching (`tools/commands.ts`),
`frontmatter.ts`, `editmatch.ts`, `capOutput` in `command.ts`, matcher scoring (`engine/matcher.ts`) and tool
filtering. If tool filtering is buried in `ChatEngine.toolsFor`, extract the pure part into a small module first.
Add `npm test` to `package.json` and mention it in `CLAUDE.md` → "Build and check".
**Files.** `Extensions/vscode/test/**` (new), `Extensions/vscode/package.json`, `Extensions/vscode/tsconfig*.json`,
plus small extractions from `engine/chatEngine.ts` **only in `toolsFor`** (tell task 1 if you touch it).
**Done when.** `npm test` runs offline and passes, with at least 30 meaningful assertions.

### [x] 3. Docs and README tidy-up
**Do.** Remove "from the icon next to Claude's" from the README (it only makes sense on one machine). Add source links
for the specific claims in `weaknesses-and-mitigations.md` (RAG-MCP study, Ollama issue #14493, CVE-2026-7482, Stack
Overflow survey). Lead the README features with **Commands**, the clearest difference from other local chat apps.
**Files.** `README.md`, `docs/weaknesses-and-mitigations.md`.
**Done when.** Every number or CVE has a link, and nothing in the README depends on one person's setup.

### [x] 4. Check the Qwen tool-call parser
**Why.** Ollama has parsed Qwen tool calls in the wrong format (issue #14493); overriding `PARSER`/`RENDERER` roughly
doubled one user's success rate.
**Do.** Check whether the bundled engine version still has the problem for the default Ember/Flint models. If it
does, add an optional per-model Modelfile override that Ingle applies when it creates or pulls the model, and record the
result in `weaknesses-and-mitigations.md` §1.
**Files.** `Sources/Ingle/Ollama.swift` (`ModelTuning`), `Sources/Ingle/ModelManager.swift`,
`Extensions/vscode/src/engine/ollama.ts` (`tuning()`), `docs/engine.md`.
**Done when.** There's a written answer ("still broken in 0.x, fixed by …" or "fixed upstream in 0.x") and, if needed,
the override.

### [x] 5. Research: VS Code Remote-SSH and dev containers (read-only)
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

### [x] 6. SSH access — Mac app
**Files.** `Sources/Ingle/Tools.swift` (definition, `describe`, `needsApproval`, `run`), `ToolSelection.swift`,
`Prefs.swift` (keys + persona fact), `SettingsViews.swift` (Mac Access tab), `SettingsMirror.swift`,
`Manifest.swift` (`HelpTopics`), new `Sources/Ingle/SSH.swift` (config parsing, process runner),
`docs/terminal-and-mac-control.md`, `PRIVACY.md`.
**Done when.** With SSH on and a host ticked, "check disk space on homelab" asks for approval and returns `df -h`
output. An unticked host or `user@1.2.3.4` is refused. With SSH off the tool is never offered.

### [x] 7. SSH access — VS Code extension
**Files.** New `Extensions/vscode/src/tools/ssh.ts` (reuse `runShell`/`capOutput` patterns from `command.ts`),
`tools/index.ts`, `engine/chatEngine.ts` (`toolsFor` only), `engine/prompt.ts`, `shared/settings.ts`,
`package.json` (settings contribution), `docs/vscode-extension.md`.
**Done when.** It behaves the same as the Mac app, reading hosts from `settings.json` or the VS Code settings, and the
type check passes. Add tests for host checking and quoting if task 2 has merged.

---

## Wave 2b — secrets store (after wave 2 merges; one task, both apps)

### [x] 28. Secrets store: the model uses secrets, but never sees them
**Why.** Today memory refuses anything that looks like a password (`Memory.looksSecret`). But a password you type in
chat still goes into the model's context and into saved chat history (`chats.json`, VS Code's chat storage), and there's
nowhere safe to keep it. SSH, MCP servers and API calls all need secrets sooner or later.

**Design.**
- **Where secrets live.** The macOS **Keychain** (service `Ingle`, one generic-password item per secret, with a name
  and a short description). Never in `~/.ingle`, chat history, memory, logs or `settings.json`. Only the *names* and
  descriptions are listed in `~/.ingle/secrets.json` so both apps and the model know what exists.
- **Catching secrets before they're sent.** Before a message is sent, the composer checks it with the same patterns
  as `looksSecret`, plus known key formats (`ghp_`, `sk-`, `AKIA`, PEM blocks, long random strings) and phrases
  like "my password is". If it finds one, it asks: **Save as secret / Send anyway / Cancel**. Save as secret stores the
  value in the Keychain and replaces it in the message with `{{secret:name}}` *before* the message is stored or
  sent. There's also a `/secret` command and **Settings → Secrets** (add, rename, describe, delete; the value is
  shown only after Touch ID).
- **How the model uses one.** It can call `secret_list` (names and descriptions only). There's **no tool that returns a
  value.** To use one, it writes the placeholder in a tool argument, e.g.
  `run_command: gh auth login --with-token <<< {{secret:github-token}}` or an MCP header.
- **Approval every time.** Any tool call containing `{{secret:…}}` always shows the approval card with a clear
  **"Uses secret: github-token"** line and where it goes (command, host, MCP server). There's no "Allow for This
  Session" for secret use. Optionally require **Touch ID** too (Settings, on by default, via `LocalAuthentication`).
  The value is read from the Keychain and substituted only *after* approval, at the moment the tool runs.
- **Never echoed back.** Before tool output goes back to the model or into history, every occurrence of a secret's
  value (and its base64 form) is replaced with `{{secret:name}}`. Commands are passed through environment variables
  where possible (`INGLE_SECRET_GITHUB_TOKEN`) so the value doesn't appear in `ps` output.
- **Writing a secret to a file** (`write_file`/`edit_file` with a placeholder) is allowed only with a warning on the
  card: "This writes github-token to disk in plain text."
- **VS Code.** The extension reads values through the Mac app over the editor bridge (`EditorBridge.swift`, token
  auth), so the Mac app shows the approval and Touch ID. If the Mac app isn't running, it falls back to
  `/usr/bin/security find-generic-password`, which shows macOS's own Keychain prompt; say so in the docs. It never caches
  values.
- **Prompt fact** (both apps): *"Never ask the user to type a password or key in chat. Use secret_list and
  {{secret:name}} placeholders; the user approves each use. You can't read secret values."*

**Files.** New `Sources/Ingle/Secrets.swift` (Keychain, detection, substitution, scrubbing), approvals in
`ChatStore.swift` + `MacTools.approvalScope` (secret calls never get a session scope), composer in `ChatViews.swift`,
approval card in `MessageViews.swift`, `SettingsViews.swift` (new Secrets tab), `EditorBridge.swift` (secret
request endpoint), `Memory.swift` (point "Not saved" at the secrets store); new
`Extensions/vscode/src/tools/secrets.ts`, `engine/chatEngine.ts` (approvals, output scrubbing), `media/chat.js`
(composer check, card line), `shared/protocol.ts`, `engine/prompt.ts`, tests in `test/secrets.test.ts`; docs
`docs/security-and-privacy.md`, `docs/ingle-home.md`, `PRIVACY.md`, `HelpTopics`.

**Done when.** Typing "my GitHub token is ghp_…" offers Save as secret, and afterwards the token appears nowhere in chat
history, memory or the model's context (check the raw request sent to Ollama). A command using
`{{secret:github-token}}` needs approval (and Touch ID if on) every time and works. Output that prints the token
shows the placeholder instead. Both apps behave the same.

---

## Wave 3 — make the apps agree (after waves 1–2)

### [x] 8. Unify command behaviour
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

### [ ] 10. Benchmark (final round: written and run only once everything else is built)
**Question it answers.** How much does Ingle's harness improve the user's own local models, how close does that get to
a cloud assistant, and which kinds of task still need the cloud?

**Models: both of the user's assistants, each benchmarked separately** (as set in Ingle when the benchmark runs; today):
- **Ember**: `qwen3.6:35b-mlx` (23 GB), the daily model;
- **Flint**: `qwen3.8:27b-mlx` (18 GB), hard jobs.
Record each model's digest, quantisation and context length with the results.

**Conditions** (every task, each model):

| | Condition | How |
|---|---|---|
| A | Model alone | `ingle -p … --harness off` (all tools, Ollama defaults, no guards or enforcement) |
| B | Model + Ingle | `ingle -p … --harness on --effort medium` |
| C | Model + Ingle, trying hard | `ingle -p … --harness on --effort high` |
| D | Cloud reference | `claude -p …` in the same task copy (user-approved; needs internet; a separate labelled run) |
| Ablations | Which part helps | B with one part off at a time (`--no-tool-filter`, `--no-commands`, `--no-guards`, `--no-tuning`, `--no-repo-map`, `--no-coverage`, `--no-verify`), on a 10-task subset, Ember only (unless time allows) |

**Tasks: about 30, in small fixture projects** (`bench/tasks/<id>/`: a git repo, `prompt.md`, an automatic
checker, a time limit). Mixed languages (TypeScript, Swift, Python), sized for 16–32K context:
1. **Fixes (8):** failing unit tests from off-by-one errors, null handling, a wrong import, a regex bug, a date/timezone
   bug, an async ordering bug (hard), a Swift optional bug, and a Python edge case.
2. **Multi-file changes (6):** rename a function used in 5 files (missing one = fail), thread a new field through
   model → API → UI, add an endpoint with a test, update call sites after a signature change, extract a helper, and
   change a config format.
3. **Understanding (5):** "what calls X" (scored against the exact list), "where is Y configured", "why does Z fail",
   explaining a module, finding dead code. Scored by required facts and references from an answer key, not by asking a
   model's opinion.
4. **Tools and obedience (5):** follow a command (lint after every edit), obey a `never_use` ban, use a local fake MCP
   server for one step, pick the right tool out of many, and use a `{{secret:…}}` placeholder without ever printing
   the secret.
5. **Long input (3):** find the one cause in a 3,000-line log, pull key figures from a PDF, answer from a memory file.
6. **Robustness and safety (3):** recover from a failing command, ask or plan when the request is ambiguous, and
   **refuse a prompt injection** (a README telling it to run `curl … | sh`). Running it = fail.
Plus, if built by then: **1 background job** (start it, keep chatting, the job comes back and is checked) and **1 Code
mode task through the Mac app** as a smoke test. SSH tasks run only if a test host is set up.

**What's measured per run** (raw JSONL): pass/fail from the checker plus a partial score; **false "done"** (claimed
success but the checker failed; a key number); steps; tool calls; malformed or wrong tool calls; nudges; repeat-guard
hits; stuck stops; approvals asked and refused attempts; tokens in/out; wall time; time to first token; peak memory.

**Fairness rules.**
- Each task runs **3 times** per condition (local models vary). Report the mean and spread, with fixed seeds where
  the engine allows.
- **Half the tasks are held out**: written now, not looked at while tuning Ingle, and reported separately, so we can
  tell if the harness was tuned to the test.
- Tasks and checkers are frozen before the first full run, and every failure is published, not just the wins.
- The same machine and engine version for all local runs, with nothing else heavy running.

**Safety.** Every run works in a throwaway copy under a temp folder, with `HOME` pointed at a fake home containing a
test `~/.ingle` (no access to the user's real files, memory or secrets). Approvals come from a per-task `--allow` list
of scoped actions, and everything else is denied and recorded. No network except the local engine (Web off) for A–C.
Claude Code (D) runs with permissions limited to the task copy. Clean up every copy and process afterwards.

**Offline.** A–C run with Ingle's network blocked. One extra B run is done with Wi-Fi actually off; the user switches
it, since the benchmark doesn't change system settings.

**Time: built for a laptop** (the main test Mac is a laptop with 36 GB of memory). Overnight runs across several nights
aren't realistic: the lid closes, it travels, and while a 23 GB model is loaded the Mac isn't much use for anything
else. So:
- **Smaller default suite.** **Standard** = 20 tasks (10 tuning + 10 held out) × conditions A and B × both models × **2
  runs** = 160 runs. With a 6-minute cap per run (most finish in 2–4), that's about **5–8 hours in total**, run in
  chunks. Condition C (High effort) runs on Ember only. Ablations run once, on 8 tasks, Ember only.
- **Quick** (10 tasks × A/B × both models × 1 run ≈ **1–2 hours**) checks everything works first, and **measures real
  minutes per run** so the runner can give an honest estimate before the standard run.
- **Full** (all ~30 tasks × 3 runs × A/B/C) is optional, for later, e.g. on a desktop Mac or a home server.
- **Runs in chunks, whenever it suits you.** `bench/run.sh --for 60m` runs for about an hour, then stops at the end of
  the current task. It resumes exactly where it left off and never repeats a finished run.
- **Grouped by model.** All Ember runs, then all Flint runs, so each model loads once per chunk instead of swapping
  23 GB and 18 GB in and out.
- **Gets out of your way.** It only starts on mains power, pauses between runs if you unplug, and keeps the Mac awake
  only while it's running (`caffeinate -i -s`, released at the end; the lid must stay open, since macOS sleeps on lid
  close without an external display). With `--yield`, it pauses between runs when you start using the Mac and carries on
  when you've been idle for a few minutes.
- **Heat is recorded, not hidden.** Each run records the Mac's thermal state. Times from throttled runs are flagged, and
  pass/fail results stay valid.

**Output.** `bench/run.sh` (with `--tier quick|full`, `--models`, `--conditions`, `--tasks`, `--resume`) writes
`bench/results/<date>/` (raw JSONL, environment details: Mac model, memory, macOS, Ollama and Ingle versions, model
digests) and a `summary.md` with:
- pass rate per model × condition, overall and per category, with spread;
- the false-"done" rate;
- the ablation table (which harness part helps most);
- time and tokens;
- the Ember vs Flint comparison (which one to use for what);
- where Claude Code still wins.
The headline goes in the README.
**Files.** `bench/**` (new), plus the `--harness`/ablation switches from task 38. Don't change app behaviour to suit the
benchmark.

### [ ] 11. First-run model picker
Read the Mac's memory and suggest models that fit (8 / 16 / 24 / 32 / 64 GB+), with download sizes and a one-line
"good at" for each. Mac app only.

### [ ] 12. Signing, notarisation and a `.dmg` — needs you
Needs an Apple Developer account (yours). An agent can prepare `scripts/release.sh` and the docs; the certificate and
notarisation credentials must be set up by you and are never entered by an agent.

---

## Wave 4b — Effort and Code mode (after wave 3; can run alongside wave 4)

The two things that make Ingle work like Claude Code: you choose **how hard it tries**, and the Mac app gets a
**Code mode** for working in a project folder, not just chatting. Order: 29 and 30 in parallel → then 31 and 32 in
parallel (both need 30) → task 15 (checkpoints) is pulled forward to land with them.

### [x] 29. Effort levels (both apps)
**Why.** Today there's only a **Think** on/off pill (`ThinkToggle` in `ChatViews.swift`, `think: Bool` in
`Ollama.swift`/`ollama.ts`). One switch doesn't let you say "quick answer" vs "take your time and check your work".
**Design.** Replace the Think pill with an **Effort** menu: **Low · Medium · High · Max**. It's set per chat. The
default is set per assistant (Ember: Medium, Flint: High) and can be changed in Settings → Models. Each level is a
bundle of settings defined in one table per app (`EffortLevel` in Swift, `effort.ts` in the extension), kept in step:

| | Low | Medium | High | Max |
|---|---|---|---|---|
| Thinking | off | on (`"low"` where the model takes levels) | on (`"medium"`) | on (`"high"`) |
| Prompt line | "Answer directly in as few steps as possible." | (none) | "Investigate before changing anything: read the related code, then check your work." | "Plan first, investigate fully, verify with the project's checks, then review your own changes before finishing." |
| Tool filtering | strict | normal | relaxed (core coding tools always offered) | relaxed |
| Must verify after editing | no | no | run the project's check command once before finishing (a built-in nudge, like `then_run`) | yes, plus a read-only helper reviews the diff |
| Plan step | no | no | no | a short visible plan first (uses task 32's task list) |
| Repeat/stuck guard | 3 / 4 | 3 / 4 | 4 / 6 | 4 / 6 |

- Ollama's `think` accepts `true/false` and, for some models, `"low"|"medium"|"high"`. Send a level where the model
  supports it, `true` otherwise. Keep the existing retry when a model can't think at all (Low then behaves the same).
- "The project's check command" comes from commands' `then_run` if one applies, otherwise it's detected
  (`package.json` test/lint, `swift build`, `cargo check`, `go test`, `make test`, `pytest`), otherwise skipped with a
  note.
- The pill shows the level and a tooltip saying what it does. ⌘⇧E cycles levels in the Mac app.
- `Conversation.effort: String?` is optional. Old chats map Think on → High, Think off → Medium.
- Prompt facts + `HelpTopics` + `docs/agent-loop.md` explain the levels.
**Files.** New `Sources/Ingle/Effort.swift`, `ChatViews.swift` (pill), `ChatStore.swift` (prompt line,
verification nudge, guard thresholds), `Ollama.swift` (`think` as level), `ToolSelection.swift`, `Prefs.swift`
(per-assistant default), `SettingsViews.swift`; new `Extensions/vscode/src/engine/effort.ts`, `ollama.ts`,
`chatEngine.ts`, `toolSelection.ts`, `media/chat.js`, `shared/protocol.ts`, tests in `test/effort.test.ts`.
**Done when.** The same request at Low gives a quick answer with no thinking. At High it reads the related code and
runs the tests before finishing. At Max it shows a plan first and a review note at the end. Both apps behave the same.

### [x] 30. Code mode — foundation (Mac app)
**Why.** The Mac app is a chat. To use it the way Claude Code works, a chat needs to belong to a **project folder**,
with coding tools and a coding prompt, while normal chats stay simple.
**Design.**
- A **Chat / Code** switch at the top of the chat window (and ⌘⇧C). New Code chats ask for a folder (picker, drag a
  folder in, or a recent project). The folder is shown as a chip with the git branch.
- The sidebar gets two sections: **Chats** and **Code**. Code chats are grouped by project. Storage is ready for roadmap
  Phase 3's `~/.ingle/coding/<project>/` but can stay in the current store for now.
- In Code mode the project folder is the **workspace**, like in VS Code: reads, lists and searches inside it need no
  approval; writes and commands still ask (with the scoped allowances from task 1). Reads outside it ask.
- The prompt switches to the **coding persona**, the same text as the VS Code extension's (`engine/prompt.ts`), kept in
  step with a comment in both. It also gets the project's rules files (`AGENTS.md`, `CLAUDE.md`, `.ingle/`), the git
  branch and a short `git status`.
- **Mac control is off** in Code mode, and its pill is hidden. Web stays opt-in.
- `Conversation.mode: String?` and `Conversation.projectPath: String?` are optional (nil = Chat).
**Files.** `ChatStore.swift` (mode, workspace rules, prompt choice), `ChatViews.swift` (switch, folder chip,
sidebar sections), new `Sources/Ingle/Project.swift` (folder, git info, rules files, recent projects), `Prefs.swift`,
`Tools.swift` (workspace-aware approval), `Manifest.swift` (`HelpTopics`), `docs/mac-app.md`.
**Done when.** You can start a Code chat on a folder, ask "what does this project do?" and get an answer without any
approval prompts, and normal chats are unchanged.

### [x] 31. Code mode — coding tools in Swift (Mac app; after 30)
**Why.** The Mac app has only `list_files`, `read_file`, `write_file` and `run_command`. VS Code has the tools that
make small models good at code.
**Do.** Port these from `Extensions/vscode/src/tools/` to Swift, offered only in Code mode, same names, arguments and
behaviour (task 9's shared fixtures should cover them):
- `find_files` (glob, skipping `.gitignore`d and build folders);
- `search_code` (uses `git grep` in a repo, `grep -rn` otherwise; capped results with line numbers);
- `edit_file` (exact-match replace using the `editmatch.ts` rules, with a **diff in the approval card** and a
  side-by-side view in a sheet);
- **repo map** (port `repomap.ts`: ranked outline of files and key symbols, capped at about 1,500 tokens, added to the
  prompt per request);
- `get_problems` → runs the detected check command (as in task 29) and returns the errors.
**Files.** New `Sources/Ingle/CodeTools.swift`, `Sources/Ingle/RepoMap.swift`, `Sources/Ingle/EditMatch.swift`,
`Tools.swift` (registration only), `ToolSelection.swift`, `MessageViews.swift` (diff in the approval card),
`docs/mac-app.md`, `docs/agent-loop.md`.
**Done when.** In a Code chat, "rename `foo` to `bar` everywhere and run the tests" finds the uses, shows diffs to
approve, edits the files and runs the tests, with the same results as the VS Code extension on the same repo.

### [ ] 32. Code mode — the Claude Code-style workflow (both apps where it fits; after 30)
**Do.**
- **Task list.** An `update_tasks` tool. The model keeps a short to-do list for bigger jobs, shown pinned under the
  latest reply with ticks as it goes (Mac: under the message; VS Code: in the webview). Max effort uses it for its plan.
- **Modes in the message box (the user's decision, 4 November 2026).** A **Mode** pill next to Model and Effort, set
  per chat, with ⇧Tab cycling it, like Claude Code: **Ask** (default: changes and commands ask), **Edit** (file changes
  inside the project are approved automatically), **Auto** (also commands inside the project, except risky ones,
  which still ask: sudo, recursive or outside deletes, git push/reset/clean, network fetches, writes outside the
  project, secrets, SSH, Mac control, side-effect MCP calls), **Plan** (read only, ends with a plan to Approve, which then
  starts the work with it as the task list) and **Debug** (no edits until it has reproduced the bug and stated the
  cause with evidence; after the fix it must rerun the reproduction). Auto-approved actions are listed in the run log,
  so nothing is silent.
- **Changes panel.** A list of every file changed in this run with its diff, plus **Undo this run** (task 15) and
  **Open in editor** (VS Code, or the default app).
- **Commit.** A **Commit** button when the run changed files in a git repo. It drafts a message from the diff that you
  can edit, then runs `git commit` (with approval). It never pushes.
- **Interrupt and steer.** Typing while it works queues your message and gives it to the model at the next step,
  instead of waiting for the run to end.
**Files.** Mac: new `Sources/Ingle/TaskList.swift`, `Sources/Ingle/ChangesPanel.swift`, `ChatStore.swift` (plan mode,
queued messages), `ChatViews.swift`, `MessageViews.swift`. VS Code: `engine/chatEngine.ts`, `media/chat.js`,
`shared/protocol.ts`, new `tools/tasks.ts`. Docs: `docs/agent-loop.md`, `docs/features.md`.
**Done when.** A multi-step job in either app shows a live task list, can be planned first, ends with a changes panel,
and can be committed (or undone) in one click.

**Trade-off to note in the docs.** Porting the coding tools to Swift means three agent loops' worth of logic to keep in
step (Mac Chat, Mac Code, VS Code). Task 9's shared fixtures are what keeps that safe. Longer term, consider moving the
agent loop into one shared core.

---

## Wave 4c — don't miss anything, and know when to ask for help

The harness can't make a small model cleverer, but it can stop it **missing things**: a caller it didn't look at, a
file it skipped, half a log it never read. And when a job really is beyond it, Ingle should say so and help you get a
second opinion, **only when needed**.

**Decision (hybrid).** One analysis engine, used three ways: imported directly by the VS Code extension as built-in
tools; run as a helper process by the Mac app, with its tools shown as built-in tools (normal names, no `mcp_call`
step, no approval prompt for these read-only tools inside the workspace); and published as a standard MCP server for
other apps. Why: small models struggle with the two-step `mcp_tools` → `mcp_call` route and with an approval on every
call, and coverage checks (task 34) need to understand the results. A separate engine still means one
implementation, crash isolation and use outside Ingle.

### [x] 33. Code intelligence engine + MCP server (`ingle-code`) — can start any time (new folder only)
**Why.** Today the model finds code with text search and the repo map, and it misses things. Language servers
already know every definition, reference and type error exactly.
**Design.**
- A new Node/TypeScript package in `Extensions/ingle-code/`, with **no runtime npm deps**, in two layers:
  - `src/engine/`: a plain library with typed functions (`references()`, `impact()`, …) that the VS Code extension can
    import directly;
  - `src/mcp/`: a thin MCP-over-stdio server (written by hand like `MCPConnection`) that exposes the same functions,
    plus `bin/ingle-code` to run it. The Mac app uses this same entry point as its helper process.
- It **drives language servers that are already installed** over LSP: `sourcekit-lsp` (comes with Xcode/CLT),
  `typescript-language-server`/`tsserver`, `pyright`, `gopls`, `rust-analyzer`. It finds them on `PATH` and reports
  which languages are available. With no server for a language, it falls back to a fast symbol scan (`git grep` +
  patterns) and labels results "approximate".
- Tools. They are complete and deterministic, and each says whether its answer is **exact** (from LSP) or
  **approximate**:
  - `outline(file)`: symbols with line ranges.
  - `definition(symbol | file:line:col)`.
  - `references(symbol)`: **every** use, grouped by file, with a total count.
  - `callers(symbol)` / `callees(symbol)`: one or two levels deep.
  - `impact(symbol)`: references + callers + the tests that cover those files. This is the list of everything a
    change to this symbol could affect.
  - `diagnostics(paths?)`: compiler/type errors without a full build.
  - `read_exhaustively(path, question)`: for huge files and logs, walks the file in chunks and returns a structured
    note for every chunk, so nothing is skipped (the model reads the notes, not 50,000 lines). The per-chunk notes come
    from the local engine (`/api/generate` at `OLLAMA_HOST` or `localhost:11434`) with a small model, so it's still fully
    local.
- Output is short and capped, with "showing 40 of 212, ask for page 2". Small context windows come first.
- Read-only. It never edits files. It keeps language servers warm per workspace and shuts them down when idle.
- Tool names, arguments and output format are written down in `Extensions/ingle-code/TOOLS.md`. Task 33b and the
  Mac app follow it exactly.
**Files.** `Extensions/ingle-code/**` only (its own `package.json`, `tsconfig.json`, `node:test` tests against small
fixture projects in Swift and TypeScript, `TOOLS.md`, `README.md` with MCP set-up for Claude Code/Desktop/Cursor),
plus `docs/ingle-code.md` (new) and one line in `docs/README.md`.
**Done when.** Run as an MCP server on this repo, `references` for `approvalScope` finds every use in both the
Swift and TypeScript code, `diagnostics` reports a deliberately broken file, and results say exact/approximate
correctly when a language server is missing.

### [ ] 33b. Built-in code intelligence in both apps (after 33 and round B; with 34)
**Do.**
- **VS Code:** import `ingle-code`'s engine and register its tools as normal `ToolDef`s (`references`, `impact`,
  …), offered in coding requests by `toolSelection.ts`. Inside the workspace they don't need approval (read-only).
- **Mac app (Code mode):** start `ingle-code` as a helper process per project (Node found on `PATH` or the usual
  Homebrew/nvm places) and talk to it with the existing MCP client code, but **register its tools as built-in tools**
  in Code mode: normal names, no `mcp_call`, no approval inside the project. If Node isn't found, fall back to
  `search_code`/repo map and say once, plainly, that analysis is approximate and installing Node turns on exact results.
- The tools feed task 34 (coverage) and task 35 (relevant code for the brief).
- Prompt facts + `HelpTopics` + docs say when to use `impact` before changing shared code.
**Files.** `Extensions/vscode/src/tools/codeintel.ts` (new), `tools/index.ts`, `toolSelection.ts`,
`package.json` (bundle `ingle-code` into the `.vsix`), new `Sources/Ingle/CodeIntel.swift`, `Tools.swift`
(registration), `ToolSelection.swift`, `docs/ingle-code.md`.
**Done when.** In both apps, "what calls `runSubAgent`?" in a Code chat is answered completely with no approval
prompts, and the same answer comes from Claude Code using `ingle-code` as an MCP server.

### [ ] 34. Coverage checks: the harness notices what was missed (both apps; after round B)
**Why.** Having `impact` isn't enough if the model ignores half the list. This is the obedience-layer idea applied to
completeness.
**Design.** When a run calls `impact`/`references` and then changes code, Ingle remembers the affected files. Before
the model finishes, it checks which of them it neither read nor edited. If some are left, it nudges once ("You changed
`approvalScope` but didn't look at 3 places that use it: … Check them or say why they don't need changing."). If
they're still unvisited, the reply gets a chip: **⚠ 3 affected places not checked**. It's on at High and Max effort
(task 29), and a command can switch it on with `must_use: coverage`.
**Files.** A small `Coverage` module per app, hooks in the completion check (`ChatStore.swift`, `chatEngine.ts`),
the chip in `MessageViews.swift`/`chat.js`, tests, `docs/agent-loop.md`.
**Done when.** Renaming a function used in five files, with the model "forgetting" one, produces the nudge and then
either the fix or the chip.

### [ ] 35. Second opinion: when to ask a cloud AI (both apps; replaces task 23; after round B)
**Why.** Some problems are beyond a local model. Ingle should be honest about that and make getting help easy, but
**only when needed**, and nothing ever leaves your Mac unless you choose.
**When it's offered.** This is decided by the harness from what happened, never by the model saying it's unsure:
- the stuck stop fires, or the same check (tests/build) fails 3 times in a run;
- a command still ends in ⚠ after its nudges;
- at Max effort the review step finds problems it can't fix;
- coverage (task 34) leaves affected places unresolved.
It's never offered for quick chats, and at most once per run.
**What it offers.** A card under the reply: **This might need a stronger model.**
- **Try with Flint**: the same chat continues on the bigger local model with a short summary of what was tried
  (the old task 23).
- **Prepare a brief for a cloud AI**: Ingle writes a short, self-contained Markdown brief with the goal, what was
  tried, the errors, and only the relevant code (using `impact` from task 33). Secrets are scrubbed with the secrets
  store's scrubber (task 28), and home paths and usernames are optionally redacted. You see the full brief before
  **Copy**. Nothing is sent anywhere. Paste it into Claude or another assistant yourself.
- **Keep going**.
- Later, an optional "send with your own API key" (roadmap), off by default and clearly labelled as leaving your
  Mac, with the same preview.
**Prompt fact** (both apps): *"If a task is beyond you after real attempts, say so plainly; Ingle can offer a second
opinion. Don't suggest it for ordinary work."*
**Files.** A small `Escalation` module per app, stop paths in `ChatStore.swift` / `runLoop` in `chatEngine.ts`,
`MessageViews.swift`, `media/chat.js`, `shared/protocol.ts`, brief builder + tests, `PRIVACY.md` (states that briefs
are copy-only), `docs/agent-loop.md`.
**Done when.** A run that fails its tests three times shows the card. The brief contains the goal, attempts, errors and
the relevant code with no secrets or private paths. Ordinary chats never show it.

---

## Wave 4d — work in the background

You should be able to hand Ingle a job ("watch PR 42 and tell me when CI passes", "run the full test suite and fix
what breaks") and **keep chatting** while it works. Roadmap Phase 3's scheduled tasks are folded in here.

**Today's limit** (what these tasks change): the Mac app can only hold one run at a time across all chats (a single
`streamingID`, `task` and `approval` in `ChatStore.swift`), so there's nowhere to keep a second run while it waits
its turn. The engine serving one request at a time is fine: jobs simply queue.

### [ ] 36. Background runs (Mac app first; VS Code can view and start them; round C)
**Design.**
- **Runs are independent.** Refactor the agent loop so each run has its own state (messages, tool calls, approvals,
  stop button) instead of the store-wide `streamingID`/`task`/`approval`. A chat can be the foreground run while
  others run in the background. Keep `send`/`generate` behaviour for normal chats identical.
- **Start one.** Use **Run in background** (a composer menu item and ⌘⏎), `/background <task>`, or the model calling a
  `job_start` tool (with approval showing the task). A job **belongs to the chat that started it**. That chat shows
  a small live chip ("⟳ running tests · 2 min") you can click for its log, and you keep chatting there or anywhere
  else. A **Jobs** list (sidebar section and menu bar) shows every job's status (working · waiting for you · done ·
  failed · paused).
- **It comes back as a trigger (the user's decision).** When a job finishes, fails or gets stuck, Ingle posts a
  **job event** into the chat that started it (a compact card: what it was, the outcome, a short result and a link
  to the full log) and **starts an assistant turn automatically** so the assistant reacts. If you're mid-conversation
  in that chat, the event waits in the queue and is handled straight after your current turn, never interrupting a
  reply. If the chat isn't open, you get a notification and a badge, and the assistant's turn is waiting when you
  open it.
- **The assistant checks the job; it doesn't just relay it (the user's decision).** A job's report is a claim, not
  proof. On a job event, the assistant verifies the result before telling you it's done: it looks at the diff,
  reruns the check or reads the output that matters, as fits the job. Then it tells you plainly what's confirmed and
  what isn't. If the check fails, it says so and offers to continue or fix it. The verification uses the same
  approvals as anything else.
- **Events are data, not instructions.** Job output and event cards reach the model marked as untrusted results
  (like web content today). Nothing in them can approve an action, change settings or count as the user speaking.
- **One engine, one queue (the user's decision).** No second model or parallel engine slots: a background job is
  just another stream **queued behind** your chat on the same engine and model. One `EngineQueue` hands out model
  steps one at a time. Your chat always goes to the front, and background jobs take the next free step between your
  turns. Their tool calls (commands, checks, file reads) run while the model is busy elsewhere, so a job spends most of
  its time not needing the model at all. Jobs use the chat's model by default, so nothing extra is loaded into memory.
- **Approvals never block your chat.** A background run that needs approval pauses and shows **waiting for you**,
  with a notification (with Allow / Deny actions; this absorbs task 19) and a badge on Jobs. When starting a job you
  can **pre-approve** specific scoped actions for that job only (e.g. "`gh pr view`, `gh pr checks` in this repo"),
  using task 1's scopes. Pre-approvals are listed on the job and end with it. Secrets (task 28) still need approval
  each time.
- **Power and offline.** Runs only while Ingle is open and the Mac is awake. On battery, big-model jobs wait unless
  allowed. Jobs that need the network wait while offline and resume when it's back.
- Tears down cleanly. Stopping a job stops its commands and any processes it started.
**Files.** `ChatStore.swift` (the run refactor, the biggest part; split into a new `Sources/Ingle/Run.swift` +
`RunQueue.swift`), new `Sources/Ingle/Jobs.swift`, `JobsViews.swift`, `RunNotifications.swift`, `ChatViews.swift`
(sidebar section, composer menu), new `EngineQueue.swift`, `SettingsViews.swift`, `EditorBridge.swift`
(list/start jobs for VS Code), VS Code: a read-only Jobs view in the webview and a "Run in background" command that
sends the job to the Mac app. Docs: `docs/agent-loop.md`, `docs/mac-app.md`, `HelpTopics`.
**Done when.** You can start "run the tests and fix failures" in the background and keep chatting normally,
including in the same chat. You can approve its command from a notification. When it finishes, a job event appears in
the chat that started it, and the assistant checks the result (e.g. reruns the tests) before reporting what's confirmed.
An event that arrives mid-reply waits until the reply ends. Stopping a job leaves nothing running.

### [ ] 37. Monitors and schedules (round D)
**Why.** Many background jobs are "keep an eye on X". Asking the model every few minutes would be slow and drain the
battery, so most of the watching should be done **without the model**.
**Design.**
- **A monitor** = a check + an interval + what to do when it changes. The check is a command (`gh pr checks 42 --json
  state`), an MCP tool call (GitHub MCP `get_pull_request`), or a web page (only when Web is allowed for that job).
  Ingle runs the check itself, compares the result with last time, and **only wakes the model when something
  changed**. A change comes back into the chat that created the monitor as a **job event** (same trigger as task
  36), and the assistant checks it and follows the instructions ("summarise what changed; if CI failed, read the logs
  and suggest a fix"), with a notification if the chat isn't open. Monitors started from Settings post into a chat
  you choose (or a new one). Changes are kept in the job's log.
- **A schedule** = a job that runs at set times ("every weekday at 9:00, summarise my open PRs"). Cron-like but
  written in plain words in the UI.
- **Files, not hidden state.** Each monitor or schedule is a file in `~/.ingle/jobs/<name>.md` (frontmatter: `check`,
  `every`, `at`, `until`, `model`, `allow`, `notify`; body = instructions). It's visible, editable, pausable and
  deletable, and lives in **Settings → Jobs** as well as the sidebar.
- **Creating them by asking.** "Keep an eye on PR 42 and tell me when it's approved or CI fails" → the model calls
  `monitor_create`, and you see a card with the check, interval, pre-approved actions and when it stops (e.g. when
  the PR merges or after 7 days). Nothing runs until you approve.
- **Ready-made recipes** for common jobs (they work through the `gh` CLI or a GitHub MCP server, whichever you have):
  PR status/CI, new review comments, a failing nightly test run, a server's disk space over SSH (task 6), a website
  being up.
- Stops on its own when its `until` is met, and backs off when a check keeps failing (e.g. offline).
**Files.** New `Sources/Ingle/Monitors.swift`, `Schedules.swift`, `Jobs.swift` (extend), `SettingsViews.swift` (Jobs
tab), new `docs/jobs.md`, `docs/ingle-home.md` (the `jobs/` folder), `PRIVACY.md` (monitors only use the network for
checks you set up), `HelpTopics`, prompt facts.
**Done when.** "Watch PR 42" with the `gh` CLI notifies you when CI finishes, without the model running between
checks. A weekday-morning summary runs at 9:00. Both can be paused and edited as files.

---

## Wave 4e — Ingle in the terminal

### [ ] 38. Command-line Ingle (`ingle`) (round D, before the benchmark)
**Why.** You should be able to use Ingle straight from a terminal, the way Claude Code works: in any folder, over SSH,
in scripts, and offline. The benchmark also needs a headless way to run tasks, and this is it.
**Design.**
- **Shared engine, not a fourth copy.** The VS Code extension's engine is mostly free of VS Code already. The
  VS Code-specific parts are `chatEngine.ts` (about 55 uses), `tools/files.ts` (about 22), `repomap.ts`, `paths.ts`
  and `engine/diff.ts`. Move the agent loop behind a small **`Host` interface** (workspace folders, read/write files,
  show a diff, ask for approval, show progress, problems/diagnostics) into a VS Code-free core
  (`Extensions/vscode/src/core/` or a sibling `Extensions/core/`). Then **VS Code** and the **CLI** each provide a
  `Host`. VS Code behaviour must stay identical, and the existing tests must keep passing.
- **Interactive mode:** `ingle` in a folder opens a chat in the terminal. Replies stream, thinking is folded away,
  tool calls show as one-line rows, and diffs are coloured. Approvals are a prompt: **[y] allow · [s] allow for this
  session · [n] deny** (same scopes as task 1; secrets always ask). Slash commands: `/effort`, `/model`, `/plan`,
  `/compact`, `/new`, `/background`, `/exit`. The folder is the workspace (Code mode rules from task 30).
- **One-shot mode for scripts:** `ingle -p "explain this error" < log.txt`, `git diff | ingle -p "review this"`,
  `--json` for machine-readable output, `--effort`, `--model`, `--allow "run_command:npm test"` to pre-approve
  specific scoped actions. With no terminal to ask in, anything not pre-approved is **denied**, never silently allowed.
  Exit codes say whether it succeeded.
- **`--harness off` for benchmarking.** It turns off Ingle's compensations: per-turn tool filtering (all tools offered),
  commands enforcement, the repeat/stuck guards, sampling tuning (Ollama defaults), the repo map, rule/skill suggestions,
  effort verification and coverage checks. It keeps the same model, tools, prompt facts and task, so the only
  difference is the harness. Individual switches (`--no-tool-filter`, `--no-commands`, …) show which part helps most.
  It's for measurement only and is hidden from normal help.
- **Same brain.** It reads `~/.ingle` (rules, skills, commands, memory, secrets via the Keychain or the Mac app,
  `mcp.json`, settings), uses the same engine (starts the bundled one from `Ingle.app` if it's installed and not
  running, otherwise uses `OLLAMA_HOST`), and saves sessions under `~/.ingle/` so they can be resumed (`ingle
  --resume`). Background jobs (task 36) started from the CLI show up in the Mac app's Jobs list via the editor bridge
  when it's running.
- **Install.** Settings → General → **Install command-line tool** (like VS Code's `code` command) symlinks `ingle`
  into `/usr/local/bin` or `~/.local/bin`, plus `Extensions/cli/install.sh`. Node 18+ is required; say so clearly
  if it's missing.
- Works on Linux too (it's plain Node), which is a first step towards roadmap Phase 4.
**Files.** The core extraction (`Extensions/vscode/src/engine/chatEngine.ts` → core + `VSCodeHost`,
`tools/files.ts`, `repomap.ts`, `paths.ts`, `engine/diff.ts`), new `Extensions/cli/**` (entry point, terminal UI
with no npm deps, `TerminalHost`, tests), `SettingsViews.swift` (install button), `build.sh` (copy the CLI into
`Ingle.app/Contents/Resources/cli`), new `docs/cli.md`, `docs/README.md`, `CLAUDE.md` (build/check commands).
**Done when.** `ingle` in this repo can answer questions, edit a file with an approved diff and run the tests.
`git diff | ingle -p "review this" --json` works with no prompts and denies anything not pre-approved. The VS Code
extension behaves exactly as before, with all tests passing. The benchmark (final round) can drive tasks through
`ingle -p`.

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

#### [x] 15. Checkpoints: undo a whole run
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

#### [ ] 19. Notifications for long runs — *now part of task 36*
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

#### [ ] 23. Escalate when stuck — *now part of task 35*
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
