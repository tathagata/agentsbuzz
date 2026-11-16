// agentsbuzz client. No build step, no dependencies. Agent text is rendered as DOM nodes (never HTML strings).
import { renderMarkdown, renderInline } from '/md.js';
import { assignMonograms, colorFor } from '/avatar.js';
import { installShortcuts } from '/keys.js';
import { suggestions, QUICK_REPLIES } from '/suggest.js';

const $ = (id) => document.getElementById(id);
const IMPORTANT = new Set(['milestone', 'done', 'pr', 'blocked', 'error']);
const KIND_LABEL = { milestone: 'Milestone', done: 'Done', pr: 'PR', blocked: 'Blocked', error: 'Error', started: 'Started', note: 'Note' };
const STATUS_LABEL = { idea: 'Idea', active: 'Active', paused: 'Paused', done: 'Done' };
const STATUS_ORDER = ['active', 'idea', 'paused', 'done'];
const NEXT_STEP = { todo: 'doing', doing: 'done', done: 'todo' };
const STEP_LABEL = { todo: 'Not started', doing: 'In progress', done: 'Done' };
const LIVE_MS = 2 * 60 * 1000;
const STALE_MS = 3 * 24 * 3600 * 1000;
const PAGE = 60;

// A link like /#t=TOKEN signs in without typing, then lands on the feed. The token never stays in the address bar.
(() => {
  const m = location.hash.match(/^#t=([^&/]+)/);
  if (!m) return;
  try {
    localStorage.setItem('buzz.token', decodeURIComponent(m[1]));
  } catch {
    /* private mode: the prompt will ask instead */
  }
  history.replaceState(null, '', `${location.pathname}${location.search}#/feed`);
})();

const state = {
  events: new Map(), // id -> event
  projects: new Map(), // name -> project
  route: { page: 'home', name: '' },
  feedProject: '', // set from the route: #/f/<name> narrows the feed to one project
  showQuiet: localStorage.getItem('buzz.showQuiet') === '1', // dock: reveal the quiet projects
  dockOpen: false,
  wake: false, // the server wakes idle agents when you message them
  navDepth: 0,
  quiet: localStorage.getItem('buzz.quiet') === '1',
  expanded: new Set(),
  composing: new Set(),
  topOpen: false, // the one-line box at the top of the feed, opened
  topProject: '', // the project you picked in it
  drafts: new Map(),
  cursors: new Map(), // scope -> { oldest, done, loaded }
  loading: false,
  replies: new Map(), // id -> message left for an agent
  pos: new Map(), // top-level route -> scrollY, so Back lands where you were
  unseen: 0,
};

// ---------- api ----------
const token = () => localStorage.getItem('buzz.token') || '';
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token()) headers.authorization = `Bearer ${token()}`;
  if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    await askToken();
    return api(path, opts);
  }
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

function askToken() {
  return new Promise((resolve) => {
    const dlg = $('auth');
    $('authForm').onsubmit = () => {
      localStorage.setItem('buzz.token', $('tokenInput').value.trim());
      resolve();
    };
    if (!dlg.open) dlg.showModal();
  });
}

// ---------- helpers ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v; // CSSOM, so the strict CSP needs no 'unsafe-inline'
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

// Project colors and monograms come from the name alone (web/avatar.js), so they match on every device.
const color = colorFor;
let monoKey = '';
let monoMap = new Map();
function monogram(name) {
  const names = [...state.projects.keys()];
  if (!state.projects.has(name)) names.push(name);
  const key = names.join('\n');
  if (key !== monoKey) {
    monoKey = key;
    monoMap = assignMonograms(names);
  }
  return monoMap.get(name) || '?';
}

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 14 * 86400) return `${Math.round(s / 86400)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
const projectHref = (name) => `#/p/${encodeURIComponent(name)}`;

// ---------- plan helpers ----------
function counts(plan) {
  const c = { todo: 0, doing: 0, done: 0, total: plan.length };
  for (const s of plan) c[s.status] += 1;
  return c;
}

function nowLine(p) {
  if (p.focus) return `Now: ${p.focus}`;
  const doing = p.plan.find((s) => s.status === 'doing');
  if (doing) return `Now: ${doing.title}`;
  const next = p.plan.find((s) => s.status === 'todo');
  if (next) return `Next: ${next.title}`;
  return p.plan.length ? 'Plan complete' : 'No plan yet';
}

function quietFor(p) {
  if (p.status !== 'active') return 0;
  const last = p.last_ts || p.updated_ts;
  const gap = Date.now() - last;
  return gap > STALE_MS ? Math.floor(gap / 86400000) : 0;
}

function progressBar(plan) {
  const c = counts(plan);
  if (!c.total) return null;
  return h(
    'div',
    { class: 'prog', role: 'img', 'aria-label': `${c.done} of ${c.total} steps done` },
    h('i', { class: 'd', style: `width:${(c.done / c.total) * 100}%` }),
    h('i', { class: 'g', style: `width:${(c.doing / c.total) * 100}%` })
  );
}

function parsePlan(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      line = line.replace(/^[-*]\s+/, '');
      let status = 'todo';
      const m = line.match(/^\[(x|X|~| )\]\s*/);
      if (m) {
        status = m[1] === ' ' ? 'todo' : m[1] === '~' ? 'doing' : 'done';
        line = line.slice(m[0].length);
      }
      return { title: line, status };
    })
    .filter((s) => s.title);
}

const planToText = (plan) => plan.map((s) => `${s.status === 'done' ? '[x] ' : s.status === 'doing' ? '[~] ' : ''}${s.title}`).join('\n');

// ---------- data ----------
function ingest(ev) {
  state.events.set(ev.id, ev);
}

function cursor(scope) {
  if (!state.cursors.has(scope)) state.cursors.set(scope, { oldest: null, done: false, loaded: false });
  return state.cursors.get(scope);
}

async function loadEvents(scope) {
  const cur = cursor(scope);
  if (state.loading || cur.done) return;
  state.loading = true;
  try {
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (scope) q.set('project', scope);
    if (cur.oldest) {
      q.set('before_ts', String(cur.oldest.ts));
      q.set('before', String(cur.oldest.id));
    }
    const { events } = await api(`/api/events?${q}`);
    events.forEach((e) => {
      ingest(e);
      if (!cur.oldest || e.ts < cur.oldest.ts || (e.ts === cur.oldest.ts && e.id < cur.oldest.id)) cur.oldest = { ts: e.ts, id: e.id };
    });
    cur.loaded = true;
    if (events.length < PAGE) cur.done = true;
  } finally {
    state.loading = false;
  }
  render();
  requestAnimationFrame(maybeLoadMore); // still near the end? keep going before the user gets there
}

async function loadProjects() {
  const { projects } = await api('/api/projects');
  state.projects = new Map(projects.map((p) => [p.name, p]));
}

async function loadReplies() {
  const { replies } = await api('/api/replies?all=1');
  replies.forEach((r) => state.replies.set(r.id, r));
}

async function loadNeeds() {
  const { events } = await api('/api/events?needs=1&limit=50');
  events.forEach(ingest);
}

let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await loadProjects().catch(() => {});
    requestRender();
  }, 400);
}

async function savePlan(name, patch) {
  const p = await api(`/api/projects/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(patch) });
  state.projects.set(p.name, p);
  render();
  return p;
}

// ---------- routing ----------
// The feed is home. #/f/<name> is the same feed narrowed to one project. #/p/<name> is the project's
// page (plan, notes), and #/projects is the overview of every project's plan and stage.
function parseRoute() {
  const hash = location.hash || '#/';
  let m = hash.match(/^#\/p\/(.+)$/);
  if (m) return { page: 'project', name: decodeURIComponent(m[1]) };
  m = hash.match(/^#\/f\/(.+)$/);
  if (m) return { page: 'feed', name: decodeURIComponent(m[1]) };
  if (hash.startsWith('#/projects')) return { page: 'home', name: '' };
  return { page: 'feed', name: '' };
}
const feedHref = (name) => (name ? `#/f/${encodeURIComponent(name)}` : '#/');

async function onRoute() {
  state.navDepth += 1;
  state.route = parseRoute();
  state.feedProject = state.route.page === 'feed' ? state.route.name : '';
  state.dockOpen = false;
  const target = state.route.page === 'project' ? 0 : state.pos.get(location.hash || '#/') || 0;
  render();
  window.scrollTo(0, target);
  const { page, name } = state.route;
  try {
    if (page === 'home') {
      await Promise.all([loadProjects(), loadNeeds(), loadReplies()]);
      render();
    } else if (page === 'feed') {
      await Promise.all([loadProjects(), loadNeeds(), loadReplies()]);
      render();
      if (!cursor(state.feedProject).loaded) await loadEvents(state.feedProject);
      maybeLoadMore();
    } else {
      await Promise.all([loadProjects(), loadNeeds(), loadReplies()]);
      render();
      if (!cursor(name).loaded) await loadEvents(name);
    }
  } catch (e) {
    console.error(e);
  }
}

// ---------- grouping ----------
const byNewest = (a, b) => b.ts - a.ts || b.id - a.id;
function threads(project) {
  const evs = [...state.events.values()].filter((e) => !project || e.project === project).sort(byNewest);
  const groups = new Map();
  for (const e of evs) {
    const key = e.session_id ? `${e.project}:${e.session_id}` : `solo:${e.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const out = [];
  for (const [key, list] of groups) {
    const important = list.filter((e) => IMPORTANT.has(e.kind));
    if (state.quiet && important.length === 0) continue;
    const head = important[0] || list[0];
    const rest = list.filter((e) => e !== head && (!state.quiet || IMPORTANT.has(e.kind)));
    out.push({ key, head, latest: list[0], rest });
  }
  return out;
}

// ---------- calm rendering ----------
// Design rule: if the reader ever has to change scroll direction, the UI failed.
// So: content never moves under the thumb (anchor), nodes that did not change are
// never touched (cache + minimal DOM diff), live updates wait for a pause in the
// scroll, and older posts are fetched well before the end is in sight.
const nodeCache = new Map(); // post key -> { sig, node }
function cached(key, sig, build) {
  const hit = nodeCache.get(key);
  if (hit && hit.sig === sig) return hit.node;
  const node = build();
  nodeCache.set(key, { sig, node });
  return node;
}

// Make parent's children equal nodes, touching only what differs.
function sync(parent, nodes) {
  nodes.forEach((n, i) => {
    const cur = parent.childNodes[i];
    if (cur !== n) parent.insertBefore(n, cur || null);
  });
  while (parent.childNodes.length > nodes.length) parent.lastChild.remove();
}

const feedLists = new Map(); // scope -> persistent <ol>
function postList(scope, list) {
  if (!feedLists.has(scope)) feedLists.set(scope, h('ol', { class: 'feed' }));
  const ol = feedLists.get(scope);
  sync(ol, list.map(postNode));
  return ol;
}

let keys = null; // keyboard shortcuts, installed once the app's actions exist (see the end of this file)
const postIndex = new Map(); // key -> thread, so a keyboard shortcut knows what the selected post is
// ----- read and unread -----
// Which posts you have seen, kept on this device only (like a remembered filter). Everything from
// before your first visit counts as read. A post becomes read once it has been on screen for a second.
const READ_KEY = 'buzz.read';
const readState = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(READ_KEY) || 'null');
    if (v && typeof v.base === 'number' && v.ids && typeof v.ids === 'object') return v;
  } catch {
    /* private mode or cleared: start fresh */
  }
  return { base: Date.now(), ids: {}, fresh: true };
})();
function saveRead() {
  try {
    const keys = Object.keys(readState.ids);
    for (const k of keys.slice(0, Math.max(0, keys.length - 800))) delete readState.ids[k];
    localStorage.setItem(READ_KEY, JSON.stringify(readState));
  } catch {
    /* not saved: it is only a convenience */
  }
}
if (readState.fresh) {
  delete readState.fresh;
  saveRead(); // remember the first visit, so posts that arrive after it count as new next time
}
const isUnread = (t) => t.latest.ts > readState.base && (readState.ids[t.key] || 0) < t.latest.id;
function markRead(key) {
  const t = postIndex.get(key);
  if (!t || !isUnread(t)) return;
  readState.ids[key] = t.latest.id;
  saveRead();
  requestRender();
}
const readTimers = new Map();
const readObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const key = e.target.dataset.k;
      if (e.isIntersecting && e.intersectionRatio >= 0.6) {
        if (!readTimers.has(key)) readTimers.set(key, setTimeout(() => (readTimers.delete(key), !document.hidden && markRead(key)), 1000));
      } else {
        clearTimeout(readTimers.get(key));
        readTimers.delete(key);
      }
    }
  },
  { threshold: [0, 0.6] }
);
const watchedForRead = new WeakSet();
function watchUnread() {
  let n = 0;
  for (const el of document.querySelectorAll('#view .post.unread')) {
    n++;
    if (!watchedForRead.has(el)) {
      watchedForRead.add(el);
      readObserver.observe(el);
    }
  }
  return n;
}

function postNode(t) {
  const { key, head, latest, rest } = t;
  postIndex.set(key, t);
  const open = state.expanded.has(key);
  const sig = [
    head.id, head.kind, head.summary, head.body || '', head.url || '', head.resolved ? 1 : 0, head.needs_you ? 1 : 0,
    latest.id, rest.map((e) => e.id).join(','), open ? rest.map((e) => ago(e.ts)).join(',') : '',
    open ? 1 : 0, pendingAnswers.has(head.id) ? 1 : 0, state.expanded.has(`${key}:body`) ? 1 : 0, state.expanded.has(`${key}:replies`) ? 1 : 0, state.composing.has(key) ? 1 : 0, replySig(repliesFor(head)), Date.now() - latest.ts < LIVE_MS ? 1 : 0, ago(head.ts), isUnread(t) ? 1 : 0,
  ].join('\u241f');
  return cached(key, sig, () => {
    const li = renderPost(t);
    li.dataset.k = key;
    return li;
  });
}

function anchorBefore() {
  if (scrollY < 8) return null; // at the top, new content may push down naturally
  const limit = Math.max(0, document.querySelector('.top').getBoundingClientRect().bottom);
  for (const el of $('view').querySelectorAll('[data-k]')) {
    const r = el.getBoundingClientRect();
    if (r.bottom > limit) return { k: el.dataset.k, top: r.top };
  }
  return null;
}
function anchorAfter(a) {
  if (!a) return;
  const el = [...$('view').querySelectorAll('[data-k]')].find((e) => e.dataset.k === a.k);
  if (!el) return;
  const d = el.getBoundingClientRect().top - a.top;
  if (Math.abs(d) > 0.5) scrollBy({ top: d, behavior: 'instant' });
}

// Live updates wait until the finger or momentum has stopped.
let scrolling = false;
let scrollTimer;
let renderQueued = false;
function requestRender() {
  renderQueued = true;
  if (!scrolling) requestAnimationFrame(() => renderQueued && render());
}
function onScroll() {
  scrolling = true;
  $('dock').classList.add('scrolling'); // the dock shrinks out of the way while you read
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    scrolling = false;
    $('dock').classList.remove('scrolling');
    if (renderQueued) render();
  }, 160);
  const { page } = state.route;
  if (page !== 'project') state.pos.set(location.hash || '#/', scrollY);
  if (scrollY < 120 && state.unseen) {
    state.unseen = 0;
    updatePill();
  }
}
function updatePill() {
  const b = $('newpill');
  b.hidden = !state.unseen;
  b.textContent = `\u2191 ${state.unseen} new`;
}

function maybeLoadMore() {
  const { page, name } = state.route;
  const scope = page === 'feed' ? state.feedProject : page === 'project' ? name : null;
  if (scope === null || !cursor(scope).loaded) return;
  if ($('sentinel').getBoundingClientRect().top < innerHeight + 2400) loadEvents(scope).catch(() => {});
}

// ---------- render ----------
function render() {
  renderQueued = false;
  const anchor = anchorBefore();
  const keep = captureFocus();
  const { page, name } = state.route;

  document.title = name ? `${name} · agentsbuzz` : 'agentsbuzz';
  document.body.dataset.page = page;
  $('title').textContent = page === 'home' ? 'Projects' : name || 'Feed';
  $('back').hidden = page === 'feed' && !name;
  $('back').setAttribute('aria-label', page === 'project' ? 'Back' : 'Back to the feed');
  $('add').hidden = page !== 'home';
  $('edit').hidden = page !== 'project';
  $('quiet').hidden = page === 'home';

  const view = $('view');
  if (page === 'home') sync(view, renderHome());
  else if (page === 'feed') sync(view, renderFeed());
  else sync(view, renderProject(name));
  renderDock();

  restoreFocus(keep);
  anchorAfter(anchor);
  watchUnread();
  if (state.unreadTotal) document.title = `(${state.unreadTotal}) ${document.title}`;
  keys?.afterRender();
}

// keep typing intact when a live event re-renders the page
function captureFocus() {
  const el = document.activeElement;
  if (el && el.dataset && el.dataset.draft) return { key: el.dataset.draft, start: el.selectionStart, end: el.selectionEnd };
  return null;
}
function restoreFocus(keep) {
  if (!keep) return;
  const el = document.querySelector(`[data-draft="${CSS.escape(keep.key)}"]`);
  if (!el) return;
  el.focus();
  try {
    el.setSelectionRange(keep.start, keep.end);
  } catch {
    /* not a text field */
  }
}
function draftField(tag, key, props) {
  const el = h(tag, { ...props, 'data-draft': key });
  el.value = state.drafts.get(key) || '';
  el.addEventListener('input', () => state.drafts.set(key, el.value));
  return el;
}

function avatar(name, live = false, big = false) {
  return h('div', { class: `avatar${live ? ' live' : ''}${big ? ' big' : ''}`, style: `--c:${color(name)}`, 'aria-hidden': 'true', text: monogram(name) });
}

// ----- home: projects -----
function renderHome() {
  const out = [needsLane('')];
  const all = [...state.projects.values()];
  if (!all.length) {
    out.push(
      h(
        'p',
        { class: 'empty' },
        'No projects yet. Tap ',
        h('b', { text: 'New project' }),
        ' to add an idea and a plan, or let an agent post and its project appears here.'
      )
    );
    return out.filter(Boolean);
  }
  for (const status of STATUS_ORDER) {
    const group = all
      .filter((p) => p.status === status)
      .sort((a, b) => (b.needs > 0) - (a.needs > 0) || (b.last_ts || b.updated_ts) - (a.last_ts || a.updated_ts));
    if (!group.length) continue;
    out.push(h('h2', { class: 'sect', text: `${STATUS_LABEL[status]} (${group.length})` }));
    out.push(h('ul', { class: 'projects' }, ...group.map(projectRow)));
  }
  return out.filter(Boolean);
}

function projectRow(p) {
  const c = counts(p.plan);
  const quiet = quietFor(p);
  const last = p.last_ts ? ago(p.last_ts) : '';
  const live = p.last_ts && Date.now() - p.last_ts < LIVE_MS;
  return h(
    'li',
    {},
    h(
      'a',
      { class: 'proj', href: projectHref(p.name), style: `--c:${color(p.name)}` },
      avatar(p.name, live),
      h(
        'div',
        { class: 'pbody' },
        h(
          'div',
          { class: 'phead' },
          h('span', { class: 'proj-name', text: p.name }),
          p.needs ? h('span', { class: 'badge', text: `${p.needs} needs you` }) : null,
          h('span', { class: 'ptime', text: last })
        ),
        h('div', { class: 'pnow', text: nowLine(p) }),
        c.total ? h('div', { class: 'pprog' }, progressBar(p.plan), h('span', { text: `${c.done} of ${c.total}` })) : null,
        quiet
          ? h('div', { class: 'pquiet', text: `Quiet for ${quiet} days` })
          : p.last_win
            ? h('div', { class: 'pwin', text: `Latest win: ${p.last_win}` })
            : !p.last_ts
              ? h('div', { class: 'pwin', text: 'No updates yet' })
              : null
      )
    )
  );
}

// ----- project page -----
function renderProject(name) {
  const p = state.projects.get(name);
  if (!p) {
    return [h('p', { class: 'empty', text: state.loading ? 'Loading' : 'This project is not in your list yet.' })];
  }
  const c = counts(p.plan);
  const quiet = quietFor(p);

  const hero = h(
    'section',
    { class: 'hero', style: `--c:${color(name)}` },
    avatar(name, false, true),
    h(
      'div',
      { class: 'hero-body' },
      h('div', { class: 'hero-line' }, h('span', { class: `pill ${p.status}`, text: STATUS_LABEL[p.status] }), quiet ? h('span', { class: 'pquiet', text: `Quiet for ${quiet} days` }) : null),
      p.description ? h('p', { class: 'desc', text: p.description }) : h('p', { class: 'desc muted', text: 'No description yet. Tap Edit to add one.' }),
      h('p', { class: 'pnow', text: nowLine(p) })
    )
  );

  const plan = h(
    'section',
    { class: 'plan' },
    h('h2', { class: 'sect', text: c.total ? `Plan: ${c.done} of ${c.total} done` : 'Plan' }),
    progressBar(p.plan),
    h(
      'ol',
      { class: 'steps' },
      ...p.plan.map((s, i) =>
        h(
          'li',
          { class: `step ${s.status}` },
          h('button', {
            class: 'step-btn',
            type: 'button',
            'aria-label': `${s.title}: ${STEP_LABEL[s.status]}. Tap to change.`,
            onclick: () => {
              const plan2 = p.plan.map((x, j) => (j === i ? { ...x, status: NEXT_STEP[x.status] } : x));
              savePlan(name, { plan: plan2 });
            },
          }),
          h('span', { class: 'step-title', text: s.title })
        )
      )
    ),
    h(
      'form',
      {
        class: 'addstep',
        onsubmit: (ev) => {
          ev.preventDefault();
          const title = (state.drafts.get(`step:${name}`) || '').trim();
          if (!title) return;
          state.drafts.delete(`step:${name}`);
          savePlan(name, { plan: [...p.plan, { title, status: 'todo' }] });
        },
      },
      draftField('input', `step:${name}`, { placeholder: 'Add a step', 'aria-label': 'Add a plan step', maxlength: '200', autocomplete: 'off' }),
      h('button', { type: 'submit', text: 'Add' })
    )
  );

  const list = threads(name);
  const feed = h(
    'section',
    {},
    h('h2', { class: 'sect', text: 'Updates' }),
    list.length
      ? postList(name, list)
      : h('p', { class: 'empty', text: cursor(name).loaded ? 'No updates yet. Agents working on this project will post here.' : 'Loading' })
  );

  return [hero, needsLane(name), plan, notesSection(name), feed].filter(Boolean);
}

function notesSection(name) {
  const notes = projectNotes(name).sort((x, y) => y.id - x.id); // newest first, under the box you type in
  const ta = draftField('textarea', `note:${name}`, { placeholder: 'Tell the agents what to work on next', 'aria-label': 'Message for the agents on this project', rows: '2' });
  const waiting = notes.some((r) => !r.delivered);
  return h(
    'section',
    { class: 'notes' },
    h('h2', { class: 'sect', text: 'Message the agents' }),
    h(
      'form',
      {
        class: 'composer',
        onsubmit: async (ev) => {
          ev.preventDefault();
          const prompt = ta.value.trim();
          if (!prompt) return;
          const row = await api(`/api/projects/${encodeURIComponent(name)}/reply`, { method: 'POST', body: JSON.stringify({ prompt }) });
          state.drafts.delete(`note:${name}`);
          state.replies.set(row.id, row);
          render();
        },
      },
      ta,
      h('p', {
        class: 'hint',
        text: state.wake
          ? 'An idle agent is woken with this; a busy one gets it at its next turn.'
          : waiting
            ? 'Waiting for an agent to start or finish a turn here. Run ./buzz wake on to wake idle ones.'
            : 'Picked up by whichever agent starts or finishes a turn here next.',
      }),
      h('button', { type: 'submit', text: 'Send' })
    ),
    notes.length ? h('div', { class: 'msgs' }, ...notes.slice(0, 6).map(messageLine)) : null
  );
}

// ----- feed -----
function renderFeed() {
  const list = threads(state.feedProject);
  return [
    state.feedProject ? scopeHeader(state.feedProject) : null,
    topComposer(),
    needsLane(state.feedProject),
    list.length
      ? postList(state.feedProject, list)
      : h('p', { class: 'empty', text: cursor(state.feedProject).loaded ? (state.feedProject || state.quiet ? 'Nothing here with these filters.' : 'No activity yet. Commits and agent sessions in your projects show up here on their own.') : 'Loading' }),
  ].filter(Boolean);
}

// A slim card at the top of a narrowed feed: which project, how it is going, and a way to its plan.
function scopeHeader(name) {
  const p = state.projects.get(name);
  const c = p ? counts(p.plan) : { total: 0, done: 0 };
  return h(
    'section',
    { class: 'scope', style: `--c:${color(name)}` },
    avatar(name, false),
    h(
      'div',
      { class: 'scope-body' },
      h('div', { class: 'scope-name', text: name }),
      p ? h('div', { class: 'scope-sub', text: [STATUS_LABEL[p.status], nowLine(p)].filter(Boolean).join(' · ') }) : null,
      c.total ? h('div', { class: 'pprog' }, progressBar(p.plan), h('span', { text: `${c.done} of ${c.total}` })) : null
    ),
    h('a', { class: 'scope-plan', href: projectHref(name), text: 'Plan' })
  );
}

// ----- the dock: switch project without leaving the feed -----
const DAY_MS = 24 * 3600 * 1000;
function needsByProject() {
  const by = {};
  for (const e of state.events.values()) if (e.needs_you && !e.resolved) by[e.project] = (by[e.project] || 0) + 1;
  return by;
}
const dockScope = () => (state.route.page === 'home' ? '' : state.route.name);

function renderDock() {
  const dock = $('dock');
  const scope = dockScope();
  const by = needsByProject();
  const totalNeeds = Object.values(by).reduce((a, b) => a + b, 0);
  // the buzzer: amber = agents waiting on you, blue = posts you have not read yet
  const unreadBy = {};
  for (const t of threads('')) if (isUnread(t)) unreadBy[t.head.project] = (unreadBy[t.head.project] || 0) + 1;
  const totalUnread = Object.values(unreadBy).reduce((a, b) => a + b, 0);
  state.unreadTotal = totalUnread;
  const btn = $('dockBtn');
  btn.replaceChildren(
    ...[
      scope ? h('span', { class: 'dk-av', style: `--c:${color(scope)}`, text: monogram(scope) }) : dockIcon(),
      totalNeeds ? h('span', { class: 'dk-badge', text: String(totalNeeds) }) : null,
      totalUnread ? h('span', { class: 'dk-unread', text: totalUnread > 99 ? '99+' : String(totalUnread) }) : null,
    ].filter(Boolean) // replaceChildren turns a null into the text "null"
  );
  const counts_ = [totalNeeds && `${totalNeeds} need you`, totalUnread && `${totalUnread} unread`].filter(Boolean).join(', ');
  btn.setAttribute('aria-label', `${scope ? `Project: ${scope}. ` : ''}Switch project${counts_ ? ` (${counts_})` : ''}`);
  btn.setAttribute('aria-expanded', String(state.dockOpen));
  dock.classList.toggle('open', state.dockOpen);
  $('scrim').hidden = !state.dockOpen;
  const tray = $('tray');
  tray.hidden = !state.dockOpen;
  if (!state.dockOpen) return;

  const now = Date.now();
  const all = [...state.projects.values()];
  const rank = (p) => (by[p.name] || 0) * 1e15 + (p.last_ts || p.updated_ts || 0);
  const isActive = (p) => p.name === scope || (p.status !== 'done' && (p.status === 'active' || (p.last_ts && now - p.last_ts < 3 * DAY_MS)));
  const active = all.filter(isActive).sort((a, b) => rank(b) - rank(a));
  const quiet = all.filter((p) => !isActive(p)).sort((a, b) => rank(b) - rank(a));

  const go = (hash) => {
    state.dockOpen = false;
    if (location.hash === hash || (hash === '#/' && (location.hash === '' || location.hash === '#/feed'))) renderDock();
    else location.hash = hash;
  };
  const pill = (label, hash, { c, n, u, current, cls = '', live } = {}) =>
    h(
      'button',
      { class: `dk-pill ${cls}`, type: 'button', role: 'menuitem', 'aria-current': current ? 'true' : 'false', style: c ? `--c:${c}` : '', onclick: () => go(hash) },
      c ? h('span', { class: `dot${live ? ' live' : ''}` }) : null,
      h('span', { class: 'lbl', text: label }),
      u ? h('span', { class: 'u', title: `${u} unread`, text: String(u) }) : null,
      n ? h('span', { class: 'n', title: `${n} need you`, text: String(n) }) : null
    );

  const keep = tray.scrollTop;
  tray.replaceChildren(
    ...[
    // nearest the thumb: everything, and the plans overview
    h('div', { class: 'dk-row' }, pill('All', '#/', { current: !scope && state.route.page === 'feed', n: totalNeeds, u: totalUnread, cls: 'all' }), pill('Plans', '#/projects', { current: state.route.page === 'home', cls: 'plans' })),
    ...active.map((p) => pill(p.name, feedHref(p.name), { c: color(p.name), n: by[p.name], u: unreadBy[p.name], current: p.name === scope, live: p.last_ts && now - p.last_ts < LIVE_MS })),
    quiet.length
      ? h('button', {
          class: 'dk-pill more',
          type: 'button',
          'aria-expanded': String(state.showQuiet),
          text: state.showQuiet ? 'Hide quiet' : `Quiet \u00b7 ${quiet.length}`,
          onclick: () => {
            state.showQuiet = !state.showQuiet;
            localStorage.setItem('buzz.showQuiet', state.showQuiet ? '1' : '0');
            renderDock();
          },
        })
      : null,
    ...(state.showQuiet ? quiet.map((p) => pill(p.name, feedHref(p.name), { c: color(p.name), n: by[p.name], u: unreadBy[p.name], current: false, cls: 'quiet' })) : [])
  ].filter(Boolean)
  );
  tray.scrollTop = keep;
}

function dockIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('aria-hidden', 'true');
  for (const [x, y] of [[5, 5], [14, 5], [5, 14], [14, 14]]) {
    const r = document.createElementNS(ns, 'rect');
    for (const [k, v] of Object.entries({ x, y, width: 5, height: 5, rx: 1.6, fill: 'currentColor' })) r.setAttribute(k, String(v));
    svg.append(r);
  }
  return svg;
}

function toggleDock(open = !state.dockOpen) {
  state.dockOpen = open;
  renderDock();
}

// ----- shared pieces -----
function needsLane(project) {
  const open = [...state.events.values()]
    .filter((e) => e.needs_you && !e.resolved && (!project || e.project === project))
    .sort((a, b) => b.id - a.id);
  if (!open.length) return null;
  return h(
    'section',
    { class: 'needs', 'aria-label': 'Needs you' },
    h('h2', { text: open.length === 1 ? '1 agent needs you' : `${open.length} agents need you` }),
    ...open.map((e) =>
      h(
        'div',
        { class: 'need' },
        h(
          'div',
          { class: 'txt' },
          h('a', { class: 'who', href: feedHref(e.project), text: `${e.project} · ${e.agent || e.harness} · ${ago(e.ts)}` }),
          h('div', { class: 'what' }, renderInline(e.summary)),
          answerChips(e)
        ),
        h('button', { class: 'act primary', type: 'button', onclick: () => resolve(e.id, { advance: true }), text: 'Handled' })
      )
    )
  );
}

const repliesFor = (head) =>
  head.session_id ? [...state.replies.values()].filter((r) => r.session_id === head.session_id && r.project === head.project) : [];
const projectNotes = (name) => [...state.replies.values()].filter((r) => !r.session_id && r.project === name);
const replySig = (list) => list.map((r) => `${r.id}${r.delivered ? 'd' : 'w'}${r.delivered ? ago(r.delivered_ts) : ''}`).join(',');

function messageLine(r) {
  // like a messaging app: one grey tick when sent, two green ones once the agent has it
  const when = r.delivered ? ago(r.delivered_ts) : '';
  const state_ = r.delivered ? `✓✓ Read by the agent · ${when === 'now' ? 'just now' : `${when} ago`}` : '✓ Sent · not read yet';
  return h(
    'div',
    { class: `msg ${r.delivered ? 'sent' : 'wait'}` },
    h('span', { class: 'msg-who', text: 'You' }),
    h('span', { class: 'msg-text', text: r.prompt }),
    h('span', { class: 'msg-state', text: state_ })
  );
}

// Your messages fold away like the updates, so a long conversation does not push the feed down.
// The button still says when one has not reached the agent yet.
function repliesLabel(list) {
  const waiting = list.filter((r) => !r.delivered).length;
  return `${list.length} ${list.length === 1 ? 'reply' : 'replies'}${waiting ? ` · ${list.length === 1 ? '' : `${waiting} `}waiting` : ''}`;
}

function renderPost(t) {
  const { key, head, latest, rest } = t;
  const live = Date.now() - latest.ts < LIVE_MS;
  const open = state.expanded.has(key);
  const replies = repliesFor(head);
  const repliesOpen = state.expanded.has(`${key}:replies`);
  const url = safeUrl(head.url);

  const text = h('p', { class: 'text' });
  if (head.kind !== 'progress' && head.kind !== 'note') {
    text.append(h('span', { class: `tag ${head.kind}`, text: KIND_LABEL[head.kind] || head.kind }));
  }
  text.append(renderInline(head.summary));
  if (url) text.append(' ', h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: 'Open' }));

  const acts = h('div', { class: 'acts' });
  if (rest.length) {
    acts.append(
      h('button', {
        class: 'act',
        type: 'button',
        'aria-expanded': String(open),
        text: open ? 'Hide updates' : `${rest.length} ${rest.length === 1 ? 'update' : 'updates'}`,
        onclick: () => {
          open ? state.expanded.delete(key) : state.expanded.add(key);
          render();
        },
      })
    );
  }
  if (replies.length) {
    acts.append(
      h('button', {
        class: `act${!repliesOpen && replies.some((r) => !r.delivered) ? ' waiting' : ''}`,
        type: 'button',
        'aria-expanded': String(repliesOpen),
        text: repliesOpen ? 'Hide replies' : repliesLabel(replies),
        onclick: () => {
          repliesOpen ? state.expanded.delete(`${key}:replies`) : state.expanded.add(`${key}:replies`);
          render();
        },
      })
    );
  }
  if (head.session_id) {
    acts.append(
      h('button', {
        class: 'act',
        type: 'button',
        text: 'Reply',
        onclick: () => {
          state.composing.has(key) ? state.composing.delete(key) : state.composing.add(key);
          render();
        },
      })
    );
  }

  return h(
    'li',
    { class: `post${isUnread(t) ? ' unread' : ''}`, style: `--c:${color(head.project)}` },
    avatar(head.project, live),
    h(
      'div',
      {},
      h(
        'div',
        { class: 'head' },
        h('a', { class: 'proj-link', href: feedHref(head.project), text: head.project }),
        h('span', { class: 'meta', text: [...new Set([head.agent, head.harness].filter(Boolean))].join(' · ') }),
        h('time', { datetime: new Date(head.ts).toISOString(), title: new Date(head.ts).toLocaleString(), text: ago(head.ts) })
      ),
      text,
      head.body ? bodyBlock(head, key) : null,
      (head.kind === 'blocked' || head.needs_you) && !head.resolved ? answerChips(head) : null,
      acts,
      // Newest first, like the project notes: the box you type in, then your messages, then the
      // earlier updates, so the latest of everything is right under your thumb.
      state.composing.has(key) ? composer(head, key) : null,
      replies.length && repliesOpen ? h('div', { class: 'msgs' }, ...[...replies].sort((x, y) => y.id - x.id).map(messageLine)) : null,
      open
        ? h(
            'div',
            { class: 'thread' },
            rest.map((e) =>
              h(
                'div',
                { class: 'reply-line' },
                h('time', { text: ago(e.ts) }),
                e.kind !== 'progress' && e.kind !== 'note' ? h('span', { class: `tag ${e.kind}`, text: KIND_LABEL[e.kind] }) : null,
                renderInline(e.summary)
              )
            )
          )
        : null
    )
  );
}

// The agent's longer message, as Markdown. Long ones are folded so the feed keeps moving; tap to unfold.
function bodyBlock(head, key) {
  const long = head.body.length > 360 || head.body.split('\n').length > 7;
  const open = state.expanded.has(`${key}:body`);
  return h(
    'div',
    { class: 'bodywrap' },
    h('div', { class: `body md${long && !open ? ' clamp' : ''}` }, renderMarkdown(head.body)),
    long
      ? h('button', {
          class: 'more-btn',
          type: 'button',
          'aria-expanded': String(open),
          text: open ? 'Show less' : 'Show more',
          onclick: () => {
            open ? state.expanded.delete(`${key}:body`) : state.expanded.add(`${key}:body`);
            render();
          },
        })
      : null
  );
}

function composer(head, key) {
  const ta = draftField('textarea', `reply:${key}`, { placeholder: 'Message for this agent', 'aria-label': 'Message for this agent', rows: '2' });
  const waiting = head.needs_you && !head.resolved;
  return h(
    'form',
    {
      class: 'composer',
      onsubmit: async (ev) => {
        ev.preventDefault();
        const prompt = ta.value.trim();
        if (!prompt) return;
        const row = await api(`/api/events/${head.id}/reply`, { method: 'POST', body: JSON.stringify({ prompt }) });
        state.replies.set(row.id, row);
        state.drafts.delete(`reply:${key}`);
        state.composing.delete(key);
        state.expanded.add(`${key}:replies`); // show what you just sent
        if (ev.submitter?.value === 'handled') await resolve(head.id, { advance: true });
        else render();
      },
    },
    ta,
    quickChips(ta, `reply:${key}`),
    h('p', { class: 'hint', text: state.wake ? 'If the agent is idle, it is woken up to handle this.' : 'Delivered when the agent next starts or finishes a turn. To wake idle agents: ./buzz wake on' }),
    waiting ? h('button', { type: 'submit', value: 'handled', class: 'secondary', title: 'Send, and mark it handled', 'aria-label': 'Send, and mark it handled', text: '✓ Handled' }) : null,
    h('button', { type: 'submit', value: 'send', text: 'Send' })
  );
}

// A small line icon and at most one word, light like "Reply". A row of them shrinks its words
// before it would ever spill over, and never scrolls sideways.
const ICONS = {
  go: ['M5 12h14', 'M13 6l6 6-6 6'],
  test: ['M9 3h6', 'M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3', 'M7.5 15h9'],
  pr: ['M6 8.5v7', 'M18 15.5V10a3 3 0 0 0-3-3h-4', 'M13 4.5L10.5 7 13 9.5', 'C6 6 2.2', 'C6 18 2.2', 'C18 18 2.2'],
  explain: ['C12 12 9', 'M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5', 'M12 16.8h.01'],
  stop: ['C12 12 9', 'M9.5 9.5h5v5h-5z'],
  yes: ['M5 12.5l4.5 4.5L19 7'],
  no: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
};
function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const add = (tag, attrs) => {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  };
  const n = /^n(\d)$/.exec(name);
  if (n) {
    add('circle', { cx: 12, cy: 12, r: 9 });
    const t = document.createElementNS(ns, 'text');
    for (const [k, v] of Object.entries({ x: 12, y: 16, 'text-anchor': 'middle', class: 'num' })) t.setAttribute(k, v);
    t.textContent = n[1];
    svg.append(t);
    return svg;
  }
  for (const d of ICONS[name] || []) {
    if (d.startsWith('C')) {
      const [cx, cy, r] = d.slice(1).trim().split(' ');
      add('circle', { cx, cy, r });
    } else add('path', { d });
  }
  return svg;
}
function emojiButton(iconName, word, props) {
  return h('button', { class: 'ebtn', type: 'button', ...props }, icon(iconName), h('span', { class: 'wd', text: word }));
}
const buttonRow = (cls, label, buttons) => h('div', { class: cls, role: 'group', 'aria-label': label, style: `--n:${buttons.length}` }, ...buttons);

// Things you often say, under a text box: a tap adds one to what you are typing.
function quickChips(ta, draftKey) {
  return buttonRow(
    'quick',
    'Quick replies',
    QUICK_REPLIES.map((q) =>
      emojiButton(q.icon, q.word, {
        title: q.text,
        'aria-label': q.text,
        onclick: () => {
          const now = ta.value.trim();
          ta.value = `${now ? `${now}${/[.!?]$/.test(now) ? '' : '.'} ` : ''}${q.text}.`;
          state.drafts.set(draftKey, ta.value);
          ta.focus();
        },
      })
    )
  );
}

// ----- one-tap answers -----
// An agent waiting on you often asks a question with its own answers in it ("Grams or cups?").
// They become buttons. A tap sends after a short pause you can undo, marks the item handled and
// moves you on to the next agent that is waiting, like working through an inbox.
const pendingAnswers = new Map(); // event id -> timer
function answerChips(e) {
  if (!e || e.resolved) return null;
  const pending = pendingAnswers.has(e.id);
  return buttonRow(
    'answers',
    'Quick answers',
    suggestions(e.summary, e.body || '').map((s) => emojiButton(s.icon, s.word, { disabled: pending, title: s.reply, 'aria-label': `${s.word}: ${s.reply}`, onclick: () => answer(e, s.reply) }))
  );
}
function answer(e, reply) {
  if (pendingAnswers.has(e.id)) return;
  const send = async () => {
    pendingAnswers.delete(e.id);
    try {
      const path = e.session_id ? `/api/events/${e.id}/reply` : `/api/projects/${encodeURIComponent(e.project)}/reply`;
      const row = await api(path, { method: 'POST', body: JSON.stringify({ prompt: reply }) });
      state.replies.set(row.id, row);
      if (e.needs_you && !e.resolved) await resolve(e.id, { advance: true });
      else render();
    } catch (err) {
      toast(`Not sent: ${err.message}`);
      render();
    }
  };
  pendingAnswers.set(e.id, setTimeout(send, 2500));
  render();
  toast(`Sending “${reply}” to ${e.project}`, {
    ms: 2500,
    undo: () => {
      clearTimeout(pendingAnswers.get(e.id));
      pendingAnswers.delete(e.id);
      render();
    },
  });
}

let toastTimer = 0;
function toast(text, { undo, ms = 3000 } = {}) {
  const el = $('toast');
  el.replaceChildren(
    ...[
      h('span', { text }),
      undo
      ? h('button', {
          type: 'button',
          text: 'Undo',
          onclick: () => {
            clearTimeout(toastTimer);
            el.hidden = true;
            undo();
          },
        })
      : null,
    ].filter(Boolean)
  );
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// After you deal with one agent, bring the next one that is waiting into view.
function moveToNextNeed() {
  const rows = [...document.querySelectorAll('#view .need')];
  if (!rows.length) return toast('All clear: no agent is waiting on you');
  const next = rows[0];
  const r = next.getBoundingClientRect();
  if (r.top < 60 || r.bottom > innerHeight - 80) next.scrollIntoView({ block: 'center', behavior: 'smooth' });
  next.classList.add('next');
  setTimeout(() => next.classList.remove('next'), 1600);
  toast(rows.length === 1 ? '1 more agent needs you' : `${rows.length} more agents need you`);
}

// ----- one line at the top of the feed: message an agent without finding its post -----
// It goes to the agent waiting on you in that project if there is one, else to the project's agents.
function topComposer() {
  const scoped = state.feedProject;
  const waiting = [...state.events.values()].filter((e) => e.needs_you && !e.resolved).sort((a, b) => b.id - a.id);
  const names = [...state.projects.keys()].sort();
  const fallback = scoped || waiting[0]?.project || threads('')[0]?.head.project || names[0] || '';
  const project = scoped || (names.includes(state.topProject) ? state.topProject : fallback);
  if (!project) return null;
  const need = waiting.find((e) => e.project === project && e.session_id);
  if (!state.topOpen) {
    return h(
      'button',
      {
        class: 'top-compose',
        type: 'button',
        onclick: () => {
          state.topOpen = true;
          render();
          document.querySelector('#view [data-draft="top"]')?.focus();
        },
      },
      avatar(project),
      h('span', { class: 'tc-ph', text: need ? `Answer ${project}…` : `Message ${project}…` })
    );
  }
  const ta = draftField('textarea', 'top', { placeholder: need ? `Answer: ${need.summary}` : `Tell the agents on ${project} what to do next`, 'aria-label': 'Message for an agent', rows: '2' });
  const pick = scoped
    ? h('span', { class: 'tc-name', text: project })
    : h(
        'select',
        {
          class: 'tc-proj',
          'aria-label': 'Project',
          onchange: (ev) => {
            state.topProject = ev.target.value;
            render();
          },
        },
        ...names.map((n) => {
          const o = h('option', { value: n, text: n });
          o.selected = n === project;
          return o;
        })
      );
  return h(
    'form',
    {
      class: 'composer top-compose open',
      onsubmit: async (ev) => {
        ev.preventDefault();
        const prompt = ta.value.trim();
        if (!prompt) return;
        const path = need ? `/api/events/${need.id}/reply` : `/api/projects/${encodeURIComponent(project)}/reply`;
        const row = await api(path, { method: 'POST', body: JSON.stringify({ prompt }) });
        state.replies.set(row.id, row);
        state.drafts.delete('top');
        state.topOpen = false;
        toast(`Sent to ${project}`);
        render();
      },
    },
    h(
      'div',
      { class: 'tc-row' },
      avatar(project),
      pick,
      h('button', {
        class: 'act',
        type: 'button',
        text: 'Cancel',
        onclick: () => {
          state.topOpen = false;
          render();
        },
      })
    ),
    ta,
    quickChips(ta, 'top'),
    h('p', { class: 'hint', text: need ? 'Goes to the agent waiting on you here.' : state.wake ? 'An idle agent is woken with this.' : "Picked up at the agent's next turn." }),
    h('button', { type: 'submit', text: 'Send' })
  );
}

async function resolve(id, { advance = false } = {}) {
  const row = await api(`/api/events/${id}/resolve`, { method: 'POST' });
  state.events.set(row.id, row);
  scheduleRefresh();
  render();
  if (advance) moveToNextNeed();
}

// ---------- project dialog ----------
function openProjectDialog(existing) {
  const dlg = $('projectDialog');
  $('pdTitle').textContent = existing ? `Edit ${existing.name}` : 'New project';
  $('pdName').value = existing ? existing.name : '';
  $('pdName').disabled = Boolean(existing);
  $('pdDesc').value = existing ? existing.description : '';
  $('pdStatus').value = existing ? existing.status : 'active';
  $('pdPlan').value = existing ? planToText(existing.plan) : '';
  $('projectForm').onsubmit = async () => {
    const name = $('pdName').value.trim();
    if (!name) return;
    const p = await savePlan(name, {
      description: $('pdDesc').value.trim(),
      status: $('pdStatus').value,
      plan: parsePlan($('pdPlan').value),
    });
    if (!existing) location.hash = projectHref(p.name);
  };
  dlg.showModal();
}
$('pdCancel').addEventListener('click', () => $('projectDialog').close());
$('add').addEventListener('click', () => openProjectDialog(null));
$('edit').addEventListener('click', () => {
  const p = state.projects.get(state.route.name);
  if (p) openProjectDialog(p);
});
$('back').addEventListener('click', () => {
  // Step back through where you have been in the app; fall back to the feed if you landed here directly.
  if (state.navDepth > 1) history.back();
  else location.hash = '#/';
});

// ---------- live ----------
function connect() {
  const q = token() ? `?token=${encodeURIComponent(token())}` : '';
  const es = new EventSource(`/api/stream${q}`);
  const conn = $('conn');
  es.onopen = () => {
    conn.className = 'conn live';
    conn.setAttribute('aria-label', 'live');
  };
  es.onerror = () => {
    conn.className = 'conn down';
    conn.setAttribute('aria-label', 'reconnecting');
  };
  es.addEventListener('event', (m) => {
    const ev = JSON.parse(m.data);
    ingest(ev);
    scheduleRefresh();
    if (scrollY > 400 && state.route.page !== 'home') {
      state.unseen++;
      updatePill();
    }
    requestRender();
    if (ev.needs_you && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(`${ev.project} needs you`, { body: ev.summary });
    }
  });
  es.addEventListener('update', (m) => {
    ingest(JSON.parse(m.data));
    scheduleRefresh();
    requestRender();
  });
  es.addEventListener('reply', (m) => {
    const r = JSON.parse(m.data);
    state.replies.set(r.id, r);
    requestRender();
  });
  es.addEventListener('project', (m) => {
    const p = JSON.parse(m.data);
    state.projects.set(p.name, p);
    requestRender();
  });
}

// ---------- boot ----------
$('quiet').setAttribute('aria-pressed', String(state.quiet));
$('quiet').addEventListener('click', () => {
  state.quiet = !state.quiet;
  localStorage.setItem('buzz.quiet', state.quiet ? '1' : '0');
  $('quiet').setAttribute('aria-pressed', String(state.quiet));
  render();
});

new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && maybeLoadMore(), { rootMargin: '2400px' }).observe($('sentinel'));

history.scrollRestoration = 'manual';
$('dockBtn').addEventListener('click', () => toggleDock());
$('scrim').addEventListener('click', () => toggleDock(false));
addEventListener('scroll', onScroll, { passive: true });
$('newpill').addEventListener('click', () => {
  state.unseen = 0;
  updatePill();
  scrollTo({ top: 0, behavior: 'smooth' });
});

// ---------- keyboard ----------
// web/keys.js handles the keys; these are the app actions it may use.
const postSel = (key) => document.querySelector(`#view .post[data-k="${CSS.escape(key)}"]`);
keys = installShortcuts({
  h,
  feedHref,
  projectHref,
  postInfo(key) {
    const t = postIndex.get(key);
    if (!t) return null;
    // only the update you can see: an older needs-you item hidden in the thread stays in the Needs you lane
    const need = t.head.needs_you && !t.head.resolved ? t.head : null;
    return { project: t.head.project, canReply: Boolean(t.head.session_id), needsYou: Boolean(need), needId: need?.id };
  },
  go(hash) {
    if (location.hash !== hash) location.hash = hash;
  },
  toggleExpand(key) {
    state.expanded.has(key) ? state.expanded.delete(key) : state.expanded.add(key);
    render();
  },
  reply(key) {
    state.composing.add(key);
    render();
    postSel(key)?.querySelector('.composer textarea')?.focus();
  },
  closeComposer(textarea) {
    const key = textarea.closest('.post')?.dataset.k;
    if (key && state.composing.delete(key)) render();
  },
  resolve(key) {
    const id = this.postInfo(key)?.needId;
    if (id) resolve(id, { advance: true });
  },
  toggleQuiet: () => !$('quiet').hidden && $('quiet').click(),
  toggleDock,
  dockOpen: () => state.dockOpen,
  back: () => !$('back').hidden && $('back').click(),
  toTop() {
    state.unseen = 0;
    updatePill();
    scrollTo({ top: 0, behavior: 'smooth' });
  },
  projectItems: () =>
    [...state.projects.values()]
      .sort((a, b) => (b.needs || 0) - (a.needs || 0) || (b.last_ts || b.updated_ts || 0) - (a.last_ts || a.updated_ts || 0))
      .map((p) => ({
        title: p.name,
        dot: color(p.name),
        note: p.needs ? `${p.needs} need${p.needs === 1 ? 's' : ''} you` : p.status,
        run: (alt) => (location.hash = alt ? projectHref(p.name) : feedHref(p.name)),
      })),
  commands: () => [
    { title: 'Feed: all projects', note: 'g f', run: () => (location.hash = '#/') },
    { title: 'Plans', note: 'g p', run: () => (location.hash = '#/projects') },
    { title: state.quiet ? 'Show every update' : 'Quiet: milestones only', note: 'q', run: () => $('quiet').click() },
    { title: 'New project', run: () => openProjectDialog(null) },
    { title: 'Keyboard shortcuts', note: '?', run: () => keys.openHelp() },
  ],
});

setInterval(requestRender, 60000); // keep relative times and live rings fresh
addEventListener('hashchange', onRoute);

(async () => {
  api('/api/health').then((h) => {
    state.wake = Boolean(h.wake);
  }).catch(() => {});
  await onRoute();
  connect();
  if ('Notification' in window && Notification.permission === 'default') {
    // Ask on first tap anywhere so the browser allows the prompt.
    addEventListener('pointerdown', () => Notification.requestPermission(), { once: true });
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
