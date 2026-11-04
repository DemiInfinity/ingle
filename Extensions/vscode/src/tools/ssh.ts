// ssh_command: run a command on one of the user's own SSH hosts. Off by default. Hosts come from the user (a plain
// `Host` in ~/.ssh/config that is also switched on in Ingle), never from the model. Mirrors the Mac app's SSH.swift.
import * as os from 'os';
import * as vscode from 'vscode';
import type { IngleSettings } from '../shared/settings';
import { runProcess } from './command';
import { DENIED } from './paths';
import { SSH_BINARY, SSH_REFUSED, allowedHost, configHosts, mergeSSH, sshArgs, sshHint, usableHosts, type SSHSettings } from './sshConfig';
import { str, type ToolDef } from './types';

/** SSH settings: ~/.ingle/settings.json `ssh`, overridden by ingle.ssh.enabled / ingle.ssh.hosts where the user set them
 *  (in user settings; null means unset). */
export function sshSettings(settings: IngleSettings): SSHSettings {
  const override: Partial<SSHSettings> = {};
  try {
    const cfg = vscode.workspace.getConfiguration('ingle');
    // User settings only: a project's .vscode/settings.json must never switch SSH on or add hosts.
    const set = <T>(key: string): T | undefined => cfg.inspect<T>(key)?.globalValue ?? undefined;
    const enabled = set<boolean>('ssh.enabled');
    const hosts = set<string[]>('ssh.hosts');
    if (typeof enabled === 'boolean') override.enabled = enabled;
    if (Array.isArray(hosts)) override.hosts = hosts;
  } catch { /* no VS Code config: mirror only */ }
  return mergeSSH(settings.ssh, override);
}

/** Host names the model may use right now (empty when SSH is off or nothing is ticked). */
export function enabledSSHHosts(settings: IngleSettings): string[] {
  const ssh = sshSettings(settings);
  return ssh.enabled ? usableHosts(ssh, configHosts()) : [];
}

const sshCommand: ToolDef = {
  name: 'ssh_command',
  description: "Run a shell command on one of the user's SSH hosts and return its output. The user must approve.",
  parameters: {
    type: 'object',
    properties: {
      host: { type: 'string', description: 'One of the SSH host names listed in your instructions' },
      command: { type: 'string', description: 'The command to run on that host' },
      cwd: { type: 'string', description: 'Optional folder on that host to run it in' },
    },
    required: ['host', 'command'],
  },
  readOnly: false,
  available: (ctx) => !ctx.isSubAgent && enabledSSHHosts(ctx.settings).length > 0,
  describe: (a) => {
    const cwd = str(a, 'cwd').trim();
    const command = str(a, 'command');
    return { title: `Run a command on ${str(a, 'host').trim() || 'a server'}`, detail: cwd ? `cd ${cwd} && ${command}` : command, icon: 'remote' };
  },
  async run(a, ctx) {
    const command = str(a, 'command');
    if (!command.trim()) return 'Give me a command to run.';
    const ssh = sshSettings(ctx.settings);
    if (!ssh.enabled) return "SSH is off. The user can turn it on in Settings → Mac Access → SSH (or the ingle.ssh.enabled setting in VS Code).";
    const alias = allowedHost(str(a, 'host'), usableHosts(ssh, configHosts()));
    if (!alias) return SSH_REFUSED;
    const cwd = str(a, 'cwd').trim();
    const answer = await ctx.requestApproval({
      kind: 'ssh', title: `Wants to run a command on ${alias}`,
      detail: cwd ? `cd ${cwd} && ${command}` : command,
    });
    if (answer !== 'allow') return DENIED;
    ctx.setActivity(`Running a command on ${alias}…`);
    try {
      const result = await runProcess(SSH_BINARY, sshArgs(alias, command, cwd), os.homedir(), ctx.signal);
      // ssh exits 255 for its own errors (connection, host key, auth); add a plain hint.
      const hint = result.startsWith('exit code 255') ? sshHint(result, alias) : '';
      return `on ${alias}: ${result}` + (hint ? `\n${hint}` : '');
    } finally {
      ctx.setActivity(null);
    }
  },
};

export const sshTools: ToolDef[] = [sshCommand];
