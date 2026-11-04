// The approximate path: no language servers. Every result must say "approximate".
import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodeEngine, callTool } from '../src/index';
import { copyFixture, cleanup } from './helpers';

after(cleanup);

for (const fx of [
  { name: 'swift-shop', git: false, pricing: 'Sources/Shop/Pricing.swift', cart: 'Sources/Shop/Cart.swift', test: 'Tests/ShopTests/CartTests.swift', lang: 'swift' },
  { name: 'ts-shop', git: true, pricing: 'src/pricing.ts', cart: 'src/cart.ts', test: 'test/cart.test.ts', lang: 'typescript' },
]) {
  test(`${fx.name}: scan fallback is complete and labelled approximate`, async (t) => {
    const root = copyFixture(fx.name, { git: fx.git });
    const engine = new CodeEngine({ root, noServers: true });
    t.after(() => engine.dispose());

    const refs = await engine.references('discount');
    assert.equal(refs.exactCount, 0);
    assert.ok(refs.items.every((i) => i.exactness === 'approximate'));
    assert.deepEqual(refs.definitions.map((d) => d.file), [fx.pricing]);
    assert.ok(refs.items.some((i) => i.file === fx.cart && i.text.includes('discount(') && !i.inComment), 'the call in total()');
    assert.ok(refs.items.some((i) => i.file === fx.cart && i.inComment), 'the comment mention is flagged');
    assert.equal(refs.sources[0].exactness, 'approximate');
    assert.match(refs.sources[0].reason ?? '', /turned off/);

    const outline = await engine.outline(fx.cart);
    assert.equal(outline.source.exactness, 'approximate');
    const total = outline.items.find((s) => s.name === 'total');
    assert.ok(total && total.container === 'Cart' && total.endLine > total.startLine);

    const callers = await engine.callers('discount');
    assert.ok(callers.items.some((c) => /total$/.test(c.name) && c.file === fx.cart && c.exactness === 'approximate'));
    assert.ok(!callers.items.some((c) => c.callLines.includes(25)), 'the comment on line 25 is not a call');

    const deep = await engine.callers('discount', { depth: 2 });
    assert.ok(deep.items.some((c) => c.level === 2 && c.name.endsWith('checkout')), 'checkout calls total which calls discount');

    const callees = await engine.callees('Cart.total');
    assert.deepEqual(callees.items.map((c) => c.name).sort(), ['discount', 'subtotal']);

    const def = await engine.definition('Cart.total');
    assert.equal(def.total, 1);
    assert.equal(def.items[0].file, fx.cart);

    const impact = await engine.impact('discount');
    const tests = impact.tests.map((x) => x.file);
    assert.ok(tests.includes(fx.test), `impact lists ${fx.test}`);
    assert.ok(impact.tests.find((x) => x.file === fx.test)!.reasons.length > 0);

    const diag = await engine.diagnostics([fx.cart]);
    assert.equal(diag.checked.length, 0);
    assert.match(diag.skipped[0].reason, /turned off/);
  });
}

test('position targets and paging', async (t) => {
  const root = copyFixture('ts-shop', { git: true });
  const engine = new CodeEngine({ root, noServers: true, pageSize: 2 });
  t.after(() => engine.dispose());
  const byPos = await engine.references('src/cart.ts:21:18');
  assert.ok(byPos.total >= 5);
  assert.equal(byPos.items.length, 2);
  assert.equal(byPos.pages, Math.ceil(byPos.total / 2));
  const p2 = await engine.references('discount', { page: 2 });
  assert.equal(p2.from, 3);
  const out = await callTool(engine, 'references', { symbol: 'discount' });
  assert.match(out.text, /for more, call again with page: 2/);
  assert.match(out.text, /approx/);
});

test('diagnostics with no paths uses changed files; outside paths are refused', async (t) => {
  const root = copyFixture('ts-shop', { git: true });
  fs.writeFileSync(path.join(root, 'src', 'new.ts'), 'export const x: number = 1;\n');
  const engine = new CodeEngine({ root, noServers: true });
  t.after(() => engine.dispose());
  const d = await engine.diagnostics();
  assert.equal(d.scope, 'files changed since the last commit');
  assert.deepEqual(d.skipped.map((s) => s.file), ['src/new.ts']);
  const bad = await callTool(engine, 'outline', { file: '../../etc/passwd' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /outside the workspace/);
});

test('code_status reports approximate when servers are off', async (t) => {
  const root = copyFixture('swift-shop');
  const engine = new CodeEngine({ root, noServers: true, ollamaHost: 'http://127.0.0.1:9' });
  t.after(() => engine.dispose());
  const s = await engine.status();
  const sw = s.languages.find((l) => l.language === 'swift')!;
  assert.equal(sw.exactness, 'approximate');
  assert.equal(sw.files, 4);
  assert.equal(s.ollama.reachable, false);
});

test('impact keeps comment-only mentions apart from real uses', async (t) => {
  const root = copyFixture('ts-shop', { git: true });
  fs.writeFileSync(path.join(root, 'src', 'notes.ts'), '// discount() is applied at checkout\nexport const note = "see discount";\n');
  const engine = new CodeEngine({ root, noServers: true });
  t.after(() => engine.dispose());
  const r = await engine.impact('discount');
  assert.deepEqual(r.references.mentionedOnly, ['src/notes.ts']);
  assert.ok(!r.references.files.some((f) => f.file === 'src/notes.ts'));
  assert.ok(!r.untested.includes('src/notes.ts'));
  const callers = await engine.callers('discount');
  assert.ok(!callers.items.some((c) => c.file === 'src/notes.ts'), 'a call written in a comment is not a caller');
});
