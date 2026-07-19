#!/usr/bin/env node

/**
 * policy.js — single entrypoint for the build policy's computational enforcement.
 *
 * Every step of BUILD-POLICY.md that can be checked by a machine is checked here.
 * AI tools and humans interact with the policy through these commands instead of
 * remembering prose. See BUILD-POLICY.md for the workflow these commands enforce.
 *
 * Usage: node policy.js <command> [projectDir] [flags]
 *
 *   setup-machine       Bootstrap a new machine: hook script, hooks, agents (from machine/)
 *   doctor              Machine-level setup checks (tools, npmrc, hooks, agents)
 *   check [dir]         Project compliance check (structure, scripts, drift, staleness)
 *   gates [dir]         Run quality gates in order; writes .policy/gates.json marker
 *                         --fast   pre-commit subset (validate + secrets)
 *   verify-marker [dir] Pre-commit: block commit if source changed without a full-gates
 *                         pass on this exact tree (called from .husky/pre-commit)
 *   verify-ready [dir]  Confirm gates marker matches current diff + changelog updated
 *                         --release      add release checks (version, attribution, checklist)
 *                         --ack-manual   record that manual release checks were performed
 *   health [dir]        Maintenance run: outdated, audit, registry staleness; records timestamp
 *                         --socket   include a Socket supply-chain scan (uses quota)
 *   scaffold [dir]      Create missing standard files/scripts (never overwrites)
 *   mirror              Check public mirror for drift and private-detail leaks
 *
 * Hook modes (called by Claude Code hooks, not humans):
 *   check --hook        Terse output for SessionStart injection; always exits 0
 *   hook-stop           Stop hook: block turn-end if source changed without CHANGELOG entry
 *                         or without a full-gates pass on the current tree
 *   hook-pretool        PreToolUse hook: block electron:build on a dirty tree;
 *                         redirect raw `semgrep scan` to `npm run sast`
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const POLICY_ROOT = path.resolve(__dirname, '..');
const TEMPLATES = path.join(POLICY_ROOT, 'templates');
const REGISTRY_PATH = path.join(POLICY_ROOT, 'registry.json');
const PUBLIC_ROOT = path.join(path.dirname(POLICY_ROOT), 'build-policy-public');
const BLOCKLIST_PATH = path.join(POLICY_ROOT, 'mirror-blocklist.txt');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// ---------------------------------------------------------------- utilities

const results = { pass: 0, warn: 0, fail: 0, lines: [] };
let hookMode = false;

function ok(msg) {
  results.pass++;
  if (!hookMode) console.log(`  ${GREEN}✓${RESET} ${msg}`);
}
function warn(msg) {
  results.warn++;
  results.lines.push(`WARN: ${msg}`);
  if (!hookMode) console.log(`  ${YELLOW}⚠${RESET} ${msg}`);
}
function fail(msg) {
  results.fail++;
  results.lines.push(`FAIL: ${msg}`);
  if (!hookMode) console.log(`  ${RED}✗${RESET} ${msg}`);
}
function section(title) {
  if (!hookMode) console.log(`\n${BOLD}${title}${RESET}`);
}

function sh(cmd, cwd) {
  try {
    const out = execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: out.trim() };
  } catch (e) {
    return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).trim(), code: e.status };
  }
}

/**
 * Values interpolated into shell commands (npm script names, registry values)
 * come from trusted local files, but validate anyway so a tampered config
 * can't inject commands.
 */
function safeToken(value, label) {
  if (!/^[\w@:.\/-]+$/.test(value)) {
    console.error(`${RED}Refusing to use unsafe ${label}: ${JSON.stringify(value)}${RESET}`);
    process.exit(1);
  }
  return value;
}

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function exists(p) {
  return fs.existsSync(p);
}

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function daysSince(iso) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function loadRegistry() {
  return readJSON(REGISTRY_PATH) || { entries: {}, staleness: {} };
}

function statePath(dir) {
  return path.join(dir, '.policy', 'state.json');
}
function loadState(dir) {
  return readJSON(statePath(dir)) || {};
}
function saveState(dir, state) {
  fs.mkdirSync(path.join(dir, '.policy'), { recursive: true });
  fs.writeFileSync(statePath(dir), JSON.stringify(state, null, 2) + '\n');
}

/**
 * Guard against operating on a cloud-mounted (streamed) copy instead of the
 * locally synced folder. Git on a virtual drive risks data damage.
 */
function guardLocalPath(dir) {
  const real = fs.realpathSync(path.resolve(dir));
  if (real.startsWith('/Volumes/')) {
    console.error(
      `${RED}${BOLD}BLOCKED:${RESET} ${real}\n` +
        `This path is on a mounted volume (likely a cloud-drive mount), ` +
        `not the local sync folder under ${os.homedir()}. ` +
        `Switch to the local copy before running git or build commands.`,
    );
    process.exit(1);
  }
}

// ------------------------------------------------------------ project model

function detectProject(dir) {
  const pkg = readJSON(path.join(dir, 'package.json'));
  const p = {
    dir,
    pkg,
    hasPkg: !!pkg,
    isTS: exists(path.join(dir, 'tsconfig.json')),
    isElectron: false,
    hasServer: exists(path.join(dir, 'server')) || exists(path.join(dir, 'server.js')),
    hasHTML: false,
    hasCSS: exists(path.join(dir, 'styles')),
    isGit: exists(path.join(dir, '.git')),
  };
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    p.isElectron = 'electron' in deps || !!(pkg.build && pkg.build.mac);
    if (!p.hasServer && 'express' in deps) p.hasServer = true;
  }
  try {
    p.hasHTML = fs.readdirSync(dir).some((f) => f.endsWith('.html'));
  } catch {
    /* unreadable dir */
  }
  if (!p.hasHTML) p.hasHTML = exists(path.join(dir, 'index.html'));
  return p;
}

function changedFiles(dir) {
  const r = sh('git status --porcelain', dir);
  if (!r.ok) return [];
  // sh() trims the whole output, which can strip the first line's leading
  // status column — parse by stripping the status token, not by offset.
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const f = l.trim().replace(/^[A-Z?!]{1,2}\s+/, '');
      return f.includes(' -> ') ? f.split(' -> ')[1] : f;
    });
}

const SOURCE_PATTERNS = [
  /^src\//,
  /^server\//,
  /^electron\//,
  /^worker\//,
  /^public\//,
  /^styles\//,
  /\.(js|ts|tsx|jsx|css|html)$/,
];
function isSourceFile(f) {
  if (/^tests?\//.test(f) || f === 'CHANGELOG.md' || f.endsWith('.md')) return false;
  return SOURCE_PATTERNS.some((re) => re.test(f));
}

/**
 * Versions that already have a built DMG in the release output — treated as
 * shipped and frozen: new source work requires a version bump and a NEW
 * CHANGELOG section, never amendments to a built version's entry.
 */
/** Top CHANGELOG entry's version, or null. */
function changelogTopVersion(dir) {
  const m = readFile(path.join(dir, 'CHANGELOG.md')).match(/^##\s*\[?(\d+\.\d+\.\d+)/m);
  return m ? m[1] : null;
}

function builtDmgVersions(dir) {
  const versions = new Set();
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(dir, 'release'));
  } catch {
    return versions;
  }
  for (const f of entries) {
    const m = f.endsWith('.dmg') && f.match(/(\d+\.\d+\.\d+)/);
    if (m) versions.add(m[1]);
  }
  return versions;
}

function diffHash(dir) {
  // Hash the changed-file list + their current contents. Deliberately
  // staging-invariant: `git add` must not invalidate a gates marker, so we
  // hash file content directly rather than `git status`/`git diff` output
  // (whose text changes between staged and unstaged states).
  // .policy/ is gitignored in compliant projects, but exclude it explicitly —
  // the gates marker written moments earlier must never invalidate itself.
  const files = changedFiles(dir)
    .filter((f) => !f.startsWith('.policy/'))
    .sort();
  const h = crypto.createHash('sha256');
  h.update(files.join('\n'));
  for (const f of files) h.update('\0' + readFile(path.join(dir, f)));
  return h.digest('hex');
}

// ------------------------------------------------------------------- check

const BASE_SCRIPTS = ['lint', 'format:check', 'validate', 'quality', 'secrets', 'licenses', 'deps:check', 'review'];

function cmdCheck(dir) {
  guardLocalPath(dir);
  const proj = detectProject(dir);
  const reg = loadRegistry();

  section(`Compliance check: ${path.resolve(dir)}`);

  if (!proj.hasPkg) {
    ok('No package.json — documentation-only project, structural checks skipped');
    checkStaleness(dir, reg);
    return finish();
  }

  // Required npm scripts
  const scripts = proj.pkg.scripts || {};
  const required = [...BASE_SCRIPTS];
  if (proj.isTS) required.push('type-check');
  if (proj.hasHTML) required.push('lint:html');
  if (proj.hasCSS) required.push('lint:css');
  if (proj.hasServer) required.push('test:smoke');
  required.push('sast');
  const devDepsForBuild = { ...(proj.pkg.dependencies || {}), ...(proj.pkg.devDependencies || {}) };
  if ('vite' in devDepsForBuild || 'typescript' in devDepsForBuild) required.push('build');
  const missing = required.filter((s) => !scripts[s]);
  if (missing.length === 0) ok(`All ${required.length} required npm scripts present`);
  else fail(`Missing npm scripts: ${missing.join(', ')} (run: policy scaffold)`);
  if (scripts.sast && !scripts.sast.includes('--error')) {
    fail(`sast script missing --error — semgrep findings cannot fail the gate locally (CI will fail where local passed)`);
  }

  // Required devDependencies
  const devDeps = proj.pkg.devDependencies || {};
  for (const dep of ['eslint-plugin-security', 'husky', 'license-checker', 'prettier']) {
    if (!devDeps[dep]) fail(`Missing devDependency: ${dep}`);
  }

  // Required files
  const requiredFiles = [
    ['.github/dependabot.yml', 'Dependabot config'],
    ['.github/workflows/ci.yml', 'GitHub Actions CI'],
    ['allowed-packages.json', 'dependency allowlist'],
    ['CHANGELOG.md', 'changelog'],
    ['README.md', 'readme'],
    ['.husky/pre-commit', 'husky pre-commit hook'],
    ['AGENTS.md', 'agent instructions (non-Claude agents)'],
  ];
  for (const [f, label] of requiredFiles) {
    if (exists(path.join(dir, f))) ok(`${label} present`);
    else fail(`Missing ${label}: ${f} (run: policy scaffold)`);
  }

  // .gitignore effectiveness — some repos are public, so private context and
  // data must be unpublishable. Test what git would actually ignore (pattern
  // semantics), not what .gitignore happens to mention as a substring.
  const privatePaths = [
    '.env',
    '.env.local',
    'local_data/x',
    'node_modules/x',
    '.claude/x',
    'CLAUDE.md',
    'CLAUDE.local.md',
    'AGENTS.md',
    '.policy/x',
  ];
  if (proj.isGit) {
    const ci = sh(`git check-ignore -- ${privatePaths.join(' ')}`, dir);
    const ignored = new Set(ci.out.split('\n').filter(Boolean));
    const unignored = privatePaths.filter((p) => !ignored.has(p));
    if (unignored.length > 0) {
      fail(
        `.gitignore does not cover: ${unignored.map((p) => p.replace(/\/x$/, '/')).join(', ')} — a 'git add .' would stage private files. Sync with templates/gitignore`,
      );
    } else ok('.gitignore covers all private paths (verified via git check-ignore)');

    // Ignoring is meaningless if the file is already tracked. Committed
    // placeholders (.env.example/.env.template/.gitkeep) are fine by design.
    const trackedRaw = sh(
      `git ls-files -- .env '.env.*' .claude CLAUDE.md CLAUDE.local.md AGENTS.md local_data .policy`,
      dir,
    );
    const tracked = {
      ok: trackedRaw.ok,
      out: trackedRaw.out
        .split('\n')
        .filter((f) => f && !/\.env\.(example|sample|template)$/.test(f) && !f.endsWith('.gitkeep'))
        .join('\n'),
    };
    if (tracked.ok && tracked.out) {
      fail(
        `Private files are TRACKED in git (would publish with the repo): ${tracked.out.split('\n').join(', ')} — git rm --cached them (developer runs this) before any push`,
      );
    } else ok('No private files tracked in git');
  } else {
    const gi = readFile(path.join(dir, '.gitignore'));
    for (const entry of ['.env', 'local_data', 'node_modules', '.claude', 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.policy']) {
      if (!gi.includes(entry)) fail(`.gitignore missing entry: ${entry}`);
    }
  }
  const gi = readFile(path.join(dir, '.gitignore'));
  if (proj.isElectron && /^build\/?\s*$/m.test(gi)) {
    fail('.gitignore ignores build/ — Electron apps must commit build/icon.png and entitlements');
  }

  // Icons
  if (proj.isElectron) {
    if (exists(path.join(dir, 'build/icon.png'))) ok('App icon present (build/icon.png)');
    else fail('Missing app icon: build/icon.png (512x512+, electron-builder converts to .icns)');
    if (exists(path.join(dir, 'build/entitlements.mac.plist'))) ok('Entitlements present');
    else fail('Missing build/entitlements.mac.plist');
    const mac = proj.pkg.build && proj.pkg.build.mac;
    if (mac && mac.notarize && mac.hardenedRuntime) ok('Signing config: notarize + hardenedRuntime set');
    else warn('electron-builder mac config missing notarize/hardenedRuntime');
  } else if (proj.hasServer) {
    if (exists(path.join(dir, 'public/manifest.json'))) ok('PWA manifest present');
    else warn('No public/manifest.json — web apps should ship PWA icons');
  }

  // Shipped version frozen: source changes on a version that already has a DMG
  if (proj.pkg && proj.pkg.version && builtDmgVersions(dir).has(proj.pkg.version)) {
    if (changedFiles(dir).filter(isSourceFile).length > 0) {
      fail(
        `Source changed but version ${proj.pkg.version} already has a built DMG (shipped = frozen) — bump the version and start a new CHANGELOG section`,
      );
    } else {
      ok(`Version ${proj.pkg.version} shipped (DMG built), no new source changes`);
    }
  }

  // CHANGELOG freshness vs package version
  const cl = readFile(path.join(dir, 'CHANGELOG.md'));
  const topVersion = (cl.match(/^##\s*\[?(\d+\.\d+\.\d+)/m) || [])[1];
  if (topVersion && proj.pkg.version) {
    if (topVersion === proj.pkg.version) ok(`CHANGELOG top entry matches package version (${topVersion})`);
    else warn(`CHANGELOG top entry (${topVersion}) != package.json version (${proj.pkg.version})`);
  }

  // CI template drift
  const ciPath = path.join(dir, '.github/workflows/ci.yml');
  if (exists(ciPath)) {
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    if (norm(readFile(ciPath)) !== norm(readFile(path.join(TEMPLATES, 'ci.yml')))) {
      fail('ci.yml differs from the shared template — sync it: cp ../build-policy/templates/ci.yml .github/workflows/ci.yml (deviations belong in the template, not the project)');
    } else ok('CI workflow matches shared template');
  }

  // Pre-commit hook template drift
  const pcPath = path.join(dir, '.husky/pre-commit');
  if (exists(pcPath)) {
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    if (norm(readFile(pcPath)) !== norm(readFile(path.join(TEMPLATES, 'pre-commit')))) {
      fail('.husky/pre-commit differs from the shared template — THIS PROJECT IS UNENFORCED (no verify-marker). Sync: cp ../build-policy/templates/pre-commit .husky/pre-commit');
    } else ok('Pre-commit hook matches shared template');
  }

  // Dependabot config template drift (quote-style-insensitive) — presence-only
  // checking let projects fork on cooldown settings
  const dbPath = path.join(dir, '.github/dependabot.yml');
  if (exists(dbPath)) {
    const norm = (s) => s.replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
    if (norm(readFile(dbPath)) !== norm(readFile(path.join(TEMPLATES, 'dependabot.yml')))) {
      fail('dependabot.yml differs from the shared template — sync: cp ../build-policy/templates/dependabot.yml .github/dependabot.yml (deviations belong in the template)');
    } else ok('Dependabot config matches shared template');
  }

  // AGENTS.md template drift (non-Claude agents rely on this being current)
  const agPath = path.join(dir, 'AGENTS.md');
  if (exists(agPath)) {
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    if (norm(readFile(agPath)) !== norm(readFile(path.join(TEMPLATES, 'AGENTS.md')))) {
      fail('AGENTS.md differs from the shared template — sync: cp ../build-policy/templates/AGENTS.md AGENTS.md');
    } else ok('AGENTS.md matches shared template');
  }

  // Uncommitted work notice (context for session start)
  if (proj.isGit) {
    const changed = changedFiles(dir);
    if (changed.length > 0) warn(`${changed.length} uncommitted change(s) in working tree`);
    else ok('Working tree clean');
  }

  checkStaleness(dir, reg);
  return finish();
}

function checkStaleness(dir, reg) {
  const state = loadState(dir);
  const healthDays = (reg.staleness && reg.staleness.healthRunDays) || 30;
  if (state.lastHealthRun) {
    const d = daysSince(state.lastHealthRun);
    if (d > healthDays) warn(`Maintenance overdue: last 'policy health' run ${d} days ago (run: policy health)`);
    else ok(`Maintenance current (last health run ${d} days ago)`);
  } else {
    warn(`No maintenance record — run 'policy health' to establish one`);
  }

  const stale = Object.entries(reg.entries || {}).filter(([, e]) => daysSince(e.verified) > (e.reviewEveryDays || 90));
  if (stale.length > 0) {
    warn(
      `Registry entries need re-verification (web-search current state, update registry.json): ` +
        stale.map(([k]) => k).join(', '),
    );
  } else if (Object.keys(reg.entries || {}).length > 0) {
    ok('Tooling registry entries all within review window');
  }
}

function finish() {
  if (hookMode) {
    if (results.fail === 0 && results.warn === 0) {
      console.log('Policy compliance: PASS. No gaps.');
    } else {
      console.log(`Policy compliance: ${results.fail} gap(s), ${results.warn} warning(s):`);
      for (const l of results.lines.slice(0, 12)) console.log(`- ${l}`);
      if (results.lines.length > 12) console.log(`- ...and ${results.lines.length - 12} more`);
      console.log('Fix FAIL items before feature work (BUILD-POLICY Phase 1).');
    }
    process.exit(0);
  }
  console.log(
    `\n${BOLD}${results.fail === 0 ? GREEN + 'PASS' : RED + 'FAIL'}${RESET} — ` +
      `${results.pass} ok, ${results.warn} warnings, ${results.fail} failures\n`,
  );
  process.exit(results.fail > 0 ? 1 : 0);
}

// ------------------------------------------------------------------- gates

const GATE_ORDER = [
  { name: 'Type check', script: 'type-check', fast: true },
  { name: 'Lint', script: 'lint', fast: true },
  { name: 'HTML validation', script: 'lint:html', fast: true },
  { name: 'CSS validation', script: 'lint:css', fast: true },
  { name: 'Format check', script: 'format:check', fast: true },
  { name: 'Secret scan', script: 'secrets', fast: true },
  { name: 'Dependency allowlist', script: 'deps:check', fast: true },
  { name: 'SAST (Semgrep)', script: 'sast' },
  { name: 'Dependency audit', script: 'security' },
  { name: 'License compliance', script: 'licenses' },
  { name: 'CodeRabbit review', script: 'review' },
  { name: 'Build', script: 'build' },
  { name: 'Smoke tests', script: 'test:smoke' },
  { name: 'Integration tests', script: 'test:integration' },
];

function cmdGates(dir, flags) {
  guardLocalPath(dir);
  const proj = detectProject(dir);
  if (!proj.hasPkg) {
    console.log('No package.json — nothing to gate.');
    return;
  }
  const fast = flags.includes('--fast');
  const scripts = proj.pkg.scripts || {};
  const gates = GATE_ORDER.filter((g) => (fast ? g.fast : true)).filter((g) => scripts[g.script]);

  section(`Quality gates (${fast ? 'fast/pre-commit' : 'full'}): ${path.resolve(dir)}`);
  const report = [];
  for (const g of gates) {
    const t0 = Date.now();
    process.stdout.write(`  ${DIM}running${RESET} ${g.name} (npm run ${g.script}) ... `);
    const r = sh(`npm run ${safeToken(g.script, 'script name')}`, dir);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.ok) {
      console.log(`${GREEN}pass${RESET} ${DIM}${secs}s${RESET}`);
      report.push({ gate: g.name, pass: true });
    } else {
      console.log(`${RED}FAIL${RESET} ${DIM}${secs}s${RESET}\n`);
      const tail = r.out.split('\n').slice(-40).join('\n');
      console.log(tail);
      console.log(
        `\n${RED}${BOLD}Gate failed: ${g.name}.${RESET} Fix, then re-run FULL gates (a commit needs the full-gates marker): policy gates\n` +
          (fast ? `${DIM}(--fast is only the pre-commit subset — it does not write the marker)${RESET}\n` : ''),
      );
      process.exit(1);
    }
  }

  if (!fast) {
    const marker = { diffHash: diffHash(dir), timestamp: new Date().toISOString(), gates: report.map((r) => r.gate) };
    fs.mkdirSync(path.join(dir, '.policy'), { recursive: true });
    // Trailing newline keeps the marker prettier-clean in projects where
    // .policy/ isn't (yet) gitignored/prettierignored.
    fs.writeFileSync(path.join(dir, '.policy', 'gates.json'), JSON.stringify(marker, null, 2) + '\n');
  }
  console.log(`\n${GREEN}${BOLD}All ${report.length} gates passed.${RESET}${fast ? '' : ' Marker written (.policy/gates.json).'}\n`);
}

// ----------------------------------------------------------- verify-marker

/**
 * Pre-commit enforcement: source files changed => full gates must have passed
 * on this exact tree (.policy/gates.json diffHash matches). Doc-only commits
 * pass without a marker. Exits 1 to block the commit otherwise.
 */
function cmdVerifyMarker(dir) {
  guardLocalPath(dir);
  const proj = detectProject(dir);
  if (!proj.hasPkg || !proj.isGit) return;
  const sourceChanged = changedFiles(dir).filter(isSourceFile);
  if (sourceChanged.length === 0) return;
  const marker = readJSON(path.join(dir, '.policy', 'gates.json'));
  if (marker && marker.diffHash === diffHash(dir)) {
    console.log(`${GREEN}✓${RESET} Full gates passed on this exact tree (${marker.timestamp})`);
    return;
  }
  console.log(
    `\n${RED}${BOLD}BUILD-POLICY: commit blocked.${RESET} ` +
      (marker
        ? `Source changed since full gates last passed (${marker.timestamp}).`
        : 'Source changed but full quality gates have never passed on this tree.') +
      `\nRun full gates, then commit:\n  node ${path.join(POLICY_ROOT, 'scripts', 'policy.js')} gates\n`,
  );
  process.exit(1);
}

// ------------------------------------------------------------ verify-ready

function apiRoutes(dir) {
  const routes = new Set();
  const scan = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) scan(full);
      else if (/\.(js|ts)$/.test(e.name)) {
        const src = readFile(full);
        const re = /\.(?:get|post|put|patch|delete)\(\s*['"`](\/api\/[^'"`]+)['"`]/g;
        let m;
        while ((m = re.exec(src))) routes.add(m[1]);
      }
    }
  };
  scan(path.join(dir, 'server'));
  const rootServer = path.join(dir, 'server.js');
  if (exists(rootServer)) {
    const src = readFile(rootServer);
    const re = /\.(?:get|post|put|patch|delete)\(\s*['"`](\/api\/[^'"`]+)['"`]/g;
    let m;
    while ((m = re.exec(src))) routes.add(m[1]);
  }
  return [...routes];
}

function cmdVerifyReady(dir, flags) {
  guardLocalPath(dir);
  const proj = detectProject(dir);
  const release = flags.includes('--release');
  section(`Verify ready${release ? ' (release)' : ''}: ${path.resolve(dir)}`);

  if (!proj.isGit) {
    fail('Not a git repository');
    return finish();
  }

  // 1. Gates marker matches the current diff
  const marker = readJSON(path.join(dir, '.policy', 'gates.json'));
  if (!marker) fail(`No gates marker — run 'policy gates' first`);
  else if (marker.diffHash !== diffHash(dir))
    fail(`Working tree changed since gates last passed (${marker.timestamp}) — re-run 'policy gates'`);
  else ok(`Gates passed for the current working tree (${marker.gates.length} gates, ${marker.timestamp})`);

  // 2. CHANGELOG updated alongside source changes
  const changed = changedFiles(dir);
  const sourceChanged = changed.filter(isSourceFile);
  if (proj.pkg && proj.pkg.version && sourceChanged.length > 0 && builtDmgVersions(dir).has(proj.pkg.version)) {
    fail(
      `Version ${proj.pkg.version} already shipped as a DMG — bump the version and start a new CHANGELOG section before declaring ready`,
    );
  }
  if (sourceChanged.length > 0 && !changed.includes('CHANGELOG.md')) {
    fail(`${sourceChanged.length} source file(s) changed but CHANGELOG.md not updated`);
  } else if (sourceChanged.length > 0) {
    ok('CHANGELOG.md updated alongside source changes');
  } else {
    ok('No uncommitted source changes');
  }

  // 3. Smoke coverage for API routes — ratcheted: existing gaps are recorded
  // as a baseline (debt, warned); NEW uncovered routes FAIL. The baseline
  // auto-shrinks as tests are added, and can never grow.
  if (proj.hasServer) {
    const routes = apiRoutes(dir);
    const smoke = readFile(path.join(dir, 'tests', 'smoke.js'));
    if (routes.length > 0 && smoke) {
      const uncovered = routes.filter((r) => !smoke.includes(r.split('/:')[0]));
      const state = loadState(dir);
      const baseline = state.smokeGapBaseline;
      if (uncovered.length === 0) {
        ok(`All ${routes.length} detected API routes appear in smoke tests`);
        if (baseline && baseline.length > 0) {
          state.smokeGapBaseline = [];
          saveState(dir, state);
        }
      } else if (!baseline) {
        state.smokeGapBaseline = uncovered.sort();
        saveState(dir, state);
        warn(
          `API routes with no smoke coverage (recorded as debt baseline, new gaps will FAIL): ${uncovered.join(', ')}`,
        );
      } else {
        const fresh = uncovered.filter((r) => !baseline.includes(r));
        if (fresh.length > 0)
          fail(`NEW API routes with no smoke coverage (cover them before shipping): ${fresh.join(', ')}`);
        const remaining = uncovered.filter((r) => baseline.includes(r));
        if (remaining.length < baseline.length) {
          state.smokeGapBaseline = remaining.sort();
          saveState(dir, state);
        }
        if (remaining.length > 0)
          warn(`Smoke-coverage debt (baseline, shrink over time): ${remaining.length} route(s)`);
      }
    }
  }

  if (release) verifyRelease(dir, proj, flags);
  return finish();
}

// Banner verification exploits the deliberate mismatch check (app version !==
// site version.json => banner): installing the new DMG while the site still
// lists the old version proves the banner machinery fires; updating the site
// then proves the match clears it. Same code path a real user's old app hits.
const RELEASE_MANUAL_CHECKLIST = [
  'Installed new DMG over previous (dogfood): data migrated, settings intact, first-run + one core flow work',
  'Update banner VISIBLE in the new build (site version.json still lists the previous version)',
  'Uploaded new DMG to Gumroad, then updated site version.json + changelog + listing',
  'Update banner CLEARED after site update (versions match; relaunch app to re-fetch)',
  'Release marketing drafts prepped in app-marketing',
];

function verifyRelease(dir, proj, flags) {
  section('Release checks');

  // Version bumped vs last tag. Tag-at-release flow: pkg == tag is CORRECT
  // when the tag sits at HEAD (this release, already tagged); it is a missed
  // bump only when commits landed after the tag.
  const tag = sh('git describe --tags --abbrev=0', dir);
  if (tag.ok && proj.pkg) {
    const last = tag.out.replace(/^v/, '');
    if (last === proj.pkg.version) {
      const ahead = sh(`git rev-list ${safeToken(tag.out, 'git tag')}..HEAD --count`, dir);
      if (ahead.ok && ahead.out.trim() === '0')
        ok(`Release ${proj.pkg.version} tagged at HEAD (${tag.out})`);
      else
        fail(
          `Commits exist after tag ${tag.out} but package.json is still ${proj.pkg.version} — bump it`,
        );
    } else ok(`Version bumped: ${last} -> ${proj.pkg.version}`);
  } else warn('No git tags found — tag releases so version bumps are verifiable (git tag v<version> at each release commit)');

  // CHANGELOG top entry IS this version (includes() would match old entries)
  const relTopVer = changelogTopVersion(dir);
  if (proj.pkg && relTopVer === proj.pkg.version) ok(`CHANGELOG top entry matches release version (${relTopVer})`);
  else
    fail(
      `CHANGELOG top entry (${relTopVer || 'none'}) is not the release version (${proj.pkg && proj.pkg.version}) — bump/align before shipping`,
    );

  // Third-party attribution shipped
  if (proj.isElectron) {
    if (exists(path.join(dir, 'THIRD-PARTY-LICENSES.txt')))
      ok('Third-party license attribution file present');
    else fail(`Missing THIRD-PARTY-LICENSES.txt — run 'npm run licenses:file' and include it in the build`);
  }

  // Manual checklist acknowledgment (recorded per version)
  const state = loadState(dir);
  const ackVersion = state.releaseAck && state.releaseAck.version;
  if (flags.includes('--ack-manual')) {
    state.releaseAck = { version: proj.pkg.version, time: new Date().toISOString() };
    saveState(dir, state);
    ok(`Manual release checklist acknowledged for ${proj.pkg.version}`);
  } else if (ackVersion === proj.pkg.version) {
    ok(`Manual release checklist previously acknowledged for ${proj.pkg.version} (${state.releaseAck.time})`);
  } else {
    fail('Manual release checklist not acknowledged for this version. Perform these, then re-run with --ack-manual:');
    for (const item of RELEASE_MANUAL_CHECKLIST) console.log(`      ${DIM}•${RESET} ${item}`);
  }
}

// ------------------------------------------------------------------ health

function cmdHealth(dir, flags) {
  guardLocalPath(dir);
  const proj = detectProject(dir);
  const reg = loadRegistry();
  section(`Health: ${path.resolve(dir)}`);

  if (proj.hasPkg) {
    const outdated = sh('npm outdated --json', dir);
    let list = {};
    try {
      list = JSON.parse(outdated.out || '{}');
    } catch {
      /* non-JSON output, treat as none */
    }
    const n = Object.keys(list).length;
    if (n === 0) ok('No outdated dependencies');
    else warn(`${n} outdated dependencies: ${Object.keys(list).slice(0, 8).join(', ')}${n > 8 ? ', ...' : ''}`);

    const audit = sh('npm audit --audit-level=high', dir);
    if (audit.ok) ok('npm audit clean at high level');
    else fail(`npm audit found high/critical issues:\n${audit.out.split('\n').slice(-15).join('\n')}`);

    if (flags.includes('--socket')) {
      const org = safeToken(loadRegistry().socketOrg || 'your-org', 'socket org');
      const scan = sh(`socket scan create ${org} .`, dir);
      if (scan.ok) ok('Socket supply-chain scan submitted');
      else warn(`Socket scan failed: ${scan.out.split('\n').slice(-3).join(' ')}`);
    }
  } else {
    ok('No package.json — dependency checks skipped');
  }

  checkStaleness(dir, reg);

  const state = loadState(dir);
  state.lastHealthRun = new Date().toISOString();
  saveState(dir, state);
  console.log(`\n${DIM}Recorded health run in .policy/state.json${RESET}`);
  return finish();
}

// ---------------------------------------------------------------- scaffold

const STANDARD_SCRIPTS = {
  lint: 'eslint . --max-warnings 0',
  'lint:fix': 'eslint . --fix',
  format: 'prettier --write .',
  'format:check': 'prettier --check .',
  security: 'npm audit --audit-level=high',
  sast: 'semgrep scan --config auto --error --quiet',
  secrets: 'betterleaks git . -v',
  licenses: "license-checker --production --failOn 'GPL-2.0;GPL-3.0;AGPL-1.0;AGPL-3.0' --summary",
  'licenses:file': 'license-checker --production > THIRD-PARTY-LICENSES.txt',
  'deps:check': 'node ../build-policy/scripts/check-allowlist.js .',
  'deps:verify': 'node ../build-policy/scripts/verify-package.js',
  review: 'coderabbit review --agent',
  prepare: 'husky',
};

function cmdScaffold(dir) {
  guardLocalPath(dir);
  const proj = detectProject(dir);
  section(`Scaffold: ${path.resolve(dir)}`);
  const created = [];
  const skipped = [];

  const copy = (tpl, dest) => {
    const destPath = path.join(dir, dest);
    if (exists(destPath)) {
      skipped.push(dest);
      return;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(path.join(TEMPLATES, tpl), destPath);
    created.push(dest);
  };

  copy('gitignore', '.gitignore');
  copy('AGENTS.md', 'AGENTS.md');
  copy('dependabot.yml', '.github/dependabot.yml');
  copy('ci.yml', '.github/workflows/ci.yml');
  copy('pre-commit', '.husky/pre-commit');
  if (proj.hasHTML) copy('htmlvalidate.json', '.htmlvalidate.json');
  if (proj.hasCSS) copy('stylelintrc.json', '.stylelintrc.json');
  if (proj.isElectron) copy('entitlements.mac.plist', 'build/entitlements.mac.plist');

  if (!exists(path.join(dir, 'CHANGELOG.md'))) {
    fs.writeFileSync(
      path.join(dir, 'CHANGELOG.md'),
      `# Changelog\n\n## [0.1.0] - ${new Date().toISOString().slice(0, 10)}\n- Initial setup\n`,
    );
    created.push('CHANGELOG.md');
  } else skipped.push('CHANGELOG.md');

  fs.mkdirSync(path.join(dir, '.claude', 'specs'), { recursive: true });

  // Merge missing standard scripts into package.json (never overwrite existing)
  if (proj.hasPkg) {
    const pkgPath = path.join(dir, 'package.json');
    const pkg = readJSON(pkgPath);
    pkg.scripts = pkg.scripts || {};
    const add = { ...STANDARD_SCRIPTS };
    if (proj.isTS) add['type-check'] = 'tsc --noEmit';
    if (proj.hasHTML) add['lint:html'] = 'html-validate *.html';
    if (proj.hasCSS) add['lint:css'] = 'stylelint "styles/*.css"';
    const fastParts = ['lint', proj.hasHTML && 'lint:html', proj.hasCSS && 'lint:css', 'format:check', proj.isTS && 'type-check']
      .filter(Boolean)
      .map((s) => `npm run ${s}`);
    add.validate = fastParts.join(' && ');
    add.quality =
      'npm run validate && npm run sast && npm run security && npm run secrets && npm run licenses && npm run deps:check && npm run review';
    const addedScripts = [];
    for (const [k, v] of Object.entries(add)) {
      if (!pkg.scripts[k]) {
        pkg.scripts[k] = v;
        addedScripts.push(k);
      }
    }
    if (addedScripts.length > 0) {
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      created.push(`package.json scripts: ${addedScripts.join(', ')}`);
    }
    try {
      fs.chmodSync(path.join(dir, '.husky', 'pre-commit'), 0o755);
    } catch {
      /* fine */
    }
    if (!exists(path.join(dir, 'allowed-packages.json'))) {
      console.log(`  ${YELLOW}⚠${RESET} No allowed-packages.json — bootstrap it:`);
      console.log(`      node ../build-policy/scripts/bootstrap-allowlist.js .`);
    }
  }

  for (const c of created) console.log(`  ${GREEN}created${RESET} ${c}`);
  for (const s of skipped) console.log(`  ${DIM}exists  ${s}${RESET}`);
  console.log(`\nRe-run 'policy check' to see remaining gaps (devDependencies must be installed manually).\n`);
}

// ------------------------------------------------------------------ mirror

function cmdMirror() {
  section('Public mirror check');
  if (!exists(PUBLIC_ROOT)) {
    fail(`Public mirror not found at ${PUBLIC_ROOT}`);
    return finish();
  }

  // Drift: private docs newer or version-different vs public
  for (const doc of ['BUILD-POLICY.md', 'project-standards.md']) {
    const priv = readFile(path.join(POLICY_ROOT, doc));
    const pub = readFile(path.join(PUBLIC_ROOT, doc));
    const ver = (s) => (s.match(/\*\*Version:\*\*\s*([\d.]+)/) || [])[1];
    if (!pub) fail(`${doc} missing from public mirror`);
    else if (ver(priv) !== ver(pub)) fail(`${doc} version drift: private ${ver(priv)} vs public ${ver(pub)}`);
    else ok(`${doc} versions match (${ver(priv)})`);
  }

  // Drift: scripts/ and templates/ are mirrored verbatim ("enforcement is
  // publicly verifiable") — any byte difference means the mirror is stale.
  for (const sub of ['scripts', 'templates']) {
    const privDir = path.join(POLICY_ROOT, sub);
    const pubDir = path.join(PUBLIC_ROOT, sub);
    const list = (d) => (exists(d) ? fs.readdirSync(d).filter((f) => !f.startsWith('.')) : []);
    const names = [...new Set([...list(privDir), ...list(pubDir)])].sort();
    const stale = names.filter((f) => readFile(path.join(privDir, f)) !== readFile(path.join(pubDir, f)));
    if (stale.length > 0) {
      fail(
        `${sub}/ drift vs public mirror: ${stale.join(', ')} — sync: cp ${stale.map((f) => `${sub}/${f}`).join(' ')} ../build-policy-public/${sub}/`,
      );
    } else ok(`${sub}/ matches public mirror (${names.length} files)`);
  }

  // Leak scan: blocklist terms + generic patterns must not appear in public files.
  // '!'-prefixed terms are checked everywhere; others are exempt in README.md
  // (which carries deliberate branding).
  const terms = readFile(BLOCKLIST_PATH)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => (l.startsWith('!') ? { term: l.slice(1), everywhere: true } : { term: l, everywhere: false }));
  // Third generic pattern: Apple app-specific password shape (xxxx-xxxx-xxxx-xxxx,
  // lowercase letters) — covered here so the literal never lives in the blocklist.
  const genericPatterns = [
    /\/Users\/[a-z]+/i,
    /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
    /\b[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}\b/,
  ];
  let leaks = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const content = readFile(full);
        const rel = path.relative(PUBLIC_ROOT, full);
        const isReadme = rel === 'README.md';
        for (const { term, everywhere } of terms) {
          if ((everywhere || !isReadme) && content.includes(term)) {
            fail(`Leak in public mirror ${rel}: contains "${term}"`);
            leaks++;
          }
        }
        if (!isReadme) {
          for (const re of genericPatterns) {
            // Check every match, not just the first — a doc placeholder must
            // not mask a real secret later in the same file.
            const all = content.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || [];
            const hit = all.find(
              (s) => !/^(your|you|user|name|example|placeholder|someone)@/i.test(s) && s !== 'xxxx-xxxx-xxxx-xxxx',
            );
            if (hit) {
              fail(`Leak in public mirror ${rel}: matches ${re} ("${hit}")`);
              leaks++;
            }
          }
        }
      }
    }
  };
  walk(PUBLIC_ROOT);
  if (leaks === 0) ok('No blocklisted terms or private patterns found in public mirror');
  return finish();
}

// ------------------------------------------------------------------ doctor

function cmdDoctor() {
  section('Machine setup (policy doctor)');
  guardLocalPath(POLICY_ROOT);
  ok(`build-policy at local path: ${POLICY_ROOT}`);

  for (const [bin, hint] of [
    ['git', 'xcode-select --install'],
    ['node', 'install Node LTS via nvm'],
    ['semgrep', 'brew install semgrep'],
    ['betterleaks', 'brew install betterleaks'],
    ['socket', 'npm install -g @socketsecurity/cli'],
    ['pm2', 'npm install -g pm2'],
  ]) {
    const r = sh(`command -v ${bin}`);
    if (r.ok) ok(`${bin} installed (${r.out})`);
    else fail(`${bin} not found — ${hint}`);
  }

  const npmrc = readFile(path.join(os.homedir(), '.npmrc'));
  if (/^min-release-age\s*=\s*1/m.test(npmrc)) ok('~/.npmrc min-release-age=1 (24h package quarantine)');
  else fail('~/.npmrc missing min-release-age=1');

  const settings = readJSON(path.join(os.homedir(), '.claude', 'settings.json')) || {};
  const settingsStr = JSON.stringify(settings);
  if (settingsStr.includes('policy.js') || settingsStr.includes('session-start'))
    ok('Claude Code hooks configured in ~/.claude/settings.json');
  else warn('Claude Code hooks not wired — run: policy setup-machine');

  const agentsDir = path.join(os.homedir(), '.claude', 'agents');
  const agents = exists(agentsDir) ? fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')) : [];
  if (agents.length > 0) ok(`Claude agents present: ${agents.join(', ')}`);
  else warn('No ~/.claude/agents definitions — run: policy setup-machine');

  const profile = loadRegistry().notaryKeychainProfile;
  if (profile) {
    safeToken(profile, 'keychain profile');
    // notarytool stores in the data-protection keychain (not visible to
    // `security find-generic-password`), so verify via notarytool itself.
    try {
      execSync(`xcrun notarytool history --keychain-profile "${profile}"`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20000,
      });
      ok(`Notarization keychain profile "${profile}" valid (verified with Apple)`);
    } catch {
      warn(
        `Notarization keychain profile "${profile}" not verifiable (missing, or offline) — ` +
          `set up with: xcrun notarytool store-credentials ${profile} --apple-id <id> --team-id <team> --password <app-specific>`,
      );
    }
  }
  return finish();
}

// ------------------------------------------------------------ setup-machine

/**
 * Bootstrap a new machine from the canonical wiring in build-policy/machine/:
 * session-start script, Claude Code hooks, haiku agent definitions.
 * Idempotent — canonical files are (re)copied, hooks are merged only if the
 * event doesn't already reference the policy. Finish with `policy doctor`.
 */
function cmdSetupMachine() {
  const MACHINE = path.join(POLICY_ROOT, 'machine');
  const claudeDir = path.join(os.homedir(), '.claude');
  section('Machine setup from build-policy/machine/');

  if (!exists(MACHINE)) {
    fail(`Canonical wiring not found at ${MACHINE}`);
    return finish();
  }

  // 1. Session-start script
  const scriptsDir = path.join(claudeDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const scriptDest = path.join(scriptsDir, 'session-start.sh');
  fs.copyFileSync(path.join(MACHINE, 'session-start.sh'), scriptDest);
  fs.chmodSync(scriptDest, 0o755);
  ok(`Installed ${scriptDest}`);

  // 2. Agent definitions
  const agentsSrc = path.join(MACHINE, 'agents');
  const agentsDest = path.join(claudeDir, 'agents');
  fs.mkdirSync(agentsDest, { recursive: true });
  for (const f of fs.readdirSync(agentsSrc).filter((n) => n.endsWith('.md'))) {
    fs.copyFileSync(path.join(agentsSrc, f), path.join(agentsDest, f));
  }
  ok(`Installed agents to ${agentsDest}`);

  // 3. Hooks — merge into settings.json, never clobber existing config
  const settingsPath = path.join(claudeDir, 'settings.json');
  const settings = readJSON(settingsPath) || {};
  const canonical = readJSON(path.join(MACHINE, 'hooks.json')) || {};
  settings.hooks = settings.hooks || {};
  let merged = 0;
  for (const [event, entries] of Object.entries(canonical)) {
    if (event.startsWith('_')) continue;
    const existing = JSON.stringify(settings.hooks[event] || '');
    if (existing.includes('policy.js') || existing.includes('session-start')) {
      ok(`Hook ${event}: already wired, left as-is`);
      continue;
    }
    settings.hooks[event] = [...(settings.hooks[event] || []), ...entries];
    merged++;
  }
  if (merged > 0) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    ok(`Merged ${merged} hook event(s) into ${settingsPath}`);
  }

  console.log(
    `\nRemaining manual steps (doctor checks all of these):\n` +
      `  brew install semgrep betterleaks\n` +
      `  npm install -g pm2 @socketsecurity/cli && socket wrapper on && socket login\n` +
      `  echo 'min-release-age=1' >> ~/.npmrc  (if not present)\n` +
      `  xcrun notarytool store-credentials <profile> --apple-id <id> --team-id <team> --password <app-specific>\n` +
      `\nNow run: node ${path.join(POLICY_ROOT, 'scripts', 'policy.js')} doctor\n`,
  );
  return finish();
}

// ------------------------------------------------------------- hook modes

function readStdinJSON() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

/** Stop hook: block turn-end when source changed without a CHANGELOG update
 *  or without a full-gates pass on the current tree. One combined block per
 *  turn (stop_hook_active guard), so all reasons are reported together. */
function cmdHookStop() {
  const input = readStdinJSON();
  if (input.stop_hook_active) process.exit(0); // never loop
  const dir = process.cwd();
  const proj = detectProject(dir);
  if (!proj.hasPkg || !proj.isGit) process.exit(0);
  const changed = changedFiles(dir);
  const sourceChanged = changed.filter(isSourceFile);
  if (sourceChanged.length === 0) process.exit(0);

  const reasons = [];
  if (!changed.includes('CHANGELOG.md') && exists(path.join(dir, 'CHANGELOG.md'))) {
    reasons.push(
      `CHANGELOG.md was not updated — every code change gets a changelog entry before the turn ends. ` +
        `Update it now (or state why no entry is needed).`,
    );
  }
  if (proj.pkg && proj.pkg.version && builtDmgVersions(dir).has(proj.pkg.version)) {
    reasons.push(
      `Version ${proj.pkg.version} already has a built DMG in release/ — it is shipped and FROZEN. ` +
        `Bump the version in package.json (patch for fixes, minor for features) and start a NEW ` +
        `CHANGELOG section for it. Never amend a shipped version's changelog entry.`,
    );
  }
  const topVer = changelogTopVersion(dir);
  if (proj.pkg && proj.pkg.version && topVer && topVer !== proj.pkg.version) {
    reasons.push(
      `CHANGELOG top entry is ${topVer} but package.json is ${proj.pkg.version} — they must move together. ` +
        `A new CHANGELOG section means bumping package.json to match, in the same turn.`,
    );
  }
  const marker = readJSON(path.join(dir, '.policy', 'gates.json'));
  if (!marker || marker.diffHash !== diffHash(dir)) {
    reasons.push(
      `Full quality gates have NOT passed on the current tree` +
        (marker ? ` (last pass: ${marker.timestamp}, tree has changed since)` : ' (no gates marker)') +
        `. If you are presenting this work as ready or asking the developer to commit, run them now: ` +
        `node ${path.join(POLICY_ROOT, 'scripts', 'policy.js')} gates — the pre-commit hook will reject the commit without this. ` +
        `If you are mid-iteration and not presenting yet, state that explicitly and continue.`,
    );
  }
  if (reasons.length > 0) {
    console.log(
      JSON.stringify({
        decision: 'block',
        reason:
          `Source files changed (${sourceChanged.slice(0, 5).join(', ')}${sourceChanged.length > 5 ? ', ...' : ''}). BUILD-POLICY:\n` +
          reasons.map((r, i) => `${i + 1}. ${r}`).join('\n'),
      }),
    );
  }
  process.exit(0);
}

/** PreToolUse hook: block electron DMG builds while the working tree is dirty;
 *  redirect raw semgrep invocations to the policy-defined script. */
function cmdHookPretool() {
  const input = readStdinJSON();
  const cmd = (input.tool_input && input.tool_input.command) || '';
  // --ack-manual is the developer's signature that manual release checks
  // (dogfood install, banner, Gumroad upload) were personally performed. The
  // AI cannot know that — it must never record the ack itself.
  if (input.tool_name === 'Bash' && /--ack-manual/.test(cmd)) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            'BUILD-POLICY: --ack-manual is the DEVELOPER\'s signature that the manual release checks were personally performed — the AI must never run it. ' +
            'Show the developer the checklist and ask them to run: node ../build-policy/scripts/policy.js verify-ready --release --ack-manual ' +
            '(they can type it with a ! prefix to run it in this session).',
        },
      }),
    );
    process.exit(0);
  }
  // Raw `semgrep scan` drifts from the gate's flags (that drift is exactly how
  // CI failed where local passed). Steer to the policy-defined invocation.
  if (input.tool_name === 'Bash' && /\bsemgrep\s+scan\b/.test(cmd) && !/npm run sast/.test(cmd)) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            'BUILD-POLICY: do not invoke semgrep directly — flag drift between ad-hoc runs and the gate is how CI fails where local passed. ' +
            'Use the policy-defined script: `npm run sast` (identical flags to CI). ' +
            'Extra output flags go after --, e.g. `npm run sast -- --json`. ' +
            'The full gate sequence is `node ../build-policy/scripts/policy.js gates`.',
        },
      }),
    );
    process.exit(0);
  }
  if (input.tool_name === 'Bash' && /electron:build|electron-builder/.test(cmd)) {
    const dir = process.cwd();
    const deny = (reason) => {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }),
      );
      process.exit(0);
    };
    const status = sh('git status --porcelain', dir);
    if (status.ok && status.out.trim().length > 0) {
      deny(
        'BUILD-POLICY: never build a DMG with uncommitted changes. ' +
          'The build order is gates -> review -> developer commits -> THEN build. ' +
          'Commit (developer) or stash first, then rebuild.',
      );
    }
    // Version consistency: the DMG bakes in package.json's version — building
    // while the CHANGELOG top entry names a different version ships the wrong one.
    const pkg = readJSON(path.join(dir, 'package.json'));
    const topVer = changelogTopVersion(dir);
    if (pkg && pkg.version && topVer && topVer !== pkg.version) {
      deny(
        `BUILD-POLICY: CHANGELOG top entry is ${topVer} but package.json is ${pkg.version} — ` +
          `this build would produce a ${pkg.version} DMG for ${topVer}'s changes. ` +
          `Bump package.json to ${topVer} (developer commits the bump), then build.`,
      );
    }
  }
  process.exit(0);
}

// -------------------------------------------------------------------- main

function main() {
  const [, , command, ...rest] = process.argv;
  const flags = rest.filter((a) => a.startsWith('--'));
  const dir = rest.find((a) => !a.startsWith('--')) || '.';
  hookMode = flags.includes('--hook');

  switch (command) {
    case 'doctor':
      return cmdDoctor();
    case 'setup-machine':
      return cmdSetupMachine();
    case 'check':
      return cmdCheck(dir);
    case 'gates':
      return cmdGates(dir, flags);
    case 'verify-marker':
      return cmdVerifyMarker(dir);
    case 'verify-ready':
      return cmdVerifyReady(dir, flags);
    case 'health':
      return cmdHealth(dir, flags);
    case 'scaffold':
      return cmdScaffold(dir);
    case 'mirror':
      return cmdMirror();
    case 'hook-stop':
      return cmdHookStop();
    case 'hook-pretool':
      return cmdHookPretool();
    default:
      console.log(readFile(__filename).match(/\/\*\*[\s\S]*?\*\//)[0]);
      process.exit(command ? 1 : 0);
  }
}

main();
