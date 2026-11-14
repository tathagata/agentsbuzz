#!/usr/bin/env node
// Wakes idle agents. When you leave a message for a session that has stopped, this resumes that
// session in the background with your message, using the agent's own command:
//   claude --resume <session> -p "<message>"      (Claude Code)
//   codex exec resume <session> "<message>"       (Codex)
// The agent runs exactly as it would if you had resumed it yourself: same project folder, same
// permission settings. Nothing is bypassed. A session that is still active is left alone, because
// its hook (or get_messages tool) hands it the message at its next turn.
// A note on a whole project wakes the agent that worked there last.
//
// Opt in with `./buzz wake on`. Runs on your computer, so it is not available in the Docker setup.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, post, claimReplies, requeueReplies, formatMessages } from '../lib/client.js';

const env = process.env;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const POLL_MS = num(env.AGENTSBUZZ_WAKE_POLL_MS, 4000);
const IDLE_MS = num(env.AGENTSBUZZ_WAKE_IDLE_MS, 90 * 1000); // no activity for this long counts as idle
const RUN_LIMIT_MS = num(env.AGENTSBUZZ_WAKE_RUN_LIMIT_MS, 30 * 60 * 1000);
const STATE_FILE = env.STATE_FILE || path.join(os.homedir(), '.agentsbuzz', 'collector-state.json');
const PROJECTS_DIR = env.PROJECTS_DIR || '';
const HOME = os.homedir();

const log = (m) => console.log(`${new Date().toTimeString().slice(0, 8)} ${m}`); // local time, like the rest of your clock
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every file matching dir/<glob>/rest, newest version first. Version folders (nvm's v24.4.1, the
// editor extension's openai.chatgpt-26.1021.22027-...) sort by their numbers, not as text.
const verKey = (s) => (s.match(/\d+/g) || []).map(Number);
const newer = (a, b) => {
  const x = verKey(a);
  const y = verKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
  return 0;
};
export function globDir(dir, prefix, rest) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix));
  } catch {
    return [];
  }
  return names.sort(newer).map((n) => path.join(dir, n, ...rest));
}

// Where the commands live. PATH comes first, but a background service often has a different PATH
// from your terminal: nvm puts global npm commands under one Node version's folder, the native
// installer uses ~/.local/bin, and Codex may only exist inside the VS Code or Cursor extension.
const nvmDirs = [env.NVM_DIR && path.join(env.NVM_DIR, 'versions', 'node'), path.join(HOME, '.nvm', 'versions', 'node'), path.join(HOME, '.config', 'nvm', 'versions', 'node')].filter(Boolean);
const nodeBins = (name) => [...new Set(nvmDirs)].flatMap((d) => globDir(d, 'v', ['bin', name]));
const extBins = () =>
  ['.vscode', '.vscode-insiders', '.cursor', '.windsurf'].flatMap((e) =>
    globDir(path.join(HOME, e, 'extensions'), 'openai.chatgpt-', ['bin']).flatMap((b) => globDir(b, '', ['codex']))
  );
export const CLIS = {
  'claude-code': {
    name: 'claude',
    override: 'AGENTSBUZZ_CLAUDE_BIN',
    candidates: () => [
      'claude',
      path.join(HOME, '.local', 'bin', 'claude'),
      path.join(HOME, '.claude', 'local', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      path.join(HOME, '.volta', 'bin', 'claude'),
      path.join(HOME, '.bun', 'bin', 'claude'),
      ...nodeBins('claude'),
    ],
    args: (sid, text) => ['--resume', sid, '-p', text],
  },
  codex: {
    name: 'codex',
    override: 'AGENTSBUZZ_CODEX_BIN',
    candidates: () => [
      'codex',
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      path.join(HOME, '.local', 'bin', 'codex'),
      path.join(HOME, '.volta', 'bin', 'codex'),
      ...nodeBins('codex'),
      ...extBins(),
    ],
    args: (sid, text) => ['exec', 'resume', sid, text],
  },
};

// Found commands are kept while they still exist (an editor update deletes the old extension folder,
// so a vanished path means look again). A miss is retried after a minute, so installing one later just works.
const binCache = new Map();
const MISS_MS = 60 * 1000;
const gone = (bin) => bin.includes('/') && !fs.existsSync(bin);
export function findBin(kind) {
  const hit = binCache.get(kind);
  if (hit && hit.bin && !gone(hit.bin)) return hit.bin;
  if (hit && !hit.bin && Date.now() - hit.at < MISS_MS) return '';
  const cli = CLIS[kind];
  const list = env[cli.override] ? [env[cli.override]] : cli.candidates();
  let bin = '';
  for (const c of list) {
    if (c.includes('/') && !fs.existsSync(c)) continue;
    const r = spawnSync(c, ['--version'], { stdio: 'ignore', timeout: 15000 });
    if (!r.error && r.status === 0) {
      bin = c;
      break;
    }
  }
  binCache.set(kind, { bin, at: Date.now() });
  return bin;
}

async function api(p) {
  const { url, token } = config();
  const res = await fetch(`${url}${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`agentsbuzz ${res.status}`);
  return res.json();
}

// Session ids and project names arrive through the API, and a session id lands on the agent's
// command line. Real ids are UUID-like; anything else (above all, anything starting with "-",
// which the command would read as an option such as a looser sandbox) is never run.
export const safeSessionId = (sid) => typeof sid === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(sid);
// A project name may only ever name a folder directly inside the projects folder.
export function projectDir(root, project) {
  if (!root || typeof project !== 'string' || !project || project === '.' || project === '..' || /[\\/\0]/.test(project)) return '';
  const dir = path.resolve(root, project);
  return path.dirname(dir) === path.resolve(root) ? dir : '';
}

// Where did this session run? The collector remembers the folder each session started in.
function sessionCwd(sid, project) {
  try {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const f of Object.values(st.files || {})) if (f.session === sid && f.cwd && fs.existsSync(f.cwd)) return f.cwd;
  } catch {
    /* no state yet */
  }
  for (const root of PROJECTS_DIR.split(path.delimiter).filter(Boolean)) {
    const guess = projectDir(root, project);
    if (guess && fs.existsSync(guess)) return guess;
  }
  return '';
}

const busy = new Set();
// Sessions whose command failed outright (for example the session no longer exists). Not tried again
// while this service runs, so a broken session cannot turn into a retry loop.
const failed = new Set();
const warned = new Set();
const warnOnce = (key, msg) => {
  if (warned.has(key)) return;
  warned.add(key);
  log(msg);
};

function run(bin, args, cwd) {
  return new Promise((resolve) => {
    let tail = '';
    // Its own process group, so the time limit stops the agent and everything it started: a tool
    // still running would otherwise hold the output open and keep the wake going past the limit.
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env, detached: true });
    const stop = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* already gone */
      }
    };
    const keep = (d) => (tail = `${tail}${d}`.slice(-600));
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    let force;
    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      force = setTimeout(() => stop('SIGKILL'), 10000); // ignored SIGTERM? then it goes
      force.unref();
    }, RUN_LIMIT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, tail: e.message, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(force);
      resolve({ code, tail: tail.trim(), timedOut });
    });
  });
}

// A message we cannot act on stays queued (the agent still gets it the next time it runs), but you
// hear about it once in the feed instead of watching "Waiting for the agent" forever.
// It counts as said only once the post lands: a failed post throws, and the next poll tries again.
const reported = new Set();
async function cannot(sid, latest, why) {
  if (reported.has(sid)) return;
  warnOnce(`cannot:${sid}`, `cannot wake session ${sid.slice(0, 8)}: ${why}`);
  await post({
    project: latest.project,
    harness: latest.harness,
    agent: latest.agent,
    session_id: sid,
    kind: 'error',
    summary: `Could not wake the agent: ${why}. Your message is still waiting for its next run.`,
  });
  reported.add(sid);
}

async function wake(sid, latest) {
  if (!safeSessionId(sid)) return warnOnce(`sid:${sid}`, `not waking a session with an unexpected id: ${JSON.stringify(sid).slice(0, 60)}`);
  const cli = CLIS[latest.harness];
  const bin = findBin(latest.harness);
  if (!bin) return cannot(sid, latest, `the ${cli.name} command was not found on this computer (set ${cli.override} to its full path)`);
  const cwd = sessionCwd(sid, latest.project);
  if (!cwd) return cannot(sid, latest, 'its project folder was not found');

  // Claims the session's own messages and any project-wide notes. Atomic: the hook cannot take the same message.
  const msgs = await claimReplies({ session_id: sid, project: latest.project, via: 'wake' });
  if (!msgs.length) return;
  const base = { project: latest.project, harness: latest.harness, agent: latest.agent, session_id: sid };
  log(`waking ${latest.harness} session ${sid.slice(0, 8)} in ${cwd} (${msgs.length} message${msgs.length === 1 ? '' : 's'})`);
  await post({ ...base, kind: 'note', summary: `Woke the agent with your message: ${msgs.map((m) => m.prompt).join(' / ').slice(0, 200)}` }).catch(() => {});

  // The text always starts with "Message", so the command never mistakes it for an option.
  const { code, tail, timedOut } = await run(bin, cli.args(sid, formatMessages(msgs)), cwd);
  const said = msgs.map((m) => m.prompt).join(' / ').slice(0, 200);
  if (timedOut) {
    // The agent did get the message and worked on it; it was stopped at the time limit. Running it
    // again would only repeat the same work, so the message stays delivered.
    const mins = Math.round(RUN_LIMIT_MS / 60000);
    log(`session ${sid.slice(0, 8)} stopped at the ${mins} minute limit`);
    await post({
      ...base,
      kind: 'error',
      summary: `The agent worked on your message for ${mins} minutes and was stopped at the time limit (AGENTSBUZZ_WAKE_RUN_LIMIT_MS). Your message: ${said}`,
      body: tail.slice(-1500),
    }).catch(() => {});
  } else if (code !== 0) {
    // The agent never got to the message: give it back, so it is not shown as delivered when it was not.
    failed.add(sid);
    log(`wake failed (exit ${code}): ${tail.slice(-200)}`);
    const back = await requeueReplies(msgs.map((m) => m.id)).then((r) => r.length, () => 0);
    await post({
      ...base,
      kind: 'error',
      summary: back
        ? `Could not wake the agent (${cli.name} exited ${code}). Your message is back in the queue for this session's next run, and after 30 minutes the next agent on the project can take it: ${said}`
        : `Could not wake the agent (${cli.name} exited ${code}). Your message: ${said}`,
      body: tail.slice(-1500),
    }).catch(() => {});
  } else {
    log(`session ${sid.slice(0, 8)} finished`);
  }
}

// A note left on a whole project (not a particular session) goes to the agent that worked there last,
// unless some agent there is still active: that one picks it up through its hook.
async function projectTarget(project) {
  const { events } = await api(`/api/events?project=${encodeURIComponent(project)}&limit=40`);
  const agents = events.filter((e) => CLIS[e.harness] && e.session_id);
  if (!agents.length) return null;
  const newest = Math.max(...agents.map((e) => e.ts));
  if (Date.now() - newest < IDLE_MS) return null;
  return agents.find((e) => e.ts === newest);
}

async function tick() {
  // A message can run an agent, so never act on one from a server anyone could post to.
  const health = await api('/api/health');
  if (!health.auth) return warnOnce('noauth', 'not waking agents: the server has no token, so anyone who can reach it could send a message. Start it with ./buzz (it sets one), or set AGENTSBUZZ_TOKEN.');
  const { replies } = await api('/api/replies');
  const bySession = new Map();
  const projects = new Set();
  for (const r of replies) {
    if (r.session_id) {
      if (!busy.has(r.session_id) && !failed.has(r.session_id)) bySession.set(r.session_id, r);
    } else if (r.project) projects.add(r.project);
  }
  const start = (sid, latest) => {
    busy.add(sid);
    wake(sid, latest)
      .catch((e) => log(`wake error: ${e.message}`))
      .finally(() => busy.delete(sid));
  };
  for (const sid of bySession.keys()) {
    const { events } = await api(`/api/events?session_id=${encodeURIComponent(sid)}&limit=1`);
    const latest = events[0];
    if (!latest || !CLIS[latest.harness]) continue; // unknown session, or git: nothing to resume
    if (Date.now() - latest.ts < IDLE_MS) continue; // still active: its hook will deliver
    start(sid, latest);
  }
  for (const project of projects) {
    const latest = await projectTarget(project);
    if (!latest || busy.has(latest.session_id) || failed.has(latest.session_id)) continue;
    start(latest.session_id, latest);
  }
}

async function main() {
  log(`wake service started (idle after ${Math.round(IDLE_MS / 1000)}s)`);
  for (const kind of Object.keys(CLIS)) log(`${CLIS[kind].name}: ${findBin(kind) || 'not found'}`);
  for (;;) {
    try {
      await tick();
    } catch (e) {
      if (!/agentsbuzz|fetch|abort|timeout/i.test(e.message)) log(`error: ${e.message}`);
    }
    await sleep(POLL_MS);
  }
}

// run as a service; importing it (tests) only loads the helpers
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) await main();
