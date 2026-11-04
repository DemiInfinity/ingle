// A small stdio MCP client so the extension can use MCP servers itself (the Mac app has its own).
// JSON-RPC 2.0 over newline-delimited stdio: initialize → notifications/initialized → tools/list → tools/call.
// One manager for the whole extension (shared by every tab); servers start lazily on first use,
// restart once after a crash, and are all killed on dispose. Doesn't use the vscode API itself.
import { ChildProcess, spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import type { IngleSettings } from '../shared/settings';
import { DENIED } from './paths';
import { MCPServerConfig, mcpServers } from './stores';
import { str, type ToolArgs, type ToolDef } from './types';

const PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT = 30_000;
/** First runs of `npx -y …` download the server, so the handshake gets longer than a normal request. */
const START_TIMEOUT = 90_000;
const RESULT_LIMIT = 20_000;

export interface McpToolInfo { name: string; description: string; inputSchema: unknown }

interface Pending { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }

class McpConnection {
  private proc?: ChildProcess;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderr = '';
  tools: McpToolInfo[] = [];
  alive = false;
  /** Set when the process exits; the manager uses it to decide on a restart. */
  onExit?: (detail: string) => void;
  private stopping = false;

  constructor(readonly config: MCPServerConfig, private readonly cwd: string) {}

  async start(version: string): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.config.env };
    // GUI-launched editors on macOS often miss Homebrew's folders, which is where npx/uvx/node usually live.
    if (process.platform !== 'win32') {
      const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
      const have = (env.PATH ?? '').split(':');
      env.PATH = [...have, ...extra.filter((p) => !have.includes(p))].filter(Boolean).join(':');
    }
    await new Promise<void>((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = spawn(this.config.command, this.config.args, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      this.proc = proc;
      proc.once('spawn', () => { this.alive = true; resolve(); });
      proc.once('error', (e) => {
        if (!this.alive) reject(new Error(`couldn't start ${this.config.command}: ${e.message}`));
        else this.exited(`error: ${e.message}`);
      });
      proc.on('exit', (code, signal) => this.exited(signal ? `stopped by ${signal}` : `exited with code ${code}`));
      proc.stdout?.setEncoding('utf8');
      proc.stdout?.on('data', (d: string) => this.onData(d));
      proc.stderr?.setEncoding('utf8');
      proc.stderr?.on('data', (d: string) => { this.stderr = (this.stderr + d).slice(-2000); });
      proc.stdin?.on('error', () => { /* the exit handler reports it */ });
    });
    try {
      await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'Ingle', version },
      }, START_TIMEOUT);
      this.notify('notifications/initialized', {});
      await this.refreshTools();
    } catch (e) {
      this.kill();
      throw e;
    }
  }

  async refreshTools(): Promise<void> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = (await this.request('tools/list', cursor ? { cursor } : {})) as { tools?: unknown[]; nextCursor?: unknown } | null;
      for (const t of r?.tools ?? []) {
        const x = t as { name?: unknown; description?: unknown; inputSchema?: unknown };
        if (typeof x.name === 'string') out.push({ name: x.name, description: typeof x.description === 'string' ? x.description : '', inputSchema: x.inputSchema ?? {} });
      }
      cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    this.tools = out;
  }

  private exited(detail: string) {
    if (!this.alive && !this.proc) return;
    const wasAlive = this.alive;
    this.alive = false;
    this.proc = undefined;
    const tail = this.stderr.trim().split('\n').slice(-3).join(' ').trim();
    const why = `${this.config.name} ${detail}` + (tail ? ` — ${tail.slice(0, 400)}` : '');
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(why)); }
    this.pending.clear();
    if (wasAlive && !this.stopping) this.onExit?.(why);
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: unknown; method?: unknown; result?: unknown; error?: { message?: unknown; code?: unknown } };
      try { msg = JSON.parse(line); } catch { continue; } // servers sometimes log to stdout
      if (typeof msg.method === 'string') {
        if (msg.id !== undefined && msg.id !== null) this.answerServer(msg.id, msg.method);
        else if (msg.method === 'notifications/tools/list_changed') void this.refreshTools().catch(() => undefined);
        continue;
      }
      if (typeof msg.id !== 'number') continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(String(msg.error.message ?? 'error') + (msg.error.code !== undefined ? ` (${String(msg.error.code)})` : '')));
      else p.resolve(msg.result);
    }
  }

  /** Requests from the server: answer ping, decline the rest (we offer no client capabilities). */
  private answerServer(id: unknown, method: string) {
    if (method === 'ping') this.write({ jsonrpc: '2.0', id, result: {} });
    else this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Ingle doesn't support ${method}` } });
  }

  private write(obj: unknown) {
    try { this.proc?.stdin?.write(JSON.stringify(obj) + '\n'); } catch { /* exit handler reports it */ }
  }

  notify(method: string, params: unknown) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  request(method: string, params: unknown, timeout = REQUEST_TIMEOUT, signal?: AbortSignal): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error(`${this.config.name} isn't running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        clearTimeout(this.pending.get(id)!.timer);
        this.pending.delete(id);
        this.notify('notifications/cancelled', { requestId: id, reason: 'Stopped by the user' });
        reject(new Error('Stopped.'));
      };
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        cleanup();
        this.notify('notifications/cancelled', { requestId: id, reason: 'Timed out' });
        reject(new Error(`${this.config.name} didn't answer ${method} within ${Math.round(timeout / 1000)} s`));
      }, timeout);
      this.pending.set(id, {
        resolve: (v) => { cleanup(); resolve(v); },
        reject: (e) => { cleanup(); reject(e); },
        timer,
      });
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort);
      }
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  kill() {
    this.stopping = true;
    const p = this.proc;
    this.exited('was stopped');
    if (p && p.exitCode === null) {
      try { p.stdin?.end(); } catch { /* ignore */ }
      try { p.kill(); } catch { /* ignore */ }
      const t = setTimeout(() => { try { if (p.exitCode === null) p.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
      t.unref?.();
    }
  }
}

/** Joins text parts; notes images, audio and resources by type; caps the size. */
export function formatToolResult(r: unknown): string {
  const res = (r ?? {}) as { content?: unknown[]; isError?: unknown; structuredContent?: unknown };
  const parts: string[] = [];
  for (const c of Array.isArray(res.content) ? res.content : []) {
    const x = c as { type?: unknown; text?: unknown; mimeType?: unknown; uri?: unknown; name?: unknown; resource?: { uri?: unknown; text?: unknown; mimeType?: unknown } };
    switch (x.type) {
      case 'text': parts.push(typeof x.text === 'string' ? x.text : ''); break;
      case 'image': parts.push(`[image${typeof x.mimeType === 'string' ? ` (${x.mimeType})` : ''} — not shown]`); break;
      case 'audio': parts.push(`[audio${typeof x.mimeType === 'string' ? ` (${x.mimeType})` : ''} — not played]`); break;
      case 'resource_link': parts.push(`[resource link: ${String(x.uri ?? x.name ?? '')}]`); break;
      case 'resource': {
        const rr = x.resource ?? {};
        parts.push(`[resource: ${String(rr.uri ?? '')}${typeof rr.mimeType === 'string' ? ` (${rr.mimeType})` : ''}]` + (typeof rr.text === 'string' ? '\n' + rr.text : ''));
        break;
      }
      default: parts.push(`[${String(x.type ?? 'unknown')} content]`);
    }
  }
  let text = parts.join('\n').trim();
  if (!text && res.structuredContent !== undefined) text = JSON.stringify(res.structuredContent, null, 1);
  if (!text) text = '(The tool returned nothing.)';
  if (res.isError === true) text = 'The tool reported an error:\n' + text;
  return text.length > RESULT_LIMIT ? text.slice(0, RESULT_LIMIT) + `\n…(trimmed ${text.length - RESULT_LIMIT} characters)` : text;
}

function compactSchema(schema: unknown): string {
  let s = '';
  try { s = JSON.stringify(schema ?? {}); } catch { s = '{}'; }
  return s.length > 700 ? s.slice(0, 700) + '…' : s;
}

export class McpManager {
  private readonly conns = new Map<string, McpConnection>();
  private readonly starting = new Map<string, Promise<McpConnection>>();
  /** Servers that have crashed once and been restarted (a second crash isn't restarted until Reload). */
  private readonly crashed = new Map<string, number>();
  private readonly errors = new Map<string, string>();
  private version = '0.0.0';
  private disposed = false;

  setClientVersion(v: string) { if (v) this.version = v; }

  /** Configured servers, minus the ones switched off in Ingle's settings. */
  enabledServers(settings: IngleSettings): MCPServerConfig[] {
    const off = new Set(settings.mcpDisabled ?? []);
    let all: MCPServerConfig[] = [];
    try { all = mcpServers(); } catch { /* none */ }
    return all.filter((s) => !off.has(s.name));
  }

  private find(name: string, settings: IngleSettings): MCPServerConfig | undefined {
    const key = name.trim().toLowerCase();
    return this.enabledServers(settings).find((s) => s.name.toLowerCase() === key);
  }

  private serverList(settings: IngleSettings): string {
    return this.enabledServers(settings).map((s) => s.name).join(', ') || 'none';
  }

  /** Starts the server if needed. Returns the connection, or an error sentence. */
  async ready(name: string, settings: IngleSettings, root: string | undefined): Promise<McpConnection | string> {
    if (this.disposed) return 'MCP is shutting down.';
    const cfg = this.find(name, settings);
    if (!cfg) {
      const off = (settings.mcpDisabled ?? []).some((s) => s.toLowerCase() === name.trim().toLowerCase());
      return off ? `The ${name} MCP server is turned off in Ingle's settings.` : `There's no MCP server called ${name}. Servers: ${this.serverList(settings)}.`;
    }
    const live = this.conns.get(cfg.name);
    if (live?.alive) return live;
    if ((this.crashed.get(cfg.name) ?? 0) > 1) {
      const why = (this.errors.get(cfg.name) ?? '').replace(/[.\s]*$/, '');
      return `${cfg.name} crashed twice, so Ingle has stopped restarting it${why ? ` (${why})` : ''}. Use Reload in /mcp to try again.`;
    }
    let p = this.starting.get(cfg.name);
    if (!p) {
      p = this.launch(cfg, root);
      this.starting.set(cfg.name, p);
    }
    try {
      return await p;
    } catch (e) {
      return `The ${cfg.name} MCP server couldn't start: ${(e as Error).message}`;
    } finally {
      this.starting.delete(cfg.name);
    }
  }

  private async launch(cfg: MCPServerConfig, root: string | undefined): Promise<McpConnection> {
    const c = new McpConnection(cfg, root ?? os.homedir());
    try {
      await c.start(this.version);
    } catch (e) {
      this.errors.set(cfg.name, (e as Error).message);
      throw e;
    }
    if (this.disposed) { c.kill(); throw new Error('shutting down'); }
    this.errors.delete(cfg.name);
    c.onExit = (why) => {
      if (this.conns.get(cfg.name) === c) this.conns.delete(cfg.name);
      this.errors.set(cfg.name, why);
      // Restarted lazily on next use, once.
      this.crashed.set(cfg.name, (this.crashed.get(cfg.name) ?? 0) + 1);
    };
    this.conns.get(cfg.name)?.kill();
    this.conns.set(cfg.name, c);
    return c;
  }

  async describeTools(name: string, settings: IngleSettings, root: string | undefined): Promise<string> {
    const c = await this.ready(name, settings, root);
    if (typeof c === 'string') return c;
    if (!c.tools.length) return `${c.config.name} has no tools.`;
    return `${c.config.name} tools (use with mcp_call):\n` +
      c.tools.map((t) => `- ${t.name}: ${t.description.replace(/\s+/g, ' ').trim().slice(0, 400)}\n  inputs: ${compactSchema(t.inputSchema)}`).join('\n');
  }

  async call(name: string, tool: string, args: Record<string, unknown>, settings: IngleSettings, root: string | undefined, signal: AbortSignal): Promise<string> {
    const c = await this.ready(name, settings, root);
    if (typeof c === 'string') return c;
    if (!c.tools.some((t) => t.name === tool)) {
      const near = c.tools.find((t) => t.name.toLowerCase() === tool.trim().toLowerCase());
      if (!near) return `${c.config.name} has no tool called ${tool}. Use mcp_tools to see its tools.`;
      tool = near.name;
    }
    try {
      return formatToolResult(await c.request('tools/call', { name: tool, arguments: args }, REQUEST_TIMEOUT, signal));
    } catch (e) {
      return signal.aborted ? 'Stopped.' : `The tool failed: ${(e as Error).message}`;
    }
  }

  /** Whether this extension has the server running, and its tool names. */
  status(name: string): { tools: string[] } | undefined {
    const c = this.conns.get(name);
    return c?.alive ? { tools: c.tools.map((t) => t.name) } : undefined;
  }

  lastError(name: string): string | undefined { return this.errors.get(name); }

  /** Re-reads the configs: stops servers that were removed, switched off or changed, and clears crash counts. */
  reload(settings: IngleSettings) {
    const wanted = new Map(this.enabledServers(settings).map((s) => [s.name, JSON.stringify([s.command, s.args, s.env])]));
    for (const [name, c] of [...this.conns]) {
      if (wanted.get(name) !== JSON.stringify([c.config.command, c.config.args, c.config.env])) {
        this.conns.delete(name);
        c.kill();
      }
    }
    this.crashed.clear();
    this.errors.clear();
  }

  dispose() {
    this.disposed = true;
    for (const c of this.conns.values()) c.kill();
    this.conns.clear();
  }
}

/** The one manager for the extension. */
export const mcp = new McpManager();

/** Tool names that MCP tool selection is about. */
export const MCP_TOOL_NAMES = ['mcp_tools', 'mcp_call'];

/** Mirrors ToolSelection.wantsMCP on the Mac: "mcp" or a configured server's name in the message. */
export function wantsMCP(lastUserLower: string): boolean {
  if (lastUserLower.includes('mcp')) return true;
  let names: string[] = [];
  try { names = mcpServers().map((s) => s.name.toLowerCase()); } catch { /* none */ }
  return names.some((n) => n && lastUserLower.includes(n));
}

function mcpArguments(a: ToolArgs): Record<string, unknown> {
  const v = a.arguments;
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string' && v.trim()) {
    try {
      const o = JSON.parse(v) as unknown;
      if (o && typeof o === 'object' && !Array.isArray(o)) return o as Record<string, unknown>;
    } catch { /* not JSON */ }
  }
  return {};
}

export const mcpTools: ToolDef[] = [
  {
    name: 'mcp_tools',
    description: 'List what an MCP server can do: its tools, what they do and their inputs.',
    parameters: { type: 'object', properties: { server: { type: 'string', description: 'The MCP server\'s name from the index' } }, required: ['server'] },
    readOnly: true,
    available: (ctx) => mcp.enabledServers(ctx.settings).length > 0,
    describe: (a) => ({ title: 'Look inside an MCP server', detail: str(a, 'server'), icon: 'plug' }),
    async run(a, ctx) {
      const server = str(a, 'server').trim();
      if (!server) return `Say which server. Servers: ${mcp.enabledServers(ctx.settings).map((s) => s.name).join(', ')}.`;
      ctx.setActivity(`Connecting to ${server}…`);
      try { return await mcp.describeTools(server, ctx.settings, ctx.workspaceRoot); } finally { ctx.setActivity(null); }
    },
  },
  {
    name: 'mcp_call',
    description: 'Use one tool from an MCP server. Check its inputs with mcp_tools first. The user must approve.',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'The MCP server\'s name' },
        tool: { type: 'string', description: 'The tool\'s name' },
        arguments: { type: 'object', description: 'The tool\'s inputs, as an object' },
      },
      required: ['server', 'tool'],
    },
    readOnly: false,
    available: (ctx) => mcp.enabledServers(ctx.settings).length > 0,
    describe: (a) => ({ title: 'Use an MCP tool', detail: `${str(a, 'server')} · ${str(a, 'tool')}`, icon: 'plug' }),
    async run(a, ctx) {
      const server = str(a, 'server').trim(), tool = str(a, 'tool').trim();
      if (!server || !tool) return 'mcp_call needs a server and a tool. Use mcp_tools to see what a server offers.';
      const args = mcpArguments(a);
      // Start it first so a missing server or tool is reported before asking the user.
      ctx.setActivity(`Connecting to ${server}…`);
      const ready = await mcp.ready(server, ctx.settings, ctx.workspaceRoot);
      ctx.setActivity(null);
      if (typeof ready === 'string') return ready;
      if (!ready.tools.some((t) => t.name.toLowerCase() === tool.toLowerCase())) {
        return `${ready.config.name} has no tool called ${tool}. Use mcp_tools to see its tools.`;
      }
      const answer = await ctx.requestApproval({
        kind: 'mcp', title: 'Wants to use an MCP tool', detail: `${ready.config.name} · ${tool}`,
        preview: JSON.stringify({ server: ready.config.name, tool, arguments: args }, null, 2).slice(0, 6000),
      });
      if (answer !== 'allow') return DENIED;
      ctx.setActivity(`${ready.config.name}: ${tool}…`);
      try { return await mcp.call(ready.config.name, tool, args, ctx.settings, ctx.workspaceRoot, ctx.signal); } finally { ctx.setActivity(null); }
    },
  },
];
