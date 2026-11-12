// Turn commits into feed events. Works for every tool because every tool ends in a commit.
// On first sight of a repo the recent history is loaded (with the original timestamps),
// so the feed is worth opening on day one. After that only new commits are posted.
import { git } from '../lib/discover.js';

export function pollGit(repos, gitState, outbox, { backfillDays = 30, backfillMax = 20 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  for (const repo of repos) {
    let st = gitState[repo.name];
    let limit = 30;
    if (!st) {
      st = { since: now - Math.max(0, backfillDays) * 86400, seen: [], first: true };
      gitState[repo.name] = st;
      limit = backfillMax;
      if (backfillDays <= 0) {
        st.since = now;
        continue;
      }
    }
    const out = git(repo.dir, 'log', '--all', `--since=${Math.max(0, st.since - 120)}`, '--format=%H%x09%ct%x09%an%x09%s', '-n', String(limit));
    const rows = out ? out.split('\n').map((l) => l.split('\t')) : [];
    for (const [hash, ct, author, ...rest] of rows.reverse()) {
      if (!hash || st.seen.includes(hash)) continue;
      st.seen.push(hash);
      const day = new Date(Number(ct) * 1000).toISOString().slice(0, 10);
      outbox.push({
        project: repo.name,
        harness: 'git',
        agent: author || '',
        session_id: `git:${repo.name}:${day}`,
        kind: 'progress',
        summary: rest.join('\t').slice(0, 300) || '(no message)',
        ts: Number(ct) * 1000,
      });
    }
    delete st.first;
    if (st.seen.length > 300) st.seen = st.seen.slice(-300);
    st.since = now;
  }
}
