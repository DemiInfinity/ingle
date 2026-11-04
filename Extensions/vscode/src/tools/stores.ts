// The ~/.ingle stores — rules, skills, memory, research reports, MCP config — ported from
// Extensions.swift, Memory.swift and Knowledge.swift so both apps read and write the same files.
// No vscode import: the engine and the tests can use it directly.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IngleSettings } from '../shared/settings';
import { paths } from '../shared/settings';
import { cmp, frontmatter, listDir, looksSecret, readText, searchWords, slug, stripFrontmatter, today, writeAtomic } from './frontmatter';

export interface RuleEntry { name: string; description: string; always: boolean; body: string; file: string }
export interface SkillEntry { name: string; description: string; body: string; file: string; source: 'ingle' | 'claude' }
export interface MemoryEntry { name: string; description: string; body: string; file: string }
export interface ReportEntry { name: string; title: string; description: string; date: string; body: string; file: string }

export { slug, looksSecret, frontmatter, stripFrontmatter };

const isMd = (f: string) => path.extname(f).toLowerCase() === '.md';

// MARK: Rules

function loadRules(folder: string, prefix: string): RuleEntry[] {
  return listDir(folder).filter(isMd).sort(cmp).flatMap((f) => {
    const file = path.join(folder, f);
    const text = readText(file);
    if (text === null) return [];
    const meta = frontmatter(text);
    const name = prefix + (meta.name ?? path.basename(f, path.extname(f)));
    // No frontmatter at all = a plain rule that always applies.
    const always = Object.keys(meta).length === 0 ? true : ['true', 'yes', '1'].includes((meta.always ?? 'false').toLowerCase());
    return [{ name, description: meta.description ?? '', always, body: stripFrontmatter(text), file }];
  });
}

/** ~/.ingle/rules, plus `<workspace>/.ingle/rules` with names prefixed `project/` (so both are kept,
 *  as on the Mac — RuleStore). */
export function listRules(workspaceRoot?: string): RuleEntry[] {
  const out = loadRules(paths.rules, '');
  if (workspaceRoot) out.push(...loadRules(path.join(workspaceRoot, '.ingle', 'rules'), 'project/'));
  return out;
}

export function readRule(name: string, workspaceRoot?: string): string {
  const rules = listRules(workspaceRoot);
  const key = name.trim().toLowerCase();
  const r = rules.find((x) => x.name.toLowerCase() === key);
  if (!r) return `There's no rule called ${name}. Rules: ${rules.map((x) => x.name).join(', ')}.`;
  return r.body.slice(0, 20_000);
}

// MARK: Skills

export function skillRoots(settings: IngleSettings): { root: string; source: 'ingle' | 'claude' }[] {
  const roots: { root: string; source: 'ingle' | 'claude' }[] = [{ root: paths.skills, source: 'ingle' }];
  if (settings.useClaudeSkills) roots.push({ root: paths.claudeSkills, source: 'claude' });
  return roots;
}

/** Skills in ~/.ingle/skills and (if useClaudeSkills) ~/.claude/skills. First name wins. body = SKILL.md without frontmatter. */
export function listSkills(settings: IngleSettings): SkillEntry[] {
  const seen = new Set<string>();
  const out: SkillEntry[] = [];
  for (const { root, source } of skillRoots(settings)) {
    for (const dir of listDir(root).sort(cmp)) {
      const file = path.join(root, dir, 'SKILL.md');
      const text = readText(file);
      if (text === null) continue;
      const meta = frontmatter(text);
      const name = meta.name ?? dir;
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push({ name, description: meta.description ?? '', body: stripFrontmatter(text), file, source });
    }
  }
  return out;
}

export function readSkill(name: string, settings: IngleSettings): string {
  const skills = listSkills(settings);
  const key = name.trim().toLowerCase();
  const skill = skills.find((s) => s.name.toLowerCase() === key);
  if (!skill) return `There's no skill called ${name}. Available: ${skills.map((s) => s.name).join(', ')}.`;
  let out = (readText(skill.file) ?? '').slice(0, 30_000);
  const folder = path.dirname(skill.file);
  const extras = listDir(folder).filter((f) => f !== 'SKILL.md' && !f.startsWith('.')).sort(cmp);
  if (extras.length) {
    out += '\n\nOther files in this skill (open them with read_file):\n';
    out += extras.map((f) => '- ' + path.join(folder, f)).join('\n');
  }
  return out;
}

// MARK: Memory

export function listMemory(): MemoryEntry[] {
  return listDir(paths.memory).filter((f) => isMd(f) && f !== 'INDEX.md').sort(cmp).flatMap((f) => {
    const file = path.join(paths.memory, f);
    const text = readText(file);
    if (text === null) return [];
    return [{ name: path.basename(f, path.extname(f)), description: frontmatter(text).description ?? '', body: stripFrontmatter(text), file }];
  });
}

export function memoryFacts(body: string): string[] {
  return body.split('\n').map((l) => l.replace(/^[ \t]+|[ \t]+$/g, '')).filter((l) => l && !l.startsWith('#'));
}

function writeMemory(name: string, description: string, body: string): void {
  const text = `---\ndescription: ${description}\n---\n\n${body.trim()}\n`;
  writeAtomic(path.join(paths.memory, `${slug(name)}.md`), text);
  writeMemoryIndex();
}

/** INDEX.md for browsing in Finder — regenerated, never a memory. */
export function writeMemoryIndex(): void {
  try {
    const lines = ['# Memory index', '', 'Ingle keeps this up to date. Each file below holds one subject.', '',
      ...listMemory().map((m) => `- [${m.name}](${m.name}.md) — ${m.description || '(no description)'} · ${memoryFacts(m.body).length} facts`)];
    writeAtomic(path.join(paths.memory, 'INDEX.md'), lines.join('\n'));
  } catch { /* best effort */ }
}

export function memorySave(file: string, factIn: string, description?: string): string {
  const fact = factIn.trim();
  if (!fact) return 'Nothing to save.';
  if (looksSecret(fact)) return 'Not saved: that looks like a password, key or card number, which Ingle never stores.';
  const name = slug(file);
  const existing = listMemory().find((m) => m.name === name);
  const line = fact.startsWith('- ') ? fact : '- ' + fact;
  if (existing && memoryFacts(existing.body).some((f) => f.toLowerCase() === line.toLowerCase())) return `Already remembered in ${name}.`;
  const desc = (existing?.description ? existing.description : null)
    ?? (description?.trim() || null) ?? `Things to remember about ${name.split('-').join(' ')}`;
  try { writeMemory(name, desc, (existing?.body ?? '') + '\n' + line); } catch (e) { return `Couldn't save: ${(e as Error).message}`; }
  return `Saved to ${name}: ${line.slice(2)}`;
}

export function memoryRewrite(file: string, content: string, description?: string): string {
  if (looksSecret(content)) return 'Not saved: that includes something that looks like a password, key or card number.';
  const name = slug(file);
  const existing = listMemory().find((m) => m.name === name);
  const desc = description?.trim() || existing?.description || 'Things to remember';
  try { writeMemory(name, desc, content); } catch (e) { return `Couldn't save: ${(e as Error).message}`; }
  return `Rewrote ${name}.`;
}

export function memoryForget(file: string, text: string): string {
  const name = slug(file);
  const existing = listMemory().find((m) => m.name === name);
  if (!existing) return `There's no memory file called ${name}.`;
  const needle = text.trim();
  if (!needle) return 'Say what to forget.';
  const lines = existing.body.split('\n');
  const kept = lines.filter((l) => !l.toLowerCase().includes(needle.toLowerCase()));
  const removed = lines.length - kept.length;
  if (removed === 0) return `Nothing in ${name} mentions “${needle}”.`;
  try { writeMemory(name, existing.description, kept.join('\n')); } catch (e) { return `Couldn't save: ${(e as Error).message}`; }
  return `Forgot ${removed} line${removed === 1 ? '' : 's'} from ${name}.`;
}

export function memoryRead(file: string): string {
  const name = slug(file);
  const all = listMemory();
  const m = all.find((x) => x.name === name);
  if (!m) return `There's no memory file called ${name}. Files: ${all.map((x) => x.name).join(', ')}.`;
  return m.body.slice(0, 12_000);
}

export function memorySearch(query: string): string {
  const words = [...searchWords(query)];
  if (!words.length) return 'Give me a word or two to search for.';
  const hits: { score: number; line: string; order: number }[] = [];
  for (const file of listMemory()) {
    const fileHit = words.some((w) => file.name.includes(w) || file.description.toLowerCase().includes(w)) ? 1 : 0;
    for (const fact of memoryFacts(file.body)) {
      const lower = fact.toLowerCase();
      const score = words.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0) + fileHit;
      if (score > 0) hits.push({ score, line: `[${file.name}] ${fact}`, order: hits.length });
    }
  }
  if (!hits.length) return 'Nothing in memory about that.';
  return hits.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, 15).map((h) => h.line).join('\n');
}

/** "## Memory index …" section for the system prompt, or '' when there are no memories. */
export function memoryIndexText(): string {
  const files = listMemory();
  if (!files.length) return '';
  const lines = ['## Memory index (long-term memory about the user — search it before saying you don\'t know)'];
  for (const f of files) lines.push(`- ${f.name} — ${f.description || 'notes'} (${memoryFacts(f.body).length} facts)`);
  return lines.join('\n');
}

export const MEMORY_SYSTEM_PROMPT = `You have long-term memory in files (see the memory index).
- When the user asks about themselves, their life, work or preferences, or refers to something from before, use memory_search or memory_read first.
- When the user tells you a lasting fact about themselves (work, people, preferences, plans, how they like answers), save it with memory_save: one short fact, in the right file (about-me, preferences, work, projects, people, or a new subject). Don't ask first, and don't save passing chatter or things that will be out of date tomorrow.
- If something changed, fix the old fact with memory_forget then memory_save, or memory_rewrite the file. If asked to forget something, use memory_forget.
- Never save passwords, keys, card or bank numbers.`;

// MARK: Research reports

export function listReports(): ReportEntry[] {
  return listDir(paths.research).filter((f) => isMd(f) && f !== 'INDEX.md').flatMap((f) => {
    const file = path.join(paths.research, f);
    const text = readText(file);
    if (text === null) return [];
    const meta = frontmatter(text);
    const name = path.basename(f, path.extname(f));
    return [{ name, title: meta.title ?? name, description: meta.description ?? '', date: meta.date ?? '', body: stripFrontmatter(text), file }];
  }).sort((a, b) => cmp(b.date, a.date));
}

export function writeReportIndex(): void {
  try {
    const lines = ['# Research index', '', 'Reports Ingle has written after researching the web, newest first.', '',
      ...listReports().map((r) => `- ${r.date} · [${r.title}](${r.name}.md) — ${r.description}`)];
    writeAtomic(path.join(paths.research, 'INDEX.md'), lines.join('\n'));
  } catch { /* best effort */ }
}

export function reportSave(titleIn: string, summary: string, report: string, sources: string): string {
  const title = titleIn.trim();
  if (!title || !report.trim()) return 'A report needs a title and some content.';
  const day = today();
  const name = `${day}-${slug(title)}`;
  const oneLine = summary.split('\n').join(' ').replace(/^[ \t]+|[ \t]+$/g, '');
  let text = `---\ntitle: ${title.split('\n').join(' ')}\ndescription: ${oneLine}\ndate: ${day}\n---\n\n# ${title}\n\n${report.trim()}\n`;
  const src = sources.trim();
  if (src) text += `\n## Sources\n${src}\n`;
  try { writeAtomic(path.join(paths.research, `${name}.md`), text); } catch (e) { return `Couldn't save the report: ${(e as Error).message}`; }
  writeReportIndex();
  return `Saved research report “${title}” (${name}).`;
}

export function reportRead(name: string): string {
  const reports = listReports();
  const key = name.trim().toLowerCase();
  const r = reports.find((x) => x.name.toLowerCase() === key || x.title.toLowerCase() === key)
    ?? reports.find((x) => x.name.toLowerCase().includes(key) || x.title.toLowerCase().includes(key));
  if (!r || !key) return `There's no report called ${name}.`;
  return r.body.slice(0, 15_000);
}

export function reportSearch(query: string): string {
  const words = [...searchWords(query)];
  if (!words.length) return 'Give me a word or two to search for.';
  const scored = listReports().map((r) => {
    const hay = `${r.title} ${r.description} ${r.body}`.toLowerCase();
    return { r, score: words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return 'No saved research about that yet.';
  return scored.slice(0, 8).map(({ r }) => `- ${r.name}: ${r.title} — ${r.description} (${r.date})`).join('\n');
}

/** "## Research index …" section for the system prompt, or '' when there are no reports. */
export function reportIndexText(): string {
  const reports = listReports();
  if (!reports.length) return '';
  const lines = ['## Research index (earlier web research — check here before researching again; open with report_read)'];
  for (const r of reports.slice(0, 15)) lines.push(`- ${r.name} — ${r.description || r.title}`);
  if (reports.length > 15) lines.push(`- …and ${reports.length - 15} older reports (find them with report_search)`);
  return lines.join('\n');
}

// MARK: Index helpers for the engine (same wording as Manifest.swift)

/** "## Rules you always follow" + "## Rules index" sections ('' if no rules). */
export function rulesIndexText(workspaceRoot?: string): string {
  const rules = listRules(workspaceRoot);
  const always = rules.filter((r) => r.always), other = rules.filter((r) => !r.always);
  const parts: string[] = [];
  if (always.length) parts.push(['## Rules you always follow', ...always.map((r) => r.body)].join('\n'));
  if (other.length) parts.push(['## Rules index (load with use_rule when one applies)', ...other.map((r) => `- ${r.name}${r.description ? ` — ${r.description}` : ''}`)].join('\n'));
  return parts.join('\n\n');
}

/** "## Skills (load with use_skill)" section ('' if none). */
export function skillsIndexText(settings: IngleSettings): string {
  const skills = listSkills(settings);
  if (!skills.length) return '';
  return ['## Skills (load with use_skill)', ...skills.map((s) => {
    const d = s.description.length > 110 ? s.description.slice(0, 107) + '…' : s.description;
    return `- ${s.name}${d ? ` — ${d}` : ''}`;
  })].join('\n');
}

// MARK: Skill and rule builder (Knowledge.swift Builder)

export function skillFile(name: string): { slug: string; file: string } {
  const s = slug(name);
  return { slug: s, file: path.join(paths.skills, s, 'SKILL.md') };
}
export function skillText(name: string, description: string, instructions: string): string {
  return `---\nname: ${slug(name)}\ndescription: ${description.split('\n').join(' ')}\n---\n\n${instructions.trim()}\n`;
}
export function createSkill(name: string, description: string, instructions: string, replace: boolean): string {
  const { slug: s, file } = skillFile(name);
  if (fs.existsSync(file) && !replace) return `A skill called ${s} already exists. Call skill_create again with replace set to true to overwrite it.`;
  try { writeAtomic(file, skillText(name, description, instructions)); } catch (e) { return `Couldn't save the skill: ${(e as Error).message}`; }
  return `Created the skill ${s} at ${file}. It's now in the skills index.`;
}

export function ruleFile(name: string): { slug: string; file: string } {
  const s = slug(name);
  return { slug: s, file: path.join(paths.rules, `${s}.md`) };
}
export function ruleText(description: string, always: boolean, body: string): string {
  return `---\ndescription: ${description.split('\n').join(' ')}\nalways: ${always}\n---\n\n${body.trim()}\n`;
}
export function createRule(name: string, description: string, always: boolean, body: string, replace: boolean): string {
  const { slug: s, file } = ruleFile(name);
  if (fs.existsSync(file) && !replace) return `A rule called ${s} already exists. Call rule_create again with replace set to true to overwrite it.`;
  try { writeAtomic(file, ruleText(description, always, body)); } catch (e) { return `Couldn't save the rule: ${(e as Error).message}`; }
  return `Created the rule ${s} (${always ? 'always on' : 'used when relevant'}).`;
}

// MARK: MCP

export interface MCPServerConfig { name: string; command: string; args: string[]; env: Record<string, string>; source: string }

function readMcpMap(file: string): Record<string, unknown> {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: unknown };
    return obj.mcpServers && typeof obj.mcpServers === 'object' ? (obj.mcpServers as Record<string, unknown>) : {};
  } catch { return {}; }
}

/** ~/.ingle/mcp.json, then ~/.cursor/mcp.json and ~/.claude.json (read-only); Ingle's own file wins on a name clash. */
export function mcpServers(): MCPServerConfig[] {
  const sources: [string, string][] = [['Ingle', paths.mcp], ['Cursor', path.join(os.homedir(), '.cursor', 'mcp.json')], ['Claude Code', path.join(os.homedir(), '.claude.json')]];
  const out: MCPServerConfig[] = [];
  const seen = new Set<string>();
  for (const [label, file] of sources) {
    const map = readMcpMap(file);
    for (const name of Object.keys(map).sort(cmp)) {
      const s = map[name] as { command?: unknown; args?: unknown; env?: unknown } | null;
      if (!s || typeof s.command !== 'string' || seen.has(name)) continue;
      seen.add(name);
      out.push({
        name, command: s.command, source: label,
        args: Array.isArray(s.args) ? s.args.filter((x): x is string => typeof x === 'string') : [],
        env: s.env && typeof s.env === 'object' ? Object.fromEntries(Object.entries(s.env as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {},
      });
    }
  }
  return out;
}

/** Names of MCP servers in ~/.ingle/mcp.json (plus Cursor / Claude Code configs, as the Mac app does). Empty if none. */
export function mcpServerNames(): string[] { return mcpServers().map((s) => s.name); }

/** Text after the `<!-- Your notes:` marker in INGLE.md ('' if none). */
export function ingleNotes(): string {
  const text = readText(paths.manifest);
  if (!text) return '';
  const i = text.indexOf('<!-- Your notes:');
  if (i < 0) return '';
  const after = text.slice(i);
  const close = after.indexOf('-->');
  return (close >= 0 ? after.slice(close + 3) : '').trim();
}
