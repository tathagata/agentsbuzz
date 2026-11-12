#!/usr/bin/env node
// Fills the feed with realistic sample events so you can see the UI. Not run automatically.
// Every project here is made up.
import { post, putProject } from '../lib/client.js';

const now = Date.now();
const min = 60 * 1000;
const e = (ago, o) => ({ ts: now - ago * min, ...o });
const day = 24 * 60;

const events = [
  e(95, { project: 'trailmap', harness: 'claude-code', agent: 'claude', session_id: 'tm-1', kind: 'started', summary: 'Session started in trailmap' }),
  e(80, { project: 'trailmap', harness: 'claude-code', agent: 'claude', session_id: 'tm-1', kind: 'progress', summary: 'Reading the GPX import code' }),
  e(52, { project: 'trailmap', harness: 'claude-code', agent: 'claude', session_id: 'tm-1', kind: 'milestone', summary: 'Elevation profiles render for imported routes; 22 tests green.' }),
  e(9, { project: 'trailmap', harness: 'claude-code', agent: 'claude', session_id: 'tm-1', kind: 'progress', summary: 'Adding offline tiles for saved routes' }),
  e(70, { project: 'recipe-box', harness: 'codex', agent: 'codex', session_id: 'rb-1', kind: 'progress', summary: 'Moved 31 of 80 recipes to the new ingredient schema' }),
  e(33, { project: 'recipe-box', harness: 'codex', agent: 'codex', session_id: 'rb-1', kind: 'blocked', needs_you: true, summary: 'Two recipes use units I cannot convert. Grams or cups for flour?', body: 'Pancakes and focaccia list flour in "handfuls". Options: (a) convert to grams with a note, (b) keep the original text and skip scaling for these two.' }),
  e(25, { project: 'latency-lab', harness: 'cursor', agent: 'cursor', session_id: 'll-1', kind: 'pr', summary: 'Opened PR: capture replay with nanosecond timestamps', url: 'https://github.com/example/latency-lab/pull/7' }),
  e(14, { project: 'latency-lab', harness: 'cursor', agent: 'cursor', session_id: 'll-1', kind: 'done', summary: 'Latency histogram renders for the sample capture' }),
  e(6, { project: 'garden-bot', harness: 'claude-code', agent: 'claude', session_id: 'gb-1', kind: 'error', summary: 'Watering schedule fails validation when a bed has no plants' }),
  e(1, { project: 'garden-bot', harness: 'claude-code', agent: 'claude', session_id: 'gb-1', kind: 'milestone', summary: 'Fixed empty-bed validation; schedule now skips fallow beds' }),
  e(5 * day, { project: 'blog', harness: 'claude-code', agent: 'claude', session_id: 'bl-1', kind: 'milestone', summary: 'Drafts preview with the real theme' }),
];

const step = (title, status = 'todo') => ({ title, status });
const projects = {
  trailmap: {
    description: 'Hiking route planner with elevation profiles and offline maps',
    status: 'active',
    focus: 'Offline tiles for saved routes',
    plan: [step('GPX import', 'done'), step('Elevation profiles', 'done'), step('Offline tiles', 'doing'), step('Share a route link')],
  },
  'recipe-box': {
    description: 'Family recipes, scaled to any number of people',
    status: 'active',
    plan: [step('Import old recipes', 'done'), step('Ingredient schema', 'doing'), step('Scaling'), step('Shopping list')],
  },
  'latency-lab': {
    description: 'Replay network captures and chart latency',
    status: 'active',
    plan: [step('Capture replay', 'done'), step('Latency histograms', 'done'), step('Report template', 'doing'), step('Compare two runs')],
  },
  'garden-bot': {
    description: 'Watering schedules for raised beds',
    status: 'active',
    plan: [step('Bed layout', 'done'), step('Weather-aware schedule'), step('Phone reminders')],
  },
  blog: {
    description: 'Personal blog on a static site generator',
    status: 'active',
    plan: [step('Theme', 'done'), step('Drafts preview', 'done'), step('RSS feed')],
  },
  'chess-coach': {
    description: 'Explain my chess blunders in plain words',
    status: 'idea',
    plan: [step('Import games'), step('Find the turning point')],
  },
  'photo-sorter': { description: 'Sort holiday photos by place and day', status: 'paused', plan: [step('Read photo locations', 'done'), step('Group by trip')] },
};

await post(events, { timeoutMs: 8000 });
for (const [name, body] of Object.entries(projects)) await putProject(name, body, { timeoutMs: 8000 });
console.log(`Seeded ${events.length} events and ${Object.keys(projects).length} projects.`);
