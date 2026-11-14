import fs from 'node:fs';
import path from 'node:path';

export function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { git: s.git || {}, files: s.files || {}, names: s.names || {} };
  } catch {
    return { git: {}, files: {}, names: {} };
  }
}

export function saveState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
    fs.renameSync(`${file}.tmp`, file);
  } catch (e) {
    console.error(`could not save state: ${e.message}`);
  }
}
