// Security properties of the server and the wake service. Each test names the attack it stops.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeSessionId, projectDir } from '../cli/deliver.js';
import { toLocal, sessionRepo } from '../collector/transcripts.js';
import { agentRepos, describeRepo, git, repoRoot } from '../lib/discover.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzs-'));
const TOKEN = 'test-not-a-real-token';
const base = { ...process.env, HOME: tmp };
delete base.AGENTSBUZZ_TOKEN;
delete base.AGENTSBUZZ_URL;

const servers = [];
async function startServer(env) {
  const port = 24000 + Math.floor(Math.random() * 900) + servers.length;
  const p = spawn(process.execPath, [path.join(root, 'server/server.js')], {
    env: { ...base, PORT: String(port), AGENTSBUZZ_DB: path.join(tmp, `s${port}.db`), ...env },
    stdio: 'ignore',
  });
  servers.push(p);
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return port;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server did not start');
}

// fetch() normalizes paths and forbids some headers; a raw request sends exactly what an attacker would
function raw(port, reqPath, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

let port;
let open; // a server with no token
before(async () => {
  port = await startServer({ AGENTSBUZZ_TOKEN: TOKEN });
  open = await startServer({});
});
after(() => {
  for (const p of servers) p.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const bearer = { authorization: `Bearer ${TOKEN}` };

test('every response carries a strict Content-Security-Policy and the other browser protections', async () => {
  for (const p of ['/', '/app.js', '/api/health', '/nope']) {
    const r = await raw(port, p, bearer);
    const csp = r.headers['content-security-policy'] || '';
    assert.match(csp, /default-src 'none'/, p);
    assert.match(csp, /script-src 'self'(;|$)/, p);
    assert.match(csp, /frame-ancestors 'none'/, p);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/, p);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
    assert.equal(r.headers['referrer-policy'], 'no-referrer', p); // the token can be in a sign-in link
    assert.equal(r.headers['x-frame-options'], 'DENY', p); // no clickjacking the Reply button
  }
});

test('the web app sets no inline style attributes, so the CSP needs no unsafe-inline', () => {
  for (const f of ['web/app.js', 'web/md.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(src, /setAttribute\(\s*['"]style['"]/, f);
    assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|document\.write/, f);
  }
  const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'no inline <script>');
  assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=/i, 'no inline styles or handlers');
});

test("a project's summary (what its agents last said) is not readable without the token", async () => {
  assert.equal((await raw(port, '/api/projects/alpha/summary')).status, 401);
  assert.equal((await raw(port, '/api/projects/alpha/summary', { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await raw(port, '/api/projects/alpha/summary', bearer)).status, 200);
});

test('a wrong token, or one of a different length, is refused', async () => {
  for (const t of ['x', `${TOKEN}x`, TOKEN.slice(0, -1), '']) {
    const r = await raw(port, '/api/events', { authorization: `Bearer ${t}` });
    assert.equal(r.status, 401, JSON.stringify(t));
  }
  assert.equal((await raw(port, '/api/events', bearer)).status, 200);
});

test('a token in the URL only opens the live stream, never the rest of the API', async () => {
  const q = `?token=${TOKEN}`;
  assert.equal((await raw(port, `/api/events${q}`)).status, 401);
  assert.equal((await raw(port, `/api/replies${q}`)).status, 401);
  const stream = await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: `/api/stream${q}` }, (res) => {
      resolve(res.statusCode);
      req.destroy();
    });
  });
  assert.equal(stream, 200);
});

test('another website cannot call the API from your browser (CSRF), even with no token set', async () => {
  for (const p of [port, open]) {
    const r = await raw(p, '/api/events/1/reply', { ...bearer, 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, 'POST');
    assert.equal(r.status, 403);
  }
  // opening the app from a link on another site is still fine
  assert.equal((await raw(port, '/', { 'sec-fetch-site': 'cross-site' })).status, 200);
  assert.equal((await raw(open, '/api/health', { 'sec-fetch-site': 'same-origin' })).status, 200);
});

test('without a token, only loopback Host names are served (DNS rebinding)', async () => {
  assert.equal((await raw(open, '/api/events', { host: 'attacker.example.invalid' })).status, 403);
  assert.equal((await raw(open, '/', { host: 'attacker.example.invalid:7777' })).status, 403);
  for (const h of ['127.0.0.1', 'localhost:7777', '[::1]:7777']) assert.equal((await raw(open, '/api/health', { host: h })).status, 200, h);
  // with a token the Host is not the defense, so a phone behind Tailscale keeps working
  assert.equal((await raw(port, '/api/health', { ...bearer, host: 'mymac.example.invalid' })).status, 200);
});

test('static files cannot escape the web folder', async () => {
  for (const p of ['/../server/server.js', '/..%2fserver/server.js', '/%2e%2e/server/server.js', '/../web-private/x', '/..%5cpackage.json']) {
    const r = await raw(port, p);
    assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.doesNotMatch(r.body, /DatabaseSync|"name": "agentsbuzz"/, p);
  }
  assert.equal((await raw(port, '/%E0%A4%A')).status, 400); // malformed escapes are a clean 400, not a 500
});

test('the database folder is private to you', async () => {
  const dir = path.join(tmp, 'private-db');
  const p = await startServer({ AGENTSBUZZ_DB: path.join(dir, 'b.db') });
  assert.ok(p);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'b.db')).mode & 0o077, 0, 'no access for group or others');
});

test("requeue can only undo the wake service's own deliveries, never an agent's", async () => {
  const call = (p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  await call('/api/events', { project: 'rq', harness: 'claude-code', session_id: 'rq-1', kind: 'done', summary: 'done' });
  const ev = (await (await fetch(`http://127.0.0.1:${port}/api/events?session_id=rq-1`, { headers: bearer })).json()).events[0];
  const a = await call(`/api/events/${ev.id}/reply`, { prompt: 'first' });
  const [byAgent] = (await call('/api/replies/claim', { session_id: 'rq-1', via: 'hook' })).replies;
  assert.equal(byAgent.id, a.id);
  assert.deepEqual((await call('/api/replies/requeue', { ids: [a.id] })).replies, [], 'an agent already has it');
  const b = await call(`/api/events/${ev.id}/reply`, { prompt: 'second' });
  await call('/api/replies/claim', { session_id: 'rq-1', via: 'wake' });
  const back = (await call('/api/replies/requeue', { ids: [b.id, 'x', -1] })).replies;
  assert.deepEqual(back.map((r) => [r.id, r.delivered]), [[b.id, 0]]);
  const noAuth = await fetch(`http://127.0.0.1:${port}/api/replies/requeue`, { method: 'POST', body: JSON.stringify({ ids: [b.id] }) });
  assert.equal(noAuth.status, 401);
});

test('a session id that looks like an option never reaches the agent command line', () => {
  for (const ok of ['00000000-1111-4222-8333-444444444444', '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', 'wk-claude']) assert.ok(safeSessionId(ok), ok);
  for (const bad of ['--dangerously-skip-permissions', '-c', '-csandbox_mode=danger-full-access', 'a b', 'a\nb', '', 'x'.repeat(121), null, 42]) {
    assert.equal(safeSessionId(bad), false, JSON.stringify(bad));
  }
});

test('a project name cannot point the agent at a folder outside your projects', () => {
  const r = path.join(tmp, 'projects');
  assert.equal(projectDir(r, 'alpha'), path.join(r, 'alpha'));
  for (const bad of ['..', '.', '../..', '../etc', 'a/b', 'a\\b', '/etc', '', 'x\0y']) assert.equal(projectDir(r, bad), '', JSON.stringify(bad));
  assert.equal(projectDir('', 'alpha'), '');
});

test('a session file pointing at a hostile repository cannot make agentsbuzz run its programs', () => {
  // a repository whose own config would run a program on many git commands
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const evil = path.join(home, 'cloned', 'evil');
  fs.mkdirSync(evil, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: evil, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'a@example.invalid');
  g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(evil, 'f'), 'x');
  g('add', '-A');
  g('commit', '-q', '-m', 'x');
  const marker = path.join(home, 'ran');
  const script = path.join(home, 'payload.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  g('config', 'core.fsmonitor', script);
  g('config', 'core.pager', script);
  fs.writeFileSync(path.join(evil, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  // a Claude Code session that ran there
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(path.join(claudeDir, 'projects', '-evil'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'projects', '-evil', 's.jsonl'), `${JSON.stringify({ type: 'user', cwd: evil, sessionId: 's' })}\n`);
  const found = agentRepos({ claudeDir, home });
  assert.deepEqual(found, [fs.realpathSync(evil)]);
  describeRepo(found[0]);
  git(found[0], 'status'); // plain git status runs core.fsmonitor; this must not
  assert.equal(fs.existsSync(marker), false, 'reading the repository ran one of its programs');
});

test('a working folder from a session file cannot name a folder that is not a repository', () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const plain = path.join(home, 'notes', 'sub');
  fs.mkdirSync(plain, { recursive: true });
  for (const bad of ['', 'relative/path', '../..', 'x\0y', null, 42, {}, home, plain, path.parse(home).root]) assert.equal(repoRoot(bad, { home }), '', JSON.stringify(bad));
  // a .git file that points somewhere else is only read as a path, and only a real worktree folds into its repository
  const odd = path.join(home, 'odd');
  fs.mkdirSync(odd);
  fs.writeFileSync(path.join(odd, '.git'), 'gitdir: /etc\n');
  assert.equal(repoRoot(odd, { home }), fs.realpathSync(odd));
  // a .git file claiming to be a worktree of some other repository is not followed into it...
  const other = path.join(home, 'other');
  execFileSync('git', ['init', '-q', other], { stdio: 'ignore' });
  fs.mkdirSync(path.join(other, '.git', 'worktrees', 'fake'), { recursive: true });
  const liar = path.join(home, 'liar');
  fs.mkdirSync(liar);
  fs.writeFileSync(path.join(liar, '.git'), `gitdir: ${path.join(other, '.git', 'worktrees', 'fake')}\n`);
  assert.equal(repoRoot(liar, { home }), fs.realpathSync(liar));
  // ...while a real worktree, linked both ways by git, folds into its repository
  execFileSync('git', ['-C', other, '-c', 'user.email=a@example.invalid', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'x'], { stdio: 'ignore' });
  const wt = path.join(home, 'wt');
  execFileSync('git', ['-C', other, 'worktree', 'add', '-q', wt], { stdio: 'ignore' });
  assert.equal(repoRoot(wt, { home }), fs.realpathSync(other));
});

test('a symlink to your home folder cannot make your home folder (a dotfiles repository) a project', () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  execFileSync('git', ['init', '-q', home], { stdio: 'ignore' });
  fs.mkdirSync(path.join(home, 'sub'));
  const link = path.join(fs.mkdtempSync(path.join(tmp, 'elsewhere-')), 'home-link');
  fs.symlinkSync(home, link);
  assert.equal(repoRoot(path.join(link, 'sub'), { home }), '');
  assert.equal(repoRoot(link, { home }), '');
});

test('in Docker, a session file cannot point the collector outside the mounted projects folder', () => {
  const host = '/home/someone/projects';
  const mount = fs.mkdtempSync(path.join(tmp, 'mount-'));
  const inside = path.join(mount, 'ok', 'src');
  fs.mkdirSync(inside, { recursive: true });
  execFileSync('git', ['init', '-q', path.join(mount, 'ok')], { stdio: 'ignore' });
  assert.equal(sessionRepo(`${host}/ok/src`, host, mount), fs.realpathSync(path.join(mount, 'ok')));
  // ".." in the recorded path cannot climb out
  // (it is resolved first: a path that ends up outside the host folder is never translated into the mount)
  for (const bad of [`${host}/../../etc`, `${host}/ok/../../..`, `${host}/./../x`, `${host}/ok/../../../etc`]) {
    const t = toLocal(bad, host, mount);
    assert.ok(t === null || t === bad, `${bad} became ${t}`);
    assert.ok(!sessionRepo(bad, host, mount), bad);
  }
  // a symlink inside the mount that leads to a repository outside it is ignored
  const outside = fs.mkdtempSync(path.join(tmp, 'outside-'));
  execFileSync('git', ['init', '-q', outside], { stdio: 'ignore' });
  fs.symlinkSync(outside, path.join(mount, 'leak'));
  assert.equal(sessionRepo(`${host}/leak`, host, mount), null);
});

test('the wake service refuses to run agents for a server without a token', async () => {
  const stubs = path.join(tmp, 'stubs');
  const calls = path.join(tmp, 'calls.log');
  fs.mkdirSync(stubs, { recursive: true });
  fs.writeFileSync(path.join(stubs, 'claude'), `#!/bin/sh\n[ "$1" = "--version" ] && exit 0\necho "$*" >> "${calls}"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(tmp, 'projects', 'alpha'), { recursive: true });
  const api = (p, body) =>
    fetch(`http://127.0.0.1:${open}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  await api('/api/events', { project: 'alpha', harness: 'claude-code', session_id: 'sec-1', kind: 'done', summary: 'done', ts: Date.now() - 600000 });
  const ev = (await (await fetch(`http://127.0.0.1:${open}/api/events?session_id=sec-1`)).json()).events[0];
  await api(`/api/events/${ev.id}/reply`, { prompt: 'run something' });

  let out = '';
  const d = spawn(process.execPath, [path.join(root, 'cli/deliver.js')], {
    env: { ...base, PATH: `${stubs}:/usr/bin:/bin`, AGENTSBUZZ_URL: `http://127.0.0.1:${open}`, PROJECTS_DIR: path.join(tmp, 'projects'), AGENTSBUZZ_WAKE_IDLE_MS: '200', AGENTSBUZZ_WAKE_POLL_MS: '150' },
  });
  d.stdout.on('data', (x) => (out += x));
  await new Promise((r) => setTimeout(r, 2000));
  d.kill();
  assert.match(out, /not waking agents: the server has no token/);
  assert.equal(fs.existsSync(calls), false, 'the agent was never started');
});
