import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestions, QUICK_REPLIES } from '../web/suggest.js';

const words = (s, b) => suggestions(s, b).map((x) => `${x.icon} ${x.word}`);

test('an "X or Y?" question becomes two numbered one-word answers', () => {
  assert.deepEqual(words('Two recipes use units I cannot convert. Grams or cups for flour?'), ['n1 Grams', 'n2 Cups']);
  assert.equal(suggestions('Postgres or SQLite?')[1].reply, 'SQLite.');
});

test('lettered and numbered options: the button shows the first word, the reply names the whole option', () => {
  const s = suggestions('Need a decision', 'Options: (a) convert to grams with a note, (b) keep the original text');
  assert.deepEqual(s.map((x) => `${x.icon} ${x.word}`), ['n1 Convert', 'n2 Keep']);
  assert.deepEqual(s.map((x) => x.reply), ['(a) convert to grams with a note', '(b) keep the original text']);
  assert.deepEqual(words('Which store?', '1. Postgres\n2. SQLite\n3. JSON files'), ['n1 Postgres', 'n2 SQLite', 'n3 JSON']);
});

test('a yes/no question gets Yes and No; anything else gets Go', () => {
  assert.deepEqual(words('Should I open the PR now?'), ['yes Yes', 'no No']);
  assert.deepEqual(words('Need the **staging** capture sample'), ['go Go']);
});

test('every button is a known icon and at most one short word, at most four of them', () => {
  const many = suggestions('x', Array.from({ length: 6 }, (_, i) => `${i + 1}. Supercalifragilisticexpialidocious option ${i + 1}`).join('\n'));
  assert.ok(many.length <= 4);
  for (const s of [...many, ...suggestions('Grams or cups?'), ...suggestions('Should I?'), ...QUICK_REPLIES]) {
    assert.match(s.word, /^\S{1,14}$/, `one word: ${s.word}`);
    assert.match(s.icon, /^(go|test|pr|explain|stop|yes|no|n[1-4])$/, `icon: ${s.icon}`);
  }
});

test('markup in the agent text never reaches a button', () => {
  assert.deepEqual(words('Use **bold** or `code`?'), ['n1 Bold', 'n2 Code']);
  assert.equal(suggestions('<img src=x onerror=alert(1)> or <b>?').some((s) => /[<>]/.test(s.word)), false);
});

test('quick replies add a whole phrase', () => {
  for (const q of QUICK_REPLIES) assert.match(q.text, /^[A-Z][A-Za-z ]+$/);
});
