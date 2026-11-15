// Follow main, end to end with real git: a bare repo stands in for GitHub, a clone is the checkout
// being followed, and a real feed server receives the posts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzf-'));
const PORT = 25000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-not-a-real-token';
const remote = path.join(tmp, 'remote.git');
const work = path.join(tmp, 'agentsbuzz'); // the followed checkout
const dev = path.join(tmp, 'dev'); // where "merges" are made and pushed
const restarts = path.join(tmp, 'restarts.log');
const base = { ...process.env, HOME: tmp, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
delete base.AGENTSBUZZ_TOKEN;
delete base.AGENTSBUZZ_URL;
// The follower works in the same checkout; a deploy's fast-forward holds the index lock for a moment.
// Like a person would, wait it out instead of failing.
function git(cwd, ...a) {
  for (let i = 0; ; i++) {
    try {
      return execFileSync('git', a, { cwd, env: base, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) {
      if (i < 40 && /index\.lock/.test(String(e.stderr))) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        continue;
      }
      throw e;
    }
  }
}
const okTest = "require('node:test')('fine', () => {});\n";
const badTest = "require('node:test')('broken', () => { throw new Error('nope'); });\n";
function commit(msg, testSrc) {
  fs.mkdirSync(path.join(dev, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dev, 'test', 'a.test.cjs'), testSrc);
  fs.writeFileSync(path.join(dev, 'notes.txt'), `${msg}\n`);
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', msg);
  git(dev, 'push', '-q', 'origin', 'main');
  return git(dev, 'rev-parse', 'HEAD');
}
const api = (p) => fetch(BASE + p, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());
const feed = async () => (await api('/api/events?session_id=buzz-follow&limit=50')).events;
const until = async (fn, what, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

let server;
let follower;
before(async () => {
  git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  git(tmp, 'clone', '-q', remote, dev);
  git(dev, 'checkout', '-q', '-b', 'main');
  commit('first', okTest);
  git(tmp, 'clone', '-q', remote, work);

  server = spawn(process.execPath, [path.join(root, 'server/server.js')], { env: { ...base, PORT: String(PORT), AGENTSBUZZ_TOKEN: TOKEN, AGENTSBUZZ_DB: path.join(tmp, 'f.db') }, stdio: 'ignore' });
  await until(async () => {
    try {
      return (await fetch(`${BASE}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } })).ok;
    } catch {
      return false;
    }
  }, 'server');
  follower = spawn(process.execPath, [path.join(root, 'cli/follow.js')], {
    env: {
      ...base,
      AGENTSBUZZ_URL: BASE,
      AGENTSBUZZ_TOKEN: TOKEN,
      FOLLOW_DIR: work,
      FOLLOW_POLL_MS: '300',
      FOLLOW_TEST_CMD: JSON.stringify([process.execPath, '--test', 'test/*.test.cjs']),
      FOLLOW_RESTART_CMD: JSON.stringify(['sh', '-c', `git rev-parse --short HEAD >> "${restarts}"`]),
    },
    stdio: ['ignore', fs.openSync(path.join(tmp, 'follow.log'), 'a'), 'ignore'],
  });
});
// Stop a follower and wait until it has exited, then delete its folders. A git command it started
// can still be finishing for a moment after it exits, so the delete retries instead of failing on a
// .git folder that just gained a file (ENOTEMPTY).
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill();
  await exited;
}
const rmTree = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });

after(async () => {
  await stop(follower);
  await stop(server);
  rmTree(tmp);
});
const restartLog = () => (fs.existsSync(restarts) ? fs.readFileSync(restarts, 'utf8').trim().split('\n').filter(Boolean) : []);

test('a new commit on main is tested, fast-forwarded, restarted on, and announced in the feed', async () => {
  const sha = commit('Add the thing', okTest);
  await until(() => git(work, 'rev-parse', 'HEAD') === sha, 'fast-forward');
  await until(() => restartLog().includes(sha.slice(0, 7)), 'restart on the new commit');
  const ev = await until(async () => (await feed()).find((e) => e.kind === 'milestone'), 'deployed post');
  assert.match(ev.summary, new RegExp(`^Deployed ${sha.slice(0, 7)} \\(1 new commit\\): Add the thing`));
  assert.equal(ev.project, 'agentsbuzz');
});

test('a commit whose tests fail is not deployed, and the feed says why, once', async () => {
  const before = git(work, 'rev-parse', 'HEAD');
  const bad = commit('Break it', badTest);
  const ev = await until(async () => (await feed()).find((e) => e.kind === 'error' && e.summary.includes(bad.slice(0, 7))), 'test failure post');
  assert.match(ev.summary, /its tests failed/);
  await new Promise((r) => setTimeout(r, 1500)); // several more polls
  assert.equal(git(work, 'rev-parse', 'HEAD'), before, 'the live checkout did not move');
  assert.equal((await feed()).filter((e) => e.summary.includes(bad.slice(0, 7))).length, 1, 'said once, not every poll');
  assert.ok(!restartLog().includes(bad.slice(0, 7)), 'no restart');
  const runs = fs.readFileSync(path.join(tmp, 'follow.log'), 'utf8').split('\n').filter((l) => l.includes(`testing ${bad.slice(0, 7)}`)).length;
  assert.equal(runs, 1, 'a failed commit is tested once, not every poll');
  assert.deepEqual(git(work, 'worktree', 'list').split('\n').length, 1, 'scratch checkouts are cleaned up');
});

test('the fix after a failure deploys', async () => {
  const fix = commit('Fix it', okTest);
  await until(() => git(work, 'rev-parse', 'HEAD') === fix, 'fast-forward to the fix');
  const ev = await until(async () => (await feed()).find((e) => e.kind === 'milestone' && e.summary.includes(fix.slice(0, 7))), 'deployed post');
  assert.match(ev.summary, /\(2 new commits\): Fix it/);
});

test('on another branch nothing is deployed; the feed says why', async () => {
  git(work, 'checkout', '-q', '-b', 'experiment');
  const sha = commit('While you were away', okTest);
  const ev = await until(async () => (await feed()).find((e) => e.summary.includes(sha.slice(0, 7))), 'branch note');
  assert.match(ev.summary, /on experiment, so it was not deployed/);
  assert.notEqual(git(work, 'rev-parse', 'HEAD'), sha);
  git(work, 'checkout', '-q', 'main');
  await until(() => git(work, 'rev-parse', 'HEAD') === sha, 'deploys once back on main');
});

test('local commits that are not on main block the fast-forward; nothing is changed', async () => {
  fs.writeFileSync(path.join(work, 'mine.txt'), 'local work\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'local only');
  const mine = git(work, 'rev-parse', 'HEAD');
  const sha = commit('Upstream change', okTest);
  const ev = await until(async () => (await feed()).find((e) => e.summary.includes(sha.slice(0, 7))), 'diverged post');
  assert.match(ev.summary, /cannot fast-forward/);
  assert.equal(git(work, 'rev-parse', 'HEAD'), mine, 'your commit is untouched');
});

test('a run that finds no tests does not count as passing', async () => {
  fs.rmSync(path.join(dev, 'test'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dev, 'notes.txt'), 'tests moved away\n');
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', 'Move the tests');
  git(dev, 'push', '-q', 'origin', 'main');
  const sha = git(dev, 'rev-parse', 'HEAD');
  git(work, 'reset', '-q', '--hard', 'origin/main~1'); // the local-only commit from the last test is gone; back on track
  const ev = await until(async () => (await feed()).find((e) => e.summary.includes(sha.slice(0, 7))), 'no-tests post');
  assert.match(ev.summary, /its tests failed/);
  assert.match(ev.body, /No tests ran/);
  assert.notEqual(git(work, 'rev-parse', 'HEAD'), sha);
});

test('uncommitted changes in the checkout block the deploy, so only tested code is restarted', async () => {
  git(work, 'reset', '-q', '--hard', 'origin/main'); // on track again after the earlier tests
  fs.writeFileSync(path.join(work, 'notes.txt'), 'an edit nobody tested\n'); // a tracked file the next commit does not touch
  fs.mkdirSync(path.join(dev, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dev, 'test', 'a.test.cjs'), okTest);
  fs.writeFileSync(path.join(dev, 'other.txt'), 'upstream\n');
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', 'Unrelated upstream change');
  git(dev, 'push', '-q', 'origin', 'main');
  const sha = git(dev, 'rev-parse', 'HEAD');
  const ev = await until(async () => (await feed()).find((e) => e.summary.includes(sha.slice(0, 7))), 'dirty post');
  assert.match(ev.summary, /uncommitted changes \(notes\.txt\)/);
  assert.notEqual(git(work, 'rev-parse', 'HEAD'), sha, 'not fast-forwarded');
  assert.ok(!restartLog().includes(sha.slice(0, 7)), 'not restarted');
  git(work, 'checkout', '-q', '--', 'notes.txt'); // discard the edit: the next check deploys
  await until(() => git(work, 'rev-parse', 'HEAD') === sha, 'deploys once clean');
});

test('an edit made while the deploy is being announced stops the restart', async () => {
  // A second, separate setup: its own "GitHub", checkout and a stand-in feed that edits the
  // checkout the moment the Deployed post arrives, before answering it.
  const http = await import('node:http');
  const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzf2-'));
  const r2 = path.join(t2, 'remote.git');
  const w2 = path.join(t2, 'agentsbuzz');
  const d2 = path.join(t2, 'dev');
  const log2 = path.join(t2, 'restarts.log');
  git(t2, 'init', '-q', '--bare', '-b', 'main', r2);
  git(t2, 'clone', '-q', r2, d2);
  git(d2, 'checkout', '-q', '-b', 'main');
  const push = (msg) => {
    fs.mkdirSync(path.join(d2, 'test'), { recursive: true });
    fs.writeFileSync(path.join(d2, 'test', 'a.test.cjs'), okTest);
    fs.writeFileSync(path.join(d2, 'n.txt'), `${msg}\n`);
    git(d2, 'add', '-A');
    git(d2, 'commit', '-q', '-m', msg);
    git(d2, 'push', '-q', 'origin', 'main');
    return git(d2, 'rev-parse', 'HEAD');
  };
  push('first');
  git(t2, 'clone', '-q', r2, w2);
  const posts = [];
  const feed2 = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const ev = JSON.parse(body || '{}');
      posts.push(ev);
      if (/^Deployed/.test(ev.summary || '')) fs.writeFileSync(path.join(w2, 'n.txt'), 'edited mid-deploy\n');
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"created":1,"ids":[1]}');
    });
  });
  await new Promise((r) => feed2.listen(0, '127.0.0.1', r));
  const f2 = spawn(process.execPath, [path.join(root, 'cli/follow.js')], {
    env: {
      ...base,
      AGENTSBUZZ_URL: `http://127.0.0.1:${feed2.address().port}`,
      AGENTSBUZZ_TOKEN: TOKEN,
      FOLLOW_DIR: w2,
      FOLLOW_POLL_MS: '300',
      FOLLOW_TEST_CMD: JSON.stringify([process.execPath, '--test', 'test/*.test.cjs']),
      FOLLOW_RESTART_CMD: JSON.stringify(['sh', '-c', `echo restarted >> "${log2}"`]),
    },
    stdio: 'ignore',
  });
  try {
    const sha = push('second');
    await until(() => posts.find((e) => /^Did not restart/.test(e.summary)), 'did-not-restart post');
    assert.ok(posts.some((e) => e.summary.startsWith(`Deployed ${sha.slice(0, 7)}`)));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(fs.existsSync(log2), false, 'no restart with the edit in place');
  } finally {
    await stop(f2);
    feed2.close();
    rmTree(t2);
  }
});

test('a branch switch while the tests run is noticed: the other branch is never fast-forwarded', async () => {
  const t3 = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzf3-'));
  const r3 = path.join(t3, 'remote.git');
  const w3 = path.join(t3, 'agentsbuzz');
  const d3 = path.join(t3, 'dev');
  const log3 = path.join(t3, 'restarts.log');
  git(t3, 'init', '-q', '--bare', '-b', 'main', r3);
  git(t3, 'clone', '-q', r3, d3);
  git(d3, 'checkout', '-q', '-b', 'main');
  const push = (msg) => {
    fs.mkdirSync(path.join(d3, 'test'), { recursive: true });
    fs.writeFileSync(path.join(d3, 'test', 'a.test.cjs'), okTest);
    fs.writeFileSync(path.join(d3, 'n.txt'), `${msg}\n`);
    git(d3, 'add', '-A');
    git(d3, 'commit', '-q', '-m', msg);
    git(d3, 'push', '-q', 'origin', 'main');
    return git(d3, 'rev-parse', 'HEAD');
  };
  const first = push('first');
  git(t3, 'clone', '-q', r3, w3);
  const f3 = spawn(process.execPath, [path.join(root, 'cli/follow.js')], {
    env: {
      ...base,
      AGENTSBUZZ_URL: BASE,
      AGENTSBUZZ_TOKEN: TOKEN,
      FOLLOW_DIR: w3,
      FOLLOW_POLL_MS: '300',
      // the "tests" switch the live checkout to another branch while they run, as a person might
      FOLLOW_TEST_CMD: JSON.stringify(['sh', '-c', `git -C "${w3}" checkout -q -B side && exec "${process.execPath}" --test 'test/*.test.cjs'`]),
      FOLLOW_RESTART_CMD: JSON.stringify(['sh', '-c', `echo restarted >> "${log3}"`]),
    },
    stdio: 'ignore',
  });
  try {
    const sha = push('second');
    const ev = await until(async () => (await feed()).find((e) => e.summary.includes(sha.slice(0, 7)) && /changed while its tests ran/.test(e.summary)), 'moved post');
    assert.match(ev.summary, /now on side/);
    assert.equal(git(w3, 'rev-parse', 'side'), first, 'the other branch was not fast-forwarded');
    assert.equal(fs.existsSync(log3), false, 'no restart');
  } finally {
    await stop(f3);
    rmTree(t3);
  }
});
