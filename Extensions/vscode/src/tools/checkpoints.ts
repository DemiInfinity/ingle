// Checkpoints: undo a whole run. Before a run first changes a file, its original is copied to
// ~/.ingle/checkpoints/<chat>/<run>/ (a file that didn't exist is recorded as "didn't exist"). When the run ends,
// the files' new state is recorded too, so Undo can refuse if a file changed again after the run.
// Pure Node (no vscode), so it is tested directly. Keep in step with Sources/Ingle/Checkpoints.swift (same folder format).
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Every tool that changes a local file, in one place. Each of them calls `snapshot()` before writing.
 *  (The Mac's list is Checkpoints.fileChangingTools.) */
export const FILE_CHANGING_TOOLS = ['edit_file', 'write_file'];

/** Shown in the Undo preview. */
export const NOT_COVERED = 'Changes made by commands, or on other computers over SSH, can’t be undone here.';

export const MAX_AGE_DAYS = 14;
export const MAX_BYTES = 500 * 1024 * 1024;

/** Which run a change belongs to: the chat and one id per reply-to-a-message. */
export interface RunRef { chat: string; run: string }

/** One changed file, for the preview and for task 32's changes panel. null = the file didn't exist (before) or
 *  doesn't exist now (after). Binary files come back as text too, so only use before/after for display. */
export interface Change { path: string; before: string | null; after: string | null }

/** What Undo would do to a file: put the original back, remove a file the run created, or bring back one it deleted. */
export type UndoAction = 'restore' | 'remove' | 'recreate';
export interface FileSummary { path: string; action: UndoAction }

export type RestoreResult =
  | { ok: true; restored: string[]; message: string }
  | { ok: false; changedLater: string[]; message: string };

interface State { exists: boolean; blob?: string; hash?: string }
interface Entry {
  path: string;
  before: State;
  /** For a file that didn't exist: the highest folder the run had to create for it (removed again on undo if empty). */
  createdDir?: string;
  after?: State;
}
interface Manifest {
  version: 1;
  chat: string;
  run: string;
  created: number;
  finished?: number;
  undone?: number;
  files: Entry[];
}

export function checkpointsRoot(): string {
  return path.join(os.homedir(), '.ingle', 'checkpoints');
}

const safe = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_') || '_';
function runDir(ref: RunRef): string { return path.join(checkpointsRoot(), safe(ref.chat), safe(ref.run)); }
function manifestFile(ref: RunRef): string { return path.join(runDir(ref), 'manifest.json'); }

function readManifest(ref: RunRef): Manifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile(ref), 'utf8')) as Manifest;
    return m && Array.isArray(m.files) ? m : null;
  } catch {
    return null;
  }
}

function writeManifest(ref: RunRef, m: Manifest): void {
  fs.mkdirSync(runDir(ref), { recursive: true });
  const file = manifestFile(ref);
  fs.writeFileSync(file + '.tmp', JSON.stringify(m, null, 1));
  fs.renameSync(file + '.tmp', file);
}

function hash(buf: Buffer): string { return crypto.createHash('sha256').update(buf).digest('hex'); }

/** A regular file's bytes, or null if there's no file there. Throws for folders and unreadable files. */
function readBytes(abs: string): Buffer | null {
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { return null; }
  if (!st.isFile()) throw new Error(`${abs} isn't a regular file`);
  return fs.readFileSync(abs);
}

/** Saves `buf` into the run's folder and describes it. */
function capture(ref: RunRef, buf: Buffer | null, name: string): State {
  if (!buf) return { exists: false };
  fs.mkdirSync(path.join(runDir(ref), 'files'), { recursive: true });
  fs.writeFileSync(path.join(runDir(ref), 'files', name), buf);
  return { exists: true, blob: name, hash: hash(buf) };
}

function load(ref: RunRef, s: State): Buffer | null {
  if (!s.exists || !s.blob) return null;
  return fs.readFileSync(path.join(runDir(ref), 'files', s.blob));
}

function sameAs(abs: string, s: State): boolean {
  let now: Buffer | null;
  try { now = readBytes(abs); } catch { return false; }
  if (!now) return !s.exists;
  return s.exists && hash(now) === s.hash;
}

/** Records a file's original before a run first changes it. Call it from every file-changing tool, after approval
 *  and just before writing, with the absolute path. Only the first call per file per run copies anything.
 *  `current` is the file's text when the editor holds unsaved changes (that's what the tool changes, so that's the
 *  original); otherwise the file is read from disk.
 *  Returns an error sentence if the copy failed (the tool may still go ahead), or null. */
export function snapshot(abs: string, ref: RunRef | undefined, current?: string): string | null {
  if (!ref) return null;
  try {
    const full = path.resolve(abs);
    const m: Manifest = readManifest(ref) ?? { version: 1, chat: ref.chat, run: ref.run, created: Date.now(), files: [] };
    if (m.files.some((f) => f.path === full)) return null;
    const i = m.files.length;
    const original = current !== undefined ? Buffer.from(current, 'utf8') : readBytes(full);
    const entry: Entry = { path: full, before: capture(ref, original, `${i}.before`) };
    if (!entry.before.exists) {
      // The highest folder that doesn't exist yet: write_file will create it, so undo removes it again (if empty).
      let dir = path.dirname(full);
      let top: string | undefined;
      while (!fs.existsSync(dir)) {
        top = dir;
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
      }
      if (top) entry.createdDir = top;
    }
    m.files.push(entry);
    writeManifest(ref, m);
    return null;
  } catch (e) {
    return `Couldn't save a checkpoint of ${abs}, so this change can't be undone with Undo this run: ${(e as Error).message}`;
  }
}

/** Ends a run: records each file's state now, so a later change can be detected. Returns what Undo would do,
 *  or null if the run changed nothing (no checkpoint, or every file ended up as it was — then it's deleted). */
export function finish(ref: RunRef): FileSummary[] | null {
  const m = readManifest(ref);
  if (!m) return null;
  try {
    m.files.forEach((f, i) => {
      let now: Buffer | null = null;
      try { now = readBytes(f.path); } catch { /* a folder now: treat as gone */ }
      f.after = capture(ref, now, `${i}.after`);
    });
    m.finished = Date.now();
    writeManifest(ref, m);
  } catch { /* keep what we have */ }
  maybePrune();
  const s = summarise(m);
  if (!s.length) { discard(ref); return null; }
  return s;
}

function summarise(m: Manifest): FileSummary[] {
  const out: FileSummary[] = [];
  for (const f of m.files) {
    const after = f.after;
    if (after && after.exists === f.before.exists && after.hash === f.before.hash) continue;   // ended as it was
    const action: UndoAction = !f.before.exists ? 'remove' : after && !after.exists ? 'recreate' : 'restore';
    out.push({ path: f.path, action });
  }
  return out;
}

/** What Undo would do for a run (empty if there's no checkpoint). */
export function summary(ref: RunRef): FileSummary[] {
  const m = readManifest(ref);
  return m ? summarise(m) : [];
}

/** The run's changed files with their text before and after (for the changes panel). If the run hasn't
 *  finished, "after" is the file as it is now. */
export function changes(ref: RunRef): Change[] {
  const m = readManifest(ref);
  if (!m) return [];
  const text = (b: Buffer | null) => (b ? b.toString('utf8') : null);
  const out: Change[] = [];
  for (const f of m.files) {
    let after: string | null = null;
    try {
      if (f.after) after = text(load(ref, f.after));
      else after = text(readBytes(f.path));
    } catch { after = null; }
    let before: string | null = null;
    try { before = text(load(ref, f.before)); } catch { before = null; }
    if (before === after && f.before.exists === (after !== null)) continue;
    out.push({ path: f.path, before, after });
  }
  return out;
}

/** True once the run has been undone. */
export function isUndone(ref: RunRef): boolean { return !!readManifest(ref)?.undone; }

/** Undoes a run: puts originals back, removes files it created, brings back files it deleted. Refuses if a file
 *  changed again after the run (unless `force`), and lists those files. */
export function restore(ref: RunRef, force = false): RestoreResult {
  const m = readManifest(ref);
  if (!m) return { ok: false, changedLater: [], message: 'There is no checkpoint for this run any more (checkpoints are kept for 14 days).' };
  if (m.undone) return { ok: false, changedLater: [], message: 'This run has already been undone.' };
  const files = m.files.filter((f) => !(f.after && f.after.exists === f.before.exists && f.after.hash === f.before.hash));
  const changedLater = files.filter((f) => f.after && !sameAs(f.path, f.after)).map((f) => f.path);
  if (changedLater.length && !force) {
    return {
      ok: false, changedLater,
      message: `${changedLater.length === 1 ? 'This file has' : 'These files have'} changed since the run, so undoing would lose those changes:\n` +
        changedLater.map((p) => '• ' + p).join('\n'),
    };
  }
  const done: string[] = [];
  const failed: string[] = [];
  for (const f of files) {
    try {
      const original = load(ref, f.before);
      if (original) {
        fs.mkdirSync(path.dirname(f.path), { recursive: true });
        fs.writeFileSync(f.path, original);
      } else {
        fs.rmSync(f.path, { force: true });
        removeEmptyDirs(path.dirname(f.path), f.createdDir);
      }
      done.push(f.path);
    } catch (e) {
      failed.push(`${f.path} (${(e as Error).message})`);
    }
  }
  m.undone = Date.now();
  try { writeManifest(ref, m); } catch { /* the files are back; the flag is a nicety */ }
  const n = done.length;
  let message = `Undid the run: ${n} file${n === 1 ? '' : 's'} put back.`;
  if (failed.length) message += `\nCouldn't put back:\n` + failed.map((p) => '• ' + p).join('\n');
  return { ok: true, restored: done, message };
}

/** Removes `dir` and its parents while they're empty, stopping after `top` (the folder the run created). */
function removeEmptyDirs(dir: string, top: string | undefined): void {
  if (!top) return;
  let d = dir;
  while (d === top || d.startsWith(top + path.sep)) {
    try { fs.rmdirSync(d); } catch { return; }
    if (d === top) return;
    d = path.dirname(d);
  }
}

/** Deletes one run's checkpoint. */
export function discard(ref: RunRef): void {
  try { fs.rmSync(runDir(ref), { recursive: true, force: true }); } catch { /* gone */ }
  try { fs.rmdirSync(path.dirname(runDir(ref))); } catch { /* not empty */ }
}

/** Deletes every checkpoint of a chat (when the chat is deleted). */
export function discardChat(chat: string): void {
  try { fs.rmSync(path.join(checkpointsRoot(), safe(chat)), { recursive: true, force: true }); } catch { /* gone */ }
}

function sizeOf(p: string): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) total += sizeOf(full);
      else { try { total += fs.statSync(full).size; } catch { /* gone */ } }
    }
  } catch { /* gone */ }
  return total;
}

/** Deletes checkpoints older than 14 days, then the oldest ones while all of them take more than 500 MB.
 *  Returns how many runs were deleted. */
export function prune(now = Date.now(), maxAgeDays = MAX_AGE_DAYS, maxBytes = MAX_BYTES): number {
  const root = checkpointsRoot();
  const runs: { dir: string; created: number; size: number; live: boolean }[] = [];
  let chats: string[] = [];
  try { chats = fs.readdirSync(root); } catch { return 0; }
  for (const c of chats) {
    const cdir = path.join(root, c);
    let names: string[] = [];
    try { if (!fs.statSync(cdir).isDirectory()) continue; names = fs.readdirSync(cdir); } catch { continue; }
    for (const r of names) {
      const dir = path.join(cdir, r);
      let created = 0;
      let finished: number | undefined;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
        created = m.created;
        finished = m.finished;
      } catch { /* use the folder's time */ }
      if (!created) { try { created = fs.statSync(dir).mtimeMs; } catch { continue; } }
      // A run still going (not finished, under a day old) is never pruned for size.
      runs.push({ dir, created, size: sizeOf(dir), live: !finished && now - created < 86_400_000 });
    }
  }
  runs.sort((a, b) => a.created - b.created);
  let total = runs.reduce((s, r) => s + r.size, 0);
  let removed = 0;
  const cutoff = now - maxAgeDays * 86_400_000;
  for (const r of runs) {
    if (r.created >= cutoff && total <= maxBytes) break;
    if (r.live && r.created >= cutoff) continue;
    try { fs.rmSync(r.dir, { recursive: true, force: true }); } catch { continue; }
    total -= r.size;
    removed++;
  }
  for (const c of chats) { try { fs.rmdirSync(path.join(root, c)); } catch { /* not empty */ } }
  return removed;
}

let lastPrune = 0;
/** Prunes at most once an hour. */
export function maybePrune(): void {
  const now = Date.now();
  if (now - lastPrune < 3_600_000) return;
  lastPrune = now;
  try { prune(now); } catch { /* next time */ }
}
