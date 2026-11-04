// Task 39: the previewer's pure logic (kinds, ticking task boxes, local links, tool filtering).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { PREVIEW_WANTS, previewKind, resolveLocalLink, toggleTask } from '../src/tools/previewCore';
import { selectTools } from '../src/engine/toolSelection';

test('files map to the right preview kind', () => {
  assert.equal(previewKind('/a/plan.md'), 'markdown');
  assert.equal(previewKind('page.HTML'), 'html');
  assert.equal(previewKind('x.svg'), 'svg');
  assert.equal(previewKind('x.heic'), 'image');
  assert.equal(previewKind('x.pdf'), 'pdf');
  assert.equal(previewKind('x.csv'), 'csv');
  assert.equal(previewKind('x.tsv'), 'tsv');
  assert.equal(previewKind('x.json'), 'json');
  assert.equal(previewKind('x.yml'), 'yaml');
  assert.equal(previewKind('Makefile'), 'code');
  assert.equal(previewKind('main.swift'), 'code');
});

const PLAN = [
  '---', 'title: Demo', 'status: draft', '---', '', '# Demo', '', '## Steps', '',
  '- [ ] One', '- [x] Two', '', '```md', '- [ ] not a task (code)', '```', '', '1. [ ] Three', '  * [ ] nested four', '',
].join('\n');

test('toggleTask ticks the nth box, skipping front matter and code blocks', () => {
  const a = toggleTask(PLAN, 0, true)!;
  assert.match(a, /- \[x\] One/);
  const b = toggleTask(PLAN, 1, false)!;
  assert.match(b, /- \[ \] Two/);
  const c = toggleTask(PLAN, 2, true)!;
  assert.match(c, /1\. \[x\] Three/);
  assert.match(c, /- \[ \] not a task \(code\)/);
  const d = toggleTask(PLAN, 3, true)!;
  assert.match(d, /  \* \[x\] nested four/);
  assert.equal(toggleTask(PLAN, 4, true), undefined);
  // Nothing else changes.
  assert.equal(a.split('\n').length, PLAN.split('\n').length);
});

test('the Swift and TypeScript task toggles agree on the same file', () => {
  // PreviewTasks.toggle in PreviewTabs.swift uses this same pattern; keep them in step.
  const swift = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'Sources', 'Ingle', 'Preview', 'PreviewTabs.swift'), 'utf8');
  assert.ok(swift.includes('#"^\\s*(?:>\\s*)*(?:[-*+]|\\d+[.)])\\s+\\[[ xX]\\]"#'), 'Swift task pattern changed: update previewCore.ts too');
});

test('local links resolve against the file’s folder; web links do not', () => {
  assert.equal(resolveLocalLink('data.csv', '/p/docs'), '/p/docs/data.csv');
  assert.equal(resolveLocalLink('../README.md#intro', '/p/docs'), '/p/README.md');
  assert.equal(resolveLocalLink('my%20file.md', '/p'), '/p/my file.md');
  assert.equal(resolveLocalLink('/abs/x.md', '/p'), '/abs/x.md');
  assert.equal(resolveLocalLink('file:///abs/y.md', '/p'), '/abs/y.md');
  assert.equal(resolveLocalLink('https://example.com/x.md', '/p'), undefined);
  assert.equal(resolveLocalLink('mailto:a@b.c', '/p'), undefined);
  assert.equal(resolveLocalLink('#section', '/p'), undefined);
});

test('open_preview is offered when the user wants to see something', () => {
  for (const t of ['preview the plan', 'show me the page', 'make an svg diagram', 'write index.html', 'draw a mermaid chart']) {
    assert.ok(PREVIEW_WANTS.test(t), t);
  }
  assert.ok(!PREVIEW_WANTS.test('fix the failing test'));
  const tools = [{ name: 'read_file', readOnly: true }, { name: 'open_preview', readOnly: true }];
  const pick = (lastUser: string) => selectTools({ available: tools, lastUser, isSubAgent: false, active: [], mcpToolNames: [], mcpWanted: false }).map((t) => t.name);
  assert.deepEqual(pick('fix the failing test'), ['read_file']);
  assert.deepEqual(pick('Show me the README'), ['read_file', 'open_preview']);
});
