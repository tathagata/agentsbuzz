import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzw-'));
const stubs = path.join(home, 'stubs');
const log = path.join(home, 'stub.log');
const PORT = 22000 + Math.floor(Math.random() * 900);
const env = {
  ...process.env,
  HOME: home,
  AGENTSBUZZ_HOME: path.join(home, '.agentsbuzz'),
  PATH: `${stubs}:${process.env.PATH}`,
  STUB_LOG: log,
  STUB_DIR: stubs,
  AGENTSBUZZ_WAKE_IDLE_MS: '3000',
  AGENTSBUZZ_WAKE_POLL_MS: '250',
  AGENTSBUZZ_WAKE_RUN_LIMIT_MS: '2000',
};
delete env.AGENTSBUZZ_TOKEN;
delete env.AGENTSBUZZ_URL;

// stand-ins for the real commands: record how they were called
fs.mkdirSync(stubs, { recursive: true });
for (const name of ['claude', 'codex']) {
  fs.writeFileSync(path.join(stubs, name), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo stub; exit 0; fi\nprintf '%s|%s|%s\\n' "${name}" "$PWD" "$(printf '%s' "$*" | tr '\\n' ' ')" >> "$STUB_LOG"\n[ -f "$STUB_DIR/fail" ] && { echo "boom" >&2; exit 3; }\n[ -f "$STUB_DIR/slow" ] && sleep 30\nexit 0\n`, { mode: 0o755 });
}
const projects = path.join(home, 'code');
fs.mkdirSync(path.join(projects, 'alpha', '.git'), { recursive: true });

function buzz(...args) {
  return new Promise((resolve) => {
    const p = spawn(path.join(root, 'buzz'), args, { env, cwd: root });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}
let base;
let auth;
const api = async (p, opts = {}) => (await fetch(base + p, { ...opts, headers: { ...auth, 'content-type': 'application/json' } })).json();
const send = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body) });
const stubCalls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
const until = async (fn, what, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};
const old = () => Date.now() - 10 * 60 * 1000;
async function ask(session, harness, text, ts = old(), project = 'alpha') {
  await send('/api/events', { project, harness, agent: harness, session_id: session, kind: 'done', summary: `done in ${session}`, ts });
  const ev = (await api(`/api/events?session_id=${session}`)).events[0];
  return (await send(`/api/events/${ev.id}/reply`, { prompt: text })).id;
}
const reply = async (id) => (await api('/api/replies?all=1')).replies.find((r) => r.id === id);

test('start with waking on', async () => {
  const r = await buzz('--no-open', '--no-phone', '--projects', projects, '--port', String(PORT));
  assert.equal(r.code, 0, r.out);
  const w = await buzz('wake', 'on', '--yes');
  assert.match(w.out, /on\./, w.out);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.agentsbuzz', 'config.json'), 'utf8'));
  base = `http://127.0.0.1:${cfg.port}`;
  auth = { authorization: `Bearer ${cfg.token}` };
  const h = await api('/api/health');
  assert.equal(h.wake, true);
});

test('a message for an idle Claude Code session resumes it, in its project folder', async () => {
  const id = await ask('wk-claude', 'claude-code', 'please add the tests');
  const call = await until(() => stubCalls().find((l) => l.startsWith('claude|')), 'claude to be woken');
  const [, cwd, args] = call.split('|');
  assert.equal(fs.realpathSync(cwd), fs.realpathSync(path.join(projects, 'alpha')));
  assert.match(args, /^--resume wk-claude -p /);
  assert.match(args, /please add the tests/);
  const r = await until(async () => (await reply(id)).delivered && (await reply(id)), 'delivered');
  assert.equal(r.delivered_via, 'wake');
  const notes = (await api('/api/events?session_id=wk-claude')).events;
  assert.ok(notes.some((e) => e.summary.startsWith('Woke the agent with your message')));
});

test('a message for an idle Codex session uses codex exec resume', async () => {
  await ask('wk-codex', 'codex', 'rename the helper');
  const call = await until(() => stubCalls().find((l) => l.startsWith('codex|')), 'codex to be woken');
  assert.match(call.split('|')[2], /^exec resume wk-codex /);
  assert.match(call, /rename the helper/);
});

test('an active session is left alone (its hook delivers instead)', async () => {
  const id = await ask('wk-busy', 'claude-code', 'do not wake me', Date.now());
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(stubCalls().some((l) => l.includes('wk-busy')), false);
  assert.equal((await reply(id)).delivered, 0);
});

test('a note on a whole project wakes the agent that worked there last', async () => {
  const proj = 'beta';
  fs.mkdirSync(path.join(projects, proj, '.git'), { recursive: true });
  await send('/api/events', { project: proj, harness: 'claude-code', agent: 'claude-code', session_id: 'wk-proj', kind: 'done', summary: 'earlier work', ts: old() });
  const row = await send(`/api/projects/${proj}/reply`, { prompt: 'pick up the next step' });
  assert.equal(row.session_id, '');
  const call = await until(() => stubCalls().find((l) => l.includes('wk-proj')), 'project note to wake the last agent');
  assert.match(call, /pick up the next step/);
  const r = await until(async () => (await reply(row.id)).delivered && (await reply(row.id)), 'delivered');
  assert.equal(r.delivered_via, 'wake');
});

test('a reply on a commit becomes a project note and is not lost', async () => {
  const id = await ask('git:alpha:2026-11-09', 'git', 'remember to squash');
  assert.equal((await reply(id)).session_id, '');
});

test('a failed wake gives the message back, says so in the feed, and does not retry in a loop', async () => {
  fs.writeFileSync(path.join(stubs, 'fail'), '');
  const id = await ask('wk-fail', 'claude-code', 'try this');
  const err = await until(async () => (await api('/api/events?session_id=wk-fail')).events.find((e) => e.kind === 'error'), 'error event');
  assert.match(err.summary, /Could not wake the agent/);
  assert.match(err.summary, /back in the queue/);
  assert.match(err.summary, /try this/);
  const r = await until(async () => { const x = await reply(id); return !x.delivered && x; }, 'message requeued');
  assert.equal(r.delivered_via, '');
  await new Promise((r2) => setTimeout(r2, 1500)); // several polls: the broken session is not woken again
  assert.equal(stubCalls().filter((l) => l.includes('wk-fail')).length, 1);
  fs.rmSync(path.join(stubs, 'fail'));
});

test('an agent stopped at the time limit keeps the message delivered: it did get it, and is not rerun', async () => {
  fs.writeFileSync(path.join(stubs, 'slow'), '');
  const id = await ask('wk-slow', 'claude-code', 'a long job');
  const err = await until(async () => (await api('/api/events?session_id=wk-slow')).events.find((e) => e.kind === 'error'), 'time limit post');
  fs.rmSync(path.join(stubs, 'slow'));
  assert.match(err.summary, /stopped at the time limit/);
  assert.match(err.summary, /a long job/);
  const r = await reply(id);
  assert.equal(r.delivered, 1);
  assert.equal(r.delivered_via, 'wake');
  await new Promise((r2) => setTimeout(r2, 1000));
  assert.equal(stubCalls().filter((l) => l.includes('wk-slow')).length, 1);
});

test('wake off stops the service', async () => {
  const w = await buzz('wake', 'off');
  assert.match(w.out, /off\./);
  assert.equal((await api('/api/health')).wake, false);
});

after(async () => {
  await buzz('stop');
});
