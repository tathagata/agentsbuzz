#!/usr/bin/env node
// Usage: buzz [--kind milestone] [--project name] [--agent name] [--harness name] [--url link] [--needs] "summary"
import { post, projectFromDir } from '../lib/client.js';

const args = process.argv.slice(2);
const opts = {};
const words = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--needs') opts.needs_you = true;
  else if (a.startsWith('--')) opts[a.slice(2)] = args[++i];
  else words.push(a);
}

const summary = words.join(' ').trim();
if (!summary) {
  console.error('usage: buzz [--kind progress|milestone|blocked|done|pr|error] [--project p] [--needs] "summary"');
  process.exit(2);
}

try {
  await post({
    summary,
    kind: opts.kind || 'progress',
    project: opts.project || projectFromDir(process.cwd()),
    harness: opts.harness || 'cli',
    agent: opts.agent || '',
    session_id: opts.session || '',
    url: opts.url || '',
    needs_you: Boolean(opts.needs_you),
  });
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
