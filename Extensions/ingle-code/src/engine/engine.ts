// CodeEngine: the typed, read-only API. Language servers when installed (exact), the text scan otherwise (approximate).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Workspace, GrepHit, wordColumns } from './files';
import { Language, LANGUAGES, languageOf, matchDefinition, isTestFile, testStem, stem } from './languages';
import { LspClient, LspLocation, LspDiagnostic, Json, uriPath } from './lsp';
import { ServerPool } from './pool';
import { scanOutline, enclosingFunction, enclosingSymbols, scanCalls, looksLikeCall, codeMask } from './scan';
import { readExhaustively, resolveOllamaHost, ollamaReachable, pickModel } from './exhaustive';
import {
  EngineOptions, EngineError, Source, StatusResult, LanguageStatus, OutlineResult, OutlineSymbol, DefinitionItem, DefinitionResult,
  ReferenceItem, ReferencesResult, CallItem, CallsResult, ImpactResult, TestItem, DiagnosticItem, DiagnosticsResult, ReadExhaustivelyResult, Exactness,
} from './types';
import { inRoot, paginate, relTo, shorten } from './util';

const SYMBOL_KINDS = ['', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter'];
const LOW_PRIORITY_KINDS = new Set(['variable', 'constant', 'property', 'field', 'case', 'enum member', 'extension', 'key', 'symbol']);
const CALLABLE_LSP_KINDS = new Set([6, 9, 12]);
const MAX_DEFS = 6;
const MAX_LEVEL2 = 20;
const MAX_DIAG_FILES = 60;

type Target =
  | { kind: 'name'; name: string; qualifier?: string; raw: string }
  | { kind: 'position'; file: string; abs: string; line: number; col: number; raw: string };

interface Resolved {
  defs: DefinitionItem[];
  hits: GrepHit[];
  name: string;
  notes: string[];
}

export interface PageOpts { page?: number; pageSize?: number; file?: string }

export class CodeEngine {
  readonly root: string;
  private readonly ws: Workspace;
  private readonly pool: ServerPool;
  private readonly pageSize: number;
  private readonly indexWaitMs: number;
  private readonly log: (m: string) => void;
  private readonly opts: EngineOptions;
  private outlineCache = new Map<string, { mtimeMs: number; outline: OutlineSymbol[] }>();
  private maskCache = new Map<string, { mtimeMs: number; lines: string[] }>();

  constructor(opts: EngineOptions) {
    let root = path.resolve(opts.root);
    try { root = fs.realpathSync(root); } catch { throw new EngineError(`Workspace ${opts.root} doesn't exist.`); }
    if (!fs.statSync(root).isDirectory()) throw new EngineError(`Workspace ${opts.root} isn't a folder.`);
    this.root = root;
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.pageSize = Math.max(1, opts.pageSize ?? 40);
    this.indexWaitMs = opts.indexWaitMs ?? 120_000;
    this.ws = new Workspace(root);
    this.pool = new ServerPool(root, {
      idleMs: opts.idleMs ?? 10 * 60_000,
      disabled: !!opts.noServers,
      only: opts.onlyLanguages,
      log: this.log,
    });
  }

  // MARK: status

  async status(): Promise<StatusResult> {
    const files = await this.ws.list();
    const languages: LanguageStatus[] = [];
    for (const lang of LANGUAGES) {
      const count = files.filter((f) => languageOf(f) === lang).length;
      const found = this.pool.find(lang);
      const enabled = this.pool.enabled(lang);
      const failed = this.pool.failure(lang.id);
      const exact = !!found && enabled && !failed;
      const s: LanguageStatus = { language: lang.id, extensions: lang.extensions, running: this.pool.running(lang.id), files: count, exactness: exact ? 'exact' : 'approximate' };
      if (found) { s.server = found.cmd; s.serverPath = found.path; }
      if (failed) s.note = failed;
      else if (!found) s.note = `no ${lang.servers.map((c) => c.cmd).join(' or ')} on PATH`;
      else if (!enabled) s.note = 'language servers turned off';
      languages.push(s);
    }
    const ollama: StatusResult['ollama'] = { host: '', reachable: false };
    try {
      ollama.host = resolveOllamaHost(this.opts.ollamaHost);
      ollama.reachable = await ollamaReachable(ollama.host);
      if (ollama.reachable) ollama.model = await pickModel(ollama.host, this.opts.model).catch((e: Error) => { ollama.error = e.message; return undefined; });
      else ollama.error = 'not reachable';
    } catch (e) {
      ollama.error = (e as Error).message;
    }
    return { root: this.root, git: await this.ws.isGit(), languages, ollama };
  }

  // MARK: outline

  async outline(file: string, o: PageOpts = {}): Promise<OutlineResult> {
    const [abs, rel] = this.existing(file);
    const lang = languageOf(rel);
    if (!lang) throw new EngineError(`${rel}: not a language ingle-code knows (${LANGUAGES.map((l) => l.extensions.join(' ')).join(' ')}).`);
    let symbols: OutlineSymbol[] | undefined;
    let source: Source = { language: lang.id, exactness: 'approximate', via: 'scan' };
    const client = await this.pool.get(lang);
    if (client) {
      try {
        const uri = client.ensureOpen(abs);
        const res = await client.request<Json>('textDocument/documentSymbol', { textDocument: { uri } }, 30_000);
        if (Array.isArray(res)) {
          symbols = flattenSymbols(res);
          source = { language: lang.id, exactness: 'exact', via: client.name };
        }
      } catch (e) {
        source.reason = (e as Error).message;
      }
    } else {
      source.reason = this.whyNoServer(lang);
    }
    if (!symbols) symbols = this.scanOutlineOf(rel);
    const pg = paginate(symbols, o.page, o.pageSize ?? this.pageSize);
    return { file: rel, source, ...pg };
  }

  // MARK: definition

  async definition(target: string, o: PageOpts = {}): Promise<DefinitionResult> {
    const t = this.parseTarget(target);
    const sources: Source[] = [];
    let defs: DefinitionItem[] = [];
    if (t.kind === 'position') {
      const lang = languageOf(t.file);
      const client = lang ? await this.pool.get(lang) : undefined;
      if (lang && client) {
        try {
          const uri = client.ensureOpen(t.abs);
          await client.waitForIdle(this.indexWaitMs);
          const res = await client.request<Json>('textDocument/definition', { textDocument: { uri }, position: { line: t.line - 1, character: t.col - 1 } }, 30_000);
          const locs: LspLocation[] = (Array.isArray(res) ? res : res ? [res] : []).map((l: Json) => ('targetUri' in l ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : l));
          for (const l of locs) {
            const item = this.locToDef(l, lang, 'exact');
            if (item) defs.push(item);
          }
          sources.push({ language: lang.id, exactness: 'exact', via: client.name });
        } catch (e) {
          sources.push({ language: lang.id, exactness: 'approximate', via: 'scan', reason: (e as Error).message });
        }
      }
      if (!defs.length) {
        const word = this.wordAt(t.file, t.line, t.col);
        if (!word) throw new EngineError(`No symbol at ${t.file}:${t.line}:${t.col}.`);
        const r = await this.resolve({ kind: 'name', name: word, raw: word }, t.file);
        defs = r.defs;
        if (!sources.length) sources.push(...this.scanSources(defs, lang ? [lang] : []));
      }
    } else {
      const r = await this.resolve(t, o.file);
      defs = r.defs;
      const langs = new Set(defs.map((d) => d.language));
      for (const id of langs) {
        const ex = defs.find((d) => d.language === id)!.exactness;
        sources.push(ex === 'exact' ? { language: id, exactness: 'exact', via: this.serverName(id) } : { language: id, exactness: 'approximate', via: 'scan', reason: this.whyNoServer(languageByIdOrThrow(id)) });
      }
    }
    const pg = paginate(defs, o.page, o.pageSize ?? this.pageSize);
    return { target, sources, ...pg };
  }

  // MARK: references

  async references(target: string, o: PageOpts = {}): Promise<ReferencesResult> {
    const all = await this.allReferences(target, o.file);
    const pg = paginate(all.items, o.page, o.pageSize ?? this.pageSize);
    return {
      target, definitions: all.defs, sources: all.sources, files: new Set(all.items.map((i) => i.file)).size,
      exactCount: all.items.filter((i) => i.exactness === 'exact').length,
      approximateCount: all.items.filter((i) => i.exactness === 'approximate').length,
      ...pg,
    };
  }

  private async allReferences(target: string, fileHint?: string): Promise<{ items: ReferenceItem[]; defs: DefinitionItem[]; sources: Source[] }> {
    const t = this.parseTarget(target);
    const sources: Source[] = [];
    const items = new Map<string, ReferenceItem>();
    const add = (it: ReferenceItem) => {
      const k = `${it.file}:${it.line}:${it.col}`;
      const old = items.get(k);
      if (!old || (old.exactness === 'approximate' && it.exactness === 'exact')) items.set(k, it);
    };
    const texts = new Map<string, string[]>();
    const lineText = (rel: string, line: number) => {
      let ls = texts.get(rel);
      if (!ls) { ls = (this.ws.read(rel) ?? '').split('\n'); texts.set(rel, ls); }
      return ls[line - 1] ?? '';
    };

    // A position with a server: ask it directly.
    if (t.kind === 'position') {
      const lang = languageOf(t.file);
      const client = lang ? await this.pool.get(lang) : undefined;
      const word = this.wordAt(t.file, t.line, t.col);
      if (lang && client && word) {
        try {
          const locs = await this.lspReferences(client, t.abs, t.line - 1, t.col - 1);
          for (const l of locs) add(this.refItem(l, lang, lineText, 'exact'));
          sources.push({ language: lang.id, exactness: 'exact', via: client.name });
          // Text matches in this language the server didn't report.
          const hits = await this.ws.grepWords([word]);
          for (const h of hits) if (languageOf(h.file) === lang) for (const c of wordColumns(h.text, word)) {
            const k = `${h.file}:${h.line}:${c + 1}`;
            if (!items.has(k)) add({ file: h.file, line: h.line, col: c + 1, text: shorten(h.text), language: lang.id, exactness: 'approximate', unconfirmed: true, inComment: this.inCommentOrString(h.file, h.line, c) || undefined });
          }
          const defs = (await this.definition(target)).items;
          return { items: sortRefs([...items.values()]), defs, sources };
        } catch (e) {
          sources.push({ language: lang.id, exactness: 'approximate', via: 'scan', reason: (e as Error).message });
        }
      }
      if (!word) throw new EngineError(`No symbol at ${t.file}:${t.line}:${t.col}.`);
      return this.allReferences(word, t.file);
    }

    const r = await this.resolve(t, fileHint);
    const byLang = new Map<string, GrepHit[]>();
    for (const h of r.hits) {
      const l = languageOf(h.file);
      if (!l) continue;
      const list = byLang.get(l.id) ?? [];
      list.push(h);
      byLang.set(l.id, list);
    }
    for (const d of r.defs) if (!byLang.has(d.language)) byLang.set(d.language, []);

    for (const [langId, hits] of byLang) {
      const lang = languageByIdOrThrow(langId);
      const defs = r.defs.filter((d) => d.language === langId);
      let exactDone = false;
      if (defs.length) {
        const client = await this.pool.get(lang);
        if (client) {
          try {
            for (const d of defs.slice(0, MAX_DEFS)) {
              const locs = await this.lspReferences(client, path.join(this.root, d.file), d.line - 1, d.col - 1);
              for (const l of locs) add(this.refItem(l, lang, lineText, 'exact'));
              add({ file: d.file, line: d.line, col: d.col, text: d.text, language: langId, exactness: d.exactness, definition: true });
            }
            sources.push({ language: langId, exactness: 'exact', via: client.name });
            exactDone = true;
          } catch (e) {
            sources.push({ language: langId, exactness: 'approximate', via: 'scan', reason: (e as Error).message });
          }
        } else {
          sources.push({ language: langId, exactness: 'approximate', via: 'scan', reason: this.whyNoServer(lang) });
        }
      } else {
        sources.push({ language: langId, exactness: 'approximate', via: 'scan', reason: `no definition of ${r.name} found in ${lang.name} files; text matches only` });
      }
      for (const h of hits) {
        for (const c of wordColumns(h.text, r.name)) {
          const k = `${h.file}:${h.line}:${c + 1}`;
          if (items.has(k)) continue;
          const isDef = !!matchDefinition(lang, h.text, r.name);
          const inComment = this.inCommentOrString(h.file, h.line, c) || undefined;
          add({ file: h.file, line: h.line, col: c + 1, text: shorten(h.text), language: langId, exactness: 'approximate', definition: isDef || undefined, unconfirmed: exactDone || undefined, inComment });
        }
      }
    }
    // Mark declarations among exact results.
    const defKeys = new Set(r.defs.map((d) => `${d.file}:${d.line}`));
    for (const it of items.values()) if (defKeys.has(`${it.file}:${it.line}`)) it.definition = true;
    return { items: sortRefs([...items.values()]), defs: r.defs, sources };
  }

  private async lspReferences(client: LspClient, abs: string, line0: number, col0: number): Promise<LspLocation[]> {
    const uri = client.ensureOpen(abs);
    await client.waitForIdle(this.indexWaitMs);
    const res = await client.request<LspLocation[] | null>('textDocument/references', { textDocument: { uri }, position: { line: line0, character: col0 }, context: { includeDeclaration: true } }, 90_000);
    return res ?? [];
  }

  private refItem(l: LspLocation, lang: Language, lineText: (rel: string, line: number) => string, exactness: Exactness): ReferenceItem {
    const abs = uriPath(l.uri);
    const rel = relTo(this.root, abs);
    const line = l.range.start.line + 1;
    const fileLang = languageOf(rel) ?? lang;
    return { file: rel, line, col: l.range.start.character + 1, text: shorten(lineText(rel, line)), language: fileLang.id, exactness };
  }

  // MARK: callers / callees

  async callers(target: string, o: PageOpts & { depth?: number } = {}): Promise<CallsResult> {
    return this.calls(target, 'callers', o);
  }

  async callees(target: string, o: PageOpts & { depth?: number } = {}): Promise<CallsResult> {
    return this.calls(target, 'callees', o);
  }

  private async calls(target: string, direction: 'callers' | 'callees', o: PageOpts & { depth?: number }): Promise<CallsResult> {
    const all = await this.allCalls(target, direction, o.depth ?? 1, o.file);
    const pg = paginate(all.items, o.page, o.pageSize ?? this.pageSize);
    return { target, direction, depth: all.depth, definitions: all.defs, sources: all.sources, ...pg };
  }

  private async allCalls(target: string, direction: 'callers' | 'callees', depthIn: number, fileHint?: string): Promise<{ items: CallItem[]; defs: DefinitionItem[]; sources: Source[]; depth: number }> {
    const depth = Math.min(2, Math.max(1, Math.floor(depthIn)));
    const t = this.parseTarget(target);
    let defs: DefinitionItem[];
    if (t.kind === 'position') defs = (await this.definition(target)).items;
    else defs = (await this.resolve(t, fileHint)).defs;
    if (!defs.length) throw new EngineError(`Couldn't find a definition of ${target}. Try definition or references first.`);
    const items: CallItem[] = [];
    const sources: Source[] = [];
    const byLang = new Map<string, DefinitionItem[]>();
    for (const d of defs) byLang.set(d.language, [...(byLang.get(d.language) ?? []), d]);
    for (const [langId, ds] of byLang) {
      const lang = languageByIdOrThrow(langId);
      const client = await this.pool.get(lang);
      let done = false;
      if (client && client.capabilities?.callHierarchyProvider) {
        try {
          for (const d of ds.slice(0, MAX_DEFS)) items.push(...(await this.lspCalls(client, lang, d, direction, depth)));
          sources.push({ language: langId, exactness: 'exact', via: client.name });
          done = true;
        } catch (e) {
          sources.push({ language: langId, exactness: 'approximate', via: 'scan', reason: (e as Error).message });
        }
      } else {
        sources.push({ language: langId, exactness: 'approximate', via: 'scan', reason: client ? `${client.name} has no call hierarchy` : this.whyNoServer(lang) });
      }
      if (!done) {
        for (const d of ds.slice(0, MAX_DEFS)) {
          items.push(...(direction === 'callers' ? await this.scanCallers(lang, d.name, depth) : await this.scanCallees(lang, d, depth)));
        }
      }
    }
    // Dedupe by level+file+line+via.
    const seen = new Set<string>();
    const out = items.filter((i) => { const k = `${i.level}:${i.file}:${i.line}:${i.via ?? ''}`; if (seen.has(k)) return false; seen.add(k); return true; });
    out.sort((a, b) => a.level - b.level || a.file.localeCompare(b.file) || a.line - b.line);
    return { items: out, defs, sources, depth };
  }

  private async lspCalls(client: LspClient, lang: Language, d: DefinitionItem, direction: 'callers' | 'callees', depth: number): Promise<CallItem[]> {
    const uri = client.ensureOpen(path.join(this.root, d.file));
    await client.waitForIdle(this.indexWaitMs);
    const prepared = await client.request<Json[] | null>('textDocument/prepareCallHierarchy', { textDocument: { uri }, position: { line: d.line - 1, character: d.col - 1 } }, 30_000);
    if (!prepared?.length) throw new EngineError(`${client.name} found no callable at ${d.file}:${d.line}`);
    const out: CallItem[] = [];
    const method = direction === 'callers' ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls';
    const level1: Json[] = [];
    let external = 0;
    for (const item of prepared) {
      const calls = (await client.request<Json[] | null>(method, { item }, 60_000)) ?? [];
      for (const c of calls) {
        const other = direction === 'callers' ? c.from : c.to;
        const ci = this.callItem(other, c.fromRanges ?? [], 1, undefined, lang);
        if (!ci) { external++; continue; }
        out.push(ci);
        level1.push(other);
      }
    }
    if (external) this.log(`${external} ${direction} outside the workspace left out`);
    if (depth >= 2) {
      for (const other of level1.slice(0, MAX_LEVEL2)) {
        const calls = (await client.request<Json[] | null>(method, { item: other }, 60_000).catch(() => null)) ?? [];
        for (const c of calls) {
          const o2 = direction === 'callers' ? c.from : c.to;
          const ci = this.callItem(o2, c.fromRanges ?? [], 2, other.name, lang);
          if (ci) out.push(ci);
        }
      }
    }
    return out;
  }

  private callItem(item: Json, fromRanges: Json[], level: number, via: string | undefined, lang: Language): CallItem | undefined {
    const abs = uriPath(item.uri);
    const rel = relTo(this.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    const lines = [...new Set(fromRanges.map((r: Json) => r.start.line + 1))].sort((a, b) => a - b);
    const fileLevel = item.kind === 1 || item.kind === 2 || String(item.name).includes('/');
    return {
      name: fileLevel ? '(top level)' : String(item.name), kind: fileLevel ? 'file' : (SYMBOL_KINDS[item.kind] ?? 'symbol'), file: rel, line: (item.selectionRange ?? item.range).start.line + 1,
      level, via, callLines: lines, exactness: 'exact', language: languageOf(rel)?.id ?? lang.id,
    };
  }

  private async scanCallers(lang: Language, name: string, depth: number): Promise<CallItem[]> {
    const level = async (names: string[], lvl: number, viaOf: (n: string) => string | undefined): Promise<CallItem[]> => {
      const hits = (await this.ws.grepWords(names)).filter((h) => languageOf(h.file) === lang);
      const groups = new Map<string, CallItem>();
      for (const h of hits) {
        for (const n of names) {
          const cols = wordColumns(h.text, n).filter((c) => looksLikeCall(h.text, n, c) && !this.inCommentOrString(h.file, h.line, c));
          if (!cols.length || matchDefinition(lang, h.text, n)) continue;
          const outline = this.scanOutlineOf(h.file);
          const fn = enclosingFunction(outline, h.line);
          const key = `${h.file}:${fn?.startLine ?? 0}:${n}`;
          const g = groups.get(key) ?? {
            name: fn ? qualified(fn) : '(top level)', kind: fn?.kind ?? 'file', file: h.file, line: fn?.startLine ?? h.line,
            level: lvl, via: viaOf(n), callLines: [], exactness: 'approximate' as Exactness, language: lang.id,
          };
          if (!g.callLines.includes(h.line)) g.callLines.push(h.line);
          groups.set(key, g);
        }
      }
      return [...groups.values()];
    };
    const l1 = await level([name], 1, () => undefined);
    if (depth < 2) return l1;
    const names = [...new Set(l1.filter((c) => c.kind !== 'file').map((c) => c.name.split('.').pop()!))].slice(0, MAX_LEVEL2);
    const l2 = names.length ? await level(names, 2, (n) => n) : [];
    return [...l1, ...l2];
  }

  private async scanCallees(lang: Language, d: DefinitionItem, depth: number): Promise<CallItem[]> {
    const one = async (file: string, line: number, lvl: number, via?: string): Promise<CallItem[]> => {
      const text = this.ws.read(file);
      if (text === undefined) return [];
      const outline = this.scanOutlineOf(file);
      const sym = outline.find((s) => s.startLine === line) ?? enclosingFunction(outline, line);
      if (!sym) return [];
      const calls = scanCalls(text, lang, sym.startLine, sym.endLine);
      if (!calls.size) return [];
      const names = [...calls.keys()].slice(0, 80);
      const hits = await this.ws.grepWords(names);
      const defsByName = new Map<string, GrepHit & { kind: string }>();
      for (const h of hits) {
        const l = languageOf(h.file);
        if (l !== lang) continue;
        for (const n of names) {
          if (defsByName.has(n)) continue;
          const m = matchDefinition(lang, h.text, n);
          if (m && !LOW_PRIORITY_KINDS.has(m.kind)) defsByName.set(n, { ...h, kind: m.kind });
        }
      }
      const out: CallItem[] = [];
      for (const [n, lines] of calls) {
        const def = defsByName.get(n);
        if (!def) continue; // library or unknown: left out
        out.push({ name: n, kind: def.kind, file: def.file, line: def.line, level: lvl, via, callLines: lines, exactness: 'approximate', language: lang.id });
      }
      return out;
    };
    const l1 = await one(d.file, d.line, 1);
    if (depth < 2) return l1;
    const l2: CallItem[] = [];
    for (const c of l1.slice(0, MAX_LEVEL2)) l2.push(...(await one(c.file, c.line, 2, c.name)));
    return [...l1, ...l2];
  }

  // MARK: impact

  async impact(target: string, o: PageOpts = {}): Promise<ImpactResult> {
    const refs = await this.allReferences(target, o.file);
    let callers: CallItem[] = [];
    const sources = [...refs.sources];
    try {
      const c = await this.allCalls(target, 'callers', 1, o.file);
      callers = c.items;
      for (const s of c.sources) if (!sources.some((x) => x.language === s.language && x.via === s.via)) sources.push(s);
    } catch (e) {
      this.log(`impact: callers failed: ${(e as Error).message}`);
    }
    const perFile = new Map<string, { count: number; exactCount: number }>();
    const mentioned = new Set<string>();
    for (const r of refs.items) {
      if (r.inComment && r.exactness === 'approximate') { mentioned.add(r.file); continue; }
      const f = perFile.get(r.file) ?? { count: 0, exactCount: 0 };
      f.count++;
      if (r.exactness === 'exact') f.exactCount++;
      perFile.set(r.file, f);
    }
    const affected = new Set<string>([...perFile.keys(), ...callers.map((c) => c.file)]);
    const tests = await this.findTests([...affected], new Set(perFile.keys()), [...new Set(refs.defs.map((d) => d.file))]);
    const covered = new Set(tests.flatMap((t) => t.covers));
    const untested = [...affected].filter((f) => !isTestFile(f) && !covered.has(f)).sort();
    const fileList = [...perFile.entries()].map(([file, v]) => ({ file, ...v })).sort((a, b) => a.file.localeCompare(b.file));
    const ps = o.pageSize ?? this.pageSize;
    const pFiles = paginate(fileList, o.page, ps);
    const pCallers = paginate(callers, o.page, ps);
    const pTests = paginate(tests, o.page, ps);
    const pages = Math.max(pFiles.pages, pCallers.pages, pTests.pages);
    const page = Math.min(Math.max(1, Math.floor(o.page ?? 1)), pages);
    return {
      target, definitions: refs.defs, sources,
      references: {
        total: refs.items.length,
        exactCount: refs.items.filter((i) => i.exactness === 'exact').length,
        approximateCount: refs.items.filter((i) => i.exactness === 'approximate').length,
        files: page <= pFiles.pages && pFiles.page === page ? pFiles.items : [],
        mentionedOnly: [...mentioned].filter((f) => !perFile.has(f)).sort(),
      },
      callers: pCallers.page === page ? pCallers.items : [],
      callersTotal: callers.length,
      tests: pTests.page === page ? pTests.items : [],
      untested,
      page, pageSize: ps, pages,
    };
  }

  /** Tests that cover the affected files: by file name, by import, or because they use the symbol. */
  private async findTests(affected: string[], usesSymbol: Set<string>, defFiles: string[]): Promise<TestItem[]> {
    const all = await this.ws.list();
    const tests = all.filter((f) => isTestFile(f) && languageOf(f));
    const result = new Map<string, TestItem>();
    const add = (test: string, reason: TestItem['reasons'][number], covers: string) => {
      const t = result.get(test) ?? { file: test, reasons: [], covers: [] };
      if (!t.reasons.includes(reason)) t.reasons.push(reason);
      if (covers && !t.covers.includes(covers)) t.covers.push(covers);
      result.set(test, t);
    };
    const sourcesAffected = affected.filter((f) => !isTestFile(f));
    for (const f of affected) if (isTestFile(f) && usesSymbol.has(f)) add(f, 'uses', '');
    const importCache = new Map<string, TestImports>();
    const importsOf = (test: string) => {
      let l = importCache.get(test);
      if (!l) { l = parseImports(test, this.ws.read(test) ?? ''); importCache.set(test, l); }
      return l;
    };
    for (const src of sourcesAffected) {
      const s = stem(src).toLowerCase();
      const srcLang = languageOf(src);
      for (const test of tests.slice(0, 5000)) {
        if (languageOf(test) !== srcLang) continue;
        if (testStem(test).toLowerCase() === s) add(test, 'name', src);
        if (importsCovers(importsOf(test), src)) add(test, 'import', src);
      }
    }
    // A test that uses the symbol itself covers the files that define it.
    for (const t of result.values()) if (t.reasons.includes('uses')) for (const f of defFiles) if (!t.covers.includes(f)) t.covers.push(f);
    return [...result.values()].sort((a, b) => a.file.localeCompare(b.file));
  }

  // MARK: diagnostics

  async diagnostics(paths?: string[], o: PageOpts = {}): Promise<DiagnosticsResult> {
    let scope: string | undefined;
    let files: string[] = [];
    if (!paths || !paths.length) {
      files = (await this.ws.changed()).filter((f) => languageOf(f));
      scope = 'files changed since the last commit';
      if (!files.length) {
        if (!(await this.ws.isGit())) throw new EngineError('Not a git repository, so there\'s no list of changed files. Pass paths.');
        scope = 'files changed since the last commit (none)';
      }
    } else {
      for (const p of paths) {
        const [abs, rel] = this.existing(p);
        if (fs.statSync(abs).isDirectory()) {
          const prefix = rel ? `${rel}/` : '';
          files.push(...(await this.ws.list()).filter((f) => (!prefix || f.startsWith(prefix)) && languageOf(f)));
        } else files.push(rel);
      }
    }
    files = [...new Set(files)];
    const skipped: DiagnosticsResult['skipped'] = [];
    if (files.length > MAX_DIAG_FILES) {
      for (const f of files.slice(MAX_DIAG_FILES)) skipped.push({ file: f, reason: `over the ${MAX_DIAG_FILES}-file limit; ask for it by name` });
      files = files.slice(0, MAX_DIAG_FILES);
    }
    const items: DiagnosticItem[] = [];
    const checked: string[] = [];
    const sources: Source[] = [];
    for (const rel of files) {
      const lang = languageOf(rel);
      if (!lang) { skipped.push({ file: rel, reason: 'not a known language' }); continue; }
      const client = await this.pool.get(lang);
      if (!client) {
        skipped.push({ file: rel, reason: this.whyNoServer(lang) });
        if (!sources.some((s) => s.language === lang.id)) sources.push({ language: lang.id, exactness: 'approximate', via: 'none', reason: this.whyNoServer(lang) });
        continue;
      }
      try {
        const diags = await this.fileDiagnostics(client, path.join(this.root, rel));
        if (diags === undefined) { skipped.push({ file: rel, reason: `${client.name} didn't report in time` }); continue; }
        checked.push(rel);
        for (const d of diags) items.push(toDiag(rel, d));
        if (!sources.some((s) => s.language === lang.id)) sources.push({ language: lang.id, exactness: 'exact', via: client.name });
      } catch (e) {
        skipped.push({ file: rel, reason: (e as Error).message });
      }
    }
    const order = { error: 0, warning: 1, info: 2, hint: 3 };
    items.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
    const pg = paginate(items, o.page, o.pageSize ?? this.pageSize);
    return {
      checked, skipped, sources, scope,
      errors: items.filter((i) => i.severity === 'error').length,
      warnings: items.filter((i) => i.severity === 'warning').length,
      ...pg,
    };
  }

  private async fileDiagnostics(client: LspClient, abs: string): Promise<LspDiagnostic[] | undefined> {
    const uri = client.ensureOpen(abs);
    await client.waitForIdle(this.indexWaitMs);
    if (client.capabilities?.diagnosticProvider) {
      // Pull: ask, and ask again briefly if the server isn't ready yet.
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await client.request<Json>('textDocument/diagnostic', { textDocument: { uri } }, 60_000).catch((e: Error) => {
          if (/ServerCancelled|not ready|cancel/i.test(e.message)) return null;
          throw e;
        });
        if (res && Array.isArray(res.items)) return res.items as LspDiagnostic[];
        await client.waitForIdle(5000);
      }
    }
    return client.waitForPushedDiagnostics(uri, 30_000);
  }

  // MARK: read_exhaustively

  async readExhaustively(file: string, question: string, o: { page?: number; chunksPerPage?: number; chunkChars?: number } = {}): Promise<ReadExhaustivelyResult> {
    const [abs, rel] = this.existing(file);
    if (fs.statSync(abs).isDirectory()) throw new EngineError(`${rel} is a folder; give a file.`);
    const host = resolveOllamaHost(this.opts.ollamaHost);
    return readExhaustively(abs, rel, question, { host, model: this.opts.model, page: o.page, chunksPerPage: o.chunksPerPage, chunkChars: o.chunkChars });
  }

  // MARK: lifecycle

  /** Number of language servers running now. */
  runningServers(): number {
    return this.pool.runningCount();
  }

  async dispose(): Promise<void> {
    await this.pool.dispose();
  }

  /** Synchronous best effort for process 'exit' handlers. */
  killNow(): void {
    this.pool.killNow();
  }

  // MARK: helpers

  private existing(p: string): [string, string] {
    const [abs, rel] = inRoot(this.root, p);
    if (!fs.existsSync(abs)) throw new EngineError(`${p} doesn't exist in ${this.root}.`);
    return [abs, rel];
  }

  private parseTarget(raw: string): Target {
    const s = String(raw ?? '').trim();
    if (!s) throw new EngineError('Give a symbol name or file:line:col.');
    const m = /^(.+?):(\d+)(?::(\d+))?$/.exec(s);
    if (m) {
      const [abs, rel] = this.existing(m[1]);
      const line = Number(m[2]);
      let col = m[3] ? Number(m[3]) : 0;
      if (!col) {
        const text = (this.ws.read(rel) ?? '').split('\n')[line - 1] ?? '';
        const lang = languageOf(rel);
        const d = lang ? matchDefinition(lang, text) : undefined;
        col = d ? d.col + 1 : (text.search(/[A-Za-z_$]/) + 1 || 1);
      }
      return { kind: 'position', file: rel, abs, line, col, raw: s };
    }
    const cleaned = s.replace(/\(.*\)$/, '').replace(/::/g, '.');
    const parts = cleaned.split('.').filter(Boolean);
    const name = parts.pop() ?? cleaned;
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new EngineError(`"${s}" isn't a symbol name or file:line:col.`);
    return { kind: 'name', name, qualifier: parts.length ? parts[parts.length - 1] : undefined, raw: s };
  }

  private wordAt(rel: string, line: number, col: number): string | undefined {
    const text = (this.ws.read(rel) ?? '').split('\n')[line - 1] ?? '';
    const i = col - 1;
    let a = i, b = i;
    while (a > 0 && /[\w$]/.test(text[a - 1])) a--;
    while (b < text.length && /[\w$]/.test(text[b])) b++;
    const w = text.slice(a, b);
    return /^[A-Za-z_$][\w$]*$/.test(w) ? w : undefined;
  }

  /** Find definitions of a name: language servers' workspace symbols where available, the scan otherwise. */
  private async resolve(t: Extract<Target, { kind: 'name' }>, fileHint?: string): Promise<Resolved> {
    const name = t.name;
    const hits = await this.ws.grepWords([name]);
    const notes: string[] = [];
    let defs: DefinitionItem[] = [];
    const langsWithHits = new Set<string>();
    for (const h of hits) {
      const lang = languageOf(h.file);
      if (!lang) continue;
      langsWithHits.add(lang.id);
      const m = matchDefinition(lang, h.text, name);
      if (m) defs.push({ name, kind: m.kind, file: h.file, line: h.line, col: m.col + 1, text: shorten(h.text), language: lang.id, exactness: 'approximate', container: this.containerOf(h.file, h.line) });
    }
    // Ask servers for exact definitions where we have one.
    for (const id of langsWithHits) {
      const lang = languageByIdOrThrow(id);
      const client = await this.pool.get(lang);
      if (!client) continue;
      try {
        const scanDefs = defs.filter((d) => d.language === id);
        const exact = await this.lspWorkspaceSymbols(client, lang, name, scanDefs);
        // Scan positions stay usable starting points for exact reference queries when the server has no symbol search.
        if (exact.length) defs = [...defs.filter((d) => d.language !== id), ...exact];
      } catch (e) {
        notes.push((e as Error).message);
      }
    }
    // Qualifier ("MacTools.approvalScope") and file hint narrow the list, if they leave anything.
    if (t.qualifier) {
      const q = t.qualifier;
      const narrowed = defs.filter((d) => (d.container ?? '').split('.').includes(q));
      if (narrowed.length) defs = narrowed;
      else notes.push(`no definition of ${name} inside ${q}; showing all`);
    }
    if (fileHint) {
      const [, rel] = inRoot(this.root, fileHint);
      const narrowed = defs.filter((d) => d.file === rel);
      if (narrowed.length) defs = narrowed;
    }
    // Real declarations beat variables/properties/extensions with the same name.
    if (defs.some((d) => !LOW_PRIORITY_KINDS.has(d.kind))) defs = defs.filter((d) => !LOW_PRIORITY_KINDS.has(d.kind));
    const seen = new Set<string>();
    defs = defs.filter((d) => { const k = `${d.file}:${d.line}`; if (seen.has(k)) return false; seen.add(k); return true; });
    defs.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    return { defs, hits, name, notes };
  }

  private async lspWorkspaceSymbols(client: LspClient, lang: Language, name: string, scanDefs: DefinitionItem[]): Promise<DefinitionItem[]> {
    if (!client.capabilities?.workspaceSymbolProvider) return [];
    // Some servers (tsserver) need a file of the project open before workspace symbols work.
    const seed = scanDefs[0]?.file;
    if (seed) client.ensureOpen(path.join(this.root, seed));
    await client.waitForIdle(this.indexWaitMs);
    const res = await client.request<Json[] | null>('workspace/symbol', { query: name }, 30_000);
    const out: DefinitionItem[] = [];
    for (const s of res ?? []) {
      const base = String(s.name ?? '').replace(/\(.*$/, '').replace(/<.*$/, '').trim();
      if (base !== name) continue;
      const loc = s.location;
      if (!loc?.uri || !loc.range) continue; // WorkspaceSymbol without a range: skip
      const item = this.locToDef(loc, lang, 'exact', s.kind, s.containerName, name);
      if (item) out.push({ ...item, name });
    }
    return out;
  }

  private locToDef(l: LspLocation, lang: Language, exactness: Exactness, kind?: number, container?: string, name?: string): DefinitionItem | undefined {
    const abs = uriPath(l.uri);
    const rel = relTo(this.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    const line = l.range.start.line + 1;
    const text = (this.ws.read(rel) ?? '').split('\n')[line - 1] ?? '';
    const fileLang = languageOf(rel) ?? lang;
    const m = matchDefinition(fileLang, text);
    // Some servers give the whole declaration's range (starting at "export"): point at the name instead.
    let col0 = l.range.start.character;
    if (name) {
      const cols = wordColumns(text, name).filter((c) => c >= col0);
      if (cols.length) col0 = cols[0];
    }
    const word = this.wordAt(rel, line, col0 + 1) ?? m?.name ?? '';
    return {
      name: word, kind: kind ? (SYMBOL_KINDS[kind] ?? 'symbol') : (m?.kind ?? 'symbol'), file: rel, line, col: col0 + 1,
      text: shorten(text), language: fileLang.id, exactness, container: container || this.containerOf(rel, line),
    };
  }

  private containerOf(rel: string, line: number): string | undefined {
    const chain = enclosingSymbols(this.scanOutlineOf(rel), line).filter((s) => s.startLine !== line && !['function', 'method', 'constructor'].includes(s.kind));
    return chain.length ? chain.map((s) => s.name).join('.') : undefined;
  }

  /** Is this 0-based column of a 1-based line inside a comment or string? */
  private inCommentOrString(rel: string, line: number, col0: number): boolean {
    const lang = languageOf(rel);
    if (!lang) return false;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(path.join(this.root, rel)).mtimeMs; } catch { return false; }
    let c = this.maskCache.get(rel);
    if (!c || c.mtimeMs !== mtimeMs) {
      c = { mtimeMs, lines: codeMask(this.ws.read(rel) ?? '', lang).split('\n') };
      if (this.maskCache.size > 500) this.maskCache.clear();
      this.maskCache.set(rel, c);
    }
    const ln = c.lines[line - 1];
    return ln !== undefined && ln[col0] === ' ';
  }

  private scanOutlineOf(rel: string): OutlineSymbol[] {
    const lang = languageOf(rel);
    if (!lang) return [];
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(path.join(this.root, rel)).mtimeMs; } catch { return []; }
    const c = this.outlineCache.get(rel);
    if (c && c.mtimeMs === mtimeMs) return c.outline;
    const outline = scanOutline(this.ws.read(rel) ?? '', lang);
    if (this.outlineCache.size > 2000) this.outlineCache.clear();
    this.outlineCache.set(rel, { mtimeMs, outline });
    return outline;
  }

  private whyNoServer(lang: Language): string {
    const failed = this.pool.failure(lang.id);
    if (failed) return failed;
    if (!this.pool.enabled(lang)) return 'language servers turned off';
    return `no ${lang.name} language server installed (${lang.servers.map((s) => s.cmd).join(' or ')})`;
  }

  private serverName(langId: string): string {
    const lang = languageByIdOrThrow(langId);
    return this.pool.find(lang)?.cmd ?? 'scan';
  }

  private scanSources(defs: DefinitionItem[], langs: Language[]): Source[] {
    const ids = new Set([...defs.map((d) => d.language), ...langs.map((l) => l.id)]);
    return [...ids].map((id) => ({ language: id, exactness: 'approximate' as Exactness, via: 'scan', reason: this.whyNoServer(languageByIdOrThrow(id)) }));
  }
}

function languageByIdOrThrow(id: string): Language {
  const l = LANGUAGES.find((x) => x.id === id);
  if (!l) throw new EngineError(`unknown language ${id}`);
  return l;
}

function qualified(s: OutlineSymbol): string {
  return s.container ? `${s.container}.${s.name}` : s.name;
}

function sortRefs(items: ReferenceItem[]): ReferenceItem[] {
  return items.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);
}

function flattenSymbols(res: Json[]): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  if (res.length && 'location' in res[0]) {
    // SymbolInformation[]
    for (const s of res) out.push({ name: s.name, kind: SYMBOL_KINDS[s.kind] ?? 'symbol', startLine: s.location.range.start.line + 1, endLine: s.location.range.end.line + 1, depth: s.containerName ? 1 : 0, container: s.containerName || undefined });
    return out.sort((a, b) => a.startLine - b.startLine);
  }
  const walk = (list: Json[], depth: number, container?: string) => {
    for (const s of list) {
      const kind = SYMBOL_KINDS[s.kind] ?? 'symbol';
      // Locals inside functions are noise in an outline.
      const inFunction = depth > 0 && container !== undefined && out.some((o) => o.name === container && ['function', 'method', 'constructor'].includes(o.kind));
      if (!(inFunction && ['variable', 'constant'].includes(kind))) {
        const sym: OutlineSymbol = { name: s.name, kind, startLine: s.range.start.line + 1, endLine: s.range.end.line + 1, depth };
        if (container) sym.container = container;
        out.push(sym);
      }
      if (Array.isArray(s.children) && !CALLABLE_LSP_KINDS.has(s.kind)) walk(s.children, depth + 1, s.name);
    }
  };
  walk(res, 0);
  return out;
}

function toDiag(rel: string, d: LspDiagnostic): DiagnosticItem {
  const sev = (['', 'error', 'warning', 'info', 'hint'][d.severity ?? 1] ?? 'error') as DiagnosticItem['severity'];
  const item: DiagnosticItem = { file: rel, line: d.range.start.line + 1, col: d.range.start.character + 1, severity: sev, message: d.message.split('\n')[0] };
  if (d.source) item.source = d.source;
  if (d.code !== undefined) item.code = String(d.code);
  return item;
}

interface TestImports {
  /** Workspace-relative paths (no extension) of relative imports. */
  paths: string[];
  /** Module or package names (Swift modules, Python dotted modules as paths, Go import paths). */
  modules: string[];
}

const JS_SPEC = /(?:from\s*|require\s*\(\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

/** What a test file imports, by path where that can be worked out. */
export function parseImports(test: string, text: string): TestImports {
  const dir = path.posix.dirname(test);
  const paths: string[] = [];
  const modules: string[] = [];
  const lines = text.split('\n').slice(0, 400);
  const ext = path.extname(test);
  for (const line of lines) {
    if (/\.([cm]?[jt]sx?)$/.test(ext)) {
      JS_SPEC.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = JS_SPEC.exec(line))) {
        const spec = m[1];
        if (spec.startsWith('.')) paths.push(path.posix.normalize(path.posix.join(dir, spec)).replace(/\.([cm]?[jt]sx?)$/, ''));
        else modules.push(spec);
      }
    } else if (ext === '.swift') {
      const m = /^\s*(?:@testable\s+)?import\s+(?:class\s+|struct\s+|func\s+|enum\s+)?([A-Za-z_][\w]*)/.exec(line);
      if (m) modules.push(m[1]);
    } else if (ext === '.py') {
      const m = /^\s*from\s+(\.*)([\w.]*)\s+import\s+([\w, ]+)|^\s*import\s+([\w.]+)/.exec(line);
      if (m) {
        if (m[4]) modules.push(m[4].replace(/\./g, '/'));
        else {
          const base = m[1] ? path.posix.join(dir, ...Array(Math.max(0, m[1].length - 1)).fill('..')) : '';
          const mod = (m[2] ?? '').replace(/\./g, '/');
          for (const name of m[3].split(',').map((x) => x.trim()).filter(Boolean)) {
            const full = path.posix.join(base, mod, name);
            if (m[1]) paths.push(path.posix.normalize(full)); else modules.push(full);
          }
          if (m[1]) paths.push(path.posix.normalize(path.posix.join(base, mod))); else if (mod) modules.push(mod);
        }
      }
    } else if (ext === '.go') {
      const m = /^\s*(?:import\s+)?(?:\w+\s+)?"([^"]+)"/.exec(line);
      if (m) modules.push(m[1]);
    } else if (ext === '.rs') {
      const m = /^\s*use\s+(?:crate|super|self)?(?:::)?([\w:]+)/.exec(line);
      if (m) modules.push(m[1].replace(/::/g, '/'));
    }
  }
  return { paths, modules };
}

/** Does a test with these imports load this source file? */
export function importsCovers(imp: TestImports, src: string): boolean {
  const noExt = src.replace(/\.[^./]+$/, '');
  const dir = path.posix.dirname(src);
  if (imp.paths.some((p) => p === noExt || p === dir && path.posix.basename(noExt) === 'index' || p === `${dir}/${path.posix.basename(noExt)}`)) return true;
  if (imp.paths.some((p) => `${p}/index` === noExt || `${p}/__init__` === noExt)) return true;
  if (src.endsWith('.swift')) {
    const parts = src.split('/');
    const i = parts.lastIndexOf('Sources');
    const module = i >= 0 ? parts[i + 1] : undefined;
    return !!module && imp.modules.includes(module);
  }
  if (src.endsWith('.py')) return imp.modules.some((m) => noExt.endsWith(m) || `${noExt}`.endsWith(`${m}/__init__`));
  if (src.endsWith('.go')) return imp.modules.some((m) => m.endsWith(`/${dir}`) || m === dir || m.endsWith(`/${path.posix.basename(dir)}`));
  if (src.endsWith('.rs')) return imp.modules.some((m) => noExt.endsWith(m) || noExt.endsWith(m.split('/').slice(0, -1).join('/')));
  return false;
}
