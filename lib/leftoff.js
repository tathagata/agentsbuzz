// "Where you left off": what a project's feed already says, boiled down for someone coming back to it
// after a while. Three parts, all worked out from recorded events (no model, no network):
//   summary  the agent's last word, the last commit, how long ago, what is still open
//   next     the one action most likely to move the project: answer, fix, go ahead, or continue
//   metrics  what got done in the last 30 days
// Pure functions over plain rows, so they are easy to test and cannot touch anything.

const DAY = 86400000;
export const WINDOW_DAYS = 30;

const plain = (s) =>
  String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_#>]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const sentences = (text) =>
  plain(text)
    .split(/(?<=[.?!])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter(Boolean);

// A sentence where the agent says what comes next or asks to go on.
const NEXT_RE = /\b(next(?: step| up)?\b|then I(?:'|’)ll|I(?:'|’)ll (?:next|then|also)|want me to|should I|shall I|would you like|do you want|remaining|left to do|still (?:need|to do|missing)|to ?do:|follow[- ]?up|not (?:yet )?done|haven(?:'|’)t (?:yet )?)/i;

export function proposedNext(text) {
  const all = sentences(text);
  for (let i = all.length - 1; i >= 0; i--) if (NEXT_RE.test(all[i])) return clip(all[i], 180);
  return '';
}

// rows: events of one project, newest first, covering at least the last WINDOW_DAYS
export function metrics(rows, now = Date.now()) {
  const since = now - WINDOW_DAYS * DAY;
  const m = { days: WINDOW_DAYS, commits: 0, turns: 0, milestones: 0, prs: 0, answered: 0, active_days: 0 };
  const days = new Set();
  for (const e of rows) {
    if (e.ts < since) continue;
    days.add(Math.floor(e.ts / DAY));
    if (e.harness === 'git') m.commits++;
    else if (e.kind === 'done') m.turns++;
    if (e.kind === 'milestone') m.milestones++;
    if (e.kind === 'pr') m.prs++;
    if (e.needs_you && e.resolved) m.answered++;
  }
  m.active_days = days.size;
  return m;
}

// lastAgent: the newest event an agent (not git) posted, any age. lastCommit: the newest git event.
// open: unresolved needs-you events, newest first. waiting: your messages no agent has picked up yet.
export function leftOff({ lastAgent = null, lastCommit = null, open = [], waiting = [], recent = [], lastTs = 0, now = Date.now() } = {}) {
  const said = lastAgent ? sentences(lastAgent.body || lastAgent.summary) : [];
  const summary = {
    last_ts: lastTs || Math.max(lastAgent?.ts || 0, lastCommit?.ts || 0),
    agent: lastAgent ? { name: lastAgent.agent || lastAgent.harness, kind: lastAgent.kind, ts: lastAgent.ts, text: clip(said.slice(0, 2).join(' ') || plain(lastAgent.summary), 280) } : null,
    commit: lastCommit ? { ts: lastCommit.ts, text: clip(plain(lastCommit.summary), 140) } : null,
    open: open.length,
    waiting: waiting.length,
  };

  let next;
  const need = open[0];
  const stale = waiting.find((r) => now - r.ts > 2 * 60 * 1000);
  const proposal = lastAgent ? proposedNext(lastAgent.body || lastAgent.summary) : '';
  if (need) {
    next = { kind: 'answer', text: clip(plain(need.summary), 180), event_id: need.id, body: clip(plain(need.body), 600) };
  } else if (stale) {
    next = { kind: 'waiting', text: clip(plain(stale.prompt), 140) };
  } else if (lastAgent && (lastAgent.kind === 'error' || lastAgent.kind === 'blocked') && !lastAgent.resolved) {
    next = { kind: 'fix', text: clip(plain(lastAgent.summary), 180), event_id: lastAgent.id, reply: `Please sort this out: ${clip(plain(lastAgent.summary), 200)}` };
  } else if (proposal) {
    next = /\?$/.test(proposal)
      ? { kind: 'question', text: proposal, event_id: lastAgent.id }
      : { kind: 'proposal', text: proposal, event_id: lastAgent.id, reply: `Go ahead with what you proposed: "${proposal}"` };
  } else if (lastAgent) {
    next = { kind: 'continue', text: clip(plain(lastAgent.summary), 180), event_id: lastAgent.id, reply: 'Continue from where you left off.' };
  } else {
    next = { kind: 'start', text: lastCommit ? 'No agent has worked here yet.' : 'Nothing has happened here yet.' };
  }
  if (next.event_id && !(next.kind === 'answer' ? need.session_id : lastAgent?.session_id)) next.project_note = true;

  return { summary, next, metrics: metrics(recent, now) };
}
