// A small Language Server Protocol client: JSON-RPC over stdio with Content-Length framing, written by hand.
// It only reads: it never applies edits a server asks for.
import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { EngineError } from './types';
import { sleep } from './util';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;

export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspLocation { uri: string; range: LspRange }
export interface LspDiagnostic { range: LspRange; severity?: number; code?: string | number; source?: string; message: string }

interface Pending { resolve: (v: Json) => void; reject: (e: Error) => void; method: string }
interface OpenDoc { version: number; mtimeMs: number; size: number; usedAt: number }

const MAX_OPEN_DOCS = 300;

export function fileUri(abs: string): string {
  return pathToFileURL(abs).href;
}

export function uriPath(uri: string): string {
  try { return fileURLToPath(uri); } catch { return uri; }
}

export class LspClient {
  private proc?: ChildProcess;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private docs = new Map<string, OpenDoc>();
  private progress = new Map<string | number, number>();
  private wasIdle = false;
  private lastProgressAt = 0;
  private startedAt = 0;
  private diagWaiters = new Map<string, Array<() => void>>();
  private exitReason?: string;
  readonly diagnostics = new Map<string, { version?: number; items: LspDiagnostic[]; at: number }>();
  capabilities: Json = {};
  lastUsed = Date.now();
  stderrTail = '';

  constructor(
    readonly name: string,
    private readonly cmd: string,
    private readonly args: string[],
    readonly root: string,
    private readonly languageIdFor: (file: string) => string,
    private readonly log: (m: string) => void = () => {},
    private readonly initializationOptions: Json = undefined,
  ) {}

  get alive(): boolean {
    return !!this.proc && this.exitReason === undefined;
  }

  async start(timeoutMs = 60_000): Promise<void> {
    this.startedAt = Date.now();
    const proc = spawn(this.cmd, this.args, { cwd: this.root, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    this.proc = proc;
    proc.stdout!.on('data', (d: Buffer) => this.onData(d));
    proc.stderr!.on('data', (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString('utf8')).slice(-2000); });
    proc.stdin!.on('error', () => { /* server gone; handled by exit */ });
    const failAll = (reason: string) => {
      if (this.exitReason === undefined) this.exitReason = reason;
      for (const p of this.pending.values()) p.reject(new EngineError(`${this.name} stopped (${reason}) during ${p.method}`));
      this.pending.clear();
    };
    proc.on('error', (e) => failAll(e.message));
    proc.on('exit', (code, sig) => failAll(sig ? `signal ${sig}` : `exit code ${code}`));

    const rootUri = fileUri(this.root);
    const init = this.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'ingle-code', version: '0.1.0' },
      rootUri,
      rootPath: this.root,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) }],
      initializationOptions: this.initializationOptions,
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        window: { workDoneProgress: true },
        workspace: {
          configuration: true,
          workspaceFolders: true,
          symbol: { dynamicRegistration: false },
          didChangeWatchedFiles: { dynamicRegistration: false },
          diagnostics: { refreshSupport: false },
        },
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          definition: { linkSupport: true },
          references: {},
          callHierarchy: { dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: false, versionSupport: true },
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
        },
      },
    }, timeoutMs);
    const res = await init;
    this.capabilities = res?.capabilities ?? {};
    this.notify('initialized', {});
  }

  request<T = Json>(method: string, params: Json, timeoutMs = 60_000): Promise<T> {
    if (this.exitReason !== undefined) return Promise.reject(new EngineError(`${this.name} is not running (${this.exitReason})`));
    this.lastUsed = Date.now();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
          reject(new EngineError(`${this.name} did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: Json): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(msg: Json): void {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) return;
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buf.subarray(0, headerEnd).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.buf = this.buf.subarray(headerEnd + 4); continue; }
      const len = Number(m[1]);
      if (this.buf.length < headerEnd + 4 + len) return;
      const body = this.buf.subarray(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(headerEnd + 4 + len);
      let msg: Json;
      try { msg = JSON.parse(body); } catch { continue; }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Json): void {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new EngineError(`${this.name}: ${msg.error.message ?? 'error'} (${p.method})`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined) { this.answerServerRequest(msg); return; }
    switch (msg.method) {
      case '$/progress': {
        const kind = msg.params?.value?.kind;
        this.lastProgressAt = Date.now();
        if (kind === 'begin' && !this.progress.has(msg.params.token)) this.progress.set(msg.params.token, Date.now());
        if (kind === 'end') this.progress.delete(msg.params.token);
        break;
      }
      case 'textDocument/publishDiagnostics': {
        const uri: string = msg.params?.uri;
        this.diagnostics.set(uri, { version: msg.params?.version, items: msg.params?.diagnostics ?? [], at: Date.now() });
        const w = this.diagWaiters.get(uri);
        if (w) { this.diagWaiters.delete(uri); w.forEach((f) => f()); }
        break;
      }
      case 'window/logMessage':
      case 'window/showMessage':
        if ((msg.params?.type ?? 4) <= 2) this.log(`${this.name}: ${msg.params?.message}`);
        break;
      default:
        break;
    }
  }

  private answerServerRequest(msg: Json): void {
    let result: Json = null;
    switch (msg.method) {
      case 'workspace/configuration':
        result = (msg.params?.items ?? []).map(() => null);
        break;
      case 'workspace/workspaceFolders':
        result = [{ uri: fileUri(this.root), name: path.basename(this.root) }];
        break;
      case 'workspace/applyEdit':
        result = { applied: false, failureReason: 'ingle-code is read-only' };
        break;
      case 'window/workDoneProgress/create':
        this.lastProgressAt = Date.now();
        break;
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/showMessageRequest':
      case 'workspace/diagnostic/refresh':
      case 'workspace/semanticTokens/refresh':
      case 'workspace/inlayHint/refresh':
      case 'workspace/codeLens/refresh':
        break;
      default:
        this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unsupported: ${msg.method}` } });
        return;
    }
    this.send({ jsonrpc: '2.0', id: msg.id, result });
  }

  /** Open (or refresh) a file so the server knows its current text. Returns its URI. */
  ensureOpen(abs: string): string {
    const uri = fileUri(abs);
    const st = fs.statSync(abs);
    const doc = this.docs.get(uri);
    if (doc && doc.mtimeMs === st.mtimeMs && doc.size === st.size) { doc.usedAt = Date.now(); return uri; }
    const text = fs.readFileSync(abs, 'utf8');
    if (!doc) {
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId: this.languageIdFor(abs), version: 1, text } });
      this.docs.set(uri, { version: 1, mtimeMs: st.mtimeMs, size: st.size, usedAt: Date.now() });
      this.trimDocs();
    } else {
      doc.version += 1;
      doc.mtimeMs = st.mtimeMs;
      doc.size = st.size;
      doc.usedAt = Date.now();
      this.diagnostics.delete(uri);
      this.notify('textDocument/didChange', { textDocument: { uri, version: doc.version }, contentChanges: [{ text }] });
    }
    return uri;
  }

  docVersion(uri: string): number | undefined {
    return this.docs.get(uri)?.version;
  }

  private trimDocs(): void {
    if (this.docs.size <= MAX_OPEN_DOCS) return;
    const oldest = [...this.docs.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt).slice(0, this.docs.size - MAX_OPEN_DOCS);
    for (const [uri] of oldest) {
      this.notify('textDocument/didClose', { textDocument: { uri } });
      this.docs.delete(uri);
    }
  }

  /**
   * Wait until the server has reported no work in progress for a moment (indexing, project loading).
   * The full wait is only for the first time; once the server has been idle, later waits are short, and a progress
   * report left open longer than `maxMs` is treated as stale, so one odd server can't slow every call.
   */
  async waitForIdle(maxMs: number, quietMs = 1500): Promise<boolean> {
    const limit = this.wasIdle ? Math.min(maxMs, 15_000) : maxMs;
    const deadline = Date.now() + limit;
    const grace = this.startedAt + 2500;
    while (Date.now() < deadline) {
      if (!this.alive) return false;
      const now = Date.now();
      let open = 0;
      for (const began of this.progress.values()) if (now - began < maxMs) open++;
      if (open === 0 && now >= grace && now - this.lastProgressAt >= quietMs) { this.wasIdle = true; return true; }
      await sleep(150);
    }
    this.wasIdle = true;
    return false;
  }

  /** Wait for pushed diagnostics for this URI (at the current version), then let them settle. */
  async waitForPushedDiagnostics(uri: string, maxMs: number, settleMs = 1200): Promise<LspDiagnostic[] | undefined> {
    const deadline = Date.now() + maxMs;
    const version = this.docVersion(uri);
    const fresh = () => {
      const d = this.diagnostics.get(uri);
      return d && (d.version === undefined || version === undefined || d.version >= version) ? d : undefined;
    };
    while (!fresh() && Date.now() < deadline && this.alive) {
      await new Promise<void>((resolve) => {
        const list = this.diagWaiters.get(uri) ?? [];
        const t = setTimeout(resolve, Math.max(50, Math.min(500, deadline - Date.now())));
        list.push(() => { clearTimeout(t); resolve(); });
        this.diagWaiters.set(uri, list);
      });
    }
    if (!fresh()) return undefined;
    // Servers often send syntax errors first and semantic errors a moment later.
    for (;;) {
      const at = fresh()!.at;
      const wait = at + settleMs - Date.now();
      if (wait <= 0 || Date.now() >= deadline) break;
      await sleep(Math.min(wait, 200));
    }
    return fresh()?.items;
  }

  async shutdown(): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise<void>((r) => proc.once('exit', () => r()));
    try {
      if (this.exitReason === undefined) {
        await Promise.race([this.request('shutdown', undefined, 3000), sleep(3000)]);
        this.notify('exit', undefined);
      }
    } catch { /* kill below */ }
    const killed = await Promise.race([exited.then(() => true), sleep(2000).then(() => false)]);
    if (!killed) {
      proc.kill('SIGTERM');
      const gone = await Promise.race([exited.then(() => true), sleep(2000).then(() => false)]);
      if (!gone) proc.kill('SIGKILL');
    }
    this.exitReason = this.exitReason ?? 'shut down';
  }

  /** Synchronous last resort for process exit handlers. */
  killNow(): void {
    try { this.proc?.kill('SIGTERM'); } catch { /* already gone */ }
  }
}
