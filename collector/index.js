#!/usr/bin/env node
// agentsbuzz collector: finds your projects and follows what your agents do, with no setup per project.
//   - discovers git projects in PROJECTS_DIR and creates them
//   - posts new git commits
//   - follows Claude Code and Codex session files and posts each finished turn
import fs from 'node:fs';
import path from 'node:path';
import { post, putProject, getProjects } from '../lib/client.js';
import { scanProjects } from '../lib/discover.js';
import { loadState, saveState } from './state.js';
import { pollGit } from './git.js';
import { Turns, listFiles, readNewLines, parseClaude, parseCodex } from './transcripts.js';

const env = process.env;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const cfg = {
  projectsDir: env.PROJECTS_DIR || '/host/projects',
  hostProjects: env.HOST_PROJECTS || env.PROJECTS_DIR || '/host/projects',
  claudeDir: env.CLAUDE_DIR || '/host/claude',
  codexDir: env.CODEX_DIR || '/host/codex',
  stateFile: env.STATE_FILE || '/data/collector-state.json',
  pollMs: num(env.POLL_MS, 5000),
  gitMs: num(env.GIT_POLL_MS, 30000),
  discoverMs: num(env.DISCOVER_MS, 300000),
  quietMs: num(env.QUIET_MS, 90000),
  recentMs: 2 * 24 * 3600 * 1000,
  backfillDays: env.COLLECT_BACKFILL === '0' ? 0 : num(env.BACKFILL_DAYS, 30),
  backfillPerProject: num(env.BACKFILL_PER_PROJECT, 40),
  on: (k) => env[k] !== '0',
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const startedAt = Date.now();
const state = loadState(cfg.stateFile);
const outbox = [];
let repos = [];
let initialScanDone = false;
let dirty = false;
let gitDone = false;
// While the first-run history is being read, hold posting so it goes out as one
// chronologically sorted batch (ids then follow time, and live events land on top).
let backfilling = cfg.backfillDays > 0 && Object.keys(state.files).length === 0;
const backfillFiles = new Set();
const counted = new WeakSet();
const historic = new Map(); // project -> history events already queued (keeps the per-project cap)

const turns = {
  claude: new Turns({ harness: 'claude-code', agent: 'claude', hostProjects: cfg.hostProjects, quietMs: cfg.quietMs, outbox }),
  codex: new Turns({ harness: 'codex', agent: 'codex', hostProjects: cfg.hostProjects, quietMs: cfg.quietMs, outbox }),
};

function releaseBackfill() {
  backfilling = false;
  outbox.sort((a, b) => a.ts - b.ts);
  // keep the newest N per project so one busy repo cannot bury the rest
  const seen = new Map();
  for (let i = outbox.length - 1; i >= 0; i--) {
    const n = (seen.get(outbox[i].project) || 0) + 1;
    seen.set(outbox[i].project, n);
    if (n > cfg.backfillPerProject) outbox.splice(i, 1);
  }
  for (const e of outbox) {
    counted.add(e);
    if (e.harness !== 'git') historic.set(e.project, (historic.get(e.project) || 0) + 1);
  }
  log(`loaded ${outbox.length} past event${outbox.length === 1 ? '' : 's'} so the feed starts full`);
}

async function flushOutbox() {
  if (backfilling) return;
  if (cfg.backfillDays > 0) {
    // stragglers from files still being read after the first release: same per-project cap
    for (let i = outbox.length - 1; i >= 0; i--) {
      const e = outbox[i];
      if (e.ts > startedAt - 60000 || e.harness === 'git') continue;
      if (counted.has(e)) continue;
      const n = historic.get(e.project) || 0;
      if (n >= cfg.backfillPerProject) outbox.splice(i, 1);
      else historic.set(e.project, n + 1);
    }
  }
  if (!outbox.length) return;
  const batch = outbox.splice(0, 100);
  try {
    await post(batch, { timeoutMs: 8000 });
    log(`posted ${batch.length} event${batch.length === 1 ? '' : 's'}`);
  } catch (e) {
    if (/agentsbuzz 4(00|13|22)/.test(e.message)) {
      // the server refused the batch: find the bad event(s) instead of retrying forever
      let ok = 0;
      for (const ev of batch) {
        try {
          await post(ev, { timeoutMs: 8000 });
          ok += 1;
        } catch (e2) {
          if (!/agentsbuzz 4(00|13|22)/.test(e2.message)) {
            outbox.unshift(ev);
            return;
          }
          log(`dropped an event the server refused (${ev.project}): ${e2.message.slice(0, 120)}`);
        }
      }
      log(`posted ${ok} of ${batch.length} one by one`);
      return;
    }
    outbox.unshift(...batch);
    if (outbox.length > 20000) outbox.splice(0, outbox.length - 20000);
    log(`could not post (${e.message}); will retry`);
  }
}

// ---- projects ----
async function discover() {
  if (!cfg.on('COLLECT_PROJECTS')) return;
  const found = scanProjects(cfg.projectsDir);
  repos = found.map((f) => ({ name: f.name, dir: f.dir }));
  let existing;
  try {
    existing = new Set((await getProjects()).map((p) => p.name));
  } catch (e) {
    log(`waiting for the server (${e.message})`);
    return;
  }
  let added = 0;
  for (const f of found) {
    if (existing.has(f.name)) continue;
    try {
      await putProject(f.name, { description: f.description, status: f.status }, { timeoutMs: 8000 });
      added += 1;
    } catch (e) {
      log(`could not add ${f.name}: ${e.message}`);
    }
  }
  if (added) log(`added ${added} new project${added === 1 ? '' : 's'}`);
  else if (!initialScanDone) log(`watching ${found.length} project${found.length === 1 ? '' : 's'} in ${cfg.projectsDir}`);
}

// Release the held first-run history once every file is read and git has had its first pass.
function maybeRelease() {
  if (!backfilling || !initialScanDone) return;
  const timedOut = Date.now() - startedAt > 20000; // never hold the feed back for long
  if (timedOut || (backfillFiles.size === 0 && (gitDone || !cfg.on('COLLECT_GIT')))) {
    for (const t of Object.values(turns)) t.finishAll(); // history has no "later": close every open turn
    releaseBackfill();
  }
}

// ---- transcripts ----
function scanTranscripts() {
  const sources = [];
  if (cfg.on('COLLECT_CLAUDE')) {
    sources.push({
      name: 'claude',
      parse: parseClaude,
      files: listFiles(path.join(cfg.claudeDir, 'projects'), 1, (f, n) => n.endsWith('.jsonl')),
    });
  }
  if (cfg.on('COLLECT_CODEX')) {
    sources.push({
      name: 'codex',
      parse: parseCodex,
      files: listFiles(path.join(cfg.codexDir, 'sessions'), 4, (f, n) => n.startsWith('rollout-') && n.endsWith('.jsonl')),
    });
  }

  for (const src of sources) {
    for (const file of src.files) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      let st = state.files[file];
      if (!st) {
        const history = backfilling && !initialScanDone && Date.now() - stat.mtimeMs < cfg.backfillDays * 86400000;
        if (!history && Date.now() - stat.mtimeMs > cfg.recentMs) continue; // old and untouched: ignore
        // First run: read recent sessions from the start so their finished turns fill the feed.
        // A file created after we started is a new session: read it all. Otherwise skip its history.
        const born = stat.birthtimeMs || 0;
        const fresh = !history && initialScanDone && (born > 0 ? born > startedAt - 5000 : stat.size < 64 * 1024);
        const TAIL = 6 * 1024 * 1024; // history: only the recent end of big session files
        st = { offset: fresh ? 0 : history ? Math.max(0, stat.size - TAIL) : stat.size, cwd: '', session: '', fresh, announced: false };
        state.files[file] = st;
        dirty = true;
        if (!fresh && !history) continue;
      }
      const before = st.offset;
      for (const obj of readNewLines(file, st)) {
        for (const item of src.parse(obj, st)) turns[src.name].add(st, file, item, { announce: st.fresh });
      }
      if (st.offset !== before) dirty = true;
      if (backfilling) {
        if (st.offset < stat.size) backfillFiles.add(file);
        else backfillFiles.delete(file);
      }
    }
  }
  initialScanDone = true;

  maybeRelease();
  if (!backfilling) {
    for (const t of Object.values(turns)) t.tick();
  }

  // forget files that no longer exist
  for (const [f, st] of Object.entries(state.files)) {
    if (!fs.existsSync(f)) {
      delete state.files[f];
      dirty = true;
    }
  }
}

function persist() {
  if (!dirty) return;
  dirty = false;
  saveState(cfg.stateFile, state);
}

async function loop(fn, ms, name) {
  const run = async () => {
    try {
      await fn();
    } catch (e) {
      log(`${name} failed: ${e.message}`);
    }
    setTimeout(run, ms);
  };
  await run();
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      await getProjects({ timeoutMs: 3000 });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  log('server not reachable yet; continuing anyway');
}

log('agentsbuzz collector starting');
await waitForServer();
await discover();
// transcript scan + outbox flush on a short loop; git and discovery on slower ones
loop(async () => {
  scanTranscripts();
  await flushOutbox();
  persist();
}, cfg.pollMs, 'transcripts');
if (cfg.on('COLLECT_GIT')) {
  loop(async () => {
    pollGit(repos, state.git, outbox, { backfillDays: cfg.backfillDays, backfillMax: 20 });
    gitDone = true;
    maybeRelease();
    dirty = true;
    await flushOutbox();
    persist();
  }, cfg.gitMs, 'git');
}
loop(async () => {
  await discover();
}, cfg.discoverMs, 'discovery');

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    persist();
    process.exit(0);
  });
}
