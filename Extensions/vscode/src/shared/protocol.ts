// Messages between the extension host and the chat webview (media/chat.js).
// Both sides must use exactly these shapes.

export type Role = 'user' | 'assistant' | 'tool';

export interface ToolInfo {
  name: string;
  title: string;      // "Run a command"
  detail: string;     // the command / path / query
  icon: string;       // codicon name without "codicon-", e.g. "terminal", "file", "globe", "search", "edit", "book", "person"
  output?: string;    // tool result text (shown collapsed)
  denied?: boolean;
  /** Set when the chat's mode approved this call without asking, e.g. "Auto approved (Edit mode): …". */
  auto?: string;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;              // Markdown for assistant/user; tool output for tool rows lives in tool.output
  thinking?: string;
  assistantName?: string;       // "Ember"
  model?: string;               // pretty model name, e.g. "Qwen3.6 35B"
  tool?: ToolInfo;
  usedContext?: string[];       // rules/skills/memories attached automatically
  stats?: { tokensPerSecond: number; seconds: number };
  failed?: boolean;
  thoughtSeconds?: number;
  /** Images attached to a user message (thumbnails shown in the bubble). */
  attachments?: Attachment[];
  /** A compaction marker: content is the summary of everything before it. The UI shows a divider
   *  "Earlier messages summarised" that expands to show the summary. */
  compaction?: { summarisedCount: number; auto: boolean };
  /** Set on the last reply of a run that changed files: what "Undo this run" would do (paths shown tidied). */
  checkpoint?: RunCheckpoint;
  /** A user message typed while a run was going: it joined the run at the model's next step. */
  steer?: boolean;
  /** A plan saved as a Markdown file (tools/planFiles.ts): shown as a card with Open, Edit and (in Plan mode) Approve. */
  plan?: { file: string; name: string; status: 'draft' | 'approved' | 'done' };
  /** Coverage (task 34): affected places the run never looked at, shown as "⚠ N affected places not checked".
   *  Paths are relative to the workspace, lines 1-based. */
  coverage?: { places: { path: string; line: number }[] };
}

/** One item on the chat's task list (update_tasks; see tools/tasks.ts). */
export interface TaskItem { content: string; status: 'pending' | 'in_progress' | 'done' }

/** One file in a run's changes panel. `path` is absolute (used for Open / Diff), `display` tidied. */
export interface RunChangeFile {
  path: string;
  display: string;
  action: 'restore' | 'remove' | 'recreate';
  diff: string;
  added: number;
  removed: number;
}

/** A run's checkpoint as the webview sees it (see tools/checkpoints.ts). */
export interface RunCheckpoint {
  run: string;
  files: { path: string; action: 'restore' | 'remove' | 'recreate' }[];
  undone?: boolean;
  /** Short hash once the run's files were committed with the Commit button. */
  committed?: string;
}

/** A file the user attached in the composer (paste, drag-drop or the paperclip). */
export interface Attachment {
  name: string;
  mime: string;          // image/png, image/jpeg, image/heic, application/pdf, text/plain, …
  dataBase64?: string;   // for images and documents picked in the webview (≤ 20 MB)
  path?: string;         // when it came from the workspace / file picker on the extension side
  thumbnail?: string;    // small data: URL for display (images only; the engine fills this for HEIC)
}

export interface ChatSummary { id: string; title: string; updated: number; assistantId: string }

export interface EditorContextInfo {
  project?: string;     // folder name
  file?: string;        // file name
  language?: string;
  hasSelection: boolean;
  problems: number;
}

export interface ApprovalRequest {
  id: string;
  kind: 'command' | 'write' | 'edit' | 'open' | 'mcp' | 'memory' | 'skill' | 'rule' | 'read' | 'ssh';
  title: string;        // "Ember wants to run a command"
  detail: string;       // command text, file path, or JSON
  preview?: string;     // e.g. a unified diff for edits, or file content for writes
  canShowDiff?: boolean; // true for edits: the webview shows a "View Diff" button
  sessionScope?: string; // what "Allow for this session" covers, e.g. "“npm test” in Ingle"
  /** Secrets this call uses (names only). Such a card never offers "Allow for this session". */
  secrets?: string[];
  secretLine?: string;    // "Uses secret: github-token → a command on this Mac"
  secretWarning?: string; // "This writes github-token to disk in plain text."
  noSession?: boolean;    // hide "Allow for this session"
}

/** An entry in the "/" menu. Commands: compact, new, mcp, skill-reload. Skills: every skill by name. */
export interface SlashItem { name: string; detail: string; kind: 'command' | 'skill' }

export interface MCPServerInfo {
  name: string;
  source: string;                // "Ingle", "Cursor", "Claude Code"
  command: string;               // command line, for display
  enabled: boolean;
  state: 'connected' | 'not-connected' | 'failed' | 'off';
  detail: string;                // "Connected · 4 tools" / "Connected in the Ingle app only" / error text
  tools?: string[];
}

export interface UIState {
  assistants: { id: string; name: string; role: string; model: string }[]; // role: "Daily coding" / "Hard jobs"
  currentAssistant: string;   // assistant id
  /** This chat's effort level (src/engine/effort.ts). */
  effort: 'low' | 'medium' | 'high' | 'max';
  /** Tooltip text per level, from the effort table. */
  effortHelp: Record<'low' | 'medium' | 'high' | 'max', string>;
  web: boolean;
  useContext: boolean;
  chats: ChatSummary[];
  chatId: string;
  messages: ChatMessage[];
  context?: EditorContextInfo;
  engine: { state: 'starting' | 'ready' | 'offline'; text: string };
  /** Whether the current assistant's model can see images (Ollama /api/show capabilities include "vision"). */
  vision?: boolean;
  contextUsage?: { used: number; limit: number };
  slashItems?: SlashItem[];
  /** The extension's version, e.g. "0.2.0". */
  version?: string;
  /** The chat's task list (pinned under the latest reply). */
  tasks?: TaskItem[];
  /** The chat's work mode (Mode pill; ⇧Tab cycles). Plan: read/search only, ends with a plan to Approve. */
  workMode?: 'ask' | 'edit' | 'auto' | 'plan' | 'debug';
  /** Label, short role and tooltip per mode, from engine/modes.ts. */
  modes?: { id: 'ask' | 'edit' | 'auto' | 'plan' | 'debug'; label: string; role: string; help: string }[];
  /** Messages typed while the run is going, waiting for the model's next step. */
  queued?: { id: string; text: string }[];
}

// Extension → webview
export type ToWebview =
  | { type: 'init'; state: UIState }
  | { type: 'messageAdd'; message: ChatMessage }
  | { type: 'messageDelta'; id: string; content?: string; thinking?: string }   // append text while streaming
  | { type: 'messageUpdate'; message: ChatMessage }                             // replace a whole message
  | { type: 'status'; streaming: boolean; activity: string | null }
  | { type: 'approval'; approval: ApprovalRequest }
  | { type: 'approvalClear' }
  | { type: 'context'; context?: EditorContextInfo }
  | { type: 'engine'; state: 'starting' | 'ready' | 'offline'; text: string }
  | { type: 'chats'; chats: ChatSummary[]; chatId: string }
  | { type: 'prefill'; text: string }
  | { type: 'attachments'; attachments: Attachment[] }                           // add to the composer (from the file picker)
  | { type: 'contextUsage'; used: number; limit: number }                        // estimated tokens, for a small meter
  | { type: 'slashItems'; items: SlashItem[] }                                   // after /skill-reload
  | { type: 'mcp'; servers: MCPServerInfo[] }                                    // open the /mcp dialog with this list
  | { type: 'notice'; text: string }                                            // short note under the composer (fades after ~4 s)
  /** The message looks like it has a secret in it: ask Save as secret / Send anyway / Cancel. Nothing is stored or
   *  sent until the user answers. `preview` is a masked hint ("ghp_…"), never the value. */
  | { type: 'secretPrompt'; requestId: string; found: { kind: string; suggested: string; preview: string }[] }
  | { type: 'secretPromptClear' }
  /** Answer to undoRun when it didn't happen: files changed after the run (offer "Undo anyway"), or another reason. */
  | { type: 'undoRefused'; id: string; message: string; canForce: boolean }
  | { type: 'tasks'; tasks: TaskItem[] }                                        // the task list changed
  | { type: 'workMode'; mode: 'ask' | 'edit' | 'auto' | 'plan' | 'debug' }   // e.g. back from Plan after Approve
  | { type: 'queued'; items: { id: string; text: string }[] }                    // steering messages still waiting
  /** The changes panel under reply `id`: each file's diff, and the repo when Commit is possible (else why not). */
  | { type: 'runChanges'; id: string; files: RunChangeFile[]; repo?: string; noCommit?: string }
  | { type: 'commitDraft'; id: string; message: string }                        // a drafted message to edit
  | { type: 'commitFailed'; id: string; message: string };

// Webview → extension
export type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; text: string; attachments?: Attachment[] }
  /** The answer to a secretPrompt. 'save' stores each value in the Keychain (names in the same order as `found`) and
   *  sends the message with placeholders; 'send' sends it as typed; 'cancel' puts it back in the message box. */
  | { type: 'secretDecision'; requestId: string; decision: 'save' | 'send' | 'cancel'; items?: { name: string; description: string }[] }
  | { type: 'compact' }                                   // "Compact chat" button or the /compact command
  | { type: 'slash'; name: string }                       // a command picked from the "/" menu: 'new' | 'mcp' | 'skill-reload' | 'compact'
  | { type: 'mcpRefresh' }                                // Reload button in the /mcp dialog
  | { type: 'openMcpConfig' }                             // Edit mcp.json button
  | { type: 'pickFiles' }                                 // paperclip: the extension shows a file picker
  | { type: 'stop' }
  | { type: 'newChat' }
  | { type: 'openChat'; id: string }
  | { type: 'deleteChat'; id: string }
  | { type: 'setAssistant'; id: string }
  | { type: 'toggle'; key: 'web' | 'useContext'; value: boolean }
  | { type: 'setEffort'; effort: 'low' | 'medium' | 'high' | 'max' }
  | { type: 'approve'; id: string; decision: 'allow' | 'deny' | 'always' }
  | { type: 'showDiff'; id: string }
  | { type: 'insertCode'; code: string }                  // insert at cursor in the active editor
  | { type: 'applyCode'; code: string; language?: string } // replace selection, or show a diff for the active file
  | { type: 'copy'; text: string }
  | { type: 'regenerate' }
  | { type: 'undoRun'; id: string; force?: boolean }      // "Undo this run" under reply `id` (force: "Undo anyway")
  | { type: 'startEngine' }
  | { type: 'openSettings' }
  | { type: 'setWorkMode'; mode: 'ask' | 'edit' | 'auto' | 'plan' | 'debug' }
  | { type: 'approvePlan'; id: string }                   // Approve under the plan reply `id`
  | { type: 'unqueue'; id: string }                       // remove a waiting steering message
  | { type: 'runChanges'; id: string }                    // open the changes panel under reply `id`
  | { type: 'showRunDiff'; id: string; path: string }     // VS Code's diff editor for one file of that run
  | { type: 'openFile'; path: string }
  | { type: 'openPlace'; id: string; path: string; line: number } // an unchecked place on reply `id`'s coverage chip
  | { type: 'openPlan'; file: string }                   // a plan file in the Markdown preview
  | { type: 'editPlan'; file: string }                   // a plan file in the editor
  | { type: 'draftCommit'; id: string }
  | { type: 'commit'; id: string; message: string };
