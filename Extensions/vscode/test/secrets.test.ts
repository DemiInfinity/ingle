import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  detectSecrets, envName, isValidName, luhn, looksRandom, namesIn, namesInArgs, parseSecretsFile, placeholder, replaceValues,
  scrub, secretLine, secretsFact, secretUse, slugName, substituteArgs, substituteLiteral, substituteShellEnv,
  substituteShellLiteral, uniqueName, SECRET_TOOLS,
} from '../src/tools/secretsCore';
import { secretApprovalRequest } from '../src/tools/secretsApproval';

// Obvious fakes only.
const GH = 'ghp_' + 'TESTTESTTESTTESTTESTTESTTESTTESTTEST';
const AWS = 'AKIA' + 'TESTTESTTESTTEST';

// MARK: detection

test('detects a GitHub token and suggests a name', () => {
  const text = `my GitHub token is ${GH} thanks`;
  const found = detectSecrets(text);
  assert.equal(found.length, 1);
  assert.equal(found[0].value, GH);
  assert.equal(found[0].suggested, 'github-token');
  assert.equal(text.slice(found[0].start, found[0].end), GH);
});

test('detects known key formats', () => {
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAfake\n-----END OPENSSH PRIVATE KEY-----';
  const cases: [string, string][] = [
    [AWS, 'aws-access-key'],
    ['sk-ant-' + 'TESTtest1234567890TESTtest', 'anthropic-key'],
    ['sk-' + 'TESTtest1234567890TESTtest', 'openai-key'],
    ['xoxb-' + '1234567890-TESTTEST', 'slack-token'],
    ['AIza' + 'TESTTESTTESTTESTTESTTESTTESTTESTTES', 'google-api-key'],
    [pem, 'private-key'],
  ];
  for (const [value, name] of cases) {
    const found = detectSecrets(`here: ${value} ok`);
    assert.equal(found.length, 1, value);
    assert.equal(found[0].value, value);
    assert.equal(found[0].suggested, name);
  }
});

test('phrases: "my password is" catches anything; "password:" needs a value that looks real', () => {
  assert.equal(detectSecrets('my password is hunter2.')[0]?.value, 'hunter2');
  assert.equal(detectSecrets('my wifi password is correcthorsebattery')[0]?.value, 'correcthorsebattery');
  assert.equal(detectSecrets('password: S3cret!pass')[0]?.value, 'S3cret!pass');
  assert.equal(detectSecrets('api_key="abc123xyz"')[0]?.suggested, 'api-key');
  // Talking about passwords, or code, is not a secret.
  assert.equal(detectSecrets('my password is wrong, can you help?').length, 0);
  assert.equal(detectSecrets('the token is expired').length, 0);
  assert.equal(detectSecrets('password: string;').length, 0);
  assert.equal(detectSecrets('const token = getToken();').length, 0);
  assert.equal(detectSecrets('password = os.environ["DB_PASSWORD"]').length, 0);
  assert.equal(detectSecrets('token = this.token').length, 0);
  assert.equal(detectSecrets('token: ${{ secrets.GITHUB_TOKEN }}').length, 0);
});

test('card numbers need a valid Luhn check', () => {
  assert.ok(luhn('4111111111111111'));
  assert.ok(!luhn('4111111111111112'));
  assert.equal(detectSecrets('card 4111 1111 1111 1111 please')[0]?.suggested, 'card-number');
  assert.equal(detectSecrets('order 4111 1111 1111 1112').length, 0);
});

test('long random strings, but not hashes, UUIDs or paths', () => {
  assert.ok(looksRandom('Zk8pQ2xLmN4vR7tY1wB5cD9fG3hJ6kS0aE2uI8oP'));
  assert.ok(!looksRandom('3f786850e387550fdab836ed7e6dc881de23001b'));            // git SHA
  assert.ok(!looksRandom('123e4567-e89b-12d3-a456-426614174000'));               // UUID
  assert.ok(!looksRandom('src/components/Button/ButtonGroup2Something.tsx'));    // path
  assert.ok(!looksRandom('ThisIsAVeryLongIdentifierName1'));                     // too short
  assert.equal(detectSecrets('key Zk8pQ2xLmN4vR7tY1wB5cD9fG3hJ6kS0aE2uI8oP end')[0]?.suggested, 'api-token');
  assert.equal(detectSecrets('commit 3f786850e387550fdab836ed7e6dc881de23001b').length, 0);
});

test('existing placeholders are never detected again', () => {
  assert.equal(detectSecrets('my password is {{secret:password}}').length, 0);
  assert.equal(detectSecrets('use {{secret:github-token}} please').length, 0);
});

test('replaceValues swaps every copy of the value for the placeholder', () => {
  const text = `token ${GH} and again ${GH}`;
  const out = replaceValues(text, new Map([[GH, 'github-token']]));
  assert.equal(out, 'token {{secret:github-token}} and again {{secret:github-token}}');
  assert.ok(!out.includes(GH));
});

// MARK: names and placeholders

test('names, slugs and environment variables', () => {
  assert.ok(isValidName('github-token'));
  assert.ok(!isValidName('GitHub'));
  assert.ok(!isValidName('-x'));
  assert.equal(slugName('My GitHub Token!'), 'my-github-token');
  assert.equal(uniqueName('github-token', ['github-token', 'github-token-2']), 'github-token-3');
  assert.equal(envName('github-token'), 'INGLE_SECRET_GITHUB_TOKEN');
  assert.deepEqual(namesIn('a {{secret:one}} b {{ Secret: Two }} {{secret:one}}'), ['one', 'two']);
  assert.deepEqual(namesInArgs({ server: 'x', arguments: { headers: ['Bearer {{secret:api}}'] } }), ['api']);
  assert.equal(placeholder('x'), '{{secret:x}}');
});

// MARK: substitution

test('run_command: placeholders become environment variables in every kind of quoting', () => {
  const values = { 'github-token': GH };
  const plain = substituteShellEnv('gh auth login --with-token <<< {{secret:github-token}}', values);
  assert.equal(plain.command, 'gh auth login --with-token <<< "${INGLE_SECRET_GITHUB_TOKEN}"');
  assert.deepEqual(plain.env, { INGLE_SECRET_GITHUB_TOKEN: GH });
  assert.ok(!plain.command.includes(GH));
  assert.equal(substituteShellEnv(`curl -H 'Authorization: Bearer {{secret:github-token}}' x`, values).command,
    `curl -H 'Authorization: Bearer '"\${INGLE_SECRET_GITHUB_TOKEN}"'' x`);
  assert.equal(substituteShellEnv('echo "token={{secret:github-token}}"', values).command, 'echo "token=${INGLE_SECRET_GITHUB_TOKEN}"');
  // An unknown name is left as it is.
  assert.equal(substituteShellEnv('echo {{secret:other}}', values).command, 'echo {{secret:other}}');
});

test('run_command substitution really works in zsh (value passed only in the environment)', { skip: process.platform !== 'darwin' && process.platform !== 'linux' }, () => {
  const value = `it's a "test" $HOME \`x\``;
  for (const cmd of ['printf %s {{secret:t}}', `printf %s '{{secret:t}}'`, 'printf %s "{{secret:t}}"']) {
    const r = substituteShellEnv(cmd, { t: value });
    const sh = process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
    const out = execFileSync(sh, ['-c', r.command], { env: { ...process.env, ...r.env } }).toString();
    assert.equal(out, value, cmd);
  }
});

test('ssh_command: the value is quoted for where it sits', () => {
  const value = `a'b"c$d`;
  for (const cmd of ['printf %s {{secret:t}}', `printf %s '{{secret:t}}'`, 'printf %s "{{secret:t}}"']) {
    const remote = substituteShellLiteral(cmd, { t: value });
    const out = execFileSync('/bin/sh', ['-c', remote]).toString();
    assert.equal(out, value, cmd);
  }
});

test('other tools get the plain value; AppleScript strings are escaped', () => {
  assert.equal(substituteLiteral('KEY={{secret:k}}\n', { k: 'v@l' }), 'KEY=v@l\n');
  assert.equal(substituteLiteral('"{{secret:k}}"', { k: 'a"b' }, true), '"a\\"b"');
  const mcp = substituteArgs('mcp_call', { server: 's', tool: 't', arguments: { command: 'x {{secret:k}}', h: ['{{secret:k}}'] } }, { k: 'VALUE' });
  assert.deepEqual(mcp.args, { server: 's', tool: 't', arguments: { command: 'x VALUE', h: ['VALUE'] } });
  const run = substituteArgs('run_command', { command: 'echo {{secret:k}}', cwd: '.' }, { k: 'VALUE' });
  assert.equal(run.args.command, 'echo "${INGLE_SECRET_K}"');
  assert.deepEqual(run.env, { INGLE_SECRET_K: 'VALUE' });
});

// MARK: scrubbing

test('scrub replaces the value, its base64 and other encodings', () => {
  const secrets = [{ name: 'github-token', value: GH }];
  const b64 = Buffer.from(GH).toString('base64');
  const out = scrub(`token=${GH}\nbasic ${b64}\nurl ${encodeURIComponent(GH)}`, secrets);
  assert.ok(!out.includes(GH) && !out.includes(b64));
  assert.equal(out.split('{{secret:github-token}}').length - 1, 3);
  const quoted = scrub(JSON.stringify({ p: 'pa"ss\\word' }), [{ name: 'pw', value: 'pa"ss\\word' }]);
  assert.equal(quoted, '{"p":"{{secret:pw}}"}');
  // Very short values are left alone.
  assert.equal(scrub('abc abc', [{ name: 'x', value: 'abc' }]), 'abc abc');
});

// MARK: approvals

test('secretUse says which secrets, where they go, and warns about files', () => {
  const run = secretUse('run_command', { command: 'gh auth login --with-token <<< {{secret:github-token}}' })!;
  assert.deepEqual(run.names, ['github-token']);
  assert.equal(secretLine(run), 'Uses secret: github-token → a command on this Mac');
  assert.equal(secretUse('ssh_command', { host: 'homelab', command: 'echo {{secret:a}}' })!.destination, 'a command on homelab');
  const write = secretUse('write_file', { path: '.env', content: 'TOKEN={{secret:github-token}}' })!;
  assert.equal(write.warning, 'This writes github-token to disk in plain text.');
  assert.equal(secretUse('run_command', { command: 'ls' }), undefined);
  assert.ok(!('web_fetch' in SECRET_TOOLS) && !('memory_save' in SECRET_TOOLS));
});

test('a secret approval never offers "Allow for this session"', () => {
  const use = secretUse('run_command', { command: 'echo {{secret:t}}' })!;
  const req = secretApprovalRequest({ title: 'Run a command', detail: 'echo {{secret:t}}' }, 'run_command', use);
  assert.equal(req.sessionScope, undefined);
  assert.equal(req.noSession, true);
  assert.deepEqual(req.secrets, ['t']);
  assert.equal(req.secretLine, 'Uses secret: t → a command on this Mac');
  assert.equal(req.kind, 'command');
});

// MARK: the names file and the prompt

test('secrets.json holds names and descriptions only', () => {
  const list = parseSecretsFile(JSON.stringify({ secrets: [{ name: 'github-token', description: 'CLI login' }, { name: 'BAD NAME' }, { value: 'x' }] }));
  assert.deepEqual(list, [{ name: 'github-token', description: 'CLI login', created: undefined }]);
  assert.deepEqual(parseSecretsFile('not json'), []);
  assert.match(secretsFact(['github-token']), /Saved secrets: github-token\./);
  assert.match(secretsFact([]), /none yet/);
});

// Bug fixed with this task: memory's filter only knew words like "password", so a bare key was saved.
test('memory refuses a bare API key and points at the secrets store', async () => {
  const { looksSecret } = await import('../src/tools/frontmatter');
  const { MEMORY_NOT_SAVED } = await import('../src/tools/stores');
  assert.equal(looksSecret(`use ${GH} for the CLI`), true);
  assert.equal(looksSecret(`aws ${AWS}`), true);
  assert.equal(looksSecret('likes tea, not coffee'), false);
  assert.match(MEMORY_NOT_SAVED, /secrets store/);
});
