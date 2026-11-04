import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { nearestLines, planEdit, type EditPlan } from '../src/tools/editmatch';

/** Apply a successful plan, or fail the test. */
function apply(text: string, plan: EditPlan): string {
  assert.ok(plan.ok, `expected a match, got ${JSON.stringify(plan)}`);
  return text.slice(0, plan.start) + plan.replacement + text.slice(plan.end);
}

test('exact single match is replaced and not marked tolerant', () => {
  const text = 'const a = 1;\nconst b = 2;\n';
  const plan = planEdit(text, 'const b = 2;', 'const b = 3;');
  assert.equal(apply(text, plan), 'const a = 1;\nconst b = 3;\n');
  assert.equal(plan.ok && plan.tolerant, false);
});

test('more than one exact match is refused with a count', () => {
  const plan = planEdit('x = 1\nx = 1\nx = 1\n', 'x = 1', 'x = 2');
  assert.deepEqual(plan, { ok: false, reason: 'many', count: 3 });
});

test('LF old_text matches a CRLF file, and new_text gets CRLF', () => {
  const text = 'one\r\ntwo\r\nthree\r\n';
  const plan = planEdit(text, 'one\ntwo', 'ONE\nTWO');
  assert.equal(apply(text, plan), 'ONE\r\nTWO\r\nthree\r\n');
  assert.equal(plan.ok && plan.tolerant, true);
});

test('trailing spaces in the file or old_text are ignored', () => {
  const text = 'function f() {   \n  return 1;\t\n}\n';
  const plan = planEdit(text, 'function f() {\n  return 1;\n}', 'function f() {\n  return 2;\n}');
  assert.equal(apply(text, plan), 'function f() {\n  return 2;\n}\n');
});

test('an exact substring wins, leaving trailing spaces after it', () => {
  const text = 'a\nlet x = 1;  \nb\n';
  assert.equal(apply(text, planEdit(text, 'let x = 1;', 'let x = 2;')), 'a\nlet x = 2;  \nb\n');
});

test('a single line with extra trailing spaces in old_text replaces the whole line', () => {
  const text = 'a\nlet x = 1;\nb\n';
  const plan = planEdit(text, 'let x = 1;   ', 'let x = 2;');
  assert.equal(apply(text, plan), 'a\nlet x = 2;\nb\n');
  assert.equal(plan.ok && plan.tolerant, true);
});

test('an old_text ending in a newline does not eat the next line', () => {
  const text = 'keep\nold line   \nnext\n';
  assert.equal(apply(text, planEdit(text, 'old line\n', 'new line\n')), 'keep\nnew line\nnext\n');
});

test('blank old_text is never matched tolerantly', () => {
  assert.deepEqual(planEdit('a\n\nb', '\n\n\n', 'x'), { ok: false, reason: 'none' });
});

test('no match returns the nearest lines, numbered', () => {
  const text = 'import x\nfunction greet(name) {\n  return name;\n}\n';
  const plan = planEdit(text, 'function greet(nme) {\n  return nme;\n}', '');
  assert.equal(plan.ok, false);
  assert.ok(!plan.ok && plan.reason === 'none');
  assert.match(!plan.ok && plan.nearest ? plan.nearest : '', /^\d+\tfunction greet\(name\) \{/m);
});

test('nearestLines gives nothing when no line is similar', () => {
  assert.equal(nearestLines('alpha\nbeta\ngamma', ['zzzzqqqq wwww']), '');
  assert.equal(nearestLines('alpha', ['  ']), '');
});
