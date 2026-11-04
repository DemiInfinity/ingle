# Troubleshooting

Common problems and how to fix them. If yours isn't here, open an issue with what you did, what you expected and
what happened (leave out anything personal).

## Building

**`./build.sh` fails with a Swift error.** Look at the first `error:` line.
- *"the compiler is unable to type-check this expression in reasonable time"* — split the expression into `let` steps
  with explicit types.
- *"'await' cannot appear to the right of a non-assignment operator"* or an `await` in an autoclosure — compute the
  value first (`let running = await …`), then use it.
- *"main actor-isolated … can not be referenced from a nonisolated context"* — mark the caller `@MainActor`.
- More in the **Swift pitfalls** section of [../CLAUDE.md](../CLAUDE.md).

**"Swift isn't installed".** Run `xcode-select --install` (or install Xcode) and try again.

**"Couldn't find the ollama engine".** The build couldn't copy or download the engine. Check your network and run
again; it uses `/Applications/Ollama.app`, then `~/.local/share/ingle-runtime`, then GitHub.

**"The slimmed engine doesn't start — restoring the full one".** Not an error: the build kept the full engine.
Try a different `INGLE_MLX` value if you want it smaller.

**The app won't open ("can't be opened" / "unidentified developer").** It's ad-hoc signed. Right-click the app →
Open, once.

## The app behaves like an old version

You rebuilt, but the assistant still says or does old things (for example, claims Terminal needs the Mac button).
- Make sure you ran `./build.sh --install`, not just `./build.sh`, if you open Ingle from `/Applications`.
- Quit Ingle fully (menu bar → Quit) and reopen it.
- Start a **new chat**: old chats keep their old system prompt in the history the model sees.

## The engine

**Chat says the engine isn't running.** It starts automatically when you send a message. If it doesn't:
- Something else may be using port 11434. If that's your own Ollama, Ingle uses it instead of starting its own —
  that's expected. Otherwise quit the other program.
- Settings → General shows the engine version and lets you **Roll Back** or **Use Built-in** if an engine update
  misbehaves (see [engine.md](engine.md)).

**The `ollama` command in Terminal stopped working after removing the Ollama app.** Run `./build.sh --install`; it
links `~/.local/bin/ollama` to Ingle's engine. Make sure `~/.local/bin` is on your `PATH`.

**Replies are very slow or the Mac swaps.** The model is too big for your memory. Pick a smaller model or a smaller
quantisation in Settings → Models, and close other heavy apps.

## The assistant

**It doesn't use a tool it obviously needs.** Tools are filtered per message to help small models choose. Mention
what you want ("search the code for…", "use the figma MCP"), or make it certain with a command
([commands.md](commands.md)).

**It keeps repeating the same tool call.** The repeat guard skips the third identical call and stops after four skips
("stuck"). Rephrase, give it the missing piece of information, or try the bigger assistant (Flint).

**It ignored a skill or rule.** Matched skills and rules are only *suggested*; the chips under a reply show what it
actually opened. If it must always happen, write a command.

**⚠ didn't follow <command>.** It was nudged twice and still didn't do what the command requires. Check the
command's `must_use` is available in this chat (Web on for `web_search`, the MCP server connected), and that the
`when` phrases aren't firing by accident.

**The context meter is nearly full.** Ingle compacts automatically at about 75%; you can also use `/compact` or
⇧⌘K. Earlier messages stay visible above the "Earlier messages summarised" divider.

**It says it can't run commands.** Terminal tools are always available but every command needs your approval
(Deny / Allow for This Session / Allow). The **Mac** button is only for controlling apps, AppleScript and
screenshots. If it still says otherwise, see "The app behaves like an old version" above.

## Mac control

**AppleScript or opening apps fails.** macOS needs to allow it: System Settings → Privacy & Security →
**Automation** (and **Accessibility** for UI scripting). Allow Ingle, then try again.

**Screenshots are blank or only show the desktop.** Allow Ingle under Privacy & Security → **Screen Recording**,
then quit and reopen Ingle.

**Permissions keep being asked for after every rebuild.** macOS ties them to the bundle identifier and signature.
Keep the same `INGLE_BUNDLE_ID` in `local.env` (see [building-and-releasing.md](building-and-releasing.md)).

## VS Code

**`install.sh` can't find VS Code.** Add VS Code's `code` command to your `PATH` (Command Palette → "Shell Command:
Install 'code' command in PATH"), or set `VSCODE_APP` in `local.env` to where VS Code lives.

**My chat history disappeared after reinstalling.** VS Code keys stored data by publisher and name. Set
`VSCODE_PUBLISHER` in `local.env` to the publisher you used before and reinstall.

**I can't see the Ingle icon.** It's in the editor title bar (top right of an editor). Open any file, or run
**Ingle: New Ingle Chat Tab** from the Command Palette.

**Approvals keep coming back.** "Allow for This Session" lasts until VS Code (or the Mac app) quits. Clear them any
time with **Ingle: Ask Before Every Action Again**.

**MCP servers don't connect.** Run `/mcp` to see each server's state. Check `~/.ingle/mcp.json` (the command must
exist and run from a terminal), then `/skill-reload`.

## Still stuck

Ask the assistant: it can read its own help (`ingle_help`) and your `~/.ingle` index. Otherwise open an issue on
GitHub using the bug report template.
