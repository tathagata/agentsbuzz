// Terminal QR codes, so a phone can scan straight from the screen.
// Uses the MIT-licensed qrcode-generator by Kazuhiko Arase (lib/vendor/qrcode.cjs).
import { createRequire } from 'node:module';
const qrcode = createRequire(import.meta.url)('./vendor/qrcode.cjs');

export function qrMatrix(text) {
  const qr = qrcode(0, 'L'); // smallest version that fits, lowest error correction: fewest modules
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

// Two modules per character cell using half blocks, drawn black on white with explicit colors
// so it scans the same on dark and light terminals.
export function terminalQR(text, { quiet = 2, color = true } = {}) {
  const m = qrMatrix(text);
  const n = m.length + quiet * 2;
  const at = (r, c) => {
    const rr = r - quiet;
    const cc = c - quiet;
    return rr >= 0 && cc >= 0 && rr < m.length && cc < m.length ? m[rr][cc] : false;
  };
  const on = color ? '\x1b[30;47m' : '';
  const off = color ? '\x1b[0m' : '';
  const lines = [];
  for (let r = 0; r < n; r += 2) {
    let line = '';
    for (let c = 0; c < n; c++) {
      const top = at(r, c);
      const bottom = at(r + 1, c);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(`${on}${line}${off}`);
  }
  return lines.join('\n');
}
