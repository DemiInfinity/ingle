// The chat engine: chats, the agent loop, approvals, sub-agents, compaction, attachments and editor actions.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type {
  ApprovalRequest,
  Attachment,
  ChatMessage,
  EditorContextInfo,
  FromWebview,
  MCPServerInfo,
  SlashItem,
  ToWebview,
  UIState,
} from '../shared/protocol';
import { assistant, AssistantSettings, expandHome, IngleSettings, loadSettings, paths } from '../shared/settings';
import { allTools } from '../tools';
import {
  activeCommands, bannedBy, blockedMessage, CallRecord, CommandEntry, commandsBlock, commandsNotice, listCommands,
  requirementMet, requirementWords, thenRunOwed,
} from '../tools/commands';
import { mcp, MCP_TOOL_NAMES, wantsMCP } from '../tools/mcp';
import { extractDocument, prepareImage } from '../tools/documents';
import { listMemory, listReports, listRules, listSkills, mcpServers } from '../tools/stores';
import { buildRepoMap } from '../tools/repomap';
import { str, toOllama, ToolArgs, ToolContext, ToolDef, ToolResult } from '../tools/types';
import { ChatStore, NEW_TITLE, StoredChat, StoredMessage, uid } from './chatStore';
import { DIFF_SCHEME, DiffProvider } from './diff';
import { Candidate, Matcher } from './matcher';
import { prettyModel, roleName } from './names';
import { OllamaClient, OllamaMessage, RawToolCall } from './ollama';
import {
  COMPACT_PROMPT,
  EditorSnapshot,
  editorPrompt,
  guidancePrompt,
  indexPrompt,
  personaPrompt,
  projectInstructions,
  subAgentPrompt,
} from './prompt';
import { EngineServer, OFFLINE_TEXT } from './server';

const TOOL_OUTPUT_LIMIT = 12000;
const IMAGE_TOKENS = 800;
const COMPACT_AT = 0.75;
const TOOL_IMAGE_NOTE = '(Image from view_image)';
/** Start of a command nudge (a hidden user message). */
const NUDGE_PREFIX = 'Ingle: the command "';

interface PendingApproval {
  id: string;
  chatId: string;
  toolName: string;
  args: ToolArgs;
  request: ApprovalRequest;
  resolve(decision: 'allow' | 'deny'): void;
}

interface Matched {
  names: string[];   // shown on the reply's chip: things actually in use
  text: string;      // full text given to the model (memories, forced skills)
  hints: string[];   // matched skills/rules/reports offered as suggestions, not loaded
}

/** User messages may carry hidden text for the model (extracted documents, OCR) and notes for the reply. */
interface UserExtras {
  extraContext?: string;
  notes?: string[];
  /** A message only the model sees (command nudges). Never sent to the UI. */
  hidden?: boolean;
}
type Stored = StoredMessage & UserExtras;

// MARK: helpers

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.find((w) => w.uri.scheme === 'file')?.uri.fsPath;
}

function okScheme(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' || uri.scheme === 'untitled';
}

function resolvePath(p: string, root?: string): string {
  const e = expandHome(p.trim());
  return path.isAbsolute(e) ? e : path.join(root ?? os.homedir(), e);
}

function parseArgs(raw: unknown): ToolArgs {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as ToolArgs;
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as ToolArgs;
    } catch { /* not JSON */ }
  }
  return {};
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n…(trimmed ${s.length - max} characters)` : s;
}

function stripThink(s: string): string {
  const t = s.trim();
  if (!t.startsWith('<think>')) return t;
  const end = t.indexOf('</think>');
  return end < 0 ? '' : t.slice(end + 8).trim();
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function friendly(e: unknown, model: string): string {
  const text = errMessage(e);
  const lower = text.toLowerCase();
  const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message.toLowerCase() : '';
  if (lower.includes('fetch failed') || lower.includes('econnrefused') || cause.includes('econnrefused')) {
    return 'Couldn’t reach the engine. ' + OFFLINE_TEXT + '.';
  }
  if (lower.includes('not found')) return `That model (${model}) isn’t downloaded yet. Get it in Ingle → Settings → Models.`;
  if (lower.includes('does not support tools')) return 'This model can’t use tools. Pick a different model for this assistant in Ingle → Settings → Models.';
  return 'Something went wrong: ' + text;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$/i;
const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic', '.heif': 'image/heif',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
function guessMime(name: string): string {
  return MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** Splits a leading <think>…</think> block out of streamed content (models that inline their reasoning). */
class InlineThink {
  private raw = '';
  private sentBody = 0;
  private sentThink = 0;

  private split(final: boolean): { think: string; body: string } {
    const s = this.raw.trimStart();
    if (s.startsWith('<think>')) {
      const rest = s.slice(7);
      const end = rest.indexOf('</think>');
      if (end >= 0) return { think: rest.slice(0, end), body: rest.slice(end + 8).trimStart() };
      let think = rest;
      if (!final) {
        for (let k = 7; k >= 1; k--) {
          if (think.endsWith('</think>'.slice(0, k))) { think = think.slice(0, -k); break; }
        }
      }
      return { think, body: '' };
    }
    if (!final && '<think>'.startsWith(s)) return { think: '', body: '' };
    return { think: '', body: this.raw };
  }

  push(text: string, final = false): { content: string; thinking: string } {
    this.raw += text;
    const { think, body } = this.split(final);
    const out = { content: body.slice(this.sentBody), thinking: think.slice(this.sentThink) };
    this.sentBody = Math.max(this.sentBody, body.length);
    this.sentThink = Math.max(this.sentThink, think.length);
    return out;
  }
}

/** Rough token count: 4 chars per token, ~800 per image. */
function estimate(messages: OllamaMessage[]): number {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    chars += m.content.length + 8;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    images += m.images?.length ?? 0;
  }
  return Math.ceil(chars / 4) + images * IMAGE_TOKENS;
}

/** Saved messages → what Ollama gets. Tool images go in a short user message after that batch of tool results. */
function toOllamaHistory(msgs: Stored[], vision: boolean): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length) out.push({ role: 'user', content: TOOL_IMAGE_NOTE, images: pending });
    pending = [];
  };
  for (const m of msgs) {
    if (m.compaction) continue;
    if (m.role === 'tool') {
      out.push({ role: 'tool', content: m.tool?.output ?? m.content, tool_name: m.tool?.name });
      if (vision && m.images?.length) pending.push(...m.images);
      continue;
    }
    flush();
    if (m.role === 'user') {
      const content = m.extraContext ? `${m.content}\n\n${m.extraContext}` : m.content;
      out.push({ role: 'user', content, images: vision && m.images?.length ? m.images : undefined });
    } else {
      if (m.failed) continue;
      if (!m.content && !m.toolCalls?.length) continue;
      out.push({ role: 'assistant', content: m.content, tool_calls: m.toolCalls?.length ? m.toolCalls : undefined });
    }
  }
  flush();
  return out;
}

/** The UI shape (without the replay-only fields). */
function forUI(m: Stored): ChatMessage {
  const { toolCalls: _t, images: _i, extraContext: _e, notes: _n, hidden: _h, ...rest } = m;
  return rest;
}

// MARK: shared by every Ingle tab

/** One chat history, one Ollama engine and one diff provider, shared by all open Ingle tabs. */
export class EngineShared implements vscode.Disposable {
  readonly store: ChatStore;
  readonly server: EngineServer;
  readonly matcher = new Matcher();
  readonly diff = new DiffProvider();
  readonly visionCache = new Map<string, boolean>();
  /** Kinds of action allowed for this session ("Allow for this session"), shared by every Ingle tab until VS Code closes. */
  readonly sessionAllowed = new Set<string>();
  readonly engines = new Set<ChatEngine>();
  private readonly registration: vscode.Disposable;

  constructor(context: vscode.ExtensionContext) {
    const key = workspaceRoot() ?? vscode.workspace.workspaceFile?.fsPath ?? 'no-workspace';
    this.store = new ChatStore(context.globalStorageUri.fsPath, key);
    this.server = new EngineServer(
      (state, text) => { for (const e of this.engines) e.onEngineState(state, text); },
      () => loadSettings(),
    );
    void this.server.ensure(true);
    this.registration = vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, this.diff);
    mcp.setClientVersion(String((context.extension.packageJSON as { version?: unknown }).version ?? ''));
  }

  /** Another tab changed the chat list: refresh every tab's history. */
  chatsChanged(except?: ChatEngine) {
    for (const e of this.engines) if (e !== except) e.refreshChats();
  }

  dispose(): void {
    for (const e of [...this.engines]) e.dispose();
    this.store.save();
    this.server.dispose();
    this.registration.dispose();
    mcp.dispose();
  }
}

// MARK: engine (one per tab)

export class ChatEngine implements vscode.Disposable {
  private poster?: (msg: ToWebview) => void;
  private settings: IngleSettings;
  private readonly store: ChatStore;
  private currentId = '';
  private readonly server: EngineServer;
  private readonly matcher: Matcher;
  private readonly diff: DiffProvider;
  private readonly disposables: vscode.Disposable[] = [];
  private lastEditor?: vscode.TextEditor;
  private generating?: { chatId: string; abort: AbortController };
  private activity: string | null = null;
  private pending?: PendingApproval;
  private readonly visionCache: Map<string, boolean>;
  private pendingPrefill?: string;
  private contextTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly shared: EngineShared, chatId?: string) {
    this.settings = loadSettings();
    this.store = shared.store;
    this.server = shared.server;
    this.matcher = shared.matcher;
    this.diff = shared.diff;
    this.visionCache = shared.visionCache;
    shared.engines.add(this);
    if (chatId && this.store.get(chatId)) this.currentId = chatId;
    else this.newChatObject();

    const ed = vscode.window.activeTextEditor;
    if (ed && okScheme(ed.document.uri)) this.lastEditor = ed;
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e && okScheme(e.document.uri)) this.lastEditor = e;
        this.scheduleContext();
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (okScheme(e.textEditor.document.uri)) this.lastEditor = e.textEditor;
        this.scheduleContext();
      }),
      vscode.languages.onDidChangeDiagnostics(() => this.scheduleContext()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleContext()),
    );
  }

  // MARK: public API

  setPoster(post: (msg: ToWebview) => void): void {
    this.poster = post;
  }

  state(): UIState {
    this.settings = loadSettings();
    const chat = this.current();
    const a = assistant(this.settings, chat.assistantId);
    return {
      assistants: this.settings.assistants.map((x) => ({ id: x.id, name: x.name, role: roleName(x.id), model: prettyModel(x.model) })),
      currentAssistant: a.id,
      think: chat.think,
      web: chat.web,
      useContext: chat.useContext,
      chats: this.store.summaries(),
      chatId: chat.id,
      messages: (chat.messages as Stored[]).filter((m) => !m.hidden).map(forUI),
      context: this.contextInfo(),
      engine: { state: this.server.state, text: this.server.text },
      vision: this.visionCache.get(a.model) ?? false,
      contextUsage: chat.usage,
      slashItems: this.slashItems(),
      version: String((this.context.extension.packageJSON as { version?: unknown }).version ?? ''),
    };
  }

  async handle(msg: FromWebview): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready': return this.onReady();
        case 'send': return await this.send(msg.text, msg.attachments);
        case 'compact': return await this.compactNow();
        case 'slash': return await this.runSlash(msg.name);
        case 'mcpRefresh': return this.showMcp(true);
        case 'openMcpConfig': return await this.openMcpConfig();
        case 'pickFiles': return await this.pickFiles();
        case 'stop': return this.stop();
        case 'newChat': return this.newChat();
        case 'openChat': return this.openChat(msg.id);
        case 'deleteChat': return this.deleteChat(msg.id);
        case 'setAssistant': return this.setAssistant(msg.id);
        case 'toggle': return this.toggle(msg.key, msg.value);
        case 'approve': return this.approve(msg.id, msg.decision);
        case 'showDiff': return await this.showApprovalDiff(msg.id);
        case 'insertCode': return await this.insertCode(msg.code);
        case 'applyCode': return await this.applyCode(msg.code);
        case 'copy': await vscode.env.clipboard.writeText(msg.text); return;
        case 'regenerate': return await this.regenerate();
        case 'startEngine': await this.server.start(); return;
        case 'openSettings': return await this.openSettings();
      }
    } catch (e) {
      void vscode.window.showErrorMessage('Ingle: ' + errMessage(e));
    }
  }

  async ask(text: string, attachment?: { name: string; code: string; language?: string }, autoSend?: boolean): Promise<void> {
    this.newChat();
    let body = text.trim();
    if (attachment) {
      body = (body || 'Can you look at this?') + `\n\nFile: ${attachment.name}\n\`\`\`${attachment.language ?? ''}\n${attachment.code}\n\`\`\``;
    }
    if (autoSend && body) {
      await this.send(body);
    } else {
      // Kept until the webview says 'ready', in case it isn't open yet.
      this.pendingPrefill = body;
      this.post({ type: 'prefill', text: body });
    }
  }

  /** The chat this tab shows (used to restore tabs after a restart). */
  get chatId(): string {
    return this.currentId;
  }

  onEngineState(state: 'starting' | 'ready' | 'offline', text: string) {
    this.post({ type: 'engine', state, text });
    if (state === 'ready') void this.refreshVision();
  }

  refreshChats() {
    this.post({ type: 'chats', chats: this.store.summaries(), chatId: this.currentId });
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.dropEmptyCurrent();
    this.store.save();
    this.shared.engines.delete(this);
    this.shared.chatsChanged(this);
    if (this.contextTimer) clearTimeout(this.contextTimer);
    for (const d of this.disposables) d.dispose();
    this.poster = undefined;
  }

  // MARK: posting

  private post(msg: ToWebview) {
    if (!this.poster || this.disposed) return;
    try {
      this.poster(msg);
    } catch { /* webview gone */ }
  }

  /** Only events for the chat on screen reach the UI. */
  private postFor(chatId: string, msg: ToWebview) {
    if (chatId === this.currentId) this.post(msg);
  }

  private postInit() {
    this.post({ type: 'init', state: this.state() });
  }

  private postStatus() {
    const streaming = !!this.generating && this.generating.chatId === this.currentId;
    this.post({ type: 'status', streaming, activity: streaming ? this.activity : null });
  }

  private postChats() {
    this.post({ type: 'chats', chats: this.store.summaries(), chatId: this.currentId });
    this.shared.chatsChanged(this);
  }

  private setActivity(text: string | null) {
    this.activity = text;
    this.postStatus();
  }

  private onReady() {
    // chatView posts 'init' itself; this adds what init doesn't carry.
    this.postStatus();
    if (this.pending && this.pending.chatId === this.currentId) this.post({ type: 'approval', approval: this.pending.request });
    const prefill = this.pendingPrefill;
    if (prefill !== undefined) {
      this.pendingPrefill = undefined;
      setTimeout(() => this.post({ type: 'prefill', text: prefill }), 50);
    }
    void this.refreshVision();
  }

  // MARK: chats

  private current(): StoredChat {
    return this.store.get(this.currentId) ?? this.newChatObject();
  }

  private newChatObject(): StoredChat {
    const last = this.context.globalState.get<string>('ingle.assistant') ?? 'daily';
    const think = this.context.globalState.get<boolean>('ingle.think') ?? false;
    const chat = this.store.create(assistant(this.settings, last).id, this.settings.web.onByDefault, think);
    this.currentId = chat.id;
    return chat;
  }

  private dropEmptyCurrent(except?: string) {
    const cur = this.store.get(this.currentId);
    if (cur && !cur.messages.length && cur.id !== except) this.store.chats = this.store.chats.filter((c) => c.id !== cur.id);
  }

  private newChat() {
    const cur = this.store.get(this.currentId);
    if (!cur || cur.messages.length) this.newChatObject();
    this.postInit();
    this.postStatus();
  }

  private openChat(id: string) {
    if (!this.store.get(id)) return;
    this.dropEmptyCurrent(id);
    this.currentId = id;
    this.postInit();
    this.postStatus();
    if (this.pending?.chatId === id) this.post({ type: 'approval', approval: this.pending.request });
    void this.refreshVision();
  }

  private deleteChat(id: string) {
    if (this.generating?.chatId === id) this.stop();
    this.store.delete(id);
    if (id === this.currentId) {
      const next = this.store.summaries()[0];
      if (next) this.currentId = next.id;
      else this.newChatObject();
      this.postInit();
      this.postStatus();
    } else {
      this.postChats();
    }
  }

  private setAssistant(id: string) {
    this.settings = loadSettings();
    const chat = this.current();
    chat.assistantId = assistant(this.settings, id).id;
    void this.context.globalState.update('ingle.assistant', chat.assistantId);
    if (chat.messages.length) this.store.save();
    this.postInit();
    void this.refreshVision();
  }

  private toggle(key: 'think' | 'web' | 'useContext', value: boolean) {
    const chat = this.current();
    chat[key] = value;
    if (key === 'think') void this.context.globalState.update('ingle.think', value);
    if (chat.messages.length) this.store.save();
    if (key === 'useContext') this.post({ type: 'context', context: this.contextInfo() });
  }

  // MARK: slash commands

  private static readonly COMMANDS: SlashItem[] = [
    { name: 'compact', detail: 'Summarise older messages so the chat can keep going', kind: 'command' },
    { name: 'new', detail: 'Start a new chat', kind: 'command' },
    { name: 'mcp', detail: "MCP servers Ingle knows about, and whether they're connected", kind: 'command' },
    { name: 'commands', detail: 'Commands Ingle enforces, and which apply to your last message', kind: 'command' },
    { name: 'skill-reload', detail: 'Re-read skills, rules and MCP servers from disk', kind: 'command' },
  ];

  private slashItems(): SlashItem[] {
    let skills: SlashItem[] = [];
    try {
      skills = listSkills(this.settings).map((s) => ({ name: s.name, detail: s.description || 'Skill', kind: 'skill' as const }));
    } catch { /* no skills folder */ }
    return [...ChatEngine.COMMANDS, ...skills];
  }

  private forcedSkill(text: string) {
    const m = /^\/([^\s]+)/.exec(text.trim());
    if (!m) return undefined;
    try {
      return listSkills(this.settings).find((s) => s.name.toLowerCase() === m[1].toLowerCase());
    } catch {
      return undefined;
    }
  }

  private async runSlash(name: string) {
    switch (name) {
      case 'compact': return this.compactNow();
      case 'new': return this.newChat();
      case 'mcp': return this.showMcp();
      case 'commands': {
        const last = [...this.current().messages].reverse().find((m) => m.role === 'user' && !(m as Stored).hidden)?.content ?? '';
        this.post({ type: 'notice', text: commandsNotice(workspaceRoot(), last) });
        return;
      }
      case 'skill-reload':
      case 'skills-reload':
      case 'reload': {
        this.settings = loadSettings();
        this.matcher.clearCache();
        mcp.reload(this.settings);
        const items = this.slashItems();
        this.post({ type: 'slashItems', items });
        let rules = 0;
        try { rules = listRules(workspaceRoot()).length; } catch { /* none */ }
        const skills = items.filter((i) => i.kind === 'skill').length;
        const servers = mcpServers().length;
        let commands = 0;
        try { commands = listCommands(workspaceRoot()).filter((c) => c.enabled).length; } catch { /* none */ }
        const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
        this.post({ type: 'notice', text: `Reloaded · ${plural(skills, 'skill')} · ${plural(rules, 'rule')} · ${plural(commands, 'command')} · ${plural(servers, 'MCP server')}` });
        return;
      }
      default:
        this.post({ type: 'notice', text: `There's no /${name} command.` });
    }
  }

  /** The /mcp dialog: servers this extension runs show as connected; otherwise the Mac app's status. */
  private showMcp(reload = false) {
    this.settings = loadSettings();
    if (reload) mcp.reload(this.settings);
    const live = this.settings.mcpStatus ?? {};
    const disabled = new Set(this.settings.mcpDisabled ?? []);
    const servers: MCPServerInfo[] = mcpServers().map((s) => {
      const base = { name: s.name, source: s.source, command: [s.command, ...s.args].join(' '), enabled: !disabled.has(s.name) };
      if (disabled.has(s.name)) return { ...base, state: 'off', detail: 'Turned off in Ingle’s settings' };
      const here = mcp.status(s.name);
      if (here) {
        const n = here.tools.length;
        return { ...base, state: 'connected', detail: `Connected in VS Code · ${n} tool${n === 1 ? '' : 's'}`, tools: here.tools };
      }
      const error = mcp.lastError(s.name);
      if (error) return { ...base, state: 'failed', detail: `Couldn’t connect in VS Code: ${error}` };
      const status = live[s.name];
      if (status?.state === 'running') {
        const n = status.tools?.length ?? 0;
        return { ...base, state: 'connected', detail: `Connected in the Ingle app · ${n} tool${n === 1 ? '' : 's'} — VS Code starts its own when a chat uses it`, tools: status.tools };
      }
      if (status?.state === 'failed') return { ...base, state: 'failed', detail: `Couldn’t connect in the Ingle app: ${status.error ?? 'unknown error'}` };
      return { ...base, state: 'not-connected', detail: 'Not connected — starts when a chat uses it (mention MCP or the server’s name)' };
    });
    this.post({ type: 'mcp', servers });
  }

  private async openMcpConfig() {
    if (!fs.existsSync(paths.mcp)) {
      fs.mkdirSync(paths.home, { recursive: true });
      fs.writeFileSync(paths.mcp, JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
    }
    await vscode.window.showTextDocument(vscode.Uri.file(paths.mcp));
  }

  private async openSettings() {
    try {
      fs.mkdirSync(paths.home, { recursive: true });
    } catch { /* ignore */ }
    await vscode.env.openExternal(vscode.Uri.file(paths.home));
  }

  // MARK: vision

  private async visionFor(model: string): Promise<boolean> {
    const cached = this.visionCache.get(model);
    if (cached !== undefined) return cached;
    const caps = await new OllamaClient(this.settings.serverURL).capabilities(model);
    if (caps === null) return false; // engine down or model missing: ask again later
    const v = caps.includes('vision');
    this.visionCache.set(model, v);
    return v;
  }

  /** Looks up the current model's vision support once, and re-sends state if it can see images. */
  private async refreshVision() {
    const model = assistant(this.settings, this.current().assistantId).model;
    if (this.visionCache.has(model)) return;
    const v = await this.visionFor(model);
    if (v && model === assistant(this.settings, this.current().assistantId).model) this.postInit();
  }

  // MARK: editor context

  private editor(): vscode.TextEditor | undefined {
    const a = vscode.window.activeTextEditor;
    if (a && okScheme(a.document.uri)) return a;
    const l = this.lastEditor;
    if (l && !l.document.isClosed) return vscode.window.visibleTextEditors.find((e) => e.document === l.document) ?? l;
    return undefined;
  }

  private scheduleContext() {
    if (this.contextTimer) clearTimeout(this.contextTimer);
    this.contextTimer = setTimeout(() => this.post({ type: 'context', context: this.contextInfo() }), 300);
  }

  private problemsFor(doc: vscode.TextDocument): EditorSnapshot['problems'] {
    return vscode.languages
      .getDiagnostics(doc.uri)
      .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
      .map((d) => ({
        line: d.range.start.line + 1,
        severity: d.severity === vscode.DiagnosticSeverity.Error ? ('error' as const) : ('warning' as const),
        message: d.message,
      }));
  }

  private contextInfo(): EditorContextInfo | undefined {
    const ed = this.editor();
    const folder = ed ? vscode.workspace.getWorkspaceFolder(ed.document.uri) : undefined;
    const project = folder?.name ?? vscode.workspace.workspaceFolders?.[0]?.name;
    if (!ed && !project) return undefined;
    return {
      project,
      file: ed ? path.basename(ed.document.fileName) : undefined,
      language: ed?.document.languageId,
      hasSelection: !!ed && !ed.selection.isEmpty,
      problems: ed ? this.problemsFor(ed.document).length : 0,
    };
  }

  private snapshot(): EditorSnapshot {
    const ed = this.editor();
    const doc = ed?.document;
    const folder = doc ? vscode.workspace.getWorkspaceFolder(doc.uri) : undefined;
    return {
      workspace: folder?.uri.fsPath ?? workspaceRoot(),
      file: doc ? (doc.uri.scheme === 'file' ? doc.uri.fsPath : doc.fileName) : undefined,
      fileName: doc ? path.basename(doc.fileName) : undefined,
      language: doc?.languageId,
      selection: ed && doc && !ed.selection.isEmpty ? doc.getText(ed.selection).slice(0, 8000) : undefined,
      problems: doc ? this.problemsFor(doc).slice(0, 20) : [],
    };
  }

  // MARK: matched context

  private async matchContext(client: OllamaClient, query: string, root: string | undefined): Promise<Matched> {
    const result: Matched = { names: [], text: '', hints: [] };
    if (!this.settings.smartMatching || !query.trim()) return result;
    const candidates: Candidate[] = [];
    const bodies = new Map<string, { label: string; title: string; body: string }>();
    const safe = <T>(f: () => T[]): T[] => {
      try { return f(); } catch { return []; }
    };
    if (this.settings.memory.enabled) {
      for (const m of safe(listMemory)) {
        const facts = m.body.split('\n').filter((l) => l.trim().startsWith('- ')).slice(0, 6).join(' ');
        const id = 'memory:' + m.name;
        candidates.push({ id, text: `${m.name}: ${m.description}. ${facts}` });
        bodies.set(id, { label: `memory: ${m.name}`, title: `Memory: ${m.name}`, body: m.body.slice(0, 4000) });
      }
    }
    for (const r of safe(listReports).slice(0, 60)) {
      const id = 'report:' + r.name;
      candidates.push({ id, text: `${r.title}: ${r.description}` });
      bodies.set(id, { label: `report: ${r.name}`, title: `Earlier research: ${r.name}`, body: r.body.slice(0, 5000) });
    }
    for (const r of safe(() => listRules(root)).filter((x) => !x.always)) {
      const id = 'rule:' + r.name;
      candidates.push({ id, text: `${r.name}: ${r.description}` });
      bodies.set(id, { label: r.name, title: `Rule: ${r.name}`, body: r.body });
    }
    for (const s of safe(() => listSkills(this.settings))) {
      const id = 'skill:' + s.name;
      candidates.push({ id, text: `${s.name}: ${s.description}` });
      bodies.set(id, { label: s.name, title: `Skill: ${s.name}`, body: s.body.slice(0, 12000) });
    }
    if (!candidates.length) return result;
    const installed = await client.tags();
    const hits = await this.matcher.matches(client, installed, query.slice(0, 4000), candidates, 3);
    // Matches are only suggestions: the assistant loads one if it really applies, and only then does it
    // appear on the reply's chip. Memories are small facts, so they're included quietly.
    for (const id of hits) {
      const b = bodies.get(id);
      if (!b) continue;
      const name = id.slice(id.indexOf(':') + 1);
      if (id.startsWith('memory:')) result.text += `### ${b.title}\n${b.body}\n\n`;
      else if (id.startsWith('skill:')) result.hints.push(`- skill ${name} — use_skill("${name}")`);
      else if (id.startsWith('rule:')) result.hints.push(`- rule ${name} — use_rule("${name}")`);
      else if (id.startsWith('report:')) result.hints.push(`- earlier research ${name} — report_read("${name}")`);
    }
    return result;
  }

  // MARK: tools

  private makeCtx(chatId: string, web: boolean, vision: boolean, signal: AbortSignal, isSubAgent: boolean, toolName: string, args: ToolArgs, onDeny: () => void): ToolContext {
    return {
      settings: this.settings,
      workspaceRoot: workspaceRoot(),
      web,
      isSubAgent,
      vision,
      signal,
      setActivity: (t) => this.setActivity(t === null ? null : isSubAgent ? 'Helper: ' + t : t),
      requestApproval: async (req) => {
        const d = await this.requestApproval(chatId, toolName, args, req, isSubAgent, signal);
        if (d === 'deny') onDeny();
        return d;
      },
    };
  }

  private toolsFor(ctx: ToolContext, lastUser: string, delegate?: ToolDef, active: CommandEntry[] = []): ToolDef[] {
    let defs: ToolDef[] = [];
    try {
      defs = allTools().filter((t) => t.name !== 'delegate');
    } catch {
      defs = [];
    }
    let list = defs.filter((t) => {
      try { return t.available(ctx); } catch { return false; }
    });
    if (ctx.isSubAgent) return list.filter((t) => t.readOnly);
    // Builder tools only when the user is talking about skills or rules (fewer tools for small models).
    // Local models pick tools far less reliably as the list grows (≈85% right with 5 tools, ≈45% with 20),
    // so optional tools are only offered when the message plausibly needs them.
    const t = lastUser.toLowerCase();
    const wants: Record<string, RegExp> = {
      skill_create: /skill|rule/,
      rule_create: /skill|rule/,
      command_create: /command/,
      read_document: /pdf|docx?\b|word doc|xlsx|excel|spreadsheet|document|\.pages|keynote|numbers file|rtf/,
      view_image: /image|screenshot|png|jpe?g|heic|gif|webp|picture|photo|diagram|mock-?up|icon/,
      open_url: /\bopen\b.*(url|link|browser|http|site|page)|https?:\/\//,
      memory_read: /remember|memory|memories|forget|about me|preference/,
      memory_rewrite: /remember|memory|memories|forget|about me|preference/,
      memory_forget: /remember|memory|memories|forget|about me|preference/,
    };
    // Commands: tools a must_use needs are always offered; never_use tools are removed.
    const forced = new Set<string>();
    const banned = new Set<string>();
    for (const c of active) {
      for (const r of c.mustUse) {
        if (r.kind === 'tool') forced.add(r.tool.toLowerCase());
        else if (r.kind === 'mcp') MCP_TOOL_NAMES.forEach((n) => forced.add(n));
      }
      for (const n of c.neverUse) if (!n.toLowerCase().startsWith('mcp:')) banned.add(n.trim().toLowerCase());
    }
    const mcpWanted = wantsMCP(t);
    list = list.filter((tool) => {
      if (forced.has(tool.name)) return true;
      if (MCP_TOOL_NAMES.includes(tool.name)) return mcpWanted;
      return !wants[tool.name] || wants[tool.name].test(t);
    });
    if (delegate && (forced.has('delegate') || /research|compare|look into|investigate|summari[sz]e|find out|dig into|go through|sub-?agent|helper|in parallel|across (the|all)/.test(t))) {
      list.push(delegate);
    }
    return list.filter((tool) => !banned.has(tool.name.toLowerCase()));
  }

  private delegateTool(run: (task: string) => Promise<string>): ToolDef {
    return {
      name: 'delegate',
      description: 'Hand a self-contained job (research one topic, read and summarise some files) to a read-only helper with a fresh context. Give it the complete task; it returns its findings.',
      parameters: {
        type: 'object',
        properties: { task: { type: 'string', description: 'The full task, with everything the helper needs to know.' } },
        required: ['task'],
      },
      readOnly: false,
      available: () => true,
      describe: (a) => ({ title: 'Ask a helper', detail: str(a, 'task').slice(0, 300), icon: 'person' }),
      run: (a) => run(str(a, 'task')),
    };
  }

  private requestApproval(chatId: string, toolName: string, args: ToolArgs, req: Omit<ApprovalRequest, 'id'>, isSub: boolean, signal: AbortSignal): Promise<'allow' | 'deny'> {
    if (signal.aborted) return Promise.resolve('deny');
    if (this.shared.sessionAllowed.has(toolName)) return Promise.resolve('allow');
    if (this.pending) this.pending.resolve('deny'); // only one card at a time
    const request: ApprovalRequest = { ...req, id: uid(), title: isSub ? 'Helper: ' + req.title : req.title };
    return new Promise((resolve) => {
      let settled = false;
      const onAbort = () => finish('deny');
      const finish = (d: 'allow' | 'deny') => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (this.pending?.id === request.id) {
          this.pending = undefined;
          this.postFor(chatId, { type: 'approvalClear' });
        }
        resolve(d);
      };
      signal.addEventListener('abort', onAbort);
      this.pending = { id: request.id, chatId, toolName, args, request, resolve: finish };
      this.postFor(chatId, { type: 'approval', approval: request });
    });
  }

  private approve(id: string, decision: 'allow' | 'deny' | 'always') {
    const p = this.pending;
    if (!p || p.id !== id) return;
    if (decision === 'always') {
      this.shared.sessionAllowed.add(p.toolName);
    }
    p.resolve(decision === 'deny' ? 'deny' : 'allow');
  }

  private async showApprovalDiff(id: string) {
    const p = this.pending;
    if (!p || p.id !== id) return;
    const file = str(p.args, 'path');
    const full = file ? resolvePath(file, workspaceRoot()) : undefined;
    const current = full ? this.readCurrent(full) : undefined;
    if (p.toolName === 'edit_file' && full && current !== undefined) {
      const oldText = str(p.args, 'old_text');
      const i = oldText ? current.indexOf(oldText) : -1;
      if (i >= 0) {
        const proposed = current.slice(0, i) + str(p.args, 'new_text') + current.slice(i + oldText.length);
        await this.diff.show(full, proposed, `${path.basename(full)} ↔ proposed edit`, current);
        return;
      }
    }
    if (p.toolName === 'write_file' && full) {
      await this.diff.show(full, str(p.args, 'content'), `${path.basename(full)} ↔ proposed file`, current ?? '');
      return;
    }
    // Anything else (or an edit whose text moved): show the preview the tool gave.
    const doc = await vscode.workspace.openTextDocument({ content: p.request.preview ?? p.request.detail, language: 'diff' });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /** Current text of a file: the open (maybe unsaved) document, or disk. */
  private readCurrent(file: string): string | undefined {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === file);
    if (open) return open.getText();
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  }

  // MARK: attachments

  private async pickFiles() {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach', defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri });
    if (!uris?.length) return;
    const attachments: Attachment[] = uris
      .filter((u) => u.scheme === 'file')
      .map((u) => ({ name: path.basename(u.fsPath), mime: guessMime(u.fsPath), path: u.fsPath }));
    if (attachments.length) this.post({ type: 'attachments', attachments });
  }

  private async prepareAttachments(list: Attachment[], vision: boolean): Promise<{ ui: Attachment[]; images: string[]; extra: string; notes: string[] }> {
    const ui: Attachment[] = [];
    const images: string[] = [];
    const extra: string[] = [];
    const notes: string[] = [];
    for (const a of list) {
      const name = a.name || (a.path ? path.basename(a.path) : 'attachment');
      const mime = a.mime || guessMime(name);
      const isImage = mime.startsWith('image/') || IMAGE_EXT.test(name);
      const input: string | Buffer | undefined = a.path ?? (a.dataBase64 ? Buffer.from(a.dataBase64, 'base64') : undefined);
      if (!input) continue;
      if (isImage) {
        let r: { base64: string; thumbnail: string; ocrText?: string } | string;
        try {
          r = await prepareImage(input, name, { ocr: !vision });
        } catch (e) {
          r = errMessage(e);
        }
        if (typeof r === 'string') {
          ui.push({ name, mime, path: a.path, thumbnail: a.thumbnail });
          extra.push(`(The image ${name} couldn’t be read: ${r})`);
          continue;
        }
        ui.push({ name, mime, path: a.path, thumbnail: r.thumbnail || a.thumbnail });
        if (vision) {
          images.push(r.base64);
        } else {
          extra.push(`Image: ${name} (read as text — the current model can’t see images)\n\`\`\`\n${r.ocrText?.trim() || '(no text found in the image)'}\n\`\`\``);
          if (!notes.length) notes.push('image read as text — model can’t see images');
        }
      } else {
        let file = a.path;
        if (!file && Buffer.isBuffer(input)) {
          const dir = path.join(os.tmpdir(), 'ingle-' + uid());
          fs.mkdirSync(dir, { recursive: true });
          file = path.join(dir, path.basename(name));
          fs.writeFileSync(file, input);
        }
        let text: string;
        try {
          text = file ? await extractDocument(file) : 'Couldn’t read this file.';
        } catch (e) {
          text = 'Couldn’t read this file: ' + errMessage(e);
        }
        ui.push({ name, mime, path: a.path });
        extra.push(`Attached file: ${name}\n\`\`\`\n${text}\n\`\`\``);
      }
    }
    return { ui, images, extra: extra.join('\n\n'), notes };
  }

  // MARK: sending

  private async send(text: string, attachments?: Attachment[]) {
    const body = text.trim();
    if (!attachments?.length && /^\/(compact|new|mcp|commands|skill-reload|skills-reload|reload)$/i.test(body)) {
      return this.runSlash(body.slice(1).toLowerCase());
    }
    if (!body && !attachments?.length) return;
    if (this.generating) {
      if (this.generating.chatId !== this.currentId) {
        void vscode.window.showInformationMessage('Ingle is still replying in another chat. Stop it or wait a moment.');
      }
      return;
    }
    this.pendingPrefill = undefined;
    this.settings = loadSettings();
    const chat = this.current();
    const a = assistant(this.settings, chat.assistantId);
    const msg: Stored = { id: uid(), role: 'user', content: body };
    if (attachments?.length) {
      this.generating = { chatId: chat.id, abort: new AbortController() };
      this.setActivity('Reading attachments…');
      try {
        const vision = await this.visionFor(a.model);
        const prepared = await this.prepareAttachments(attachments, vision);
        if (prepared.ui.length) msg.attachments = prepared.ui;
        if (prepared.images.length) msg.images = prepared.images;
        if (prepared.extra) msg.extraContext = prepared.extra;
        if (prepared.notes.length) msg.notes = prepared.notes;
      } finally {
        this.generating = undefined;
        this.setActivity(null);
      }
      if (!msg.content) msg.content = attachments.every((x) => IMAGE_EXT.test(x.name)) ? 'What do you make of this?' : 'Can you look at this?';
    }
    chat.messages.push(msg);
    if (chat.title === NEW_TITLE) {
      const source = body || attachments?.[0]?.name || 'Files';
      chat.title = (source.split('\n')[0] ?? source).slice(0, 48);
    }
    chat.updated = Date.now();
    this.store.save();
    this.postFor(chat.id, { type: 'messageAdd', message: forUI(msg) });
    this.postChats();
    await this.generate(chat.id);
    if (!chat.autoTitled) void this.summariseTitle(chat);
  }

  /** Like Claude: after the first reply, the model names the chat in a few words (shown on the tab and in history). */
  private async summariseTitle(chat: StoredChat) {
    chat.autoTitled = true;
    const firstUser = chat.messages.find((m) => m.role === 'user')?.content ?? '';
    const firstReply = chat.messages.find((m) => m.role === 'assistant' && m.content)?.content ?? '';
    if (!firstUser.trim()) return;
    try {
      const a = assistant(this.settings, chat.assistantId);
      const client = new OllamaClient(this.settings.serverURL);
      const r = await client.chat({
        model: a.model,
        messages: [{
          role: 'user',
          content: 'Give this conversation a short title of 2 to 6 words, in British English, like a tab label. Reply with the title only — no quotes, no full stop.\n\n' +
            `User: ${firstUser.slice(0, 1500)}\n\nAssistant: ${firstReply.replace(/<think>[\s\S]*?<\/think>/g, '').slice(0, 1500)}`,
        }],
        think: false,
        numCtx: 4096,
        keepAlive: this.settings.keepAlive,
      }, AbortSignal.timeout(30000));
      const title = r.content.replace(/<think>[\s\S]*?<\/think>/g, '').split('\n').map((l) => l.trim()).find(Boolean)
        ?.replace(/^["'“‘*#\s]+|["'”’*.\s]+$/g, '').replace(/^title:\s*/i, '').slice(0, 60);
      if (!title) return;
      chat.title = title;
      this.store.save();
      this.postChats();
    } catch {
      // Keep the first-line title.
    }
  }

  private async regenerate() {
    if (this.generating) return;
    const chat = this.current();
    const isRealUser = (m: Stored) => m.role === 'user' && !m.hidden;
    while (chat.messages.length && !isRealUser(chat.messages[chat.messages.length - 1] as Stored)) chat.messages.pop();
    if (!chat.messages.length) return;
    this.postInit();
    await this.generate(chat.id);
  }

  private stop() {
    if (this.pending) this.pending.resolve('deny');
    this.generating?.abort.abort();
  }

  private async generate(chatId: string) {
    const chat = this.store.get(chatId);
    if (!chat || this.generating) return;
    this.settings = loadSettings();
    const abort = new AbortController();
    this.generating = { chatId, abort };
    this.activity = null;
    this.postStatus();
    try {
      if (!(await this.server.ensure(true))) {
        const a = assistant(this.settings, chat.assistantId);
        const fail: Stored = { id: uid(), role: 'assistant', content: this.server.text || OFFLINE_TEXT, assistantName: a.name, model: prettyModel(a.model), failed: true };
        chat.messages.push(fail);
        this.postFor(chatId, { type: 'messageAdd', message: forUI(fail) });
        return;
      }
      await this.runLoop(chat, abort.signal);
    } catch (e) {
      void vscode.window.showErrorMessage('Ingle: ' + errMessage(e));
    } finally {
      if (this.pending?.chatId === chatId) this.pending.resolve('deny');
      this.generating = undefined;
      this.activity = null;
      chat.updated = Date.now();
      this.store.save();
      this.postStatus();
      this.postChats();
      if (chat.usage) this.postFor(chatId, { type: 'contextUsage', used: chat.usage.used, limit: chat.usage.limit });
    }
  }

  private buildSystem(chat: StoredChat, a: AssistantSettings, tools: ToolDef[], editor: EditorSnapshot | undefined, matched: Matched, summary: string, repoMap = '', active: CommandEntry[] = []): string {
    const root = workspaceRoot();
    const parts = [personaPrompt(this.settings, a, chat.web)];
    const commands = commandsBlock(active);
    if (commands) parts.push(commands);
    parts.push(indexPrompt(this.settings, tools, root, chat.web));
    if (editor) {
      parts.push(editorPrompt(editor));
      const project = projectInstructions(editor.workspace ?? root);
      if (project) parts.push(project);
    }
    if (repoMap) parts.push('## Repo map (the project at a glance, most relevant first — read_file for details, repo_map for more)\n' + repoMap);
    if (matched.text) parts.push('## Loaded for this request\n' + matched.text.trim());
    if (matched.hints.length) parts.push('## Possibly relevant (matched automatically — load one with its tool only if it clearly applies to this request; otherwise ignore them)\n' + matched.hints.join('\n'));
    parts.push(guidancePrompt(this.settings, chat.web, tools.some((t) => t.name === 'delegate')));
    if (summary) parts.push('## Summary of earlier messages in this chat (they were compacted)\n' + summary);
    return parts.join('\n\n');
  }

  private lastCompaction(chat: StoredChat): number {
    for (let i = chat.messages.length - 1; i >= 0; i--) if (chat.messages[i].compaction) return i;
    return -1;
  }

  private async runLoop(chat: StoredChat, signal: AbortSignal) {
    const a = assistant(this.settings, chat.assistantId);
    const model = a.model;
    const pretty = prettyModel(model);
    const limit = a.contextLength || 32768;
    const client = new OllamaClient(this.settings.serverURL);
    const vision = await this.visionFor(model);
    const editor = chat.useContext ? this.snapshot() : undefined;
    const lastUser = [...chat.messages].reverse().find((m) => m.role === 'user') as Stored | undefined;
    const lastText = lastUser?.content ?? '';
    const matched = await this.matchContext(client, `${lastText} ${editor?.language ?? ''} ${editor?.fileName ?? ''}`, workspaceRoot());
    // "/skill-name …" always loads that skill, first.
    const forced = this.forcedSkill(lastText);
    if (forced && !matched.names.includes(forced.name)) {
      matched.names.unshift(forced.name);
      matched.text = `### Skill: ${forced.name} (the user asked for this skill — follow it)\n${forced.body.slice(0, 12000)}\n\n` + matched.text;
    }
    // Commands active for this request (computed once). skill: requirements are attached here.
    let active: CommandEntry[] = [];
    try { active = activeCommands(listCommands(workspaceRoot()), lastText); } catch { /* none */ }
    for (const c of active) {
      for (const r of c.mustUse) {
        if (r.kind !== 'skill') continue;
        let skill: ReturnType<typeof listSkills>[number] | undefined;
        try { skill = listSkills(this.settings).find((x) => x.name.toLowerCase() === r.name.toLowerCase()); } catch { /* none */ }
        if (!skill || matched.names.includes(skill.name)) continue;
        matched.names.push(skill.name);
        matched.text += `### Skill: ${skill.name} (required by the command "${c.name}" — follow it)\n${skill.body.slice(0, 12000)}\n\n`;
      }
    }
    const used = [...active.map((c) => `⚑ ${c.name}`), ...matched.names, ...(lastUser?.notes ?? [])];
    const done: CallRecord[] = [];
    const nudges = new Map<string, number>();
    const ignored = new Set<string>();
    // The project at a glance, ranked for this request (about a tenth of the context, at most ~1,500 tokens).
    let repoMap = '';
    const root = workspaceRoot();
    if (editor && root) {
      this.setActivity('Mapping the project…');
      try {
        repoMap = await buildRepoMap({ root, query: lastText, activeFile: this.editor()?.document.uri.fsPath, budgetChars: Math.min(6000, Math.floor(limit * 0.4)) });
      } catch { /* no map this turn */ }
      this.setActivity(null);
    }
    // Local models cost nothing per step, so there's no small cap: it keeps going until the job is done,
    // you press Stop, or it's clearly stuck. The ceiling is only a backstop (Settings → Ingle › Max Steps, 0 = none).
    const configured = vscode.workspace.getConfiguration('ingle').get<number>('maxSteps', 200);
    const maxSteps = configured > 0 ? configured : Number.MAX_SAFE_INTEGER;
    let skips = 0;
    const delegate = this.delegateTool((task) => this.runSubAgent(task, chat, model, limit, vision, signal, active));

    const callCounts = new Map<string, number>();
    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) return;
      const baseCtx = this.makeCtx(chat.id, chat.web, vision, signal, false, '', {}, () => undefined);
      const tools = this.toolsFor(baseCtx, lastText, delegate, active);
      const toolJSON = tools.map(toOllama);
      const toolChars = JSON.stringify(toolJSON).length;

      // Build the request, compacting first if it would pass ~75 % of the context.
      let history: OllamaMessage[] = [];
      let system = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        const c = this.lastCompaction(chat);
        system = this.buildSystem(chat, a, tools, editor, matched, c >= 0 ? chat.messages[c].content : '', repoMap, active);
        history = toOllamaHistory(chat.messages.slice(c + 1) as Stored[], vision);
        const tokens = Math.ceil((system.length + toolChars) / 4) + estimate(history);
        if (tokens <= limit * COMPACT_AT || attempt > 0) break;
        if (!(await this.compact(chat, true, signal))) break;
        if (signal.aborted) return;
      }
      const fixed = Math.ceil((system.length + toolChars) / 4);
      history = this.trim(history, Math.floor(limit * 0.9) - fixed);
      const tokens = fixed + estimate(history);
      chat.usage = { used: tokens, limit };
      this.postFor(chat.id, { type: 'contextUsage', used: tokens, limit });

      const reply: Stored = { id: uid(), role: 'assistant', content: '', assistantName: a.name, model: pretty };
      if (used.length) reply.usedContext = used;
      chat.messages.push(reply);
      chat.updated = Date.now();
      this.postFor(chat.id, { type: 'messageAdd', message: forUI(reply) });

      const started = Date.now();
      let thinkStart: number | undefined;
      let thinkEnd: number | undefined;
      const inline = new InlineThink();
      const addThinking = (t: string) => {
        if (!t) return;
        if (thinkStart === undefined) thinkStart = Date.now();
        reply.thinking = (reply.thinking ?? '') + t;
        this.postFor(chat.id, { type: 'messageDelta', id: reply.id, thinking: t });
      };
      const addContent = (t: string) => {
        if (!t) return;
        if (thinkStart !== undefined && thinkEnd === undefined) thinkEnd = Date.now();
        reply.content += t;
        this.postFor(chat.id, { type: 'messageDelta', id: reply.id, content: t });
      };

      let calls: RawToolCall[] = [];
      let stopped = false;
      try {
        const r = await client.chat(
          { model, messages: [{ role: 'system', content: system }, ...history], tools: toolJSON, think: chat.think, numCtx: limit, keepAlive: this.settings.keepAlive },
          signal,
          {
            onContent: (raw) => {
              const d = inline.push(raw);
              addThinking(d.thinking);
              addContent(d.content);
            },
            onThinking: addThinking,
          },
        );
        const tail = inline.push('', true);
        addThinking(tail.thinking);
        addContent(tail.content);
        calls = r.toolCalls;
        const tps = r.evalDuration > 0 ? r.evalCount / (r.evalDuration / 1e9) : 0;
        reply.stats = { tokensPerSecond: Math.round(tps * 10) / 10, seconds: Math.round((Date.now() - started) / 100) / 10 };
      } catch (e) {
        if (signal.aborted) {
          stopped = true;
        } else {
          reply.failed = true;
          reply.content = reply.content ? reply.content + '\n\n_' + friendly(e, model) + '_' : friendly(e, model);
        }
      }
      if (thinkStart !== undefined) reply.thoughtSeconds = Math.round(((thinkEnd ?? Date.now()) - thinkStart) / 100) / 10;

      if (stopped && !reply.content && !reply.thinking) {
        chat.messages = chat.messages.filter((m) => m.id !== reply.id);
        this.postFor(chat.id, { type: 'init', state: this.state() });
        return;
      }
      if (calls.length && !stopped) reply.toolCalls = calls;
      this.postFor(chat.id, { type: 'messageUpdate', message: forUI(reply) });
      this.store.saveSoon();
      if (stopped || reply.failed) return;
      if (!calls.length) {
        // Completion check: don't finish while an active command isn't satisfied (≤ 2 nudges per command).
        const asks: string[] = [];
        for (const c of active) {
          if (ignored.has(c.name)) continue;
          const missing: string[] = [];
          let possible = true;
          for (const r of c.mustUse) {
            if (requirementMet(r, done)) continue;
            missing.push(requirementWords(r));
            const needs = r.kind === 'mcp' ? 'mcp_call' : r.kind === 'tool' ? r.tool.toLowerCase() : '';
            if (needs && !tools.some((x) => x.name.toLowerCase() === needs)) possible = false;
          }
          if (c.thenRun && thenRunOwed(c.thenRun, done)) {
            missing.push(`run \`${c.thenRun}\` with run_command (files changed since it last ran)`);
            if (!tools.some((x) => x.name === 'run_command')) possible = false;
          }
          if (!missing.length) continue;
          const n = nudges.get(c.name) ?? 0;
          if (!possible || n >= 2) { ignored.add(c.name); continue; }
          nudges.set(c.name, n + 1);
          asks.push(`${NUDGE_PREFIX}${c.name}" requires you to ${missing.join(', and ')} before finishing. Do that now.`);
        }
        if (asks.length && !signal.aborted) {
          const nudge: Stored = { id: uid(), role: 'user', content: asks.join('\n'), hidden: true };
          chat.messages.push(nudge);
          this.store.saveSoon();
          continue;
        }
        if (ignored.size) {
          reply.usedContext = [...(reply.usedContext ?? []), ...[...ignored].map((n) => `⚠ didn't follow ${n}`)];
          this.postFor(chat.id, { type: 'messageUpdate', message: forUI(reply) });
          this.store.saveSoon();
        }
        return;
      }

      for (const call of calls) {
        if (signal.aborted) break;
        // Local models sometimes loop on the same call; after two runs, nudge instead of running it again.
        const sig = (call.function?.name ?? '') + '|' + JSON.stringify(parseArgs(call.function?.arguments));
        const repeats = (callCounts.get(sig) ?? 0) + 1;
        callCounts.set(sig, repeats);
        const skip = repeats >= 3
          ? `You've already made this exact call ${repeats - 1} times and have its result above. Don't repeat it — use that result, try a different approach, or tell the user what's blocking you.`
          : undefined;
        if (skip) skips++;
        const record = await this.runToolCall(chat, call, tools, vision, signal, skip, active);
        // Show a skill, rule or report on the chip once the assistant has actually opened it.
        const callName = call.function?.name ?? '';
        if (!skip && ['use_skill', 'use_rule', 'report_read'].includes(callName)) {
          const opened = str(parseArgs(call.function?.arguments), 'name').trim();
          const label = callName === 'report_read' ? `report: ${opened}` : opened;
          const lastReply = [...chat.messages].reverse().find((m) => m.role === 'assistant') as Stored | undefined;
          const row = chat.messages[chat.messages.length - 1] as Stored | undefined;
          if (opened && !used.includes(label) && !row?.tool?.denied) {
            used.push(label);
            if (lastReply) {
              lastReply.usedContext = [...(lastReply.usedContext ?? []), label];
              this.postFor(chat.id, { type: 'messageUpdate', message: forUI(lastReply) });
            }
          }
        }
        if (record) done.push(record);
      }
      this.store.save();
      // Stuck: it keeps repeating the same calls even after being told it has the result.
      if (skips >= 4 && !signal.aborted) {
        const note: Stored = { id: uid(), role: 'assistant', content: 'I seem to be going round in circles, so I’ve stopped. Tell me what to try next, or say “carry on” to let me keep going.', assistantName: a.name, model: pretty, failed: true };
        chat.messages.push(note);
        this.postFor(chat.id, { type: 'messageAdd', message: forUI(note) });
        return;
      }
      if (step === maxSteps - 1 && !signal.aborted) {
        const note: Stored = { id: uid(), role: 'assistant', content: `I’ve taken ${maxSteps} steps on this, which is the limit in Settings (Ingle › Max Steps). Say “carry on” and I’ll continue.`, assistantName: a.name, model: pretty, failed: true };
        chat.messages.push(note);
        this.postFor(chat.id, { type: 'messageAdd', message: forUI(note) });
      }
    }
  }

  /** Drops the oldest messages (never the latest user turn) until the history fits the budget. */
  private trim(history: OllamaMessage[], budget: number): OllamaMessage[] {
    let h = history.slice();
    let lastUser = -1;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].role === 'user' && h[i].content !== TOOL_IMAGE_NOTE && !h[i].content.startsWith(NUDGE_PREFIX)) { lastUser = i; break; }
    }
    while (estimate(h) > budget && lastUser > 0) {
      h.shift();
      lastUser--;
    }
    while (h.length > 1 && h[0].role === 'tool') h.shift();
    if (estimate(h) > budget) {
      h = h.map((m) => (m.role === 'tool' && m.content.length > 2000 ? { ...m, content: m.content.slice(0, 2000) + '\n…(trimmed to fit the context)' } : m));
    }
    return h;
  }

  /** Runs one call. Returns what was run (for command checks), or undefined if it was skipped, blocked or unknown. */
  private async runToolCall(chat: StoredChat, call: RawToolCall, tools: ToolDef[], vision: boolean, signal: AbortSignal, skip?: string, active: CommandEntry[] = []): Promise<CallRecord | undefined> {
    const name = call.function?.name ?? '';
    const args = parseArgs(call.function?.arguments);
    const def = tools.find((t) => t.name === name);
    let info: { title: string; detail: string; icon: string };
    try {
      info = def ? def.describe(args) : { title: `Unknown tool ${name}`, detail: JSON.stringify(args).slice(0, 300), icon: 'warning' };
    } catch {
      info = { title: name, detail: '', icon: 'tools' };
    }
    const row: Stored = { id: uid(), role: 'tool', content: '', tool: { name, ...info } };
    chat.messages.push(row);
    this.postFor(chat.id, { type: 'messageAdd', message: forUI(row) });

    let denied = false;
    let text: string;
    let images: string[] | undefined;
    let ran = false;
    const ban = bannedBy(active, name, args);
    if (skip) {
      text = skip;
    } else if (ban) {
      text = blockedMessage(ban.command, ban.item);
    } else if (!def) {
      text = `There's no tool called "${name}" here. Use only the tools you were given.`;
    } else {
      ran = true;
      const ctx = this.makeCtx(chat.id, chat.web, vision, signal, false, name, args, () => { denied = true; });
      this.setActivity(info.title + '…');
      try {
        const out: string | ToolResult = await def.run(args, ctx);
        if (typeof out === 'string') {
          text = out;
        } else {
          text = out.text;
          if (vision && out.images?.length) images = out.images;
        }
      } catch (e) {
        text = 'The tool failed: ' + errMessage(e);
      }
      this.setActivity(null);
    }
    row.tool = { name, ...info, output: truncate(text, TOOL_OUTPUT_LIMIT), denied: denied || undefined };
    if (images) row.images = images;
    this.postFor(chat.id, { type: 'messageUpdate', message: forUI(row) });
    return ran ? { name, args, denied } : undefined;
  }

  // MARK: sub-agents

  /** A helper with a fresh context and read-only tools, on the same model, ≤ 10 steps. */
  private async runSubAgent(task: string, chat: StoredChat, model: string, numCtx: number, vision: boolean, signal: AbortSignal, active: CommandEntry[] = []): Promise<string> {
    task = task.trim();
    if (!task) return 'The helper needs a task.';
    const client = new OllamaClient(this.settings.serverURL);
    const tools = this.toolsFor(this.makeCtx(chat.id, chat.web, vision, signal, true, '', {}, () => undefined), task);
    const toolJSON = tools.map(toOllama);
    const messages: OllamaMessage[] = [
      { role: 'system', content: subAgentPrompt(model, chat.web, this.settings) },
      { role: 'user', content: task },
    ];
    let last = '';
    try {
      for (let step = 0; step < 10; step++) {
        if (signal.aborted) return 'Stopped.';
        this.setActivity('Helper is thinking…');
        let r;
        try {
          r = await client.chat({ model, messages, tools: toolJSON, think: false, numCtx, keepAlive: this.settings.keepAlive }, signal);
        } catch (e) {
          return signal.aborted ? 'Stopped.' : 'The helper stopped: ' + friendly(e, model);
        }
        last = r.content;
        messages.push({ role: 'assistant', content: r.content, tool_calls: r.toolCalls.length ? r.toolCalls : undefined });
        if (!r.toolCalls.length) return stripThink(r.content) || '(The helper finished without a result.)';
        const imgs: string[] = [];
        for (const c of r.toolCalls) {
          const name = c.function?.name ?? '';
          const args = parseArgs(c.function?.arguments);
          const def = tools.find((t) => t.name === name);
          const ban = bannedBy(active, name, args);
          let text: string;
          if (ban) {
            text = blockedMessage(ban.command, ban.item);
          } else if (!def) {
            text = 'Helpers can only read, so that tool isn’t available.';
          } else {
            let title = name;
            try { title = def.describe(args).title; } catch { /* keep the name */ }
            this.setActivity('Helper: ' + title + '…');
            try {
              const out = await def.run(args, this.makeCtx(chat.id, chat.web, vision, signal, true, name, args, () => undefined));
              if (typeof out === 'string') {
                text = out;
              } else {
                text = out.text;
                if (vision && out.images?.length) imgs.push(...out.images);
              }
            } catch (e) {
              text = 'The tool failed: ' + errMessage(e);
            }
          }
          messages.push({ role: 'tool', content: truncate(text, TOOL_OUTPUT_LIMIT), tool_name: name });
        }
        if (imgs.length) messages.push({ role: 'user', content: TOOL_IMAGE_NOTE, images: imgs });
      }
    } finally {
      this.setActivity(null);
    }
    const partial = stripThink(last);
    return 'The helper ran out of steps.' + (partial ? ' Its last notes:\n' + partial : '');
  }

  // MARK: compaction

  /** Manual compaction ("Compact chat" or /compact): summarises everything so far. */
  private async compactNow() {
    if (this.generating) return;
    this.settings = loadSettings();
    const chat = this.current();
    if (!chat.messages.some((m) => !m.compaction)) return;
    const abort = new AbortController();
    this.generating = { chatId: chat.id, abort };
    this.postStatus();
    try {
      if (!(await this.server.ensure(true))) {
        void vscode.window.showWarningMessage(OFFLINE_TEXT);
        return;
      }
      const ok = await this.compact(chat, false, abort.signal);
      if (!ok && !abort.signal.aborted) void vscode.window.showInformationMessage('Nothing new to compact in this chat yet.');
      const a = assistant(this.settings, chat.assistantId);
      const c = this.lastCompaction(chat);
      // Rough: summary + ~6k chars of system prompt + whatever is after the summary.
      const used = Math.ceil(((c >= 0 ? chat.messages[c].content.length : 0) + 6000) / 4) +
        estimate(toOllamaHistory(chat.messages.slice(c + 1) as Stored[], false));
      chat.usage = { used, limit: a.contextLength || 32768 };
    } finally {
      this.generating = undefined;
      this.activity = null;
      this.store.save();
      this.postStatus();
      if (chat.usage) this.postFor(chat.id, { type: 'contextUsage', used: chat.usage.used, limit: chat.usage.limit });
    }
  }

  /** Summarises older messages into a compaction message. Auto keeps the last 2 user turns verbatim. */
  private async compact(chat: StoredChat, auto: boolean, signal: AbortSignal): Promise<boolean> {
    const a = assistant(this.settings, chat.assistantId);
    const start = this.lastCompaction(chat) + 1;
    let cut = chat.messages.length;
    if (auto) {
      const users: number[] = [];
      for (let i = start; i < chat.messages.length; i++) if (chat.messages[i].role === 'user' && !(chat.messages[i] as Stored).hidden) users.push(i);
      if (users.length < 3) return false;
      cut = users[users.length - 2];
    }
    const slice = (chat.messages.slice(start, cut) as Stored[]).filter((m) => !m.compaction && !m.hidden);
    if (!slice.length) return false;

    const lines: string[] = [];
    if (start > 0) lines.push('Summary of what came before:\n' + chat.messages[start - 1].content);
    for (const m of slice) {
      if (m.role === 'user') {
        lines.push('User: ' + m.content + (m.extraContext ? '\n' + m.extraContext.slice(0, 3000) : ''));
      } else if (m.role === 'assistant') {
        if (m.failed) continue;
        const calls = (m.toolCalls ?? []).map((c) => `${c.function?.name ?? ''}(${JSON.stringify(c.function?.arguments ?? {}).slice(0, 300)})`);
        lines.push(`${m.assistantName ?? 'Assistant'}: ${m.content}` + (calls.length ? `\n[called ${calls.join(', ')}]` : ''));
      } else if (m.tool) {
        lines.push(`Tool ${m.tool.name} (${m.tool.detail.slice(0, 200)})${m.tool.denied ? ' — denied' : ''}: ${(m.tool.output ?? '').slice(0, 2000)}`);
      }
    }
    const numCtx = a.contextLength || 32768;
    let transcript = lines.join('\n\n');
    const maxChars = Math.floor(numCtx * 4 * 0.6);
    if (transcript.length > maxChars) transcript = '…(the start is cut)\n' + transcript.slice(-maxChars);

    this.setActivity('Compacting chat…');
    try {
      const r = await new OllamaClient(this.settings.serverURL).chat(
        {
          model: a.model,
          messages: [
            { role: 'system', content: COMPACT_PROMPT },
            { role: 'user', content: transcript },
          ],
          think: false,
          numCtx,
          keepAlive: this.settings.keepAlive,
        },
        signal,
      );
      const summary = stripThink(r.content);
      if (!summary) return false;
      const marker: Stored = {
        id: uid(),
        role: 'assistant',
        content: summary,
        assistantName: a.name,
        model: prettyModel(a.model),
        compaction: { summarisedCount: slice.length, auto },
      };
      chat.messages.splice(cut, 0, marker);
      chat.updated = Date.now();
      this.store.save();
      this.postFor(chat.id, { type: 'init', state: this.state() });
      return true;
    } catch (e) {
      if (!signal.aborted) void vscode.window.showWarningMessage('Ingle couldn’t compact this chat. ' + friendly(e, a.model));
      return false;
    } finally {
      this.setActivity(null);
    }
  }

  // MARK: code actions

  private async visibleEditor(): Promise<vscode.TextEditor | undefined> {
    const ed = this.editor();
    if (!ed) {
      void vscode.window.showWarningMessage('Open a file first, then try again.');
      return undefined;
    }
    if (vscode.window.visibleTextEditors.includes(ed)) return ed;
    return vscode.window.showTextDocument(ed.document, { viewColumn: ed.viewColumn, preserveFocus: false });
  }

  private async insertCode(code: string) {
    const ed = await this.visibleEditor();
    if (!ed) return;
    const at = ed.selection.active;
    await ed.edit((b) => b.insert(at, code));
  }

  private async applyCode(code: string) {
    const ed = await this.visibleEditor();
    if (!ed) return;
    if (!ed.selection.isEmpty) {
      const sel = ed.selection;
      await ed.edit((b) => b.replace(sel, code));
      return;
    }
    const doc = ed.document;
    const name = path.basename(doc.fileName);
    await this.diff.show(doc.uri.scheme === 'file' ? doc.uri.fsPath : undefined, code, `${name} ↔ Ingle’s code`, doc.getText());
    const choice = await vscode.window.showInformationMessage(`Replace all of ${name} with Ingle’s code?`, { modal: true }, 'Apply');
    if (choice !== 'Apply') return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), code);
    await vscode.workspace.applyEdit(edit);
    await vscode.window.showTextDocument(doc, { viewColumn: ed.viewColumn });
  }
}
