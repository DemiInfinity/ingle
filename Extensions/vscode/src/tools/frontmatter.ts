// Frontmatter, slugs and the secret filter — ported from Extensions.swift (SkillStore.frontmatter,
// RuleStore.stripFrontmatter) and Memory.swift (MemoryStore.slug, looksSecret). Pure, no vscode import.
import * as fs from 'fs';
import * as path from 'path';

const trimWS = (s: string) => s.replace(/^[ \t\r]+|[ \t\r]+$/g, '');

/** `---` / `key: value` lines / `---`. Values may be wrapped in double quotes. */
export function frontmatter(text: string): Record<string, string> {
  const lines = text.split('\n');
  if (lines.length === 0 || trimWS(lines[0]) !== '---') return {};
  const out: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    if (trimWS(line) === '---') break;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = trimWS(line.slice(0, colon));
    let value = trimWS(line.slice(colon + 1));
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key) out[key] = value;
  }
  return out;
}

/** The text after the closing `---`, trimmed. Text without frontmatter is returned trimmed. */
export function stripFrontmatter(text: string): string {
  const lines = text.split('\n');
  if (lines.length > 0 && trimWS(lines[0]) === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (trimWS(lines[i]) === '---') return lines.slice(i + 1).join('\n').trim();
    }
  }
  return text.trim();
}

/** "About Me" → "about-me". Same as MemoryStore.slug. */
export function slug(name: string): string {
  const lowered = name.toLowerCase().split('.md').join('');
  const cleaned = Array.from(lowered).map((c) => (/[\p{L}\p{N}]/u.test(c) ? c : '-')).join('');
  const collapsed = cleaned.replace(/-+/g, '-');
  const s = collapsed.replace(/^-+|-+$/g, '');
  return s ? Array.from(s).slice(0, 60).join('') : 'notes';
}

/** Passwords, keys and card numbers — never stored. Same as MemoryStore.looksSecret. */
export function looksSecret(s: string): boolean {
  const lower = s.toLowerCase();
  if (['password', 'passcode', 'pin code', 'api key', 'secret key', 'private key', 'token:'].some((w) => lower.includes(w))) return true;
  const digits = s.replace(/[ -]/g, '');
  return /\d{13,19}/.test(digits);
}

/** Lowercased words longer than two letters, as the Swift search functions use. */
export function searchWords(query: string): Set<string> {
  return new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => Array.from(w).length > 2));
}

/** Local date as yyyy-mm-dd (ISO8601DateFormatter .withFullDate in the current time zone). */
export function today(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Write via a temp file and rename, like Swift's atomically: true. Throws on failure. */
export function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export function readText(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

export function listDir(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

export function cmp(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
