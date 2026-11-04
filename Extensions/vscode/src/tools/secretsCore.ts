// Secrets store — the pure parts (no vscode), shared by the engine, the webview checks and the tests.
// Mirrors Sources/Ingle/Secrets.swift: keep detection, placeholders, substitution and scrubbing in step.
//
// Values live only in the macOS Keychain (service "Ingle"). The model sees names and {{secret:name}} placeholders;
// a value is put into a tool's arguments only after the user approves that call, and tool output is scrubbed back
// to placeholders before the model or the chat history sees it.

/** Keychain service for every Ingle secret. */
export const SECRET_SERVICE = 'Ingle';

/** `{{secret:name}}` (spaces and case in the word "secret" tolerated). Group 1 is the name. */
export const PLACEHOLDER_SOURCE = String.raw`\{\{\s*[Ss][Ee][Cc][Rr][Ee][Tt]\s*:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s*\}\}`;

function placeholderRegex(): RegExp {
  return new RegExp(PLACEHOLDER_SOURCE, 'g');
}

export function placeholder(name: string): string {
  return `{{secret:${name}}}`;
}

/** Names are lower-case letters, digits, dots, dashes and underscores, starting with a letter or digit. */
export function isValidName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name);
}

/** "My GitHub Token" → "my-github-token". */
export function slugName(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-._]+|[-._]+$/g, '');
  return s.slice(0, 64) || 'secret';
}

/** A name not in `taken`: "github-token", then "github-token-2", … */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  const root = slugName(base);
  if (!used.has(root)) return root;
  for (let n = 2; ; n++) if (!used.has(`${root}-${n}`)) return `${root}-${n}`;
}

/** The environment variable a secret is passed in: github-token → INGLE_SECRET_GITHUB_TOKEN. */
export function envName(name: string): string {
  return 'INGLE_SECRET_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** Secret names used in a piece of text, lower-cased, first use first. */
export function namesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(placeholderRegex())) {
    const n = m[1].toLowerCase();
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Secret names used anywhere in a tool call's arguments (nested objects and arrays too). */
export function namesInArgs(args: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') { for (const n of namesIn(v)) if (!out.includes(n)) out.push(n); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(args);
  return out;
}

// MARK: detection (the composer's "Save as secret?" check)

export interface Detected {
  /** The value as typed. */
  value: string;
  /** Plain words for the card: "GitHub token". */
  kind: string;
  /** A suggested name: "github-token". */
  suggested: string;
  start: number;
  end: number;
}

interface Pattern { re: RegExp; kind: string; name: string }

/** Known key formats. Order matters: the more specific ones first. */
const KNOWN: Pattern[] = [
  { re: /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g, kind: 'private key', name: 'private-key' },
  { re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})/g, kind: 'GitHub token', name: 'github-token' },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, kind: 'Anthropic key', name: 'anthropic-key' },
  { re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, kind: 'API key', name: 'openai-key' },
  { re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, kind: 'Stripe key', name: 'stripe-key' },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, kind: 'AWS access key', name: 'aws-access-key' },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, kind: 'Slack token', name: 'slack-token' },
  { re: /\bAIza[0-9A-Za-z_-]{35}/g, kind: 'Google API key', name: 'google-api-key' },
];

/** "my password is …", "token: …", "api_key=…". Group 1 = "my" (optional), 2 = the keyword, 3 = the value. */
const PHRASE = /\b(my\s+(?:[a-z]+\s+)?)?(password|passcode|passphrase|passwd|pin|api[ _-]?key|secret[ _-]?key|secret|token|access[ _-]?key|private[ _-]?key)\b\s*(?:is|was|=|:)\s*:?\s*["'`]?([^\s"'`]+)/gi;

/** After "my password is", words that describe the password rather than being it. */
const NOT_VALUES = new Set([
  'wrong', 'expired', 'invalid', 'missing', 'incorrect', 'not', 'empty', 'set', 'unset', 'the', 'a', 'an', 'too', 'still', 'also',
  'being', 'correct', 'right', 'working', 'broken', 'fine', 'ok', 'okay', 'different', 'same', 'here', 'there', 'below',
  'above', 'in', 'on', 'saved', 'stored', 'changed', 'reset', 'gone', 'lost', 'required', 'needed', 'weak', 'strong',
  'short', 'long', 'secret', 'private', 'public', 'null', 'none', 'undefined', 'true', 'false', 'string', 'number',
  'blank', 'new', 'old', 'now', 'already', 'definitely', 'probably', 'just', 'very', 'really', 'something',
]);

function phraseValueLooksReal(value: string, strong: boolean): boolean {
  if (value.length < 4 || value.startsWith('{{')) return false;
  if (NOT_VALUES.has(value.toLowerCase())) return false;
  if (strong) return true;
  // Code, not a value: os.environ[…], getPassword(), this.token, ${VAR}, <placeholder>.
  if (/[()[\]{}<>]/.test(value) || value.startsWith('$') || /^[A-Za-z_$][\w$]*(\.[\w$]+)+$/.test(value)) return false;
  if (/[0-9!#$%&*+?^~@]/.test(value)) return true;
  return value.length >= 16 && !/^[A-Za-z_.-]+$/.test(value);
}

/** Luhn check for card numbers. */
export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

/** A long random-looking token (an unknown kind of key): 32+ characters, mixed case and digits, not hex, not a path. */
export function looksRandom(token: string): boolean {
  if (token.length < 32 || token.length > 512) return false;
  if (!/^[A-Za-z0-9+/_\-=.]+$/.test(token)) return false;
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/[0-9]/.test(token)) return false;
  if (/^[0-9a-fA-F-]+$/.test(token)) return false;
  if (token.includes('//') || (token.match(/\//g)?.length ?? 0) > 3 || (token.includes('/') && token.includes('.'))) return false;
  return entropy(token) >= 3.5;
}

/** Likely secrets in a message, in order, not overlapping each other or an existing placeholder. */
export function detectSecrets(text: string): Detected[] {
  const found: Detected[] = [];
  const taken: [number, number][] = [];
  for (const m of text.matchAll(placeholderRegex())) taken.push([m.index!, m.index! + m[0].length]);
  const free = (s: number, e: number) => !taken.some(([a, b]) => s < b && e > a);
  const add = (start: number, end: number, kind: string, name: string) => {
    if (end <= start || !free(start, end)) return;
    taken.push([start, end]);
    found.push({ value: text.slice(start, end), kind, suggested: name, start, end });
  };
  for (const p of KNOWN) {
    for (const m of text.matchAll(p.re)) add(m.index!, m.index! + m[0].length, p.kind, p.name);
  }
  for (const m of text.matchAll(PHRASE)) {
    let value = m[3];
    const start = m.index! + m[0].length - value.length;
    value = value.replace(/[.,;!?)\]}]+$/, '');
    if (!phraseValueLooksReal(value, !!m[1])) continue;
    const word = m[2].toLowerCase().replace(/[ _]/g, '-');
    const name = word === 'passwd' || word === 'passcode' || word === 'passphrase' ? 'password' : word;
    add(start, start + value.length, word.replace(/-/g, ' '), name);
  }
  for (const m of text.matchAll(/(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) add(m.index!, m.index! + m[0].length, 'card number', 'card-number');
  }
  for (const m of text.matchAll(/[^\s"'`,;()[\]{}<>=:]+/g)) {
    if (looksRandom(m[0])) add(m.index!, m.index! + m[0].length, 'key or token', 'api-token');
  }
  // The same value twice (e.g. pasted twice) is one secret.
  const seen = new Set<string>();
  return found.sort((a, b) => a.start - b.start).filter((f) => !seen.has(f.value) && !!seen.add(f.value));
}

/** Replaces each detected value (everywhere it appears) with its placeholder. `names` maps value → chosen name. */
export function replaceValues(text: string, names: Map<string, string>): string {
  let out = text;
  for (const [value, name] of [...names].sort((a, b) => b[0].length - a[0].length)) {
    if (value) out = out.split(value).join(placeholder(name));
  }
  return out;
}

// MARK: which tools may use a secret, and where it goes

export type SubstitutionMode = 'shell-env' | 'shell-literal' | 'applescript' | 'literal';

/** Tools that may carry a secret. Any other tool with a placeholder is refused (nothing runs). */
export const SECRET_TOOLS: Record<string, SubstitutionMode> = {
  run_command: 'shell-env',
  ssh_command: 'shell-literal',
  write_file: 'literal',
  edit_file: 'literal',
  open_url: 'literal',
  open: 'literal',
  applescript: 'applescript',
  mcp_call: 'literal',
};

export const SECRET_REFUSED = 'Secrets can only be used in run_command, ssh_command, write_file, edit_file, open_url and mcp_call. Nothing was run.';

export function unknownSecretMessage(names: string[]): string {
  return `There's no secret called ${names.join(', ')}. Use secret_list to see the names; the user can add one with /secret or in Settings → Secrets. Nothing was run.`;
}

export interface SecretUse {
  names: string[];
  /** Where the value goes, for the card: "a command on this Mac", "the MCP server github". */
  destination: string;
  /** Shown on the card when the value ends up on disk. */
  warning?: string;
}

/** What a call does with secrets, or undefined if it uses none. */
export function secretUse(toolName: string, args: Record<string, unknown>): SecretUse | undefined {
  const names = namesInArgs(args);
  if (!names.length) return undefined;
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string).trim() : '');
  let destination: string;
  let warning: string | undefined;
  switch (toolName) {
    case 'run_command': destination = 'a command on this Mac'; break;
    case 'ssh_command': destination = `a command on ${s('host') || 'a server'}`; break;
    case 'write_file':
    case 'edit_file':
      destination = `the file ${s('path')}`;
      warning = `This writes ${names.join(', ')} to disk in plain text.`;
      break;
    case 'open_url': destination = `the link ${s('url')}`; break;
    case 'open': destination = `opening ${s('target')}`; break;
    case 'applescript': destination = 'an AppleScript'; break;
    case 'mcp_call': destination = `the MCP server ${s('server')}`; break;
    default: destination = toolName.startsWith('mcp') ? `the MCP tool ${toolName}` : toolName;
  }
  return { names, destination, warning };
}

/** The card's line: "Uses secret: github-token → a command on this Mac". */
export function secretLine(use: SecretUse): string {
  return `Uses secret${use.names.length > 1 ? 's' : ''}: ${use.names.join(', ')} → ${use.destination}`;
}

// MARK: substitution (only after approval, at run time)

/** POSIX single-quoting. */
export function shQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/** Walks a shell command, calling `put(name, quoting)` for each placeholder with the quoting it sits in. */
function shellWalk(command: string, put: (name: string, quoting: 'none' | 'single' | 'double') => string): string {
  const re = new RegExp(PLACEHOLDER_SOURCE, 'y');
  let out = '';
  let state: 'none' | 'single' | 'double' = 'none';
  for (let i = 0; i < command.length;) {
    re.lastIndex = i;
    const m = re.exec(command);
    if (m) {
      out += put(m[1].toLowerCase(), state);
      i += m[0].length;
      continue;
    }
    const c = command[i];
    if (c === '\\' && state !== 'single' && i + 1 < command.length) { out += c + command[i + 1]; i += 2; continue; }
    if (c === "'" && state !== 'double') state = state === 'single' ? 'none' : 'single';
    else if (c === '"' && state !== 'single') state = state === 'double' ? 'none' : 'double';
    out += c;
    i++;
  }
  return out;
}

/** For run_command: each placeholder becomes an environment variable reference that works in the quoting it sits in,
 *  so the value never appears in the command line (or `ps`). Returns the command and the variables to set. */
export function substituteShellEnv(command: string, values: Record<string, string>): { command: string; env: Record<string, string> } {
  const env: Record<string, string> = {};
  const text = shellWalk(command, (name, quoting) => {
    if (!(name in values)) return placeholder(name);
    const v = envName(name);
    env[v] = values[name];
    if (quoting === 'single') return `'"\${${v}}"'`;
    if (quoting === 'double') return `\${${v}}`;
    return `"\${${v}}"`;
  });
  return { command: text, env };
}

/** For ssh_command (environment variables don't reach the server): the value, quoted for where it sits. */
export function substituteShellLiteral(command: string, values: Record<string, string>): string {
  return shellWalk(command, (name, quoting) => {
    if (!(name in values)) return placeholder(name);
    const v = values[name];
    if (quoting === 'single') return v.replace(/'/g, `'\\''`);
    if (quoting === 'double') return v.replace(/([\\"$`])/g, '\\$1');
    return shQuote(v);
  });
}

/** Plain text (file contents, links, MCP arguments): the value as it is. */
export function substituteLiteral(text: string, values: Record<string, string>, applescript = false): string {
  return text.replace(placeholderRegex(), (whole, n: string) => {
    const name = n.toLowerCase();
    if (!(name in values)) return whole;
    return applescript ? values[name].replace(/(["\\])/g, '\\$1') : values[name];
  });
}

/** The arguments with values put in. run_command gets environment variables instead (returned in `env`). */
export function substituteArgs(toolName: string, args: Record<string, unknown>, values: Record<string, string>): { args: Record<string, unknown>; env: Record<string, string> } {
  const mode = SECRET_TOOLS[toolName] ?? 'literal';
  let env: Record<string, string> = {};
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return substituteLiteral(v, values, mode === 'applescript');
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    // Only the top-level command of a shell tool is shell-quoted; everything else is plain text.
    if (k === 'command' && typeof v === 'string' && mode === 'shell-env') {
      const r = substituteShellEnv(v, values);
      env = { ...env, ...r.env };
      out[k] = r.command;
    } else if (k === 'command' && typeof v === 'string' && mode === 'shell-literal') {
      out[k] = substituteShellLiteral(v, values);
    } else {
      out[k] = walk(v);
    }
  }
  return { args: out, env };
}

// MARK: scrubbing (tool output → placeholders)

/** The forms a value may come back in: as typed, base64 (with and without padding), URL-encoded and JSON-escaped. */
export function variants(value: string): string[] {
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  const list = [value, b64, b64.replace(/=+$/, ''), encodeURIComponent(value), JSON.stringify(value).slice(1, -1)];
  return [...new Set(list)].filter((v) => v.length >= 4);
}

/** Every occurrence of a secret's value (and its base64 and other forms) becomes {{secret:name}}. Values shorter
 *  than 4 characters are left alone (they'd match ordinary text). */
export function scrub(text: string, secrets: { name: string; value: string }[]): string {
  if (!text) return text;
  const pairs: [string, string][] = [];
  for (const s of secrets) {
    if (!s.value || s.value.length < 4) continue;
    for (const v of variants(s.value)) pairs.push([v, placeholder(s.name)]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [v, p] of pairs) if (out.includes(v)) out = out.split(v).join(p);
  return out;
}

// MARK: ~/.ingle/secrets.json (names and descriptions only)

export interface SecretEntry { name: string; description: string; created?: string }

export function parseSecretsFile(text: string): SecretEntry[] {
  try {
    const raw = JSON.parse(text) as { secrets?: unknown };
    if (!Array.isArray(raw.secrets)) return [];
    return raw.secrets
      .filter((e): e is { name: string; description?: unknown; created?: unknown } => !!e && typeof (e as { name?: unknown }).name === 'string')
      .filter((e) => isValidName(e.name))
      .map((e) => ({ name: e.name, description: typeof e.description === 'string' ? e.description : '', created: typeof e.created === 'string' ? e.created : undefined }));
  } catch {
    return [];
  }
}

/** The prompt fact (same meaning as the Mac app's `Secrets.promptFact`). */
export function secretsFact(names: string[]): string {
  const list = names.length ? names.join(', ') : 'none yet (the user can add one with /secret or in Settings → Secrets)';
  return `Secrets: never ask the user to type a password or key in chat. Use secret_list and {{secret:name}} placeholders in tool arguments (e.g. in run_command); the user approves each use. You can't read secret values. Saved secrets: ${list}.`;
}
