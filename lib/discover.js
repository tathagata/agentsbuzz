// Find git projects in a folder and describe them. Used by the import CLI and the collector.
import fs from 'node:fs';
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

// Returns [{ name, dir, status, ct, subject, description }] newest commit first.
export function scanProjects(root, { include, skip, all = false, activeDays = 30 } = {}) {
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (name.startsWith('.') || name === 'node_modules' || name.endsWith('.worktrees')) continue;
    if (include && !include.has(name)) continue;
    if (skip && skip.has(name)) continue;
    const dir = path.join(root, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const isGit = fs.existsSync(path.join(dir, '.git'));
    if (!isGit && !all) continue;

    const ct = Number(git(dir, 'log', '-1', '--format=%ct')) || 0;
    const subject = ct ? git(dir, 'log', '-1', '--format=%s').slice(0, 120) : '';
    const ageDays = ct ? (Date.now() / 1000 - ct) / 86400 : Infinity;
    const status = !ct ? 'idea' : ageDays <= activeDays ? 'active' : 'paused';
    const about = readmeLine(dir);
    const tail = ct ? `Last commit ${ago(ct)}: ${subject}` : 'No commits yet';
    found.push({ name, dir, status, ct, subject, description: [about, tail].filter(Boolean).join(' — ').slice(0, 600) });
  }
  return found.sort((a, b) => b.ct - a.ct);
}
