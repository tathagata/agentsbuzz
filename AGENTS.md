# Working on agentsbuzz

Rules for anyone changing this repository, people and coding agents alike.

## Security rules for changes

agentsbuzz can run a coding agent when a message arrives, so treat these as hard rules. `SECURITY.md` explains why each exists.

- **No dependencies.** The app uses Node built-ins only. Do not add packages, lockfiles or install scripts; `test/supply-chain.test.js` will fail. Test-only tooling lives in `test/browser/` with its own lockfile.
- **No HTML from data.** Build the DOM with `textContent`, `createElement` and the `h()` helper. Never `innerHTML`, `insertAdjacentHTML` or `document.write`, and never `setAttribute('style', …)` (use the `style` prop, which goes through the CSSOM, so the Content-Security-Policy needs no `'unsafe-inline'`). Load nothing from another origin.
- **No shells.** Run programs with `spawn`/`execFile` and an argument list, never `shell: true` or `exec`. Anything from the API that lands on a command line must be validated first (see `safeSessionId` and `projectDir` in `cli/deliver.js`).
- **Auth stays on.** Every `/api` route goes through `authed()`. Do not add routes that take the token in the URL, and do not log it.
- **Git reads stay read-only.** Use `git()` from `lib/discover.js`, which switches off everything that could run a repository's own programs.
- **CI pins stay pinned.** Actions by full commit SHA with the tag in a comment, tools by exact version, downloads by SHA-256. Resolve an annotated tag to its commit, not to the tag object. New jobs get `permissions:` explicitly and `persist-credentials: false` on checkout. Run actionlint and zizmor before pushing a workflow change.
- Add a test to `test/security.test.js` for any new security property, named after the attack it stops.

## Keeping private information out

Commit messages, pull request descriptions and issues are as permanent as the code. They must not contain:

- **Agent session links or ids** from real sessions.
- **Other private repositories:** do not name, link or describe them. Say "another project" or use an invented fixture.
- **Personal contact details:** no email addresses or phone numbers.
- **Local machine details:** no absolute paths with a username or home folder, hostnames, Tailscale names or internal URLs. Use repository-relative paths.
- **Credentials or real identifiers:** no tokens or keys. Test values must be obviously fake (`test-not-a-real-token`). Use `example.com`, `example.invalid` and `127.0.0.1`.

Before committing, read the full diff and the commit message for the items above. If unsure whether something is private, leave it out and say so.

## Checks before a pull request

```sh
npm test                                                     # includes the security and supply-chain tests
(cd test/browser && npm ci --ignore-scripts && npx playwright install chromium)
NODE_PATH=test/browser/node_modules node test/ui.mjs         # fails on any CSP violation
NODE_PATH=test/browser/node_modules node test/smooth.mjs
```
