// Documents and images: read_document, view_image, and the helpers the engine uses for attachments
// (extractDocument, prepareImage). Uses macOS's own tools (textutil, PDFKit/Vision via JXA, sips, mdls),
// so most of this only works on a Mac; elsewhere it says so plainly.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readable } from './html';
import { checkRead, resolvePath, tidy } from './paths';
import { str, type ToolArgs, type ToolContext, type ToolDef, type ToolResult } from './types';

const MAX_DOC = 60_000;
const IS_MAC = process.platform === 'darwin';
const NOT_MAC = 'This needs macOS (it uses the Mac\'s built-in document and image tools).';

export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif']);
const TEXTUTIL_EXTS = new Set(['docx', 'doc', 'rtf', 'rtfd', 'odt', 'webarchive', 'wordml']);
const IWORK_EXTS = new Set(['pages', 'numbers', 'key']);
const SHEET_EXTS = new Set(['xlsx', 'xlsm']);
const HTML_EXTS = new Set(['html', 'htm', 'xhtml']);
/** Binary document types read_file should hand to read_document. */
export const DOCUMENT_EXTS = new Set(['pdf', ...TEXTUTIL_EXTS, ...IWORK_EXTS, ...SHEET_EXTS, 'xls', 'pptx', 'ppt']);

export function extOf(p: string): string { return path.extname(p).slice(1).toLowerCase(); }

// MARK: process helper

interface RunOut { code: number; stdout: string; stderr: string; buf: Buffer }
function run(cmd: string, args: string[], timeoutMs = 60_000, signal?: AbortSignal): Promise<RunOut> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', signal }, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0;
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''));
        resolve({ code, stdout: out.toString('utf8'), stderr: String(stderr ?? ''), buf: out });
      });
    } catch (e) {
      resolve({ code: 1, stdout: '', stderr: String(e), buf: Buffer.alloc(0) });
    }
  });
}

function tmpFile(ext: string): string {
  return path.join(os.tmpdir(), `ingle-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}
function rm(p: string): void { try { fs.rmSync(p, { force: true, recursive: true }); } catch { /* ignore */ } }

function cap(text: string, label: string): string {
  const t = text.replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  if (t.length <= MAX_DOC) return label + '\n\n' + t;
  return `${label} (showing the first ${MAX_DOC.toLocaleString('en-GB')} of ${t.length.toLocaleString('en-GB')} characters)\n\n${t.slice(0, MAX_DOC)}\n…(trimmed)`;
}

// MARK: PDF

const PDF_JXA = `ObjC.import('Foundation'); ObjC.import('Quartz');
function run(argv) {
  var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) return 'ERR';
  var s = doc.string;
  return String(doc.pageCount) + '\\n' + ((s && !s.isNil()) ? ObjC.unwrap(s) : '');
}`;

async function pdfText(file: string): Promise<{ pages?: number; text: string }> {
  const r = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PDF_JXA, file], 90_000);
  if (r.code === 0 && !r.stdout.startsWith('ERR')) {
    const nl = r.stdout.indexOf('\n');
    const pages = Number(r.stdout.slice(0, nl));
    const text = r.stdout.slice(nl + 1).trim();
    if (text) return { pages: Number.isFinite(pages) ? pages : undefined, text };
    if (Number.isFinite(pages)) {
      const md = await mdlsText(file);
      return { pages, text: md };
    }
  }
  return { text: await mdlsText(file) };
}

async function mdlsText(file: string): Promise<string> {
  const r = await run('/usr/bin/mdls', ['-raw', '-name', 'kMDItemTextContent', file], 20_000);
  const t = r.stdout.trim();
  return r.code === 0 && t && t !== '(null)' ? t : '';
}

// MARK: Spreadsheets (xlsx) — unzip + a tiny XML reader

function xmlText(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? '';
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}

function csvCell(v: string): string { return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

async function xlsxText(file: string): Promise<{ text: string; sheets: number } | string> {
  const list = await run('unzip', ['-Z1', file], 20_000);
  if (list.code !== 0) return "Couldn't open that spreadsheet (unzip failed).";
  const entries = list.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const sheetFiles = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  const shared: string[] = [];
  if (entries.includes('xl/sharedStrings.xml')) {
    const ss = (await run('unzip', ['-p', file, 'xl/sharedStrings.xml'])).stdout;
    for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1])).join(''));
    }
  }
  const names: string[] = [];
  if (entries.includes('xl/workbook.xml')) {
    const wb = (await run('unzip', ['-p', file, 'xl/workbook.xml'])).stdout;
    for (const m of wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)) names.push(xmlText(m[1]));
  }
  const parts: string[] = [];
  let total = 0;
  for (const [i, sf] of sheetFiles.slice(0, 5).entries()) {
    const xml = (await run('unzip', ['-p', file, sf])).stdout;
    const rows: string[] = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const inner = c[2] ?? '';
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '';
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let value = '';
        if (type === 's' && v !== undefined) value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') value = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1])).join('');
        else if (v !== undefined) value = xmlText(v);
        const idx = ref ? colIndex(ref) : cells.length;
        while (cells.length < idx) cells.push('');
        cells[idx] = csvCell(value);
      }
      if (cells.some((c) => c !== '')) rows.push(cells.join(','));
      total += rows.length ? rows[rows.length - 1].length : 0;
      if (total > MAX_DOC) break;
    }
    parts.push(`## Sheet ${i + 1}${names[i] ? `: ${names[i]}` : ''} (${rows.length} rows)\n${rows.join('\n')}`);
    if (total > MAX_DOC) break;
  }
  if (sheetFiles.length > 5) parts.push(`…and ${sheetFiles.length - 5} more sheets not shown.`);
  return { text: parts.join('\n\n'), sheets: sheetFiles.length };
}

// MARK: iWork (.pages/.numbers/.key) — use the QuickLook preview PDF when there is one

async function iworkText(file: string): Promise<string> {
  const exportHint = 'Export it as PDF (File → Export To → PDF) and I can read that.';
  if (!IS_MAC) return NOT_MAC;
  let pdf: string | null = null;
  let cleanup: string | null = null;
  try {
    if (fs.statSync(file).isDirectory()) {
      const p = path.join(file, 'QuickLook', 'Preview.pdf');
      if (fs.existsSync(p)) pdf = p;
    } else {
      const list = await run('unzip', ['-Z1', file], 20_000);
      const entry = list.stdout.split('\n').map((s) => s.trim()).find((e) => /^QuickLook\/Preview\.pdf$/i.test(e));
      if (entry) {
        const out = await run('unzip', ['-p', file, entry]);
        if (out.code === 0 && out.buf.length > 0) {
          pdf = tmpFile('pdf');
          fs.writeFileSync(pdf, out.buf);
          cleanup = pdf;
        }
      }
    }
    if (!pdf) {
      const md = await mdlsText(file);
      return md ? cap(md, `Document: ${path.basename(file)} (text from Spotlight)`) : `I can't read the text inside ${path.basename(file)}. ${exportHint}`;
    }
    const r = await pdfText(pdf);
    if (!r.text) return `${path.basename(file)} has no readable text in its preview. ${exportHint}`;
    return cap(r.text, `Document: ${path.basename(file)} (from its preview${r.pages ? `, ${r.pages} pages` : ''} — layout may be simplified)`);
  } catch {
    return `Couldn't open ${path.basename(file)}. ${exportHint}`;
  } finally {
    if (cleanup) rm(cleanup);
  }
}

// MARK: extractDocument

/** Text of a document at an absolute path (PDF, Word, RTF, iWork, xlsx, HTML, CSV, plain text…).
 *  Returns the text with a one-line header, or a plain error sentence. Never throws. */
export async function extractDocument(file: string): Promise<string> {
  try {
    const st = fs.statSync(file);
    const name = path.basename(file);
    const ext = extOf(file);
    if (IWORK_EXTS.has(ext)) return await iworkText(file);
    if (st.isDirectory() && ext !== 'rtfd') return `${name} is a folder, not a document.`;
    if (IMAGE_EXTS.has(ext)) return `${name} is an image — use view_image for it.`;

    if (ext === 'pdf') {
      if (!IS_MAC) return `Reading PDFs ${NOT_MAC.slice(5)}`;
      const r = await pdfText(file);
      if (!r.text) return `${name} has no text layer (it may be a scan)${r.pages ? ` — ${r.pages} pages` : ''}. Try view_image on a screenshot of a page instead.`;
      return cap(r.text, `Document: ${name} (PDF${r.pages ? `, ${r.pages} page${r.pages === 1 ? '' : 's'}` : ''})`);
    }
    if (SHEET_EXTS.has(ext)) {
      const r = await xlsxText(file);
      if (typeof r === 'string') return r;
      return cap(r.text || '(no cells with values)', `Spreadsheet: ${name} (${r.sheets} sheet${r.sheets === 1 ? '' : 's'}${r.sheets > 5 ? ', first 5 shown' : ''}, as CSV)`);
    }
    if (HTML_EXTS.has(ext)) return cap(readable(fs.readFileSync(file, 'utf8')), `Document: ${name} (HTML as text)`);
    if (TEXTUTIL_EXTS.has(ext)) {
      if (!IS_MAC) {
        if (ext === 'docx') {
          const x = await run('unzip', ['-p', file, 'word/document.xml']);
          if (x.code === 0 && x.stdout) {
            const t = xmlText(x.stdout.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t'));
            return cap(t, `Document: ${name} (Word)`);
          }
        }
        return `Reading .${ext} files ${NOT_MAC.slice(5)}`;
      }
      const r = await run('/usr/bin/textutil', ['-convert', 'txt', '-stdout', file], 60_000);
      if (r.code !== 0) return `Couldn't convert ${name} to text${r.stderr ? `: ${r.stderr.trim().slice(0, 200)}` : '.'}`;
      return cap(r.stdout, `Document: ${name}`);
    }
    if (ext === 'pptx' || ext === 'ppt' || ext === 'xls') {
      if (IS_MAC) {
        const md = await mdlsText(file);
        if (md) return cap(md, `Document: ${name} (text from Spotlight — layout lost)`);
      }
      if (ext === 'pptx') {
        const list = await run('unzip', ['-Z1', file], 20_000);
        const slides = list.stdout.split('\n').map((s) => s.trim()).filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e))
          .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
        const parts: string[] = [];
        for (const [i, s] of slides.entries()) {
          const xml = (await run('unzip', ['-p', file, s])).stdout;
          const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => xmlText(m[1])).join(' ');
          parts.push(`## Slide ${i + 1}\n${text}`);
        }
        if (parts.length) return cap(parts.join('\n\n'), `Presentation: ${name} (${slides.length} slides)`);
      }
      return `I can't read ${name}. Export it as PDF and I can read that.`;
    }
    // Plain text (csv, tsv, json, md, code…): refuse obvious binaries.
    const buf = fs.readFileSync(file);
    if (buf.subarray(0, 8000).includes(0)) return `${name} looks like a binary file, so I can't read it as text.`;
    const kind = ext === 'csv' ? 'CSV' : ext === 'tsv' ? 'TSV' : ext === 'json' ? 'JSON' : ext === 'md' ? 'Markdown' : 'text';
    return cap(buf.toString('utf8'), `Document: ${name} (${kind})`);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return `There's no file at ${file}.`;
    return `Couldn't read ${path.basename(file)}: ${err.message ?? String(e)}`;
  }
}

// MARK: Images

const OCR_JXA = `ObjC.import('Foundation'); ObjC.import('Vision');
function run(argv) {
  var handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(argv[0]), $({}));
  var req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = 0;
  req.usesLanguageCorrection = true;
  if (!handler.performRequestsError($([req]), null)) return '';
  var results = req.results, out = [];
  if (!results || results.isNil()) return '';
  for (var i = 0; i < results.count; i++) {
    var c = results.objectAtIndex(i).topCandidates(1);
    if (c.count > 0) out.push(ObjC.unwrap(c.objectAtIndex(0).string));
  }
  return out.join('\\n');
}`;

/** Text in an image via the Vision framework (macOS). '' if none or not on a Mac. */
export async function ocrImage(file: string): Promise<string> {
  if (!IS_MAC) return '';
  const r = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', OCR_JXA, file], 60_000);
  return r.code === 0 ? r.stdout.trim() : '';
}

async function imageSize(file: string): Promise<{ w: number; h: number } | null> {
  if (!IS_MAC) return null;
  const r = await run('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], 15_000);
  const w = /pixelWidth:\s*(\d+)/.exec(r.stdout)?.[1];
  const h = /pixelHeight:\s*(\d+)/.exec(r.stdout)?.[1];
  return w && h ? { w: Number(w), h: Number(h) } : null;
}

async function sipsJpeg(src: string, maxPx: number): Promise<Buffer | null> {
  const out = tmpFile('jpg');
  try {
    const r = await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', String(maxPx), src, '--out', out], 30_000);
    if (r.code !== 0 || !fs.existsSync(out)) return null;
    return fs.readFileSync(out);
  } finally {
    rm(out);
  }
}

function sniffMime(buf: Buffer): 'image/jpeg' | 'image/png' | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

/** Turn an image (path or raw bytes) into what the model and UI need:
 *  base64 = JPEG ≤ 1600 px (no data: prefix), thumbnail = ~256 px JPEG data: URL,
 *  ocrText only when opts.ocr is set. Returns an error sentence on failure. Never throws. */
export async function prepareImage(input: string | Buffer, name?: string, opts?: { ocr?: boolean }): Promise<{ base64: string; thumbnail: string; ocrText?: string } | string> {
  let src: string;
  let cleanup: string | null = null;
  try {
    if (typeof input === 'string') {
      src = input;
      if (!fs.existsSync(src)) return `There's no image at ${src}.`;
    } else {
      const ext = (name && extOf(name)) || (sniffMime(input) === 'image/png' ? 'png' : 'jpg');
      src = tmpFile(ext);
      fs.writeFileSync(src, input);
      cleanup = src;
    }
    const label = name || path.basename(src);
    if (!IS_MAC) {
      // No sips: pass JPEG/PNG through unchanged (no resizing); anything else needs macOS.
      const buf = fs.readFileSync(src);
      const mime = sniffMime(buf);
      if (!mime) return `Converting ${label} ${NOT_MAC.slice(5)}`;
      if (buf.length > 8 * 1024 * 1024) return `${label} is too large to send without resizing, and resizing needs macOS.`;
      const b64 = buf.toString('base64');
      return { base64: b64, thumbnail: `data:${mime};base64,${b64}` };
    }
    const big = await sipsJpeg(src, 1600);
    if (!big) return `Couldn't open ${label} as an image.`;
    const small = await sipsJpeg(src, 256);
    const result: { base64: string; thumbnail: string; ocrText?: string } = {
      base64: big.toString('base64'),
      thumbnail: 'data:image/jpeg;base64,' + (small ?? big).toString('base64'),
    };
    if (opts?.ocr) result.ocrText = await ocrImage(src);
    return result;
  } catch (e) {
    return `Couldn't prepare that image: ${(e as Error).message ?? String(e)}`;
  } finally {
    if (cleanup) rm(cleanup);
  }
}

// MARK: Tools

const readDocument: ToolDef = {
  name: 'read_document',
  description: 'Read the text of a document: PDF, Word (.docx/.doc), RTF, Pages/Numbers/Keynote, Excel (.xlsx), PowerPoint (.pptx), HTML, CSV.',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path (absolute, ~/…, or relative to the project)' } }, required: ['path'] },
  readOnly: true,
  available: () => true,
  describe: (a: ToolArgs) => ({ title: 'Read a document', detail: str(a, 'path'), icon: 'file' }),
  async run(a: ToolArgs, ctx: ToolContext): Promise<string> {
    const raw = str(a, 'path');
    if (!raw.trim()) return 'Give me the path of the document to read.';
    const abs = resolvePath(raw, ctx.workspaceRoot);
    const denied = await checkRead(abs, ctx, 'a document');
    if (denied) return denied;
    ctx.setActivity('Reading a document…');
    try { return await extractDocument(abs); } finally { ctx.setActivity(null); }
  },
};

const viewImage: ToolDef = {
  name: 'view_image',
  description: 'Look at an image file (PNG, JPEG, GIF, WebP, HEIC, TIFF…), e.g. a screenshot or design mock-up.',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'Image path (absolute, ~/…, or relative to the project)' } }, required: ['path'] },
  readOnly: true,
  available: () => true,
  describe: (a: ToolArgs) => ({ title: 'Look at an image', detail: str(a, 'path'), icon: 'file' }),
  async run(a: ToolArgs, ctx: ToolContext): Promise<string | ToolResult> {
    const raw = str(a, 'path');
    if (!raw.trim()) return 'Give me the path of the image to look at.';
    const abs = resolvePath(raw, ctx.workspaceRoot);
    if (!IMAGE_EXTS.has(extOf(abs))) {
      return DOCUMENT_EXTS.has(extOf(abs)) ? 'That is a document — use read_document for it.' : "That doesn't look like an image file (png, jpg, gif, webp, heic, tiff, bmp).";
    }
    if (!fs.existsSync(abs)) return `There's no image at ${tidy(abs)}.`;
    const denied = await checkRead(abs, ctx, 'an image');
    if (denied) return denied;
    ctx.setActivity(ctx.vision ? 'Looking at an image…' : 'Reading text in an image…');
    try {
      const size = await imageSize(abs);
      const sizeText = size ? `${size.w}×${size.h} px` : '';
      if (!ctx.vision) {
        if (!IS_MAC) return `The current model can't see images, and reading text from images ${NOT_MAC.slice(5)}`;
        const text = await ocrImage(abs);
        return `${path.basename(abs)}${sizeText ? ` (${sizeText})` : ''}. The current model can't see images, so here is the text found in it:\n\n`
          + (text ? text.slice(0, MAX_DOC) : '(no text found)');
      }
      const img = await prepareImage(abs);
      if (typeof img === 'string') return img;
      return { text: `Image: ${tidy(abs)}${sizeText ? ` (${sizeText}, sent resized to fit 1600 px)` : ''}.`, images: [img.base64] };
    } finally {
      ctx.setActivity(null);
    }
  },
};

export const documentTools: ToolDef[] = [readDocument, viewImage];
