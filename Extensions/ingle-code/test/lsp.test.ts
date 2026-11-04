// The exact path: real language servers. Each test skips (with a message) if its server isn't installed.
import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodeEngine } from '../src/index';
import { findTypescriptServer } from '../src/engine/pool';
import { copyFixture, cleanup, onPath } from './helpers';

after(cleanup);

const hasSourcekit = onPath('sourcekit-lsp');

test('swift via sourcekit-lsp: exact references, callers, callees, outline, diagnostics', { skip: hasSourcekit ? false : 'sourcekit-lsp is not installed (comes with Xcode or the Command Line Tools)', timeout: 240_000 }, async (t) => {
  const root = copyFixture('swift-shop');
  // Deliberately broken file for diagnostics.
  fs.writeFileSync(path.join(root, 'Sources', 'Shop', 'Broken.swift'), 'func broken() -> Int {\n    return "nope"\n}\n');
  const engine = new CodeEngine({ root, onlyLanguages: ['swift'] });
  t.after(() => engine.dispose());

  const refs = await engine.references('discount');
  assert.equal(refs.sources[0].exactness, 'exact', JSON.stringify(refs.sources));
  const exact = refs.items.filter((i) => i.exactness === 'exact').map((i) => `${i.file}:${i.line}`);
  assert.ok(exact.includes('Sources/Shop/Pricing.swift:3'), 'declaration');
  assert.ok(exact.includes('Sources/Shop/Cart.swift:21'), 'call in total()');
  const comment = refs.items.find((i) => i.line === 25 && i.file === 'Sources/Shop/Cart.swift');
  assert.ok(comment?.unconfirmed && comment.exactness === 'approximate', 'comment mention is text only');

  const callers = await engine.callers('discount', { depth: 2 });
  assert.ok(callers.items.some((c) => c.level === 1 && /\btotal\b/.test(c.name) && c.exactness === 'exact'));
  assert.ok(callers.items.some((c) => c.level === 2 && /\bcheckout\b/.test(c.name)));

  const callees = await engine.callees('Cart.total');
  assert.deepEqual(callees.items.map((c) => c.name.replace(/\(.*$/, '').split('.').pop()).sort(), ['discount', 'subtotal']);

  const outline = await engine.outline('Sources/Shop/Cart.swift');
  assert.equal(outline.source.exactness, 'exact');
  assert.ok(outline.items.some((s) => /^total\b/.test(s.name)));

  const diag = await engine.diagnostics(['Sources/Shop/Broken.swift', 'Sources/Shop/Cart.swift']);
  assert.equal(diag.sources[0].exactness, 'exact');
  assert.ok(diag.errors >= 1, JSON.stringify(diag));
  assert.ok(diag.items.every((d) => d.file === 'Sources/Shop/Broken.swift'), 'Cart.swift is clean');
  assert.equal(engine.runningServers(), 1);
  await engine.dispose();
  assert.equal(engine.runningServers(), 0);
});

test('an idle language server is stopped', { skip: hasSourcekit ? false : 'sourcekit-lsp is not installed', timeout: 60_000 }, async (t) => {
  const root = copyFixture('swift-shop');
  const engine = new CodeEngine({ root, onlyLanguages: ['swift'], idleMs: 1000 });
  t.after(() => engine.dispose());
  await engine.outline('Sources/Shop/Pricing.swift');
  assert.equal(engine.runningServers(), 1);
  const deadline = Date.now() + 15_000;
  while (engine.runningServers() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  assert.equal(engine.runningServers(), 0);
});

const tsServer = findTypescriptServer(process.cwd());

test('typescript via a language server: exact references, callers, diagnostics', { skip: tsServer ? false : 'no TypeScript language server (typescript-language-server with TypeScript ≤6, or TypeScript 7+ tsc/tsgo) on PATH', timeout: 120_000 }, async (t) => {
  const root = copyFixture('ts-shop', { git: true });
  fs.writeFileSync(path.join(root, 'src', 'broken.ts'), 'export const n: number = "text";\n');
  const engine = new CodeEngine({ root, onlyLanguages: ['typescript'] });
  t.after(() => engine.dispose());

  const refs = await engine.references('discount');
  assert.equal(refs.sources[0].exactness, 'exact', JSON.stringify(refs.sources));
  const exact = refs.items.filter((i) => i.exactness === 'exact').map((i) => `${i.file}:${i.line}`);
  for (const loc of ['src/pricing.ts:2', 'src/cart.ts:1', 'src/cart.ts:21', 'test/pricing.test.ts:3']) assert.ok(exact.includes(loc), loc);
  assert.ok(refs.items.some((i) => i.unconfirmed && i.inComment), 'comment mention is text only');

  const callers = await engine.callers('discount');
  assert.ok(callers.items.some((c) => c.name === 'total' && c.exactness === 'exact'));

  const diag = await engine.diagnostics(['src/broken.ts', 'src/cart.ts']);
  assert.ok(diag.errors >= 1, JSON.stringify(diag));
  assert.ok(diag.items.every((d) => d.file === 'src/broken.ts'));
});

test('a missing server falls back to approximate and says why', async (t) => {
  const root = copyFixture('swift-shop');
  const savedPath = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    const engine = new CodeEngine({ root });
    t.after(() => engine.dispose());
    const refs = await engine.references('discount');
    assert.equal(refs.sources[0].exactness, 'approximate');
    assert.match(refs.sources[0].reason ?? '', /no Swift language server installed/);
    assert.ok(refs.items.every((i) => i.exactness === 'approximate'));
    const status = await engine.status();
    assert.equal(status.languages.find((l) => l.language === 'swift')!.exactness, 'approximate');
  } finally {
    process.env.PATH = savedPath;
  }
});
