import { test, beforeEach, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A temp folder as HOME, so ~/.ingle/checkpoints is a throwaway one.
const realHome = process.env.HOME;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingle-cp-'));
process.env.HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

import {
  changes, checkpointsRoot, discardChat, finish, FILE_CHANGING_TOOLS, isUndone, prune, restore, snapshot, summary,
} from '../src/tools/checkpoints';
import { FILE_CHANGING_TOOLS as FROM_COMMANDS } from '../src/tools/commands';

const proj = path.join(tmp, 'proj');
const p = (name: string) => path.join(proj, name);
const read = (name: string) => fs.readFileSync(p(name), 'utf8');
const write = (name: string, text: string) => { fs.mkdirSync(path.dirname(p(name)), { recursive: true }); fs.writeFileSync(p(name), text); };
let n = 0;
let ref = { chat: 'chat-1', run: 'run-0' };

beforeEach(() => {
  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(checkpointsRoot(), { recursive: true, force: true });
  write('a.txt', 'A1');
  write('b.txt', 'B1');
  write('c.txt', 'C1');
  ref = { chat: 'chat-1', run: `run-${++n}` };
});

after(() => {
  process.env.HOME = realHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A tool writing a file: snapshot first, then write. */
function toolWrite(name: string, text: string) {
  assert.equal(snapshot(p(name), ref), null);
  write(name, text);
}

test('the checkpoint lives under ~/.ingle/checkpoints (HOME)', () => {
  assert.equal(checkpointsRoot(), path.join(process.env.HOME!, '.ingle', 'checkpoints'));
});

test('one list of file-changing tools', () => {
  assert.equal(FROM_COMMANDS, FILE_CHANGING_TOOLS);
  assert.deepEqual([...FILE_CHANGING_TOOLS].sort(), ['edit_file', 'write_file']);
});

test('no run: snapshot does nothing', () => {
  assert.equal(snapshot(p('a.txt'), undefined), null);
  assert.equal(fs.existsSync(checkpointsRoot()), false);
});

test('snapshots each file once per run (the first original wins)', () => {
  toolWrite('a.txt', 'A2');
  toolWrite('a.txt', 'A3');
  const s = finish(ref);
  assert.deepEqual(s, [{ path: p('a.txt'), action: 'restore' }]);
  assert.deepEqual(changes(ref), [{ path: p('a.txt'), before: 'A1', after: 'A3' }]);
  const blobs = fs.readdirSync(path.join(checkpointsRoot(), 'chat-1', ref.run, 'files')).sort();
  assert.deepEqual(blobs, ['0.after', '0.before']);
});

test('a run that edits three files and creates one is fully undone', () => {
  toolWrite('a.txt', 'A2');
  toolWrite('b.txt', 'B2');
  toolWrite('c.txt', 'C2');
  toolWrite('new/deep/d.txt', 'D');
  const s = finish(ref)!;
  assert.equal(s.length, 4);
  assert.deepEqual(s.find((f) => f.path === p('new/deep/d.txt')), { path: p('new/deep/d.txt'), action: 'remove' });
  const r = restore(ref);
  assert.equal(r.ok, true);
  assert.equal(read('a.txt'), 'A1');
  assert.equal(read('b.txt'), 'B1');
  assert.equal(read('c.txt'), 'C1');
  assert.equal(fs.existsSync(p('new/deep/d.txt')), false);
  assert.equal(fs.existsSync(p('new')), false, 'folders the run created are removed again');
  assert.equal(isUndone(ref), true);
  assert.equal(restore(ref).ok, false, 'can only be undone once');
});

test('created file: before is null; undo keeps a folder that already existed', () => {
  fs.mkdirSync(p('src'));
  toolWrite('src/e.txt', 'E');
  finish(ref);
  assert.deepEqual(changes(ref), [{ path: p('src/e.txt'), before: null, after: 'E' }]);
  assert.equal(restore(ref).ok, true);
  assert.equal(fs.existsSync(p('src/e.txt')), false);
  assert.equal(fs.existsSync(p('src')), true);
});

test('deleted file: recorded with its content and brought back', () => {
  snapshot(p('b.txt'), ref);
  fs.rmSync(p('b.txt'));
  assert.deepEqual(finish(ref), [{ path: p('b.txt'), action: 'recreate' }]);
  assert.deepEqual(changes(ref), [{ path: p('b.txt'), before: 'B1', after: null }]);
  assert.equal(restore(ref).ok, true);
  assert.equal(read('b.txt'), 'B1');
});

test('refuses when a file changed after the run, unless forced', () => {
  toolWrite('a.txt', 'A2');
  toolWrite('b.txt', 'B2');
  finish(ref);
  write('a.txt', 'A-later');
  const r = restore(ref);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual(r.changedLater, [p('a.txt')]);
    assert.match(r.message, /changed since the run/);
  }
  assert.equal(read('a.txt'), 'A-later', 'nothing touched on refusal');
  assert.equal(read('b.txt'), 'B2');
  const forced = restore(ref, true);
  assert.equal(forced.ok, true);
  assert.equal(read('a.txt'), 'A1');
  assert.equal(read('b.txt'), 'B1');
});

test('a created file that was later deleted counts as changed later', () => {
  toolWrite('f.txt', 'F');
  finish(ref);
  fs.rmSync(p('f.txt'));
  const r = restore(ref);
  assert.equal(r.ok, false);
});

test('a run that ends with every file as it was leaves no checkpoint', () => {
  toolWrite('a.txt', 'A2');
  write('a.txt', 'A1');
  assert.equal(finish(ref), null);
  assert.deepEqual(summary(ref), []);
  assert.equal(fs.existsSync(path.join(checkpointsRoot(), 'chat-1', ref.run)), false);
});

test('binary files round-trip exactly', () => {
  const bytes = Buffer.from([0, 1, 2, 255, 0, 10, 13]);
  fs.writeFileSync(p('bin.dat'), bytes);
  snapshot(p('bin.dat'), ref);
  fs.writeFileSync(p('bin.dat'), 'text now');
  finish(ref);
  assert.equal(restore(ref).ok, true);
  assert.deepEqual(fs.readFileSync(p('bin.dat')), bytes);
});

test('chat and run ids cannot escape the checkpoints folder', () => {
  const evil = { chat: '../../etc', run: '../x' };
  snapshot(p('a.txt'), evil);
  const dirs = fs.readdirSync(checkpointsRoot());
  assert.equal(dirs.length, 1);
  assert.ok(!dirs[0].includes('/'));
  assert.ok(fs.existsSync(path.join(checkpointsRoot(), dirs[0])));
});

test('discardChat removes a chat’s checkpoints', () => {
  toolWrite('a.txt', 'A2');
  finish(ref);
  discardChat('chat-1');
  assert.equal(fs.existsSync(path.join(checkpointsRoot(), 'chat-1')), false);
});

function setCreated(r: { chat: string; run: string }, created: number) {
  const file = path.join(checkpointsRoot(), r.chat, r.run, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  m.created = created;
  fs.writeFileSync(file, JSON.stringify(m));
}

test('prunes checkpoints older than 14 days', () => {
  const now = Date.now();
  const old = { chat: 'chat-2', run: 'old' };
  snapshot(p('a.txt'), old); write('a.txt', 'A-old'); finish(old);
  setCreated(old, now - 15 * 86_400_000);
  toolWrite('b.txt', 'B2'); finish(ref);
  assert.equal(prune(now), 1);
  assert.equal(fs.existsSync(path.join(checkpointsRoot(), 'chat-2')), false, 'empty chat folder removed');
  assert.ok(summary(ref).length === 1);
});

test('prunes the oldest first above the size limit', () => {
  const now = Date.now();
  write('big.txt', 'x'.repeat(1000));
  const runs = [1, 2, 3].map((i) => ({ chat: 'chat-3', run: `r${i}` }));
  runs.forEach((r, i) => {
    snapshot(p('big.txt'), r);
    write('big.txt', 'y'.repeat(1000 + i));
    finish(r);
    setCreated(r, now - (10 - i) * 60_000);
  });
  // Allow a byte less than all three take, so only the oldest goes.
  const du = (d: string): number => fs.readdirSync(d, { withFileTypes: true })
    .reduce((s, e) => s + (e.isDirectory() ? du(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
  assert.equal(prune(now, 14, du(checkpointsRoot()) - 1), 1);
  assert.equal(summary(runs[0]).length, 0);
  assert.equal(summary(runs[1]).length, 1);
  assert.equal(summary(runs[2]).length, 1);
});

test('a run still in progress is not pruned for size', () => {
  const now = Date.now();
  snapshot(p('a.txt'), ref);       // not finished
  assert.equal(prune(now, 14, 0), 0);
  assert.ok(fs.existsSync(path.join(checkpointsRoot(), 'chat-1', ref.run, 'manifest.json')));
});
