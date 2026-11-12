// A small, safe Markdown renderer for agent messages.
// It parses to a plain tree first (testable without a browser), then builds DOM nodes with
// createElement/createTextNode only. Nothing is ever set through innerHTML, and only
// http(s) and mailto links are allowed, so agent text cannot inject markup or script.

const SAFE_URL = /^(https?:\/\/|mailto:)/i;
const isAlnum = (c) => !!c && /[\p{L}\p{N}]/u.test(c);

// ---------- inline ----------
export function parseInline(src) {
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  const s = String(src ?? '');
  let i = 0;
  while (i < s.length) {
    const c = s[i];

    if (c === '\\' && i + 1 < s.length && /[\\`*_{}\[\]()#+\-.!~|>]/.test(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '\n') {
      flush();
      out.push({ t: 'br' });
      i += 1;
      continue;
    }
    if (c === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      const fence = '`'.repeat(n);
      const end = s.indexOf(fence, i + n);
      if (end > i + n) {
        flush();
        out.push({ t: 'code', v: s.slice(i + n, end).replace(/^ (.*) $/s, '$1') });
        i = end + n;
        continue;
      }
      buf += fence;
      i += n;
      continue;
    }
    if ((c === '*' || c === '_' || c === '~') && s[i + 1] === c) {
      const end = s.indexOf(c + c, i + 2);
      const inner = end > i + 2 ? s.slice(i + 2, end) : '';
      const okOpen = !/^\s/.test(inner) && !/\s$/.test(inner);
      const okWord = c !== '_' || (!isAlnum(s[i - 1]) && !isAlnum(s[end + 2]) && !/^\w+$/.test(inner)); // __init__.py is a file name, not bold
      if (inner && okOpen && okWord) {
        flush();
        out.push({ t: c === '~' ? 'del' : 'strong', c: parseInline(inner) });
        i = end + 2;
        continue;
      }
    }
    if ((c === '*' || c === '_') && s[i + 1] !== c) {
      let end = i + 1;
      for (;;) {
        end = s.indexOf(c, end);
        if (end < 0 || s[end + 1] !== c) break;
        end += 2; // skip a ** inside
      }
      const inner = end > i + 1 ? s.slice(i + 1, end) : '';
      const okOpen = inner && !/^\s/.test(inner) && !/\s$/.test(inner);
      const okWord = !isAlnum(s[i - 1]) && !isAlnum(s[end + 1]) && !(c === '_' && /^\w+$/.test(inner)); // no intraword emphasis (2*3*4, snake_case), and _name_ is an identifier
      if (okOpen && okWord && !inner.includes('\n')) {
        flush();
        out.push({ t: 'em', c: parseInline(inner) });
        i = end + 1;
        continue;
      }
    }
    if (c === '[') {
      const m = /^\[([^\]\n]+)\]\(\s*(<[^>\s]+>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/.exec(s.slice(i));
      if (m) {
        const href = m[2].replace(/^<|>$/g, '');
        flush();
        if (SAFE_URL.test(href)) out.push({ t: 'a', href, c: parseInline(m[1]) });
        else out.push(...parseInline(m[1])); // unsafe or relative target: keep just the words
        i += m[0].length;
        continue;
      }
    }
    if ((c === 'h' || c === 'H') && /^https?:\/\//i.test(s.slice(i, i + 8)) && !isAlnum(s[i - 1])) {
      const m = /^https?:\/\/[^\s<>]+/i.exec(s.slice(i));
      let url = m[0];
      const trail = /[.,;:!?'"]+$/.exec(url);
      if (trail) url = url.slice(0, -trail[0].length);
      // drop an unbalanced closing bracket: "(see https://x.com)"
      while (/[)\]]$/.test(url) && (url.match(/[(\[]/g) || []).length < (url.match(/[)\]]/g) || []).length) url = url.slice(0, -1);
      if (url.length > 8) {
        flush();
        out.push({ t: 'a', href: url, c: [{ t: 'text', v: url }] });
        i += url.length;
        continue;
      }
    }
    buf += c;
    i += 1;
  }
  flush();
  return out;
}

// ---------- blocks ----------
const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const isTable = (head, sep) => head.includes('|') && TABLE_SEP.test(sep) && splitRow(sep).length === splitRow(head).length;
const splitRow = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

function startsBlock(line, next) {
  return FENCE.test(line) || HR.test(line) || HEADING.test(line) || /^\s{0,3}>/.test(line) || LIST.test(line) || (next !== undefined && isTable(line, next));
}

function parseList(lines, i) {
  const first = LIST.exec(lines[i]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  while (i < lines.length) {
    const m = LIST.exec(lines[i]);
    if (!m || m[1].length < base) break;
    if (m[1].length > base) {
      // deeper indent: a nested list under the previous item
      const [sub, next] = parseList(lines, i);
      if (items.length) items[items.length - 1].children.push(sub);
      else items.push({ c: [], children: [sub] });
      i = next;
      continue;
    }
    if (/\d/.test(m[2]) !== ordered) break;
    const text = [m[3]];
    i += 1;
    // continuation lines: indented text that is not itself a list item
    while (i < lines.length && lines[i].trim() && !LIST.test(lines[i]) && /^\s+\S/.test(lines[i]) && !FENCE.test(lines[i])) {
      text.push(lines[i].trim());
      i += 1;
    }
    const task = /^\[( |x|X)\]\s+/.exec(text[0]);
    if (task) text[0] = text[0].slice(task[0].length);
    items.push({ c: parseInline(text.join('\n')), children: [], task: task ? task[1] !== ' ' : undefined });
  }
  return [{ t: ordered ? 'ol' : 'ul', start: ordered ? Number(first[2].replace(/\D/g, '')) : undefined, items }, i];
}

export function parseBlocks(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    let m = FENCE.exec(line);
    if (m) {
      const marker = m[1];
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i += 1; // closing fence (an unclosed one simply runs to the end)
      out.push({ t: 'code', lang: m[2] || '', text: body.join('\n') });
      continue;
    }
    if (HR.test(line)) {
      out.push({ t: 'hr' });
      i += 1;
      continue;
    }
    m = HEADING.exec(line);
    if (m) {
      out.push({ t: 'h', level: m[1].length, c: parseInline(m[2]) });
      i += 1;
      continue;
    }
    if (i + 1 < lines.length && isTable(line, lines[i + 1])) {
      const head = splitRow(line).map(parseInline);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]).map(parseInline));
      out.push({ t: 'table', head, rows });
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) q.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push({ t: 'quote', blocks: parseBlocks(q.join('\n')) });
      continue;
    }
    if (LIST.test(line)) {
      const [list, next] = parseList(lines, i);
      out.push(list);
      i = next;
      continue;
    }
    // paragraph: runs until a blank line or the start of another block
    const para = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++]);
    out.push({ t: 'p', c: parseInline(para.map((l) => l.replace(/\s+$/, '')).join('\n')) });
  }
  return out;
}

// ---------- DOM ----------
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid) n.append(kid);
  return n;
}

function inlineNodes(list) {
  return list.map((n) => {
    switch (n.t) {
      case 'text':
        return document.createTextNode(n.v);
      case 'br':
        return el('br');
      case 'code':
        return el('code', { text: n.v });
      case 'strong':
        return el('strong', {}, inlineNodes(n.c));
      case 'em':
        return el('em', {}, inlineNodes(n.c));
      case 'del':
        return el('del', {}, inlineNodes(n.c));
      case 'a':
        return el('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer' }, inlineNodes(n.c));
      default:
        return null;
    }
  });
}

function codeBlock(b) {
  const copy = el('button', { class: 'copy', type: 'button', text: 'Copy', 'aria-label': 'Copy code' });
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(b.text);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Press and hold to copy';
    }
    setTimeout(() => (copy.textContent = 'Copy'), 1500);
  });
  return el('div', { class: 'code' }, el('div', { class: 'code-head' }, el('span', { class: 'lang', text: b.lang }), copy), el('pre', {}, el('code', { text: b.text })));
}

function listNode(l) {
  const li = (item) =>
    el(
      'li',
      { class: item.task !== undefined ? 'task' : '' },
      item.task !== undefined ? el('span', { class: `check${item.task ? ' on' : ''}`, 'aria-hidden': 'true', text: item.task ? '☑' : '☐' }) : null,
      inlineNodes(item.c),
      item.children.map(listNode)
    );
  return el(l.t, l.start && l.start !== 1 ? { start: String(l.start) } : {}, l.items.map(li));
}

function blockNodes(blocks) {
  return blocks.map((b) => {
    switch (b.t) {
      case 'p':
        return el('p', {}, inlineNodes(b.c));
      case 'h':
        return el('p', { class: `h h${Math.min(b.level, 3)}` }, inlineNodes(b.c));
      case 'code':
        return codeBlock(b);
      case 'ul':
      case 'ol':
        return listNode(b);
      case 'quote':
        return el('blockquote', {}, blockNodes(b.blocks));
      case 'hr':
        return el('hr');
      case 'table':
        return el(
          'div',
          { class: 'tablewrap' },
          el('table', {}, el('thead', {}, el('tr', {}, b.head.map((c) => el('th', {}, inlineNodes(c))))), el('tbody', {}, b.rows.map((r) => el('tr', {}, r.map((c) => el('td', {}, inlineNodes(c)))))))
        );
      default:
        return null;
    }
  });
}

export function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  for (const n of blockNodes(parseBlocks(text))) if (n) frag.append(n);
  return frag;
}

// For one-line summaries: inline formatting only, no block structure.
export function renderInline(text) {
  const frag = document.createDocumentFragment();
  for (const n of inlineNodes(parseInline(String(text ?? '').replace(/\s*\n\s*/g, ' ')))) if (n) frag.append(n);
  return frag;
}
