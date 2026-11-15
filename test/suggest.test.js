import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestions, QUICK_REPLIES } from '../web/suggest.js';

const labels = (s, b) => suggestions(s, b).map((x) => x.label);

test('an "X or Y?" question becomes two answers', () => {
  assert.deepEqual(labels('Two recipes use units I cannot convert. Grams or cups for flour?'), ['Grams', 'Cups']);
  assert.equal(suggestions('Postgres or SQLite?')[1].reply, 'SQLite.');
});

test('lettered and numbered options become answers that name the option', () => {
  const s = suggestions('Need a decision', 'Options: (a) convert to grams with a note, (b) keep the original text');
  assert.deepEqual(s.map((x) => x.reply), ['(a) convert to grams with a note', '(b) keep the original text']);
  assert.deepEqual(labels('Which store?', '1. Use Postgres\n2. Use SQLite\n3. Keep JSON files'), ['1 · Use Postgres', '2 · Use SQLite', '3 · Keep JSON files']);
});

test('a yes/no question gets Yes and No; anything else gets Go ahead', () => {
  assert.deepEqual(labels('Should I open the PR now?'), ['Yes', 'No']);
  assert.deepEqual(labels('Need the **staging** capture sample'), ['Go ahead']);
});

test('answers stay short, few and plain text', () => {
  const many = suggestions('x', Array.from({ length: 6 }, (_, i) => `${i + 1}. option number ${i + 1} with a rather long description that keeps going`).join('\n'));
  assert.ok(many.length <= 4);
  for (const s of many) assert.ok(s.label.length <= 34, s.label);
  // markup in the agent's text is not carried into a button
  assert.deepEqual(labels('Use **bold** or `code`?'), ['Bold', 'Code']);
  assert.equal(labels('<img src=x onerror=alert(1)> or <b>?').some((l) => l.includes('<')), false);
});

test('quick replies are plain phrases', () => {
  for (const q of QUICK_REPLIES) assert.match(q, /^[A-Z][A-Za-z ]+$/);
});
