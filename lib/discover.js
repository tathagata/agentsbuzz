// Find git projects in a folder and describe them. Used by the import CLI and the collector.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Your projects folder may hold repositories you cloned but do not trust, and a repository's own
// config can make git run programs. Reading history needs none of that, so it is all switched off:
// no pager, no fsmonitor or hooks, no replacement objects, no fetching of missing objects, no prompts.
const GIT_SAFE = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat'];
const GIT_ENV = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' };

export function git(dir, ...args) {
  try {
    return execFileSync('git', [...GIT_SAFE, '-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000, env: GIT_ENV }).toString().trim();
  } catch {
    return '';
  }
}

export function readmeLine(dir) {
  const file = ['README.md', 'readme.md', 'README', 'README.txt'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!file) return '';
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    text = buf.slice(0, n).toString('utf8');
  } catch {
    return '';
  }
  const clean = (l) =>
    l
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*_>]/g, '')
      .trim();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const para = lines.find((l) => !/^(#|<|---|===|\||```|!\[|\[!\[)/.test(l) && clean(l).length > 12);
  const heading = lines.find((l) => /^#\s/.test(l));
  return clean(para || (heading || '').replace(/^#+\s*/, '')).slice(0, 160);
}

export function ago(sec) {
  const d = Math.floor((Date.now() / 1000 - sec) / 86400);
  if (d < 1) return 'today';
  if (d < 14) return `${d}d ago`;
  if (d < 60) return `${Math.round(d / 7)}w ago`;
  if (d < 730) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

// What the feed shows for one repository: { name, dir, status, ct, subject, description }.
export function describeRepo(dir, name = path.basename(dir), { activeDays = 30 } = {}) {
  const ct = Number(git(dir, 'log', '-1', '--format=%ct')) || 0;
  const subject = ct ? git(dir, 'log', '-1', '--format=%s').slice(0, 120) : '';
  const ageDays = ct ? (Date.now() / 1000 - ct) / 86400 : Infinity;
  const status = !ct ? 'idea' : ageDays <= activeDays ? 'active' : 'paused';
  const about = readmeLine(dir);
  const tail = ct ? `Last commit ${ago(ct)}: ${subject}` : 'No commits yet';
  return { name, dir, status, ct, subject, description: [about, tail].filter(Boolean).join(' — ').slice(0, 600) };
}

const skipName = (n) => n.startsWith('.') || n === 'node_modules' || n.endsWith('.worktrees');
function subdirs(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if ((!e.isDirectory() && !e.isSymbolicLink()) || skipName(e.name)) continue;
    const d = path.join(dir, e.name);
    try {
      if (fs.statSync(d).isDirectory()) out.push({ name: e.name, dir: d });
    } catch {
      /* broken link */
    }
  }
  return out;
}

// Returns [{ name, dir, status, ct, subject, description }] newest commit first.
// Repositories directly in the folder, and one level further down for grouping folders that are
// not repositories themselves (~/code/<org>/<repo>).
export function scanProjects(root, { include, skip, all = false, activeDays = 30 } = {}) {
  const found = [];
  for (const { name, dir } of subdirs(root)) {
    if (include && !include.has(name)) continue;
    if (skip && skip.has(name)) continue;
    const isGit = fs.existsSync(path.join(dir, '.git'));
    if (isGit || all) {
      found.push(describeRepo(dir, name, { activeDays }));
      continue;
    }
    for (const inner of subdirs(dir)) {
      if (skip && skip.has(inner.name)) continue;
      if (fs.existsSync(path.join(inner.dir, '.git'))) found.push(describeRepo(inner.dir, inner.name, { activeDays }));
    }
  }
  return found.sort((a, b) => b.ct - a.ct);
}

// The repository a folder belongs to: the nearest parent with a .git. A worktree's .git file points
// into the main repository, so its sessions and commits count for the main project. Your home folder
// (a dotfiles repository) and the filesystem root are never projects. Only looks at the filesystem:
// nothing in the folder is run, and a path that is not absolute is refused. Paths are compared after
// following symlinks, so a link to your home folder is still your home folder; the result is a real path.
const realpath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return '';
  }
};
export function repoRoot(dir, { home = os.homedir() } = {}) {
  if (typeof dir !== 'string' || !dir || dir.includes('\0') || !path.isAbsolute(dir)) return '';
  const stop = realpath(home) || path.resolve(home);
  let cur = realpath(dir);
  if (!cur) return '';
  for (let i = 0; i < 64; i++) {
    if (cur === stop || cur === path.parse(cur).root) return '';
    const dotgit = path.join(cur, '.git');
    let st = null;
    try {
      st = fs.statSync(dotgit);
    } catch {
      /* not here */
    }
    if (st?.isDirectory()) return cur;
    if (st?.isFile()) {
      let head = '';
      try {
        head = fs.readFileSync(dotgit, 'utf8').slice(0, 4096);
      } catch {
        /* unreadable: treat as its own repository */
      }
      const m = head.match(/^gitdir:\s*(.+)$/m);
      const target = m ? path.resolve(cur, m[1].trim()) : '';
      const at = target.lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
      const main = at > 0 ? realpath(target.slice(0, at)) : '';
      // A real worktree is linked both ways: the main repository's worktrees/<name>/gitdir file points
      // back at this .git file. A .git file that only claims some other repository is not followed.
      let back = '';
      try {
        back = realpath(path.resolve(target, fs.readFileSync(path.join(target, 'gitdir'), 'utf8').trim()));
      } catch {
        back = '';
      }
      const linked = back && back === realpath(dotgit);
      return linked && main && main !== stop && main !== path.parse(main).root && fs.existsSync(path.join(main, '.git')) ? main : cur;
    }
    const up = path.dirname(cur);
    if (up === cur) return '';
    cur = up;
  }
  return '';
}

// The folders your Claude Code and Codex sessions ran in, newest session first. Each session file
// records its working folder near the start, so only the first part of each file is read, and only
// files touched in the last `days` days. Claude Code keeps one folder per working directory, so only
// its newest file is read; Codex files are cached by path because a session never changes folder.
const cwdCache = new Map();
const CWD_RE = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/;
function firstCwd(file) {
  if (cwdCache.has(file)) return cwdCache.get(file);
  let found = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const m = buf.subarray(0, n).toString('utf8').match(CWD_RE);
      const v = m ? JSON.parse(m[1]) : '';
      found = typeof v === 'string' ? v : '';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    found = '';
  }
  if (found) cwdCache.set(file, found);
  return found;
}
function jsonlFiles(dir, depth, since, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) jsonlFiles(p, depth - 1, since, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try {
        const m = fs.statSync(p).mtimeMs;
        if (m >= since) out.push({ file: p, m });
      } catch {
        /* gone */
      }
    }
  }
  return out;
}
export function agentFolders({ claudeDir, codexDir, days = 90 } = {}) {
  const since = Date.now() - days * 86400000;
  const files = [];
  if (claudeDir) {
    for (const { dir } of subdirs(path.join(claudeDir, 'projects'))) {
      const newest = jsonlFiles(dir, 0, since).sort((a, b) => b.m - a.m)[0];
      if (newest) files.push(newest);
    }
  }
  if (codexDir) files.push(...jsonlFiles(path.join(codexDir, 'sessions'), 4, since));
  const seen = new Set();
  const out = [];
  for (const { file } of files.sort((a, b) => b.m - a.m)) {
    const cwd = firstCwd(file);
    if (cwd && !seen.has(cwd)) {
      seen.add(cwd);
      out.push(cwd);
    }
  }
  return out;
}

// Every repository your agents worked in recently, newest first, as absolute paths.
export function agentRepos(opts = {}) {
  const seen = new Set();
  for (const cwd of agentFolders(opts)) {
    const r = repoRoot(cwd, opts);
    if (r) seen.add(r);
  }
  return [...seen];
}
