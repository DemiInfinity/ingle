// Short text renderings of engine results, written for 16–32K context windows. The MCP server and the apps share these.
import {
  CallsResult, DefinitionResult, DiagnosticsResult, ImpactResult, OutlineResult, PageInfo, ReadExhaustivelyResult, ReferencesResult, Source, StatusResult,
} from './types';

function more(p: PageInfo, noun: string): string {
  if (p.total === 0) return '';
  const head = `showing ${p.from}–${p.to} of ${p.total} ${noun}`;
  return p.page < p.pages ? `${head}; for more, call again with page: ${p.page + 1}` : head;
}

export function formatSources(sources: Source[]): string {
  if (!sources.length) return 'sources: none';
  return 'sources: ' + sources.map((s) => (s.exactness === 'exact' ? `${s.language} exact (${s.via})` : `${s.language} approximate (${s.reason ?? s.via})`)).join('; ');
}

export function formatStatus(s: StatusResult): string {
  const out = [`workspace: ${s.root}${s.git ? ' (git)' : ''}`];
  const used = s.languages.filter((l) => l.files > 0);
  if (!used.length) out.push('no source files in a known language');
  for (const l of used) {
    const server = l.server ? `${l.server}${l.running ? ', running' : ''}` : 'no server';
    out.push(`${l.language}: ${l.files} files, ${l.exactness} (${server})${l.note && l.server ? ` — ${l.note}` : ''}`);
  }
  const missing = s.languages.filter((l) => l.files > 0 && !l.server).map((l) => `${l.language}: ${l.note}`);
  if (missing.length) out.push(`install for exact results: ${missing.join('; ')}`);
  const spare = s.languages.filter((l) => l.files === 0 && l.server).map((l) => l.server);
  if (spare.length) out.push(`also installed (no files here): ${spare.join(', ')}`);
  out.push(s.ollama.reachable ? `read_exhaustively: ready (${s.ollama.host}, model ${s.ollama.model ?? '?'})` : `read_exhaustively: unavailable — ${s.ollama.error ?? 'Ollama not reachable'}${s.ollama.host ? ` (${s.ollama.host})` : ''}`);
  return out.join('\n');
}

export function formatOutline(r: OutlineResult): string {
  const out = [`outline of ${r.file}: ${r.total} symbols, ${r.source.exactness} (${r.source.exactness === 'exact' ? r.source.via : r.source.reason ?? 'scan'})`];
  for (const s of r.items) out.push(`${'  '.repeat(Math.min(s.depth, 4))}${s.kind} ${s.name}  ${s.startLine}-${s.endLine}`);
  const m = more(r, 'symbols');
  if (m) out.push(m);
  return out.join('\n');
}

export function formatDefinition(r: DefinitionResult): string {
  if (!r.total) return `no definition found for ${r.target}\n${formatSources(r.sources)}`;
  const out = [`definition of ${r.target}: ${r.total} found`, formatSources(r.sources)];
  for (const d of r.items) out.push(`${d.file}:${d.line}:${d.col} ${d.kind}${d.container ? ` in ${d.container}` : ''} [${tag(d.exactness)}]  ${d.text}`);
  const m = more(r, 'definitions');
  if (m) out.push(m);
  return out.join('\n');
}

function tag(e: string): string {
  return e === 'exact' ? 'exact' : 'approx';
}

export function formatReferences(r: ReferencesResult): string {
  if (!r.total) return `no references found for ${r.target}\n${formatSources(r.sources)}`;
  const out = [
    `references to ${r.target}: ${r.total} in ${r.files} files (${r.exactCount} exact, ${r.approximateCount} approximate)`,
    formatSources(r.sources),
  ];
  if (r.definitions.length) out.push('defined at: ' + r.definitions.map((d) => `${d.file}:${d.line}`).join(', '));
  if (r.items.some((i) => i.unconfirmed)) out.push('"text only" = a text match the language server did not report (comment, string, other symbol, or not indexed yet)');
  out.push(more(r, 'references'));
  let file = '';
  for (const i of r.items) {
    if (i.file !== file) { file = i.file; out.push(file); }
    const flags = [i.unconfirmed ? 'text only' : tag(i.exactness)];
    if (i.inComment) flags.push('comment/string');
    if (i.definition) flags.push('definition');
    out.push(`  ${i.line}:${i.col} [${flags.join(', ')}] ${i.text}`);
  }
  return out.join('\n');
}

export function formatCalls(r: CallsResult): string {
  const what = r.direction === 'callers' ? 'callers of' : 'callees of';
  if (!r.total) return `no ${r.direction} found for ${r.target}\n${formatSources(r.sources)}`;
  const out = [`${what} ${r.target}: ${r.total} (depth ${r.depth})`, formatSources(r.sources)];
  out.push(more(r, r.direction));
  for (const c of r.items) {
    const via = c.via ? ` via ${c.via}` : '';
    const at = r.direction === 'callers' ? `calls at line${c.callLines.length > 1 ? 's' : ''} ${c.callLines.join(', ')}` : `called at line${c.callLines.length > 1 ? 's' : ''} ${c.callLines.join(', ')}`;
    out.push(`${c.level === 2 ? '  ' : ''}${c.name} (${c.kind}) ${c.file}:${c.line} [${tag(c.exactness)}]${via} — ${at}`);
  }
  return out.join('\n');
}

export function formatImpact(r: ImpactResult): string {
  const out = [
    `impact of changing ${r.target}`,
    formatSources(r.sources),
    `references: ${r.references.total} (${r.references.exactCount} exact, ${r.references.approximateCount} approximate)${r.definitions.length ? `; defined at ${r.definitions.map((d) => `${d.file}:${d.line}`).join(', ')}` : ''}`,
  ];
  if (r.pages > 1) out.push(`page ${r.page} of ${r.pages}${r.page < r.pages ? `; for more, call again with page: ${r.page + 1}` : ''}`);
  if (r.references.files.length) {
    out.push('files that use it:');
    for (const f of r.references.files) {
      const how = f.exactCount === f.count ? 'exact' : f.exactCount === 0 ? 'approx' : `${f.exactCount} exact, ${f.count - f.exactCount} approx`;
      out.push(`  ${f.file} (${f.count}: ${how})`);
    }
  }
  if (r.references.mentionedOnly.length) out.push(`only mentioned in comments/strings: ${r.references.mentionedOnly.slice(0, 10).join(', ')}${r.references.mentionedOnly.length > 10 ? ` (+${r.references.mentionedOnly.length - 10} more)` : ''}`);
  out.push(`callers: ${r.callersTotal}`);
  for (const c of r.callers) out.push(`  ${c.name} ${c.file}:${c.line} [${tag(c.exactness)}]`);
  if (r.tests.length) {
    out.push('tests that cover these files (name = file name matches, import = imports it, uses = uses the symbol):');
    for (const t of r.tests) out.push(`  ${t.file} (${t.reasons.join(', ')})${t.covers.length ? ` → ${t.covers.slice(0, 4).join(', ')}${t.covers.length > 4 ? ', …' : ''}` : ''}`);
  } else out.push('tests: none found by name or import');
  if (r.untested.length) out.push(`no test found for: ${r.untested.slice(0, 20).join(', ')}${r.untested.length > 20 ? ` (+${r.untested.length - 20} more)` : ''}`);
  return out.join('\n');
}

export function formatDiagnostics(r: DiagnosticsResult): string {
  const out = [`diagnostics: ${r.errors} errors, ${r.warnings} warnings in ${r.checked.length} checked files${r.scope ? ` (${r.scope})` : ''}`];
  if (r.sources.length) out.push(formatSources(r.sources));
  if (r.skipped.length) {
    out.push(`not checked (${r.skipped.length}):`);
    for (const s of r.skipped.slice(0, 10)) out.push(`  ${s.file}: ${s.reason}`);
    if (r.skipped.length > 10) out.push(`  … and ${r.skipped.length - 10} more`);
  }
  const m = more(r, 'diagnostics');
  if (m) out.push(m);
  for (const d of r.items) out.push(`${d.file}:${d.line}:${d.col} ${d.severity}: ${d.message}${d.source ? ` (${d.source})` : ''}`);
  if (!r.total && r.checked.length) out.push('no problems found');
  return out.join('\n');
}

export function formatExhaustive(r: ReadExhaustivelyResult): string {
  const out = [
    `read ${r.file} for: ${r.question}`,
    `${r.totalLines} lines in ${r.chunks} chunks; this call read chunks ${r.fromChunk}–${r.toChunk} (model ${r.model})`,
  ];
  const relevant = r.notes.filter((n) => n.relevant);
  const other = r.notes.filter((n) => !n.relevant);
  out.push(relevant.length ? 'relevant:' : 'relevant: nothing in these chunks');
  for (const n of relevant) out.push(`  lines ${n.startLine}-${n.endLine}: ${n.note}`);
  if (other.length) {
    out.push('other chunks (not relevant):');
    for (const n of other) out.push(`  lines ${n.startLine}-${n.endLine}: ${n.note}`);
  }
  out.push(r.page < r.pages ? `not finished: ${r.chunks - r.toChunk} chunks left. Call again with page: ${r.page + 1} to keep reading.` : 'finished: every chunk has been read.');
  return out.join('\n');
}
