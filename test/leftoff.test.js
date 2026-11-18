import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leftOff, proposedNext, metrics } from '../lib/leftoff.js';

const D = 86400000;
const now = Date.UTC(2026, 10, 16, 12);
const agent = (o) => ({ id: 9, ts: now - 9 * D, agent: 'claude', harness: 'claude-code', session_id: 's1', kind: 'done', summary: 'Wrapped up', body: '', resolved: 0, ...o });

test('the next step an agent proposed is found in its last message', () => {
  assert.equal(proposedNext('Cache works. All 31 tests pass. Next I will add a progress bar.'), 'Next I will add a progress bar.');
  assert.equal(proposedNext('Parser is done. Want me to open a PR for it?'), 'Want me to open a PR for it?');
  assert.equal(proposedNext('Parser is done. All tests pass.'), '');
  assert.equal(proposedNext('**Done.** `npm test` passes. Next, I\'ll wire it into the explainer.'), "Next, I'll wire it into the explainer.");
});

test('the next action, in order: answer, waiting message, fix, proposal, question, continue', () => {
  const open = [{ id: 3, ts: now, summary: 'Grams or cups?', body: '', session_id: 's2' }];
  assert.equal(leftOff({ now, lastAgent: agent({ body: 'Next I will do X.' }), open }).next.kind, 'answer');
  assert.equal(leftOff({ now, lastAgent: agent({}), waiting: [{ id: 1, ts: now - 10 * 60000, prompt: 'Use grams' }] }).next.kind, 'waiting');
  assert.equal(leftOff({ now, lastAgent: agent({}), waiting: [{ id: 1, ts: now - 30000, prompt: 'just sent' }] }).next.kind, 'continue', 'a message sent a moment ago is not stuck yet');
  assert.equal(leftOff({ now, lastAgent: agent({ kind: 'error', summary: 'Build failed on Node 22' }) }).next.kind, 'fix');
  const p = leftOff({ now, lastAgent: agent({ body: 'Done. Next I will add a progress bar.' }) }).next;
  assert.deepEqual([p.kind, p.event_id], ['proposal', 9]);
  assert.match(p.reply, /^Go ahead with what you proposed: "Next I will add a progress bar\."$/);
  assert.equal(leftOff({ now, lastAgent: agent({ body: 'Done. Should I open the PR?' }) }).next.kind, 'question');
  assert.equal(leftOff({ now, lastAgent: agent({ summary: 'Parser done' }) }).next.kind, 'continue');
  assert.equal(leftOff({ now, lastCommit: { ts: now, summary: 'x' } }).next.kind, 'start');
});

test('a next action without an agent session goes to the project as a note', () => {
  assert.equal(leftOff({ now, lastAgent: agent({ session_id: '' }) }).next.project_note, true);
  assert.equal(leftOff({ now, lastAgent: agent({}) }).next.project_note, undefined);
});

test('the summary is short plain text: the agent\'s last two sentences, the last commit', () => {
  const s = leftOff({ now, lastAgent: agent({ body: '**Cache** works. `31` tests pass. Next I will add a bar. More text here.' }), lastCommit: { ts: now - D, summary: 'Cache tiles' } }).summary;
  assert.equal(s.agent.text, 'Cache works. 31 tests pass.');
  assert.equal(s.commit.text, 'Cache tiles');
  assert.ok(!/[*`<>]/.test(s.agent.text));
});

test('metrics count the last 30 days only', () => {
  const rows = [
    { ts: now - D, harness: 'git', kind: 'progress' },
    { ts: now - D, harness: 'git', kind: 'progress' },
    { ts: now - 2 * D, harness: 'claude-code', kind: 'done' },
    { ts: now - 3 * D, harness: 'codex', kind: 'milestone' },
    { ts: now - 3 * D, harness: 'codex', kind: 'pr' },
    { ts: now - 4 * D, harness: 'codex', kind: 'blocked', needs_you: 1, resolved: 1 },
    { ts: now - 40 * D, harness: 'git', kind: 'progress' },
  ];
  assert.deepEqual(metrics(rows, now), { days: 30, commits: 2, turns: 1, milestones: 1, prs: 1, answered: 1, active_days: 4 });
});
