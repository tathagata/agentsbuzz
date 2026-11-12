import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzl-'));
const PORT = 21000 + Math.floor(Math.random() * 900);
// AGENTSBUZZ_TAILSCALE=none: never touch the real Tailscale on the machine running the tests
const env = { ...process.env, HOME: home, AGENTSBUZZ_HOME: path.join(home, '.agentsbuzz'), PATH: process.env.PATH, AGENTSBUZZ_TAILSCALE: 'none' };
delete env.AGENTSBUZZ_TOKEN;
delete env.AGENTSBUZZ_URL;
// a follower started by these tests watches an empty scratch repo, never this repository
env.FOLLOW_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzl-follow-'));
execFileSync('git', ['init', '-q', '-b', 'main', env.FOLLOW_DIR]);
env.FOLLOW_POLL_MS = '600000';

function buzz(...args) {
  return new Promise((resolve) => {
    const p = spawn(path.join(root, 'buzz'), args, { env, cwd: root });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });

// a fake machine: a projects folder with history, a Codex session, a Claude Code folder
const projects = path.join(home, 'code');
for (const name of ['alpha', 'beta']) {
  const d = path.join(projects, name);
  fs.mkdirSync(d, { recursive: true });
  sh(d, 'init', '-q', '-b', 'main');
  sh(d, 'config', 'user.email', 'a@b.c');
  sh(d, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(d, 'README.md'), `# ${name}\n\nThe ${name} project.\n`);
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', `First commit of ${name}`);
}
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "x"\n');

after(async () => {
  await buzz('stop');
});

test('one command finds the projects, loads history and says what it did', async () => {
  const t0 = Date.now();
  const r = await buzz('--no-open', '--no-phone', '--projects', projects, '--port', String(PORT));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /agentsbuzz is running/);
  assert.match(r.out, /2 repos/);
  assert.match(r.out, /Loaded\s+2 projects, \d+ events/);
  assert.ok(Date.now() - t0 < 30000, 'first value within 30s');
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.agentsbuzz', 'config.json'), 'utf8'));
  const res = await fetch(`http://127.0.0.1:${cfg.port}/api/events`, { headers: { authorization: `Bearer ${cfg.token}` } });
  const { events } = await res.json();
  assert.ok(events.some((e) => e.summary === 'First commit of alpha'), 'history is in the feed');
  const noAuth = await fetch(`http://127.0.0.1:${cfg.port}/api/events`);
  assert.equal(noAuth.status, 401, 'token is required even locally');
});

test('running it again is safe and instant', async () => {
  const t0 = Date.now();
  const r = await buzz('--no-open', '--no-phone');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Loaded\s+2 projects/);
  assert.ok(Date.now() - t0 < 5000);
  const s = await buzz('status');
  assert.match(s.out, /Running at/);
  assert.match(s.out, /2 projects/);
});

test('phone without Tailscale explains the way forward instead of failing', async () => {
  const r = await buzz('phone');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Tailscale/);
  assert.match(r.out, /--lan/);
});

test('connect shows what it will change, and changes nothing without a yes', async () => {
  const before = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
  const r = await buzz('connect');
  assert.match(r.out, /This will:/);
  assert.match(r.out, /No changes made/);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), before);
});

test('connect --yes wires up Claude Code and Codex, keeps what was there, and is idempotent', async () => {
  const r = await buzz('connect', '--yes');
  assert.match(r.out, /Done\./, r.out);
  const s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.theme, 'dark');
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'echo mine', 'existing hook kept');
  assert.ok(JSON.stringify(s.hooks.Stop).includes('claude-code-hook.js'));
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'Notification', 'SubagentStop']) assert.ok(JSON.stringify(s.hooks[ev]).includes('claude-code-hook.js'), ev);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json.bak-agentsbuzz')));
  assert.match(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /\[mcp_servers\.agentsbuzz\]/);
  assert.match(fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8'), /get_messages/);
  const file = JSON.parse(fs.readFileSync(path.join(home, '.agentsbuzz.json'), 'utf8'));
  assert.ok(file.token && file.url);
  const again = await buzz('connect', '--yes');
  assert.match(again.out, /already connected/);
});

test('follow on starts a follower, restart keeps it, follow off stops it', async () => {
  const run = () => JSON.parse(fs.readFileSync(path.join(home, '.agentsbuzz', 'run.json'), 'utf8'));
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const on = await buzz('follow', 'on', '--yes');
  assert.match(on.out, /Following main is on/, on.out);
  const first = run().follower;
  assert.ok(first && alive(first), 'follower running');
  assert.match((await buzz('status')).out, /Follow\s+on/);
  const r = await buzz('restart');
  assert.match(r.out, /Restarted/, r.out);
  const second = run().follower;
  assert.ok(second && second !== first && alive(second) && !alive(first), 'restart replaces the follower');
  const off = await buzz('follow', 'off');
  assert.match(off.out, /Following main is off/);
  assert.equal(run().follower, undefined);
  assert.equal(alive(second), false);
});

test('stop stops, and the data is kept', async () => {
  const r = await buzz('stop');
  assert.match(r.out, /Stopped/);
  assert.ok(fs.existsSync(path.join(home, '.agentsbuzz', 'buzz.db')));
  const s = await buzz('status');
  assert.match(s.out, /Not running/);
});
