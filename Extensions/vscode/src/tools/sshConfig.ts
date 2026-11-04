// SSH helpers for ssh_command: ~/.ssh/config parsing, host checking, quoting, approval scope and tool wanting.
// Pure (no vscode import) so it can be tested. Keep in step with Sources/Ingle/SSH.swift.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const SSH_BINARY = '/usr/bin/ssh';
export const SSH_REFUSED = "That host isn't set up for Ingle. Add it in Settings → Mac Access → SSH (or the ingle.ssh.hosts setting in VS Code).";

export interface SSHSettings { enabled: boolean; hosts: string[] }

/** Host aliases we'll pass to ssh: no wildcards, no leading dash (it would be read as an option), no spaces or `@`. */
export function isPlainAlias(s: string): boolean {
  return /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(s);
}

/** Splits one config line into keyword and arguments (`Host a b`, `Host=a`, quoted values). */
function splitLine(line: string): { key: string; args: string[] } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const m = /^([A-Za-z]+)\s*(?:=\s*|\s+)(.*)$/.exec(trimmed);
  if (!m) return null;
  const args: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let t: RegExpExecArray | null;
  while ((t = re.exec(m[2]))) {
    if (t[2]?.startsWith('#')) break; // trailing comment
    args.push(t[1] ?? t[2]);
  }
  return { key: m[1].toLowerCase(), args };
}

/** The plain `Host` aliases in one config file's text, plus its `Include` patterns. Wildcard and negated patterns
 *  (`*`, `?`, `!`) are skipped; `Match` blocks are ignored. */
export function parseSSHConfig(text: string): { hosts: string[]; includes: string[] } {
  const hosts: string[] = [];
  const includes: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const l = splitLine(line);
    if (!l) continue;
    if (l.key === 'host') {
      for (const a of l.args) if (isPlainAlias(a) && !hosts.includes(a)) hosts.push(a);
    } else if (l.key === 'include') {
      includes.push(...l.args);
    }
  }
  return { hosts, includes };
}

/** Files an `Include` pattern names. Relative paths are under ~/.ssh; `*` and `?` work in the last part only. */
export function expandInclude(pattern: string, sshDir: string, home = os.homedir()): string[] {
  let p = pattern.startsWith('~/') ? path.join(home, pattern.slice(2)) : pattern;
  if (!path.isAbsolute(p)) p = path.join(sshDir, p);
  const dir = path.dirname(p), base = path.basename(p);
  if (/[*?[]/.test(dir)) return []; // wildcards in folder names: not supported
  if (!/[*?]/.test(base)) return [p];
  const re = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  try {
    return fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Every plain host alias in ~/.ssh/config, following `Include` (up to 5 levels). Never throws. */
export function configHosts(file = path.join(os.homedir(), '.ssh', 'config'), depth = 0, seen = new Set<string>()): string[] {
  if (depth > 5 || seen.has(file)) return [];
  seen.add(file);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const { hosts, includes } = parseSSHConfig(text);
  const sshDir = path.join(os.homedir(), '.ssh');
  for (const inc of includes) {
    for (const f of expandInclude(inc, sshDir)) {
      for (const h of configHosts(f, depth + 1, seen)) if (!hosts.includes(h)) hosts.push(h);
    }
  }
  return hosts;
}

/** The mirror from ~/.ingle/settings.json, with VS Code's ingle.ssh.* settings winning where the user set them. */
export function mergeSSH(mirror: Partial<SSHSettings> | undefined, override: Partial<SSHSettings>): SSHSettings {
  const enabled = override.enabled ?? (mirror?.enabled === true);
  const raw = override.hosts ?? (Array.isArray(mirror?.hosts) ? mirror!.hosts : []);
  return { enabled, hosts: raw.filter((h): h is string => typeof h === 'string' && h.trim() !== '').map((h) => h.trim()) };
}

/** Hosts the model may use: switched on in Ingle **and** a plain `Host` in ~/.ssh/config. Empty when SSH is off. */
export function usableHosts(ssh: SSHSettings, inConfig: string[]): string[] {
  if (!ssh.enabled) return [];
  const on = new Set(ssh.hosts.map((h) => h.toLowerCase()));
  return inConfig.filter((h) => on.has(h.toLowerCase()));
}

/** The config's spelling of the requested host if it's usable, else null (raw `user@ip`, unknown, unticked). */
export function allowedHost(requested: string, usable: string[]): string | null {
  const want = requested.trim().toLowerCase();
  if (!want || !isPlainAlias(want)) return null;
  return usable.find((h) => h.toLowerCase() === want) ?? null;
}

/** Single-quotes a string for a POSIX shell. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The command the remote shell runs: `cd <cwd> && <command>`, with cwd quoted (a leading `~` still expands). */
export function remoteCommand(command: string, cwd?: string): string {
  const dir = (cwd ?? '').trim();
  if (!dir) return command;
  let quoted: string;
  if (dir === '~') quoted = '~';
  else if (dir.startsWith('~/')) quoted = '~/' + shQuote(dir.slice(2));
  else quoted = shQuote(dir);
  return `cd ${quoted} && ${command}`;
}

/** Arguments for /usr/bin/ssh (no local shell involved). Keys or ssh-agent only; unknown host keys fail. */
export function sshArgs(alias: string, command: string, cwd?: string): string[] {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes', '-T', alias, '--', remoteCommand(command, cwd)];
}

/** A hint added to ssh's own error output, so the user knows what to fix. */
export function sshHint(output: string, alias: string): string {
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/i.test(output)) {
    return `The host key for ${alias} isn't known or has changed. Connect once in Terminal (ssh ${alias}) to check and save it, then try again.`;
  }
  if (/Permission denied \(|Too many authentication failures/i.test(output)) {
    return `${alias} didn't accept a key. Ingle only uses SSH keys or ssh-agent and never types passwords. Check the key with ssh ${alias} in Terminal.`;
  }
  if (/Could not resolve hostname|Connection timed out|Connection refused|No route to host|Operation timed out/i.test(output)) {
    return `Couldn't reach ${alias}. Check it's switched on and on the network.`;
  }
  return '';
}

/** What "Allow for this session" covers: the same host, folder and exact command. */
export function sshScope(host: string, command: string, cwd: string): { key: string; label: string } {
  const clip = (t: string) => { const f = t.replace(/\n/g, ' '); return f.length > 80 ? f.slice(0, 79) + '…' : f; };
  const h = host.trim().toLowerCase(), c = command.trim(), d = cwd.trim();
  return { key: `ssh\n${h}\n${d}\n${c}`, label: `“${clip(c)}” on ${host.trim()}` + (d ? ` in ${d}` : '') };
}

/** Whether a message makes ssh_command worth offering: ssh, server, remote, or an enabled host's name. */
export function wantsSSH(message: string, hosts: string[]): boolean {
  if (!hosts.length) return false;
  const t = message.toLowerCase();
  if (/\bssh\b|server|remote/.test(t)) return true;
  return hosts.some((h) => new RegExp(`(^|[^a-z0-9_.-])${h.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_-])`).test(t));
}
