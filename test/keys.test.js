import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore, rankItems, SHORTCUTS } from '../web/keys.js';

test('fuzzy match: letters in order, anywhere; anything out of order does not match', () => {
  assert.ok(fuzzyScore('lb', 'latency-lab') > 0);
  assert.ok(fuzzyScore('gp', 'gitops-plane') > 0);
  assert.equal(fuzzyScore('bl', 'latency-lab'), -1);
  assert.equal(fuzzyScore('xyz', 'agentsbuzz'), -1);
  assert.equal(fuzzyScore('', 'anything'), 0);
});

test('ranking prefers prefixes, word starts and short names', () => {
  const items = ['cookbook', 'gitops-plane', 'agentsbuzz', 'latency-lab', 'old-idea', 'dotfiles'].map((title) => ({ title }));
  assert.equal(rankItems('laten', items)[0].title, 'latency-lab');
  assert.equal(rankItems('gp', items)[0].title, 'gitops-plane', 'initials of the words');
  assert.equal(rankItems('ab', items)[0].title, 'agentsbuzz');
  assert.deepEqual(rankItems('zzz', items), []);
  const tie = rankItems('plan', [{ title: 'planner-long-name' }, { title: 'planner' }]);
  assert.equal(tie[0].title, 'planner', 'the shorter name wins a tie');
});

test('every shortcut in the help sheet has a group, a label and at least one key', () => {
  const seen = new Set();
  for (const s of SHORTCUTS) {
    assert.ok(s.group && s.label && s.keys.length, JSON.stringify(s));
    const id = s.keys.join('+');
    assert.ok(!seen.has(id), `duplicate shortcut ${id}`);
    seen.add(id);
  }
});
