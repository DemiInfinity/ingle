import Foundation

/// ~/.ingle/INGLE.md — a short index of what the assistant can use. Only this goes into every chat;
/// the details (how Ingle works, skills, MCP tools) are loaded on demand with tools.
@MainActor
enum IngleManifest {
    static var url: URL { IngleHome.url.appendingPathComponent("INGLE.md") }
    private static let notesMarker = "<!-- Your notes: everything below this line is kept and sent to the assistant. -->"

    /// Builds the index, saves it to ~/.ingle/INGLE.md (keeping your notes), and returns it.
    static func refresh(macAccess: Bool, project: String? = nil, web: Bool = false, currentChat: UUID? = nil, code: Bool = false) -> String {
        let skills = SkillStore.all()
        let rules = RuleStore.all(project: project)
        let alwaysRules = rules.filter(\.always)
        let otherRules = rules.filter { !$0.always }
        let servers = MCPManager.shared.servers.filter { MCPManager.shared.isEnabled($0.name) }
        let notes = userNotes()

        var lines: [String] = []
        lines.append("# INGLE.md — what you have access to")
        lines.append("You're running inside Ingle. This is an index: load details with tools only when you actually need them.")
        lines.append("")
        lines.append("## Tools you always have")
        lines.append("- ingle_help(topic): how Ingle itself works. Topics: \(HelpTopics.names.joined(separator: ", ")).")
        if !skills.isEmpty { lines.append("- use_skill(name): load a skill's full instructions before doing a task it covers.") }
        if !otherRules.isEmpty { lines.append("- use_rule(name): load a rule from the rules index when it applies.") }
        if Prefs.memoryEnabled {
            lines.append("- memory_search, memory_read, memory_save, memory_rewrite, memory_forget: your long-term memory about the user.")
        }
        lines.append("- chat_list, chat_search, chat_read: the user's past chats.")
        lines.append("- report_search, report_read" + (web ? ", report_save" : "") + ": research reports from earlier web research.")
        lines.append("- delegate(task): hand a self-contained job to a read-only helper sub-agent.")
        lines.append("- skill_create, rule_create, command_create: build new skills, rules and commands (offered when the user asks for one).")
        lines.append("- web_search, web_fetch: " + (web ? "read-only web browsing (on in this chat)." : "off in this chat — tell the user to switch on Web in the message bar if they need it."))
        lines.append("")
        lines.append("## Terminal tools (always available; commands and writes ask the user first)")
        lines.append("- list_files, read_file: look at files" + (code ? " (free inside the project folder; outside it asks)." : "."))
        lines.append("- write_file, run_command: change things. The user approves each one.")
        let sshHosts: [String] = SSH.enabledHosts
        if !sshHosts.isEmpty {
            lines.append("- ssh_command(host, command, cwd): run a command on one of the user's servers (\(sshHosts.joined(separator: ", "))). The user approves each one.")
        }
        lines.append("")
        let macState: String
        if code { macState = " (off in Code mode — for it, the user starts a normal chat and switches on the Mac button)" }
        else if macAccess { macState = " (on in this chat)" }
        else { macState = " (off — tell the user to switch on the Mac button in the message bar, next to Think and Web, to let you control apps or see the screen)" }
        lines.append("## Mac control" + macState)
        lines.append("- open (apps, files, links), applescript (drive apps; System Events for clicks and typing), screenshot (see the screen). Each asks the user first.")
        if !servers.isEmpty {
            lines.append("- mcp_tools(server): see what an MCP server can do. mcp_call(server, tool, arguments): use one of its tools (needs approval).")
        }
        if let commands = CommandStore.indexSection(project: project) {
            lines.append("")
            lines.append(commands)
        }
        if !alwaysRules.isEmpty {
            lines.append("")
            lines.append("## Rules you always follow")
            for r in alwaysRules { lines.append(r.body) }
        }
        if !otherRules.isEmpty {
            lines.append("")
            lines.append("## Rules index (load with use_rule when one applies)")
            for r in otherRules {
                lines.append("- \(r.name)" + (r.description.isEmpty ? "" : " — \(r.description)"))
            }
        }
        if !skills.isEmpty {
            lines.append("")
            lines.append("## Skills (load with use_skill)")
            for s in skills {
                let d = s.description.count > 110 ? String(s.description.prefix(107)) + "…" : s.description
                lines.append("- \(s.name)" + (d.isEmpty ? "" : " — \(d)"))
            }
        }
        if !servers.isEmpty {
            lines.append("")
            lines.append("## MCP servers (look inside with mcp_tools; each mcp_call asks the user)")
            for s in servers {
                let state: String
                switch MCPManager.shared.status[s.name] ?? .stopped {
                case .running(let n): state = "\(n) tools ready"
                case .failed: state = "failed to start last time"
                default: state = "starts when you first use it"
                }
                lines.append("- \(s.name) — \(state)")
            }
        }
        if let reports = ReportStore.indexSection() {
            lines.append("")
            lines.append(reports)
        }
        if let store = ChatStore.current {
            let recent = store.conversations.filter { $0.id != currentChat && !$0.messages.isEmpty }
                .sorted { $0.updated > $1.updated }.prefix(8)
            if !recent.isEmpty {
                let f = DateFormatter()
                f.dateFormat = "d MMM"
                lines.append("")
                lines.append("## Recent chats (read with chat_read)")
                for c in recent { lines.append("- \(c.title) — \(f.string(from: c.updated))") }
            }
        }
        if let memory = MemoryStore.indexSection() {
            lines.append("")
            lines.append(memory)
        }
        lines.append("")
        lines.append(notesMarker)
        lines.append(notes.isEmpty ? "" : notes)

        let text = lines.joined(separator: "\n")
        IngleHome.ensure()
        try? text.write(to: url, atomically: true, encoding: .utf8)
        return text
    }

    static func userNotes() -> String {
        guard let existing = try? String(contentsOf: url, encoding: .utf8),
              let range = existing.range(of: notesMarker) else { return "" }
        return existing[range.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// The how-Ingle-works guide, split into topics the assistant loads with ingle_help.
enum HelpTopics {
    static let names = ["overview", "assistants", "menu-bar", "sleep", "autocomplete", "chat", "mac-access",
                        "settings", "models", "extensions", "web", "memory", "reports", "history", "builder", "commands", "helpers", "editors", "engine", "files", "ssh", "secrets", "code"]

    @MainActor
    static func text(_ topic: String) -> String {
        let t = topic.lowercased().trimmingCharacters(in: .whitespaces)
        let daily = Prefs.dailyName, hard = Prefs.hardName
        let sleep = Prefs.d.object(forKey: Prefs.K.sleep) as? Int ?? 15
        let sleepText = sleep < 0 ? "never (models stay loaded)" : "\(sleep) minutes"
        switch t {
        case "overview":
            return "Ingle is a menu-bar app plus a chat window for local AI models, with a matching chat for VS Code. It has the Ollama engine built in (it starts by itself and can be updated from Settings). Two main assistants: \(daily) for everyday coding and \(hard) for hard problems — and any other model can be given its own name and character. Everything runs on this Mac; nothing leaves it unless Web is on. Topics: \(names.joined(separator: ", "))."
        case "assistants":
            return "\(daily) = Daily coding on \(ModelNames.pretty(Prefs.dailyModel)): fast and low power. \(hard) = Hard jobs on \(ModelNames.pretty(Prefs.hardModel)): slower, smarter, best plugged in. Only one big model fits in memory at a time. Switch with the model pill in the message bar or from the menu bar. Settings → Models: names and personalities for both, and an Other models section to name any other downloaded model and write its character. Whatever the name or character, Ingle always adds the same facts about the app and its tools, so every model knows how Ingle works."
        case "menu-bar":
            return "The menu-bar icon is three connected dots and \"AI\": hollow and faded = asleep; top dot filled = \(daily) awake; all dots filled = \(hard) awake. Click it to switch assistant, Sleep Now, see autocomplete and memory, Open Chat (⌘O), Settings (⌘,), and More → Download Models, Restart AI Engine, Update AI Engine (when an update is out), Open Model Folder. Ingle shows in the Dock only while one of its windows is open; close them and it stays in the menu bar only."
        case "sleep":
            return "Models unload from memory after \(sleepText) unused, so the GPU goes idle. Change it in Settings → General → Sleep models after. Sleep Now in the menu frees memory straight away. On battery, Ingle warns before loading \(hard) (Settings → General → Warn when on battery)."
        case "autocomplete":
            return "Autocomplete in VS Code and Rider comes from \(ModelNames.pretty(Prefs.autoModel)) through the Continue extension, not from Ingle. Settings → General → Autocomplete: Smart (default) pauses it while \(daily) or \(hard) is awake to free memory and brings it back when they sleep; Always loaded; or On demand (left to Continue)."
        case "chat":
            return "⌘N new chat. Chat / Code at the top of the window (⇧⌘C) switches to Code mode for a project folder (see the code topic). Typing / in the message box opens a menu: /compact, /new, /mcp (dialog of MCP servers and whether they are connected), /skill-reload (re-read skills, rules and MCP servers), and every skill as /skill-name — sending \"/skill-name your request\" makes the assistant follow that skill. Sidebar: search, right-click to delete. Message bar: paperclip (or drag and drop) attaches files — code, documents (PDF, Word, RTF, Excel, Pages) are read as text, images (PNG, JPEG, HEIC…) are shown to models that can see images, otherwise their text is read with on-device OCR; long chats are compacted automatically at 75% of the context (the meter under the message box; Compact button, ⇧⌘K or typing /compact does it now) — older messages stay visible above an \"Earlier messages summarised\" divider but the model works from the summary; the model pill switches assistant; Think lets the model reason first (replies show \"Thought for Ns\"); the assistant can always use Terminal (asking before each command or file change), and the Mac button lets it control apps and see the screen (asking before each action); Allow for This Session stops the asking until Ingle quits, but only for the same thing: the exact same command in the same folder, writing files in the same folder, the same app, link or script, or the same MCP tool — the card says what it covers. Under each reply: Copy, Regenerate, speed in tokens per second. The This Mac card shows live CPU, memory and GPU. Long jobs: there is no small step limit — the assistant keeps working until the job is done, the user presses Stop, or it is clearly stuck repeating the same step (then it stops and says so; 200 steps is a backstop). Each turn only the tools the request needs are offered, which keeps small models accurate. The engine starts by itself when a message is sent."
        case "mac-access":
            return "Two levels. Terminal (always on): the assistant can list and read files — inside the workspace folders (\(Prefs.workspaceFolders.joined(separator: ", "))) without asking — and run Terminal commands and write files, each after an approval card: Deny, Allow for This Session (no more asking until Ingle quits for the same thing only: the exact command in the same folder, writing files in the same folder, reading the same outside folder; the card says what it covers) or Allow. Mac control (the Mac button in the message bar, per chat): the assistant can also open apps, files and links, drive apps with AppleScript (including clicks, menus and typing through System Events) and take screenshots to see the screen — each action asks first. Screenshots need Screen Recording permission for Ingle (System Settings → Privacy & Security). A small \"N allowed\" badge shows what is allowed this session; click it to be asked every time again. Workspace folders are in Settings → Mac Access. SSH (off by default, Settings → Mac Access → SSH) lets the assistant run commands on servers the user ticks there — see the ssh topic."
        case "settings":
            return "Settings tabs: General (sleep timer, switching, autocomplete, battery warning, menu-bar name, launch at login, engine status, server address, Engine updates: Check Now, Update Engine, Roll Back, Use Built-in, update notifications), Models (which model each assistant uses, each one’s context length, Get a model, names and personalities, Other models, downloaded models), Mac Access (workspace folders, SSH hosts), Secrets (saved passwords and keys, Touch ID for each use), Web & Memory, Extensions (INGLE.md, editors, Commands with on/off switches, matching, rules, skills, MCP servers), About."
        case "models":
            return "Settings → Models → Get a model: pick a recommended model or type any Ollama or Hugging Face name, choose Replace \(daily), Replace \(hard), Replace Autocomplete or add as a new model, optionally delete the old one, then Download. Context length: \(daily) \(Prefs.contextLength(for: Prefs.dailyModel) / 1024)K, \(hard) \(Prefs.contextLength(for: Prefs.hardModel) / 1024)K tokens; longer remembers more but uses more memory. MLX-format models run fastest on Apple Silicon."
        case "extensions":
            return "Everything editable lives in ~/.ingle: commands/ (rules Ingle enforces — see the commands topic), rules/ (one .md per rule; always: true rules are in every chat, the rest are listed in the rules index and loaded with use_rule), skills/<name>/SKILL.md (skills in Claude's format; ~/.claude/skills can be included), mcp.json (MCP servers, Claude Desktop/Cursor format), and INGLE.md (this index; the user's notes at the bottom are kept). Servers in ~/.cursor/mcp.json and ~/.claude.json are picked up automatically. Settings → Extensions manages all of it."
        case "web":
            return "The Web pill in the message bar (on by default; Settings → Web & Memory) gives read-only browsing: web_search and web_fetch. No logins, cookies, forms or JavaScript, and nothing on the local network. Search uses DuckDuckGo by default, or the user's own SearXNG, or Brave Search. For research: several searches, read the best sources, answer with a Sources list."
        case "memory":
            return "Long-term memory lives in ~/.ingle/memory as Markdown, one file per subject (about-me, preferences, work, projects, people…), each with a one-line description. The memory index is in every chat; memory_search and memory_read look things up, memory_save adds a fact, memory_rewrite and memory_forget correct or remove. Matching memories are also attached automatically. Settings → Web & Memory: switch memory off, Ask before saving, open or edit files, Forget Everything. Passwords, keys and card numbers are never saved in memory — they belong in the secrets store (see the secrets topic)."
        case "reports":
            return "After web research the assistant saves a short report (title, summary, findings, sources) to ~/.ingle/research. The research index is in every chat, report_search and report_read recall them, and matching reports are suggested to the assistant (it opens one with report_read if it applies), so research builds up over time instead of being redone. Settings → Web & Memory → Research reports opens the folder."
        case "history":
            return "The assistant can look back through the user's other chats: chat_list (recent chats), chat_search (find something said before) and chat_read (open one). The newest few chat titles are listed in every chat."
        case "builder":
            return "Ask the assistant to make a skill or a rule (\"make me a skill for code reviews\") and it drafts one and saves it with skill_create or rule_create after the user approves the card. Skills go to ~/.ingle/skills, rules to ~/.ingle/rules, and they appear in the indexes straight away."
        case "commands":
            return "Commands are rules Ingle enforces, not just suggests — the obedience layer. Each is a file in ~/.ingle/commands (or a project's .ingle/commands) with: when (trigger words, or always on its own), must_use (tool names, mcp:server, mcp:server/tool, skill:name), never_use (tool names, mcp:server, mcp:server/tool), then_run (a command to run after any file change). When a command applies, it appears in a COMMANDS block; its required tools are always offered (unless switched off, e.g. web_search with Web off — then the reply is marked \"⚠ didn’t follow\" with the reason straight away); banned tools are blocked, for helpers too; and the assistant can't finish until the requirements are met (Ingle sends it back up to twice, listing everything owed in one reminder, then marks the reply \"⚠ didn’t follow\"). command_create won't make a command with no must_use, never_use or then_run — that's a rule (rule_create). Replies show ⚑ for commands in force. Make one by asking (\"write a command to always use the figma MCP for component builds\") — the assistant drafts it with command_create and you approve it. /commands lists them; Settings → Extensions → Commands turns them on or off. Shared with Ingle for VS Code."
        case "helpers":
            return "delegate(task) hands a self-contained job to a helper sub-agent with a fresh, empty context. Helpers can only read (web if on, memory, reports, past chats, skills, rules, and workspace files), can't change anything or start more helpers, and report back. They run one at a time on the same model, because only one big model fits in memory."
        case "editors":
            return "Ingle for VS Code (Extensions/vscode, install with ./install.sh) is a full Ingle chat for coding that opens as an editor tab: click the orange Ingle icon at the top right of the editor (next to Claude’s) — each click opens another tab with its own chat; ↗ pops a tab into its own window; tabs are named after their chat and come back after a restart. It reads the project, searches code, sees problems, edits files with a diff to approve, runs commands, and gets a repo map — an outline of the project’s files and key functions ranked for each request (repo_map tool for more). It shares ~/.ingle with this app (assistants, rules, skills, commands, memory, research) and works without this app open. Right-click → Ask Ingle About This (⌘⌥I), Explain or Fix This Problem. Rider is followed through its window title (Settings → Extensions → Follow Rider). Projects’ AGENTS.md, CLAUDE.md and .ingle/rules are loaded automatically."
        case "engine":
            return "Ingle runs its built-in Ollama engine and starts it by itself — when the app opens, when a chat opens, and before replying if it has stopped — so there’s nothing to press; if the Ollama app is already running, Ingle uses that instead. Updates: Settings → General → Engine updates checks GitHub once a day and sends a notification when a newer Ollama is out; Update Engine downloads it, checks it against Ollama’s published checksum and switches to it without touching models; Roll Back returns to the previous engine and Use Built-in to the one that shipped with Ingle. More → Restart AI Engine in the menu bar restarts it. Settings → General → Server address can point at another computer running Ollama (e.g. a home AI server over Tailscale); commands and file changes still happen on this Mac. Engine log: ~/Library/Logs/Ingle/ollama.log."
        case "ssh":
            let hosts: [String] = SSH.enabledHosts
            let state: String = Prefs.sshEnabled ? (hosts.isEmpty ? "SSH is on but no host is ticked." : "SSH is on for: \(hosts.joined(separator: ", ")).") : "SSH is off."
            return "SSH lets the assistant run commands on the user's own servers (a home server, NAS, dev box, Raspberry Pi) with ssh_command. \(state) Settings → Mac Access → SSH: switch it on, then tick hosts. Only plain Host entries from ~/.ssh/config can be ticked (no wildcards), and only ticked hosts are used — raw addresses like user@1.2.3.4 are refused. It runs the Mac's own ssh with keys or ssh-agent only (BatchMode), so Ingle never asks for, stores or types passwords. Unknown or changed host keys fail safely: connect once in Terminal (ssh name) first. Every command asks first and the card shows the host; Allow for This Session covers only the same command on the same host and folder. Same limits as Terminal commands: 2 minutes, long output trimmed, Stop ends it. The SSH tool is only offered when the message mentions ssh, a server, remote or a ticked host name."
        case "secrets":
            let saved: [String] = Secrets.names()
            let list: String = saved.isEmpty ? "No secrets are saved yet." : "Saved secrets: \(saved.joined(separator: ", "))."
            return "The secrets store keeps passwords, tokens and keys in the macOS Keychain (service Ingle) — never in chats, memory, logs or ~/.ingle, which only lists names and descriptions in secrets.json. \(list) If a message looks like it has a secret in it (a GitHub or API key, a private key, \"my password is …\"), Ingle asks first: Save as Secret (the message then says {{secret:name}} instead), Send Anyway or Cancel. Add, rename, describe or delete secrets in Settings → Secrets or with /secret; a value is shown there only after Touch ID. Assistants list names with secret_list and use one by writing {{secret:name}} in a tool argument (run_command, ssh_command, write_file, open, applescript, MCP calls) — there is no tool that reads a value. Every use asks, with a \"Uses secret\" line saying where it goes and no Allow for This Session; Touch ID follows if it's on (it is by default). Only then is the value put in: commands get it through an environment variable (INGLE_SECRET_NAME) so it isn't in the command line; writing it to a file shows a plain-text warning. Output that shows a value (or its base64) is changed back to {{secret:name}} before the assistant or the chat history sees it. Ingle for VS Code gets values from this app (Touch ID or a dialog here) or, if it isn't open, from macOS's own Keychain prompt."
        case "code":
            return "Code mode works on a project folder, the way Claude Code does. Switch with Chat / Code at the top of the chat window or ⇧⌘C; a new Code chat asks for a folder (Choose Folder…, drop a folder in, or a recent project), shown as a chip with its git branch (changeable until the first message). The sidebar follows the mode: Code chats grouped by project in Code mode, normal chats by date in Chat mode. In Code mode the project folder is the workspace: listing and reading inside it needs no approval, reading outside it asks, and writing files and running commands always ask (with the usual Allow for This Session scopes). Relative paths and commands without a folder use the project folder. The assistant gets a coding prompt plus the project's folder, git branch, short git status and its AGENTS.md / CLAUDE.md / .cursorrules, and the project's .ingle rules and commands. Mac control is off in Code mode (its button is hidden); Web stays opt-in. ⌘N in a Code chat starts another on the same project."
        case "files":
            return "Chats: ~/Library/Application Support/Ingle/chats.json. Images in chats: ~/Library/Application Support/Ingle/images. Updated engines: ~/Library/Application Support/Ingle/Engine. Config: ~/.ingle (rules/, skills/, commands/, memory/, research/, mcp.json, INGLE.md, settings.json shared with VS Code, bridge-token, secrets.json with secret names only — values are in the Keychain). Models: ~/.ollama/models. Engine log: ~/Library/Logs/Ingle/ollama.log."
        default:
            return "No help topic called \(topic). Topics: \(names.joined(separator: ", "))."
        }
    }
}
