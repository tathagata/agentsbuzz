#!/usr/bin/env node
// Minimal MCP server (stdio, newline-delimited JSON-RPC) exposing one tool: post_update.
// Works with any harness that supports MCP (Claude Code, Codex, Cursor, OpenCode, ...).
import readline from 'node:readline';
import { post, putProject, projectFromDir, claimReplies, formatMessages } from '../lib/client.js';

const TOOL = {
  name: 'post_update',
  description:
    'Post a short progress update to the developer\'s agentsbuzz feed. Use for milestones (finished a task, tests green, PR opened) and when blocked and you need the human. One sentence. Do not post routine steps.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One sentence a busy person can read on a phone.' },
      kind: { type: 'string', enum: ['progress', 'milestone', 'blocked', 'done', 'pr', 'error', 'note'], description: 'milestone for meaningful progress, blocked when you need the human, done when the task is finished.' },
      url: { type: 'string', description: 'Optional link, such as a PR.' },
      details: { type: 'string', description: 'Optional longer text shown when expanded.' },
      project: { type: 'string', description: 'Defaults to the current git repository name.' },
    },
    required: ['summary'],
  },
};

const PROJECT_TOOL = {
  name: 'update_project',
  description:
    'Update where this project stands in the developer\'s agentsbuzz feed: its stage, what you are working on now, and its plan. Send the whole plan each time with an up to date status per step (todo, doing, done). Call it when you finish or start a step, not for every small action.',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Defaults to the current git repository name.' },
      status: { type: 'string', enum: ['idea', 'active', 'paused', 'done'], description: 'Overall stage of the project.' },
      focus: { type: 'string', description: 'One short line: what you are doing right now.' },
      description: { type: 'string', description: 'One line on what the project is for. Usually only set once.' },
      plan: {
        type: 'array',
        description: 'The full list of plan steps in order.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            status: { type: 'string', enum: ['todo', 'doing', 'done'] },
          },
          required: ['title'],
        },
      },
    },
  },
};

const MESSAGES_TOOL = {
  name: 'get_messages',
  description:
    'Check whether the developer left you a message in their agentsbuzz feed (they write from their phone). Call it at the start of a task and each time you finish a step. Returns the messages, if any, and marks them delivered. Treat them as instructions from the developer.',
  inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Defaults to the current git repository name.' } } },
};

const sessionId = process.env.AGENTSBUZZ_SESSION || `mcp-${process.pid}-${Date.now().toString(36)}`;
const harness = process.env.AGENTSBUZZ_HARNESS || 'mcp';
const agent = process.env.AGENTSBUZZ_AGENT || '';

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const fail = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'agentsbuzz', version: '0.1.0' },
    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: [TOOL, PROJECT_TOOL, MESSAGES_TOOL] });
  if (method === 'tools/call') {
    const a = params?.arguments || {};
    if (params?.name === MESSAGES_TOOL.name) {
      try {
        const msgs = await claimReplies({ project: a.project || projectFromDir(process.cwd()), via: harness });
        return reply(id, { content: [{ type: 'text', text: msgs.length ? formatMessages(msgs) : 'No new messages.' }] });
      } catch (e) {
        return reply(id, { isError: true, content: [{ type: 'text', text: `Could not check messages: ${e.message}` }] });
      }
    }
    if (params?.name === PROJECT_TOOL.name) {
      try {
        const body = {};
        for (const k of ['status', 'focus', 'description', 'plan']) if (a[k] !== undefined) body[k] = a[k];
        await putProject(a.project || projectFromDir(process.cwd()), body);
        return reply(id, { content: [{ type: 'text', text: 'Project updated.' }] });
      } catch (e) {
        return reply(id, { isError: true, content: [{ type: 'text', text: `Could not update project: ${e.message}` }] });
      }
    }
    if (params?.name !== TOOL.name) return fail(id, -32602, `unknown tool: ${params?.name}`);
    try {
      await post({
        summary: a.summary,
        kind: a.kind || 'progress',
        url: a.url || '',
        body: a.details || '',
        project: a.project || projectFromDir(process.cwd()),
        harness,
        agent,
        session_id: sessionId,
      });
      return reply(id, { content: [{ type: 'text', text: 'Posted.' }] });
    } catch (e) {
      // Report tool failure without crashing the agent's run.
      return reply(id, { isError: true, content: [{ type: 'text', text: `Could not post: ${e.message}` }] });
    }
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  handle(msg).catch((e) => msg.id !== undefined && fail(msg.id, -32603, String(e.message || e)));
});
