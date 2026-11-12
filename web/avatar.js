// Project avatars: a two-letter monogram and a color, both worked out from the project name alone,
// so every device shows the same avatar for the same project. No library: see the PR that added this.

// "work-queue-grid" -> work, queue, grid; "l_python_notes" -> l, python, notes;
// "photoLib" -> photo, Lib; "_scratch-test" -> scratch, test. Letters in any script count, so
// "café-über" -> café, über.
export function words(name) {
  return String(name || '')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// Upper-casing is locale-independent (toUpperCase, not toLocaleUpperCase); a letter that grows
// when upper-cased ("ß" -> "SS") is cut back so a monogram is never more than two characters.
const two = (s) => [...s.toUpperCase()].slice(0, 2).join('');

// Monograms to try, best first: the first letters of the first two words (or the first two letters
// of a one-word name), then the first letter with the initial of each later word, then with each
// later letter of the name, then with a digit.
function* candidates(name) {
  const w = words(name);
  if (!w.length) {
    yield '?';
    for (let d = 2; d <= 9; d++) yield `?${d}`;
    return;
  }
  const first = [...w[0]][0];
  const seen = new Set();
  const offer = function* (code) {
    code = two(code);
    if (!seen.has(code)) {
      seen.add(code);
      yield code;
    }
  };
  if (w.length > 1) yield* offer(first + [...w[1]][0]);
  else if ([...w[0]].length > 1) yield* offer([...w[0]].slice(0, 2).join(''));
  // siblings usually differ at the end (app vs app-podman), so later words go first
  for (let i = w.length - 1; i >= 2; i--) yield* offer(first + [...w[i]][0]);
  for (const ch of [...w.join('')].slice(1)) yield* offer(first + ch);
  for (let d = 2; d <= 9; d++) yield* offer(first + d);
  yield* offer(first);
}

// When a name's own letters are all taken: its first letter with any letter or digit, then any
// two-character code at all. 1,296 codes in all, far more projects than anyone has.
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function* fallback(name) {
  const w = words(name);
  if (w.length) for (const ch of ALNUM) yield two([...w[0]][0] + ch);
  for (const a of ALNUM) for (const b of ALNUM) yield a + b;
}

// Plain code-point order, never the device's locale: localeCompare sorts "aä" and "az" one way in
// English and the other in Swedish, and every device must agree.
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Every project gets a monogram no other project has. Names are handled in a fixed order, so the
// same set of projects gives the same monograms on every device.
export function assignMonograms(names) {
  const out = new Map();
  const used = new Set();
  const sorted = [...new Set(names.map(String))].sort((a, b) => byCodePoint(a.toLowerCase(), b.toLowerCase()) || byCodePoint(a, b));
  for (const name of sorted) {
    let pick = '';
    for (const c of (function* () {
      yield* candidates(name);
      yield* fallback(name);
    })()) {
      if (!used.has(c)) {
        pick = c;
        break;
      }
    }
    pick = pick || two(words(name).join('')) || '?'; // only past 1,296 projects can this repeat
    used.add(pick);
    out.set(name, pick);
  }
  return out;
}

// Twelve hues 30 degrees apart, chosen by a hash of the name: stable everywhere, with no stored
// state. Two projects can share a color; their letters still tell them apart.
const HUES = Array.from({ length: 12 }, (_, i) => (i * 30 + 25) % 360);
export function hash(s) {
  let h = 0x811c9dc5; // FNV-1a
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
export const hueFor = (name) => HUES[hash(name) % HUES.length];
export const colorFor = (name) => `hsl(${hueFor(name)} 62% 62%)`;
