// Finding old_text for edit_file: exact first, then tolerant of CRLF and trailing spaces. Pure.

export type EditPlan = { ok: true; start: number; end: number; replacement: string; tolerant: boolean }
  | { ok: false; reason: 'none' | 'many'; count?: number; nearest?: string };

function eolOf(text: string): '\r\n' | '\n' { return /\r\n/.test(text) ? '\r\n' : '\n'; }
function toEol(s: string, eol: string): string { return s.replace(/\r\n|\n/g, eol); }

function countAll(hay: string, needle: string): number[] {
  const at: number[] = [];
  let i = hay.indexOf(needle);
  while (i >= 0 && at.length < 50) { at.push(i); i = hay.indexOf(needle, i + Math.max(1, needle.length)); }
  return at;
}

/** Where to replace old_text with new_text in `text`. new_text is converted to the file's line endings. */
export function planEdit(text: string, oldText: string, newText: string): EditPlan {
  const eol = eolOf(text);
  // 1. Exact, and exact after matching the file's line endings.
  for (const [o, n] of [[oldText, newText], [toEol(oldText, eol), toEol(newText, eol)]] as const) {
    const hits = countAll(text, o);
    if (hits.length === 1) return { ok: true, start: hits[0], end: hits[0] + o.length, replacement: eol === '\r\n' ? toEol(n, eol) : n, tolerant: o !== oldText };
    if (hits.length > 1) return { ok: false, reason: 'many', count: hits.length };
  }
  // 2. Line by line, ignoring trailing whitespace and \r. The first line may start mid-line,
  //    the last may end mid-line.
  let oldN = oldText.replace(/\r\n/g, '\n');
  let newN = newText.replace(/\r\n/g, '\n');
  if (oldN.endsWith('\n')) { oldN = oldN.replace(/\n+$/, ''); newN = newN.replace(/\n$/, ''); }
  const oldLines = oldN.split('\n');
  if (!oldN.trim()) return { ok: false, reason: 'none' };

  const lines: { start: number; text: string }[] = [];
  { let pos = 0; for (const raw of text.split('\n')) { const t = raw.endsWith('\r') ? raw.slice(0, -1) : raw; lines.push({ start: pos, text: t }); pos += raw.length + 1; } }
  const rt = (s: string) => s.replace(/[ \t]+$/, '');
  const found: { start: number; end: number }[] = [];
  const k = oldLines.length;
  for (let i = 0; i + k <= lines.length && found.length < 2; i++) {
    let ok = true;
    let start = lines[i].start, end = 0;
    for (let j = 0; j < k && ok; j++) {
      const fl = lines[i + j].text, ol = oldLines[j];
      if (k === 1) {
        if (rt(fl) === rt(ol)) { start = lines[i].start; end = lines[i].start + fl.length; }
        else ok = false;
      } else if (j === 0) {
        const f = rt(fl), o = rt(ol);
        if (o === '' ? f === '' : f.endsWith(o)) start = lines[i].start + (o === '' ? 0 : f.length - o.length);
        else ok = false;
      } else if (j === k - 1) {
        if (rt(fl) === rt(ol)) end = lines[i + j].start + fl.length;
        else if (ol !== '' && fl.startsWith(ol)) end = lines[i + j].start + ol.length;
        else ok = false;
      } else if (rt(fl) !== rt(ol)) ok = false;
    }
    if (ok) found.push({ start, end });
  }
  if (found.length === 1) return { ok: true, start: found[0].start, end: found[0].end, replacement: toEol(newN, eol), tolerant: true };
  if (found.length > 1) return { ok: false, reason: 'many', count: found.length };
  return { ok: false, reason: 'none', nearest: nearestLines(text, oldLines) };
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.replace(/\s+/g, ' ').trim().toLowerCase();
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); }
  return m;
}
function similarity(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, total = 0;
  for (const [g, c] of A) { inter += Math.min(c, B.get(g) ?? 0); total += c; }
  for (const c of B.values()) total += c;
  return total ? (2 * inter) / total : 0;
}

/** The numbered lines of `text` that look most like the old_text, for the "not found" message. */
export function nearestLines(text: string, oldLines: string[]): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const probe = oldLines.find((l) => l.trim().length > 2) ?? oldLines[0] ?? '';
  const offset = Math.max(0, oldLines.indexOf(probe));
  if (!probe.trim()) return '';
  let best = -1, bestScore = 0;
  const limit = Math.min(lines.length, 20_000);
  for (let i = 0; i < limit; i++) {
    const s = lines[i].trim() === probe.trim() ? 2 : similarity(lines[i], probe);
    if (s > bestScore) { bestScore = s; best = i; }
  }
  if (best < 0 || bestScore < 0.35) return '';
  const from = Math.max(0, best - offset - 1);
  const to = Math.min(lines.length, from + oldLines.length + 3);
  return lines.slice(from, to).map((l, i) => `${from + i + 1}\t${l}`).join('\n');
}
