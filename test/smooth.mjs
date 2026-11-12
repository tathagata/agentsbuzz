// Manual check of the scroll rule: reading downward must never jump or reverse.
// Needs Playwright (not a project dependency):  node test/smooth.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PORT = 18000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smooth-'));
const server = spawn('node', ['server/server.js'], { env: { ...process.env, AGENTSBUZZ_TOKEN: '', PORT: String(PORT), AGENTSBUZZ_DB: path.join(tmp, 's.db') }, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (b) => fetch(`${BASE}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(100); }

const names = ['trailmap', 'agentsbuzz', 'latency-lab', 'cookbook', 'dotfiles'];
const now = Date.now();
const seed = [];
for (let i = 0; i < 400; i++) {
  const project = names[i % names.length];
  seed.push({ project, harness: i % 3 ? 'codex' : 'git', agent: 'a', session_id: `s${Math.floor(i / 3)}`, kind: i % 7 ? 'progress' : 'milestone', summary: `Event ${i}: ${'step '.repeat(1 + (i % 9))}`, ts: now - i * 600000 });
}
seed.sort((a, b) => a.ts - b.ts);
for (let i = 0; i < seed.length; i += 100) await post(seed.slice(i, i + 100));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
await page.goto(`${BASE}/#/feed`);
await page.waitForSelector('.post');

// record every scroll position change
await page.evaluate(() => {
  window.__trace = [];
  addEventListener('scroll', () => window.__trace.push(Math.round(scrollY)), { passive: true });
});

let live = 0;
const liveTimer = setInterval(() => post({ project: names[live % 5], harness: 'codex', agent: 'a', session_id: `live${live}`, kind: 'milestone', summary: `Live ${live++}`, ts: Date.now() }), 400);

// scroll down in 120px steps, the way a thumb does
let maxLoaded = 0;
for (let i = 0; i < 70; i++) {
  await page.mouse.wheel(0, 120);
  await sleep(45);
  maxLoaded = Math.max(maxLoaded, await page.locator('.post').count());
}
await sleep(500);
clearInterval(liveTimer);

const trace = await page.evaluate(() => window.__trace);
let reversals = 0, worst = 0;
for (let i = 1; i < trace.length; i++) { const d = trace[i] - trace[i - 1]; if (d < 0) { reversals++; worst = Math.min(worst, d); } }

// anchor test: park mid-feed, let events arrive, the post under the thumb must not move
await page.evaluate(() => scrollTo(0, 3000));
await sleep(400);
const probe = () => page.evaluate(() => { const top = document.querySelector('.top').offsetHeight; for (const el of document.querySelectorAll('#view [data-k]')) { const r = el.getBoundingClientRect(); if (r.bottom > top) return { k: el.dataset.k, top: Math.round(r.top) }; } });
const before = await probe();
for (let i = 0; i < 5; i++) await post({ project: 'trailmap', harness: 'codex', agent: 'a', session_id: `late${i}`, kind: 'milestone', summary: `Late ${i}`, ts: Date.now() });
await sleep(900);
const after = await probe();
const pill = await page.locator('#newpill').isVisible();

console.log(JSON.stringify({ posts: maxLoaded, scrollEvents: trace.length, reversals, worstJump: worst, anchorBefore: before, anchorAfter: after, pillShown: pill }));
const ok = reversals === 0 && before.k === after.k && Math.abs(before.top - after.top) <= 1 && maxLoaded > 60;
console.log(ok ? 'PASS' : 'FAIL');
await browser.close();
server.kill();
process.exit(ok ? 0 : 1);
