// Shared text helpers for turning agent messages into one-line feed summaries.
export function oneLine(text, n = 280) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// The first meaningful sentence or two of a Markdown message: skips code blocks, rules and heading
// or bullet markers, so "## Summary\n- Fixed the parser" reads "Summary — Fixed the parser".
export function summarize(text, n = 280) {
  const parts = [];
  let inFence = false;
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^\s{0,3}#{1,6}\s+/.test(raw);
    const line = raw.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '').trim();
    if (!line || /^[-*_=]{3,}$/.test(line)) continue;
    parts.push({ line, heading });
    if (parts.length >= 3 || parts.map((p) => p.line).join(' ').length >= 90) break;
  }
  let out = '';
  for (const [i, p] of parts.entries()) out += i === 0 ? p.line : `${parts[i - 1].heading && !parts[i - 1].line.endsWith(':') ? ' — ' : ' '}${p.line}`;
  return oneLine(out, n) || oneLine(text, n);
}
