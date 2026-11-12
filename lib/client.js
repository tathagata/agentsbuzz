// Shared poster used by the CLI, the Claude Code hook and the MCP server.
// Config: env vars win, then ~/.agentsbuzz.json ({ "url": "...", "token": "..." }).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fileConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.agentsbuzz.json'), 'utf8'));
  } catch {
    return {};
  }
}

export function config() {
  const f = fileConfig();
  return {
    url: (process.env.AGENTSBUZZ_URL || f.url || 'http://127.0.0.1:7777').replace(/\/$/, ''),
    token: process.env.AGENTSBUZZ_TOKEN || f.token || '',
  };
}

export async function post(event, { timeoutMs = 3000 } = {}) {
  const { url, token } = config();
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${url}/api/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`agentsbuzz ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function putProject(name, body, { timeoutMs = 3000 } = {}) {
  const { url, token } = config();
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${url}/api/projects/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`agentsbuzz ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function getProjects({ timeoutMs = 5000 } = {}) {
  const { url, token } = config();
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${url}/api/projects`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`agentsbuzz ${res.status}: ${await res.text()}`);
  return (await res.json()).projects;
}

// Project name = nearest git root's folder name, else the folder itself.
export function projectFromDir(dir) {
  let cur = path.resolve(dir || process.cwd());
  const start = cur;
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return path.basename(cur);
    const parent = path.dirname(cur);
    if (parent === cur) return path.basename(start) || 'default';
    cur = parent;
  }
}

// Ask for messages the developer left for this agent. Each message is handed out once.
export async function claimReplies({ session_id = '', project = '', via = 'agent' }, { timeoutMs = 2500 } = {}) {
  const { url, token } = config();
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${url}/api/replies/claim`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ session_id, project, via }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`agentsbuzz ${res.status}: ${await res.text()}`);
  return (await res.json()).replies;
}

// The wake service gives back messages it claimed but could not get to an agent.
export async function requeueReplies(ids, { timeoutMs = 2500 } = {}) {
  const { url, token } = config();
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${url}/api/replies/requeue`, { method: 'POST', headers, body: JSON.stringify({ ids }), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`agentsbuzz ${res.status}: ${await res.text()}`);
  return (await res.json()).replies;
}

export function formatMessages(replies) {
  const lines = replies.map((r) => `- ${r.prompt}`).join('\n');
  return `Message${replies.length === 1 ? '' : 's'} from the developer, left from their phone in agentsbuzz:\n${lines}`;
}
