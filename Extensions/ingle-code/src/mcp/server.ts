// A small MCP server over stdio (newline-delimited JSON-RPC 2.0), written by hand like Ingle's MCPConnection.
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { CodeEngine } from '../engine/engine';
import { TOOL_SPECS, callTool } from '../engine/tools';
import { EngineOptions } from '../engine/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export const VERSION = '0.1.0';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = 'Read-only code intelligence. Use references/callers/impact to find every use of a symbol before changing it, '
  + 'diagnostics to check for type errors, and read_exhaustively for files too big to read. Each result says exact (language server) '
  + 'or approximate (text scan). Results are paged: ask for the next page when told to.';

export interface McpServerOptions extends Omit<EngineOptions, 'root'> {
  /** Workspace root. If missing, the client's first root (roots/list) is used, then the current folder. */
  root?: string;
}

export class McpServer {
  private engine?: CodeEngine;
  private enginePromise?: Promise<CodeEngine>;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, (msg: Json) => void>();
  private clientRoots = false;
  private closed = false;

  constructor(private readonly input: Readable, private readonly output: Writable, private readonly opts: McpServerOptions) {}

  /** Start reading. Resolves when the input ends. */
  run(): Promise<void> {
    return new Promise((resolve) => {
      this.input.setEncoding('utf8');
      this.input.on('data', (d: string) => this.onData(d));
      this.input.on('end', () => resolve());
      this.input.on('close', () => resolve());
    });
  }

  private onData(d: string): void {
    this.buf += d;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: Json;
      try { msg = JSON.parse(line); } catch {
        this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      for (const m of Array.isArray(msg) ? msg : [msg]) void this.handle(m);
    }
  }

  private send(msg: Json): void {
    if (this.closed) return;
    this.output.write(JSON.stringify(msg) + '\n');
  }

  private async handle(msg: Json): Promise<void> {
    if (msg.method === undefined && msg.id !== undefined) {
      const cb = this.pending.get(msg.id);
      if (cb) { this.pending.delete(msg.id); cb(msg); }
      return;
    }
    const id = msg.id;
    const reply = (result: Json) => { if (id !== undefined) this.send({ jsonrpc: '2.0', id, result }); };
    const fail = (code: number, message: string) => { if (id !== undefined) this.send({ jsonrpc: '2.0', id, error: { code, message } }); };
    try {
      switch (msg.method) {
        case 'initialize': {
          const asked = msg.params?.protocolVersion;
          this.clientRoots = !!msg.params?.capabilities?.roots;
          reply({
            protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'ingle-code', version: VERSION },
            instructions: INSTRUCTIONS,
          });
          return;
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
        case 'notifications/roots/list_changed':
          return;
        case 'ping':
          reply({});
          return;
        case 'tools/list':
          reply({ tools: TOOL_SPECS });
          return;
        case 'tools/call': {
          const name = String(msg.params?.name ?? '');
          let engine: CodeEngine;
          try { engine = await this.getEngine(); } catch (e) {
            reply({ content: [{ type: 'text', text: (e as Error).message }], isError: true });
            return;
          }
          const out = await callTool(engine, name, msg.params?.arguments ?? {});
          reply({ content: [{ type: 'text', text: out.text }], isError: out.isError });
          return;
        }
        default:
          if (id !== undefined) fail(-32601, `Method not found: ${msg.method}`);
      }
    } catch (e) {
      fail(-32603, (e as Error).message);
    }
  }

  private request(method: string, params: Json, timeoutMs = 5000): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.pending.delete(id); resolve(undefined); }, timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(t); resolve(m.result); });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private getEngine(): Promise<CodeEngine> {
    if (this.engine) return Promise.resolve(this.engine);
    if (!this.enginePromise) {
      this.enginePromise = (async () => {
        let root = this.opts.root;
        if (!root && this.clientRoots) {
          const res = await this.request('roots/list', {});
          const first = res?.roots?.find((r: Json) => typeof r?.uri === 'string' && r.uri.startsWith('file:'));
          if (first) root = fileURLToPath(first.uri);
        }
        const engine = new CodeEngine({ ...this.opts, root: root ?? process.cwd() });
        this.opts.log?.(`workspace: ${engine.root}`);
        this.engine = engine;
        return engine;
      })();
      this.enginePromise.catch(() => { this.enginePromise = undefined; });
    }
    return this.enginePromise;
  }

  /** Stop every language server. */
  async close(): Promise<void> {
    this.closed = true;
    const e = this.engine ?? (await this.enginePromise?.catch(() => undefined));
    await e?.dispose();
  }

  killNow(): void {
    this.engine?.killNow();
  }
}
