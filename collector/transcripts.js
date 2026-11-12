// Follow coding-agent session files and turn finished turns into feed events.
import fs from 'node:fs';
import path from 'node:path';

import { oneLine, summarize } from '../lib/text.js';
export { oneLine };

// Map a session's working directory to a project name.
// Projects are the direct children of the projects folder. Worktrees (name.worktrees/x) fold into name.
export function mapProject(cwd, hostProjects) {
  if (!cwd) return '';
  const norm = cwd.replace(/\/+$/, '');
  const root = (hostProjects || '').replace(/\/+$/, '');
  let first = '';
  if (root && (norm === root || norm.startsWith(`${root}/`))) {
    first = norm.slice(root.length + 1).split('/')[0];
  }
  if (!first) first = path.basename(norm);
  return first.replace(/\.worktrees$/, '');
}

// Walk a folder to a limited depth and return files that pass the filter.
export function listFiles(dir, depth, accept) {
  const out = [];
  const walk = (d, left) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (left > 0) walk(full, left - 1);
      } else if (accept(full, e.name)) out.push(full);
    }
  };
  walk(dir, depth);
  return out;
}

// Read complete new lines from a file, starting at the stored offset. Returns parsed JSON objects.
export function readNewLines(file, st) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return [];
  }
  if (size < st.offset) st.offset = 0; // file was replaced or truncated
  if (size === st.offset) return [];
  const MAX = 8 * 1024 * 1024;
  const len = Math.min(size - st.offset, MAX);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, len, st.offset);
  } finally {
    fs.closeSync(fd);
  }
  const chunk = buf.toString('utf8');
  const lastNl = chunk.lastIndexOf('\n');
  if (lastNl < 0) {
    // A line longer than the whole chunk can never complete: step over it instead of waiting forever.
    if (len >= MAX) st.offset += len;
    return []; // otherwise a partial line: wait for the rest
  }
  st.offset += Buffer.byteLength(chunk.slice(0, lastNl + 1));
  const objs = [];
  for (const line of chunk.slice(0, lastNl).split('\n')) {
    if (!line.trim()) continue;
    try {
      objs.push(JSON.parse(line));
    } catch {
      /* skip a malformed line */
    }
  }
  return objs;
}

// ---- per-harness line parsers. Each returns items: { text, endTurn, ts } and may update st.cwd / st.session ----

export function parseClaude(obj, st) {
  if (obj.cwd) st.cwd = obj.cwd;
  if (obj.sessionId) st.session = obj.sessionId;
  if (obj.type !== 'assistant' || obj.isSidechain) return [];
  const c = obj.message?.content;
  const text = (Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : typeof c === 'string' ? c : '').trim();
  const endTurn = obj.message?.stop_reason === 'end_turn';
  if (!text && !endTurn) return [];
  return [{ text, endTurn, ts: Date.parse(obj.timestamp) || 0 }];
}

// Best effort: Codex rollout files. Field names follow the format seen in recent Codex CLI versions.
export function parseCodex(obj, st) {
  const p = obj.payload && typeof obj.payload === 'object' ? obj.payload : {};
  if (p.cwd) st.cwd = p.cwd;
  if (obj.cwd) st.cwd = obj.cwd;
  if (obj.type === 'session_meta' && p.id) st.session = p.id;
  const ts = Date.parse(obj.timestamp) || 0;
  if (obj.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
    const text = (Array.isArray(p.content) ? p.content : [])
      .filter((b) => b?.type === 'output_text' || b?.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return text ? [{ text, endTurn: false, ts }] : [];
  }
  if (obj.type === 'event_msg' && p.type === 'task_complete') {
    return [{ text: String(p.last_agent_message || '').trim(), endTurn: true, ts }];
  }
  return [];
}

// ---- turns: remember the latest agent text per session and post it once the turn is over ----
export class Turns {
  constructor({ harness, agent, hostProjects, quietMs, outbox }) {
    Object.assign(this, { harness, agent, hostProjects, quietMs, outbox });
    this.sessions = new Map();
  }

  add(st, file, item, { announce }) {
    const sessionId = st.session || path.basename(file, '.jsonl').slice(-36);
    const project = mapProject(st.cwd, this.hostProjects);
    if (!project) return;
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { project, sessionId, text: '', ts: 0, pending: false, last: 0 };
      this.sessions.set(sessionId, s);
    }
    s.project = project;
    if (announce && !st.announced) {
      st.announced = true;
      this.emit(s, 'started', `Session started in ${project}`, '', item.ts);
    }
    if (item.text) {
      s.text = item.text;
      s.ts = item.ts || Date.now();
    }
    s.pending = true;
    s.last = Date.now();
    if (item.endTurn) this.flush(s);
  }

  flush(s) {
    if (!s.pending) return;
    s.pending = false;
    if (!s.text) return;
    this.emit(s, 'done', summarize(s.text), s.text.slice(0, 2000), s.ts);
    s.text = '';
  }

  finishAll() {
    for (const s of this.sessions.values()) this.flush(s);
  }

  tick(now = Date.now()) {
    for (const s of this.sessions.values()) if (s.pending && now - s.last > this.quietMs) this.flush(s);
  }

  emit(s, kind, summary, body, ts) {
    this.outbox.push({
      project: s.project,
      harness: this.harness,
      agent: this.agent,
      session_id: s.sessionId,
      kind,
      summary,
      body,
      ts: ts || Date.now(),
    });
  }
}
