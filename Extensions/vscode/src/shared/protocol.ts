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
  kind: 'command' | 'write' | 'edit' | 'open' | 'mcp' | 'memory' | 'skill' | 'rule' | 'read';
  title: string;        // "Ember wants to run a command"
  detail: string;       // command text, file path, or JSON
  preview?: string;     // e.g. a unified diff for edits, or file content for writes
  canShowDiff?: boolean; // true for edits: the webview shows a "View Diff" button
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
  think: boolean;
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
  | { type: 'notice'; text: string };                                            // short note under the composer (fades after ~4 s)                                           // put text in the message box

// Webview → extension
export type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; text: string; attachments?: Attachment[] }
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
  | { type: 'toggle'; key: 'think' | 'web' | 'useContext'; value: boolean }
  | { type: 'approve'; id: string; decision: 'allow' | 'deny' | 'always' }
  | { type: 'showDiff'; id: string }
  | { type: 'insertCode'; code: string }                  // insert at cursor in the active editor
  | { type: 'applyCode'; code: string; language?: string } // replace selection, or show a diff for the active file
  | { type: 'copy'; text: string }
  | { type: 'regenerate' }
  | { type: 'startEngine' }
  | { type: 'openSettings' };
