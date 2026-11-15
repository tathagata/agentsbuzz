// Manual browser check of the feed UI: markdown, wrapping code, and the floating project dock.
// Needs Playwright (not a project dependency):  node test/ui.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PORT = 19000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`;
const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ui-')), 'ui.db');
const server = spawn('node', ['server/server.js'], { cwd: ROOT, env: { ...process.env, AGENTSBUZZ_TOKEN: '', PORT: String(PORT), AGENTSBUZZ_DB: db }, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// wait for the server to answer, not a fixed time: slow CI runners need longer
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) break;
  } catch {
    /* not up yet */
  }
  await sleep(100);
}
const j = (p, b, m = 'POST') => fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const now = Date.now(), min = 60000, day = 86400000;
const body1 = `## What changed

I reworked the **rules compiler** so layered constraints resolve in one pass. Key points:

- \`compile()\` now returns a \`Plan\` instead of a raw list
- Blocked routes carry an *explanation* with the failing layer
- Tests: **42 passing**, 0 failing

\`\`\`ts
export async function explainBlockedRoute(routeId: string, opts: { layer?: string; includeHistory?: boolean } = {}): Promise<Explanation> {
  const rules = await loadRulesForMap(routeId, { includeHistory: opts.includeHistory ?? false });
  return rules.reduce((acc, r) => acc.merge(r.evaluate(routeId)), Explanation.empty());
}
\`\`\`

| Layer | Result |
|---|---|
| Desk | ok |
| Counterparty | **blocked** |

See [the PR](https://github.com/example/trailmap/pull/12) or https://example.com/very/long/path/that/keeps/going/and/going/for/a/while/to/test/wrapping.`;
await j('/api/events', [
  { project: 'trailmap', harness: 'claude-code', agent: 'claude', session_id: 's1', kind: 'milestone', summary: '**Rules compiler** now resolves layered constraints in one pass', body: body1, ts: now - 4 * min },
  { project: 'trailmap', harness: 'claude-code', agent: 'claude', session_id: 's1', kind: 'progress', summary: 'Wiring the `audit` trail into the explainer', ts: now - 1 * min },
  { project: 'agentsbuzz', harness: 'codex', agent: 'codex', session_id: 'a1', kind: 'done', summary: 'Dock switcher works', body: 'Added the floating switcher.\n\n```bash\nnpm test && ./buzz status --verbose --projects ~/projects/with/a/really/long/path/name\n```', ts: now - 9 * min },
  { project: 'latency-lab', harness: 'cursor', agent: 'cursor', session_id: 'l1', kind: 'blocked', needs_you: true, summary: 'Need the **staging** capture sample', ts: now - 30 * min },
  { project: 'cookbook', harness: 'git', agent: 'T', session_id: 'c1', kind: 'progress', summary: 'Add the miso soup recipe', ts: now - 2 * day },
  { project: 'dotfiles', harness: 'git', agent: 'T', session_id: 'd1', kind: 'progress', summary: 'Tidy zshrc', ts: now - 9 * day },
  { project: 'gitops-plane', harness: 'claude-code', agent: 'claude', session_id: 'g1', kind: 'progress', summary: 'Form validation fixed', ts: now - 3 * 3600000 },
  // a thread for the ordering check: two earlier updates under the newest post
  { project: 'gitops-plane', harness: 'claude-code', agent: 'claude', session_id: 'g1', kind: 'progress', summary: 'Older update one', ts: now - 5 * 3600000 },
  { project: 'gitops-plane', harness: 'claude-code', agent: 'claude', session_id: 'g1', kind: 'progress', summary: 'Older update two', ts: now - 4 * 3600000 },
]);
{
  const g1 = (await (await fetch(BASE + '/api/events?session_id=g1&limit=1')).json()).events[0];
  await j(`/api/events/${g1.id}/reply`, { prompt: 'first message' });
  await j(`/api/events/${g1.id}/reply`, { prompt: 'second message' });
  // a reply the agent has already picked up: its fold shows no waiting state
  const a1 = (await (await fetch(BASE + '/api/events?session_id=a1&limit=1')).json()).events[0];
  await j(`/api/events/${a1.id}/reply`, { prompt: 'picked up already' });
  await j('/api/replies/claim', { session_id: 'a1', project: 'agentsbuzz' });
}
for (const [n, st] of [['cookbook', 'paused'], ['dotfiles', 'paused'], ['old-idea', 'idea'], ['trailmap', 'active'], ['agentsbuzz', 'active'], ['latency-lab', 'active'], ['gitops-plane', 'active']]) await j(`/api/projects/${n}`, { status: st, plan: n === 'trailmap' ? [{ title: 'Rules', status: 'done' }, { title: 'Explainer', status: 'doing' }, { title: 'Demo', status: 'todo' }] : undefined }, 'PUT');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
// The server sends a strict Content-Security-Policy; anything the app does that it blocks fails this check.
const cspViolations = [];
p.on('console', (m) => /Content Security Policy|Refused to (apply|load|execute|connect|frame)/i.test(m.text()) && cspViolations.push(m.text()));
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(BASE + '/#/');
await p.waitForSelector('.post');
await sleep(500);

// markdown is rendered, not shown raw
assert.ok(await p.locator('.text strong:has-text("Rules compiler")').count(), 'bold in summary');
assert.equal(await p.locator('.body.md strong').first().textContent(), 'rules compiler');
assert.ok(!(await p.locator('.body').first().textContent()).includes('**'), 'no raw ** left');
await p.click('.more-btn');
assert.ok(await p.locator('.body.md table').count(), 'table rendered');
assert.ok(await p.locator('.body.md ul li').count() >= 3, 'list rendered');
assert.equal(await p.locator('.body.md script, .body.md img').count(), 0);

// avatars: a two-letter monogram per project, the same everywhere, never shared by two projects
{
  const seen = await p.locator('.post').evaluateAll((els) => els.map((e) => [e.querySelector('.proj-link').textContent, e.querySelector('.avatar').textContent]));
  const byProject = new Map();
  for (const [proj, mono] of seen) {
    assert.match(mono, /^[A-Z0-9?]{1,2}$/, `${proj}: ${mono}`);
    assert.equal(byProject.get(proj) ?? mono, mono, `${proj} shows one monogram`);
    byProject.set(proj, mono);
  }
  const monos = [...byProject.values()];
  assert.equal(new Set(monos).size, monos.length, `no two projects share a monogram: ${monos.join(' ')}`);
  assert.equal(byProject.get('trailmap'), 'TR');
  assert.equal(byProject.get('gitops-plane'), 'GP');
}

// code wraps: no block is wider than its box, and the page never scrolls sideways
const wide = await p.evaluate(() => [...document.querySelectorAll('.code pre')].filter((e) => e.scrollWidth > e.clientWidth + 1).length);
assert.equal(wide, 0, 'code blocks wrap');
assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal scroll');

// threads read newest first: Reply box on top, then your messages, then the earlier updates
{
  const post = p.locator('.post', { hasText: 'Form validation fixed' });
  // your messages are folded like the updates, behind a count
  assert.equal(await post.locator('.msgs').count(), 0, 'replies start folded');
  const repliesBtn = post.locator('button.act', { hasText: /^2 replies/ });
  assert.equal(await repliesBtn.count(), 1, 'the fold says how many replies there are');
  // neither has reached the agent: the folded button says so, in the waiting colour
  assert.equal(await repliesBtn.textContent(), '2 replies · 2 waiting');
  assert.match(await repliesBtn.getAttribute('class'), /\bwaiting\b/);
  await repliesBtn.tap();
  const hideBtn = post.locator('button.act', { hasText: 'Hide replies' });
  assert.doesNotMatch(await hideBtn.getAttribute('class'), /\bwaiting\b/, 'once open, the messages show their own state');
  await post.locator('button.act', { hasText: /updates?$/ }).tap();
  await post.locator('button.act', { hasText: /^Reply$/ }).tap();
  await sleep(300);
  const order = await post.evaluate((el) => [...el.querySelectorAll('.composer, .msgs, .thread')].map((x) => x.className.split(' ')[0]));
  assert.deepEqual(order, ['composer', 'msgs', 'thread'], 'Reply box first, then messages, then updates');
  assert.deepEqual(await post.locator('.msg-text').allTextContents(), ['second message', 'first message'], 'messages newest first');
  const ups = await post.locator('.reply-line').evaluateAll((els) => els.map((e) => e.lastChild.textContent));
  assert.deepEqual(ups, ['Older update two', 'Older update one'], 'updates newest first');
  await post.locator('button.act', { hasText: /^Reply$/ }).tap(); // close it again
  await post.locator('button.act', { hasText: 'Hide replies' }).tap();
  assert.equal(await post.locator('.msgs').count(), 0, 'Hide replies folds them again');
  // a delivered reply folds to a plain count, without the waiting colour
  const done = p.locator('.post', { hasText: 'Dock switcher works' }).locator('button.act', { hasText: /repl/ });
  assert.equal(await done.textContent(), '1 reply');
  assert.doesNotMatch(await done.getAttribute('class'), /\bwaiting\b/);
}

// the dock: opens, shows active projects first, switches the feed in place
await p.tap('#dockBtn');
await p.waitForSelector('.tray:not([hidden])');
assert.ok(!(await p.locator('#dockBtn').textContent()).includes('null'), 'no stray null on the dock button');
assert.ok(!(await p.locator('#tray').textContent()).includes('null'), 'no stray null in the tray');
const pills = await p.locator('.dk-pill .lbl').allTextContents();
assert.ok(pills.includes('trailmap') && pills.includes('All') && pills.includes('Plans'), pills.join());
assert.ok(!pills.includes('dotfiles'), 'quiet projects stay tucked away');
await p.tap('.dk-pill.more');
assert.ok((await p.locator('.dk-pill .lbl').allTextContents()).includes('dotfiles'), 'quiet projects can be revealed');
await p.tap('.dk-pill:has-text("trailmap")');
await sleep(500);
assert.equal(await p.evaluate(() => location.hash), '#/f/trailmap');
assert.equal(await p.locator('.post').evaluateAll((els) => els.every((e) => e.querySelector('.proj-link').textContent === 'trailmap')), true, 'feed narrowed to the project');
assert.equal(await p.locator('.tray:not([hidden])').count(), 0, 'dock closes after choosing');
assert.ok(await p.locator('.scope-plan').count(), 'plan link on the scope header');

// back to everything from the dock, and Escape closes it
await p.tap('#dockBtn');
await p.tap('.dk-pill.all');
await sleep(400);
assert.equal(await p.locator('.scope').count(), 0);
await p.tap('#dockBtn');
await p.keyboard.press('Escape');
assert.equal(await p.locator('.tray:not([hidden])').count(), 0);
// keyboard: move, act on a post, jump anywhere, all without the mouse
{
  const kb = p.keyboard;
  const selText = () => p.locator('.post.sel .text').textContent();
  const titles = await p.locator('#view .post .text').allTextContents();
  await kb.press('j');
  assert.equal(await p.locator('.post.sel').count(), 1, 'j selects a post');
  const first = await selText();
  await kb.press('j');
  assert.notEqual(await selText(), first, 'j moves to the next post');
  await kb.press('k');
  assert.equal(await selText(), first, 'k moves back');

  // walk to the thread with updates and messages, open it with Enter, reply with r and ⌘↵
  const target = titles.findIndex((t) => t.includes('Form validation fixed'));
  const at = titles.findIndex((t) => t === first);
  for (let i = at; i < target; i++) await kb.press('j');
  assert.match(await selText(), /Form validation fixed/);
  const wasOpen = await p.locator('.post.sel .thread').count();
  await kb.press('Enter');
  assert.equal(await p.locator('.post.sel .thread').count(), wasOpen ? 0 : 1, 'Enter shows or hides the updates');
  if (wasOpen) await kb.press('o');
  assert.equal(await p.locator('.post.sel .thread').count(), 1, 'o does the same');
  await kb.press('r');
  assert.equal(await p.evaluate(() => document.activeElement.tagName), 'TEXTAREA', 'r opens the Reply box and puts the cursor in it');
  await kb.type('sent from the keyboard');
  await kb.press('Control+Enter');
  await p.waitForFunction(() => [...document.querySelectorAll('.post.sel .msg-text')].some((e) => e.textContent === 'sent from the keyboard'));
  assert.equal(await p.locator('.post.sel .composer').count(), 0, 'sending closes the Reply box');

  // ⌘K: type part of a name, Enter goes to that project's feed
  await kb.press('Control+k');
  assert.equal(await p.locator('dialog.kpal[open]').count(), 1, 'Ctrl/⌘K opens the palette');
  // screen readers can follow the active result; browser shortcuts like Ctrl+N stay the browser's
  const input = p.locator('.kp-input');
  assert.equal(await input.getAttribute('role'), 'combobox');
  assert.equal(await input.getAttribute('aria-controls'), await p.locator('.kp-list').getAttribute('id'));
  assert.equal(await input.getAttribute('aria-activedescendant'), await p.locator('.kp-item.on').getAttribute('id'));
  await kb.press('ArrowDown');
  assert.equal(await input.getAttribute('aria-activedescendant'), await p.locator('.kp-item.on').getAttribute('id'), 'follows the arrow keys');
  for (const key of ['n', 'p']) {
    const prevented = await input.evaluate((el, k) => !el.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, cancelable: true })), key);
    assert.equal(prevented, false, `Ctrl+${key.toUpperCase()} is left to the browser`);
  }
  await kb.type('zzzzqq');
  assert.equal(await input.getAttribute('aria-activedescendant'), null, 'no active result when nothing matches');
  await input.fill('');
  await kb.type('laten');
  assert.equal(await p.locator('.kp-item.on .kp-title').textContent(), 'latency-lab');
  await kb.press('Enter');
  await p.waitForFunction(() => location.hash === '#/f/latency-lab');
  assert.equal(await p.locator('dialog.kpal[open]').count(), 0, 'the palette goes away');
  await p.waitForFunction(() => {
    const posts = [...document.querySelectorAll('#view .post .proj-link')];
    return posts.length && posts.every((e) => e.textContent === 'latency-lab');
  });

  // e marks the needs-you post handled
  await kb.press('j');
  assert.match(await selText(), /staging/);
  await kb.press('e');
  await p.waitForFunction(async () => {
    const r = await fetch('/api/events?project=latency-lab&needs=1').then((x) => x.json());
    return r.events.length === 0;
  });

  // two-key jumps, quiet, help, Esc
  await kb.press('g');
  await kb.press('p');
  await p.waitForFunction(() => location.hash === '#/projects');
  await kb.press('g');
  await kb.press('f');
  await p.waitForFunction(() => location.hash === '#/');
  const quiet = await p.locator('#quiet').getAttribute('aria-pressed');
  await kb.press('q');
  assert.notEqual(await p.locator('#quiet').getAttribute('aria-pressed'), quiet, 'q toggles quiet');
  await kb.press('q');
  await kb.press('Shift+?');
  assert.equal(await p.locator('dialog.khelp[open]').count(), 1, '? shows the shortcuts');
  assert.ok((await p.locator('dialog.khelp').textContent()).includes('Next post'));
  await kb.press('Escape');
  assert.equal(await p.locator('dialog.khelp[open]').count(), 0, 'Esc closes it');

  // a highlight never outlives its selection: select, leave the feed, come back, nothing looks selected
  await kb.press('j');
  assert.equal(await p.locator('.post.sel').count(), 1);
  await p.evaluate(() => (location.hash = '#/projects'));
  await p.waitForFunction(() => !document.querySelector('#view .post'));
  await p.evaluate(() => (location.hash = '#/'));
  await p.waitForFunction(() => document.querySelector('#view .post'));
  await sleep(200);
  assert.equal(await p.locator('.post.sel').count(), 0, 'no stale highlight after coming back');

  // Enter on a focused button presses that button; it does not act on the selected post
  await kb.press('j');
  const selKey = await p.locator('.post.sel').getAttribute('data-k');
  const other = p.locator('.post:not(.sel)', { has: p.locator('button.act', { hasText: 'Reply' }) }).first();
  const otherKey = await other.getAttribute('data-k');
  const selOpen = await p.locator('.post.sel .thread').count();
  await other.locator('button.act', { hasText: 'Reply' }).focus();
  await kb.press('Enter');
  await p.waitForFunction((k) => document.querySelector(`.post[data-k="${CSS.escape(k)}"] .composer`), otherKey);
  assert.equal(await p.locator(`.post[data-k="${selKey}"] .thread`).count(), selOpen, 'the selected post was not toggled');
  await kb.press('Escape'); // leave the (empty) Reply box: it closes
  await sleep(150);

  // e acts only on the update you can see: an older needs-you item hidden in the thread is left alone
  {
    const now2 = Date.now();
    const made = await j('/api/events', [
      { project: 'cookbook', harness: 'claude-code', agent: 'claude', session_id: 'kx', kind: 'blocked', summary: 'Which oven temperature?', ts: now2 - 20 * 60000 },
      { project: 'cookbook', harness: 'claude-code', agent: 'claude', session_id: 'kx', kind: 'done', summary: 'Plated the soup', ts: now2 - 19 * 60000 },
    ]);
    const oldNeed = made.ids[0];
    const post = p.locator('.post', { hasText: 'Plated the soup' });
    await post.waitFor();
    await kb.press('Escape'); // no selection: j picks the first post on screen
    await post.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await sleep(200);
    await kb.press('j');
    assert.match(await selText(), /Plated the soup/);
    await kb.press('e');
    await sleep(400);
    const still = (await (await fetch(`${BASE}/api/events?session_id=kx`)).json()).events.find((x) => x.id === oldNeed);
    assert.equal(still.resolved, 0, 'the hidden older needs-you item was not marked handled');
    await fetch(`${BASE}/api/events/${oldNeed}/resolve`, { method: 'POST' }); // tidy up for the steps below
    await p.evaluate(() => scrollTo(0, 0));
  }

  // ⌘K never opens over the project editor, so a half-filled form is never replaced
  {
    await p.evaluate(() => (location.hash = '#/projects'));
    await p.locator('#add').click();
    await p.locator('#pdName').fill('half-typed');
    await kb.press('Control+k');
    await sleep(150);
    assert.equal(await p.locator('dialog.kpal[open]').count(), 0, 'no palette over the dialog');
    assert.equal(await p.locator('#pdName').inputValue(), 'half-typed', 'the form keeps what was typed');
    await p.locator('#pdCancel').click();
    await p.evaluate(() => (location.hash = '#/'));
    await p.waitForFunction(() => document.querySelector('#view .post'));
  }

  // keys typed into a text box stay text: j in the Reply box is a letter, not "next post"
  await kb.press('j');
  const sel = await selText();
  await kb.press('r');
  await kb.type('jk');
  assert.equal(await selText(), sel, 'typing does not move the selection');
  assert.equal(await p.locator('.post.sel textarea').inputValue(), 'jk');
  await kb.press('Escape');
  assert.equal(await p.evaluate(() => document.activeElement.tagName), 'BODY', 'Esc leaves the Reply box');
}

assert.deepEqual(errs, []);
assert.deepEqual(cspViolations, [], 'the app must work under its Content-Security-Policy');
console.log('PASS');
await b.close();
server.kill();
