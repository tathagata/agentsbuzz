# How agentsbuzz works

agentsbuzz is a few small Node processes on your own computer. They watch what your coding agents and repositories do, keep it in a local SQLite database, and serve it to a web app on your phone, live. When you reply, your message travels back the other way, to the agent.

There are no dependencies beyond Node's built-ins, no cloud service and no account. Everything below runs on the machine where you typed `./buzz`.

- [The big picture](#the-big-picture)
- [Components](#components)
- [Storage](#storage)
- [Sequences](#sequences): [startup](#1-startup), [a finished turn reaches your phone](#2-a-finished-turn-reaches-your-phone), [an agent needs you](#3-an-agent-needs-you), [your reply reaches the agent](#4-your-reply-reaches-the-agent), [phone sign-in](#5-signing-in-on-your-phone), [follow main](#6-follow-main-auto-deploy)
- [The machinery, explained](#the-machinery-explained)

## The big picture

```mermaid
flowchart LR
  subgraph Sources["On your computer: what is watched"]
    P["Projects folder<br/>git repositories"]
    C["Claude Code sessions<br/>~/.claude/projects/*.jsonl"]
    X["Codex sessions<br/>~/.codex/sessions/rollout-*.jsonl"]
  end

  subgraph Agents["Your agents"]
    CC["Claude Code"]
    CX["Codex, Cursor, others"]
  end

  subgraph Buzz["agentsbuzz processes (started by ./buzz)"]
    L["Launcher<br/>cli/launcher.js"]
    COL["Collector<br/>collector/"]
    S["Feed server<br/>server/server.js"]
    DB[("SQLite<br/>~/.agentsbuzz/buzz.db")]
    W["Waker (optional)<br/>cli/deliver.js"]
    F["Follower (optional)<br/>cli/follow.js"]
  end

  subgraph You["You"]
    PH["Phone or browser<br/>web app"]
  end

  GH["GitHub<br/>origin/main"]

  P --> COL
  C --> COL
  X --> COL
  COL -- "POST /api/events" --> S
  CC -- "hook: needs you, picks up messages" --> S
  CX -- "MCP tools: post_update, get_messages" --> S
  S <--> DB
  S -- "live stream (SSE)" --> PH
  PH -- "Reply, Handled, plans" --> S
  W -- "polls for messages" --> S
  W -- "claude --resume / codex exec resume" --> CC
  F -- "git fetch, every minute" --> GH
  F -- "./buzz restart after tests pass" --> L
  L -. starts and stops .-> COL
  L -. starts and stops .-> S
  L -. starts and stops .-> W
  L -. starts and stops .-> F
```

Information flows in two directions:

- **Up (agents → you):** the collector reads files your tools already write (git history and agent session logs) and turns them into feed events. Nothing has to change in your projects.
- **Down (you → agents):** a message you leave is queued in the database until an agent collects it, through the Claude Code hook, the MCP tool, or the waker resuming a stopped session.

## Components

```mermaid
flowchart TB
  subgraph launcher["Launcher: ./buzz → cli/launcher.js"]
    l1["start, stop, restart, status<br/>config and token: ~/.agentsbuzz/config.json<br/>process ids: run.json"]
    l2["phone: Tailscale HTTPS link + QR<br/>connect: hook, MCP and agent notes<br/>wake / follow / autostart switches"]
  end

  subgraph server["Feed server: server/server.js"]
    s1["HTTP API under /api, token required"]
    s2["Live stream: GET /api/stream (server-sent events)"]
    s3["Static web app from web/, strict CSP"]
    s4[("node:sqlite<br/>events, projects, replies")]
  end

  subgraph collector["Collector: collector/"]
    c1["index.js: the loops, the outbox, first-run backfill"]
    c2["git.js: new commits per repository"]
    c3["transcripts.js: Claude and Codex session files → turns"]
    c4["state.js: read offsets, so nothing is posted twice"]
    c5["lib/discover.js: finds repositories, read-only git"]
  end

  subgraph web["Web app: web/"]
    w1["app.js: feed, threads, dock, plans, replies"]
    w2["md.js: Markdown → DOM nodes, no HTML strings"]
    w3["avatar.js: monograms and colours from names"]
    w4["keys.js: keyboard shortcuts and ⌘K palette"]
    w5["sw.js: offline app shell"]
  end

  subgraph agentside["Agent side"]
    a1["hooks/claude-code-hook.js<br/>SessionStart, UserPromptSubmit,<br/>Notification, Stop, SubagentStop"]
    a2["mcp/server.js<br/>post_update, get_messages, update_project"]
    a3["cli/buzz.js, cli/project.js<br/>post from scripts"]
  end

  subgraph optional["Optional services"]
    o1["cli/deliver.js: the waker"]
    o2["cli/follow.js: the follower"]
  end

  launcher --> server
  launcher --> collector
  launcher --> optional
  collector --> server
  agentside --> server
  web --> server
  o1 --> server
```

| Component | Runs as | Job |
| --- | --- | --- |
| **Launcher** (`cli/launcher.js`, run by `./buzz`) | A short-lived command | Creates the token and config, picks a port, starts the other processes in the background, records their ids, and handles `phone`, `connect`, `wake`, `follow` and `autostart`. |
| **Feed server** (`server/server.js`) | Background process | The only process that touches the database. Serves the API, the live stream and the web app, and enforces the token and browser security headers. |
| **Collector** (`collector/`) | Background process | Finds your repositories and follows git and agent session files, turning them into events. Remembers how far it has read, so a restart never posts anything twice. |
| **Web app** (`web/`) | Your browser or phone | Renders the feed from the API, applies live updates from the stream, and sends replies, Handled and plan changes. Installable as an app from the home screen. |
| **Claude Code hook** (`hooks/claude-code-hook.js`) | Runs inside Claude Code, on each hook event | Flags "needs you" moments, and hands your waiting messages to the agent. Never blocks the agent; exits cleanly if the server is down. |
| **MCP server** (`mcp/server.js`) | Started by any MCP-capable agent | Lets an agent post milestones, collect your messages and update its project plan. |
| **Waker** (`cli/deliver.js`, with `./buzz wake on`) | Background process | Resumes a stopped agent session when a message for it is waiting. |
| **Follower** (`cli/follow.js`, with `./buzz follow on`) | Background process | Deploys new commits on `main`, after their tests pass. |

## Storage

One SQLite file, `~/.agentsbuzz/buzz.db`, in a folder only you can read (`0700`). The server opens it in WAL mode, so reads never wait for writes.

```mermaid
erDiagram
  PROJECTS ||--o{ EVENTS : "has"
  EVENTS ||--o{ REPLIES : "replied to"
  PROJECTS ||--o{ REPLIES : "notes for"

  PROJECTS {
    text name PK
    text description
    text status "idea, active, paused, done"
    text focus "the now line"
    text plan "JSON list of steps"
  }
  EVENTS {
    int id PK
    int ts "when it happened"
    text project
    text harness "claude-code, codex, git..."
    text session_id "events sharing it form one thread"
    text kind "milestone, done, blocked, error..."
    text summary "one line for a phone"
    text body "optional Markdown"
    int needs_you
    int resolved "Handled"
  }
  REPLIES {
    int id PK
    int event_id "the post you replied to"
    text session_id "empty for a project note"
    text project
    text prompt "your message"
    int delivered
    text delivered_via "hook, mcp, wake..."
  }
```

## Sequences

### 1. Startup

```mermaid
sequenceDiagram
  autonumber
  actor You
  participant L as Launcher (./buzz)
  participant S as Feed server
  participant C as Collector
  participant B as Browser

  You->>L: ./buzz
  L->>L: read or create config and token, pick a free port
  L->>S: start in the background (PORT, token, database path)
  loop until healthy
    L->>S: GET /api/health
  end
  L->>C: start in the background (folders to watch, server address, token)
  opt waking or following is on
    L->>L: start the waker and the follower too
  end
  C->>C: find git repositories in the projects folder
  C->>S: first run only: one batch of recent history, sorted by time
  L->>S: poll project and event counts until they settle
  L->>B: open http://127.0.0.1:port/ with the token in the link
  B->>S: GET /api/projects, /api/events (Bearer token)
  B->>S: open the live stream
```

### 2. A finished turn reaches your phone

The collector reads the session files Claude Code and Codex already write, so this needs no setup.

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent (Claude Code or Codex)
  participant FS as Session file
  participant C as Collector
  participant S as Feed server
  participant DB as SQLite
  participant P as Phone

  A->>FS: append lines as it works
  loop every 5 seconds
    C->>FS: read new complete lines from the last offset
    C->>C: keep the latest assistant text for that session
  end
  alt the agent marks the end of its turn
    C->>C: turn finished now
  else no new lines for 90 seconds
    C->>C: treat the turn as finished
  end
  C->>C: summarize to one line, keep up to 2,000 characters of body
  C->>S: POST /api/events (kind done, session_id, project from the folder)
  S->>DB: insert the event, create the project if new
  S-->>P: stream: event
  P->>P: thread it under its session and render (the post under your thumb stays put)
  C->>C: save the read offset, so a restart never re-posts
```

Git works the same way on a slower loop (every 30 seconds): each new commit becomes an event, grouped into one thread per repository per day.

### 3. An agent needs you

```mermaid
sequenceDiagram
  autonumber
  participant A as Claude Code
  participant H as Hook
  participant S as Feed server
  participant P as Phone

  A->>H: Notification (for example, waiting for permission)
  H->>S: POST /api/events (kind blocked, needs_you)
  S-->>P: stream: event
  P->>P: pin it in "N agents need you"
  opt the app is in the background and notifications are allowed
    P->>P: system notification
  end
  Note over P: You answer with Reply, or tap Handled
  P->>S: POST /api/events/:id/resolve
  S-->>P: stream: update (it leaves the pinned lane)
```

Agents without hooks can do the same through the MCP tool `post_update` with `blocked`.

### 4. Your reply reaches the agent

A message is stored first and delivered later, exactly once, by whichever path gets to it first.

```mermaid
sequenceDiagram
  autonumber
  actor You
  participant P as Phone
  participant S as Feed server
  participant H as Hook (running agent)
  participant W as Waker
  participant A as Agent CLI

  You->>P: Reply on a post
  P->>S: POST /api/events/:id/reply
  S->>S: queue it for that session (Waiting for the agent)

  alt the agent is running (Claude Code hook)
    A->>H: UserPromptSubmit, or Stop at the end of a turn
    H->>S: POST /api/replies/claim (session, project)
    S-->>H: your messages, marked delivered atomically
    alt at UserPromptSubmit
      H-->>A: added to the agent's context
    else at Stop
      H-->>A: decision block: handle this before stopping
    end
  else the agent has stopped and waking is on
    loop every 4 seconds
      W->>S: any waiting messages? which sessions?
    end
    W->>W: session quiet for 90 seconds? id and folder valid?
    W->>S: POST /api/replies/claim (via wake)
    W->>A: claude --resume id -p message (or codex exec resume)
    alt it ran
      A->>A: works in the session's own folder, with its own permissions
      Note over A,S: its answer arrives as a normal finished turn (sequence 2)
    else the command failed
      W->>S: requeue the messages, post the reason to the feed
    end
  else MCP-capable agent
    A->>S: get_messages tool → claim
  end
  S-->>P: stream: reply (Delivered)
```

If a session has been silent for 30 minutes, its waiting messages may go to the next agent that asks on the same project. A note left on a project, rather than on a post, goes to whichever agent asks first.

### 5. Signing in on your phone

```mermaid
sequenceDiagram
  autonumber
  actor You
  participant L as ./buzz phone
  participant T as Tailscale
  participant P as Phone

  L->>T: tailscale serve: private HTTPS name for the local port
  L->>You: QR code of https://your-machine.ts.net/#t=token
  You->>P: scan
  P->>P: read the token from the fragment, store it, remove it from the address bar
  Note over P: The fragment (after #) is never sent to any server
  P->>T: API calls with Authorization: Bearer token
  T->>T: only devices in your tailnet can reach it
```

### 6. Follow main (auto-deploy)

```mermaid
sequenceDiagram
  autonumber
  participant F as Follower
  participant G as GitHub
  participant WT as Scratch worktree
  participant CO as Your checkout
  participant L as ./buzz restart
  participant S as Feed

  loop every minute
    F->>G: git fetch origin main
  end
  F->>CO: on main, at the old commit, nothing uncommitted?
  F->>WT: check out the new commit separately
  F->>WT: run the test suite (at least one test must run)
  alt tests pass and the checkout has not moved
    F->>CO: fast-forward only
    F->>S: post "Deployed abc1234 ..."
    F->>CO: still exactly the tested commit?
    F->>L: restart (stops and starts every process on the new code)
  else anything else
    F->>S: post why it did not deploy (once per commit)
  end
```

## The machinery, explained

**Threads.** Every event carries a `session_id`: an agent's session, or `git:repo:day` for commits. The web app groups events by project and session into one post. The post shows the newest *important* event (milestone, done, PR, blocked, error) as its headline, and the rest as earlier updates behind a tap. That is why a busy session is one post, not fifty.

**Exactly-once delivery.** Claiming messages is a single SQL `UPDATE … RETURNING` that marks rows delivered and returns them in one step. The hook, the MCP tool and the waker can race for the same message and only one wins. If the waker cannot run the agent, it hands its claim back (`/api/replies/requeue`, which can only undo its own claims), so the message is not lost.

**Idle versus active.** The waker treats a session as idle when nothing has been heard from it for 90 seconds. Before that, the agent's own hook will pick the message up at its next turn, and waking it would interrupt. After 30 minutes of silence, a session counts as gone, and its messages may go to the next agent on the project.

**Never posting twice.** The collector stores, for every session file, how far it has read, and for every repository, which commits it has seen (`~/.agentsbuzz/collector-state.json`). It reads only complete lines, skips oversized ones, and survives restarts and rotated files. Events are batched through an outbox and retried if the server is down.

**Live without jank.** The server pushes every change over one server-sent events stream. The app applies changes in place, rebuilds only posts whose content changed, keeps the post under your thumb fixed while new ones arrive above it, and waits for a pause in scrolling before re-rendering. A "↑ N new" pill offers the way back to the top.

**Security boundaries.** Every `/api` route needs the token, compared in constant time and accepted in the address only for the live stream. Browser requests from other websites are refused, and without a token only loopback is served (no DNS rebinding). Every response carries a strict Content-Security-Policy, and the app builds its page with DOM calls, never HTML strings. The waker validates session ids and project folders before anything reaches a command line, and never runs agents for a server without a token. Git is only read, with every hook and helper switched off. [SECURITY.md](../SECURITY.md) has the full list.

**What is optional.** Only the server and collector are needed for a read-only feed. The hook and MCP tool add "needs you" and message delivery to running agents, the waker adds delivery to stopped ones, and the follower adds auto-deploy. Each is switched on with one command that says what it will do first.
