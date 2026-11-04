// The previewer's pure logic (tested): what a file shows as, and ticking a task-list box in Markdown.
// Same rules as PreviewKind / PreviewTasks in Sources/Ingle/Preview/PreviewTabs.swift.
import * as path from 'path';

export type PreviewKind = 'markdown' | 'html' | 'svg' | 'image' | 'pdf' | 'csv' | 'tsv' | 'json' | 'yaml' | 'code';

export function previewKind(file: string): PreviewKind {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (['md', 'markdown', 'mdown', 'mkd'].includes(ext)) return 'markdown';
  if (['html', 'htm', 'xhtml'].includes(ext)) return 'html';
  if (ext === 'svg') return 'svg';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'heic', 'tif', 'tiff', 'avif'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'csv') return 'csv';
  if (ext === 'tsv' || ext === 'tab') return 'tsv';
  if (['json', 'jsonc', 'geojson', 'ipynb'].includes(ext)) return 'json';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  return 'code';
}

/** Text files are read and sent to the page; images and PDFs aren't. */
export function isTextKind(kind: PreviewKind): boolean {
  return kind !== 'image' && kind !== 'pdf';
}

const TASK = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/;

/** Sets the `index`th task-list box (front matter and fenced code skipped, as the renderer counts them).
 *  The new text, or undefined if there's no such box. */
export function toggleTask(text: string, index: number, checked: boolean): string | undefined {
  const lines = text.split('\n');
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end > 0) start = end + 1;
  }
  let fence: string | undefined;
  let count = 0;
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (fence) { if (t.startsWith(fence)) fence = undefined; continue; }
    if (t.startsWith('```') || t.startsWith('~~~')) { fence = t.slice(0, 3); continue; }
    const m = TASK.exec(lines[i]);
    if (!m) continue;
    if (count === index) {
      const head = m[0].slice(0, -2);
      lines[i] = head + (checked ? 'x]' : ' ]') + lines[i].slice(m[0].length);
      return lines.join('\n');
    }
    count++;
  }
  return undefined;
}

/** A link in a preview: a local file (absolute, or relative to the file's folder), or undefined for web links etc. */
export function resolveLocalLink(href: string, folder: string): string | undefined {
  let p = href.trim();
  if (!p || p.startsWith('#')) return undefined;
  if (p.startsWith('file://')) { try { return decodeURIComponent(new URL(p).pathname); } catch { return undefined; } }
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return undefined;
  p = p.split('#')[0].split('?')[0];
  try { p = decodeURIComponent(p); } catch { /* keep as written */ }
  if (p.startsWith('~')) return path.join(process.env.HOME ?? '', p.slice(1));
  return path.resolve(folder, p);
}

/** Words that suggest the user wants to see a file (tool filtering; same as Preview.wanted in Swift). */
export const PREVIEW_WANTS = /preview|show me|let me see|render|open (it|the|that)|\.(html?|svg|md|csv|pdf)\b|diagram|chart|page|mermaid/;
