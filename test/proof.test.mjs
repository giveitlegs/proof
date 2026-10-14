import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectCheck, codePath, looksFailed, suggestChecks } from '../scripts/proof.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'proof.mjs');

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function project(files = {}) {
  const root = tmp('proof-project-');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

function session(root) {
  const data = tmp('proof-data-');
  const env = { ...process.env, PROOF_DATA_DIR: data, CLAUDE_PROJECT_DIR: root };
  delete env.PROOF_DISABLED;
  const hook = (mode, input) => {
    const r = spawnSync(process.execPath, [SCRIPT, mode], {
      input: JSON.stringify({ session_id: 's1', cwd: root, ...input }), env, encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env, cwd: root, encoding: 'utf8' }).stdout;
  return {
    edit: (file) => hook('edit', { tool_name: 'Edit', tool_input: { file_path: path.join(root, file) } }),
    ran: (command, stdout = '') => hook('ran', { tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '' } }),
    failed: (command) => hook('failed', { tool_name: 'Bash', tool_input: { command }, error: 'Exit code 1' }),
    stop: () => hook('stop', { stop_hook_active: false }),
    cli,
  };
}

const NODE_PROJECT = {
  'package.json': JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc --noEmit', lint: 'eslint .' } }),
  'pnpm-lock.yaml': '',
};

// ---------------------------------------------------------------- detection

test('recognizes checks across ecosystems', () => {
  for (const cmd of [
    'npm test', 'pnpm test', 'yarn test', 'bun run test', 'pnpm -F web build', 'pnpm --filter=api run typecheck',
    'npm run test:unit', 'npx tsc --noEmit', 'npx vitest run src', 'pnpm exec eslint .', 'node --test',
    'pytest -q', 'python -m pytest tests/', 'uv run pytest', 'poetry run mypy .', 'ruff check .',
    'cargo test', 'cargo +nightly clippy', 'go test ./...', 'go vet ./...', 'make test', 'just check',
    './gradlew test', 'mvn -q verify', 'dotnet test', 'bundle exec rspec', 'mix test', 'swift test',
    'deno test', 'bun test', './scripts/check.sh', 'bash scripts/test.sh',
    'cd apps/web && pnpm test', 'CI=1 npm test', 'timeout 300 pytest', 'pytest -x 2>&1 | tail -20',
  ]) assert.ok(detectCheck(cmd), `should detect: ${cmd}`);
});

test('ignores commands that verify nothing', () => {
  for (const cmd of [
    'ls -la', 'git status', 'git checkout test-branch', 'cat test/foo.ts', 'npm install', 'pnpm add -D vitest',
    'grep -r pytest .', 'echo "run the tests"', 'cd test', 'npm test --help', 'node scripts/build-data.js',
    'mkdir tests', 'rm -rf dist', 'git log --grep test',
  ]) assert.equal(detectCheck(cmd), null, `should ignore: ${cmd}`);
});

test('honors custom checks from config', () => {
  assert.ok(detectCheck('./bin/smoke --all', ['./bin/smoke']));
  assert.equal(detectCheck('./bin/smoke --all'), null);
});

test('reads failure from piped output', () => {
  assert.ok(looksFailed('Tests: 2 failed, 40 passed'));
  assert.ok(looksFailed('FAILED tests/test_api.py::test_x'));
  assert.ok(looksFailed('src/a.ts(3,1): error TS2322: nope'));
  assert.ok(looksFailed('--- FAIL: TestThing'));
  assert.ok(looksFailed('TAP version 13\nnot ok 1 - add\n# pass 0\n# fail 1'));
  assert.ok(looksFailed("Error: Cannot find module '/demo/test'"));
  assert.ok(!looksFailed('ok 1 - add\n# pass 1\n# fail 0'));
  assert.ok(!looksFailed('Tests: 0 failed, 40 passed'));
  assert.ok(!looksFailed('42 passed in 1.2s'));
});

test('only code inside the project demands proof', () => {
  const root = '/repo';
  assert.equal(codePath(root, '/repo/src/a.ts'), 'src/a.ts');
  assert.equal(codePath(root, 'src/a.ts'), 'src/a.ts');
  assert.equal(codePath(root, '/repo/README.md'), null);
  assert.equal(codePath(root, '/repo/docs/guide.mdx'), null);
  assert.equal(codePath(root, '/repo/LICENSE'), null);
  assert.equal(codePath(root, '/repo/.claude/settings.json'), null);
  assert.equal(codePath(root, '/tmp/scratch.py'), null);
  assert.equal(codePath(root, '/repo/content/post.json', ['content/**']), null);
  assert.equal(codePath(root, '/repo/src/x.gen.ts', ['**/*.gen.ts']), null);
});

test('suggests the project\'s own checks', () => {
  assert.deepEqual(suggestChecks(project(NODE_PROJECT)), ['pnpm test', 'pnpm run typecheck', 'pnpm run lint']);
  assert.deepEqual(suggestChecks(project({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })), []);
  assert.deepEqual(suggestChecks(project({ 'Cargo.toml': '' })), ['cargo test']);
  assert.deepEqual(suggestChecks(project({ 'go.mod': '' })), ['go test ./...']);
  assert.deepEqual(suggestChecks(project({ 'pyproject.toml': '', 'uv.lock': '', 'tests/test_a.py': '' })), ['uv run pytest']);
  assert.deepEqual(suggestChecks(project({ 'Makefile': 'build:\n\tcc\ntest:\n\t./t\n' })), ['make test']);
  assert.deepEqual(suggestChecks(project({})), []);
});

// ---------------------------------------------------------------- the stop gate, end to end

test('read-only session: never blocks', () => {
  const s = session(project(NODE_PROJECT));
  s.ran('git status');
  assert.equal(s.stop(), null);
});

test('edit without a check: blocks once, naming files and commands', () => {
  const s = session(project(NODE_PROJECT));
  s.edit('src/auth.ts');
  const out = s.stop();
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /1 file changed/);
  assert.match(out.reason, /src\/auth\.ts/);
  assert.match(out.reason, /`pnpm test`/);
  assert.equal(s.stop(), null, 'second stop with nothing changed is let through');
});

test('edit then passing check: done', () => {
  const s = session(project(NODE_PROJECT));
  s.edit('src/auth.ts');
  s.ran('pnpm test');
  assert.equal(s.stop(), null);
});

test('check then another edit: unverified again', () => {
  const s = session(project(NODE_PROJECT));
  s.edit('src/a.ts');
  s.ran('pnpm test');
  s.edit('src/b.ts');
  const out = s.stop();
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /src\/b\.ts/);
  assert.doesNotMatch(out.reason, /src\/a\.ts/);
});

test('failing check: says it failed; passing re-run clears it', () => {
  const s = session(project(NODE_PROJECT));
  s.edit('src/a.ts');
  s.failed('pnpm test');
  assert.match(s.stop().reason, /`pnpm test` failed/);
  s.edit('src/a.ts');
  s.ran('pnpm test');
  assert.equal(s.stop(), null);
});

test('piped check that hides a failure is not a pass', () => {
  const s = session(project(NODE_PROJECT));
  s.edit('src/a.ts');
  s.ran('pnpm test 2>&1 | tail -5', 'Tests: 3 failed, 10 passed');
  assert.match(s.stop().reason, /failed/);
});

test('docs-only edits never block', () => {
  const s = session(project(NODE_PROJECT));
  s.edit('README.md');
  s.edit('docs/setup.md');
  assert.equal(s.stop(), null);
});

test('project with no known checks stays quiet', () => {
  const s = session(project({}));
  s.edit('main.c');
  assert.equal(s.stop(), null);
});

test('checks from .claude/proof.json make any project provable', () => {
  const s = session(project({ '.claude/proof.json': JSON.stringify({ checks: ['./bin/smoke'] }) }));
  s.edit('main.c');
  assert.match(s.stop().reason, /`\.\/bin\/smoke`/);
  s.edit('main.c');
  s.ran('./bin/smoke --fast');
  assert.equal(s.stop(), null);
});

test('/proof status, off and on', () => {
  const s = session(project(NODE_PROJECT));
  assert.match(s.cli('status'), /Nothing to prove yet/);
  assert.match(s.cli(), /Nothing to prove yet/, 'bare /proof means status');
  s.edit('src/a.ts');
  assert.match(s.cli('status'), /◐ Unverified — 1 file changed/);
  s.ran('pnpm test 2>&1');
  assert.match(s.cli('status'), /● Verified — `pnpm test` passed/);
  s.edit('src/a.ts');
  assert.match(s.cli('off'), /off/);
  assert.equal(s.stop(), null);
  assert.match(s.cli('status'), /Off for this project/);
  s.cli('on');
  assert.equal(s.stop().decision, 'block');
});

test('garbage input never breaks the session', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'stop'], { input: 'not json', encoding: 'utf8', env: { ...process.env, PROOF_DATA_DIR: tmp('proof-data-') } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
