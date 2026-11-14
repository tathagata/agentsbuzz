import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 19000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzc-'));
const projects = path.join(tmp, 'projects');
const claude = path.join(tmp, 'claude');
const codex = path.join(tmp, 'codex');
let server;
let collector;
// the test server runs without a token: do not inherit one from the shell running the tests
const baseEnv = { ...process.env };
delete baseEnv.AGENTSBUZZ_TOKEN;
delete baseEnv.AGENTSBUZZ_URL;

const get = (p) => fetch(`${BASE}${p}`).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}
const events = async (q = '') => (await get(`/api/events?limit=200${q}`)).events;
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });

function repo(name, withReadme = true, parent = projects) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'a@b.c');
  sh(dir, 'config', 'user.name', 'Tester');
  if (withReadme) fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n\nA project called ${name} for testing the collector.\n`);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'Initial commit');
  return dir;
}

const line = (o) => `${JSON.stringify(o)}\n`;
const assistant = (cwd, sessionId, text, stop, extra = {}) =>
  line({ type: 'assistant', cwd, sessionId, timestamp: new Date().toISOString(), isSidechain: false, message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] }, ...extra });

before(async () => {
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(codex, { recursive: true });
  const alpha = repo('alpha');
  fs.mkdirSync(path.join(projects, 'notes-not-git'), { recursive: true });
  globalThis.alphaDir = alpha;
  // a grouping folder inside the projects folder: ~/projects/acme/delta
  repo('delta', true, path.join(projects, 'acme'));
  // a repository outside every watched folder, added by hand (./buzz add)
  repo('zeta', true, path.join(tmp, 'manual'));

  // history that existed before the collector ever ran
  const hist = repo('hist');
  const old = new Date(Date.now() - 5 * 86400000).toISOString();
  fs.writeFileSync(path.join(hist, 'old.txt'), 'o');
  sh(hist, 'add', '-A');
  execFileSync('git', ['commit', '-q', '-m', 'Wire up the parser'], { cwd: hist, env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old }, stdio: 'ignore' });
  globalThis.histTs = Date.parse(old);
  const pdir = path.join(claude, 'projects', '-x-hist');
  fs.mkdirSync(pdir, { recursive: true });
  const t1 = new Date(Date.now() - 3 * 86400000).toISOString();
  fs.writeFileSync(
    path.join(pdir, 'past-session.jsonl'),
    line({ type: 'assistant', cwd: hist, sessionId: 'past-1', timestamp: t1, isSidechain: false, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Parser handles nested blocks now.' }] } })
  );

  server = spawn('node', [path.join(root, 'server/server.js')], {
    env: { ...baseEnv, PORT: String(PORT), AGENTSBUZZ_DB: path.join(tmp, 'c.db') },
    stdio: 'ignore',
  });
  await waitFor(async () => {
    try {
      return (await fetch(`${BASE}/api/health`)).ok;
    } catch {
      return false;
    }
  }, 'server');

  collector = spawn('node', [path.join(root, 'collector/index.js')], {
    env: {
      ...baseEnv,
      HOME: tmp,
      AGENTSBUZZ_URL: BASE,
      PROJECTS_DIR: projects,
      HOST_PROJECTS: projects,
      CLAUDE_DIR: claude,
      CODEX_DIR: codex,
      STATE_FILE: path.join(tmp, 'state.json'),
      EXTRA_REPOS: path.join(tmp, 'manual', 'zeta'),
      IGNORE_PROJECTS: 'hidden',
      POLL_MS: '200',
      GIT_POLL_MS: '300',
      DISCOVER_MS: '600',
      QUIET_MS: '700',
    },
    stdio: 'ignore',
  });
});

after(() => {
  collector?.kill();
  server?.kill();
});

test('discovers git projects on its own and skips folders that are not repos', async () => {
  const p = await waitFor(async () => (await get('/api/projects')).projects.find((x) => x.name === 'alpha'), 'alpha');
  assert.equal(p.status, 'active');
  assert.match(p.description, /project called alpha/);
  assert.ok(!(await get('/api/projects')).projects.some((x) => x.name === 'notes-not-git'));
});

test('first run loads recent history with its original time, in time order', async () => {
  const commit = await waitFor(async () => (await events('&project=hist')).find((e) => e.summary === 'Wire up the parser'), 'backfilled commit');
  assert.ok(Math.abs(commit.ts - globalThis.histTs) < 5000, 'keeps the commit time');
  const turn = await waitFor(async () => (await events('&project=hist')).find((e) => e.summary.includes('Parser handles nested')), 'backfilled agent turn');
  assert.equal(turn.harness, 'claude-code');
  assert.ok(Date.now() - turn.ts > 2.9 * 86400000, 'keeps the session time');
  const all = await events();
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].ts >= all[i].ts, 'newest first by time');
  // paging by time returns the older ones without repeats
  const first = (await events('&limit=2')).slice(0, 2);
  const next = await events(`&limit=200&before_ts=${first[1].ts}&before=${first[1].id}`);
  assert.ok(next.every((e) => e.ts <= first[1].ts && e.id !== first[1].id));
  // and nothing is posted twice
  await sleep(800);
  assert.equal((await events('&project=hist')).filter((e) => e.summary === 'Wire up the parser').length, 1);
});

test('a new project folder appears automatically', async () => {
  repo('gamma');
  await waitFor(async () => (await get('/api/projects')).projects.find((x) => x.name === 'gamma'), 'gamma');
});

test('new commits show up in the feed', async () => {
  fs.writeFileSync(path.join(globalThis.alphaDir, 'g.txt'), 'y');
  sh(globalThis.alphaDir, 'add', '-A');
  sh(globalThis.alphaDir, 'commit', '-q', '-m', 'Add the rules engine');
  const ev = await waitFor(async () => (await events('&project=alpha')).find((e) => e.summary === 'Add the rules engine'), 'git event');
  assert.equal(ev.summary, 'Add the rules engine');
  assert.equal(ev.agent, 'Tester');
  // and it is not posted twice
  await sleep(1000);
  assert.equal((await events('&project=alpha')).filter((e) => e.summary === 'Add the rules engine').length, 1);
});

test('Claude Code session: start, finished turn, ignores subagents, handles partial lines', async () => {
  const file = path.join(claude, 'projects', '-tmp-alpha', 'sess-1.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cwd = path.join(projects, 'alpha');
  fs.writeFileSync(file, line({ type: 'user', cwd, sessionId: 'sess-1', message: { role: 'user', content: 'do it' } }) + assistant(cwd, 'sess-1', 'Looking at the rules schema', null));
  await waitFor(async () => (await events('&project=alpha')).find((e) => e.kind === 'started' && e.session_id === 'sess-1'), 'started');

  fs.appendFileSync(file, assistant(cwd, 'sess-1', 'SUBAGENT SECRET', 'end_turn', { isSidechain: true }));
  const full = assistant(cwd, 'sess-1', 'Added audit export and tests, all green.', 'end_turn');
  fs.appendFileSync(file, full.slice(0, 40)); // partial line
  await sleep(500);
  fs.appendFileSync(file, full.slice(40));
  const done = await waitFor(async () => (await events('&project=alpha')).find((e) => e.kind === 'done' && e.session_id === 'sess-1'), 'done');
  assert.equal(done.summary, 'Added audit export and tests, all green.');
  assert.equal(done.harness, 'claude-code');
  assert.ok(!(await events()).some((e) => e.summary.includes('SECRET')));
});

test('a session that goes quiet still gets summarized', async () => {
  const file = path.join(claude, 'projects', '-tmp-alpha', 'sess-2.jsonl');
  fs.writeFileSync(file, assistant(path.join(projects, 'alpha'), 'sess-2', 'Halfway through the migration', null));
  const done = await waitFor(async () => (await events('&project=alpha')).find((e) => e.kind === 'done' && e.session_id === 'sess-2'), 'quiet done');
  assert.equal(done.summary, 'Halfway through the migration');
});

test('Codex session maps worktrees to the project and posts on task completion', async () => {
  const file = path.join(codex, 'sessions', '2026', '11', '08', 'rollout-2026-11-08T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ts = new Date().toISOString();
  fs.writeFileSync(
    file,
    line({ timestamp: ts, type: 'session_meta', payload: { id: 'cx-1', cwd: path.join(projects, 'alpha.worktrees', 'feature') } }) +
      line({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Refactored the loader' }] } }) +
      line({ timestamp: ts, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Refactored the loader and updated callers.' } })
  );
  const ev = await waitFor(async () => (await events('&project=alpha')).find((e) => e.harness === 'codex' && e.kind === 'done'), 'codex done');
  assert.equal(ev.summary, 'Refactored the loader and updated callers.');
  assert.equal(ev.session_id, 'cx-1');
});

test('a repository outside the projects folder is found from agent history, named after the repo, not the subfolder', async () => {
  const omega = repo('omega', true, path.join(tmp, 'elsewhere'));
  fs.mkdirSync(path.join(omega, 'src'), { recursive: true });
  const dir = path.join(claude, 'projects', '-x-elsewhere-omega-src');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'om.jsonl'), assistant(path.join(omega, 'src'), 'omega-1', 'Omega parser is done.', 'end_turn'));
  const turn = await waitFor(async () => (await events()).find((e) => e.summary.includes('Omega parser is done')), 'omega turn');
  assert.equal(turn.project, 'omega', 'a session in repo/src belongs to the repo');
  const p = await waitFor(async () => (await get('/api/projects')).projects.find((x) => x.name === 'omega' && x.description), 'omega described');
  assert.match(p.description, /project called omega/);
  // and its commits are followed, though it is in no watched folder
  await waitFor(async () => (await events('&project=omega')).find((e) => e.harness === 'git' && e.summary === 'Initial commit'), 'omega commit');
});

test('two repositories with the same name stay two projects', async () => {
  const other = repo('alpha', true, path.join(tmp, 'team'));
  const dir = path.join(claude, 'projects', '-x-team-alpha');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ta.jsonl'), assistant(other, 'team-alpha-1', 'Team alpha shipped.', 'end_turn'));
  const turn = await waitFor(async () => (await events()).find((e) => e.summary.includes('Team alpha shipped')), 'team alpha turn');
  assert.equal(turn.project, 'team-alpha');
  assert.ok(!(await events('&project=alpha')).some((e) => e.summary.includes('Team alpha shipped')));
});

test('repositories in a grouping folder, and ones added by hand, are found', async () => {
  await waitFor(async () => (await get('/api/projects')).projects.find((x) => x.name === 'delta'), 'nested delta');
  await waitFor(async () => (await get('/api/projects')).projects.find((x) => x.name === 'zeta'), 'added zeta');
});

test('a project you stopped following gets no new posts', async () => {
  const hidden = repo('hidden', true, path.join(tmp, 'elsewhere'));
  const dir = path.join(claude, 'projects', '-x-elsewhere-hidden');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'h.jsonl'), assistant(hidden, 'hidden-1', 'Hidden work.', 'end_turn') + assistant(globalThis.alphaDir, 'marker-1', 'Marker after hidden.', 'end_turn'));
  await waitFor(async () => (await events()).find((e) => e.summary.includes('Marker after hidden')), 'marker');
  await sleep(1500);
  assert.ok(!(await events()).some((e) => e.summary.includes('Hidden work') || e.project === 'hidden'));
  assert.ok(!(await get('/api/projects')).projects.some((x) => x.name === 'hidden'));
});

test('a session line bigger than the read chunk does not stall the collector', async () => {
  const dir = path.join(claude, 'projects', '-x-alpha');
  fs.mkdirSync(dir, { recursive: true });
  const huge = line({ type: 'assistant', cwd: globalThis.alphaDir, sessionId: 'giant-1', timestamp: new Date().toISOString(), isSidechain: false, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'x'.repeat(9 * 1024 * 1024) }] } });
  fs.writeFileSync(path.join(dir, 'giant.jsonl'), huge + assistant(globalThis.alphaDir, 'giant-1', 'Survived the giant line.', 'end_turn'));
  await waitFor(async () => (await events('&project=alpha')).find((e) => e.summary.includes('Survived the giant line')), 'turn after a giant line', 20000);
});

test('survives a restart without re-posting old turns', async () => {
  const before = (await events()).length;
  collector.kill();
  await sleep(300);
  collector = spawn('node', [path.join(root, 'collector/index.js')], {
    env: { ...baseEnv, HOME: tmp, AGENTSBUZZ_URL: BASE, PROJECTS_DIR: projects, HOST_PROJECTS: projects, CLAUDE_DIR: claude, CODEX_DIR: codex, STATE_FILE: path.join(tmp, 'state.json'), EXTRA_REPOS: path.join(tmp, 'manual', 'zeta'), IGNORE_PROJECTS: 'hidden', POLL_MS: '200', GIT_POLL_MS: '300', DISCOVER_MS: '600', QUIET_MS: '700' },
    stdio: 'ignore',
  });
  await sleep(2500);
  assert.equal((await events()).length, before);
});
