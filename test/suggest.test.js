import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestions, QUICK_REPLIES } from '../web/suggest.js';

const words = (s, b) => suggestions(s, b).map((x) => `${x.emoji} ${x.word}`);

test('an "X or Y?" question becomes two numbered one-word answers', () => {
  assert.deepEqual(words('Two recipes use units I cannot convert. Grams or cups for flour?'), ['1️⃣ Grams', '2️⃣ Cups']);
  assert.equal(suggestions('Postgres or SQLite?')[1].reply, 'SQLite.');
});

test('lettered and numbered options: the button shows the first word, the reply names the whole option', () => {
  const s = suggestions('Need a decision', 'Options: (a) convert to grams with a note, (b) keep the original text');
  assert.deepEqual(s.map((x) => `${x.emoji} ${x.word}`), ['1️⃣ Convert', '2️⃣ Keep']);
  assert.deepEqual(s.map((x) => x.reply), ['(a) convert to grams with a note', '(b) keep the original text']);
  assert.deepEqual(words('Which store?', '1. Postgres\n2. SQLite\n3. JSON files'), ['1️⃣ Postgres', '2️⃣ SQLite', '3️⃣ JSON']);
});

test('a yes/no question gets Yes and No; anything else gets Go', () => {
  assert.deepEqual(words('Should I open the PR now?'), ['👍 Yes', '👎 No']);
  assert.deepEqual(words('Need the **staging** capture sample'), ['👍 Go']);
});

test('every button is an emoji and at most one short word, at most four of them', () => {
  const many = suggestions('x', Array.from({ length: 6 }, (_, i) => `${i + 1}. Supercalifragilisticexpialidocious option ${i + 1}`).join('\n'));
  assert.ok(many.length <= 4);
  for (const s of [...many, ...suggestions('Grams or cups?'), ...suggestions('Should I?'), ...QUICK_REPLIES]) {
    assert.match(s.word, /^\S{1,14}$/, `one word: ${s.word}`);
    assert.ok(s.emoji && !/[\p{L}\p{N}]/u.test(s.emoji.replace(/️|⃣/g, '').replace(/[0-9]/g, '')), `emoji: ${s.emoji}`);
  }
});

test('markup in the agent text never reaches a button', () => {
  assert.deepEqual(words('Use **bold** or `code`?'), ['1️⃣ Bold', '2️⃣ Code']);
  assert.equal(suggestions('<img src=x onerror=alert(1)> or <b>?').some((s) => /[<>]/.test(s.word)), false);
});

test('quick replies add a whole phrase', () => {
  for (const q of QUICK_REPLIES) assert.match(q.text, /^[A-Z][A-Za-z ]+$/);
});
