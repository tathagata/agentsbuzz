# Security Policy

agentsbuzz is a personal, single-maintainer project. There is no security team and no formal SLA, but reports are taken seriously and triaged promptly.

## Supported versions

Only the tip of `main` is supported. Fixes land on `main`; pull and restart (`./buzz stop && ./buzz`) to pick them up.

## Reporting a vulnerability

Please **do not open a public issue** for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository (**Security** tab → **Report a vulnerability**) with a description and, if you can, steps to reproduce. Expect an acknowledgment within a few days.

## Why this matters more than it looks

With `./buzz wake on`, a message left in the feed resumes a coding agent on your computer. Anyone who can send messages to your server can make an agent run. Everything below exists to keep that ability with you alone.

## Scope

In scope: bugs in agentsbuzz that let it do something it should not, for example:

- Reaching the API without the token: auth bypass, CSRF from another website, DNS rebinding, token leaks through URLs, logs or the `Referer` header.
- Making the wake service run anything other than `claude --resume <session> -p <message>` or `codex exec resume <session> <message>`, run it outside the session's project folder, or run it for a server without a token.
- Script injection in the web app (feed posts and agent replies are untrusted text).
- The collector or launcher running programs from a repository you are only reading, or writing outside `~/.agentsbuzz` and the files `./buzz connect` lists before you confirm.
- Reading another local user's feed data, or the containers gaining privileges they were not given.
- A dependency, action or base image that CI should have caught.
- With `./buzz follow on`: deploying anything other than a fast-forward of `origin/main` whose tests passed, or changing a checkout that is on another branch or has local commits.

Out of scope, because it is how the tool is meant to work:

- Someone who has your token can read your feed and send messages, and with waking on, run your agents. Keep the token private; anyone holding it is you as far as the server knows.
- An agent woken by a message runs with its own permission settings: whatever it is allowed to do when you resume it yourself, it may do. agentsbuzz never loosens them.
- Summaries of agent replies (up to 2,000 characters) are stored in your feed. That is the product.
- With `./buzz follow on`, code merged to `main` runs on your computer once its tests pass. That is the point; protect `main` with required reviews and checks.

## What is in place

**Server** (`server/server.js`)

- Listens on `127.0.0.1` by default and refuses any other address without a token. `./buzz` always sets a random 128-bit token.
- The token is compared in constant time. It is accepted in the URL only for the live stream (`EventSource` cannot send headers); every other route needs the `Authorization` header.
- API calls another website makes from your browser are refused (`Sec-Fetch-Site: cross-site`). Without a token, only loopback `Host` names are served, which stops DNS rebinding.
- Every response sends a strict `Content-Security-Policy` (`default-src 'none'`, scripts, styles and connections only from the app itself, no inline script or style, `frame-ancestors 'none'`), plus `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and same-origin opener/resource policies.
- Static files are confined to `web/`; malformed URLs get a 400.
- The database and its folder are created private to you (`umask 077`, folder `0700`).

**Web app** (`web/`)

- Renders text with `textContent` and DOM nodes only, never `innerHTML`. Markdown links accept only `http`, `https` and `mailto`.
- Loads nothing from another origin. The sign-in link carries the token in the `#fragment`, which never reaches a server, and it is removed from the address bar right away.

**Wake service** (`cli/deliver.js`)

- Runs only when the server has a token.
- Session ids must look like real ids (letters, digits, `.`, `_`, `:`, `-`, not starting with `-`), so one can never be read as a command-line option. Message text always begins with a fixed word for the same reason.
- Runs the agent in the folder the collector saw the session use, or in a folder directly inside your projects folder. A project name can never point anywhere else.
- Spawns the command directly, never through a shell.

**Collector and launcher**

- Read repositories with `git log` only, with the pager, fsmonitor, hooks, replacement objects, lazy fetching and prompts switched off, so a repository's own config cannot make git run a program.
- `~/.agentsbuzz` is kept at `0700`, and the config holding the token at `0600`. `./buzz connect` lists every file it will change and changes nothing without a yes; it backs up each file first.

**Containers** (`Dockerfile`, `docker-compose.yml`)

- The base image is pinned by digest. The server runs as the unprivileged `node` user with no Linux capabilities, `no-new-privileges` and a read-only filesystem. The collector keeps only file access (`DAC_OVERRIDE`), with your folders mounted read-only.

## Supply chain

- The app has **no third-party packages**. `test/supply-chain.test.js` fails if a dependency, install script, lockfile or non-built-in import appears, and pins the hash of the one vendored file (`lib/vendor/qrcode.cjs`, MIT).
- Playwright for the browser checks is test-only, in `test/browser/` with its own lockfile, installed with `npm ci --ignore-scripts`, and its registry signatures are verified.
- CI (`.github/workflows/ci.yml`): no permissions by default and read-only per job, checkout without stored credentials, every action pinned to a full commit SHA, every tool pinned to a version, and downloaded binaries checked against a recorded SHA-256. It runs actionlint and zizmor on the workflows, hadolint, shellcheck, gitleaks over the full history, the tests on the oldest supported and current Node, the browser checks (which fail on any Content-Security-Policy violation), and a grype scan of the image. The image scan and the workflow audit also run weekly on a schedule.
- Dependabot keeps the pinned actions, the base image and the test tooling current, and waits seven days before adopting a new release.
- CodeQL, dependency review and OpenSSF Scorecard are ready in the workflow but commented out: they need GitHub Advanced Security, which private repositories on the Free plan do not have.

## Keeping private information out of this repository

Commit messages, pull request text and issues are as permanent as the code. The rules for what never goes in them are in [`AGENTS.md`](AGENTS.md) and apply to people and agents alike. If you find private information already published here, report it privately as above.
