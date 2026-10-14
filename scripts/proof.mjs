#!/usr/bin/env node
// Proof — Claude can't call it done until the checks have run.
//
// One zero-dependency script behind every hook and the /proof command:
//   proof.mjs edit      PostToolUse  (Edit|Write|MultiEdit|NotebookEdit)
//   proof.mjs ran       PostToolUse  (Bash)
//   proof.mjs failed    PostToolUseFailure (Bash)
//   proof.mjs stop      Stop
//   proof.mjs status | on | off      (/proof)
//
// Contract: never break the session. Any internal error exits 0 silently.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MAX_LISTED_FILES = 3;
const STALE_MS = 14 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- state

function dataRoot() {
  return process.env.PROOF_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'claude-proof');
}

function projectDir(root) {
  const id = crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 16);
  return path.join(dataRoot(), id);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function safeId(id) {
  return String(id || 'default').replace(/[^\w.-]/g, '_').slice(0, 80);
}

function sessionFile(root, sessionId) {
  return path.join(projectDir(root), `session-${safeId(sessionId)}.json`);
}

function emptyState(root, sessionId) {
  return { v: 1, root: path.resolve(root), session: sessionId, seq: 0, edits: {}, lastPass: null, lastRun: null, blocked: [], updatedAt: 0 };
}

function loadState(root, sessionId) {
  return readJson(sessionFile(root, sessionId), null) || emptyState(root, sessionId);
}

function saveState(state) {
  state.updatedAt = Date.now();
  writeJson(sessionFile(state.root, state.session), state);
  prune(state.root);
}

function prune(root) {
  const dir = projectDir(root);
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('session-')) continue;
      const file = path.join(dir, name);
      if (Date.now() - fs.statSync(file).mtimeMs > STALE_MS) fs.rmSync(file, { force: true });
    }
  } catch { /* best effort */ }
}

function latestState(root) {
  const dir = projectDir(root);
  let best = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('session-')) continue;
      const s = readJson(path.join(dir, name), null);
      if (s && (!best || s.updatedAt > best.updatedAt)) best = s;
    }
  } catch { /* none yet */ }
  return best;
}

// ---------------------------------------------------------------- config

function loadConfig(root) {
  const user = readJson(path.join(root, '.claude', 'proof.json'), {});
  const local = readJson(path.join(projectDir(root), 'settings.json'), {});
  return {
    enabled: local.enabled ?? user.enabled ?? true,
    checks: Array.isArray(user.checks) ? user.checks.filter((c) => typeof c === 'string' && c.trim()) : [],
    ignore: Array.isArray(user.ignore) ? user.ignore.filter((g) => typeof g === 'string') : [],
  };
}

function setEnabled(root, enabled) {
  const file = path.join(projectDir(root), 'settings.json');
  writeJson(file, { ...readJson(file, {}), enabled });
}

// ---------------------------------------------------------------- what counts as code

const DOC_EXT = /\.(md|mdx|markdown|txt|rst|adoc|org|png|jpe?g|gif|webp|avif|ico|svg|pdf|mp4|mov|webm|mp3|wav)$/i;
const DOC_NAMES = /^(license|licence|notice|authors|contributors|changelog|codeowners|\.gitignore|\.gitattributes|\.editorconfig|\.mailmap)(\..*)?$/i;

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// Returns the project-relative path if this file should demand verification, else null.
export function codePath(root, file, ignore = []) {
  if (!file) return null;
  const rel = path.relative(path.resolve(root), path.resolve(root, file)).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null; // outside the project
  if (rel.startsWith('.claude/') || rel.startsWith('.git/')) return null;
  if (DOC_EXT.test(rel) || DOC_NAMES.test(path.posix.basename(rel))) return null;
  if (ignore.some((g) => globToRegExp(g).test(rel))) return null;
  return rel;
}

// ---------------------------------------------------------------- what counts as a check

const WRAPPERS = [
  /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, // FOO=bar cmd
  /^(?:time|nice|sudo|env|command|xvfb-run|dotenv\s+--)\s+/,
  /^timeout\s+(?:-\S+\s+)*\S+\s+/,
  /^(?:bash|sh|zsh)\s+(?=\S*\.sh\b)/,
  /^(?:uv|poetry|pipenv|pdm|hatch|rye)\s+run\s+/,
  /^bundle\s+exec\s+/,
  /^(?:npx|pnpx|bunx)\s+(?:-\S+\s+)*/,
  /^(?:pnpm|npm|yarn)\s+(?:exec|dlx)\s+(?:-\S+\s+)*/,
  /^(?:\.\/)?node_modules\/\.bin\//,
  /^vendor\/bin\//,
];

const PM_SCRIPT = String.raw`(?:test|tests|t|lint|typecheck|type-check|types|tsc|check|checks|verify|validate|ci|build|e2e|(?:test|lint|check|e2e|typecheck)[:.-][\w:.-]+)`;

const CHECKS = [
  new RegExp(String.raw`^(?:npm|pnpm|yarn|bun)\s+(?:-[\w-]+(?:[= ](?!run\b|${PM_SCRIPT}\b)\S+)?\s+)*(?:run\s+(?:-[\w-]+\s+)*)?${PM_SCRIPT}\b`),
  /^(?:tsc|vitest|jest|mocha|ava|tap|c8|nyc|eslint|biome|oxlint|prettier\s+.*--check|playwright\s+test|cypress\s+run|svelte-check|vue-tsc|astro\s+check)\b/,
  /^node\s+(?:-\S+\s+)*--test\b/,
  /^(?:deno\s+(?:test|check|lint)|bun\s+test)\b/,
  /^(?:python3?\s+-m\s+)?(?:pytest|unittest|tox|nox|mypy|pyright|ruff\s+check|ruff|flake8|pylint|black\s+--check)\b/,
  /^hatch\s+test\b/,
  /^cargo\s+(?:\+\S+\s+)?(?:test|check|clippy|build|nextest|fmt\s+.*--check)\b/,
  /^go\s+(?:test|vet|build)\b/,
  /^(?:golangci-lint|staticcheck)\b/,
  /^(?:make|just|task|mise\s+run)\s+(?:-\S+\s+)*(?:test|tests|check|lint|ci|verify|typecheck)\b/,
  /^(?:mvn|\.\/mvnw|mvnw)\b.*\b(?:test|verify)\b/,
  /^(?:gradle|\.\/gradlew|gradlew)\b.*\b(?:test|check|build)\b/,
  /^dotnet\s+(?:test|build)\b/,
  /^(?:rspec|rubocop|rails\s+test|rake\s+(?:test|spec))\b/,
  /^(?:phpunit|pest|phpstan|composer\s+(?:test|check))\b/,
  /^swift\s+(?:test|build)\b/,
  /^xcodebuild\b.*\btest\b/,
  /^mix\s+(?:test|compile|credo|dialyzer)\b/,
  /^(?:bazel|bazelisk)\s+test\b/,
  /^(?:shellcheck|terraform\s+validate|tflint|helm\s+lint)\b/,
  /^(?:\.\/)?(?:scripts?\/|bin\/)?(?:test|tests|check|checks|ci|verify|lint|typecheck)(?:\.sh)?(?:\s|$)/,
];

function segments(command) {
  return command
    .replace(/\\\n/g, ' ')
    .split(/&&|\|\||;|\n|\|/)
    .map((s) => s.trim().replace(/^[({]\s*/, ''))
    .filter(Boolean);
}

function unwrap(segment) {
  let s = segment;
  for (let changed = true; changed;) {
    changed = false;
    for (const w of WRAPPERS) {
      const next = s.replace(w, '');
      if (next !== s) { s = next; changed = true; }
    }
    const cd = s.match(/^cd\s+\S+\s*$/); // a bare `cd x` segment is never a check
    if (cd) return '';
  }
  return s;
}

// Returns the matching check segment, or null if the command verifies nothing.
export function detectCheck(command, extra = []) {
  if (!command || /(?:^|\s)--(?:help|version)\b/.test(command)) return null;
  for (const seg of segments(command)) {
    const s = unwrap(seg);
    if (!s) continue;
    if (CHECKS.some((re) => re.test(s))) return seg;
    if (extra.some((c) => s.startsWith(c.trim()) || seg.startsWith(c.trim()))) return seg;
  }
  return null;
}

// A piped or `|| true`'d check can exit 0 while failing; read its output for the verdict.
const FAILURE_SIGNS = [
  /\b[1-9]\d* (?:failed|failing|failures?|errors?)\b/i,
  /^(?:FAIL|FAILED|ERROR)\b/m,
  /\bTests?:\s+[1-9]\d* failed/i,
  /\berror(?:\[E\d+\])?: /,
  /\berror TS\d+:/,
  /^--- FAIL:/m,
  /^not ok \d+/m,
  /^# fail [1-9]/m,
  /\bCannot find module\b/,
  /\bnpm ERR!|ERR_PNPM_|\berror Command failed\b/,
];

export function looksFailed(output) {
  return FAILURE_SIGNS.some((re) => re.test(output || ''));
}

// ---------------------------------------------------------------- suggested checks for this project

function exists(root, rel) { return fs.existsSync(path.join(root, rel)); }
function read(root, rel) { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; } }

export function suggestChecks(root) {
  const out = [];
  const pkg = readJson(path.join(root, 'package.json'), null);
  if (pkg && pkg.scripts) {
    const pm = exists(root, 'pnpm-lock.yaml') ? 'pnpm'
      : exists(root, 'yarn.lock') ? 'yarn'
      : (exists(root, 'bun.lockb') || exists(root, 'bun.lock')) ? 'bun'
      : 'npm';
    const run = (name) => (name === 'test' && pm !== 'bun' ? `${pm} test` : `${pm} run ${name}`);
    const s = pkg.scripts;
    const placeholder = /no test specified/;
    if (s.test && !placeholder.test(s.test)) out.push(run('test'));
    const typecheck = ['typecheck', 'type-check', 'check'].find((name) => s[name]);
    if (typecheck) out.push(run(typecheck));
    if (s.lint) out.push(run('lint'));
  }
  if (exists(root, 'Cargo.toml')) out.push('cargo test');
  if (exists(root, 'go.mod')) out.push('go test ./...');
  const py = ['pyproject.toml', 'setup.py', 'setup.cfg', 'pytest.ini', 'tox.ini'].some((f) => exists(root, f));
  if (py && (exists(root, 'tests') || exists(root, 'test') || /pytest/.test(read(root, 'pyproject.toml')))) {
    out.push(exists(root, 'uv.lock') ? 'uv run pytest' : exists(root, 'poetry.lock') ? 'poetry run pytest' : 'pytest');
  }
  const make = read(root, 'Makefile');
  if (/^test:/m.test(make)) out.push('make test');
  else if (/^check:/m.test(make)) out.push('make check');
  if (/^test\b.*:/m.test(read(root, 'justfile'))) out.push('just test');
  if (exists(root, 'deno.json') || exists(root, 'deno.jsonc')) out.push('deno test');
  if (exists(root, 'Gemfile') && exists(root, 'spec')) out.push('bundle exec rspec');
  if (exists(root, 'mix.exs')) out.push('mix test');
  if (exists(root, 'pom.xml')) out.push('mvn test');
  if (exists(root, 'build.gradle') || exists(root, 'build.gradle.kts')) out.push(exists(root, 'gradlew') ? './gradlew test' : 'gradle test');
  if (exists(root, 'Package.swift')) out.push('swift test');
  if (/phpunit/.test(read(root, 'composer.json'))) out.push('vendor/bin/phpunit');
  try {
    if (fs.readdirSync(root).some((f) => /\.(sln|csproj|fsproj)$/.test(f))) out.push('dotnet test');
  } catch { /* unreadable root */ }
  return [...new Set(out)].slice(0, 3);
}

// ---------------------------------------------------------------- verdict

function dirtyFiles(state) {
  const since = state.lastPass ? state.lastPass.seq : 0;
  return Object.entries(state.edits)
    .filter(([, seq]) => seq > since)
    .sort((a, b) => b[1] - a[1])
    .map(([file]) => file);
}

export function verdict(state, root) {
  const config = loadConfig(root);
  const checks = [...new Set([...config.checks, ...suggestChecks(root)])].slice(0, 3);
  if (!config.enabled) return { kind: 'off', checks };
  const dirty = dirtyFiles(state);
  const lastEditSeq = Math.max(0, ...Object.values(state.edits));
  if (!dirty.length) {
    if (state.lastPass) return { kind: 'verified', checks, pass: state.lastPass };
    return { kind: 'idle', checks };
  }
  const run = state.lastRun;
  if (run && !run.ok && run.seq > lastEditSeq) return { kind: 'failing', checks, dirty, run };
  return { kind: 'unverified', checks, dirty, run };
}

function listFiles(files) {
  const shown = files.slice(0, MAX_LISTED_FILES).join(', ');
  return files.length > MAX_LISTED_FILES ? `${shown} (+${files.length - MAX_LISTED_FILES} more)` : shown;
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function code(s) { return `\`${s}\``; }

// ---------------------------------------------------------------- hook handlers

function onEdit(input, root) {
  const config = loadConfig(root);
  const ti = input.tool_input || {};
  const rel = codePath(root, ti.file_path || ti.notebook_path || ti.path, config.ignore);
  if (!rel) return;
  const state = loadState(root, input.session_id);
  state.seq += 1;
  state.edits[rel] = state.seq;
  saveState(state);
}

function onBash(input, root, failedEvent) {
  const ti = input.tool_input || {};
  if (ti.run_in_background) return; // the result isn't in yet
  const config = loadConfig(root);
  const check = detectCheck(String(ti.command || ''), config.checks);
  if (!check) return;
  // Non-zero exits arrive as PostToolUseFailure; PostToolUse means exit 0.
  const r = input.tool_response;
  const output = typeof r === 'string' ? r : r ? `${r.stdout || ''}\n${r.stderr || ''}` : '';
  let ok = !failedEvent && !(r && r.interrupted);
  // `check | tail` and `check || true` exit 0 even when the check fails.
  if (ok && /\|/.test(String(ti.command)) && looksFailed(output)) ok = false;
  const state = loadState(root, input.session_id);
  state.seq += 1;
  const cmd = check.replace(/\s+\d*[<>]+&?\s*\S+/g, '').slice(0, 200); // drop `2>&1`, `> log`
  const entry = { cmd, ok, seq: state.seq, t: Date.now() };
  state.lastRun = entry;
  if (ok) state.lastPass = entry;
  saveState(state);
}

function onStop(input, root) {
  const state = loadState(root, input.session_id);
  const v = verdict(state, root);
  if (v.kind !== 'unverified' && v.kind !== 'failing') return null;
  // Nothing we know how to run, and nothing was ever run: stay quiet.
  if (v.kind === 'unverified' && !v.checks.length && !state.lastRun) return null;

  // Speak once per state. If Claude stops again without changing anything,
  // it has heard us (and, as instructed, told the user) — let it go.
  const lastEditSeq = Math.max(0, ...Object.values(state.edits));
  const key = `${lastEditSeq}:${state.lastRun ? state.lastRun.seq : 0}`;
  if (state.blocked.includes(key)) return null;
  state.blocked = [...state.blocked.slice(-19), key];
  saveState(state);

  const run = v.checks.length ? v.checks.map(code).join(' · ') : 'the checks that cover it';
  const escape = 'If they genuinely can\'t run here, stop and tell the user plainly that the change is unverified and why.';
  if (v.kind === 'failing') {
    return `Proof: ${code(v.run.cmd)} failed after your latest change and hasn't passed since. ` +
      `Fix it and re-run before finishing. ${escape.replace('unverified', 'failing')}`;
  }
  return `Proof: ${plural(v.dirty.length, 'file')} changed since the last passing check — ${listFiles(v.dirty)}. ` +
    `Before finishing, run ${run}. ${escape}`;
}

// ---------------------------------------------------------------- /proof

function status(root) {
  const state = latestState(root) || emptyState(root, null);
  const v = verdict(state, root);
  const lines = [`Proof · ${path.basename(path.resolve(root))}`, ''];
  switch (v.kind) {
    case 'off':
      lines.push('○ Off for this project. Run /proof on to resume.');
      break;
    case 'idle':
      lines.push('○ Nothing to prove yet — no code changes this session.');
      break;
    case 'verified':
      lines.push(`● Verified — ${code(v.pass.cmd)} passed after the last change (${ago(v.pass.t)}).`);
      break;
    case 'failing':
      lines.push(`✕ Failing — ${code(v.run.cmd)} failed ${ago(v.run.t)}.`);
      lines.push(`  Unverified: ${listFiles(v.dirty)}`);
      break;
    default:
      lines.push(`◐ Unverified — ${plural(v.dirty.length, 'file')} changed since the last passing check.`);
      lines.push(`  ${listFiles(v.dirty)}`);
      if (state.lastPass) lines.push(`  Last pass: ${code(state.lastPass.cmd)} ${ago(state.lastPass.t)}`);
  }
  lines.push('');
  lines.push(v.checks.length
    ? `Checks: ${v.checks.map(code).join(' · ')}`
    : 'Checks: none detected — add them to .claude/proof.json { "checks": ["…"] }');
  return lines.join('\n');
}

// ---------------------------------------------------------------- main

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function main() {
  const args = process.argv.slice(2);
  const data = args.find((a) => a.startsWith('--data='));
  if (data && data.length > '--data='.length && !process.env.PROOF_DATA_DIR) process.env.CLAUDE_PLUGIN_DATA = data.slice('--data='.length);
  const mode = args.find((a) => !a.startsWith('--')) || 'status'; // bare `/proof` passes no argument
  if (process.env.PROOF_DISABLED === '1' && !['status', 'on', 'off'].includes(mode)) return;

  if (mode === 'status' || mode === 'on' || mode === 'off') {
    const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    if (mode === 'on') { setEnabled(root, true); console.log('● Proof is on for this project.'); return; }
    if (mode === 'off') { setEnabled(root, false); console.log('○ Proof is off for this project. /proof on to resume.'); return; }
    console.log(status(root));
    return;
  }

  let input = {};
  try { input = JSON.parse(readStdin() || '{}'); } catch { return; }
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

  if (mode === 'edit') onEdit(input, root);
  else if (mode === 'ran') onBash(input, root, false);
  else if (mode === 'failed') onBash(input, root, true);
  else if (mode === 'stop') {
    const reason = onStop(input, root);
    if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { main(); } catch (err) {
    if (process.env.PROOF_DEBUG) console.error(err);
  }
  process.exit(0);
}
