import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  allowedHost, configHosts, expandInclude, isPlainAlias, mergeSSH, parseSSHConfig, remoteCommand, shQuote, sshArgs,
  sshHint, sshScope, usableHosts, wantsSSH,
} from '../src/tools/sshConfig';
import { selectTools, type SelectableTool, type SelectionInput } from '../src/engine/toolSelection';
import { sshFact } from '../src/engine/prompt';
import { parseRequirement, type Requirement } from '../src/tools/commands';

const CONFIG = `
# My servers
Host homelab
  HostName 192.168.1.10
  User pi

Host nas backup-box   # two aliases on one line
  HostName nas.local
Host *.example.com
Host web-? !bad prod*
Host=dev.box
host "quoted"
  Host  homelab
Match host foo exec "true"
  User x
Include config.d/*
Include ~/.ssh/extra
Host -oProxyCommand=evil
`;

test('config parsing keeps plain aliases and skips wildcards and negations', () => {
  const { hosts, includes } = parseSSHConfig(CONFIG);
  assert.deepEqual(hosts, ['homelab', 'nas', 'backup-box', 'dev.box', 'quoted']);
  assert.deepEqual(includes, ['config.d/*', '~/.ssh/extra']);
});

test('aliases that would be read as options or user@ip are not plain', () => {
  assert.equal(isPlainAlias('-oProxyCommand=x'), false);
  assert.equal(isPlainAlias('pi@192.168.1.10'), false);
  assert.equal(isPlainAlias('my host'), false);
  assert.equal(isPlainAlias('nas-2.lan'), true);
});

test('Include is followed, relative to ~/.ssh, with wildcards in the file name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingle-ssh-'));
  fs.mkdirSync(path.join(dir, 'config.d'));
  fs.writeFileSync(path.join(dir, 'config.d', 'a.conf'), 'Host pi\n');
  fs.writeFileSync(path.join(dir, 'config.d', 'b.conf'), 'Host mini *.lan\nInclude ' + path.join(dir, 'config') + '\n');
  fs.writeFileSync(path.join(dir, 'config'), 'Host homelab\nInclude ' + path.join(dir, 'config.d', '*.conf') + '\n');
  try {
    assert.deepEqual(expandInclude('config.d/*.conf', dir).map((f) => path.basename(f)), ['a.conf', 'b.conf']);
    assert.equal(expandInclude('/abs/file', dir)[0], '/abs/file');
    // Loops (b.conf includes config again) are stopped.
    assert.deepEqual(configHosts(path.join(dir, 'config')), ['homelab', 'pi', 'mini']);
    assert.deepEqual(configHosts(path.join(dir, 'missing')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('VS Code settings override the mirror only where set; defaults are off', () => {
  assert.deepEqual(mergeSSH(undefined, {}), { enabled: false, hosts: [] });
  assert.deepEqual(mergeSSH({ enabled: true, hosts: ['nas'] }, {}), { enabled: true, hosts: ['nas'] });
  assert.deepEqual(mergeSSH({ enabled: true, hosts: ['nas'] }, { enabled: false }), { enabled: false, hosts: ['nas'] });
  assert.deepEqual(mergeSSH({ enabled: false, hosts: ['nas'] }, { hosts: ['homelab', ' '] }), { enabled: false, hosts: ['homelab'] });
});

test('only ticked hosts that are in ~/.ssh/config are allowed', () => {
  const inConfig = ['homelab', 'nas', 'dev.box'];
  assert.deepEqual(usableHosts({ enabled: false, hosts: ['homelab'] }, inConfig), []);
  const usable = usableHosts({ enabled: true, hosts: ['HomeLab', 'not-in-config'] }, inConfig);
  assert.deepEqual(usable, ['homelab']);
  assert.equal(allowedHost('homelab', usable), 'homelab');
  assert.equal(allowedHost(' HOMELAB ', usable), 'homelab');
  assert.equal(allowedHost('nas', usable), null);              // in config but not ticked
  assert.equal(allowedHost('not-in-config', usable), null);    // ticked but not in config
  assert.equal(allowedHost('pi@192.168.1.10', usable), null);  // raw address
  assert.equal(allowedHost('192.168.1.10', usable), null);
  assert.equal(allowedHost('', usable), null);
  assert.equal(allowedHost('-oProxyCommand=x', ['-oProxyCommand=x']), null);
});

test('cwd is shell-quoted; the command is passed as one argument after --', () => {
  assert.equal(shQuote("it's"), `'it'\\''s'`);
  assert.equal(remoteCommand('df -h'), 'df -h');
  assert.equal(remoteCommand('ls', '/srv/my app'), `cd '/srv/my app' && ls`);
  assert.equal(remoteCommand('ls', "/tmp/x'; rm -rf / #"), `cd '/tmp/x'\\''; rm -rf / #' && ls`);
  assert.equal(remoteCommand('ls', '~'), 'cd ~ && ls');
  assert.equal(remoteCommand('ls', '~/sites/$HOME'), `cd ~/'sites/$HOME' && ls`);
  assert.deepEqual(sshArgs('homelab', 'df -h', '/srv'), [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes', '-T', 'homelab', '--', `cd '/srv' && df -h`,
  ]);
});

test('a failing cd stops the command (no injection through cwd)', { skip: !fs.existsSync('/bin/sh') }, () => {
  let out = '';
  try {
    out = execFileSync('/bin/sh', ['-c', remoteCommand('echo ran', "/nonexistent/a b'c; echo pwned")], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? '');
  }
  assert.equal(out.includes('pwned'), false);
  assert.equal(out.includes('ran'), false);
});

test('ssh errors get a plain hint', () => {
  assert.match(sshHint('Host key verification failed.', 'nas'), /Connect once in Terminal \(ssh nas\)/);
  assert.match(sshHint('pi@nas: Permission denied (publickey).', 'nas'), /never types passwords/);
  assert.match(sshHint('ssh: Could not resolve hostname nas', 'nas'), /Couldn't reach nas/);
  assert.equal(sshHint('some other failure', 'nas'), '');
});

test('session approval scope is host + folder + exact command', () => {
  const a = sshScope('homelab', 'df -h', '');
  assert.equal(a.key, 'ssh\nhomelab\n\ndf -h');
  assert.equal(a.label, '“df -h” on homelab');
  assert.equal(sshScope('HomeLab', ' df -h ', '').key, a.key);
  assert.notEqual(sshScope('nas', 'df -h', '').key, a.key);
  assert.notEqual(sshScope('homelab', 'df -h /', '').key, a.key);
  assert.notEqual(sshScope('homelab', 'df -h', '/srv').key, a.key);
  assert.equal(sshScope('homelab', 'ls', '/srv').label, '“ls” on homelab in /srv');
});

const tool = (name: string, readOnly = false): SelectableTool => ({ name, readOnly });
const AVAILABLE = [tool('read_file', true), tool('run_command'), tool('ssh_command')];
function pick(lastUser: string, over: Partial<SelectionInput<SelectableTool>> = {}): string[] {
  return selectTools({
    available: AVAILABLE, lastUser, isSubAgent: false, active: [], mcpToolNames: [], mcpWanted: false,
    sshHosts: ['homelab', 'nas.lan'], ...over,
  }).map((t) => t.name);
}

test('ssh_command is offered only when SSH is on and the message is about it', () => {
  assert.ok(pick('check disk space on homelab').includes('ssh_command'));
  assert.ok(pick('Is the NAS.lan full?').includes('ssh_command'));
  assert.ok(pick('restart nginx on the server').includes('ssh_command'));
  assert.ok(pick('ssh in and check uptime').includes('ssh_command'));
  assert.ok(pick('run it on the remote box').includes('ssh_command'));
  assert.ok(!pick('fix the failing build').includes('ssh_command'));
  assert.ok(!pick('my homelabs are great').includes('ssh_command'));
  assert.ok(!pick('check disk space on homelab', { sshHosts: [] }).includes('ssh_command'));
  assert.ok(!pick('ssh into homelab', { isSubAgent: true }).includes('ssh_command'));
  assert.equal(wantsSSH('ssh please', []), false);
});

test('commands can force or ban ssh_command', () => {
  const must = [{ mustUse: [parseRequirement('ssh_command')].filter((r): r is Requirement => !!r), neverUse: [] }];
  assert.ok(pick('fix the build', { active: must }).includes('ssh_command'));
  assert.ok(!pick('ssh into homelab', { active: [{ mustUse: [], neverUse: ['ssh_command'] }] }).includes('ssh_command'));
});

test('prompt fact lists the hosts, and is empty when SSH is off', () => {
  assert.equal(sshFact([]), '');
  const f = sshFact(['homelab', 'nas']);
  assert.match(f, /ssh_command/);
  assert.match(f, /homelab, nas/);
  assert.match(f, /needs approval/);
  assert.match(f, /Never try to reach other hosts/);
});
