import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 17000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buzz-'));
let server;

const env = { ...process.env, AGENTSBUZZ_URL: BASE, AGENTSBUZZ_TOKEN: TOKEN, HOME: tmp };
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const get = (p) => fetch(`${BASE}${p}`, { headers: auth }).then((r) => r.json());

function run(file, { input = '', args = [] } = {}) {
  return new Promise((resolve) => {
    const p = spawn('node', [path.join(root, file), ...args], { env, cwd: tmp });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(input);
  });
}

before(async () => {
  server = spawn('node', [path.join(root, 'server/server.js')], {
    env: { ...env, PORT: String(PORT), AGENTSBUZZ_DB: path.join(tmp, 'test.db') },
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

after(() => server?.kill());

test('rejects requests without the token', async () => {
  const r = await fetch(`${BASE}/api/events`);
  assert.equal(r.status, 401);
});

test('serves the app shell without a token', async () => {
  const r = await fetch(`${BASE}/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /agentsbuzz/);
});

test('rejects path traversal', async () => {
  const r = await fetch(`${BASE}/..%2Fpackage.json`);
  assert.notEqual(r.status, 200);
});

test('validates events', async () => {
  const r = await fetch(`${BASE}/api/events`, { method: 'POST', headers: auth, body: JSON.stringify({ project: 'x' }) });
  assert.equal(r.status, 400);
});

test('stores events and streams them live', async () => {
  const ctl = new AbortController();
  const res = await fetch(`${BASE}/api/stream?token=${TOKEN}`, { signal: ctl.signal });
  const reader = res.body.getReader();
  const seen = (async () => {
    let buf = '';
    const dec = new TextDecoder();
    for (;;) {
      const { value } = await reader.read();
      buf += dec.decode(value);
      if (buf.includes('event: event')) return buf;
    }
  })();
  await new Promise((r) => setTimeout(r, 100));
  const post = await fetch(`${BASE}/api/events`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ project: 'trailmap', harness: 'claude-code', session_id: 's1', kind: 'milestone', summary: 'Rules engine green' }),
  });
  assert.equal(post.status, 201);
  assert.match(await seen, /Rules engine green/);
  ctl.abort();
  const { events } = await get('/api/events?project=trailmap');
  assert.equal(events.length, 1);
});

test('blocked events land in needs-you and can be resolved', async () => {
  await fetch(`${BASE}/api/events`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ project: 'latency-lab', kind: 'blocked', summary: 'Need the sample capture path', session_id: 's2' }),
  });
  let { events } = await get('/api/events?needs=1');
  assert.equal(events.length, 1);
  const r = await fetch(`${BASE}/api/events/${events[0].id}/resolve`, { method: 'POST', headers: auth });
  assert.equal((await r.json()).resolved, 1);
  ({ events } = await get('/api/events?needs=1'));
  assert.equal(events.length, 0);
});

test('queues a reply for a session', async () => {
  const { events } = await get('/api/events?project=trailmap');
  const r = await fetch(`${BASE}/api/events/${events[0].id}/reply`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ prompt: 'now add audit export' }),
  });
  assert.equal(r.status, 201);
  const { replies } = await get('/api/replies?session_id=s1');
  assert.equal(replies[0].prompt, 'now add audit export');
});

test('CLI posts an event', async () => {
  const r = await run('cli/buzz.js', { args: ['--kind', 'pr', '--project', 'cli-proj', 'Opened PR #12'] });
  assert.equal(r.code, 0, r.err);
  const { events } = await get('/api/events?project=cli-proj');
  assert.equal(events[0].kind, 'pr');
});

test('Claude Code hook maps Notification to a blocked event and Stop to done', async () => {
  const transcript = path.join(tmp, 't.jsonl');
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ type: 'user', message: { content: 'go' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Migrated 14 services to BuildCache.' }] } }),
    ].join('\n')
  );
  let r = await run('hooks/claude-code-hook.js', {
    input: JSON.stringify({ hook_event_name: 'Notification', session_id: 'h1', cwd: tmp, message: 'Claude needs permission to run rm' }),
  });
  assert.equal(r.code, 0);
  r = await run('hooks/claude-code-hook.js', {
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'h1', cwd: tmp, transcript_path: transcript }),
  });
  assert.equal(r.code, 0);
  const { events } = await get(`/api/events?session_id=h1`);
  const kinds = events.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['blocked', 'done']);
  assert.ok(events.find((e) => e.kind === 'done').summary.includes('BuildCache'));
  assert.equal(events.find((e) => e.kind === 'blocked').needs_you, 1);
});

test('hook exits 0 even when the server is unreachable', async () => {
  const r = await new Promise((resolve) => {
    const p = spawn('node', [path.join(root, 'hooks/claude-code-hook.js')], { env: { ...env, AGENTSBUZZ_URL: 'http://127.0.0.1:1' }, cwd: tmp });
    p.on('close', (code) => resolve(code));
    p.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'z', cwd: tmp }));
  });
  assert.equal(r, 0);
});

test('MCP server lists and calls post_update', async () => {
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'post_update', arguments: { summary: 'Tests green on gitops plane', kind: 'milestone', project: 'gitops' } } },
  ];
  const p = spawn('node', [path.join(root, 'mcp/server.js')], { env: { ...env, AGENTSBUZZ_HARNESS: 'codex' }, cwd: tmp });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stdin.write(msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
  for (let i = 0; i < 50 && out.trim().split('\n').length < 3; i++) await new Promise((r) => setTimeout(r, 100));
  p.kill();
  const lines = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.find((l) => l.id === 2).result.tools[0].name, 'post_update');
  assert.equal(lines.find((l) => l.id === 3).result.content[0].text, 'Posted.');
  const { events } = await get('/api/events?project=gitops');
  assert.equal(events[0].harness, 'codex');
});

// ---------- projects and plans ----------
const put = (name, body) =>
  fetch(`${BASE}/api/projects/${encodeURIComponent(name)}`, { method: 'PUT', headers: auth, body: JSON.stringify(body) });

test('events create their project automatically', async () => {
  const { projects } = await get('/api/projects');
  const fx = projects.find((p) => p.name === 'trailmap');
  assert.ok(fx, 'trailmap should exist from earlier events');
  assert.equal(fx.status, 'active');
  assert.equal(fx.last_win, 'Rules engine green');
  assert.ok(fx.total >= 1);
});

test('creates a project with a plan and validates input', async () => {
  let r = await put('side-idea', {
    description: 'A thing to try',
    status: 'idea',
    plan: [{ title: 'Sketch it', status: 'done' }, { title: 'Prototype', status: 'doing' }, { title: 'Show a friend', status: 'bogus' }],
  });
  assert.equal(r.status, 200);
  const p = await r.json();
  assert.deepEqual(p.plan.map((s) => s.status), ['done', 'doing', 'todo'], 'unknown step status falls back to todo');
  assert.equal(p.total, 0);
  assert.equal(p.last_ts, null);

  assert.equal((await put('side-idea', { status: 'nope' })).status, 400);
  assert.equal((await put('side-idea', { plan: 'not-an-array' })).status, 400);
  assert.equal((await put('side-idea', { plan: [{ title: '  ' }] })).status, 400);
});

test('partial updates keep other fields', async () => {
  const r = await put('side-idea', { focus: 'Wiring the first screen' });
  const p = await r.json();
  assert.equal(p.focus, 'Wiring the first screen');
  assert.equal(p.description, 'A thing to try');
  assert.equal(p.plan.length, 3);
});

test('project updates are streamed live', async () => {
  const ctl = new AbortController();
  const res = await fetch(`${BASE}/api/stream?token=${TOKEN}`, { signal: ctl.signal });
  const reader = res.body.getReader();
  const seen = (async () => {
    let buf = '';
    const dec = new TextDecoder();
    for (;;) {
      const { value } = await reader.read();
      buf += dec.decode(value);
      if (buf.includes('event: project')) return buf;
    }
  })();
  await new Promise((r) => setTimeout(r, 100));
  await put('side-idea', { status: 'active' });
  assert.match(await seen, /side-idea/);
  ctl.abort();
});

test('project names with spaces and slashes round-trip', async () => {
  const r = await put('my idea / v2', { status: 'idea' });
  assert.equal(r.status, 200);
  const got = await fetch(`${BASE}/api/projects/${encodeURIComponent('my idea / v2')}`, { headers: auth });
  assert.equal((await got.json()).name, 'my idea / v2');
});

test('unresolved needs-you counts show on the project', async () => {
  await fetch(`${BASE}/api/events`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ project: 'side-idea', kind: 'blocked', summary: 'Which framework?', session_id: 'q1' }),
  });
  const { projects } = await get('/api/projects');
  assert.equal(projects.find((p) => p.name === 'side-idea').needs, 1);
});

test('MCP update_project sets the plan', async () => {
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'update_project', arguments: { project: 'mcp-proj', status: 'active', focus: 'Writing tests', plan: [{ title: 'Scaffold', status: 'done' }, { title: 'Tests', status: 'doing' }] } },
    },
  ];
  const p = spawn('node', [path.join(root, 'mcp/server.js')], { env, cwd: tmp });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stdin.write(msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
  for (let i = 0; i < 50 && out.trim().split('\n').length < 3; i++) await new Promise((r) => setTimeout(r, 100));
  p.kill();
  const lines = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.find((l) => l.id === 2).result.tools.map((t) => t.name), ['post_update', 'update_project', 'get_messages']);
  assert.equal(lines.find((l) => l.id === 3).result.content[0].text, 'Project updated.');
  const got = await (await fetch(`${BASE}/api/projects/mcp-proj`, { headers: auth })).json();
  assert.equal(got.focus, 'Writing tests');
  assert.equal(got.plan[1].status, 'doing');
});

test('CLI project.js sets stage, focus and plan', async () => {
  const r = await run('cli/project.js', {
    args: ['cli-plan', '--status', 'active', '--focus', 'Shipping', '--plan', '[x] Design|[~] Build|Launch'],
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /1\/3 steps done/);
  const got = await (await fetch(`${BASE}/api/projects/cli-plan`, { headers: auth })).json();
  assert.deepEqual(got.plan.map((s) => s.status), ['done', 'doing', 'todo']);
});

// ---- messages left for agents ----
const postJson = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: auth, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
const claim = (body) => postJson('/api/replies/claim', body).then((r) => r.json.replies);

test('a message reaches its session once, and shows as delivered', async () => {
  await postJson('/api/events', { project: 'msgproj', session_id: 'ms1', kind: 'progress', summary: 'working' });
  const { events } = await get('/api/events?project=msgproj');
  const r = await postJson(`/api/events/${events[0].id}/reply`, { prompt: 'use the staging db' });
  assert.equal(r.status, 201);
  assert.deepEqual(await claim({ session_id: 'someone-else', project: '' }), [], 'other sessions do not get it');
  const got = await claim({ session_id: 'ms1', via: 'test' });
  assert.equal(got.length, 1);
  assert.equal(got[0].prompt, 'use the staging db');
  assert.equal(got[0].delivered, 1);
  assert.equal(got[0].delivered_via, 'test');
  assert.deepEqual(await claim({ session_id: 'ms1' }), [], 'handed out only once');
  const all = (await get('/api/replies?all=1')).replies.find((x) => x.id === r.json.id);
  assert.equal(all.delivered, 1);
});

test('a note for the project goes to the next agent that asks', async () => {
  const n = await postJson('/api/projects/msgproj/reply', { prompt: 'prefer small PRs' });
  assert.equal(n.status, 201);
  const got = await claim({ session_id: 'brand-new', project: 'msgproj' });
  assert.equal(got.length, 1);
  assert.equal(got[0].prompt, 'prefer small PRs');
  assert.deepEqual(await claim({ session_id: 'brand-new', project: 'msgproj' }), []);
});

test('a message for a session that is still active is not taken by another session', async () => {
  await postJson('/api/events', { project: 'busy', session_id: 'live-1', kind: 'progress', summary: 'working' });
  const { events } = await get('/api/events?project=busy');
  await postJson(`/api/events/${events[0].id}/reply`, { prompt: 'for live-1 only' });
  assert.deepEqual(await claim({ session_id: 'other', project: 'busy' }), []);
  assert.equal((await claim({ session_id: 'live-1' })).length, 1);
});

test('a message for a session that went quiet is handed to the next agent on the project', async () => {
  const old = Date.now() - 2 * 3600 * 1000;
  await postJson('/api/events', { project: 'quietproj', session_id: 'gone-1', kind: 'done', summary: 'finished', ts: old });
  const { events } = await get('/api/events?project=quietproj');
  await postJson(`/api/events/${events[0].id}/reply`, { prompt: 'continue with tests' });
  const got = await claim({ session_id: 'new-session', project: 'quietproj' });
  assert.equal(got.length, 1);
});

test('claim needs a session or project', async () => {
  assert.equal((await postJson('/api/replies/claim', {})).status, 400);
});

test('hook: Stop keeps the agent working when a message is waiting', async () => {
  const dir = path.join(tmp, 'hookproj');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  await postJson('/api/projects/hookproj/reply', { prompt: 'also update the README' });
  const r = await run('hooks/claude-code-hook.js', { input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'h1', cwd: dir }) });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.out.trim().split('\n')[0]);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /also update the README/);
  // the pickup is visible in the feed
  const evs = (await get('/api/events?project=hookproj')).events;
  assert.ok(evs.some((e) => e.summary.startsWith('Picked up your message')));
  // and a second Stop is quiet
  const r2 = await run('hooks/claude-code-hook.js', { input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'h1', cwd: dir }) });
  assert.equal(r2.out.trim(), '');
});

test('hook: a new prompt gets waiting messages as context', async () => {
  const dir = path.join(tmp, 'hookproj2');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  await postJson('/api/projects/hookproj2/reply', { prompt: 'check the CI config' });
  const r = await run('hooks/claude-code-hook.js', { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'h2', cwd: dir }) });
  const out = JSON.parse(r.out.trim());
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /check the CI config/);
});

test('MCP get_messages hands over waiting messages', async () => {
  const dir = path.join(tmp, 'mcpproj');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  await postJson('/api/projects/mcpproj/reply', { prompt: 'rename the module' });
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_messages', arguments: { project: 'mcpproj' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_messages', arguments: { project: 'mcpproj' } } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const r = await run('mcp/server.js', { input });
  const lines = r.out.trim().split('\n').map((l) => JSON.parse(l));
  assert.match(lines.find((l) => l.id === 2).result.content[0].text, /rename the module/);
  assert.match(lines.find((l) => l.id === 3).result.content[0].text, /No new messages/);
});
