#!/usr/bin/env node
// Turn the git projects in a folder into agentsbuzz projects.
//
//   node cli/import-projects.js [folder] [options]
//
//   folder              where your projects live (default ~/projects)
//   --dry-run           show what would be imported, change nothing
//   --include a,b,c     only these folder names
//   --skip a,b,c        leave these out
//   --all               include folders that are not git repositories
//   --events            also post each project's last commit as a note, dated when it happened
//   --force             update projects that already exist (default: leave them alone)
//   --active-days N     commits newer than N days mean "active" (default 30)
//
// Stage is guessed from the last commit: recent = active, older = paused, none = idea.
// Plans are left empty. Add them in the app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { putProject, post, getProjects } from '../lib/client.js';
import { scanProjects, ago } from '../lib/discover.js';

const args = process.argv.slice(2);
const opt = { activeDays: 30 };
let dirArg = '';
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dry-run') opt.dry = true;
  else if (a === '--all') opt.all = true;
  else if (a === '--events') opt.events = true;
  else if (a === '--force') opt.force = true;
  else if (a === '--include') opt.include = new Set(String(args[++i] || '').split(',').map((x) => x.trim()).filter(Boolean));
  else if (a === '--skip') opt.skip = new Set(String(args[++i] || '').split(',').map((x) => x.trim()).filter(Boolean));
  else if (a === '--active-days') opt.activeDays = Number(args[++i]) || 30;
  else if (a === '-h' || a === '--help') {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(0);
  } else if (a.startsWith('--')) {
    console.error(`Unknown option ${a}`);
    process.exit(2);
  } else dirArg = a;
}

const root = path.resolve((dirArg || '~/projects').replace(/^~(?=$|\/)/, os.homedir()));
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`Not a folder: ${root}`);
  process.exit(1);
}

const found = scanProjects(root, { include: opt.include, skip: opt.skip, all: opt.all, activeDays: opt.activeDays });

console.log(`${found.length} project${found.length === 1 ? '' : 's'} in ${root}${opt.dry ? ' (dry run)' : ''}`);
for (const f of found) console.log(`  ${f.status.padEnd(6)} ${f.name.padEnd(32)} ${f.ct ? ago(f.ct) : 'no commits'}`);

if (opt.dry) {
  console.log('\nNothing was changed. Run again without --dry-run to import. Use --include or --skip to narrow the list.');
  process.exit(0);
}
if (!found.length) process.exit(0);

let existing = new Set();
try {
  existing = new Set((await getProjects()).map((p) => p.name));
} catch (e) {
  console.error(`Could not reach agentsbuzz: ${e.message}`);
  console.error('Is it running? Check AGENTSBUZZ_URL and AGENTSBUZZ_TOKEN, or ~/.agentsbuzz.json.');
  process.exit(1);
}

let added = 0;
let skipped = 0;
for (const f of found) {
  if (existing.has(f.name) && !opt.force) {
    skipped += 1;
    continue;
  }
  await putProject(f.name, { description: f.description, status: f.status }, { timeoutMs: 8000 });
  if (opt.events && f.ct) {
    await post({ project: f.name, harness: 'git', kind: 'note', summary: `Last commit: ${f.subject}`, ts: f.ct * 1000 }, { timeoutMs: 8000 });
  }
  added += 1;
}
console.log(`\nImported ${added}${skipped ? `, left ${skipped} existing project${skipped === 1 ? '' : 's'} alone (use --force to update them)` : ''}.`);
