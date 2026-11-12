// The wake service in the situations the stubbed wake.test.js cannot show: the commands are not on
// the service's PATH (nvm keeps them under one Node version, Codex ships inside the editor extension),
// and a command that cannot be found at all.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzd-'));
const PORT = 23000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'deliver-token';
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const api = async (p, body) =>
  (await fetch(BASE + p, body ? { method: 'POST', headers: auth, body: JSON.stringify(body) } : { headers: auth })).json();
// a PATH with node's tools but neither agent command
const bare = '/usr/bin:/bin';

const stub = (file, name) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = "--version" ] && { echo ${name}; exit 0; }\nexit 0\n`, { mode: 0o755 });
};
// claude installed under two nvm Node versions; the newest (v24, not the text-sorted v9) should win
stub(path.join(home, '.nvm/versions/node/v9.11.2/bin/claude'), 'old');
stub(path.join(home, '.nvm/versions/node/v24.4.1/bin/claude'), 'new');
// codex only inside two versions of the VS Code extension
stub(path.join(home, '.vscode/extensions/openai.chatgpt-26.930.61225-darwin-arm64/bin/macos-aarch64/codex'), 'old');
stub(path.join(home, '.vscode/extensions/openai.chatgpt-26.1021.22027-darwin-arm64/bin/macos-aarch64/codex'), 'new');

function findBins(extra = {}) {
  const code = `const m = await import(${JSON.stringify(path.join(root, 'cli/deliver.js'))}); console.log(JSON.stringify({ claude: m.findBin('claude-code'), codex: m.findBin('codex') }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { HOME: home, PATH: bare, ...extra }, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// system-wide installs rightly come first, so this check only means something on a machine without them
const systemWide = ['/opt/homebrew/bin', '/usr/local/bin'].some((d) => fs.existsSync(`${d}/claude`) || fs.existsSync(`${d}/codex`));
test('finds the commands off PATH: the newest nvm Node version, and the editor extension for Codex', { skip: systemWide && 'claude or codex is installed system-wide' }, () => {
  const { claude, codex } = findBins();
  assert.equal(claude, path.join(home, '.nvm/versions/node/v24.4.1/bin/claude'));
  assert.equal(codex, path.join(home, '.vscode/extensions/openai.chatgpt-26.1021.22027-darwin-arm64/bin/macos-aarch64/codex'));
});

test('AGENTSBUZZ_CLAUDE_BIN and AGENTSBUZZ_CODEX_BIN pick the command', () => {
  const mine = path.join(home, 'mine/claude');
  stub(mine, 'mine');
  const { claude, codex } = findBins({ AGENTSBUZZ_CLAUDE_BIN: mine, AGENTSBUZZ_CODEX_BIN: path.join(home, 'nope/codex') });
  assert.equal(claude, mine);
  assert.equal(codex, '');
});

test('a cached command that disappears (editor update removed that version) is looked up again', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzd2-'));
  const ext = (v) => path.join(h, `.vscode/extensions/openai.chatgpt-${v}-darwin-arm64`);
  stub(path.join(ext('26.930.61225'), 'bin/macos-aarch64/codex'), 'old');
  stub(path.join(ext('26.1021.22027'), 'bin/macos-aarch64/codex'), 'new');
  const code = `const m = await import(${JSON.stringify(path.join(root, 'cli/deliver.js'))});
    const fs = await import('node:fs');
    const first = m.findBin('codex');
    fs.rmSync(${JSON.stringify(ext('26.1021.22027'))}, { recursive: true });
    console.log(JSON.stringify({ first, second: m.findBin('codex') }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { HOME: h, PATH: bare }, encoding: 'utf8', timeout: 20000 });
  fs.rmSync(h, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  const { first, second } = JSON.parse(r.stdout);
  assert.match(first, /26\.1021\.22027/);
  assert.match(second, /26\.930\.61225/);
});

let server;
let deliverer;
let proxy;
let failNextError = true; // the proxy drops the first error post, as if the server hiccupped
before(async () => {
  server = spawn(process.execPath, [path.join(root, 'server/server.js')], {
    env: { ...process.env, HOME: home, PORT: String(PORT), AGENTSBUZZ_TOKEN: TOKEN, AGENTSBUZZ_DB: path.join(home, 'd.db') },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`, { headers: auth })).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

// sits between the wake service and the server, so a post can fail on purpose
before(async () => {
  proxy = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (failNextError && req.method === 'POST' && req.url === '/api/events' && body.includes('"kind":"error"')) {
      failNextError = false;
      res.writeHead(503).end('busy');
      return;
    }
    const r = await fetch(BASE + req.url, { method: req.method, headers: { authorization: req.headers.authorization || '', 'content-type': 'application/json' }, body: body || undefined });
    res.writeHead(r.status, { 'content-type': 'application/json' }).end(await r.text());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
});

test('a session that cannot be woken says so in the feed, once (even if the first post fails), and keeps the message waiting', async () => {
  const proj = path.join(home, 'code', 'beta');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  deliverer = spawn(process.execPath, [path.join(root, 'cli/deliver.js')], {
    env: {
      HOME: home,
      PATH: bare,
      AGENTSBUZZ_URL: `http://127.0.0.1:${proxy.address().port}`,
      AGENTSBUZZ_TOKEN: TOKEN,
      PROJECTS_DIR: path.join(home, 'code'),
      AGENTSBUZZ_CLAUDE_BIN: path.join(home, 'missing/claude'),
      AGENTSBUZZ_WAKE_IDLE_MS: '500',
      AGENTSBUZZ_WAKE_POLL_MS: '200',
    },
    stdio: 'ignore',
  });
  const ts = Date.now() - 10 * 60 * 1000;
  await api('/api/events', { project: 'beta', harness: 'claude-code', agent: 'claude', session_id: 'dl-1', kind: 'done', summary: 'done', ts });
  const ev = (await api('/api/events?session_id=dl-1')).events[0];
  const msg = await api(`/api/events/${ev.id}/reply`, { prompt: 'reply with the word pong' });

  let errors = [];
  for (let i = 0; i < 75 && !errors.length; i++) {
    await new Promise((r) => setTimeout(r, 200));
    errors = (await api('/api/events?session_id=dl-1')).events.filter((e) => e.kind === 'error');
  }
  assert.equal(errors.length, 1, 'expected one error post');
  assert.equal(failNextError, false, 'the first attempt was dropped, so this one is the retry');
  assert.match(errors[0].summary, /claude command was not found/);
  assert.match(errors[0].summary, /AGENTSBUZZ_CLAUDE_BIN/);

  await new Promise((r) => setTimeout(r, 1500)); // more ticks: still just one post
  assert.equal((await api('/api/events?session_id=dl-1')).events.filter((e) => e.kind === 'error').length, 1);
  const r = (await api('/api/replies?all=1')).replies.find((x) => x.id === msg.id);
  assert.equal(r.delivered, 0, 'the message stays queued for the agent');
});

after(() => {
  deliverer?.kill();
  proxy?.close();
  server?.kill();
  fs.rmSync(home, { recursive: true, force: true });
});
