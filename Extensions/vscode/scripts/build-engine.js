#!/usr/bin/env node
// Compiles the ingle-code engine (../ingle-code/src) into vendor/ingle-code with this extension's own TypeScript,
// so the extension imports it directly (no MCP hop) and the .vsix carries it with no runtime npm deps.
// Runs before compile and test, and after npm install. vendor/ is build output (git-ignored).
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const here = path.resolve(__dirname, '..');
const src = path.resolve(here, '../ingle-code');
const out = path.join(here, 'vendor/ingle-code');
const tsc = path.join(here, 'node_modules/typescript/bin/tsc');

if (!fs.existsSync(path.join(src, 'src/index.ts'))) {
  console.error(`ingle-code isn't at ${src}; code intelligence can't be bundled.`);
  process.exit(1);
}
if (!fs.existsSync(tsc)) {
  console.error('TypeScript is missing: run npm install in Extensions/vscode first.');
  process.exit(1);
}
fs.rmSync(out, { recursive: true, force: true });
execFileSync(process.execPath, [tsc, '-p', path.join(src, 'tsconfig.json'), '--outDir', out, '--typeRoots', path.join(here, 'node_modules/@types')], { stdio: 'inherit' });
// Its licence and contract travel with it.
for (const f of ['TOOLS.md']) fs.copyFileSync(path.join(src, f), path.join(out, f));
