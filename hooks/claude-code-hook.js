#!/usr/bin/env node
// Claude Code hook -> agentsbuzz. Wire it to SessionStart, Notification, Stop and SubagentStop.
// Also hands the agent messages left in the feed:
//   SessionStart / UserPromptSubmit -> added to the agent's context
//   Stop -> the agent is asked to keep going and deal with the message
// Never blocks or fails the agent: always exits 0, gives up after 3 seconds.
import fs from 'node:fs';
import { post, projectFromDir, claimReplies, formatMessages } from '../lib/client.js';
import { summarize } from '../lib/text.js';

const hardStop = setTimeout(() => process.exit(0), 3500);
hardStop.unref();

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

// Best effort: last assistant text from the transcript JSONL. Format may change between versions.
function lastAssistantText(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let row;
      try {
        row = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (row.type !== 'assistant') continue;
      const content = row.message?.content;
      const text = Array.isArray(content)
        ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
        : typeof content === 'string'
          ? content
          : '';
      if (text.trim()) return text.trim();
    }
  } catch {
    /* ignore */
  }
  return '';
}

function oneLine(text, n = 280) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

try {
  const input = JSON.parse((await readStdin()) || '{}');
  const project = projectFromDir(input.cwd);
  const base = {
    project,
    harness: 'claude-code',
    agent: 'claude',
    session_id: input.session_id || '',
  };
  const name = input.hook_event_name;
  let event = null;
  const claim = async () => {
    try {
      return await claimReplies({ session_id: base.session_id, project, via: 'claude-code-hook' });
    } catch {
      return [];
    }
  };
  const say = (obj) => new Promise((done) => process.stdout.write(`${JSON.stringify(obj)}\n`, done));

  if (name === 'SessionStart') {
    event = { ...base, kind: 'started', summary: `Session started in ${project}` };
    const msgs = await claim();
    if (msgs.length) await say({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: formatMessages(msgs) } });
  } else if (name === 'UserPromptSubmit') {
    const msgs = await claim();
    if (msgs.length) {
      await say({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: formatMessages(msgs) } });
      event = { ...base, kind: 'note', summary: oneLine(`Picked up your message: ${msgs.map((m) => m.prompt).join(' / ')}`) };
    }
  } else if (name === 'Notification') {
    event = {
      ...base,
      kind: 'blocked',
      needs_you: true,
      summary: oneLine(input.message || 'Needs your attention'),
    };
  } else if (name === 'Stop') {
    const text = input.transcript_path ? lastAssistantText(input.transcript_path) : '';
    event = { ...base, kind: 'done', summary: summarize(text) || 'Finished a turn', body: text.slice(0, 2000) };
    const msgs = await claim();
    if (msgs.length) {
      // keep the agent working instead of stopping: it reads the message and acts on it
      await say({ decision: 'block', reason: `${formatMessages(msgs)}\nPlease handle this now before you stop.` });
      if (process.env.AGENTSBUZZ_HOOK_QUIET !== '1') await post(event).catch(() => {});
      event = { ...base, kind: 'note', summary: oneLine(`Picked up your message: ${msgs.map((m) => m.prompt).join(' / ')}`) };
    }
  } else if (name === 'SubagentStop') {
    const text = input.transcript_path ? lastAssistantText(input.transcript_path) : '';
    event = { ...base, kind: 'progress', agent: 'subagent', summary: oneLine(text) || 'Subagent finished' };
  }

  // QUIET (set by `buzz connect`): the collector already reports sessions and finished turns from the
  // transcripts, so only post what it cannot see: needs-you alerts and message pickups.
  if (event && process.env.AGENTSBUZZ_HOOK_QUIET === '1' && !(event.kind === 'blocked' || event.summary.startsWith('Picked up your message'))) event = null;
  if (event) await post(event);
} catch {
  /* swallow: observability must never break the agent */
}
process.exit(0);
