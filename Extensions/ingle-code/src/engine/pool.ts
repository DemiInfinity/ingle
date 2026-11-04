// Keeps one language server per language warm for a workspace, and shuts each down when it's been idle.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Language, LANGUAGES, languageOf } from './languages';
import { LspClient } from './lsp';
import { which } from './util';

export interface FoundServer {
  cmd: string;
  path: string;
  args: string[];
}

interface Entry {
  client?: LspClient;
  starting?: Promise<LspClient | undefined>;
  failed?: string;
  failedAt?: number;
}

const RETRY_FAILED_MS = 5 * 60_000;

export class ServerPool {
  private entries = new Map<string, Entry>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly root: string,
    private readonly opts: { idleMs: number; disabled: boolean; only?: string[]; log: (m: string) => void },
  ) {
    this.timer = setInterval(() => void this.sweep(), Math.min(30_000, Math.max(1000, opts.idleMs / 2)));
    this.timer.unref();
  }

  /** The server binary for a language, if one is installed (PATH, then the workspace's node_modules/.bin). */
  find(lang: Language): FoundServer | undefined {
    if (lang.id === 'typescript') return findTypescriptServer(this.root);
    const extra = [path.join(this.root, 'node_modules', '.bin')];
    for (const c of lang.servers) {
      const p = which(c.cmd, extra);
      if (p) return { cmd: c.cmd, path: p, args: c.args };
    }
    return undefined;
  }

  enabled(lang: Language): boolean {
    if (this.opts.disabled) return false;
    if (this.opts.only && !this.opts.only.includes(lang.id)) return false;
    return true;
  }

  running(langId: string): boolean {
    return !!this.entries.get(langId)?.client?.alive;
  }

  failure(langId: string): string | undefined {
    return this.entries.get(langId)?.failed;
  }

  /** Get a started server, or undefined (with failure() saying why) when there is none. */
  async get(lang: Language): Promise<LspClient | undefined> {
    if (!this.enabled(lang)) return undefined;
    let e = this.entries.get(lang.id);
    if (e?.client?.alive) { e.client.lastUsed = Date.now(); return e.client; }
    if (e?.starting) return e.starting;
    if (e?.failed && e.failedAt && Date.now() - e.failedAt < RETRY_FAILED_MS) return undefined;
    const found = this.find(lang);
    if (!found) return undefined;
    e = { };
    this.entries.set(lang.id, e);
    const entry = e;
    entry.starting = (async () => {
      const args = [...found.args];
      let init: unknown;
      // sourcekit-lsp keeps its background index in <package>/.build/index-build (fixed by sourcekit-lsp; git-ignored in Swift projects).
      if (lang.id === 'swift') init = { backgroundIndexing: true };
      if (lang.id === 'typescript' && found.cmd === 'typescript-language-server') {
        const tsserver = findTsserver(this.root, found.path);
        init = { preferences: { includeCompletionsForModuleExports: false }, ...(tsserver ? { tsserver: { path: tsserver } } : {}) };
      }
      const client = new LspClient(found.cmd, found.path, args, this.root, (f) => lang.lspIds[path.extname(f).toLowerCase()] ?? lang.id, this.opts.log, init);
      try {
        await client.start();
        entry.client = client;
        this.opts.log(`started ${found.cmd} for ${this.root}`);
        return client;
      } catch (err) {
        const why = (err as Error).message.replace(/^[^:]+: /, '').split(/(?<=\.)\s/)[0].slice(0, 160);
        entry.failed = `${found.cmd} failed to start: ${why}`;
        this.opts.log(`${found.cmd} stderr: ${client.stderrTail.trim().slice(-500)}`);
        entry.failedAt = Date.now();
        await client.shutdown().catch(() => {});
        this.opts.log(entry.failed);
        return undefined;
      } finally {
        entry.starting = undefined;
      }
    })();
    return entry.starting;
  }

  /** Get the server for a file's language. */
  async forFile(file: string): Promise<{ lang?: Language; client?: LspClient }> {
    const lang = languageOf(file);
    if (!lang) return {};
    return { lang, client: await this.get(lang) };
  }

  /** Mark a server broken (e.g. it timed out) so we fall back for a while. */
  async markFailed(langId: string, reason: string): Promise<void> {
    const e = this.entries.get(langId);
    if (!e) return;
    e.failed = reason;
    e.failedAt = Date.now();
    const c = e.client;
    e.client = undefined;
    await c?.shutdown().catch(() => {});
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const [id, e] of this.entries) {
      if (e.client && now - e.client.lastUsed > this.opts.idleMs) {
        const c = e.client;
        e.client = undefined;
        this.entries.delete(id);
        this.opts.log(`stopping idle ${c.name}`);
        await c.shutdown().catch(() => {});
      }
    }
  }

  runningCount(): number {
    return [...this.entries.values()].filter((e) => e.client?.alive).length;
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map(async (e) => {
      const c = e.client ?? (await e.starting?.catch(() => undefined));
      await c?.shutdown().catch(() => {});
    }));
  }

  killNow(): void {
    for (const e of this.entries.values()) e.client?.killNow();
  }
}

export { LANGUAGES };

/** typescript-language-server needs a TypeScript install: the workspace's, else one next to the server itself. */
export function findTsserver(root: string, serverPath: string): string | undefined {
  const lookUp = (start: string): string | undefined => {
    let dir = start;
    for (let i = 0; i < 12; i++) {
      const p = path.join(dir, 'node_modules', 'typescript', 'lib', 'tsserver.js');
      if (fs.existsSync(p)) return p;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return undefined;
  };
  let real = serverPath;
  try { real = fs.realpathSync(serverPath); } catch { /* keep */ }
  return lookUp(root) ?? lookUp(path.dirname(real));
}

/** Major version of the TypeScript package a tsc/tsgo binary belongs to. */
export function typescriptMajor(binPath: string): number | undefined {
  let real = binPath;
  try { real = fs.realpathSync(binPath); } catch { return undefined; }
  let dir = path.dirname(real);
  for (let i = 0; i < 4; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'typescript' || pkg.name === '@typescript/native-preview') return Number(String(pkg.version).split('.')[0]) || (pkg.name === '@typescript/native-preview' ? 7 : undefined);
    } catch { /* go up */ }
    dir = path.dirname(dir);
  }
  return undefined;
}

/**
 * TypeScript/JavaScript: TypeScript 7+ has its own language server (tsc --lsp --stdio, or tsgo); older TypeScript goes through
 * typescript-language-server, which needs a tsserver.js. The workspace's own TypeScript comes first.
 */
export function findTypescriptServer(root: string): FoundServer | undefined {
  const local: string[] = [];
  let dir = root;
  for (let i = 0; i < 12; i++) {
    local.push(path.join(dir, 'node_modules', '.bin'));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const tsgo = which('tsgo', local);
  if (tsgo) return { cmd: 'tsgo', path: tsgo, args: ['--lsp', '--stdio'] };
  const localTsc = which('tsc', local.filter((d) => fs.existsSync(d)).slice(0, 12));
  const onPath = which('tsc');
  const tsls = which('typescript-language-server', local);
  for (const tsc of [localTsc, onPath]) {
    if (!tsc) continue;
    const major = typescriptMajor(tsc) ?? 0;
    if (major >= 7) return { cmd: 'tsc --lsp', path: tsc, args: ['--lsp', '--stdio'] };
    if (tsls && findTsserver(root, tsls)) return { cmd: 'typescript-language-server', path: tsls, args: ['--stdio'] };
  }
  if (tsls) return { cmd: 'typescript-language-server', path: tsls, args: ['--stdio'] };
  return undefined;
}
