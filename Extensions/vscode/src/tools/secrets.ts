// Secrets store, VS Code side: secret_list, and getting values only when a use has been approved.
// Values come from the Mac app over the editor bridge (it asks for Touch ID or shows its own dialog); if the app
// isn't running, from /usr/bin/security, which shows macOS's own Keychain prompt. Values are never cached or saved
// here: they live for one tool call. Mirrors Sources/Ingle/Secrets.swift.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { paths } from '../shared/settings';
import { isValidName, parseSecretsFile, SECRET_SERVICE, type SecretEntry } from './secretsCore';
import type { ToolDef } from './types';

export const SECRETS_FILE = path.join(paths.home, 'secrets.json');
const BRIDGE_PORT = 47123;

/** Names and descriptions from ~/.ingle/secrets.json (never values). */
export function listSecrets(): SecretEntry[] {
  try { return parseSecretsFile(fs.readFileSync(SECRETS_FILE, 'utf8')); } catch { return []; }
}

function writeIndex(list: SecretEntry[]) {
  fs.mkdirSync(paths.home, { recursive: true });
  const tmp = SECRETS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ secrets: list }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, SECRETS_FILE);
}

function bridgeToken(): string | undefined {
  try { return fs.readFileSync(paths.bridgeToken, 'utf8').trim() || undefined; } catch { return undefined; }
}

function bridgePort(): number {
  try { return vscode.workspace.getConfiguration('ingle').get<number>('port', BRIDGE_PORT); } catch { return BRIDGE_PORT; }
}

type BridgeResult = { ok: true; body: Record<string, unknown> } | { ok: false; reachable: boolean; error: string };

/** POST to the Mac app's bridge. `reachable` is false when the app isn't running (so a fallback can be used). */
async function bridge(route: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<BridgeResult> {
  const token = bridgeToken();
  if (!token) return { ok: false, reachable: false, error: 'no bridge token' };
  // One signal for Stop and the time limit (AbortSignal.any needs a newer Node than VS Code 1.85 has).
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${bridgePort()}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingle-Token': token }, body: JSON.stringify(body), signal: ctl.signal,
    });
  } catch (e) {
    if (signal?.aborted) return { ok: false, reachable: true, error: 'Stopped.' };
    if (timedOut) return { ok: false, reachable: true, error: 'The Ingle app didn’t answer in time.' };
    return { ok: false, reachable: false, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  let json: Record<string, unknown> = {};
  try { json = (await res.json()) as Record<string, unknown>; } catch { /* empty body */ }
  if (res.status === 404) return { ok: false, reachable: false, error: 'This Ingle app is too old for secrets.' };
  if (!res.ok) return { ok: false, reachable: true, error: typeof json.error === 'string' ? json.error : `The Ingle app said no (${res.status}).` };
  return { ok: true, body: json };
}

/** Runs /usr/bin/security; resolves stdout, or undefined if it failed or was cancelled. stdin is optional. */
function security(args: string[], stdin?: string, signal?: AbortSignal): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    let out = '', err = '';
    const child = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const onAbort = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); resolve({ code: null, out: '', err: e.message }); });
    child.on('close', (code) => { signal?.removeEventListener('abort', onAbort); resolve({ code, out, err }); });
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
  });
}

/** Values for an approved use. The Mac app confirms (Touch ID or a dialog); without it, macOS asks for each one. */
export async function secretValues(names: string[], purpose: string, detail: string, signal: AbortSignal): Promise<{ values: Record<string, string> } | { error: string }> {
  const r = await bridge('/secret/use', { names, purpose, detail, editor: 'VS Code' }, 180_000, signal);
  if (r.ok) {
    const v = r.body.values;
    if (!v || typeof v !== 'object') return { error: 'The Ingle app sent back no values.' };
    const values: Record<string, string> = {};
    for (const n of names) {
      const x = (v as Record<string, unknown>)[n];
      if (typeof x !== 'string') return { error: `The Ingle app has no secret called ${n}.` };
      values[n] = x;
    }
    return { values };
  }
  if (r.reachable) return { error: r.error };
  if (process.platform !== 'darwin') return { error: 'Secrets need the macOS Keychain.' };
  // The Mac app isn't running: macOS shows its own Keychain prompt for each value.
  const values: Record<string, string> = {};
  for (const n of names) {
    if (!isValidName(n)) return { error: `${n} isn't a valid secret name.` };
    const res = await security(['find-generic-password', '-s', SECRET_SERVICE, '-a', n, '-w'], undefined, signal);
    if (res.code !== 0) {
      return { error: /could not be found/i.test(res.err) ? `There's no secret called ${n} in the Keychain.` : `macOS didn't hand over ${n} (cancelled or denied).` };
    }
    values[n] = res.out.replace(/\n$/, '');
  }
  return { values };
}

/** Asks the Mac app to scrub text with every saved secret (no values leave the app). Undefined if it isn't running. */
export async function scrubViaApp(text: string, signal?: AbortSignal): Promise<string | undefined> {
  if (!text || !listSecrets().length) return undefined;
  const r = await bridge('/secret/scrub', { text }, 5000, signal);
  return r.ok && typeof r.body.text === 'string' ? r.body.text : undefined;
}

/** Saves a new secret: through the Mac app, or straight into the Keychain with /usr/bin/security. Returns an error
 *  sentence, or undefined when saved. Never overwrites an existing secret. */
export async function saveSecret(name: string, description: string, value: string): Promise<string | undefined> {
  if (!isValidName(name)) return `“${name}” can't be a secret name: use lower-case letters, digits and dashes.`;
  if (!value) return 'There’s no value to save.';
  if (listSecrets().some((s) => s.name === name)) return `There's already a secret called ${name}. Pick another name.`;
  const r = await bridge('/secret/save', { name, description, value }, 30_000);
  if (r.ok) return undefined;
  if (r.reachable) return r.error;
  if (process.platform !== 'darwin') return 'Secrets need the macOS Keychain.';
  if (/[\r\n]/.test(value)) return 'Open the Ingle app to save a value with line breaks (like a private key).';
  // security -i reads one command per line from stdin, so the value never appears in `ps`.
  const q = (s: string) => '"' + s.replace(/[\\"]/g, '\\$&') + '"';
  const trusted = ['/usr/bin/security', '/Applications/Ingle.app'].filter((p) => fs.existsSync(p)).flatMap((p) => ['-T', q(p)]);
  const line = ['add-generic-password', '-s', q(SECRET_SERVICE), '-a', q(name), '-l', q(`Ingle: ${name}`),
    '-j', q(description.replace(/[\r\n]+/g, ' ')), ...trusted, '-w', q(value)].join(' ');
  const res = await security(['-i'], line + '\n');
  if (res.code !== 0 || /error|failed/i.test(res.err)) return `Couldn't save to the Keychain: ${res.err.trim() || 'unknown error'}`;
  try {
    writeIndex([...listSecrets(), { name, description, created: new Date().toISOString() }]);
  } catch (e) {
    return `Saved in the Keychain, but couldn't update ${SECRETS_FILE}: ${(e as Error).message}`;
  }
  return undefined;
}

const secretList: ToolDef = {
  name: 'secret_list',
  description: "List the user's saved secrets (names and descriptions only — you can never read values). Use one as {{secret:name}} in a tool argument; the user approves each use.",
  parameters: { type: 'object', properties: {}, required: [] },
  readOnly: true,
  available: () => listSecrets().length > 0,
  describe: () => ({ title: 'List saved secrets', detail: 'names only', icon: 'key' }),
  async run() {
    const list = listSecrets();
    if (!list.length) return 'No secrets saved yet. The user can add one with /secret or in the Ingle app (Settings → Secrets).';
    return list.map((s) => `- ${s.name}${s.description ? ' — ' + s.description : ''} (use {{secret:${s.name}}})`).join('\n');
  },
};

export const secretTools: ToolDef[] = [secretList];
