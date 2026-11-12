#!/usr/bin/env node
// Follows main: when new commits land on origin/main, test them, fast-forward this checkout, and
// restart agentsbuzz on the new code. Every outcome is posted to the feed, so you know from your
// phone when a merge is live, or why it is not.
//
// Opt in with `./buzz follow on`. Safety:
// - only ever fast-forwards: never merges, rebases, resets or overwrites your local changes
// - only when this checkout is on main; on any other branch it waits
// - the new commit's tests run in a separate scratch checkout first, so a broken merge never
//   reaches the code that is running
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { post, projectFromDir } from '../lib/client.js';

const env = process.env;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const DIR = env.FOLLOW_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REMOTE = env.FOLLOW_REMOTE || 'origin';
const BRANCH = env.FOLLOW_BRANCH || 'main';
const POLL_MS = num(env.FOLLOW_POLL_MS, 60 * 1000);
const TEST_TIMEOUT_MS = num(env.FOLLOW_TEST_TIMEOUT_MS, 15 * 60 * 1000);
// Testing knobs: what proves a commit good, and how to restart. Defaults: the suite, then ./buzz restart.
const TEST_CMD = env.FOLLOW_TEST_CMD ? JSON.parse(env.FOLLOW_TEST_CMD) : [process.execPath, '--test', 'test/*.test.js']; // same as npm test
const RESTART_CMD = env.FOLLOW_RESTART_CMD ? JSON.parse(env.FOLLOW_RESTART_CMD) : [process.execPath, path.join(DIR, 'cli', 'launcher.js'), 'restart', '--quiet'];
const PROJECT = projectFromDir(DIR);

const log = (m) => console.log(`${new Date().toTimeString().slice(0, 8)} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// GIT_OPTIONAL_LOCKS=0: checking status every minute must never take the index lock, or your own
// git commands in this checkout would now and then fail with "index.lock: File exists".
const GIT_ENV = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' };
function git(...args) {
  return execFileSync('git', ['-C', DIR, ...args], { env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim();
}
const tryGit = (...args) => {
  try {
    return { ok: true, out: git(...args) };
  } catch (e) {
    return { ok: false, out: `${e.stderr || ''}${e.stdout || ''}`.trim() || e.message };
  }
};

// Say each problem once per commit, not once a minute.
const said = new Set();
// Commits whose tests failed: not tested again every minute. The next commit on main gets its own try.
const rejected = new Set();
async function tell(key, event) {
  if (said.has(key)) return;
  try {
    await post({ project: PROJECT, harness: 'buzz', agent: 'follow main', session_id: 'buzz-follow', ...event });
    said.add(key);
  } catch (e) {
    log(`could not post to the feed: ${e.message}`);
  }
}

// Run the tests of `sha` in a scratch checkout of it, never in the live one.
function testCommit(sha) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'buzz-follow-'));
  try {
    git('worktree', 'add', '--detach', '--quiet', scratch, sha);
    const testEnv = { ...env };
    delete testEnv.AGENTSBUZZ_TOKEN; // the tests start their own servers
    delete testEnv.AGENTSBUZZ_URL;
    delete testEnv.NODE_TEST_CONTEXT; // set when this itself runs under node --test; it changes the output format
    const r = spawnSync(TEST_CMD[0], TEST_CMD.slice(1), { cwd: scratch, env: testEnv, encoding: 'utf8', timeout: TEST_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    // A run that found no tests also exits 0: that proves nothing, so it does not count as passing.
    const ran = Number((out.match(/(?:ℹ|#) tests (\d+)/) || [])[1] || 0);
    if (r.status === 0 && !ran) return { ok: false, tail: `No tests ran (${TEST_CMD.slice(1).join(' ')} found nothing to run).` };
    return { ok: r.status === 0, tail: r.error ? r.error.message : out.split('\n').filter((l) => /✖|not ok|fail|Error/i.test(l)).slice(-12).join('\n') || out.slice(-1200) };
  } finally {
    tryGit('worktree', 'remove', '--force', scratch);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export async function check() {
  const fetched = tryGit('fetch', '--quiet', REMOTE, BRANCH);
  if (!fetched.ok) return log(`fetch failed: ${fetched.out.slice(-200)}`);
  const local = git('rev-parse', 'HEAD');
  const remote = git('rev-parse', `${REMOTE}/${BRANCH}`);
  if (local === remote) return;
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const short = remote.slice(0, 7);
  if (branch !== BRANCH) {
    return tell(`branch:${remote}`, { kind: 'note', summary: `${BRANCH} has new commits (${short}), but this checkout is on ${branch}, so it was not deployed. Switch back to ${BRANCH} to follow it again.` });
  }
  if (tryGit('merge-base', '--is-ancestor', remote, local).ok) return; // you are ahead: nothing to take
  // What restarts must be exactly what was tested: no edited, staged or new files in the checkout.
  const dirty = git('status', '--porcelain').split('\n').filter(Boolean);
  if (dirty.length) {
    const files = dirty.slice(0, 5).map((l) => l.replace(/^\s*\S{1,2}\s+/, '')) /* git() trims the first line's leading space */.join(', ') + (dirty.length > 5 ? ` and ${dirty.length - 5} more` : '');
    return tell(`dirty:${remote}:${dirty.join('|')}`, { kind: 'error', summary: `Not deployed ${short}: this checkout has uncommitted changes (${files}), and a restart would run them untested. Commit, stash or discard them and it deploys on the next check.` });
  }
  if (!tryGit('merge-base', '--is-ancestor', local, remote).ok) {
    return tell(`diverged:${remote}`, { kind: 'error', summary: `Not deployed ${short}: this checkout has commits that are not on ${REMOTE}/${BRANCH}, so it cannot fast-forward. Nothing was changed.` });
  }
  if (rejected.has(remote)) return;
  const commits = git('log', '--format=%h %s', `${local}..${remote}`).split('\n').filter(Boolean);
  log(`${commits.length} new commit${commits.length === 1 ? '' : 's'} on ${BRANCH}; testing ${short}`);
  const t = testCommit(remote);
  if (!t.ok) {
    rejected.add(remote);
    log(`tests failed for ${short}`);
    return tell(`tests:${remote}`, { kind: 'error', summary: `Not deployed ${short}: its tests failed. Still running ${local.slice(0, 7)}.`, body: t.tail.slice(-1500) });
  }
  // The tests take a while: make sure nothing moved under us meanwhile (a branch switch, a commit).
  const onBranch = () => git('rev-parse', '--abbrev-ref', 'HEAD') === BRANCH;
  if (!onBranch() || git('rev-parse', 'HEAD') !== local) {
    log(`checkout changed while testing ${short}; trying again on the next check`);
    return tell(`moved:${remote}:${git('rev-parse', '--abbrev-ref', 'HEAD')}`, { kind: 'note', summary: `Did not deploy ${short} yet: the checkout changed while its tests ran (now on ${git('rev-parse', '--abbrev-ref', 'HEAD')}). It is tried again on the next check.` });
  }
  const ff = tryGit('merge', '--ff-only', '--quiet', remote);
  if (!ff.ok) {
    log(`fast-forward failed: ${ff.out.slice(-200)}`);
    return tell(`ff:${remote}`, { kind: 'error', summary: `Not deployed ${short}: could not fast-forward (local changes in the way?). Nothing was changed.`, body: ff.out.slice(-1500) });
  }
  const matches = () => onBranch() && git('rev-parse', 'HEAD') === remote && !git('status', '--porcelain');
  if (!matches()) {
    return tell(`mismatch:${remote}`, { kind: 'error', summary: `Not restarting on ${short}: after the fast-forward the checkout does not match the tested commit exactly.` });
  }
  log(`deployed ${short}; restarting`);
  await tell(`deployed:${remote}`, {
    kind: 'milestone',
    summary: `Deployed ${short} (${commits.length} new commit${commits.length === 1 ? '' : 's'}): ${commits[0].slice(8)}`,
    body: commits.map((c) => `- ${c}`).join('\n'),
  });
  // Check once more right before restarting, so nothing edited while the post was sent gets run.
  // (The restart itself reads files for about a second; an edit inside that window is your own
  // hand on the checkout, not something this guards against: anyone who can edit these files can
  // already run code as you. The point is never to restart your uncommitted work by accident.)
  if (!matches()) {
    log(`checkout changed before the restart; not restarting on ${short}`);
    return tell(`changed:${remote}`, { kind: 'error', summary: `Did not restart on ${short}: the checkout changed while deploying. Still running the previous code; commit, stash or discard the change and run ./buzz restart.` });
  }
  // Detached, because the restart stops this process too and then starts a fresh one on the new code.
  spawn(RESTART_CMD[0], RESTART_CMD.slice(1), { cwd: DIR, detached: true, stdio: 'ignore', env }).unref();
}

async function main() {
  log(`following ${REMOTE}/${BRANCH} in ${DIR} (every ${Math.round(POLL_MS / 1000)}s)`);
  for (;;) {
    try {
      await check();
    } catch (e) {
      log(`error: ${e.message}`);
    }
    await sleep(POLL_MS);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
