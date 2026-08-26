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
 *   upgrade <pkg>       Ground a MAJOR dependency upgrade: pull real peer-dep constraints
 *                         + migration source from npm, scaffold a decision record under
 *                         .claude/specs/deps/. check/verify-ready FAIL on an un-recorded major.
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

// Leading major version from an npm range ("^8.0.3" -> 8, "~3.2" -> 3).
// Returns null for anything non-numeric (*, workspace:*, git urls) so those
// never produce a false "major bump" signal.
function semverMajor(range) {
  if (!range || typeof range !== 'string') return null;
  const m = range.replace(/^[\^~>=<\s]*/, '').match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// Decision-record identity for a major upgrade. Both the writer (cmdUpgrade)
// and the enforcement check derive the filename this way, so they always agree.
// "@types/dompurify" @ major 3 -> "types-dompurify-v3"
function depRecordSlug(pkg, major) {
  return `${pkg.replace(/^@/, '').replace(/\//g, '-')}-v${major}`;
}

// Shared enforcement: any dependency whose major version increased in the
// working tree (vs the committed package.json) MUST have a grounded decision
// record before the change can be presented or committed. Scoped to the
// dirty-tree window on purpose — check/verify-ready both run pre-commit (like
// the CHANGELOG check), so a major cannot reach a commit without passing here.
function auditMajorUpgrades(dir, proj) {
  if (!proj.isGit || !proj.pkg) return;
  const headRaw = sh('git show HEAD:package.json', dir);
  if (!headRaw.ok) return; // no prior commit of package.json — nothing to diff
  let headPkg = null;
  try {
    headPkg = JSON.parse(headRaw.out);
  } catch {
    return;
  }
  const merge = (p) => ({ ...(p.dependencies || {}), ...(p.devDependencies || {}) });
  const cur = merge(proj.pkg);
  const prev = merge(headPkg);
  const bumps = [];
  for (const [name, range] of Object.entries(cur)) {
    const now = semverMajor(range);
    const was = semverMajor(prev[name]);
    if (now != null && was != null && now > was) bumps.push({ name, from: was, to: now });
  }
  if (bumps.length === 0) {
    ok('No un-recorded major dependency upgrades in working tree');
    return;
  }
  for (const b of bumps) {
    const rec = path.join(dir, '.claude', 'specs', 'deps', `${depRecordSlug(b.name, b.to)}.md`);
    if (exists(rec)) ok(`Major upgrade ${b.name} v${b.from}→v${b.to}: decision record present`);
    else
      fail(
        `Major upgrade ${b.name} v${b.from}→v${b.to} has NO grounded decision record — run 'policy upgrade ${b.name}' and complete .claude/specs/deps/${depRecordSlug(b.name, b.to)}.md before committing`,
      );
  }
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
  // `-uall` is load-bearing: plain --porcelain collapses an untracked directory
  // to one `?? dir/` entry but lists its files individually once staged, so the
  // file list — and diffHash with it — changed on `git add`, breaking the
  // staging-invariance diffHash promises. Worse, readFile() on a directory path
  // returns '' (EISDIR), so a new directory's contents were hashed as nothing
  // and edits inside it never invalidated a gates marker.
  const r = sh('git status --porcelain -uall', dir);
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

// Hash of file CONTENT only, with no dependence on those files' status against
// HEAD. Unlike diffHash this is unchanged by committing them.
function contentHash(dir, files) {
  const h = crypto.createHash('sha256');
  for (const f of files) h.update('\0' + readFile(path.join(dir, f)));
  return h.digest('hex');
}

/**
 * Does a gates marker still describe the code in front of us?
 *
 * diffHash alone said no as soon as you committed: it hashes the changed-file
 * list *relative to HEAD*, and `git commit` empties that list without altering
 * a byte of what was verified. So the sequence gates → commit → anything left
 * the marker invalid and demanded a full re-run (CodeRabbit included) of gates
 * that had just passed on identical code.
 *
 * A marker holds when the verified content is still present and nothing new has
 * changed alongside it — whether that content is now committed or not.
 */
function markerMatches(dir, marker) {
  if (!marker) return false;
  if (marker.diffHash === diffHash(dir)) return true;
  if (!Array.isArray(marker.files) || typeof marker.contentHash !== 'string') return false;

  // Anything changed now that gates never saw invalidates the marker.
  const current = changedFiles(dir).filter((f) => !f.startsWith('.policy/'));
  const verified = new Set(marker.files);
  if (current.some((f) => !verified.has(f))) return false;

  // The verified files must still hold exactly the content that passed.
  return contentHash(dir, marker.files) === marker.contentHash;
}

// ------------------------------------------------------------------- check

// Prettier keys every project must share. Deliberately a baseline, not the
// whole of templates/prettierrc: projects legitimately differ on plugins and
// comma/paren taste, but these four govern line shape, and a project that
// deviates cannot be formatted with any other project's config.
// Placeholder identities used in documentation and UI hints — never leaks.
// Shared by the tracked-file scan in `check` and the leak scan in `mirror`.
const PLACEHOLDER_ID =
  /^(you|your|your[-_]?name|user|username|name|example|placeholder|someone|me|dev|developer)$/i;

const PRETTIER_BASELINE = { semi: true, singleQuote: true, tabWidth: 2, printWidth: 100 };

const BASE_SCRIPTS = [
  'lint',
  'format:check',
  'validate',
  'quality',
  'secrets',
  'licenses',
  'deps:check',
  'review',
  'socket:scan',
];

// The policy docs state their version in a header line, and BUILD-POLICY.md
// also carries a version-history table. A patch row appended without bumping
// the header leaves the document disagreeing with itself — and everything
// downstream (commit messages, the mirror drift check, anyone citing "policy
// v2.4") inherits the wrong number. The mirror check only compares the two
// headers to EACH OTHER, so a stale header passes it. Enforced here instead:
// the header must equal the highest version the history records, the history
// must read newest-first, and project-standards.md must track the same version.
function auditPolicyDocVersions(root, label) {
  const headerVer = (s) => (s.match(/\*\*Version:\*\*\s*([\d.]+)/) || [])[1];

  const bp = readFile(path.join(root, 'BUILD-POLICY.md'));
  if (!bp) return fail(`${label}: BUILD-POLICY.md not found`);
  const bpVer = headerVer(bp);
  if (!bpVer) return fail(`${label}: BUILD-POLICY.md has no "**Version:**" header`);

  const rows = [...bp.matchAll(/^\|\s*(\d+(?:\.\d+)*)\s*\|\s*\d{4}-\d{2}-\d{2}\s*\|/gm)].map(
    (m) => m[1],
  );
  if (rows.length === 0) {
    fail(`${label}: BUILD-POLICY.md version-history table has no parsable rows`);
  } else {
    const newest = rows.reduce((a, b) => (cmpSemver(b, a) > 0 ? b : a));
    if (bpVer !== newest) {
      fail(
        `${label}: BUILD-POLICY.md header says ${bpVer} but the version history records ${newest} — ` +
          `bump the header (a new history row without a header bump makes every citation of the version wrong)`,
      );
    } else ok(`${label}: BUILD-POLICY.md header matches version history (${bpVer})`);

    const misordered = rows.findIndex((v, i) => i > 0 && cmpSemver(v, rows[i - 1]) > 0);
    if (misordered > 0) {
      fail(
        `${label}: BUILD-POLICY.md version history is not newest-first — ${rows[misordered]} appears below ` +
          `${rows[misordered - 1]}; the top row must be the current version`,
      );
    }
  }

  const ps = readFile(path.join(root, 'project-standards.md'));
  if (!ps) fail(`${label}: project-standards.md not found`);
  else {
    const psVer = headerVer(ps);
    if (psVer !== bpVer) {
      fail(
        `${label}: project-standards.md header says ${psVer} but BUILD-POLICY.md is ${bpVer} — ` +
          `the two docs ship as one policy version`,
      );
    } else ok(`${label}: project-standards.md tracks the policy version (${psVer})`);
  }
}

function cmpSemver(a, b) {
  const key = (v) => {
    const p = v.split('.').map(Number);
    return [p[0] || 0, p[1] || 0, p[2] || 0];
  };
  const [x, y] = [key(a), key(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * Electron itself is audited, despite living in devDependencies.
 *
 * The `security` gate is `npm audit --audit-level=high --omit=dev`, on the
 * reasoning that the gate models SHIPPED risk and dev dependencies do not ship
 * (2.4.1). That premise is false for exactly one package: electron-builder
 * bundles Electron into the DMG, so the largest attack surface in the shipped
 * app — Chromium — was the one thing the audit never looked at. Found shipping
 * an Electron with a high-severity sandbox escape and a fix already available.
 *
 * Audits the full tree but fails only on Electron, so dev-chain advisories stay
 * out of the gate as 2.4.1 intended.
 */
function auditShippedElectron(dir) {
  const raw = sh('npm audit --audit-level=high --json', dir);
  let report;
  try {
    report = JSON.parse(raw.out);
  } catch {
    warn('Could not parse npm audit output — Electron not audited');
    return;
  }
  const vuln = (report.vulnerabilities || {}).electron;
  if (!vuln) {
    ok('Electron has no known advisories (audited despite being a devDependency)');
    return;
  }
  if (['high', 'critical'].includes(vuln.severity)) {
    const titles = (vuln.via || [])
      .filter((v) => typeof v === 'object')
      .map((v) => `${v.title} [${v.severity}]`)
      .slice(0, 2);
    fail(
      `Electron ${vuln.severity} advisory affects the SHIPPED app (${vuln.range}): ${titles.join('; ')} — ` +
        `${vuln.fixAvailable ? 'a fix is available; upgrade electron' : 'no fix published yet; assess before shipping'}. ` +
        `The 'security' gate omits dev deps, but electron-builder bundles Electron into the DMG`,
    );
  } else {
    warn(
      `Electron has a ${vuln.severity} advisory (${vuln.range}) — below the high gate threshold`,
    );
  }
}

/**
 * Electron decisions that project-standards states as prohibitions.
 *
 * These were prose only, so a new app scaffolded by copying an existing project
 * inherited whatever that project happened to do — and a divergence read as
 * "how we build Electron apps here" rather than as a defect. Checking the
 * outcome is possible where checking "read the standards first" is not.
 *
 * Comment lines are skipped: one project discusses `safeStorage` only to record
 * that it moved off it, and flagging that would train people to ignore the
 * check. Matching is on imports and calls, not on the word appearing.
 */
function auditElectronStandards(dir, proj) {
  const deps = { ...(proj.pkg.dependencies || {}), ...(proj.pkg.devDependencies || {}) };
  const findings = [];

  const puppeteer = Object.keys(deps).filter((d) => /puppeteer/.test(d));
  if (puppeteer.length > 0) {
    findings.push(
      `${puppeteer.join(', ')} in dependencies — Electron already is Chromium; use pdfmake for PDF export (project-standards § Electron)`,
    );
  }

  let licence = null;
  let safeStorage = null;
  let hasFindFreePort = false;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (['node_modules', 'dist', 'release', 'build', 'coverage'].includes(e.name)) continue;
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|mjs)$/.test(e.name)) continue;
      const src = readFile(full);
      if (/findFreePort/.test(src)) hasFindFreePort = true;
      const rel = path.relative(dir, full);
      for (const line of src.split('\n')) {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
        if (!licence && /api\.gumroad\.com\/v2\/licenses/.test(t)) licence = rel;
        if (!safeStorage && /safeStorage\s*\.\s*\w+|[{,]\s*safeStorage\s*[},]/.test(t))
          safeStorage = rel;
      }
    }
  };
  walk(dir);

  if (licence) {
    findings.push(
      `in-app licence gate in ${licence} — the Gumroad download is the gate; an activation check puts a network dependency in the startup path (project-standards § Electron)`,
    );
  }
  if (safeStorage) {
    findings.push(
      `Electron safeStorage used in ${safeStorage} — its values go stale across re-signs; use AES-256-CBC with a machine-derived key (project-standards § Electron)`,
    );
  }
  if (!hasFindFreePort) {
    findings.push(
      `no findFreePort() found — a hardcoded port collides with the PM2 dev instance and can connect the app to the wrong process (project-standards § Electron)`,
    );
  }

  if (findings.length > 0) {
    for (const f of findings) fail(`Electron standard: ${f}`);
  } else ok('Electron standards followed (no licence gate, puppeteer, or safeStorage)');
}

// Cross-platform native binaries: @rolldown/binding-linux-x64-gnu and friends.
// A package that ships these declares them all as optionalDependencies, and npm
// records a resolution for every one regardless of the machine generating the
// lockfile — verified against npm 11 with `--package-lock-only`, `npm update`,
// a from-scratch regeneration, and a real `--omit=optional` install.
const PLATFORM_BINARY =
  /(linux|darwin|win32|freebsd|android)[-_.]?(x64|arm64|ia32|arm|s390x|ppc64)|(x64|arm64)[-_.]?(linux|darwin|win32)|msvc|gnu$|musl$/i;

/**
 * A lockfile that declares platform binaries it has no resolutions for.
 *
 * npm never writes this state. It appears when something filters the lockfile
 * to "just what this machine needs" — leaving the optionalDependencies list
 * intact while deleting the entries it points at. The result installs fine on
 * the machine that made it and fails on every other platform, so the first
 * symptom is a CI build breaking with no obvious cause. A real instance removed
 * 50 entries across rolldown, lightningcss and @tailwindcss/oxide.
 *
 * Genuinely optional native modules (canvas, which often cannot build) are not
 * platform variants and are skipped: only families of two or more
 * platform-named siblings are checked.
 */
function auditLockfileIntegrity(dir) {
  const lockPath = path.join(dir, 'package-lock.json');
  if (!exists(lockPath)) return;
  const lock = readJSON(lockPath);
  if (!lock || !lock.packages) return;

  const broken = [];
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!entry || !entry.optionalDependencies) continue;
    const platform = Object.keys(entry.optionalDependencies).filter((n) => PLATFORM_BINARY.test(n));
    if (platform.length < 2) continue;
    const present = platform.filter((n) => lock.packages['node_modules/' + n]).length;
    if (present < platform.length) {
      broken.push(
        `${(name || '(root)').replace('node_modules/', '')} ${present}/${platform.length}`,
      );
    }
  }

  if (broken.length > 0) {
    fail(
      `package-lock.json is missing platform binaries it declares: ${broken.join(', ')} — ` +
        `npm never writes this, so the lockfile has been edited or filtered. It will install here and fail CI on Linux. ` +
        `Restore it (git checkout package-lock.json) or regenerate with npm install; never hand-edit a lockfile`,
    );
  } else ok('Lockfile declares a resolution for every platform binary');
}

/**
 * Private data that would publish with the repo. Two layers: private FILES that
 * must never be tracked, and private CONTENT inside files that are legitimately
 * tracked. Shared by `check` (session-start report) and `leak-scan` (pre-commit
 * block) so the two can never diverge.
 */
function auditTrackedPrivacy(dir) {
  // Ignoring is meaningless if the file is already tracked. Committed
  // placeholders (.env.example/.env.template/.gitkeep) are fine by design.
  const trackedRaw = sh(
    `git ls-files -- .env '.env.*' .claude CLAUDE.md CLAUDE.local.md AGENTS.md local_data .policy`,
    dir,
  );
  const tracked = trackedRaw.out
    .split('\n')
    .filter((f) => f && !/\.env\.(example|sample|template)$/.test(f) && !f.endsWith('.gitkeep'));
  if (trackedRaw.ok && tracked.length > 0) {
    fail(
      `Private files are TRACKED in git (would publish with the repo): ${tracked.join(', ')} — git rm --cached them (developer runs this) before any push`,
    );
  } else ok('No private files tracked in git');

  // The check above covers private FILES. This covers private CONTENT inside
  // files that are legitimately tracked: an absolute home path publishes the
  // developer's username and directory layout, and is never correct in a
  // committed file. It reached a generated artifact (THIRD-PARTY-LICENSES.txt)
  // because every other gate verified that the file existed, not what was in
  // it. Placeholder usernames (`/Users/you/...`) are documentation, not leaks.
  const hits = sh(`git grep -I -n -E "/(Users|home)/[A-Za-z0-9._-]+/" -- .`, dir);
  const leaking = new Set();
  if (hits.ok && hits.out) {
    for (const line of hits.out.split('\n')) {
      const file = line.split(':')[0];
      for (const m of line.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)\//g)) {
        if (!PLACEHOLDER_ID.test(m[1])) leaking.add(file);
      }
    }
  }
  if (leaking.size > 0) {
    fail(
      `Absolute home paths in tracked file(s): ${[...leaking].join(', ')} — these publish the build machine's username and directory layout. Regenerate or make relative (placeholders like /Users/you/... are fine)`,
    );
  } else ok('No absolute home paths in tracked files');
}

function cmdCheck(dir) {
  guardLocalPath(dir);
  const proj = detectProject(dir);
  const reg = loadRegistry();

  section(`Compliance check: ${path.resolve(dir)}`);

  // Running inside the policy repo itself: the docs are the deliverable.
  if (path.resolve(dir) === POLICY_ROOT) auditPolicyDocVersions(POLICY_ROOT, 'policy docs');

  if (!proj.hasPkg) {
    // A project carrying scaffolding but no package.json is mid-setup, not
    // documentation-only. Reporting PASS here was a false green: every
    // structural check is skipped, including all four template-drift checks, so
    // the session is told the project is fine while nothing has been examined.
    // With no signal to work from, a session invents its own theory of what is
    // wrong — one concluded its freshly scaffolded files were stale and
    // proposed deleting six of them, CHANGELOG.md included.
    const scaffolded = ['AGENTS.md', '.husky', '.github/workflows/ci.yml'].filter((f) =>
      exists(path.join(dir, f)),
    );
    if (scaffolded.length > 0) {
      fail(
        `Project is mid-setup: scaffolding present (${scaffolded.join(', ')}) but no package.json, ` +
          `so every structural check is skipped and this report says nothing about compliance. ` +
          `Create it (npm init), then re-run check and 'policy scaffold' for anything conditional on project type`,
      );
      checkStaleness(dir, reg);
      return finish();
    }
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
    fail(
      `sast script missing --error — semgrep findings cannot fail the gate locally (CI will fail where local passed)`,
    );
  }
  // Semgrep exclusion creep — fewer exclusions than sanctioned is fine
  // (per-line nosemgrep is stricter); an UNsanctioned global exclusion is not.
  if (scripts.sast) {
    const sanctioned = (STANDARD_SCRIPTS.sast.match(/--exclude-rule\s+(\S+)/g) || []).map(
      (e) => e.split(/\s+/)[1],
    );
    const present = (scripts.sast.match(/--exclude-rule\s+(\S+)/g) || []).map(
      (e) => e.split(/\s+/)[1],
    );
    const rogue = present.filter((r) => !sanctioned.includes(r));
    if (rogue.length > 0) {
      fail(
        `sast script has unsanctioned global exclusion(s): ${rogue.map((r) => r.split('.').pop()).join(', ')} — only the four documented exclusions may be global; triage each finding and use per-line // nosemgrep instead (project-standards § Semgrep rule exclusions)`,
      );
    }
  }
  // Audit gate drift — sessions must not improvise scope or thresholds
  if (scripts.security && scripts.security !== STANDARD_SCRIPTS.security) {
    fail(
      `security script is "${scripts.security}" — standard is "${STANDARD_SCRIPTS.security}" (gate = shipped deps at high; 'policy health' audits the full tree incl dev). Weakened audit levels are never sanctioned.`,
    );
  }

  // Review gate scope — the CLI default reviews tracked changes only, so a gate
  // run before staging (the normal order) never saw new files at all.
  if (scripts.review && !scripts.review.includes('--include-untracked')) {
    fail(
      `review script is "${scripts.review}" — missing --include-untracked, so brand-new files pass the review gate unreviewed (the CLI default covers TRACKED changes only, and gates run before staging). Standard: "${STANDARD_SCRIPTS.review}"`,
    );
  }

  // Prettier config — without one, prettier runs on defaults (double quotes)
  // and the project's format style silently drifts from the portfolio
  const prcPath = ['.prettierrc', '.prettierrc.json'].map((f) => path.join(dir, f)).find(exists);
  if (!prcPath) {
    fail(
      'Missing .prettierrc — prettier formats on defaults, drifting from house style (run: policy scaffold)',
    );
  } else {
    const prc = readJSON(prcPath);
    if (!prc) fail(`${path.basename(prcPath)} is not valid JSON`);
    else {
      // Baseline, not template equality: these four keys decide how code is
      // shaped line-by-line, so a project that differs cannot be formatted with
      // another project's config without rewriting the whole file (that is how
      // a stray `prettier --write` reflows 700 lines). Everything else —
      // trailingComma, arrowParens, plugins, endOfLine — is the project's call.
      const wrong = Object.entries(PRETTIER_BASELINE).filter(([k, v]) => prc[k] !== v);
      if (wrong.length > 0) {
        fail(
          `${path.basename(prcPath)} differs from the house baseline: ` +
            wrong
              .map(([k, v]) => `${k} is ${JSON.stringify(prc[k])}, must be ${JSON.stringify(v)}`)
              .join('; ') +
            ` — fixing it reformats the codebase once (npx prettier --write .), after which cross-project formatting is safe. Keys outside the baseline stay yours.`,
        );
      } else ok('Prettier config meets house baseline');
    }
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

  // CLAUDE.md — required, and required to say something. The rule existed only
  // as prose in Phase 1 marked "human judgment", so nothing verified it and a
  // third of projects had none. It is gitignored (local context, never
  // published), which is why it was omitted from the committed-file list above,
  // but existence is checkable regardless of git.
  //
  // The floor is deliberately low: of the files that already existed, every one
  // cleared 25 lines, while heading-based rules would have failed up to ten of
  // them. A scaffolded copy still carrying its placeholder marker counts as
  // absent — a file that exists but says nothing is the failure this is meant
  // to catch, not a box to tick.
  const claudeMd = path.join(dir, 'CLAUDE.md');
  if (!exists(claudeMd)) {
    fail(
      'Missing CLAUDE.md — project context for every AI session (run: policy scaffold, then fill it in)',
    );
  } else {
    const content = readFile(claudeMd);
    if (content.includes('SCAFFOLD:')) {
      fail(
        'CLAUDE.md is still the unfilled scaffold — replace the placeholders and delete the SCAFFOLD line',
      );
    } else if (content.split('\n').length < 25) {
      fail(
        `CLAUDE.md is a stub (${content.split('\n').length} lines) — it must describe what the project is, its architecture, and the patterns a session must not undo`,
      );
    } else ok('CLAUDE.md present');
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

    auditTrackedPrivacy(dir);
    auditLockfileIntegrity(dir);
  } else {
    const gi = readFile(path.join(dir, '.gitignore'));
    for (const entry of [
      '.env',
      'local_data',
      'node_modules',
      '.claude',
      'CLAUDE.md',
      'CLAUDE.local.md',
      'AGENTS.md',
      '.policy',
    ]) {
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
    if (mac && mac.notarize && mac.hardenedRuntime)
      ok('Signing config: notarize + hardenedRuntime set');
    else warn('electron-builder mac config missing notarize/hardenedRuntime');
    auditElectronStandards(dir, proj);
  } else if (proj.hasServer) {
    if (exists(path.join(dir, 'public/manifest.json'))) ok('PWA manifest present');
    else warn('No public/manifest.json — web apps should ship PWA icons');
  }

  // Smoke/integration tiers must be real. `check` used to accept any script
  // named test:smoke, so an `echo 'no tests'` or a bare `npm run build` passed
  // the gate while exercising nothing — green with zero coverage is worse than
  // an honest red. The tiers are also required to be self-contained: a script
  // that fetches a port only passes when a server happens to be running, which
  // is not a test. Standard shape: tests/smoke.js + isolated tests/harness.js
  // (own port, temp data dir) — project-standards § Testing.
  // A missing test:smoke is already reported by the required-scripts check —
  // only judge the tiers when a script actually exists to judge.
  if (proj.hasServer && scripts['test:smoke']) {
    const stub = (s) => /^\s*(echo|exit\s+0|true)\b/.test(s) || /^\s*npm run build\s*$/.test(s);
    if (stub(scripts['test:smoke'])) {
      fail(
        `test:smoke is a stub (${JSON.stringify(scripts['test:smoke'] || '')}) — it passes the gate without testing anything; write tests/smoke.js hitting every API route (project-standards § Testing)`,
      );
    } else {
      for (const [file, tier] of [
        ['tests/smoke.js', 'test:smoke'],
        ['tests/harness.js', 'test:integration'],
      ]) {
        if (exists(path.join(dir, file))) ok(`${tier}: ${file} present`);
        else {
          fail(
            `Missing ${file} — ${tier} must run against an isolated server (own port, temp data dir), not whatever is live on the dev port; production data must never be touched by a test`,
          );
        }
      }
    }
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
    if (topVersion === proj.pkg.version)
      ok(`CHANGELOG top entry matches package version (${topVersion})`);
    else warn(`CHANGELOG top entry (${topVersion}) != package.json version (${proj.pkg.version})`);
  }

  // CI template drift
  const ciPath = path.join(dir, '.github/workflows/ci.yml');
  if (exists(ciPath)) {
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    if (norm(readFile(ciPath)) !== norm(readFile(path.join(TEMPLATES, 'ci.yml')))) {
      fail(
        'ci.yml differs from the shared template — sync it: cp ../build-policy/templates/ci.yml .github/workflows/ci.yml (deviations belong in the template, not the project)',
      );
    } else ok('CI workflow matches shared template');
  }

  // Pre-commit hook template drift
  const pcPath = path.join(dir, '.husky/pre-commit');
  if (exists(pcPath)) {
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    if (norm(readFile(pcPath)) !== norm(readFile(path.join(TEMPLATES, 'pre-commit')))) {
      fail(
        '.husky/pre-commit differs from the shared template — THIS PROJECT IS UNENFORCED (no verify-marker). Sync: cp ../build-policy/templates/pre-commit .husky/pre-commit',
      );
    } else ok('Pre-commit hook matches shared template');
  }

  // Dependabot config template drift (quote-style-insensitive) — presence-only
  // checking let projects fork on cooldown settings
  const dbPath = path.join(dir, '.github/dependabot.yml');
  if (exists(dbPath)) {
    const norm = (s) => s.replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
    if (norm(readFile(dbPath)) !== norm(readFile(path.join(TEMPLATES, 'dependabot.yml')))) {
      fail(
        'dependabot.yml differs from the shared template — sync: cp ../build-policy/templates/dependabot.yml .github/dependabot.yml (deviations belong in the template)',
      );
    } else ok('Dependabot config matches shared template');
  }

  // AGENTS.md template drift (non-Claude agents rely on this being current)
  const agPath = path.join(dir, 'AGENTS.md');
  if (exists(agPath)) {
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    if (norm(readFile(agPath)) !== norm(readFile(path.join(TEMPLATES, 'AGENTS.md')))) {
      fail(
        'AGENTS.md differs from the shared template — sync: cp ../build-policy/templates/AGENTS.md AGENTS.md',
      );
    } else ok('AGENTS.md matches shared template');
  }

  // Major dependency upgrades must carry a grounded decision record
  auditMajorUpgrades(dir, proj);

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
    if (d > healthDays)
      warn(`Maintenance overdue: last 'policy health' run ${d} days ago (run: policy health)`);
    else ok(`Maintenance current (last health run ${d} days ago)`);
  } else {
    warn(`No maintenance record — run 'policy health' to establish one`);
  }

  // Dependency drift inside the declared ranges. Warns rather than fails: a
  // routine refresh should not block unrelated work. Visible every session so
  // it cannot accumulate quietly — Dependabot raises one PR per package, and
  // those queue faster than they get merged.
  // `npm outdated` is a network call taking seconds, and this runs inside the
  // SessionStart hook's 10s budget — so the result is cached and re-measured at
  // most once a day. Offline, the probe simply fails and reports nothing rather
  // than stalling the session.
  if (exists(path.join(dir, 'package.json'))) {
    const driftLimit = (reg.staleness && reg.staleness.depsDriftPackages) || 10;
    const refreshDays = (reg.staleness && reg.staleness.depsRefreshDays) || 30;
    const daysStale = state.lastDepsUpdate ? daysSince(state.lastDepsUpdate) : null;
    if (daysStale === null || daysStale > refreshDays) {
      const probeAgeHours = state.lastDriftProbe
        ? (Date.now() - Date.parse(state.lastDriftProbe)) / 3600000
        : Infinity;
      let drift = state.driftCount;
      if (probeAgeHours > 24) {
        drift = outdatedSplit(dir).inRange.length;
        state.lastDriftProbe = new Date().toISOString();
        state.driftCount = drift;
        saveState(dir, state);
      }
      if (drift > driftLimit) {
        warn(
          `${drift} dependencies behind their allowed range` +
            (daysStale === null ? '' : ` (last refresh ${daysStale} days ago)`) +
            ` — run: policy deps-update`,
        );
      }
    }
  }

  const stale = Object.entries(reg.entries || {}).filter(
    ([, e]) => daysSince(e.verified) > (e.reviewEveryDays || 90),
  );
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
  // Quota-bounded: the free tier is 1,000 scans/month across all projects, and
  // the dependency tree can only have moved if the lockfile did. CI scans every
  // push regardless — this gate exists to catch a hostile package before it is
  // committed, not to re-scan an unchanged tree several times a day.
  { name: 'Socket supply-chain scan', script: 'socket:scan', whenDepsChange: true },
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

  // A filtered lockfile installs fine here and fails CI on Linux, so it must be
  // caught before the work is presented rather than by a red pipeline later.
  // Pure JSON read, no network.
  if (!fast) {
    const before = results.fail;
    auditLockfileIntegrity(dir);
    if (results.fail > before) return finish();
  }

  // Electron ships inside the DMG but sits in devDependencies, so the `security`
  // gate's --omit=dev never sees it. Audited here rather than in `check` because
  // it is a network call and the session-start hook has a 10s budget.
  if (!fast && proj.isElectron) {
    const before = results.fail;
    auditShippedElectron(dir);
    if (results.fail > before) return finish();
  }

  // CodeRabbit preflight — both failures below surface as raw JSON from the CLI
  // mid-run, which reads as "the tool is broken" rather than "your repo is not
  // ready yet". Check them before burning the earlier gates.
  if (!fast && gates.some((g) => g.script === 'review') && proj.isGit) {
    if (!sh('git rev-parse --verify HEAD', dir).ok) {
      fail(
        'CodeRabbit needs a branch to exist (it resolves HEAD), and this repo has no commits. ' +
          'Make the root commit first — the pre-commit hook allows it — then re-run gates: ' +
          'git add -A && git commit -m "initial scaffold"',
      );
      return finish();
    }
    const hasRemote = sh('git remote', dir).out.length > 0;
    const hasBase = sh('git config coderabbit.baseBranch', dir).ok;
    if (!hasRemote && !hasBase) {
      const branch = sh('git rev-parse --abbrev-ref HEAD', dir).out || 'main';
      fail(
        `CodeRabbit cannot determine a base branch (no git remote configured yet). Set it once: ` +
          `git config coderabbit.baseBranch ${branch}`,
      );
      return finish();
    }
  }

  // The dependency tree cannot have moved unless the lockfile did, so a scan of
  // an unchanged tree spends quota to re-learn what the last one already knew.
  const depsChanged = changedFiles(dir).some((f) => /(^|\/)package(-lock)?\.json$/.test(f));

  const report = [];
  for (const g of gates) {
    if (g.whenDepsChange && !depsChanged) {
      console.log(
        `  ${DIM}skipped${RESET} ${g.name} ${DIM}(no dependency change — CI scans every push)${RESET}`,
      );
      continue;
    }
    const t0 = Date.now();
    process.stdout.write(`  ${DIM}running${RESET} ${g.name} (npm run ${g.script}) ... `);
    const r = sh(`npm run ${safeToken(g.script, 'script name')}`, dir);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    // A gate that ran but examined nothing is not a pass. CodeRabbit exits 0
    // with `"status":"review_skipped","message":"No changes detected"` whenever
    // the tree is clean and the branch equals its base — the normal state right
    // after a commit. Trusting the exit code alone recorded "CodeRabbit review:
    // pass" into the marker for code the reviewer never opened, which is how a
    // whole committed scaffold can end up shipped unreviewed.
    const reviewSkipped = g.script === 'review' && /"status"\s*:\s*"review_skipped"/.test(r.out);
    if (r.ok && !reviewSkipped) {
      console.log(`${GREEN}pass${RESET} ${DIM}${secs}s${RESET}`);
      report.push({ gate: g.name, pass: true });
    } else if (reviewSkipped) {
      console.log(`${RED}FAIL${RESET} ${DIM}${secs}s${RESET}\n`);
      console.log(
        `${RED}${BOLD}Gate failed: ${g.name} reviewed nothing.${RESET} CodeRabbit reported "No changes detected" — ` +
          `the working tree is clean, so it had no diff to read, and a pass here would claim a review that never happened.\n\n` +
          `If this code is already committed and was never reviewed, review it against the commit before it:\n` +
          `  coderabbit review --agent --base-commit <sha-before-the-work>\n` +
          `For a root commit (nothing precedes it), review it as a PR on the remote, or in a scratch repo:\n` +
          `  copy the files out, git init, git commit --allow-empty -m base, leave the files untracked,\n` +
          `  git config coderabbit.baseBranch <branch>, then: coderabbit review --agent --include-untracked\n`,
      );
      process.exit(1);
    } else {
      console.log(`${RED}FAIL${RESET} ${DIM}${secs}s${RESET}\n`);
      const tail = r.out.split('\n').slice(-40).join('\n');
      console.log(tail);
      console.log(
        `\n${RED}${BOLD}Gate failed: ${g.name}.${RESET} Fix, then re-run FULL gates (a commit needs the full-gates marker): policy gates\n` +
          (fast
            ? `${DIM}(--fast is only the pre-commit subset — it does not write the marker)${RESET}\n`
            : ''),
      );
      process.exit(1);
    }
  }

  if (!fast) {
    const verifiedFiles = changedFiles(dir)
      .filter((f) => !f.startsWith('.policy/'))
      .sort();
    const marker = {
      diffHash: diffHash(dir),
      // Recorded so the marker survives the commit, which empties the
      // changed-file list without altering any verified content.
      files: verifiedFiles,
      contentHash: contentHash(dir, verifiedFiles),
      timestamp: new Date().toISOString(),
      gates: report.map((r) => r.gate),
    };
    fs.mkdirSync(path.join(dir, '.policy'), { recursive: true });
    // Trailing newline keeps the marker prettier-clean in projects where
    // .policy/ isn't (yet) gitignored/prettierignored.
    fs.writeFileSync(
      path.join(dir, '.policy', 'gates.json'),
      JSON.stringify(marker, null, 2) + '\n',
    );
  }
  console.log(
    `\n${GREEN}${BOLD}All ${report.length} gates passed.${RESET}${fast ? '' : ' Marker written (.policy/gates.json).'}\n`,
  );
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

  // Root commit: CodeRabbit cannot run before a branch exists (it resolves the
  // current branch via `git rev-parse --abbrev-ref HEAD`), so full gates cannot
  // pass, so the marker cannot be written — and blocking here would deadlock a
  // new repo into needing --no-verify. Gating a check that is impossible to run
  // teaches people to bypass the hook, which costs more than this commit.
  // Allowed once; every commit after this one has a HEAD and is gated normally.
  if (!sh('git rev-parse --verify HEAD', dir).ok) {
    console.log(
      `${YELLOW}!${RESET} Root commit (no HEAD yet) — full gates cannot run before a branch exists; allowing.\n` +
        `  ${DIM}Immediately after this commit: policy gates — the review gate then sees the whole tree.${RESET}`,
    );
    return;
  }

  const sourceChanged = changedFiles(dir).filter(isSourceFile);
  if (sourceChanged.length === 0) return;
  const marker = readJSON(path.join(dir, '.policy', 'gates.json'));
  if (markerMatches(dir, marker)) {
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
  else if (!markerMatches(dir, marker))
    fail(
      `Working tree changed since gates last passed (${marker.timestamp}) — re-run 'policy gates'`,
    );
  else
    ok(
      `Gates passed for the current working tree (${marker.gates.length} gates, ${marker.timestamp})`,
    );

  // 2. CHANGELOG updated alongside source changes
  const changed = changedFiles(dir);
  const sourceChanged = changed.filter(isSourceFile);
  if (
    proj.pkg &&
    proj.pkg.version &&
    sourceChanged.length > 0 &&
    builtDmgVersions(dir).has(proj.pkg.version)
  ) {
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
          fail(
            `NEW API routes with no smoke coverage (cover them before shipping): ${fresh.join(', ')}`,
          );
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

  // Major dependency upgrades must carry a grounded decision record
  auditMajorUpgrades(dir, proj);

  if (release) verifyRelease(dir, proj, flags);
  return finish();
}

// Banner verification exploits the deliberate mismatch check (app version !==
// site version.json => banner): installing the new DMG while the site still
// lists the old version proves the banner machinery fires; updating the site
// then proves the match clears it. Same code path a real user's old app hits.
// Not every project ships the same way, and a checklist listing steps the
// project cannot perform gets signed anyway — which destroys the meaning of the
// signature. `gumroad` is the paid-app flow. `none` is an app that builds a DMG
// but is not distributed yet, so there is nothing to upload and no site version
// to compare a banner against. `internal` covers everything with no DMG at all:
// PM2 web apps, CLIs, libraries.
const RELEASE_CHECKLISTS = {
  gumroad: [
    'Installed new DMG over previous (dogfood): data migrated, settings intact, first-run + one core flow work',
    'Update banner VISIBLE in the new build (site version.json still lists the previous version)',
    'Uploaded new DMG to Gumroad, then updated site version.json + changelog + listing',
    'Update banner CLEARED after site update (versions match; relaunch app to re-fetch)',
    'Release marketing drafts prepped in app-marketing',
  ],
  none: [
    'Installed new DMG over previous (dogfood): data migrated, settings intact, first-run + one core flow work',
    'Not distributed yet: no upload or site listing for this version. Set "policy": {"distribution": "gumroad"} in package.json when it ships',
  ],
  internal: [
    'Rebuilt and restarted (npm run build && pm2 restart <app>); one core flow verified in the running app',
    'If the project is published (site, npm, GitHub release): listing and changelog updated',
  ],
};

/**
 * How this project reaches its users, which decides the release checklist.
 * Declared per project via package.json `policy.distribution`; inferred
 * otherwise, since most Electron apps here are sold through Gumroad and
 * everything else is deployed locally.
 */
function releaseProfile(proj) {
  const declared = proj.pkg && proj.pkg.policy && proj.pkg.policy.distribution;
  if (declared && RELEASE_CHECKLISTS[declared]) return declared;
  return proj.isElectron ? 'gumroad' : 'internal';
}

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
  } else
    warn(
      'No git tags found — tag releases so version bumps are verifiable (git tag v<version> at each release commit)',
    );

  // CHANGELOG top entry IS this version (includes() would match old entries)
  const relTopVer = changelogTopVersion(dir);
  if (proj.pkg && relTopVer === proj.pkg.version)
    ok(`CHANGELOG top entry matches release version (${relTopVer})`);
  else
    fail(
      `CHANGELOG top entry (${relTopVer || 'none'}) is not the release version (${proj.pkg && proj.pkg.version}) — bump/align before shipping`,
    );

  // Third-party attribution shipped
  if (proj.isElectron) {
    const attribPath = path.join(dir, 'THIRD-PARTY-LICENSES.txt');
    if (exists(attribPath)) {
      // The file ships to customers and is committed to public repos, so it
      // must not carry the build machine's home directory.
      const homePaths = (readFile(attribPath).match(/\/Users\/[^/\s]+/g) || []).length;
      if (homePaths > 0) {
        fail(
          `THIRD-PARTY-LICENSES.txt contains ${homePaths} absolute home paths (e.g. /Users/<name>/...) — regenerate with 'npm run licenses:file' (the standard script strips the build root)`,
        );
      } else ok('Third-party license attribution file present');
    } else {
      fail(
        `Missing THIRD-PARTY-LICENSES.txt — run 'npm run licenses:file' and include it in the build`,
      );
    }
  }

  // Release tag. The version-bump check above reads `git describe --tags`, but
  // nothing in this tool ever created a tag and the workflow never named the
  // step, so 21 of 24 projects had none and the check silently degraded to a
  // warning. A tag is the durable record of what shipped: `release/` gets
  // cleaned and DMGs get rebuilt, and then nothing else marks the commit a
  // version was cut from. Enforced at sign-off rather than earlier, because the
  // developer creates the tag, and only once the release is real.
  const profile = releaseProfile(proj);
  const checklist = RELEASE_CHECKLISTS[profile];
  // Only the DMG-producing profiles have an artifact to stage the checklist on.
  const buildsArtifact = profile === 'gumroad' || profile === 'none';

  const tagName = `v${proj.pkg.version}`;
  const tagExists =
    sh(`git tag --list ${safeToken(tagName, 'git tag')}`, dir).out.trim() === tagName;
  const tagAtHead = sh('git tag --points-at HEAD', dir)
    .out.split('\n')
    .map((t) => t.trim())
    .includes(tagName);

  // Manual checklist acknowledgment (recorded per version)
  const state = loadState(dir);
  const ackVersion = state.releaseAck && state.releaseAck.version;
  if (flags.includes('--ack-manual') && !tagExists) {
    // Refuse the signature rather than record a release with no durable marker.
    fail(
      `Release ${proj.pkg.version} is not tagged — the ack was not recorded. Tag the release commit, then re-run:\n` +
        `      git tag ${tagName} && git push origin ${tagName}`,
    );
  } else if (flags.includes('--ack-manual')) {
    if (!tagAtHead) {
      warn(`${tagName} exists but does not point at HEAD — confirm it marks the release commit`);
    } else ok(`Release tagged at HEAD (${tagName})`);
    state.releaseAck = { version: proj.pkg.version, time: new Date().toISOString() };
    saveState(dir, state);
    ok(`Manual release checklist acknowledged for ${proj.pkg.version}`);
  } else if (ackVersion === proj.pkg.version) {
    ok(
      `Manual release checklist previously acknowledged for ${proj.pkg.version} (${state.releaseAck.time})`,
    );
  } else if (buildsArtifact && !builtDmgVersions(dir).has(proj.pkg.version)) {
    // Pre-build stage, for profiles that produce a DMG. Every item on the
    // checklist needs the artifact that does not exist yet (install it, see the
    // banner, upload it), so failing here states an impossibility: the build
    // order is gates -> commit -> build, and the checklist comes after all
    // three. Reported as pending, not as a blocker — a FAIL here sent sessions
    // hunting for a way to satisfy it before the build, which is the one order
    // the policy forbids.
    ok(`Pre-build checks passed for ${proj.pkg.version} — build the DMG next`);
    console.log(
      `      ${DIM}The manual checklist below is performed AFTER the build, then signed off with:${RESET}\n` +
        `      ${DIM}  policy verify-ready --release --ack-manual   (developer runs this personally)${RESET}`,
    );
    for (const item of checklist) console.log(`      ${DIM}•${RESET} ${item}`);
    if (!tagExists) {
      // Suggested after the build rather than before it: a tag pushed ahead of
      // a build that then fails notarization, or a release later abandoned,
      // marks a version that never shipped.
      console.log(
        `      ${DIM}•${RESET} Once the DMG builds and verifies, tag the release commit (the sign-off refuses an untagged release):\n` +
          `        ${DIM}git tag ${tagName} && git push origin ${tagName}${RESET}`,
      );
    }
  } else {
    fail(
      buildsArtifact
        ? `A DMG exists for ${proj.pkg.version} but the manual release checklist is not acknowledged. Perform these, then re-run with --ack-manual:`
        : `Release checklist for ${proj.pkg.version} not acknowledged (${profile} release). Perform these, then re-run with --ack-manual:`,
    );
    for (const item of checklist) console.log(`      ${DIM}•${RESET} ${item}`);
  }
}

// ------------------------------------------------------------------ health

/**
 * Split outdated packages into what the declared ranges already allow and what
 * needs a range change. `current !== wanted` is reachable by `npm update`;
 * anything else is a major and goes through `policy upgrade <pkg>`.
 */
function outdatedSplit(dir) {
  const raw = sh('npm outdated --json', dir);
  let list = {};
  try {
    list = JSON.parse(raw.out || '{}');
  } catch {
    /* non-JSON output, treat as none */
  }
  const entries = Object.entries(list);
  return {
    // Installed, and a newer version already permitted by the declared range.
    inRange: entries.filter(([, v]) => v.current && v.wanted && v.current !== v.wanted),
    // Installed and at the top of its range, but a newer major exists.
    majorOnly: entries.filter(
      ([, v]) => v.current && v.current === v.wanted && v.latest !== v.wanted,
    ),
    // Not installed at all: `npm outdated` reports these with no `current`.
    // They are an install problem, not a drift problem.
    missing: entries.filter(([, v]) => !v.current),
  };
}

/**
 * Refresh dependencies inside their declared ranges.
 *
 * Dependabot covers the same ground, but one PR per package: a weekly trickle
 * that needs a review-scan-merge cycle each. They queue faster than they clear
 * (12 open PRs and 24 days of drift on one app when this was written), so the
 * lockfile ages while local work continues against it. This does the same
 * updates in one pass, to be verified once by a full gates run.
 *
 * Safe by construction rather than by care: `npm update` does not rewrite the
 * semver ranges in package.json (npm's own docs), and with save-prefix `^` that
 * confines it to minor and patch. Majors still require `policy upgrade <pkg>`
 * and its decision record. The lockfile changing makes `gates` run the Socket
 * supply-chain scan, and `min-release-age=1` quarantines anything published in
 * the last 24 hours.
 */
function cmdDepsUpdate(dir) {
  guardLocalPath(dir);
  const proj = detectProject(dir);
  section(`Dependency refresh: ${path.resolve(dir)}`);
  if (!proj.hasPkg) {
    ok('No package.json — nothing to update');
    return finish();
  }

  const { inRange, majorOnly, missing } = outdatedSplit(dir);
  if (missing.length > 0) {
    warn(
      `${missing.length} declared dependency/ies not installed (${missing
        .map(([n]) => n)
        .slice(0, 5)
        .join(', ')}) — run npm install first`,
    );
  }
  if (inRange.length === 0) {
    ok('All dependencies current within their declared ranges');
  } else {
    console.log(`  ${inRange.length} package(s) behind their allowed range:`);
    for (const [name, v] of inRange.slice(0, 15)) {
      console.log(`    ${DIM}${name} ${v.current} → ${v.wanted}${RESET}`);
    }
    if (inRange.length > 15) console.log(`    ${DIM}...and ${inRange.length - 15} more${RESET}`);
  }
  if (majorOnly.length > 0) {
    console.log(
      `  ${DIM}${majorOnly.length} package(s) need a major bump — not touched here; use: policy upgrade <pkg>${RESET}`,
    );
  }

  if (inRange.length > 0) {
    process.stdout.write(`  ${DIM}running${RESET} npm update ... `);
    const r = sh('npm update', dir);
    if (!r.ok) {
      console.log(`${RED}FAILED${RESET}\n`);
      console.log(r.out.split('\n').slice(-20).join('\n'));
      fail('npm update failed — dependencies unchanged');
      return finish();
    }
    console.log(`${GREEN}done${RESET}`);
    const after = outdatedSplit(dir);
    ok(`${inRange.length - after.inRange.length} package(s) updated within range`);
    if (after.inRange.length > 0) {
      warn(
        `${after.inRange.length} still behind: ${after.inRange
          .map(([n]) => n)
          .slice(0, 6)
          .join(', ')} — usually a transitive pin held by another dependency`,
      );
    }
  }

  const state = loadState(dir);
  state.lastDepsUpdate = new Date().toISOString();
  saveState(dir, state);

  if (inRange.length > 0) {
    console.log(
      `\n  ${BOLD}Lockfile changed. Next:${RESET}\n` +
        `    node ${path.join(POLICY_ROOT, 'scripts', 'policy.js')} gates   ${DIM}(the Socket scan runs because dependencies moved)${RESET}\n` +
        `    CHANGELOG entry, then the developer commits\n`,
    );
  }
  return finish();
}

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
    else
      warn(
        `${n} outdated dependencies: ${Object.keys(list).slice(0, 8).join(', ')}${n > 8 ? ', ...' : ''}`,
      );

    // Production deps: blocking (this is what ships). Full tree incl dev:
    // visibility only — dev-only advisories are maintenance work, not ship
    // blockers (the gate's --omit=dev scope relies on this check existing).
    const audit = sh('npm audit --audit-level=high --omit=dev', dir);
    if (audit.ok) ok('npm audit clean at high level (production deps)');
    else
      fail(
        `npm audit found high/critical issues in production deps:\n${audit.out.split('\n').slice(-15).join('\n')}`,
      );
    const fullAudit = sh('npm audit --audit-level=high', dir);
    if (!fullAudit.ok && audit.ok) {
      warn(
        `dev-chain advisories at high (not shipped — fix when upstream allows, do NOT weaken the gate):\n${fullAudit.out.split('\n').slice(-10).join('\n')}`,
      );
    } else if (fullAudit.ok && audit.ok) {
      ok('npm audit clean at high level (full tree incl dev)');
    }

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
  // Gate audits SHIPPED (production) deps at high — dev deps don't ship, and
  // their real threat (malicious packages) is covered by Socket + allowlist +
  // cooldown, which npm audit can't see anyway. `policy health` audits the
  // FULL tree incl dev and warns on dev-only advisories. Decided 2026-07-25
  // after sessions improvised (omit=dev in some projects, a silently weakened
  // audit-level in another) when a dev-chain advisory blocked commits.
  security: 'npm audit --audit-level=high --omit=dev',
  // The four sanctioned global exclusions (triaged FPs, documented in
  // project-standards § Semgrep rule exclusions). Anything else is per-line
  // `// nosemgrep` — enforced below in cmdCheck.
  sast: 'semgrep scan --config auto --error --quiet --exclude-rule javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal --exclude-rule javascript.express.security.audit.express-path-join-resolve-traversal.express-path-join-resolve-traversal --exclude-rule javascript.express.security.audit.express-res-sendfile.express-res-sendfile --exclude-rule javascript.express.security.audit.remote-property-injection.remote-property-injection --exclude-rule html.security.audit.missing-integrity.missing-integrity',
  secrets: 'betterleaks git . -v',
  licenses: "license-checker --production --failOn 'GPL-2.0;GPL-3.0;AGPL-1.0;AGPL-3.0' --summary",
  // The attribution file ships to customers and is committed to public repos,
  // so it must not carry the build machine's home directory. license-checker
  // prints absolute paths in both `path:` and `licenseFile:`; --relativeLicensePath
  // fixes only the latter and --customPath cannot drop a field, so the build
  // root is stripped directly. `.` is the project's own entry.
  'licenses:file':
    'license-checker --production --relativeLicensePath | sed -e "s|$PWD/||g" -e "s|$PWD|.|g" > THIRD-PARTY-LICENSES.txt',
  'deps:check': 'node ../build-policy/scripts/check-allowlist.js .',
  'deps:verify': 'node ../build-policy/scripts/verify-package.js',
  // --include-untracked is load-bearing: the CLI's default reviews TRACKED
  // changes only, and gates run before staging, so every brand-new file went
  // through the review gate unseen — the files most in need of review were the
  // ones it skipped. Verified: an untracked file is reviewed with this flag
  // (reviewType "all", reviewedFiles ["app.js"]) and ignored without it.
  review: 'coderabbit review --agent --include-untracked',
  // `socket ci` = `socket scan create --report`, exits non-zero when the scan
  // fails the org's security policy. Uses the API token's default org, so no
  // org argument to drift. This is the only gate that covers a malicious
  // maintainer or typosquat — npm audit sees published CVEs, the allowlist sees
  // names, neither sees a package that turned hostile in its latest release.
  'socket:scan': 'socket ci',
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
  copy('prettierrc', '.prettierrc');
  // Scaffolded with placeholders intact; `check` keeps failing until they are
  // replaced, so this hands over a skeleton rather than closing the gap.
  copy('CLAUDE.md', 'CLAUDE.md');
  if (proj.hasHTML) copy('htmlvalidate.json', '.htmlvalidate.json');
  if (proj.hasCSS) copy('stylelintrc.json', '.stylelintrc.json');
  if (proj.isElectron) {
    copy('entitlements.mac.plist', 'build/entitlements.mac.plist');
    // The mandatory patterns as working code. Without these, building a new
    // Electron app meant copying whichever project was nearest, which is how a
    // one-off divergence (an in-app licence gate, safeStorage, a hardcoded
    // port) spreads as though it were house style.
    copy('electron-main.js', 'electron/main.js');
    copy('secret-storage.js', 'server/secret-storage.js');
  }

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
    const fastParts = [
      'lint',
      proj.hasHTML && 'lint:html',
      proj.hasCSS && 'lint:css',
      'format:check',
      proj.isTS && 'type-check',
    ]
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
  console.log(
    `\nRe-run 'policy check' to see remaining gaps (devDependencies must be installed manually).\n`,
  );
}

// ------------------------------------------------------------------ mirror

/**
 * Commit-time privacy guard. `check` reports these at session start, which is
 * a report, not a control — a session can proceed past it, and the finding that
 * prompted this ran for days before anyone acted. Security checks belong in the
 * hook that blocks, so this runs from pre-commit in every project and exits
 * non-zero on any finding. Fast by construction: two git commands, no network.
 */
function cmdLeakScan(dir) {
  guardLocalPath(dir);
  const proj = detectProject(dir);
  if (!proj.isGit) {
    ok('Not a git repository — nothing to scan');
    return finish();
  }
  section(`Privacy scan: ${path.resolve(dir)}`);
  auditTrackedPrivacy(dir);
  return finish();
}

function cmdMirror() {
  section('Public mirror check');
  if (!exists(PUBLIC_ROOT)) {
    fail(`Public mirror not found at ${PUBLIC_ROOT}`);
    return finish();
  }

  // Self-consistency first: two copies agreeing on a stale header is not
  // "in sync", so each side must match its own version history before the
  // private-vs-public comparison means anything.
  auditPolicyDocVersions(POLICY_ROOT, 'private');
  auditPolicyDocVersions(PUBLIC_ROOT, 'public mirror');

  // Drift: private docs newer or version-different vs public
  for (const doc of ['BUILD-POLICY.md', 'project-standards.md']) {
    const priv = readFile(path.join(POLICY_ROOT, doc));
    const pub = readFile(path.join(PUBLIC_ROOT, doc));
    const ver = (s) => (s.match(/\*\*Version:\*\*\s*([\d.]+)/) || [])[1];
    if (!pub) fail(`${doc} missing from public mirror`);
    else if (ver(priv) !== ver(pub))
      fail(`${doc} version drift: private ${ver(priv)} vs public ${ver(pub)}`);
    else ok(`${doc} versions match (${ver(priv)})`);
  }

  // Drift: scripts/ and templates/ are mirrored verbatim ("enforcement is
  // publicly verifiable") — any byte difference means the mirror is stale.
  for (const sub of ['scripts', 'templates']) {
    const privDir = path.join(POLICY_ROOT, sub);
    const pubDir = path.join(PUBLIC_ROOT, sub);
    const list = (d) => (exists(d) ? fs.readdirSync(d).filter((f) => !f.startsWith('.')) : []);
    const names = [...new Set([...list(privDir), ...list(pubDir)])].sort();
    const stale = names.filter(
      (f) => readFile(path.join(privDir, f)) !== readFile(path.join(pubDir, f)),
    );
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
    .map((l) =>
      l.startsWith('!') ? { term: l.slice(1), everywhere: true } : { term: l, everywhere: false },
    );
  // Portfolio detail is not a "leak" by term or pattern — it names nothing
  // private — but it describes the private estate (how many projects exist,
  // which were non-compliant, what remediation is outstanding) and means
  // nothing to a public reader. It reached the public changelog because the
  // scans below look for identifiers, not for internal operational prose.
  // Version history entries belong in both copies; the remediation actions
  // belong only in the private one.
  const internalProse = [/\b\d+\s+projects?\b/i, /\bAction:/];
  for (const doc of ['BUILD-POLICY.md', 'project-standards.md']) {
    const content = readFile(path.join(PUBLIC_ROOT, doc));
    for (const re of internalProse) {
      const m = content.match(re);
      if (m) {
        fail(
          `Internal portfolio detail in public mirror ${doc}: "${m[0]}" — remediation counts and per-project actions stay in the private copy; the public entry states the rule and its enforcement only`,
        );
      }
    }
  }

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
            const all =
              content.match(
                new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'),
              ) || [];
            // Placeholders are documentation, not leaks. Same exemption list as
            // the tracked-file scan in `check`, applied to paths as well as
            // emails — the docs demonstrate the rule using `/Users/you/...`.
            const hit = all.find(
              (s) =>
                !PLACEHOLDER_ID.test(s.replace(/^\/(?:Users|home)\//, '').replace(/@.*$/, '')) &&
                s !== 'xxxx-xxxx-xxxx-xxxx',
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
  if (/^min-release-age\s*=\s*1/m.test(npmrc))
    ok('~/.npmrc min-release-age=1 (24h package quarantine)');
  else fail('~/.npmrc missing min-release-age=1');

  const settings = readJSON(path.join(os.homedir(), '.claude', 'settings.json')) || {};
  const settingsStr = JSON.stringify(settings);
  if (settingsStr.includes('policy.js') || settingsStr.includes('session-start'))
    ok('Claude Code hooks configured in ~/.claude/settings.json');
  else warn('Claude Code hooks not wired — run: policy setup-machine');

  const agentsDir = path.join(os.homedir(), '.claude', 'agents');
  const agents = exists(agentsDir)
    ? fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'))
    : [];
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

  // 3. Public-mirror pre-push guard. Lives in .git/hooks (not versioned), so
  // it is machine wiring like the rest of this command — a fresh clone of the
  // mirror can otherwise push unchecked.
  const mirrorHooks = path.join(PUBLIC_ROOT, '.git', 'hooks');
  if (exists(mirrorHooks)) {
    const dest = path.join(mirrorHooks, 'pre-push');
    fs.copyFileSync(path.join(MACHINE, 'mirror-pre-push.sh'), dest);
    fs.chmodSync(dest, 0o755);
    ok(`Installed public-mirror pre-push guard at ${dest}`);
  } else {
    warn(`Public mirror not found at ${PUBLIC_ROOT} — pre-push guard not installed`);
  }

  // 4. Hooks — merge into settings.json, never clobber existing config
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
  if (!markerMatches(dir, marker)) {
    reasons.push(
      `Full quality gates have NOT passed on the current tree` +
        (marker
          ? ` (last pass: ${marker.timestamp}, tree has changed since)`
          : ' (no gates marker)') +
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
  //
  // Deliberately matched anywhere in the command, which also denies harmless
  // mentions (writing documentation about the flag through a shell heredoc).
  // That false positive is the cheap side of the trade: narrowing the pattern
  // to an invocation shape risks missing a real one. Write docs with the file
  // tools instead of the shell.
  if (input.tool_name === 'Bash' && /--ack-manual/.test(cmd)) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            "BUILD-POLICY: --ack-manual is the DEVELOPER's signature that the manual release checks were personally performed — the AI must never run it. " +
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

// ------------------------------------------------------------------ upgrade

// Ground a major dependency upgrade in registry facts, not model memory.
// Pulls the target's real peer-dependency constraints, the installed version,
// and the upstream migration source from npm, prints them, and scaffolds a
// decision record the session must complete before `check`/`verify-ready` pass.
// The whole point: the fabrication-prone facts (peer constraints, breaking
// changes) come from `npm view`, and the record carries them forward so the
// next session reads the finding instead of re-deriving it differently.
function cmdUpgrade(dir, rest) {
  const args = rest.filter((a) => !a.startsWith('--'));
  const pkgName = args[0];
  if (!pkgName) {
    console.error('Usage: node policy.js upgrade <package> [targetVersion] [projectDir]');
    process.exit(1);
  }
  safeToken(pkgName, 'package name');
  // Remaining positional args: an explicit target version (starts with a digit)
  // and/or a project dir. Everything defaults sensibly.
  // NOTE: `dir` from main() is the first non-flag positional, which for this
  // command is the package name — never a directory. Resolve the project dir
  // from the args after the package name only, else default to cwd.
  const explicit = args.slice(1).find((a) => /^\d/.test(a)) || null;
  const projDir =
    args.slice(1).find((a) => a !== explicit && exists(path.join(a, 'package.json'))) || '.';
  if (explicit) safeToken(explicit, 'target version');
  guardLocalPath(projDir);
  const proj = detectProject(projDir);
  section(`Upgrade research: ${pkgName}`);
  if (!proj.hasPkg) {
    fail(`No package.json in ${path.resolve(projDir)}`);
    return finish();
  }

  const deps = { ...(proj.pkg.dependencies || {}), ...(proj.pkg.devDependencies || {}) };
  const currentRange = deps[pkgName] || null;
  if (!currentRange) warn(`${pkgName} is not a direct dependency — recording anyway`);

  // FACTS FROM NPM (authoritative — never from memory)
  const latest = sh(`npm view ${pkgName} version`, projDir);
  const targetVersion = explicit || (latest.ok ? latest.out.trim() : null);
  if (!targetVersion) {
    fail(
      `Could not resolve a target version via 'npm view ${pkgName} version' — is the name correct / registry reachable?`,
    );
    return finish();
  }
  const targetMajor = semverMajor(targetVersion);
  const installedJson = readJSON(path.join(projDir, 'node_modules', pkgName, 'package.json'));
  const installedVersion = installedJson ? installedJson.version : '(not installed)';

  const peerRaw = sh(`npm view ${pkgName}@${targetVersion} peerDependencies --json`, projDir);
  let peers = {};
  try {
    peers = JSON.parse(peerRaw.out || '{}') || {};
  } catch {
    /* no peers or non-JSON */
  }
  const repoRaw = sh(
    `npm view ${pkgName}@${targetVersion} repository.url homepage --json`,
    projDir,
  );
  let repoUrl = '';
  try {
    const r = JSON.parse(repoRaw.out || '{}');
    repoUrl = ((r && (r['repository.url'] || r.homepage)) || repoRaw.out || '')
      .toString()
      .replace(/^git\+/, '')
      .replace(/\.git$/, '')
      .trim();
  } catch {
    repoUrl = repoRaw.out.trim();
  }

  // Peer-constraint analysis — the exact class of fact that gets fabricated.
  const peerLines = Object.entries(peers).map(([p, need]) => {
    const have = deps[p];
    const flag =
      have &&
      semverMajor(have) != null &&
      semverMajor(need) != null &&
      semverMajor(have) < semverMajor(need)
        ? '  ⚠ project below required major'
        : '';
    return `  - ${p} requires ${need}${have ? ` (project has ${have})` : ' (not in project)'}${flag}`;
  });

  ok(`Target: ${pkgName} ${installedVersion} → ${targetVersion} (major v${targetMajor})`);
  console.log(`  Current range in package.json: ${currentRange || '(none)'}`);
  console.log(`  Peer dependencies of ${targetVersion}:`);
  console.log(peerLines.length ? peerLines.join('\n') : '    (none declared)');
  console.log(
    `  Upstream source: ${repoUrl || '(none found — check npmjs.com/package/' + pkgName + ')'}`,
  );

  // Scaffold the decision record (never overwrite an existing one)
  const recDir = path.join(projDir, '.claude', 'specs', 'deps');
  const recPath = path.join(recDir, `${depRecordSlug(pkgName, targetMajor)}.md`);
  if (exists(recPath)) {
    warn(
      `Decision record already exists: ${path.relative(projDir, recPath)} — update it, don't duplicate`,
    );
    return finish();
  }
  fs.mkdirSync(recDir, { recursive: true });
  const peerBlock = Object.entries(peers).length
    ? Object.entries(peers)
        .map(
          ([p, need]) =>
            `- \`${p}\`: requires \`${need}\`${deps[p] ? ` — project has \`${deps[p]}\`` : ' — not in project'}`,
        )
        .join('\n')
    : '- (none declared)';
  const record = `# Major upgrade: ${pkgName} → v${targetMajor}

**Package:** ${pkgName}
**From:** ${installedVersion} (range \`${currentRange || 'n/a'}\`)  **To:** ${targetVersion}
**Researched:** ${new Date().toISOString().slice(0, 10)}
**Status:** DRAFT — do not merge until completed and gates pass

---

## Verified facts (from \`npm view\` — DO NOT edit, DO NOT supplement from memory)

**Peer dependencies of ${pkgName}@${targetVersion}:**
${peerBlock}

**Upstream migration source:** ${repoUrl || '(look up on npmjs.com)'}
> Read the CHANGELOG / release notes for the v${targetMajor}.0.0 boundary before writing the plan below.

---

## To complete (cite the facts above — never recalled knowledge)

### Peer-constraint resolution
For each ⚠ peer above where the project is below the required major: what has to move first? (A peer bump is itself a major upgrade needing its own record.)

### Breaking changes (from the upstream migration guide, with the section link)
-

### Migration steps
1.

### Risk & blast radius
- Files/features touched:
- Rollback plan:

### Verification
- [ ] \`npm install\` clean, no unmet peer warnings
- [ ] \`policy gates\` pass on the upgraded tree
- [ ] Decision: PROCEED / DEFER / REJECT —
`;
  fs.writeFileSync(recPath, record);
  ok(`Scaffolded decision record: ${path.relative(projDir, recPath)}`);
  console.log(
    `\n${DIM}Complete the "To complete" sections from the upstream guide, then 'policy check' will pass.${RESET}`,
  );
  return finish();
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
    case 'deps-update':
      return cmdDepsUpdate(dir);
    case 'upgrade':
      return cmdUpgrade(dir, rest);
    case 'scaffold':
      return cmdScaffold(dir);
    case 'mirror':
      return cmdMirror();
    case 'leak-scan':
      return cmdLeakScan(dir);
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
