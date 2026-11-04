# What's new in Ingle

The newest changes come first. Ingle is an early preview, so changes are grouped by date until there are numbered
releases. Every change people can notice gets a line here. Ask the assistant "what's changed?" to hear it summarised.

## 4 November 2026

### New
- **Code mode** (Mac app): work on a project folder the way Claude Code does. Switch with the Chat / Code icons at
  the top of the sidebar (⇧⌘C). Code chats are grouped by project, reading inside the project needs no approval, and
  the assistant gets coding tools: find files, search code, a repo map, check for problems, and edits shown as a diff
  to approve.
- **Modes** in the message box: **Ask** (everything asks first), **Edit** (file changes in the project go ahead),
  **Auto** (also safe commands; risky ones still ask), **Plan** (read only, ends with a plan to approve) and
  **Debug** (find and prove the cause before fixing). ⇧Tab cycles them.
- **Effort** in the message box: Low, Medium, High or Max, for how thorough the assistant is. High and Max run your
  project's checks after editing; Max plans first and has its changes reviewed.
- **Reasoning switch** (the brain icon): off by default for fast, direct answers. Switch it on for deep research and
  hard problems: Ingle summarises the chat, researches, prepares a context report and lets the model think, showing
  each stage in the reply.
- **Task list, plans and commits:** bigger jobs get a live task list; plans are saved as Markdown files in
  `.ingle/plans/` (Approve runs your edited version); a changes panel lists every diff, with **Commit** (never pushes).
- **Undo this run:** every file a reply changes is backed up first, so the whole run can be put back in one click.
- **Steer while it works:** type while the assistant is working and it reads your message at its next step.
- **Code intelligence:** exact answers to "what calls this?", "what does this change affect?" and type errors, from
  the language servers on your Mac, with no approval prompts. Also available to other apps as an MCP server
  (`ingle-code`).
- **Secrets store:** passwords and keys you give Ingle go in the macOS Keychain. The assistant only sees a placeholder,
  every use asks first (Touch ID if you like), and they're scrubbed from output.
- **SSH:** run commands on your own servers (hosts from `~/.ssh/config` that you tick in Settings), each approved.
- **Thinking-loop protection:** if the model's thinking starts repeating, Ingle stops it and asks for a direct answer.
  An optional small model can also spot reasoning that goes in circles.
- **Catch up:** the chat follows new text while you're at the bottom; scroll up to read and a **Catch up** button
  brings you back.
- **What's new:** this list, in Settings → About and through the assistant.
- **The assistant knows its settings:** every message tells it which assistant, Effort, Mode, Reasoning, Web, Mac
  control, SSH and editor sharing are on, and what each means, so it won't claim to browse with Web off and can suggest
  a better setting.
- **Reasoning in VS Code too:** the brain pill works the same in both apps.

### Changed
- **Settings apply when you press Enter:** changing Model, Effort, Mode, Reasoning, Web or Mac while a reply is
  running no longer changes that reply; it applies to your next message.
- **Effort describes care, not thinking:** thinking is now only the Reasoning switch's job.
- **No thinking tag with Reasoning off:** replies made without thinking no longer show "Thinking…" or "Thoughts".
- **Licence:** now open source under the AGPL-3.0, with one extra term: keep the credit "Based on Ingle by DemiInfinity"
  visible. Removing it, or keeping changes private, needs a commercial licence.
- **Safer approvals:** "Allow for This Session" now covers only the same action (the same command in the same folder,
  writes in the same folder, the same MCP tool), not every use of a tool.
- **Commands** behave the same in the Mac app and VS Code.
- **Opening Ingle** starts a blank new chat; empty chats aren't saved.
- **The top bar is empty;** Chat / Code moved to icons at the top of the sidebar, and chat controls live in the message
  box. The Effort pill matches the other pills.
- **Switching models** in the message box now wakes that model, and the menu bar shows who's awake.
- **Qwen models** get their anti-repetition setting while thinking too, and Ember's download gets the right
  tool-call format automatically.

### Fixed
- The context meter showed about 18% on a brand-new chat; it now starts at 0%.
- Three VS Code extension bugs found by the new test suite.
- Auto mode now also checks commands hidden in backticks or `$( )`, and one-line `python -c` / `node -e` scripts.

### Coming next
Coverage checks (nothing affected gets missed), a preview pane for Markdown, HTML and more, a "second opinion" button,
background jobs that report back into the chat, a command-line `ingle`, a project map, and a benchmark with real numbers.

## Earlier on 4 November 2026
- First public preview: the Mac app (menu bar, chat window, built-in engine, Mac control, memory, web research, skills,
  rules, commands, MCP) and the VS Code extension.
