#!/usr/bin/env node
// Usage: project.js [name] [--status idea|active|paused|done] [--focus "text"] [--desc "text"] [--plan "[x] done step|[~] doing step|todo step"]
// name defaults to the current git repository folder.
import { putProject, projectFromDir } from '../lib/client.js';

const args = process.argv.slice(2);
const opts = {};
const words = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) opts[args[i].slice(2)] = args[++i];
  else words.push(args[i]);
}

const name = words[0] || projectFromDir(process.cwd());
const body = {};
if (opts.status) body.status = opts.status;
if (opts.focus !== undefined) body.focus = opts.focus;
if (opts.desc !== undefined) body.description = opts.desc;
if (opts.plan !== undefined) {
  body.plan = opts.plan
    .split('|')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^\[(x|X|~| )\]\s*/);
      const status = !m || m[1] === ' ' ? 'todo' : m[1] === '~' ? 'doing' : 'done';
      return { title: m ? line.slice(m[0].length) : line, status };
    });
}

if (!Object.keys(body).length) {
  console.error('usage: project.js [name] [--status s] [--focus text] [--desc text] [--plan "[x] a|[~] b|c"]');
  process.exit(2);
}

try {
  const p = await putProject(name, body);
  console.log(`${p.name}: ${p.status}${p.focus ? `, now: ${p.focus}` : ''} (${p.plan.filter((s) => s.status === 'done').length}/${p.plan.length} steps done)`);
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
