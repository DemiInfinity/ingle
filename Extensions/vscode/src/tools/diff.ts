// A small line diff (LCS on the changed middle) that prints a compact unified diff. Pure, no deps.

type Op = { t: ' ' | '-' | '+'; s: string; a: number; b: number }; // a/b = 1-based line numbers in old/new

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function ops(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const out: Op[] = [];
  for (let i = 0; i < pre; i++) out.push({ t: ' ', s: a[i], a: i + 1, b: i + 1 });
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const n = am.length, m = bm.length;
  if (n * m > 4_000_000) {
    am.forEach((s, i) => out.push({ t: '-', s, a: pre + i + 1, b: pre + 1 }));
    bm.forEach((s, j) => out.push({ t: '+', s, a: pre + n + 1, b: pre + j + 1 }));
  } else {
    // LCS table from the end, so we can walk forwards.
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = am[i] === bm[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) { out.push({ t: ' ', s: am[i], a: pre + i + 1, b: pre + j + 1 }); i++; j++; }
      else if (i < n && (j >= m || dp[(i + 1) * w + j] >= dp[i * w + j + 1])) { out.push({ t: '-', s: am[i], a: pre + i + 1, b: pre + j + 1 }); i++; }
      else { out.push({ t: '+', s: bm[j], a: pre + i + 1, b: pre + j + 1 }); j++; }
    }
  }
  for (let k = 0; k < suf; k++) {
    const ai = a.length - suf + k, bi = b.length - suf + k;
    out.push({ t: ' ', s: a[ai], a: ai + 1, b: bi + 1 });
  }
  return out;
}

/** Unified diff with `context` lines around each change. '' when the texts are the same. */
export function unifiedDiff(oldText: string, newText: string, name = 'file', context = 3, maxChars = 8000): string {
  const list = ops(splitLines(oldText), splitLines(newText));
  const changed = list.map((o, i) => (o.t !== ' ' ? i : -1)).filter((i) => i >= 0);
  if (!changed.length) return '';
  // Group changes into hunks.
  const hunks: [number, number][] = [];
  for (const i of changed) {
    const s = Math.max(0, i - context), e = Math.min(list.length - 1, i + context);
    const last = hunks[hunks.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else hunks.push([s, e]);
  }
  const out = [`--- a/${name}`, `+++ b/${name}`];
  for (const [s, e] of hunks) {
    const part = list.slice(s, e + 1);
    const oldCount = part.filter((o) => o.t !== '+').length;
    const newCount = part.filter((o) => o.t !== '-').length;
    const oldStart = oldCount ? (part.find((o) => o.t !== '+')!.a) : Math.max(0, part[0].a - 1);
    const newStart = newCount ? (part.find((o) => o.t !== '-')!.b) : Math.max(0, part[0].b - 1);
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const o of part) out.push(o.t + o.s);
  }
  let text = out.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…(diff trimmed)';
  return text;
}

/** Lines added and removed. */
export function diffStats(oldText: string, newText: string): { added: number; removed: number } {
  const list = ops(splitLines(oldText), splitLines(newText));
  return { added: list.filter((o) => o.t === '+').length, removed: list.filter((o) => o.t === '-').length };
}
