#!/usr/bin/env node
// agentsbuzz collector: finds your projects and follows what your agents do, with no setup per project.
//   - discovers git projects: every repository your agents worked in (from the Claude Code and Codex
//     session files), the repositories in PROJECTS_DIR, and any you added with ./buzz add
//   - posts new git commits
//   - follows Claude Code and Codex session files and posts each finished turn
import fs from 'node:fs';
import path from 'node:path';
import { post, putProject, getProjects } from '../lib/client.js';
import { scanProjects, describeRepo, agentRepos, repoRoot } from '../lib/discover.js';
import { loadState, saveState } from './state.js';
import { pollGit } from './git.js';
import { Turns, listFiles, readNewLines, parseClaude, parseCodex, mapProject, sessionRepo } from './transcripts.js';

const env = process.env;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
// lists use the path separator, like PATH: /a/code:/b/work
const list = (v) => String(v || '').split(path.delimiter).map((s) => s.trim()).filter(Boolean);
const cfg = {
  projectsDirs: list(env.PROJECTS_DIR || '/host/projects'),
  extraRepos: list(env.EXTRA_REPOS),
  ignore: new Set(list(env.IGNORE_PROJECTS)),
  discoverDays: num(env.DISCOVER_DAYS, 90),
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

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const ignored = (name, dir) => cfg.ignore.has(name) || cfg.ignore.has(dir);

// One name per repository folder, kept for good: the folder's own name, or parent-name when another
// folder already has it (~/work/api and ~/oss/api become "api" and "oss-api").
function nameFor(dir) {
  if (state.names[dir]) return state.names[dir];
  const taken = new Set(Object.values(state.names));
  const base = path.basename(dir);
  let name = base;
  if (taken.has(name)) name = `${path.basename(path.dirname(dir))}-${base}`;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  state.names[dir] = name;
  dirty = true;
  return name;
}

// A session belongs to the repository it ran in, wherever that is: a session in ~/work/api/src
// is "api", not "src". Folders that are not in a repository keep the old rule (the folder name).
function projectForCwd(cwd) {
  const root = sessionRepo(cwd, cfg.hostProjects, cfg.projectsDirs[0]);
  if (root === null) return ''; // tries to leave the mounted folder: ignore
  if (!root) return mapProject(cwd, cfg.hostProjects);
  const dir = real(root);
  const name = nameFor(dir);
  if (ignored(name, dir)) return '';
  if (!repos.some((r) => r.dir === dir)) repos.push({ name, dir }); // follow its commits right away
  return name;
}

const turns = {
  claude: new Turns({ harness: 'claude-code', agent: 'claude', hostProjects: cfg.hostProjects, quietMs: cfg.quietMs, outbox, resolve: projectForCwd }),
  codex: new Turns({ harness: 'codex', agent: 'codex', hostProjects: cfg.hostProjects, quietMs: cfg.quietMs, outbox, resolve: projectForCwd }),
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
  let existing;
  try {
    existing = new Map((await getProjects()).map((p) => [p.name, p]));
  } catch (e) {
    log(`waiting for the server (${e.message})`);
    return;
  }
  // Every source, each repository once. Folders first, so their names win for repositories that
  // were already in the feed before agent history was used.
  const found = new Map(); // dir -> { name, dir, from, info? }
  const add = (dir, from, info) => {
    const d = real(dir);
    if (found.has(d)) return;
    const name = nameFor(d);
    if (!ignored(name, d)) found.set(d, { name, dir: d, from, info });
  };
  for (const root of cfg.projectsDirs) for (const f of scanProjects(root)) add(f.dir, 'folder', f);
  for (const d of cfg.extraRepos) {
    const r = repoRoot(path.resolve(d)); // the same checks as agent history: never your home folder
    if (r) add(r, 'added');
  }
  if (cfg.on('DISCOVER_FROM_AGENTS')) {
    for (const r of agentRepos({ claudeDir: cfg.claudeDir, codexDir: cfg.codexDir, days: cfg.discoverDays })) add(r, 'agents');
  }
  repos = [...found.values()].map(({ name, dir }) => ({ name, dir }));

  let added = 0;
  for (const f of found.values()) {
    const have = existing.get(f.name);
    if (have?.description) continue;
    const info = f.info || describeRepo(f.dir, f.name);
    try {
      await putProject(f.name, have ? { description: info.description } : { description: info.description, status: info.status }, { timeoutMs: 8000 });
      if (!have) added += 1;
    } catch (e) {
      log(`could not add ${f.name}: ${e.message}`);
    }
  }
  if (added) log(`added ${added} new project${added === 1 ? '' : 's'}`);
  else if (!initialScanDone) {
    const by = (k) => [...found.values()].filter((f) => f.from === k).length;
    log(`watching ${found.size} project${found.size === 1 ? '' : 's'}: ${by('folder')} in ${cfg.projectsDirs.join(', ')}, ${by('agents')} more from agent history, ${by('added')} added by hand`);
  }
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
