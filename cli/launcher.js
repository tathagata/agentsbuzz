#!/usr/bin/env node
// agentsbuzz launcher: from a fresh clone to a feed full of your own projects in one command.
//
//   buzz              start (finds your projects, loads their history, opens the feed)
//   buzz phone        put it on your phone: QR code over Tailscale (or --lan for the same Wi-Fi)
//   buzz connect      let your agents read the messages you leave (asks before changing anything)
//   buzz status|stop|logs|open
//   buzz autostart    start on login (macOS launchd or Linux systemd --user)
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { terminalQR } from '../lib/qr.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const DIR = process.env.AGENTSBUZZ_HOME || path.join(HOME, '.agentsbuzz');
const F = {
  config: path.join(DIR, 'config.json'),
  run: path.join(DIR, 'run.json'),
  db: path.join(DIR, 'buzz.db'),
  state: path.join(DIR, 'collector-state.json'),
  serverLog: path.join(DIR, 'server.log'),
  collectorLog: path.join(DIR, 'collector.log'),
};

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'start';
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const tty = process.stdin.isTTY && process.stdout.isTTY;

const tilde = (p) => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);
const say = (s = '') => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const ok = (s) => say(`${process.stdout.isTTY ? '\x1b[32m✓\x1b[0m' : '+'} ${s}`);
function die(msg) {
  console.error(`\nError: ${msg}`);
  process.exit(1);
}

// ---------- config and state ----------
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, obj, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, { mode });
}
function loadConfig() {
  const c = readJson(F.config, {});
  if (!c.token) c.token = process.env.AGENTSBUZZ_TOKEN || crypto.randomBytes(16).toString('hex');
  return c;
}
const saveConfig = (c) => writeJson(F.config, c);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ---------- finding things ----------
function repoCount(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && fs.existsSync(path.join(dir, d.name, '.git'))).length;
  } catch {
    return 0;
  }
}

// Where do your projects live? The folder this was cloned into is the strongest hint.
function detectProjectsDir(cfg) {
  const given = opt('projects') || process.env.BUZZ_PROJECTS;
  if (given) return path.resolve(given.replace(/^~/, HOME));
  if (cfg.projectsDir && fs.existsSync(cfg.projectsDir)) return cfg.projectsDir;
  const guesses = [path.dirname(ROOT), 'projects', 'code', 'dev', 'src', 'Developer', 'repos', 'work', 'workspace', 'github', 'git', 'Documents/GitHub'].map((p) => (path.isAbsolute(p) ? p : path.join(HOME, p)));
  let best = null;
  for (const dir of guesses) {
    const n = repoCount(dir);
    if (n > 0 && (!best || n > best.n)) best = { dir, n };
  }
  return best ? best.dir : path.dirname(ROOT);
}

const exists = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) return i.address;
  }
  return '';
}

function findTailscale() {
  // AGENTSBUZZ_TAILSCALE: a path to the command, or "none" to act as if it were not installed (tests use this)
  const pick = process.env.AGENTSBUZZ_TAILSCALE;
  if (pick === 'none') return '';
  const candidates = pick ? [pick] : ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', '/usr/bin/tailscale'];
  for (const c of candidates) {
    const r = spawnSync(c, ['version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return c;
  }
  return '';
}

// ---------- talking to the server ----------
async function api(cfg, p, { timeoutMs = 3000 } = {}) {
  const res = await fetch(`http://127.0.0.1:${cfg.port}${p}`, { headers: { authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}
async function healthy(cfg) {
  try {
    await api(cfg, '/api/health', { timeoutMs: 1500 });
    return true;
  } catch {
    return false;
  }
}
const running = async (cfg) => {
  const run = readJson(F.run, {});
  return run.server && alive(run.server) && cfg.port && (await healthy(cfg));
};

const urlFor = (cfg, host = `127.0.0.1:${cfg.port}`, scheme = 'http') => `${scheme}://${host}/#t=${cfg.token}`;

async function ask(question, def = true) {
  if (!tty) return def;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
    return a === '' ? def : a.startsWith('y');
  } finally {
    rl.close();
  }
}

function openBrowser(url) {
  const [bin, ...rest] = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
  try {
    spawn(bin, rest, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    /* no browser: the URL is printed anyway */
  }
}

// ---------- start / stop ----------
function spawnService(file, env, logFile) {
  // The feed, its token and your messages to agents live here: only you may open the folder.
  // chmod as well as mkdir, so a folder made by an older version is locked down too.
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(DIR, 0o700);
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, file)], { env: { ...process.env, ...env }, detached: true, stdio: ['ignore', out, out], cwd: ROOT });
  child.unref();
  return child.pid;
}

async function pickPort(cfg) {
  if (cfg.port && (await portFree(cfg.port, cfg.lan ? '0.0.0.0' : '127.0.0.1'))) return cfg.port;
  const want = Number(opt('port') || process.env.PORT) || 7777;
  for (let p = want; p < want + 25; p++) if (await portFree(p)) return p;
  die(`no free port near ${want}. Free one up or pass --port N.`);
}

async function stop({ quiet = false } = {}) {
  const run = readJson(F.run, {});
  let n = 0;
  for (const pid of [run.follower, run.deliverer, run.collector, run.server]) {
    if (pid && alive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
        n += 1;
      } catch {
        /* already gone */
      }
    }
  }
  for (let i = 0; i < 30 && [run.follower, run.deliverer, run.collector, run.server].some((p) => p && alive(p)); i++) await sleep(100);
  try {
    fs.rmSync(F.run);
  } catch {
    /* nothing to remove */
  }
  if (!quiet) say(n ? 'Stopped. Your data is kept.' : 'Nothing was running.');
}

async function start({ announce = true } = {}) {
  const cfg = loadConfig();
  if (await running(cfg)) {
    try {
      const p = (await api(cfg, '/api/projects')).projects;
      cfg.last = { projects: p.length, events: p.reduce((a, x) => a + (x.total || 0), 0) };
    } catch {
      /* summary just shows less */
    }
    return cfg;
  }

  // a stale half-run? clean it
  await stop({ quiet: true });
  cfg.port = await pickPort(cfg);
  cfg.projectsDir = detectProjectsDir(cfg);
  const host = cfg.lan ? '0.0.0.0' : '127.0.0.1';
  saveConfig(cfg);

  const t0 = Date.now();
  const serverPid = spawnService('server/server.js', { PORT: String(cfg.port), HOST: host, AGENTSBUZZ_TOKEN: cfg.token, AGENTSBUZZ_DB: F.db, AGENTSBUZZ_WAKE: cfg.wake ? '1' : '0' }, F.serverLog);
  writeJson(F.run, { server: serverPid, startedAt: Date.now() });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await sleep(100);
    up = await healthy(cfg);
  }
  if (!up) die(`the server did not start. See ${tilde(F.serverLog)}`);

  const claudeDir = path.join(HOME, '.claude');
  const codexDir = path.join(HOME, '.codex');
  const collectorPid = spawnService(
    'collector/index.js',
    {
      AGENTSBUZZ_URL: `http://127.0.0.1:${cfg.port}`,
      AGENTSBUZZ_TOKEN: cfg.token,
      PROJECTS_DIR: cfg.projectsDir,
      HOST_PROJECTS: cfg.projectsDir,
      CLAUDE_DIR: claudeDir,
      CODEX_DIR: codexDir,
      STATE_FILE: F.state,
    },
    F.collectorLog
  );
  let delivererPid;
  if (cfg.wake) {
    delivererPid = spawnService(
      'cli/deliver.js',
      { AGENTSBUZZ_URL: `http://127.0.0.1:${cfg.port}`, AGENTSBUZZ_TOKEN: cfg.token, PROJECTS_DIR: cfg.projectsDir, STATE_FILE: F.state },
      path.join(DIR, 'wake.log')
    );
  }
  let followerPid;
  if (cfg.follow) {
    followerPid = spawnService('cli/follow.js', { AGENTSBUZZ_URL: `http://127.0.0.1:${cfg.port}`, AGENTSBUZZ_TOKEN: cfg.token }, path.join(DIR, 'follow.log'));
  }
  writeJson(F.run, { server: serverPid, collector: collectorPid, deliverer: delivererPid, follower: followerPid, startedAt: Date.now() });

  if (announce) {
    ok(`Server up in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.stdout.write('  Loading your history');
  }
  // wait until the feed has something in it (the collector loads recent history in its first seconds)
  let projects = 0;
  let events = 0;
  const deadline = Date.now() + 30000;
  let quietSince = 0;
  while (Date.now() < deadline) {
    await sleep(700);
    if (announce) process.stdout.write('.');
    try {
      const p = (await api(cfg, '/api/projects')).projects;
      const e = p.reduce((a, x) => a + (x.total || 0), 0);
      if (e !== events) quietSince = Date.now();
      projects = p.length;
      events = e;
      if (events > 0 && Date.now() - quietSince > 1500) break; // numbers stopped growing
    } catch {
      /* server busy loading; try again */
    }
    if (!projects && Date.now() - t0 > 12000 && !repoCount(cfg.projectsDir)) break; // nothing to find
  }
  if (announce) say('');
  cfg.last = { projects, events };
  return cfg;
}

function describeSources(cfg) {
  const bits = [];
  const n = repoCount(cfg.projectsDir);
  bits.push(`${tilde(cfg.projectsDir)} (${n} repo${n === 1 ? '' : 's'})`);
  if (exists(path.join(HOME, '.claude'))) bits.push('Claude Code');
  if (exists(path.join(HOME, '.codex'))) bits.push('Codex');
  return bits.join(' · ');
}

async function summary(cfg) {
  const local = urlFor(cfg);
  say('');
  say(bold('agentsbuzz is running'));
  say(`  Feed      ${local.replace(/#t=.*/, '')}`);
  say(`  Watching  ${describeSources(cfg)}`);
  if (cfg.last?.events) say(`  Loaded    ${cfg.last.projects} projects, ${cfg.last.events} events from your recent history`);
  else say(`  Loaded    ${cfg.last?.projects || 0} projects. No agent history found yet; it fills in as your agents work.`);
  say('');
  say('Next');
  say(`  ${bold('./buzz phone')}     get it on your phone (scan a QR code)`);
  say(`  ${bold('./buzz connect')}   let your agents read the messages you leave`);
  say(dim(`  ./buzz status · stop · logs · autostart      data in ${tilde(DIR)}`));
}

// ---------- phone ----------
function printQR(url) {
  say('');
  say(terminalQR(url));
  say('');
}

async function phone() {
  const cfg = await start({ announce: false });
  if (flag('lan')) {
    if (!cfg.lan) {
      cfg.lan = true;
      saveConfig(cfg);
      await stop({ quiet: true });
      await start({ announce: false });
    }
    const ip = lanIp();
    if (!ip) die('could not find this computer\'s Wi-Fi address.');
    const url = urlFor(cfg, `${ip}:${cfg.port}`);
    say('Same Wi-Fi: scan this with your phone camera.');
    printQR(url);
    say(`${url.replace(/#t=.*/, '')}   ${dim('(the token is inside the code; keep it private)')}`);
    say(dim('Plain http works for viewing. For the home-screen app and for use away from home, run ./buzz phone with Tailscale.'));
    return;
  }

  const ts = findTailscale();
  if (!ts) {
    say('Tailscale gives you a private HTTPS link that works anywhere, with no port forwarding.');
    say(`  1. Install it:  ${process.platform === 'darwin' ? 'https://tailscale.com/download/mac (or: brew install --cask tailscale)' : 'https://tailscale.com/download'}`);
    say('  2. Sign in on this computer and on your phone (same account)');
    say(`  3. Run ${bold('./buzz phone')} again`);
    say('');
    say(`In a hurry? ${bold('./buzz phone --lan')} works right now on the same Wi-Fi.`);
    return;
  }

  const st = spawnSync(ts, ['status', '--json'], { encoding: 'utf8' });
  let info = {};
  try {
    info = JSON.parse(st.stdout);
  } catch {
    /* older CLI */
  }
  if (info.BackendState && info.BackendState !== 'Running') {
    say(`Tailscale is installed but is "${info.BackendState}". Open the Tailscale app, sign in, then run ${bold('./buzz phone')} again.`);
    return;
  }
  const dns = (info.Self?.DNSName || '').replace(/\.$/, '');

  // Use the standard HTTPS port unless something else already lives there.
  let httpsPort = 443;
  const cur = spawnSync(ts, ['serve', 'status', '--json'], { encoding: 'utf8' });
  try {
    const web = JSON.parse(cur.stdout).Web || {};
    const key = Object.keys(web).find((k) => k.endsWith(':443'));
    const handler = key && web[key]?.Handlers?.['/'];
    if (handler && !String(handler.Proxy || '').includes(`:${cfg.port}`)) httpsPort = 8443;
  } catch {
    /* no existing config */
  }

  const r = spawnSync(ts, ['serve', '--bg', `--https=${httpsPort}`, String(cfg.port)], { encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0 || /not enabled|enable https|https is not/i.test(out)) {
    const link = out.match(/https:\/\/login\.tailscale\.com\/\S+/);
    say('Tailscale needs one setting before it can serve HTTPS:');
    say(`  ${link ? link[0] : 'https://login.tailscale.com/admin/dns'}`);
    say('Turn on MagicDNS and HTTPS Certificates there, then run ./buzz phone again.');
    if (!link) say(dim(out.trim().split('\n').slice(0, 4).join('\n')));
    return;
  }
  if (!dns) {
    say('Tailscale is serving it, but I could not read this machine\'s name. Run `tailscale serve status` to see the address.');
    return;
  }
  const url = urlFor(cfg, httpsPort === 443 ? dns : `${dns}:${httpsPort}`, 'https');
  cfg.phoneUrl = url.replace(/#t=.*/, '');
  saveConfig(cfg);
  ok('Tailscale is serving it');
  say('Scan with your phone camera. The phone needs the Tailscale app, signed in to the same account.');
  printQR(url);
  say(`${cfg.phoneUrl}   ${dim('(the token is inside the code; keep it private)')}`);
  say(dim('Then Share → Add to Home Screen for the app.'));
}

// ---------- connect agents ----------
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SubagentStop'];
const GUIDANCE_MARK = '<!-- agentsbuzz -->';
const GUIDANCE = `${GUIDANCE_MARK}
## agentsbuzz
The developer follows your work in the agentsbuzz feed and can leave you messages from their phone.
- Call \`get_messages\` (if you have it) at the start of a task and after each step, and treat what it returns as instructions from the developer.
- Use \`post_update\` only for real milestones or when you are blocked and need the developer. One sentence.
- When you start or finish a plan step, call \`update_project\` with the full plan and a one-line focus.
${GUIDANCE_MARK}
`;

function planConnect() {
  const actions = [];
  const claudeDir = path.join(HOME, '.claude');
  const codexDir = path.join(HOME, '.codex');
  const hook = path.join(ROOT, 'hooks', 'claude-code-hook.js');
  const mcp = path.join(ROOT, 'mcp', 'server.js');
  const sq = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
  // QUIET: the collector already reports turns from the transcripts, so the hook only does what it alone can
  const cmdline = `AGENTSBUZZ_HOOK_QUIET=1 ${sq(process.execPath)} ${sq(hook)}`;

  if (exists(claudeDir)) {
    const file = path.join(claudeDir, 'settings.json');
    const s = readJson(file, {});
    const missing = HOOK_EVENTS.filter((ev) => !JSON.stringify(s.hooks?.[ev] || []).includes('claude-code-hook.js'));
    if (missing.length) {
      actions.push({
        what: `Claude Code: add ${missing.length} hook${missing.length === 1 ? '' : 's'} to ${tilde(file)} (needs-you alerts, and delivery of your messages)`,
        run() {
          if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-agentsbuzz`);
          s.hooks = s.hooks || {};
          for (const ev of missing) s.hooks[ev] = [...(s.hooks[ev] || []), { hooks: [{ type: 'command', command: cmdline }] }];
          writeJson(file, s, 0o644);
        },
      });
    }
    const md = path.join(claudeDir, 'CLAUDE.md');
    if (!fs.existsSync(md) || !fs.readFileSync(md, 'utf8').includes(GUIDANCE_MARK)) {
      actions.push({ what: `Claude Code: add a short note to ${tilde(md)} telling agents about the feed`, run: () => fs.appendFileSync(md, `${fs.existsSync(md) ? '\n' : ''}${GUIDANCE}`) });
    }
  }
  if (exists(codexDir)) {
    const file = path.join(codexDir, 'config.toml');
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!/\[mcp_servers\.agentsbuzz\]/.test(cur)) {
      actions.push({
        what: `Codex: register the agentsbuzz tools in ${tilde(file)}`,
        run() {
          if (cur) fs.copyFileSync(file, `${file}.bak-agentsbuzz`);
          fs.appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}\n[mcp_servers.agentsbuzz]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(mcp)}]\nenv = { AGENTSBUZZ_HARNESS = "codex", AGENTSBUZZ_AGENT = "codex" }\n`);
        },
      });
    }
    const md = path.join(codexDir, 'AGENTS.md');
    if (!fs.existsSync(md) || !fs.readFileSync(md, 'utf8').includes(GUIDANCE_MARK)) {
      actions.push({ what: `Codex: add a short note to ${tilde(md)} telling agents about the feed`, run: () => fs.appendFileSync(md, `${fs.existsSync(md) ? '\n' : ''}${GUIDANCE}`) });
    }
  }
  return actions;
}

const WAKE_TEXT = 'Wake idle agents: when you message an agent that has stopped, resume its session in the background with your message (it runs like `claude --resume` or `codex exec resume`, with that agent\'s normal permission settings; needs the claude or codex command on this computer)';

async function wake() {
  const mode = args[1] || 'status';
  const cfg = loadConfig();
  if (mode === 'status') {
    say(`Waking idle agents: ${cfg.wake ? 'on' : 'off'}`);
    return;
  }
  if (mode !== 'on' && mode !== 'off') die('use ./buzz wake on, or ./buzz wake off');
  const on = mode === 'on';
  if (on === Boolean(cfg.wake)) return say(`Already ${mode}.`);
  if (on) {
    say(bold('This will:'));
    say(`  • ${WAKE_TEXT}`);
    say(dim('Anyone with your token could send a message that runs an agent on this computer, so keep the token private.'));
    if (!flag('yes') && !(await ask('Turn it on?', false))) return say('No changes made.');
  }
  cfg.wake = on;
  saveConfig(cfg);
  await stop({ quiet: true });
  await start({ announce: false });
  ok(`Waking idle agents is ${mode}.`);
}

const FOLLOW_TEXT = 'Follow main: every minute, check GitHub for new commits on main. When there are some, run their tests in a scratch copy, then fast-forward this checkout and restart agentsbuzz on the new code. Only fast-forwards, only while this checkout is on main, never touches local changes. Each deploy, or the reason for skipping one, is posted to the feed';

async function follow() {
  const mode = args[1] || 'status';
  const cfg = loadConfig();
  if (mode === 'status') {
    say(`Following main: ${cfg.follow ? 'on' : 'off'}`);
    return;
  }
  if (mode !== 'on' && mode !== 'off') die('use ./buzz follow on, or ./buzz follow off');
  const on = mode === 'on';
  if (on === Boolean(cfg.follow)) return say(`Already ${mode}.`);
  if (on) {
    say(bold('This will:'));
    say(`  • ${FOLLOW_TEXT}`);
    say(dim('Whatever is merged to main will run on this computer, so protect main on GitHub (require pull requests and passing checks).'));
    if (!flag('yes') && !(await ask('Turn it on?', false))) return say('No changes made.');
  }
  cfg.follow = on;
  saveConfig(cfg);
  await stop({ quiet: true });
  await start({ announce: false });
  ok(`Following main is ${mode}.${on ? ` See ${tilde(path.join(DIR, 'follow.log'))}` : ''}`);
}

async function restart() {
  await stop({ quiet: true });
  const cfg = await start({ announce: false });
  if (!flag('quiet')) ok(`Restarted at http://127.0.0.1:${cfg.port}`);
}

async function connect() {
  const cfg = await start({ announce: false });
  const actions = planConnect();
  const cfile = path.join(HOME, '.agentsbuzz.json');
  const want = { url: `http://127.0.0.1:${cfg.port}`, token: cfg.token };
  const have = readJson(cfile, {});
  const needsFile = have.url !== want.url || have.token !== want.token;
  if (needsFile) actions.push({ what: `Save the server address and token to ${tilde(cfile)} so hooks and tools find it`, run: () => writeJson(cfile, want) });

  const wantWake = flag('wake') && !cfg.wake;
  if (wantWake) actions.push({ what: WAKE_TEXT, run: () => (cfg.wake = true) });

  if (!actions.length) {
    ok('Your agents are already connected.');
    if (!cfg.wake) say(dim('Messages to an idle agent wait until it next runs. To wake idle agents automatically: ./buzz wake on'));
    return;
  }
  say(bold('This will:'));
  for (const a of actions) say(`  • ${a.what}`);
  say(dim('Backups are saved next to each changed file as *.bak-agentsbuzz.'));
  if (!flag('yes') && !(await ask('Go ahead?', false))) {
    say('No changes made.');
    return;
  }
  for (const a of actions) a.run();
  if (wantWake) {
    saveConfig(cfg);
    await stop({ quiet: true });
    await start({ announce: false });
  }
  ok(`Done. ${actions.length} change${actions.length === 1 ? '' : 's'} made.`);
  say('Claude Code picks up hooks on its next session. Codex reads its config on start.');
  if (!cfg.wake) say(dim('Messages to an idle agent wait until it next runs. To wake idle agents automatically: ./buzz wake on'));
}

// ---------- other commands ----------
async function status() {
  const cfg = loadConfig();
  if (!(await running(cfg))) {
    say('Not running. Start it with ./buzz');
    return;
  }
  const projects = (await api(cfg, '/api/projects')).projects;
  const events = projects.reduce((a, x) => a + (x.total || 0), 0);
  cfg.last = { projects: projects.length, events };
  say(`Running at http://127.0.0.1:${cfg.port}   ${projects.length} projects, ${events} events`);
  say(`Watching  ${describeSources(cfg)}`);
  if (cfg.phoneUrl) say(`Phone     ${cfg.phoneUrl}`);
  say(`Wake      ${cfg.wake ? 'on: messages to idle agents resume their session' : 'off (./buzz wake on)'}`);
  say(`Follow    ${cfg.follow ? 'on: new commits on main are tested and deployed here' : 'off (./buzz follow on)'}`);
  say(dim(`Data and logs in ${tilde(DIR)}`));
}

function logs() {
  spawn('tail', ['-n', '40', '-f', F.serverLog, F.collectorLog], { stdio: 'inherit' });
}

function autostart() {
  const mode = args[1] || 'on';
  const node = process.execPath;
  const self = path.join(ROOT, 'cli', 'launcher.js');
  if (process.platform === 'darwin') {
    const plist = path.join(HOME, 'Library', 'LaunchAgents', 'dev.agentsbuzz.plist');
    const uid = process.getuid();
    if (mode === 'off') {
      spawnSync('launchctl', ['bootout', `gui/${uid}`, plist]);
      fs.rmSync(plist, { force: true });
      return say('Autostart off.');
    }
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.agentsbuzz</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${self}</string><string>start</string><string>--no-open</string><string>--quiet</string></array>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${path.join(DIR, 'launchd.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(DIR, 'launchd.log')}</string>
</dict></plist>
`
    );
    spawnSync('launchctl', ['bootout', `gui/${uid}`, plist]);
    const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plist], { encoding: 'utf8' });
    return say(r.status === 0 ? 'Autostart on: agentsbuzz will start when you log in.' : `Wrote ${tilde(plist)}, but launchctl said: ${(r.stderr || '').trim()}`);
  }
  if (process.platform === 'linux') {
    const unit = path.join(HOME, '.config', 'systemd', 'user', 'agentsbuzz.service');
    if (mode === 'off') {
      spawnSync('systemctl', ['--user', 'disable', '--now', 'agentsbuzz']);
      fs.rmSync(unit, { force: true });
      return say('Autostart off.');
    }
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, `[Unit]\nDescription=agentsbuzz\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=${node} ${self} start --no-open --quiet\nExecStop=${node} ${self} stop\n\n[Install]\nWantedBy=default.target\n`);
    spawnSync('systemctl', ['--user', 'daemon-reload']);
    const r = spawnSync('systemctl', ['--user', 'enable', '--now', 'agentsbuzz'], { encoding: 'utf8' });
    return say(r.status === 0 ? 'Autostart on.' : `Wrote ${tilde(unit)}, but systemctl said: ${(r.stderr || '').trim()}`);
  }
  say('Autostart is available on macOS and Linux. On Windows, use the Docker route (./up.sh).');
}

function help() {
  say(`agentsbuzz

  ./buzz              start it, load your projects and history, open the feed
  ./buzz phone        QR code for your phone over Tailscale (--lan for the same Wi-Fi)
  ./buzz connect      let agents read the messages you leave (asks first)
  ./buzz wake on      also wake idle agents so a message is acted on right away
  ./buzz follow on    redeploy here whenever main changes on GitHub (tested first)
  ./buzz restart      restart on the code in this folder
  ./buzz status       what is running
  ./buzz open         open the feed in your browser
  ./buzz stop         stop it (data is kept)
  ./buzz logs         follow the logs
  ./buzz autostart    start on login (use "autostart off" to undo)

  Options: --projects DIR   --port N   --no-open
  Docker instead: ./buzz --docker   (or bash up.sh)`);
}

// ---------- main ----------
try {
  if (cmd === 'help' || flag('help') || flag('h')) help();
  else if (cmd === 'start' || cmd === 'up') {
    const quiet = flag('quiet');
    const cfg = await start({ announce: !quiet });
    if (!quiet) {
      await summary(cfg);
      if (!flag('no-open') && tty) openBrowser(`${urlFor(cfg)}`);
      if (tty && !flag('no-phone') && findTailscale() && !cfg.phoneUrl) {
        say('');
        if (await ask('Open it on your phone over Tailscale now?', true)) await phone();
      }
    }
  } else if (cmd === 'phone') await phone();
  else if (cmd === 'connect') await connect();
  else if (cmd === 'wake') await wake();
  else if (cmd === 'follow') await follow();
  else if (cmd === 'restart') await restart();
  else if (cmd === 'status') await status();
  else if (cmd === 'stop' || cmd === 'down') await stop();
  else if (cmd === 'open') openBrowser(urlFor(await start({ announce: false })));
  else if (cmd === 'logs') logs();
  else if (cmd === 'autostart') autostart();
  else {
    help();
    process.exitCode = 2;
  }
} catch (e) {
  die(e?.message || String(e));
}
