import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { capOutput, MAX_OUT } from '../src/tools/output';

test('capOutput leaves short output alone', () => {
  assert.equal(capOutput('hello', 10), 'hello');
  assert.equal(capOutput('x'.repeat(MAX_OUT)), 'x'.repeat(MAX_OUT));
});

test('capOutput keeps 40% of the start and 60% of the end', () => {
  const s = 'H'.repeat(500) + 'M'.repeat(1000) + 'T'.repeat(500);
  const out = capOutput(s, 100);
  const [head, tail] = out.split('\n…(trimmed)…\n');
  assert.equal(head, 'H'.repeat(40));
  assert.equal(tail, 'T'.repeat(60));
});

test('capOutput keeps the very last characters (errors are at the bottom)', () => {
  const s = 'a'.repeat(50_000) + 'error: build failed';
  const out = capOutput(s);
  assert.ok(out.endsWith('error: build failed'));
  assert.ok(out.length < s.length);
  assert.ok(out.length <= MAX_OUT + 20);
});
