#!/usr/bin/env node
// agentsbuzz server: zero-dependency event store + live feed API.
// Requires Node >= 22.5 (uses built-in node:sqlite).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { leftOff, WINDOW_DAYS } from '../lib/leftoff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'web');
const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.AGENTSBUZZ_TOKEN || '';
const DB_PATH = process.env.AGENTSBUZZ_DB || path.join(__dirname, '..', 'data', 'buzz.db');

const KINDS = new Set(['started', 'progress', 'milestone', 'blocked', 'done', 'pr', 'error', 'note']);

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !TOKEN) {
  console.error('Refusing to listen on a non-loopback host without AGENTSBUZZ_TOKEN set.');
  process.exit(1);
}

// Your feed holds messages that can run an agent: keep everything this process writes private to you.
process.umask(0o077);
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    project TEXT NOT NULL,
    harness TEXT NOT NULL DEFAULT 'unknown',
    agent TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    needs_you INTEGER NOT NULL DEFAULT 0,
    resolved INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_events_project ON events(project, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts DESC);
  CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    focus TEXT NOT NULL DEFAULT '',
    plan TEXT NOT NULL DEFAULT '[]',
    created_ts INTEGER NOT NULL,
    updated_ts INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO projects (name, created_ts, updated_ts)
    SELECT project, MIN(ts), MAX(ts) FROM events GROUP BY project;
  CREATE TABLE IF NOT EXISTS replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    event_id INTEGER,
    session_id TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
  );
`);
for (const col of ['delivered_ts INTEGER NOT NULL DEFAULT 0', "delivered_via TEXT NOT NULL DEFAULT ''"]) {
  try {
    db.exec(`ALTER TABLE replies ADD COLUMN ${col}`);
  } catch {
    /* already there */
  }
}
const STALE_SESSION_MS = 30 * 60 * 1000; // a session quiet this long counts as gone; its messages go to the next agent on the project

const insertEvent = db.prepare(`
  INSERT INTO events (ts, project, harness, agent, session_id, kind, summary, body, url, needs_you)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
`);

const clip = (v, n) => String(v ?? '').slice(0, n);

const STATUSES = new Set(['idea', 'active', 'paused', 'done']);
const STEP_STATUSES = new Set(['todo', 'doing', 'done']);

const ensureProject = db.prepare('INSERT OR IGNORE INTO projects (name, created_ts, updated_ts) VALUES (?, ?, ?)');

const PROJECT_SQL = `
  SELECT p.name, p.description, p.status, p.focus, p.plan, p.created_ts, p.updated_ts,
    (SELECT COUNT(*) FROM events e WHERE e.project = p.name) AS total,
    (SELECT MAX(ts) FROM events e WHERE e.project = p.name) AS last_ts,
    (SELECT COUNT(*) FROM events e WHERE e.project = p.name AND e.needs_you = 1 AND e.resolved = 0) AS needs,
    (SELECT summary FROM events e WHERE e.project = p.name AND e.kind IN ('milestone','done','pr') ORDER BY e.id DESC LIMIT 1) AS last_win
  FROM projects p`;

function shapeProject(row) {
  let plan = [];
  try {
    plan = JSON.parse(row.plan);
  } catch {
    /* corrupt plan: treat as empty */
  }
  return { ...row, plan };
}

function normalizePlan(input) {
  if (!Array.isArray(input)) throw new Error('plan must be an array');
  if (input.length > 60) throw new Error('plan has too many steps (max 60)');
  return input.map((step) => {
    const title = clip(step?.title, 200).trim();
    if (!title) throw new Error('every plan step needs a title');
    return { title, status: STEP_STATUSES.has(step?.status) ? step.status : 'todo' };
  });
}

function normalize(input) {
  if (!input || typeof input !== 'object') throw new Error('event must be an object');
  const summary = clip(input.summary, 500).trim();
  if (!summary) throw new Error('summary is required');
  const kind = KINDS.has(input.kind) ? input.kind : 'progress';
  const project = clip(input.project || 'default', 80).trim() || 'default';
  const ts = Number.isFinite(Number(input.ts)) && Number(input.ts) > 0 ? Number(input.ts) : Date.now();
  const needs = input.needs_you === true || input.needs_you === 1 || kind === 'blocked' ? 1 : 0;
  return [
    ts,
    project,
    clip(input.harness || 'unknown', 40),
    clip(input.agent, 80),
    clip(input.session_id, 120),
    kind,
    summary,
    clip(input.body, 8000),
    clip(input.url, 500),
    needs,
  ];
}

// ---- SSE ----
const clients = new Set();
function broadcast(type, payload) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25000).unref();

// ---- helpers ----
// Compare digests, so the time taken says nothing about how much of a guess was right.
const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
const TOKEN_DIGEST = digest(TOKEN);
const tokenMatches = (v) => typeof v === 'string' && v.length > 0 && crypto.timingSafeEqual(digest(v), TOKEN_DIGEST);

function authed(req, url) {
  if (!TOKEN) return true;
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ') && tokenMatches(h.slice(7))) return true;
  // Only the live stream may carry the token in its address: EventSource cannot send headers.
  // Everywhere else a token in the URL would end up in logs and history for nothing.
  if (req.method === 'GET' && url.pathname === '/api/stream' && tokenMatches(url.searchParams.get('token'))) return true;
  return false;
}

// API requests another website makes from your browser are refused, whatever they carry. Browsers mark
// them with Sec-Fetch-Site; tools like curl, the hook and the collector send no such header.
// Without a token there is no secret at all, so also insist on a loopback Host: that stops a page
// from reaching this server through DNS rebinding.
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
function allowedOrigin(req, pathname) {
  // opening the app from a link elsewhere is fine; calling its API from elsewhere is not
  if (pathname.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!TOKEN && !LOOPBACK_HOST.test(req.headers.host || '')) return false;
  return true;
}

// Sent with every response. The app loads nothing from other sites and runs no inline script.
const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

function send(res, code, body, headers = {}) {
  const isStr = typeof body === 'string';
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    'content-type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body));
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  // the separator matters: without it a sibling folder like web-private would pass
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'forbidden');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': MIME[path.extname(full)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

// ---- routes ----
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost'); // the Host header is not trusted to build URLs
    decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'bad request');
  }
  const { pathname } = url;
  if (!allowedOrigin(req, pathname)) return send(res, 403, { error: 'cross-site request refused' });

  try {
    if (!pathname.startsWith('/api/')) {
      // Static shell is public; all data lives behind /api and is token-gated.
      return serveStatic(req, res, pathname);
    }
    if (!authed(req, url)) return send(res, 401, { error: 'unauthorized' });

    if (req.method === 'GET' && pathname === '/api/health') {
      return send(res, 200, { ok: true, auth: Boolean(TOKEN), wake: process.env.AGENTSBUZZ_WAKE === '1' });
    }

    if (req.method === 'POST' && pathname === '/api/events') {
      const raw = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: 'invalid json' });
      }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      if (list.length > 200) return send(res, 400, { error: 'too many events (max 200)' });
      const created = [];
      try {
        for (const item of list) {
          const ev = insertEvent.get(...normalize(item));
          ensureProject.run(ev.project, ev.ts, ev.ts);
          created.push(ev);
        }
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      for (const ev of created) broadcast('event', ev);
      return send(res, 201, { created: created.length, ids: created.map((e) => e.id) });
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      const q = url.searchParams;
      const where = [];
      const args = [];
      if (q.get('project')) {
        where.push('project = ?');
        args.push(q.get('project'));
      }
      if (q.get('kind')) {
        where.push('kind = ?');
        args.push(q.get('kind'));
      }
      if (q.get('session_id')) {
        where.push('session_id = ?');
        args.push(q.get('session_id'));
      }
      if (q.get('needs') === '1') where.push('needs_you = 1 AND resolved = 0');
      if (q.get('before_ts')) {
        // time-ordered paging: backfilled history keeps its true place in the feed
        where.push('(ts < ? OR (ts = ? AND id < ?))');
        args.push(Number(q.get('before_ts')), Number(q.get('before_ts')), Number(q.get('before') || 0));
      } else if (q.get('before')) {
        where.push('id < ?');
        args.push(Number(q.get('before')));
      }
      if (q.get('since')) {
        where.push('ts >= ?');
        args.push(Number(q.get('since')));
      }
      const limit = Math.min(Math.max(Number(q.get('limit')) || 50, 1), 200);
      const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC, id DESC LIMIT ?`;
      const rows = db.prepare(sql).all(...args, limit);
      return send(res, 200, { events: rows });
    }

    // Where you left off: a summary, the next action and 30-day numbers for one project (read only)
    const lm = pathname.match(/^\/api\/projects\/([^/]+)\/summary$/);
    if (lm && req.method === 'GET') {
      const name = clip(decodeURIComponent(lm[1]), 80).trim();
      if (!name) return send(res, 400, { error: 'project name required' });
      const now = Date.now();
      const cols = 'id, ts, harness, agent, session_id, kind, summary, body, needs_you, resolved';
      const one = (where) => db.prepare(`SELECT ${cols} FROM events WHERE project = ? AND ${where} ORDER BY ts DESC, id DESC LIMIT 1`).get(name) || null;
      return send(
        res,
        200,
        leftOff({
          now,
          lastTs: db.prepare('SELECT MAX(ts) AS t FROM events WHERE project = ?').get(name)?.t || 0,
          lastAgent: one(`harness != 'git' AND kind != 'started'`),
          lastCommit: one(`harness = 'git'`),
          open: db.prepare(`SELECT ${cols} FROM events WHERE project = ? AND needs_you = 1 AND resolved = 0 ORDER BY id DESC LIMIT 5`).all(name),
          waiting: db.prepare('SELECT id, ts, prompt FROM replies WHERE project = ? AND delivered = 0 ORDER BY id DESC LIMIT 5').all(name),
          recent: db.prepare('SELECT ts, harness, kind, needs_you, resolved FROM events WHERE project = ? AND ts >= ? ORDER BY ts DESC LIMIT 20000').all(name, now - WINDOW_DAYS * 86400000),
        })
      );
    }

    if (req.method === 'GET' && pathname === '/api/projects') {
      const rows = db.prepare(`${PROJECT_SQL} ORDER BY COALESCE(last_ts, p.updated_ts) DESC`).all();
      return send(res, 200, { projects: rows.map(shapeProject) });
    }

    let pm = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (pm && (req.method === 'PUT' || req.method === 'GET')) {
      const name = clip(decodeURIComponent(pm[1]), 80).trim();
      if (!name) return send(res, 400, { error: 'project name required' });
      if (req.method === 'GET') {
        const row = db.prepare(`${PROJECT_SQL} WHERE p.name = ?`).get(name);
        return row ? send(res, 200, shapeProject(row)) : send(res, 404, { error: 'not found' });
      }
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: 'invalid json' });
      }
      if (body.status !== undefined && !STATUSES.has(body.status)) return send(res, 400, { error: 'status must be idea, active, paused or done' });
      let plan;
      if (body.plan !== undefined) {
        try {
          plan = JSON.stringify(normalizePlan(body.plan));
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }
      const now = Date.now();
      ensureProject.run(name, now, now);
      const sets = [];
      const args = [];
      if (body.description !== undefined) (sets.push('description = ?'), args.push(clip(body.description, 600)));
      if (body.status !== undefined) (sets.push('status = ?'), args.push(body.status));
      if (body.focus !== undefined) (sets.push('focus = ?'), args.push(clip(body.focus, 300)));
      if (plan !== undefined) (sets.push('plan = ?'), args.push(plan));
      sets.push('updated_ts = ?');
      args.push(now);
      db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE name = ?`).run(...args, name);
      const out = shapeProject(db.prepare(`${PROJECT_SQL} WHERE p.name = ?`).get(name));
      broadcast('project', out);
      return send(res, 200, out);
    }

    if (req.method === 'GET' && pathname === '/api/digest') {
      const since = Number(url.searchParams.get('since')) || Date.now() - 24 * 3600 * 1000;
      const rows = db
        .prepare(
          `SELECT project,
                  SUM(CASE WHEN kind IN ('milestone','done','pr') THEN 1 ELSE 0 END) AS shipped,
                  SUM(CASE WHEN needs_you = 1 AND resolved = 0 THEN 1 ELSE 0 END) AS blocked,
                  COUNT(*) AS total
           FROM events WHERE ts >= ? GROUP BY project ORDER BY total DESC`
        )
        .all(since);
      return send(res, 200, { since, projects: rows });
    }

    let m = pathname.match(/^\/api\/events\/(\d+)\/resolve$/);
    if (req.method === 'POST' && m) {
      const row = db.prepare('UPDATE events SET resolved = 1 WHERE id = ? RETURNING *').get(Number(m[1]));
      if (!row) return send(res, 404, { error: 'not found' });
      broadcast('update', row);
      return send(res, 200, row);
    }

    m = pathname.match(/^\/api\/events\/(\d+)\/reply$/);
    if (req.method === 'POST' && m) {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: 'invalid json' });
      }
      const prompt = clip(body.prompt, 4000).trim();
      if (!prompt) return send(res, 400, { error: 'prompt required' });
      const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(Number(m[1]));
      if (!ev) return send(res, 404, { error: 'not found' });
      const r = db
        .prepare(
          'INSERT INTO replies (ts, event_id, session_id, project, prompt) VALUES (?, ?, ?, ?, ?) RETURNING *'
        )
        .get(Date.now(), ev.id, ev.harness === 'git' ? '' : ev.session_id, ev.project, prompt);
      broadcast('reply', r);
      return send(res, 201, r);
    }

    // A note for whichever agent next works on the project
    pm = pathname.match(/^\/api\/projects\/([^/]+)\/reply$/);
    if (req.method === 'POST' && pm) {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: 'invalid json' });
      }
      const prompt = clip(body.prompt, 4000).trim();
      if (!prompt) return send(res, 400, { error: 'prompt required' });
      const name = clip(decodeURIComponent(pm[1]), 80).trim();
      const now = Date.now();
      ensureProject.run(name, now, now);
      const r = db
        .prepare("INSERT INTO replies (ts, event_id, session_id, project, prompt) VALUES (?, NULL, '', ?, ?) RETURNING *")
        .get(now, name, prompt);
      broadcast('reply', r);
      return send(res, 201, r);
    }

    // The wake service hands back messages it claimed but could not get to an agent (the command
    // failed before the agent ran). Only its own claims can be undone, never an agent's.
    if (req.method === 'POST' && pathname === '/api/replies/requeue') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: 'invalid json' });
      }
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 300) : [];
      if (!ids.length) return send(res, 400, { error: 'ids required' });
      const undo = db.prepare("UPDATE replies SET delivered = 0, delivered_ts = 0, delivered_via = '' WHERE id = ? AND delivered = 1 AND delivered_via = 'wake' RETURNING *");
      const rows = ids.map((id) => undo.get(id)).filter(Boolean);
      for (const r of rows) broadcast('reply', r);
      return send(res, 200, { replies: rows });
    }

    // An agent asks "anything for me?". Atomic: each message is handed out once.
    // Goes to the named session, to project-wide notes, and to messages whose session has gone quiet.
    if (req.method === 'POST' && pathname === '/api/replies/claim') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: 'invalid json' });
      }
      const sid = clip(body.session_id, 120);
      const proj = clip(body.project, 80);
      const via = clip(body.via, 60) || 'agent';
      if (!sid && !proj) return send(res, 400, { error: 'session_id or project required' });
      const now = Date.now();
      const rows = db
        .prepare(
          `UPDATE replies SET delivered = 1, delivered_ts = ?, delivered_via = ?
           WHERE delivered = 0 AND (
             (? != '' AND session_id = ?)
             OR (? != '' AND project = ? AND (
               session_id = ''
               OR COALESCE((SELECT MAX(ts) FROM events e WHERE e.session_id = replies.session_id), 0) < ?
             ))
           ) RETURNING *`
        )
        .all(now, via, sid, sid, proj, proj, now - STALE_SESSION_MS);
      rows.sort((a, b) => a.id - b.id);
      for (const r of rows) broadcast('reply', r);
      return send(res, 200, { replies: rows });
    }

    if (req.method === 'GET' && pathname === '/api/replies') {
      const q = url.searchParams;
      const where = q.get('all') === '1' ? ['1 = 1'] : ['delivered = 0'];
      const args = [];
      if (q.get('session_id')) {
        where.push('session_id = ?');
        args.push(q.get('session_id'));
      }
      if (q.get('project')) {
        where.push('project = ?');
        args.push(q.get('project'));
      }
      const rows = db.prepare(`SELECT * FROM (SELECT * FROM replies WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 300) ORDER BY id ASC`).all(...args);
      if (q.get('ack') === '1' && rows.length) {
        const mark = db.prepare('UPDATE replies SET delivered = 1, delivered_ts = ?, delivered_via = ? WHERE id = ?');
        for (const r of rows) if (!r.delivered) mark.run(Date.now(), 'poll', r.id);
      }
      return send(res, 200, { replies: rows });
    }

    if (req.method === 'GET' && pathname === '/api/stream') {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`agentsbuzz listening on http://${HOST}:${PORT}  (auth ${TOKEN ? 'on' : 'off'})`);
});
