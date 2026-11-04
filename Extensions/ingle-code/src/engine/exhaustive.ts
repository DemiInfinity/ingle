// read_exhaustively: walk a big file in chunks and get a short note per chunk from the LOCAL Ollama engine.
import * as fs from 'node:fs';
import { ChunkNote, EngineError, ReadExhaustivelyResult } from './types';

export const DEFAULT_OLLAMA = 'http://localhost:11434';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** Normalise OLLAMA_HOST-style values and refuse anything that isn't this Mac. */
export function resolveOllamaHost(value?: string): string {
  let v = (value ?? process.env.OLLAMA_HOST ?? '').trim();
  if (!v) return DEFAULT_OLLAMA;
  if (v.startsWith(':')) v = `localhost${v}`;
  if (!/^[a-z]+:\/\//i.test(v)) v = `http://${v}`;
  let u: URL;
  try { u = new URL(v); } catch { throw new EngineError(`OLLAMA_HOST "${value}" isn't a valid address.`); }
  const host = u.hostname.toLowerCase();
  const local = LOCAL_HOSTS.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);
  if (!local) throw new EngineError(`read_exhaustively only uses a local engine, but OLLAMA_HOST points at ${u.hostname}. Unset it or use localhost.`);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new EngineError(`OLLAMA_HOST must be http(s), not ${u.protocol}`);
  if (host === '0.0.0.0') u.hostname = '127.0.0.1';
  if (!u.port) u.port = '11434';
  return `${u.protocol}//${u.host}`;
}

async function call(host: string, pathName: string, body: unknown | undefined, timeoutMs: number): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${host}${pathName}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { msg = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* plain text */ }
      throw new EngineError(`Ollama at ${host} said: ${msg.slice(0, 200)}`);
    }
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof EngineError) throw e;
    if ((e as Error).name === 'AbortError') throw new EngineError(`Ollama at ${host} didn't answer within ${Math.round(timeoutMs / 1000)} s.`);
    throw new EngineError(`Ollama isn't reachable at ${host}. Start Ingle (or run "ollama serve") and try again.`);
  } finally {
    clearTimeout(t);
  }
}

interface TagModel { name: string; size?: number; details?: { family?: string; families?: string[] | null } }

/** The configured model, else the smallest installed chat model (not an embedding or base model). */
export async function pickModel(host: string, preferred?: string): Promise<string> {
  const want = preferred ?? process.env.INGLE_CODE_MODEL;
  if (want) return want;
  const tags = (await call(host, '/api/tags', undefined, 10_000)) as { models?: TagModel[] };
  const models = (tags.models ?? []).filter((m) => {
    const fam = [m.details?.family ?? '', ...(m.details?.families ?? [])].join(' ').toLowerCase();
    return !/embed|bert|minilm/.test(m.name.toLowerCase()) && !/bert/.test(fam);
  });
  if (!models.length) throw new EngineError(`No chat models are installed in Ollama at ${host}. Download a small one (for example qwen3:1.7b) or set INGLE_CODE_MODEL.`);
  // Base (non-instruct) models don't follow the note format: use one only if nothing else is installed.
  const isBase = (m: TagModel) => /(^|[-:_.])base($|[-:_.])/i.test(m.name);
  models.sort((a, b) => Number(isBase(a)) - Number(isBase(b)) || (a.size ?? Infinity) - (b.size ?? Infinity));
  return models[0].name;
}

export async function ollamaReachable(host: string): Promise<boolean> {
  try { await call(host, '/api/version', undefined, 2000); return true; } catch { return false; }
}

export interface Chunk { index: number; startLine: number; endLine: number; text: string }

/** Split into chunks of about `maxChars`, on line boundaries (very long lines are cut). */
export function chunkLines(lines: string[], maxChars: number): Chunk[] {
  const chunks: Chunk[] = [];
  let cur: string[] = [];
  let curChars = 0;
  let start = 1;
  const flush = (endLine: number) => {
    if (!cur.length) return;
    chunks.push({ index: chunks.length + 1, startLine: start, endLine, text: cur.join('\n') });
    cur = [];
    curChars = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    let line = `${i + 1}| ${lines[i]}`;
    if (line.length > maxChars) line = line.slice(0, maxChars - 20) + ' …[line cut]';
    if (curChars + line.length + 1 > maxChars && cur.length) { flush(i); start = i + 1; }
    cur.push(line);
    curChars += line.length + 1;
  }
  flush(lines.length);
  return chunks;
}

export function chunkPrompt(file: string, question: string, c: Chunk, total: number): string {
  return [
    'You are reading one part of a long file so that nothing in it is missed.',
    `File: ${file}, lines ${c.startLine}-${c.endLine} (part ${c.index} of ${total}). Each line starts with its number.`,
    `Question: ${question}`,
    '',
    '<<<',
    c.text,
    '>>>',
    '',
    'Reply with JSON only: {"relevant": true or false, "note": "one or two short sentences. If relevant, what in this part answers the question, with line numbers. If not, what this part contains."}',
  ].join('\n');
}

export function parseNote(raw: string): { relevant: boolean; note: string } {
  const text = raw.trim();
  try {
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { relevant?: unknown; note?: unknown };
    const relevant = j.relevant === true || j.relevant === 'true' || j.relevant === 'yes';
    const note = typeof j.note === 'string' ? j.note : JSON.stringify(j.note ?? '');
    return { relevant, note: note.replace(/\s+/g, ' ').trim().slice(0, 400) };
  } catch {
    return { relevant: /relevant"?\s*:\s*true/i.test(text), note: text.replace(/\s+/g, ' ').slice(0, 400) };
  }
}

export interface ExhaustiveOptions {
  host: string;
  model?: string;
  page?: number;
  chunksPerPage?: number;
  chunkChars?: number;
  timeoutMs?: number;
}

export async function readExhaustively(abs: string, rel: string, question: string, o: ExhaustiveOptions): Promise<ReadExhaustivelyResult> {
  if (!question.trim()) throw new EngineError('Say what to look for (question).');
  let text: string;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { throw new EngineError(`Can't read ${rel}.`); }
  if (text.includes('\0')) throw new EngineError(`${rel} looks like a binary file.`);
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const chunks = chunkLines(lines, Math.max(1000, o.chunkChars ?? 6000));
  const per = Math.max(1, o.chunksPerPage ?? 12);
  const pages = Math.max(1, Math.ceil(chunks.length / per));
  const page = Math.min(Math.max(1, Math.floor(o.page ?? 1)), pages);
  const slice = chunks.slice((page - 1) * per, page * per);
  const model = await pickModel(o.host, o.model);
  const notes: ChunkNote[] = [];
  let sendThink = true;
  for (const c of slice) {
    const body: Record<string, unknown> = {
      model,
      prompt: chunkPrompt(rel, question, c, chunks.length),
      stream: false,
      format: 'json',
      keep_alive: '5m',
      options: { temperature: 0, num_ctx: 8192, num_predict: 200 },
    };
    if (sendThink) body.think = false;
    let res: { response?: string };
    try {
      res = (await call(o.host, '/api/generate', body, o.timeoutMs ?? 180_000)) as { response?: string };
    } catch (e) {
      // Older engines and some models reject the think flag: retry once without it.
      if (!sendThink || !/think/i.test((e as Error).message)) throw e;
      sendThink = false;
      delete body.think;
      res = (await call(o.host, '/api/generate', body, o.timeoutMs ?? 180_000)) as { response?: string };
    }
    const n = parseNote(res.response ?? '');
    notes.push({ chunk: c.index, startLine: c.startLine, endLine: c.endLine, relevant: n.relevant, note: n.note });
  }
  return {
    file: rel, question, model, totalLines: lines.length, chunks: chunks.length,
    fromChunk: slice[0]?.index ?? 0, toChunk: slice[slice.length - 1]?.index ?? 0, page, pages, notes,
  };
}
