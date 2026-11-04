# Privacy Policy

*Applies to the Ingle Mac app and Ingle for VS Code. Last updated: 4 November 2026.*

**The short version:** Ingle runs on your Mac. It has no accounts, no servers, no analytics and no tracking.
We — the people who make Ingle — never receive your chats, files, memories or anything else you do in it.
The only times Ingle connects to the internet are listed below, and most of them happen only when you ask.

## What Ingle stores, and where

Everything Ingle keeps is stored on your own Mac, in ordinary files you can open, back up or delete:

| What | Where |
|---|---|
| Chats and images you attach (Mac app) | `~/Library/Application Support/Ingle/` |
| Chats (VS Code) | VS Code's private storage for the extension |
| Memory, rules, skills, commands, research reports, MCP server settings | `~/.ingle/` |
| Settings | macOS preferences for the app; `~/.ingle/settings.json` (shared with VS Code) |
| Secrets you save (passwords, tokens, keys) | The macOS Keychain only; `~/.ingle/secrets.json` lists their names, never the values |
| AI models | `~/.ollama/models` |
| Engine log | `~/Library/Logs/Ingle/ollama.log` |

**Memory** is written by the assistant when it learns something useful about you (you can turn memory off, or
make it ask first, in Settings → Web & Memory). It skips things that look like passwords, keys or card numbers.
You can read, edit or delete any memory file yourself.

**Secrets.** If a message looks like it contains a password or key, Ingle offers to save it in your Keychain instead,
so the chat only says `{{secret:name}}`. The AI model never sees a saved value. When the assistant wants to use one,
you approve that use each time (with Touch ID, if it's on), and Ingle puts the value in only then — for example into
a command you approved, which sends it wherever that command sends it. Output that shows the value is changed back to
the name before it's kept. Ingle for VS Code gets values from the Mac app on your Mac (or from macOS's Keychain
prompt), never over the network.

**Briefs for a cloud AI.** When a job seems beyond the local model, Ingle can prepare a short written brief you
could give another AI assistant. It's only shown to you to copy, and saved as a file in your project's
`.ingle/briefs` folder (or `~/.ingle/briefs`). Ingle never sends it anywhere: if you paste it into a cloud service,
that service's privacy policy applies. Saved secrets are replaced with their names, anything that looks like a key or
password is removed, and your home folder and username are hidden unless you switch that off.

The AI models run on your Mac through the built-in Ollama engine. Your messages are processed on your Mac and
are not sent to an AI company.

## When Ingle connects to the internet

| When | What is sent | To whom |
|---|---|---|
| **Web is switched on in a chat** and the assistant searches | The search words | DuckDuckGo by default, or the SearXNG server or Brave Search you set up in Settings |
| **Web is on** and the assistant reads a page | A normal request for that page (no cookies, no logins) | The website |
| **You download a model** | A request for that model | The Ollama model library or Hugging Face, depending on the model |
| **Checking for engine updates** (once a day; can be turned off in Settings → General) | A request for the latest version number | GitHub (`api.github.com`) |
| **You update the engine** | A download request | GitHub |
| **You approve a command, an MCP tool or opening a link** | Whatever that command, tool or link does | The service it talks to |
| **SSH is on and you approve a command on one of your servers** | That command, through your own SSH setup | Only that server, one you set up in `~/.ssh/config` and ticked in Settings → Mac Access → SSH |

Ingle blocks the assistant's web reading from reaching addresses on your local network, and the web tools only read
— they can't log in, fill in forms or post anything. Like any website visit, the sites and search services
you reach can see your IP address; their own privacy policies apply.

Ingle doesn't send crash reports, usage statistics or identifiers. There is no "phone home".

## Your files and your Mac

Ingle can only see your files when you let it: **Mac access** is off by default in each chat, and in VS Code the
assistant works inside the project you have open. Changing files, running commands, opening apps and using
MCP tools each show an approval card first. **SSH** (off by default) connects only to servers you configured and
ticked, only when you approve a command; Ingle uses your SSH keys or ssh-agent, never asks for or stores passwords,
and sends nothing anywhere else. Files you attach are read on your Mac. Text in images is read by
macOS on your Mac when the model can't see images.

## Other software

- **Ollama** (the built-in engine) runs locally. Ingle doesn't turn on any of Ollama's online or account features.
- **VS Code** and **Cursor** have their own telemetry and privacy policies, which Ingle doesn't control.
- **MCP servers** you add are separate programs; what they do with data is up to them and their makers.
- **Models** are made by others; downloading one is subject to its maker's licence.

## Children

Ingle isn't directed at children, and we don't knowingly collect anything from anyone — we don't collect data at all.

## Your rights

Because we don't collect or receive your personal data, there's nothing for us to give you a copy of, correct
or delete — it's all on your Mac, under your control. To remove everything, quit Ingle, delete the app, and
delete the folders in the table above.

If you're in the UK or EU: in data-protection terms we don't act as a controller or processor of your data
when you use Ingle, because none of it reaches us.

## Changes

If Ingle ever starts connecting to anything new, this page will be updated before that version is released,
and the change will be listed in the release notes.

## Contact

Questions about privacy: open an issue at https://github.com/DemiInfinity/ingle or contact the copyright holder named
in [LICENSE.md](LICENSE.md).

*This policy describes how the software behaves. It isn't legal advice.*
