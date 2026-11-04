# Commands — the obedience layer

Rules and skills are **advice**: they're put in front of the model and you hope it follows them. Local models are
clever but forgetful, especially with tools, so Ingle also has **commands**: rules that Ingle itself **checks and
enforces**.

> *"Write a command to always use the Figma MCP for component builds."*

From then on, when a message mentions a component:

- the Figma MCP tools are **guaranteed to be offered**, even if the per-turn tool filter would have dropped them;
- tools the command bans are **removed and blocked**;
- the assistant **can't finish** until it has done what the command says — Ingle sends it back (up to twice);
- the reply shows **⚑ components-via-figma**, or **⚠ didn't follow components-via-figma** if it still didn't comply.

Code: [`../Sources/Ingle/Commands.swift`](../Sources/Ingle/Commands.swift) (`IngleCommand`, `CommandStore`,
`CommandTracker`) and the loop in [`../Sources/Ingle/ChatStore.swift`](../Sources/Ingle/ChatStore.swift);
[`../Extensions/vscode/src/tools/commands.ts`](../Extensions/vscode/src/tools/commands.ts) and the loop in
[`../Extensions/vscode/src/engine/chatEngine.ts`](../Extensions/vscode/src/engine/chatEngine.ts).

## The file format

One Markdown file per command, with frontmatter, in:

- `~/.ingle/commands/<name>.md` — yours, shared by both apps;
- `<project>/.ingle/commands/<name>.md` — a project's own, shown as `project/<name>`.

```markdown
---
description: Build UI components from the Figma designs
when: component, components, ui kit
must_use: mcp:figma
never_use: write_file
then_run: npm run lint
enabled: true
---

Match the spacing tokens from the Figma file exactly. Put new components in src/components.
```

| Key | Meaning |
|---|---|
| `name` | Optional; defaults to the file name without `.md`. |
| `description` | One line saying what it enforces (shown in the index and Settings). |
| `when` | Comma-separated **trigger phrases**. The command applies when the latest message **contains** any of them (case-insensitive substring). `always` or empty = every request. |
| `must_use` | Comma-separated requirements, each one of: a **tool name** (`search_code`, `run_command`, `web_search`…); `mcp:server` (any tool of that MCP server via `mcp_call`); `mcp:server/tool` (that specific tool); `skill:name` (the skill is attached in full). |
| `never_use` | Comma-separated tool names that must not be used. VS Code also accepts `mcp:server` and `mcp:server/tool` here. |
| `then_run` | A command line that must be run with `run_command` **after any file change**, e.g. `npm run lint` or `swift build`. Matching is "the command run contains this text". |
| `enabled` | `true` (default) or `false` / `no` / `0` / `off`. Toggled in Settings → Extensions → Commands. |
| Body | Extra instructions, shown to the model in the COMMANDS block. |

Values are single-line `key: value`; quotes around a value are stripped. The parser is the same small frontmatter
reader used for rules and skills (`SkillStore.frontmatter`, `frontmatter()`), not full YAML — so no lists, no
multi-line values.

## How enforcement works

```mermaid
flowchart TD
    M[Your message] --> A{which enabled commands' 'when' match?}
    A --> P[COMMANDS block straight after the persona<br/>skill: requirements attached in full]
    P --> T[Tool list: add must_use tools · add mcp_tools/mcp_call for mcp: · add run_command for then_run · remove never_use]
    T --> L[Model turn]
    L --> C{tool call?}
    C -- banned --> B[Blocked by the command … use X instead] --> L
    C -- allowed --> R[run (approval as usual) · record it] --> L
    C -- none --> Q{all requirements met?<br/>then_run owed?}
    Q -- yes --> Done[Finish · ⚑ chip]
    Q -- no, nudges < 2 --> N[hidden nudge: 'the command X requires you to … Do that now.'] --> L
    Q -- no, 2 nudges used --> W[Finish · ⚠ didn't follow X]
```

1. **Selection.** Commands are chosen once per request from the **latest real user message** (nudges don't count).
2. **Prompt.** A `## COMMANDS — you must obey these` block goes straight after the persona, listing each command's
   requirements in plain words ("You MUST use the figma MCP server (mcp_tools, then mcp_call with server "figma")
   before you finish", "Never use write_file", "After changing any file you MUST run: npm run lint"). The `INGLE.md`
   index also lists all enabled commands and their triggers.
3. **Tools.** Required tools are always offered (still approved per call as usual); banned ones are removed.
4. **Blocking.** If the model calls a banned tool anyway, the call isn't run; it gets "Blocked by the command "X":
   you must not use Y. Use Z instead."
5. **Recording.** Successful (approved) calls are recorded. An `mcp:` requirement is only met by an actual
   `mcp_call` to that server (and tool), not by just looking with `mcp_tools`. `skill:` requirements count as met
   because Ingle loads that skill into the prompt itself.
6. **`then_run`.** Any approved file change (Mac: `write_file`; VS Code: `edit_file`, `write_file`) makes the
   `then_run` command **owed**; a later `run_command` whose text contains it clears the debt.
7. **Completion check.** When the model tries to finish (a turn with no tool calls), anything still owed produces a
   hidden **nudge** message and another turn. Each command gets **at most 2 nudges**. After that the reply gets a
   `⚠ didn't follow <name>` chip, so you know.

Nudges are stored as user messages marked `nudge: true` (Mac, shown as a small note) or `hidden: true` (VS Code,
not shown). Regenerate removes them.

## Creating commands

Ask in a chat: *"write a command to always run the tests after editing"* or *"never let it use write_file in this
project"*. The assistant drafts it with **`command_create`** (offered when your message contains "command") and you
approve the card, which shows the exact file text. Or write the file yourself and run `/skill-reload` (VS Code) or
just send the next message.

`/commands` lists your commands (VS Code marks the ones that apply to your last message with ⚑). Settings →
Extensions → Commands (Mac) has an on/off switch for each and **Open Commands Folder**.

## Examples

**Always lint after edits**

```markdown
---
description: Lint after every change
when: always
then_run: npm run lint
---
```

**Use the project's search before guessing**

```markdown
---
description: Look things up in the code before answering questions about it
when: where is, how does, what calls
must_use: search_code
---
```

**Research needs sources**

```markdown
---
description: Research must use the web
when: research, latest, compare
must_use: web_search, web_fetch
---
Always end with a Sources list.
```

**Follow a skill for releases**

```markdown
---
description: Releases follow the release checklist
when: release, publish, version bump
must_use: skill:release-checklist
never_use: write_file
---
```

**A specific MCP tool**

```markdown
---
description: Tickets go through the tracker
when: ticket, issue
must_use: mcp:tracker/create_issue
---
```

## Mac vs VS Code differences

| | Mac app | VS Code |
|---|---|---|
| `when: always` | only when `always` is the sole value (or empty) | if `always` appears anywhere in the list (or empty) |
| `never_use` with `mcp:` | not supported (tool names only) | supported (`mcp:server`, `mcp:server/tool`) |
| Required tool not available (e.g. `web_search` with Web off) | the tool is **added anyway** from the full tool pool | the command is given up on immediately and marked ⚠ (no nudges) |
| File-changing tools for `then_run` | `write_file` | `edit_file`, `write_file` |
| Nudges | one command per nudge message | all owed commands in one nudge message |
| `command_create` | saves any command | refuses a command with no `must_use`, `never_use` or `then_run` ("that's just advice — use rule_create") |

The same in both: helpers (`delegate`) obey `never_use` (banned tools are hidden from them and blocked), and project
commands are listed alongside yours as `project/<name>`.

These differences are worth unifying; see [roadmap.md](roadmap.md).

## Trade-offs

| We chose | We gave up | Why |
|---|---|---|
| **Enforcement in the harness** (offer, block, check, nudge) | Trusting the prompt alone | Small models drop instructions mid-task. The harness knows exactly which tools were called, so it can check objectively. |
| **Nudges capped at 2** per command | Guaranteed compliance | A model that can't comply (wrong tool, server down) would otherwise loop forever. Two retries fix most lapses; ⚠ makes the rest visible instead of silent. |
| **Substring `when` matching** | Precision (`ui` also matches "build" and "quick") | Predictable and explainable — you can see why a command fired (⚑) and fix the trigger. Use longer phrases to avoid accidental matches. Semantic matching could replace it, at the cost of predictability. |
| **One file per command** (and per rule, skill, memory subject) | A single settings file | Easy to read, share, version, copy between projects and toggle; no merge conflicts between the two apps; matches how Claude and Cursor store skills and rules. |
| Requirements are about **tools**, not outcomes | Checking that the work is *correct* | Whether `npm run lint` passed, or a component matches Figma, can't be verified generically. Commands guarantee the steps happen; you still review the result (see [../TERMS.md](../TERMS.md)). |
| `then_run` matched by **substring** of the command line | Exactness | `npm run lint -- --fix` still counts as running `npm run lint`. It can be gamed (`echo npm run lint`), but the approval card shows the real command. |
