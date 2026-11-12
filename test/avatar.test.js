import { test } from 'node:test';
import assert from 'node:assert/strict';
import { words, assignMonograms, colorFor, hueFor } from '../web/avatar.js';

test('names split into words at dashes, underscores, dots and camelCase', () => {
  assert.deepEqual(words('work-queue-grid'), ['work', 'queue', 'grid']);
  assert.deepEqual(words('l_python_notes'), ['l', 'python', 'notes']);
  assert.deepEqual(words('photoLib'), ['photo', 'Lib']);
  assert.deepEqual(words('_scratch-test'), ['scratch', 'test']);
  assert.deepEqual(words('Alpha-GPT'), ['Alpha', 'GPT']);
});

test('monograms use the first letters of the first two words, or the first two letters', () => {
  const m = assignMonograms(['work-queue-grid', 'l_python_notes', 'app', 'skyline', 'XY_ZED']);
  assert.equal(m.get('work-queue-grid'), 'WQ');
  assert.equal(m.get('l_python_notes'), 'LP');
  assert.equal(m.get('app'), 'AP');
  assert.equal(m.get('skyline'), 'SK');
  assert.equal(m.get('XY_ZED'), 'XZ');
});

test('no two projects share a monogram, even many starting with the same letter', () => {
  const names = ['agentsbuzz', 'app', 'Alpha-GPT', 'atlas', 'analytics', 'ansible-lab', 'audit-evidence-workspace', 'admin_tools',
    'a', 'ab', 'a-b', 'a_b_c', 'aa', 'aaa', 'A', 'x', 'x1', 'x-1', '', '___'];
  const m = assignMonograms(names);
  const codes = [...m.values()];
  assert.equal(new Set(codes).size, codes.length, codes.join(' '));
  for (const c of codes) assert.match(c, /^[\p{Lu}\p{N}?]{1,2}$/u, c);
});

test('siblings that differ at the end get told apart by their last word', () => {
  const m = assignMonograms(['work-queue-grid', 'work-queue-grid-podman']);
  assert.equal(m.get('work-queue-grid'), 'WQ');
  assert.equal(m.get('work-queue-grid-podman'), 'WP');
});

test('the same projects give the same monograms whatever order they arrive in (every device agrees)', () => {
  const names = ['tide', 'tally', 'tempo', 'pilot', 'pulse', 'prism', 'pay_stub'];
  const a = assignMonograms(names);
  const b = assignMonograms([...names].reverse());
  assert.deepEqual([...a].sort(), [...b].sort());
});

test('colors come from the name only: stable, one of twelve well-spaced hues', () => {
  assert.equal(colorFor('agentsbuzz'), colorFor('agentsbuzz'));
  const hues = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't'].map(hueFor));
  for (const h of hues) assert.equal((h - 25) % 30, 0, String(h));
  assert.ok(hues.size >= 8, 'names spread over the palette');
  assert.match(colorFor('x'), /^hsl\(\d+ 62% 62%\)$/);
});

test('uniqueness holds even when a letter runs out of its own candidates (40 names, one letter)', () => {
  const names = Array.from({ length: 40 }, (_, i) => 'a'.repeat(i + 1));
  const codes = [...assignMonograms(names).values()];
  assert.equal(new Set(codes).size, 40, codes.join(' '));
  const many = Array.from({ length: 300 }, (_, i) => `p${i}`);
  assert.equal(new Set(assignMonograms(many).values()).size, 300);
});

test('every device agrees whatever its language settings (no locale-sensitive sorting)', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const mod = fileURLToPath(new URL('../web/avatar.js', import.meta.url));
  const code = `const m = await import(${JSON.stringify(mod)}); console.log(JSON.stringify([...m.assignMonograms(['aä-b', 'az-b', 'ab', 'Éclair', 'eclair'])]))`;
  const run = (L) => execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, LANG: L, LC_ALL: L }, encoding: 'utf8' });
  assert.equal(run('sv_SE.UTF-8'), run('en_US.UTF-8'));
});

test('letters outside A-Z count, and a monogram is never longer than two characters', () => {
  assert.deepEqual(words('café-über'), ['café', 'über']);
  const m = assignMonograms(['über-app', 'straße', 'ßeta']);
  assert.equal(m.get('über-app'), 'ÜA');
  for (const c of m.values()) assert.ok([...c].length <= 2, c);
});

test('letters outside the basic plane stay whole in every position (no half surrogate pairs)', () => {
  const lone = /[\uD800-\uDFFF]/;
  const ok = (c) => !lone.test(c.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''));
  const m = assignMonograms(['foo-\u{10428}bar', '\u{10428}x-y', 'a-b-\u{1D400}c', 'a-b']);
  for (const [name, c] of m) assert.ok(ok(c), `${name}: ${JSON.stringify(c)}`);
  assert.equal(m.get('foo-\u{10428}bar'), 'F\u{10400}'); // 𐐨 upper-cases to 𐐀
});
