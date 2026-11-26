// Keyboard shortcuts: move through the feed and act on a post without touching the mouse.
// One table drives both the handler and the ? help sheet, so they can never disagree.
// Everything is built with DOM calls (no innerHTML), so it works under the app's strict CSP.

export const SHORTCUTS = [
  { keys: ['j'], group: 'Move', label: 'Next post' },
  { keys: ['k'], group: 'Move', label: 'Previous post' },
  { keys: ['t'], group: 'Move', label: 'Back to the newest' },
  { keys: ['⌘K', '/'], group: 'Go to', label: 'Jump to a project or command' },
  { keys: ['g', 'f'], seq: true, group: 'Go to', label: 'Feed (all projects)' },
  { keys: ['g', 'p'], seq: true, group: 'Go to', label: 'Plans' },
  { keys: ['Enter', 'o'], group: 'Selected post', label: 'Show or hide its updates' },
  { keys: ['m'], group: 'Writing', label: 'Message an agent (to the selected post\'s project, if any)' },
  { keys: ['r'], group: 'Selected post', label: 'Reply' },
  { keys: ['e'], group: 'Selected post', label: 'Mark handled (needs you)' },
  { keys: ['f'], group: 'Selected post', label: 'Only this project in the feed' },
  { keys: ['p'], group: 'Selected post', label: 'Open its project page' },
  { keys: ['⌘↵'], group: 'Writing', label: 'Send' },
  { keys: ['Esc'], group: 'Writing', label: 'Stop writing, close, or go back' },
  { keys: ['q'], group: 'View', label: 'Quiet: milestones only' },
  { keys: ['?'], group: 'View', label: 'These shortcuts' },
];

// Fuzzy match for the palette: every typed character must appear in order. Matches at the start,
// after a separator, or in a run score higher. Returns -1 when it does not match.
export function fuzzyScore(query, text) {
  const q = String(query).toLowerCase().replace(/\s+/g, '');
  const t = String(text).toLowerCase();
  if (!q) return 0;
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return -1;
    score += 1;
    if (at === 0 || /[-_./\s]/.test(t[at - 1])) score += 3; // word start
    if (at === prev + 1) score += 2; // consecutive
    prev = at;
    ti = at + 1;
  }
  if (t.startsWith(q)) score += 5;
  return score - t.length * 0.01; // shorter names win ties
}

export function rankItems(query, items) {
  return items
    .map((it, i) => ({ it, i, s: fuzzyScore(query, it.title) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.it);
}

const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

// app: { h, posts(), postInfo(key), go(hash), toggleExpand(key), reply(key), resolve(key),
//        projectItems(), commands(), toggleQuiet(), toggleDock(open), dockOpen(), back(), toTop() }
export function installShortcuts(app) {
  const { h } = app;
  let sel = '';
  let pending = ''; // first key of a two-key sequence (g f, g p)
  let pendingTimer;

  const posts = () => [...document.querySelectorAll('#view .post[data-k]')];
  function select(key, { scroll = true } = {}) {
    sel = key;
    for (const el of document.querySelectorAll('#view .post.sel')) if (el.dataset.k !== key) el.classList.remove('sel');
    const el = key && document.querySelector(`#view .post[data-k="${CSS.escape(key)}"]`);
    if (!el) return;
    el.classList.add('sel');
    // Moving with j/k says "this post": a button focused earlier (say, by a tap) elsewhere lets go,
    // so Enter acts on the selected post. A control you Tab to afterwards still gets Enter.
    const f = document.activeElement;
    if (f && f !== document.body && !el.contains(f) && f.closest?.('a[href], button, [role="button"], summary')) f.blur();
    // only scroll when the post is not already fully on screen, and only as far as needed
    if (scroll) el.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  function move(step) {
    const list = posts();
    if (!list.length) return;
    let i = list.findIndex((el) => el.dataset.k === sel);
    if (i < 0) {
      // nothing selected yet: start from the first post on screen, not the top of the page
      i = list.findIndex((el) => el.getBoundingClientRect().bottom > 60);
      i = i < 0 ? 0 : i;
      if (step < 0) i = Math.max(0, i);
    } else i = Math.min(list.length - 1, Math.max(0, i + step));
    select(list[i].dataset.k);
  }

  // ---- palette (⌘K) ----
  let palette;
  function openPalette() {
    if (palette?.open) return;
    // A combobox: focus stays in the input, and aria-activedescendant tells screen readers which
    // result Enter will open.
    const input = h('input', {
      type: 'text', class: 'kp-input', placeholder: 'Jump to a project, or type a command', 'aria-label': 'Jump to',
      autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'kp-list', 'aria-autocomplete': 'list',
    });
    const list = h('ul', { class: 'kp-list', role: 'listbox', id: 'kp-list', 'aria-label': 'Results' });
    const foot = h('p', { class: 'kp-foot', text: '↵ open its feed · ⇧↵ its project page · Esc close' });
    palette = h('dialog', { class: 'kpal', 'aria-label': 'Jump to' }, input, list, foot);
    let items = [];
    let active = 0;
    const all = () => [...app.projectItems(), ...app.commands()];
    const draw = () => {
      items = input.value.trim() ? rankItems(input.value, all()) : all();
      items = items.slice(0, 12);
      active = Math.min(active, Math.max(0, items.length - 1));
      list.replaceChildren(
        ...items.map((it, i) =>
          h(
            'li',
            { class: `kp-item${i === active ? ' on' : ''}`, id: `kp-opt-${i}`, role: 'option', 'aria-selected': String(i === active), onclick: () => choose(it, false) },
            it.dot ? h('span', { class: 'kp-dot', style: `--c:${it.dot}` }) : h('span', { class: 'kp-cmd', text: '›' }),
            h('span', { class: 'kp-title', text: it.title }),
            it.note ? h('span', { class: 'kp-note', text: it.note }) : null
          )
        )
      );
      if (!items.length) list.append(h('li', { class: 'kp-empty', role: 'presentation', text: 'Nothing matches' }));
      if (items.length) input.setAttribute('aria-activedescendant', `kp-opt-${active}`);
      else input.removeAttribute('aria-activedescendant');
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    };
    const choose = (it, alt) => {
      palette.close();
      it.run(alt);
    };
    input.addEventListener('input', () => {
      active = 0;
      draw();
    });
    input.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // browser shortcuts (new window, print, ...) stay the browser's
      if (e.key === 'ArrowDown') active = Math.min(items.length - 1, active + 1);
      else if (e.key === 'ArrowUp') active = Math.max(0, active - 1);
      else if (e.key === 'Enter') {
        if (items[active]) choose(items[active], e.shiftKey);
        e.preventDefault();
        return;
      } else return;
      e.preventDefault();
      draw();
    });
    palette.addEventListener('close', () => palette.remove());
    palette.addEventListener('click', (e) => e.target === palette && palette.close()); // tap outside
    document.body.append(palette);
    draw();
    palette.showModal();
    input.focus();
  }

  // ---- help (?) ----
  function openHelp() {
    if (document.querySelector('dialog.khelp[open]')) return;
    const groups = new Map();
    for (const s of SHORTCUTS) {
      if (!groups.has(s.group)) groups.set(s.group, []);
      groups.get(s.group).push(s);
    }
    const keyEls = (s) => s.keys.flatMap((k, i) => [i ? h('span', { class: 'kh-sep', text: s.seq ? ' then ' : ' or ' }) : null, h('kbd', { text: k })]).filter(Boolean);
    const dlg = h(
      'dialog',
      { class: 'khelp', 'aria-label': 'Keyboard shortcuts' },
      h('h2', { text: 'Keyboard shortcuts', tabindex: '-1' }),
      h(
        'div',
        { class: 'kh-grid' },
        ...[...groups].map(([g, list]) =>
          h('section', {}, h('h3', { text: g }), ...list.map((s) => h('div', { class: 'kh-row' }, h('span', { class: 'kh-keys' }, ...keyEls(s)), h('span', { text: s.label }))))
        )
      ),
      h('form', { method: 'dialog' }, h('button', { type: 'submit', class: 'ghost', text: 'Close' }))
    );
    dlg.addEventListener('close', () => dlg.remove());
    dlg.addEventListener('click', (e) => e.target === dlg && dlg.close());
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector('h2').focus(); // start at the top, not at the Close button
    dlg.scrollTop = 0;
  }

  function onKey(e) {
    const t = e.target;
    const mod = e.metaKey || e.ctrlKey;
    // A dialog (the project editor, the palette, help) handles its own keys; nothing opens over it,
    // so ⌘K cannot replace a half-filled form.
    if (document.querySelector('dialog[open]')) return;
    if (mod && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openPalette();
      return;
    }
    if (typing(t)) {
      if (mod && e.key === 'Enter' && t.form) {
        e.preventDefault();
        t.form.requestSubmit();
      } else if (e.key === 'Escape' && t.tagName === 'TEXTAREA') {
        t.blur();
        if (!t.value.trim()) app.closeComposer(t);
      }
      return;
    }
    if (mod || e.altKey) return; // leave the browser's own shortcuts alone

    if (pending) {
      const seq = `${pending} ${e.key}`;
      pending = '';
      clearTimeout(pendingTimer);
      if (seq === 'g f') app.go('#/');
      else if (seq === 'g p') app.go('#/projects');
      else return;
      e.preventDefault();
      return;
    }

    // Enter on a focused button or link presses that control, as it always has.
    if (e.key === 'Enter' && t?.closest?.('a[href], button, [role="button"], summary')) return;

    const info = sel ? app.postInfo(sel) : null;
    const run = {
      j: () => move(1),
      k: () => move(-1),
      t: () => {
        app.toTop();
        const first = posts()[0];
        if (first) select(first.dataset.k, { scroll: false });
      },
      '/': () => openPalette(),
      g: () => {
        pending = 'g';
        pendingTimer = setTimeout(() => (pending = ''), 1200);
      },
      Enter: () => info && app.toggleExpand(sel),
      o: () => info && app.toggleExpand(sel),
      m: () => app.message(info?.project),
      r: () => info?.canReply && app.reply(sel),
      e: () => info?.needsYou && app.resolve(sel),
      f: () => info && app.go(app.feedHref(info.project)),
      p: () => info && app.go(app.projectHref(info.project)),
      q: () => app.toggleQuiet(),
      '?': () => openHelp(),
      Escape: () => {
        if (app.sheetOpen?.()) app.closeComposer();
        else if (app.dockOpen()) app.toggleDock(false);
        else if (sel) select('');
        else app.back();
      },
    }[e.key];
    if (!run) return;
    e.preventDefault();
    run();
  }

  addEventListener('keydown', onKey);
  return {
    // the feed re-renders often; keep the selection on the same post across renders
    afterRender() {
      // Cached posts keep their classes between renders, so re-sync every one of them: exactly the
      // selected post is highlighted, and none when nothing is selected.
      let found = false;
      for (const el of document.querySelectorAll('#view .post[data-k]')) {
        const on = Boolean(sel) && el.dataset.k === sel;
        el.classList.toggle('sel', on);
        found ||= on;
      }
      if (!found) sel = '';
    },
    selected: () => sel,
    openPalette,
    openHelp,
  };
}
