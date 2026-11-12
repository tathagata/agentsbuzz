// agentsbuzz runs with no third-party packages at all, so there is no dependency tree to compromise.
// These checks keep it that way: adding a dependency has to be a deliberate change to this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);

// The one piece of outside code, copied in and reviewed. Changing it means updating this hash on purpose.
const VENDORED = {
  'lib/vendor/qrcode.cjs': '18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780', // qrcode-generator, MIT, Kazuhiko Arase
};

test('package.json declares no dependencies and no install scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
    assert.equal(pkg[k], undefined, `package.json has ${k}`);
  }
  for (const k of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) assert.equal(pkg.scripts?.[k], undefined, `package.json has a ${k} script`);
  assert.equal(pkg.private, true, 'stays unpublishable by accident');
});

// The browser checks use Playwright, as test-only tooling with its own lockfile. Nothing else may have one.
const TEST_TOOLING = new Set(['test/browser/package.json', 'test/browser/package-lock.json']);

test('no lockfile or vendored node_modules is committed, apart from the test-only browser tooling', () => {
  for (const f of tracked.filter((x) => !TEST_TOOLING.has(x))) {
    assert.doesNotMatch(f, /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/, f);
    assert.doesNotMatch(f, /(^|\/)node_modules\//, f);
    if (f !== 'package.json') assert.doesNotMatch(f, /(^|\/)package\.json$/, `${f}: only the app and test/browser have a package.json`);
  }
  const tooling = JSON.parse(fs.readFileSync(path.join(root, 'test/browser/package.json'), 'utf8'));
  assert.deepEqual(Object.keys(tooling.devDependencies), ['playwright']);
  assert.match(tooling.devDependencies.playwright, /^\d+\.\d+\.\d+$/, 'an exact version');
  assert.equal(tooling.dependencies, undefined);
});

test('every import in the app is a Node built-in or a file in this repository', () => {
  const code = tracked.filter((f) => /\.(m?js|cjs)$/.test(f) && !f.startsWith('test/') && !VENDORED[f]);
  assert.ok(code.length > 10);
  const spec = /(?:^|[^.\w])(?:import\s[^'"]*?from\s*|import\s*\(\s*|import\s+|require\s*\(\s*|export\s[^'"]*?from\s*)['"]([^'"]+)['"]/gm;
  for (const f of code) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const [, s] of src.matchAll(spec)) {
      // web/ files are served from this origin, so absolute paths there are local too
      const local = s.startsWith('./') || s.startsWith('../') || (f.startsWith('web/') && s.startsWith('/'));
      assert.ok(s.startsWith('node:') || local, `${f} imports "${s}"`);
    }
  }
});

test('the web app loads nothing from another origin', () => {
  for (const f of tracked.filter((x) => x.startsWith('web/'))) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(src, /<(script|link|img|iframe)[^>]+(src|href)=["']?(https?:)?\/\//i, f);
    assert.doesNotMatch(src, /@import\s+(url\()?["']?(https?:)?\/\//i, f);
  }
});

test('vendored code is exactly what was reviewed', () => {
  for (const f of tracked.filter((x) => x.includes('/vendor/'))) assert.ok(VENDORED[f], `${f} is vendored but not listed here`);
  for (const [f, sha] of Object.entries(VENDORED)) {
    const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex');
    assert.equal(got, sha, `${f} changed`);
  }
});
