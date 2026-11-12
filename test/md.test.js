import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInline, parseBlocks } from '../web/md.js';

const flat = (list) => list.map((n) => (n.t === 'text' ? n.v : n.t === 'br' ? '\n' : `<${n.t}${n.href ? ` ${n.href}` : ''}>${n.c ? flat(n.c) : n.v}</${n.t}>`)).join('');

test('inline: bold, italic, code, strike, links', () => {
  assert.equal(flat(parseInline('a **bold** and *it* and `x()` and ~~gone~~')), 'a <strong>bold</strong> and <em>it</em> and <code>x()</code> and <del>gone</del>');
  assert.equal(flat(parseInline('see [the docs](https://example.com/a?b=1) now')), 'see <a https://example.com/a?b=1>the docs</a> now');
  assert.equal(flat(parseInline('**`code` inside bold**')), '<strong><code>code</code> inside bold</strong>');
});

test('inline: code is literal, snake_case and math stay as written', () => {
  assert.equal(flat(parseInline('`**not bold**`')), '<code>**not bold**</code>');
  assert.equal(flat(parseInline('use my_var_name and 2*3*4 ok')), 'use my_var_name and 2*3*4 ok');
  assert.equal(flat(parseInline('file_name.py and __init__.py')), 'file_name.py and __init__.py');
  assert.equal(flat(parseInline('__really bold__ and _slanted words_')), '<strong>really bold</strong> and <em>slanted words</em>');
});

test('inline: bare URLs link without swallowing punctuation', () => {
  assert.equal(flat(parseInline('Open https://github.com/x/y/pull/7.')), 'Open <a https://github.com/x/y/pull/7>https://github.com/x/y/pull/7</a>.');
  assert.equal(flat(parseInline('(see https://example.com/a)')), '(see <a https://example.com/a>https://example.com/a</a>)');
});

test('inline: unsafe link targets never become links', () => {
  for (const bad of ['[x](javascript:alert(1))', '[x](data:text/html;base64,AAAA)', '[x](/relative)', '[x](vbscript:y)']) {
    const nodes = parseInline(bad);
    const has = JSON.stringify(nodes).includes('"t":"a"');
    assert.equal(has, false, bad);
  }
  assert.ok(JSON.stringify(parseInline('[x](mailto:a@b.c)')).includes('"t":"a"'));
});

test('inline: unclosed markers stay literal, truncated summaries are safe', () => {
  assert.equal(flat(parseInline('Added **the thing and `foo')), 'Added **the thing and `foo');
});

test('blocks: headings, paragraphs, line breaks', () => {
  const b = parseBlocks('## Result\nAll **green**.\nSecond line\n\nNew paragraph');
  assert.deepEqual(b.map((x) => x.t), ['h', 'p', 'p']);
  assert.equal(b[0].level, 2);
  assert.equal(flat(b[1].c), 'All <strong>green</strong>.\nSecond line');
});

test('blocks: fenced code keeps everything literal, even unclosed', () => {
  const b = parseBlocks('Run:\n```js\nconst a = "**x**"; // <script>\nif (a) {\n  b();\n}\n```\nDone');
  assert.deepEqual(b.map((x) => x.t), ['p', 'code', 'p']);
  assert.equal(b[1].lang, 'js');
  assert.equal(b[1].text, 'const a = "**x**"; // <script>\nif (a) {\n  b();\n}');
  const open = parseBlocks('```\nline1\nline2');
  assert.equal(open[0].t, 'code');
  assert.equal(open[0].text, 'line1\nline2');
});

test('blocks: lists, nesting, ordered start, tasks', () => {
  const b = parseBlocks('- one\n- two\n  - nested\n- three\n\n3. third\n4. fourth\n\n- [x] done\n- [ ] todo');
  assert.deepEqual(b.map((x) => x.t), ['ul', 'ol', 'ul']);
  assert.equal(b[0].items.length, 3);
  assert.equal(b[0].items[1].children[0].items.length, 1);
  assert.equal(b[1].start, 3);
  assert.equal(b[2].items[0].task, true);
  assert.equal(b[2].items[1].task, false);
});

test('blocks: a list can follow a paragraph with no blank line', () => {
  assert.deepEqual(parseBlocks('Changes:\n- a\n- b').map((x) => x.t), ['p', 'ul']);
});

test('blocks: tables, quotes, rules', () => {
  const t = parseBlocks('| Name | Status |\n|---|:-:|\n| a | ok |\n| b | **no** |')[0];
  assert.equal(t.t, 'table');
  assert.equal(t.head.length, 2);
  assert.equal(t.rows.length, 2);
  assert.equal(flat(t.rows[1][1]), '<strong>no</strong>');
  assert.deepEqual(parseBlocks('> quoted\n> text\n\n---').map((x) => x.t), ['quote', 'hr']);
});

test('plain agent text with no markdown comes through untouched', () => {
  const b = parseBlocks('Fixed the bug in parse.js. All 42 tests pass.');
  assert.equal(b.length, 1);
  assert.equal(flat(b[0].c), 'Fixed the bug in parse.js. All 42 tests pass.');
});

test('markup in agent text is data, never structure', () => {
  const b = parseBlocks('<img src=x onerror=alert(1)> and <script>alert(2)</script>');
  assert.equal(b[0].t, 'p');
  assert.equal(flat(b[0].c), '<img src=x onerror=alert(1)> and <script>alert(2)</script>');
});
