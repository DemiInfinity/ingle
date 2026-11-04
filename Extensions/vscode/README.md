# Ingle for VS Code

Ingle's chat in VS Code, for coding — like Claude's, but with your own local models. Click the Ingle icon
in the editor title bar (top right, next to Claude's) and it opens as a tab beside your code. Click it again for another
chat in its own tab (each tab works on its own chat); the ↗ button pops a tab out into its own window.
It talks to Ollama directly, so **the Ingle Mac app doesn't need to be open** (if no engine is running,
it starts the one bundled inside Ingle.app). It shares `~/.ingle` with the Mac app: Ember and Flint's names
and personalities, rules, skills, memory, research reports and MCP servers.

- **Chat** (⌘⌥L or the Ingle icon in the editor title bar): pick Ember or Flint, switch Think and Web, see what it's doing.
- **It can work in your project**: read files, search code, see problems, edit files (you approve each change, with
  a diff), write files and run commands (approval first). Undo works for edits.
- **Files and images**: attach with the paperclip, paste or drag in — PDFs, Word, Excel, Pages, code, and images
  including HEIC. Models that can't see images get the text read from them.
- **Long chats compact themselves** at 75% of the context, like Claude. Type `/compact` to do it now.
- **Right-click** → Ask Ingle About This (⌘⌥I), Ask Ingle to Explain This Problem, or Fix This Problem.
- Code blocks in replies have **Copy, Insert and Apply** buttons.

Everything stays on this Mac. Install: `./install.sh` (replaces the old Ingle Bridge extension).
- **Dragging from Finder:** hold Shift while dropping onto the chat, or VS Code opens the file in the editor instead.
