import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { frontmatter, looksSecret, searchWords, slug, stripFrontmatter, today, writeAtomic } from '../src/tools/frontmatter';

test('frontmatter reads key: value pairs between --- lines', () => {
  const meta = frontmatter('---\nname: figma\ndescription: Use Figma\n---\nBody text');
  assert.deepEqual(meta, { name: 'figma', description: 'Use Figma' });
});

test('frontmatter strips double quotes and surrounding spaces, keeps colons in values', () => {
  const meta = frontmatter('---\n  title :  "Hello: world"  \nurl: https://x.test/a\n---\n');
  assert.equal(meta.title, 'Hello: world');
  assert.equal(meta.url, 'https://x.test/a');
});

test('frontmatter tolerates CRLF line endings', () => {
  assert.deepEqual(frontmatter('---\r\nwhen: always\r\n---\r\nbody'), { when: 'always' });
});

test('frontmatter needs --- on the first line', () => {
  assert.deepEqual(frontmatter('name: x\n---\n'), {});
  assert.deepEqual(frontmatter(''), {});
});

test('frontmatter skips lines without a colon or a key', () => {
  assert.deepEqual(frontmatter('---\njust words\n: no key\nok: yes\n---'), { ok: 'yes' });
});

test('stripFrontmatter returns the trimmed body', () => {
  assert.equal(stripFrontmatter('---\na: b\n---\n\n  Body here  \n'), 'Body here');
  assert.equal(stripFrontmatter('  No frontmatter  '), 'No frontmatter');
});

test('stripFrontmatter keeps text when the block is never closed', () => {
  assert.equal(stripFrontmatter('---\na: b\nstill going'), '---\na: b\nstill going');
});

test('slug makes lowercase dash-separated names', () => {
  assert.equal(slug('About Me'), 'about-me');
  assert.equal(slug('  Notes.md '), 'notes');
  assert.equal(slug('Figma / Components!!'), 'figma-components');
  assert.equal(slug('Café Ünïcode'), 'café-ünïcode');
});

test('slug falls back to "notes" and caps at 60 characters', () => {
  assert.equal(slug('!!!'), 'notes');
  assert.equal(slug('a'.repeat(100)).length, 60);
});

test('looksSecret catches passwords, keys and card numbers', () => {
  assert.equal(looksSecret('My password is hunter2'), true);
  assert.equal(looksSecret('the API key is abc'), true);
  assert.equal(looksSecret('card 4111 1111 1111 1111'), true);
  assert.equal(looksSecret('card 4111-1111-1111-1111'), true);
  assert.equal(looksSecret('I prefer tabs over spaces'), false);
  assert.equal(looksSecret('call me on 0123 456 789'), false);
});

test('searchWords keeps lowercased words longer than two letters', () => {
  assert.deepEqual([...searchWords('Fix the UI in Rust, ok?')].sort(), ['fix', 'rust', 'the']);
});

test('today formats a local date as yyyy-mm-dd', () => {
  assert.equal(today(new Date(2026, 0, 5)), '2026-01-05');
});

test('writeAtomic creates folders and leaves no temp file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingle-fm-'));
  try {
    const file = path.join(dir, 'a', 'b', 'note.md');
    writeAtomic(file, 'hello');
    assert.equal(fs.readFileSync(file, 'utf8'), 'hello');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['note.md']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
