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
 *                         --all           every project beside build-policy, as a table
 *   sync-templates [dir] Overwrite the drift-checked files (ci.yml, dependabot.yml,
 *                         .husky/pre-commit, AGENTS.md, .nvmrc) from the templates;
 *                         one project at a time, and the change still needs its gates
 *   gates [dir]         Run quality gates in order; writes .policy/gates.json marker
 *                         --fast          pre-commit subset (validate + secrets)
 *                         --with-review   force the CodeRabbit gate on a source-free diff
 *                                         (it is skipped there to protect the CLI allowance)
 *   verify-marker [dir] Pre-commit: block commit if source changed without a full-gates
 *                         pass on this exact tree (called from .husky/pre-commit)
 *   security-ack [dir]  Record that /security-review was run over the security-sensitive
 *                         files in the current diff (auth, secrets, crypto, CORS, payment,
 *                         data deletion). verify-ready FAILs without it when they change.
 *   verify-ready [dir]  Confirm gates marker matches current diff + changelog updated
 *                         --release      add release checks (version, attribution, checklist)
 *                         --ack-manual   record that manual release checks were performed
 *   health [dir]        Maintenance run: outdated, audit, registry staleness; records timestamp
 *                         --socket   include a Socket supply-chain scan (uses quota)
 *   upgrade <pkg>       Ground a MAJOR dependency upgrade: pull real peer-dep constraints
 *                         + migration source from npm, scaffold a decision record under
 *                         .claude/specs/deps/. check/verify-ready FAIL on an un-recorded major.
 *   approve-exception <GHSA-id>  Developer's approval of an advisory exception
 *                         (records a hash of the entry in audit-approvals.json)
 *   scaffold [dir]      Create missing standard files/scripts (never overwrites)
 *   leak-scan [dir]     Pre-commit: private files tracked, home paths in tracked files
 *   mirror              Check public mirror for drift and private-detail leaks
 *   mirror-sync         Copy scripts/, templates/ + tests/ to the public mirror and bump
 *                         its headers; public prose is still written by hand
 *   handoff             The session holding the build-policy claim declares its change
 *                         complete; review, mirror and commit move to a build-policy session
 *
 * Hook modes (called by Claude Code hooks, not humans):
 *   check --hook        Terse output for SessionStart injection; always exits 0
 *   hook-stop           Stop hook: block turn-end if source changed without CHANGELOG entry
 *                         or without a full-gates pass on the current tree
 *   hook-pretool        PreToolUse hook: block electron:build on a dirty tree;
 *                         redirect raw `semgrep scan` to `npm run sast`;
 *                         nudge search/survey commands toward delegation
 *   hook-posttool       PostToolUse/PostToolUseFailure hook: when a DMG build's
 *                         notarization cannot reach the keychain profile from the
 *                         session, hand the build to the developer's Terminal
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
// Set while the audit runs inside another command (gates), where finish()
// must return rather than end the process.
let embedded = false;

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
 * Run a command with an argv array and no shell.
 *
 * Use this whenever an argument comes from the filesystem or a scraped file:
 * `sh()` builds a shell string, and quoting is not protection there, because
 * `$(...)` expands inside double quotes. A DMG filename or a URL read out of
 * source is attacker-influencable in principle, and the cost of argv is
 * nothing. `--` where the tool supports it stops a hostile value being read as
 * an option.
 */
function shArgs(cmd, args, cwd) {
  try {
    const r = require('child_process').spawnSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      shell: false,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    return { ok: r.status === 0, out, code: r.status };
  } catch (e) {
    return { ok: false, out: String((e && e.message) || e), code: 1 };
  }
}

/** spctl's disk-image assessment. Its verdict goes to stderr and it exits 0 on
 *  success, so both streams are captured; see the release check for why. */
function assessDmg(dmgPath, cwd) {
  return shArgs(
    'spctl',
    ['-a', '-t', 'open', '--context', 'context:primary-signature', '-vv', '--', dmgPath],
    cwd,
  );
}

/**
 * Values interpolated into shell commands (npm script names, registry values)
 * come from trusted local files, but validate anyway so a tampered config
 * can't inject commands.
 */
function safeToken(value, label) {
  // No leading '-': a token that git or npm would parse as an option (e.g. a
  // tampered gates marker holding `--output=<path>`) is refused like any other.
  if (!/^[\w@:.\/][\w@:.\/-]*$/.test(value)) {
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

// What the gates must have passed on before a commit or a turn end. Source,
// plus the dependency manifests: a lockfile-only commit changes what CI
// installs as surely as a code change does, and treating it as "not source"
// let a lockfile CI could not install be committed with no gates at all.
const DEPENDENCY_FILE = /(^|\/)package(-lock)?\.json$/;
function isGatedFile(f) {
  return isSourceFile(f) || DEPENDENCY_FILE.test(f);
}

function currentHead(dir) {
  const r = sh('git rev-parse HEAD', dir);
  return r.ok ? r.out : null;
}

/** Files changed between two commits (null when git cannot say). */
function filesBetween(dir, from, to = 'HEAD') {
  const r = sh(`git diff --name-only ${safeToken(from, 'commit')} ${safeToken(to, 'commit')}`, dir);
  if (!r.ok) return null;
  return r.out.split('\n').filter(Boolean);
}

/**
 * Security-sensitive change detection.
 *
 * BUILD-POLICY Phase 5 has always required a security review for auth, data,
 * payment, CORS and secret changes, and named it a judgment step — which meant
 * nothing checked whether it happened. The CodeRabbit gate is now conditional
 * on source, so leaving this to memory would thin the review layer twice over.
 * `/security-review` (Claude Code, no CodeRabbit allowance) is the review;
 * `security-ack` records that it ran, bound to the content it examined.
 *
 * Deliberately two-signal — a path name OR a call that carries the risk —
 * because neither alone is enough: `server/auth.js` is obvious from its name,
 * while a CORS header or a recursive delete can land in a file called
 * anything. Patterns are narrow on purpose: a check that fires on every diff
 * gets acked reflexively and stops meaning anything.
 */
const SECURITY_PATH_PATTERNS =
  /(^|\/)(auth|session|login|logout|signup|token|password|credential|secret|crypto|encrypt|payment|billing|stripe|cors|permission|middleware)/i;
const SECURITY_CONTENT_PATTERNS = [
  /createCipheriv|createDecipheriv|safeStorage/,
  /jsonwebtoken|jwt\.(sign|verify)|bcrypt|argon2|scrypt/,
  /\bcors\s*\(|Access-Control-Allow/,
  /fs\.(rm|rmSync|unlink|unlinkSync|rmdir)\b|rimraf/,
  /DELETE\s+FROM|DROP\s+TABLE/i,
];
function securitySensitiveFiles(dir, files) {
  // In the policy repo the enforcement code is the sensitive surface.
  if (path.resolve(dir) === POLICY_ROOT)
    return files.filter((f) => /^(scripts|machine|templates)\//.test(f));
  return files.filter((f) => {
    if (!isSourceFile(f)) return false;
    if (SECURITY_PATH_PATTERNS.test(f)) return true;
    const body = readFile(path.join(dir, f));
    return body ? SECURITY_CONTENT_PATTERNS.some((re) => re.test(body)) : false;
  });
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

/** The DMG versions that count as shipped. A DMG is a copy a customer may
 *  hold only once the project distributes: with `policy.distribution` set to
 *  `none` the DMGs in release/ are test builds installed on the developer's
 *  own machine, so nothing is frozen by them and no tag or update banner is
 *  owed for them. The release-only rules (freeze, tag, banner) read this;
 *  the build hook and the post-build checklist keep reading builtDmgVersions,
 *  because they are about the artifact itself, not about customers. */
function shippedDmgVersions(dir, proj) {
  if (releaseProfile(proj) === 'none') return new Set();
  return builtDmgVersions(dir);
}

/** The DMG built for a given version, or null. Only `release/` itself is
 *  searched: `release/archive/` holds superseded builds, and assessing one of
 *  those would report on an artifact that is not being shipped. */
function releaseDmgPath(dir, version) {
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(dir, 'release'));
  } catch {
    return null;
  }
  const match = entries.find((f) => f.endsWith('.dmg') && f.includes(version));
  return match ? path.join(dir, 'release', match) : null;
}

/** Project-relative source files whose contents match `pattern`. Used to ask
 *  "does this project already do X", where X may live in any file. */
function sourceFilesMatching(dir, pattern) {
  const hits = [];
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
      if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) continue;
      if (pattern.test(readFile(full))) hits.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return hits.sort();
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

  // Commits made since the pass must contain only gated files the gates saw.
  // Without the recorded HEAD, a lockfile committed after a pass left the
  // marker valid — its content was never in the marker, so nothing compared it
  // — and a clean tree's empty diffHash matched every later clean tree.
  const head = currentHead(dir);
  if (marker.head && head && marker.head !== head) {
    const since = filesBetween(dir, marker.head);
    if (!since) return false;
    const verified = new Set(marker.files || []);
    if (since.filter(isGatedFile).some((f) => !verified.has(f))) return false;
  } else if (marker.diffHash === diffHash(dir)) return true;
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

  // The table lives in HISTORY.md (2.61): at 77 rows it was most of
  // BUILD-POLICY.md, which sessions are told to read when planning.
  const histName = historyFile(root);
  const rows = historyRows(readFile(path.join(root, histName)));
  if (rows.length === 0) {
    fail(`${label}: ${histName} version-history table has no parsable rows`);
  } else {
    const newest = rows.reduce((a, b) => (cmpSemver(b, a) > 0 ? b : a));
    if (bpVer !== newest) {
      fail(
        `${label}: BUILD-POLICY.md header says ${bpVer} but ${histName} records ${newest} — ` +
          `bump the header (a new history row without a header bump makes every citation of the version wrong)`,
      );
    } else ok(`${label}: BUILD-POLICY.md header matches ${histName} (${bpVer})`);

    // Two sessions numbering their changes from the same committed version
    // both wrote a 2.56 row; the header and ordering checks below pass on that.
    const dupes = [...new Set(rows.filter((v, i) => rows.indexOf(v) !== i))];
    if (dupes.length > 0)
      fail(
        `${label}: ${histName} has more than one row for ${dupes.join(', ')} — ` +
          `two changes were numbered from the same release; renumber the later one`,
      );

    const misordered = rows.findIndex((v, i) => i > 0 && cmpSemver(v, rows[i - 1]) > 0);
    if (misordered > 0) {
      fail(
        `${label}: ${histName} is not newest-first — ${rows[misordered]} appears below ` +
          `${rows[misordered - 1]}; the top row must be the current version`,
      );
    }

    // A change is not finished when its changelog entry is written. 2.41 was
    // left with code, standards text and a "(policy 2.41)" entry but no header
    // bump or history row, by a session opened in an app project that then
    // ended; the header and history agreed with each other at 2.40, so the
    // checks above passed. Every version the unreleased entries cite must have
    // its history row.
    const cl = readFile(path.join(root, 'CHANGELOG.md'));
    if (cl) {
      // The changelog closes a release at every policy version, the same rule
      // the apps live under (top entry matches package.json). An open
      // [Unreleased] section held 26 versions before this was checked.
      const top = (cl.match(/^##\s*\[([^\]]+)\]/m) || [])[1];
      if (top !== bpVer)
        fail(
          `${label}: CHANGELOG.md top section is [${top || 'none'}] but the policy is ${bpVer} — ` +
            `each version bump heads its entries with "## [${bpVer}] - YYYY-MM-DD"; nothing stays under [Unreleased]`,
        );
      else ok(`${label}: CHANGELOG.md top section matches the policy version (${bpVer})`);

      const topSection =
        (cl.match(/^##\s*\[[^\]]+\][^\n]*\n([\s\S]*?)(?=\n##\s*\[|$)/m) || [])[1] || '';
      const cited = [
        ...new Set([...topSection.matchAll(/\bpolicy (\d+\.\d+)\b/gi)].map((m) => m[1])),
      ];
      const unrecorded = cited.filter((v) => !rows.includes(v));
      if (unrecorded.length > 0) {
        fail(
          `${label}: CHANGELOG.md cites policy ${unrecorded.join(', ')} but ${histName} has no row for it — ` +
            `the change is half-finished: bump both doc headers and add the history row (and enforcement-table row) it describes`,
        );
      }
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

/**
 * Marketing-site checks: the update path's far end.
 *
 * A shipped DMG carries its update URL baked in, so anything it points at must
 * keep working for copies already installed. That makes two things site-side
 * obligations rather than tidiness: every app that publishes a `version.json`
 * needs the changelog page that `version.json` sends people to, and every
 * changelog page needs a download link, because a customer arriving there was
 * told an update exists and must be able to get it.
 *
 * Checked here rather than in the app repos because that is where the files
 * are, and an app cannot verify a page in a different repository.
 */
function auditSite(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const appDirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'dist')
    .map((e) => e.name)
    .filter((name) => exists(path.join(dir, name, 'version.json')));

  if (appDirs.length === 0) {
    ok('Site: no app version.json files found (nothing to check)');
    return;
  }

  for (const app of appDirs) {
    const changelogIndex = path.join(dir, app, 'changelog', 'index.html');
    if (!exists(changelogIndex)) {
      fail(
        `Site: ${app}/version.json is published but ${app}/changelog/ does not exist — ` +
          `installed copies of the app link here for release notes and would hit a 404`,
      );
      continue;
    }
    // The changelog page is where an update banner lands, so it has to carry
    // the route to the actual download. Without it the page explains what
    // changed and offers no way to get it.
    const html = readFile(changelogIndex);
    if (/gumroad\.com/.test(html)) {
      ok(`Site: ${app}/changelog/ exists and links to the download`);
    } else {
      fail(
        `Site: ${app}/changelog/ has no Gumroad link — a customer sent here by the update ` +
          `banner can read what changed but cannot download it`,
      );
    }
    // Someone arriving from the banner is mid-task and needs to know a new DMG
    // installs over the old one without losing their data. Without it the safe
    // assumption is that it might not, which stalls the update.
    if (/[Aa]pplications|install|replace|drag/.test(html)) {
      ok(`Site: ${app}/changelog/ explains how to install the update`);
    } else {
      fail(
        `Site: ${app}/changelog/ does not say how to install over an existing copy — ` +
          `a customer sent here by the banner is left guessing whether their data survives`,
      );
    }
    // The version the site advertises must be the one the page documents.
    // Otherwise the banner names a release the customer can then read nothing
    // about, which is the state that prompted this whole rule.
    const advertised = readJSON(path.join(dir, app, 'version.json'));
    if (advertised && advertised.version && !html.includes(advertised.version)) {
      fail(
        `Site: ${app}/version.json advertises ${advertised.version} but the changelog page ` +
          `does not mention it — the banner sends customers to a page with no entry for the release it named`,
      );
    }
  }

  // The URL each app is told to visit must be the changelog page. This is the
  // one end of the link that stays editable after a DMG ships, so pointing it
  // at a store means losing the update route if distribution ever moves.
  for (const app of appDirs) {
    const meta = readJSON(path.join(dir, app, 'version.json'));
    if (!meta) {
      fail(`Site: ${app}/version.json does not parse`);
      continue;
    }
    const want = `/${app}/changelog/`;
    if (meta.url && meta.url.includes(want))
      ok(`Site: ${app}/version.json points at its changelog`);
    else
      fail(
        `Site: ${app}/version.json url is ${JSON.stringify(meta.url || null)}, not the changelog page ` +
          `(…${want}) — a store URL baked into shipped copies becomes a dead end if distribution moves`,
      );
  }
}

function auditPolicyRepo(root) {
  auditPolicyDocVersions(root, 'policy docs');

  // A change to the enforcement code is a policy change: it needs a changelog
  // entry like any other. An app session handed off a policy.js fix with none,
  // and `check` passed, because the doc-version rule only looks at versions the
  // changelog already cites.
  if (path.basename(root) === 'build-policy') {
    const changed = changedFiles(root);
    const code = changed.filter((f) => /^(scripts|templates|machine)\//.test(f));
    if (code.length > 0 && !changed.includes('CHANGELOG.md'))
      fail(
        `policy docs: ${code.join(', ')} changed with no CHANGELOG.md entry — describe the change ` +
          `(and bump the version with a history row if it changes what a check enforces)`,
      );

    // The enforcement code runs on every tool call with the power to deny
    // them, and this repo has no package.json, so the Stop hook's
    // security-review check never reached it: policy.js went seven versions
    // without a recorded review. The same rule as an app's auth code applies:
    // a change to scripts/ or machine/ needs /security-review and a
    // security-ack bound to the content it examined.
    const enforcement = changed.filter((f) => /^(scripts|machine|templates)\//.test(f)).sort();
    if (enforcement.length > 0) {
      const rec = loadState(root).securityReview;
      if (!rec || rec.hash !== contentHash(root, enforcement))
        fail(
          `policy repo: ${enforcement.join(', ')} changed without a recorded security review — run /security-review ` +
            `over the change, then: node ${path.join(root, 'scripts', 'policy.js')} security-ack` +
            (rec ? ' (a review is recorded, but for different content)' : ''),
        );
      else ok(`Security review recorded for ${enforcement.length} enforcement file(s)`);
    }
  }

  // The machinery guarantees tests run, so it runs its own. Node's built-in
  // runner: no dependency, no node_modules in this repo. The hook predicates
  // needed three false-positive fixes in two weeks, which is what these cover.
  if (exists(path.join(root, 'tests'))) {
    const t = sh("node --test 'tests/**/*.test.js'", root);
    if (t.ok) ok('Policy repo tests pass (node --test tests/**/*.test.js)');
    else
      fail(
        `Policy repo tests fail:\n${t.out
          .split('\n')
          .filter((l) => /not ok|Error|expected|actual/.test(l))
          .slice(0, 12)
          .join('\n')}`,
      );
  }

  const hasPublicMirrorSibling =
    path.basename(root) !== 'build-policy-public' &&
    exists(path.join(path.dirname(root), 'build-policy-public'));

  const requiredFiles = [
    'scripts/policy.js',
    'scripts/check-allowlist.js',
    'scripts/bootstrap-allowlist.js',
    'scripts/verify-package.js',
    'machine/hooks.json',
    'machine/session-start.sh',
    'templates/ci.yml',
    'templates/pre-commit',
    'templates/AGENTS.md',
    'templates/CLAUDE.md',
    'registry.json',
  ];
  const privateOnlyFiles = [
    'machine/build-policy-pre-commit.sh',
    'machine/mirror-pre-push.sh',
    'mirror-blocklist.txt',
  ];

  for (const f of hasPublicMirrorSibling ? requiredFiles.concat(privateOnlyFiles) : requiredFiles) {
    if (exists(path.join(root, f))) ok(`Policy repo file present: ${f}`);
    else fail(`Policy repo file missing: ${f}`);
  }

  if (!hasPublicMirrorSibling) {
    for (const f of privateOnlyFiles) {
      if (!exists(path.join(root, f))) {
        ok(`Policy repo private-only file skipped in public mirror: ${f}`);
      }
    }
  }

  for (const f of ['registry.json', 'machine/hooks.json', '.prettierrc']) {
    if (readJSON(path.join(root, f))) ok(`Policy repo JSON parses: ${f}`);
    else fail(`Policy repo JSON invalid: ${f}`);
  }

  for (const f of [
    'scripts/policy.js',
    'scripts/check-allowlist.js',
    'scripts/bootstrap-allowlist.js',
    'scripts/verify-package.js',
  ]) {
    const r = sh(`node --check ${safeToken(f, 'policy repo script')}`, root);
    if (r.ok) ok(`Policy repo script parses: ${f}`);
    else fail(`Policy repo script syntax error: ${f}\n${r.out}`);
  }

  const hooks = readJSON(path.join(root, 'machine/hooks.json'));
  const HOOK_EVENTS = ['SessionStart', 'Stop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'];
  if (hooks && HOOK_EVENTS.every((e) => hooks[e])) {
    ok(`Claude hook events present: ${HOOK_EVENTS.join(', ')}`);
  } else fail(`machine/hooks.json missing one of ${HOOK_EVENTS.join(', ')}`);

  const preCommit = readFile(path.join(root, 'templates/pre-commit'));
  for (const needle of ['leak-scan', 'verify-marker', 'gates --fast']) {
    if (preCommit.includes(needle)) ok(`pre-commit template includes ${needle}`);
    else fail(`pre-commit template missing ${needle}`);
  }

  const ci = readFile(path.join(root, 'templates/ci.yml'));
  for (const needle of [
    'npm run build --if-present',
    'npm run test:unit --if-present',
    'npm run test:smoke --if-present',
    'npm run test:integration --if-present',
  ]) {
    if (ci.includes(needle)) ok(`CI template includes ${needle}`);
    else fail(`CI template missing ${needle}`);
  }

  // The registry records which action version is current, but the template pins
  // by SHA for supply-chain reasons, so the two state the same fact in different
  // notations and nothing forced them to agree. A registry bumped without the
  // template is the worse direction: it reads as done while CI still runs the old
  // action. Matched on the `# vX.Y.Z` comment beside each pin, which is the only
  // place the human-readable version survives the SHA.
  const actionEntries = Object.entries(loadRegistry().entries || {}).filter(([k]) =>
    k.startsWith('gh-action-'),
  );
  for (const [key, entry] of actionEntries) {
    const m = String(entry.value).match(/^(.+?)@(v[\d.]+)$/);
    if (!m) {
      warn(`${key} value "${entry.value}" is not <action>@<version> — cannot check the CI pin`);
      continue;
    }
    const [, action, version] = m;
    // The pin line is `uses: <action>@<sha> # <version>`.
    const pinned = new RegExp(
      `${action.replace(/[/.]/g, '\\$&')}@[0-9a-f]{40}\\s*#\\s*${version.replace(/\./g, '\\.')}\\b`,
    ).test(ci);
    if (pinned) ok(`CI template pins ${action} ${version} (matches registry)`);
    else
      fail(
        `registry says ${key} is ${entry.value}, but templates/ci.yml does not pin that version — ` +
          `bump the SHA and its # ${version} comment, or the registry is claiming a version CI never runs`,
      );
  }
}

/** Where a policy repo keeps its version-history table. */
function historyFile(root) {
  return exists(path.join(root, 'HISTORY.md')) ? 'HISTORY.md' : 'BUILD-POLICY.md';
}
/** Versions in a history table, in table order. */
function historyRows(text) {
  return [...text.matchAll(/^\|\s*(\d+(?:\.\d+)*)\s*\|\s*\d{4}-\d{2}-\d{2}\s*\|/gm)].map(
    (m) => m[1],
  );
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
  const deps = declaredDeps(dir, proj);
  const findings = [];

  const puppeteer = Object.keys(deps).filter((d) => /puppeteer/.test(d));
  if (puppeteer.length > 0) {
    findings.push(
      `${puppeteer.join(', ')} in dependencies — PDF export will fail on customers' Macs: Puppeteer launches a Chromium it downloaded to ~/.cache/puppeteer during npm install, which exists on the build Mac and is not in the DMG. Use pdfmake (project-standards § Electron)`,
    );
  }

  let licence = null;
  let safeStorage = null;
  let hasFindFreePort = false;
  // BYOK provider coverage. Matched on the call surface (SDK import or API
  // host) rather than the word "openai"/"anthropic", which appears in settings
  // copy, type unions and stale-key migrations in apps that only ever call one
  // of them — counting those would report an app as dual-provider on the
  // strength of a dropdown it never wired up.
  let callsAnthropic = null;
  let callsOpenAI = null;
  // External-link routing and where the update banner points. Both are about
  // the same moment: a shipped app sending the user somewhere. Tracked here
  // rather than in their own walk because this traversal already reads every
  // source file.
  let opensExternal = false;
  let versionCheck = null;
  let rendererVersionCheck = null;
  let manualUpdateControl = null;
  // The window shows the app's own icon and name (policy 2.49): an <img> of the
  // icon/logo/favicon, or a *Logo / *AppIcon / *BrandMark component. A nav icon
  // image with "icon" in its path would also pass; the intent is a brand mark,
  // and a false pass is cheaper than failing apps that do show one.
  let brandMark = null;
  const BRAND_MARK =
    /<img\b[^>]*\bsrc=[^>]*(?:icon|logo|favicon)[^>]*>|<(?:[A-Z]\w*)?(?:Logo|AppIcon|BrandMark)\b/;
  let changelogLink = false;
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
      if (!brandMark && /\.(tsx|jsx|html)$/.test(e.name)) {
        const relPath = path.relative(dir, full);
        // Root-level pages cover flat vanilla-JS apps (index.html beside server.js)
        if (
          /^(src|renderer|app|public)\/|^[^/]+\.html$/.test(relPath) &&
          BRAND_MARK.test(readFile(full))
        )
          brandMark = relPath;
      }
      if (!/\.(ts|tsx|js|jsx|mjs)$/.test(e.name)) continue;
      const src = readFile(full);
      if (/findFreePort/.test(src)) hasFindFreePort = true;
      const rel = path.relative(dir, full);
      // Prefer the renderer fetch over a main-process check that may only send
      // an IPC event nobody subscribes to. The banner state lives in the UI.
      if (
        !rendererVersionCheck &&
        /^(src|renderer|app)\//.test(rel) &&
        /fetch\s*\(/.test(src) &&
        /version\.json|VERSION_CHECK_URL/.test(src)
      ) {
        rendererVersionCheck = rel;
      }
      // Static presence check; the release checklist verifies the actual
      // request and UI feedback in the installed app.
      // Comments stripped so "// Check for updates hourly" does not count as the
      // control. Flat vanilla-JS apps keep Settings wiring in one app.js, so a
      // file that refers to settings in code qualifies as well as a settings path.
      const updCode = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (
        !manualUpdateControl &&
        (/settings/i.test(rel) || /settings/i.test(updCode)) &&
        /Check for updates/i.test(updCode) &&
        /onClick|addEventListener|onPress/.test(updCode) &&
        // A status message, not the button's own label: "Check for updates"
        // contains "check", so testing for it made this condition always true.
        /up.to.date|is available|available:|could not|couldn't|failed|checking/i.test(
          updCode.replace(/Check for updates/gi, ''),
        )
      ) {
        manualUpdateControl = rel;
      }
      for (const line of src.split('\n')) {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
        if (!licence && /api\.gumroad\.com\/v2\/licenses/.test(t)) licence = rel;
        if (!safeStorage && /safeStorage\s*\.\s*\w+|[{,]\s*safeStorage\s*[},]/.test(t))
          safeStorage = rel;
        if (!callsAnthropic && /api\.anthropic\.com|['"]@anthropic-ai\/sdk['"]/.test(t))
          callsAnthropic = rel;
        if (
          !callsOpenAI &&
          /api\.openai\.com|from\s+['"]openai['"]|require\(['"]openai['"]\)/.test(t)
        )
          callsOpenAI = rel;
        if (!opensExternal && /shell\s*\.\s*openExternal/.test(t)) opensExternal = true;
        // Matched on intent, not one spelling. One app reads the URL from an
        // env var, so it never contains "version.json" and a literal match
        // reported it as having no banner at all.
        if (!versionCheck && /version\.json|VERSION_CHECK_URL|updateAvailable|setUpdate/.test(t))
          versionCheck = rel;
        if (!changelogLink && /\/changelog\/?['"`]|\/changelog\/?\$/.test(t)) changelogLink = true;
      }
    }
  };
  walk(dir);
  if (rendererVersionCheck) versionCheck = rendererVersionCheck;

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
  // A BYOK app that calls exactly one provider forces the customer to hold an
  // account with that vendor to use the app at all, which is a purchase
  // condition rather than a preference. Only flagged when the app already calls
  // one: apps with no AI at all are not missing a provider.
  // A shipped app must hand external links to the user's browser. Without
  // setWindowOpenHandler, Electron's default opens target="_blank" in a new
  // BrowserWindow: Chromium with no address bar, no back button and no session
  // shared with the browser the user actually uses.
  if (!opensExternal) {
    findings.push(
      `no shell.openExternal() found — without setWindowOpenHandler, links open inside the app in a chromeless Electron window instead of the user's browser (project-standards § Electron)`,
    );
  }
  // The will-navigate origin must name the same host the window is loaded from.
  // 127.0.0.1 and localhost are the same machine but not the same string, and
  // this comparison is a string prefix test: load from one and guard with the
  // other and every in-app navigation looks external, so the app throws its own
  // pages to the browser and the window is left stranded. Both hosts are
  // correct choices; only the mismatch is a bug, so this checks agreement
  // rather than mandating either.
  // The running version must be visible without an update being available.
  //
  // Every app already holds APP_VERSION, but most only ever render it inside
  // the update banner, which appears solely on a version mismatch. In the
  // normal state the user has no way to answer "what version are you running?"
  // — the first question any bug report needs. macOS does expose it through
  // About and Finder's Get Info, but that is a per-app menu the project can
  // replace, and "click the app name in the menu bar" is a poor answer for a
  // support workflow that should be the same in every app.
  //
  // Matched on an interpolation of the version identifier, so passing it to a
  // server (`process.env.APP_VERSION = app.getVersion()`) does not count as
  // showing it. Renders near `updateAvailable` are excluded as banner text.
  const VERSION_RENDER = /\{\s*_*APP_VERSION_*\s*\}|\$\{\s*_*APP_VERSION_*\s*\}/;
  let versionShown = null;
  for (const f of sourceFilesMatching(dir, VERSION_RENDER)) {
    // A dedicated banner component is banner text wherever it sits in the file.
    // Matching only on a variable name missed an app that calls its state
    // `update` rather than `updateAvailable`.
    if (/update[-_]?banner/i.test(path.basename(f))) continue;
    const lines = readFile(path.join(dir, f)).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!VERSION_RENDER.test(lines[i])) continue;
      // A tight window. At ±8 it reached past a settings footer into the
      // persistent "x available" line a few rows below and excluded the footer
      // as banner text — a false positive in a gate that now blocks. Banner
      // markup sits on or beside the render it belongs to; anything further is
      // a different element.
      const nearby = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
      if (/updateAvailable|update-banner|is available|update\.version/i.test(nearby)) continue;
      versionShown = `${f}:${i + 1}`;
      break;
    }
    if (versionShown) break;
  }
  if (!versionShown) {
    findings.push(
      `the running version is never shown outside the update banner — a user cannot answer "which version are you on?" unless a mismatch happens to be showing. Render it in the settings/about surface, e.g. \`{APP_NAME} v{__APP_VERSION__}\` (project-standards § Electron)`,
    );
  }

  // The rest of the settings footer. One surface, the same in every app, so a
  // support instruction ("open Settings, scroll to the bottom") is portable.
  // Each is matched on what it actually is rather than on the word, to avoid
  // passing on an unrelated mention.
  if (sourceFilesMatching(dir, /©|&copy;|\\u00a9/).length === 0) {
    findings.push(
      `no copyright notice in the UI — the settings footer should name who made the app and when, e.g. \`© {year} David Tiong\` (project-standards § Electron)`,
    );
  }
  // The attribution file ships (verify-ready --release requires it) but is
  // inside the bundle where nobody can reach it. A link makes it reachable.
  if (
    exists(path.join(dir, 'THIRD-PARTY-LICENSES.txt')) &&
    sourceFilesMatching(
      dir,
      /THIRD-PARTY-LICENSES|[Tt]hird[- ][Pp]arty [Ll]icen[cs]e|[Oo]pen[- ][Ss]ource [Ll]icen[cs]e/,
    ).length === 0
  ) {
    findings.push(
      `THIRD-PARTY-LICENSES.txt ships but nothing in the UI links to it — the file is inside the bundle where a user cannot find it (project-standards § Electron)`,
    );
  }
  // Mandated since the Diagnostics Logging section was written, never checked,
  // and consequently present in 1 of 11 apps. Once a DMG is on a user's
  // machine, logs the user can send are the only way to see what happened.
  // Matched on the capability, not the wording, so the label can be whatever
  // fits the surface — "Diagnostics" in a narrow modal, "Export diagnostics…"
  // in a menu. What must exist is diagnostics that can leave the machine, so a
  // file-producing action has to appear alongside the word: a bare mention of
  // "diagnostics" in a comment or an endpoint path is not an affordance.
  // Required within a few lines of each other, not merely in the same file: a
  // server file can mention diagnostics in a comment and call writeFile a
  // hundred lines away for something unrelated, which passed on coincidence.
  const DELIVERS_FILE =
    /showSaveDialog|writeFileSync|writeFile\(|createObjectURL|new Blob|download\s*=|Content-Disposition|attachment;/;
  const diagnosticsExport = sourceFilesMatching(dir, /diagnostics/i).filter((f) => {
    const lines = readFile(path.join(dir, f)).split('\n');
    return lines.some(
      (l, i) =>
        /diagnostics/i.test(l) &&
        DELIVERS_FILE.test(lines.slice(Math.max(0, i - 6), i + 6).join('\n')),
    );
  });
  if (diagnosticsExport.length === 0) {
    findings.push(
      `no way to export diagnostics — logs cannot leave the user's machine, so a bug report carries no evidence. Needs a "Diagnostics" action that writes a file (menu item or settings footer). The reference implementation is named in project-standards § Diagnostics Logging`,
    );
  } else {
    // Shipping diagnostics without a leak test is the riskier state of the two.
    // The bundle is a file the user emails out, and these apps hold customer
    // records, personal journals and BYOK keys. A payload that dumps log files
    // is only as safe as every log call site, forever, and the failure is
    // silent: the user sends the file and neither party knows what was in it.
    // A test that writes known canaries through the app's real paths and then
    // asserts they are absent from the bundle is the only thing that keeps the
    // promise true as the code changes. Required only where diagnostics exist,
    // so it lands with the feature rather than ahead of it.
    const leakTest = sourceFilesMatching(dir, /diagnostic/i).filter(
      (f) =>
        /(^|\/)tests?\//.test(f) &&
        /canary|leak|redact|must not (appear|contain)/i.test(readFile(path.join(dir, f))),
    );
    if (leakTest.length === 0) {
      findings.push(
        `diagnostics can be exported but no test proves the bundle is clean — it is a file the user emails out, and these apps hold customer records, journals and BYOK keys. Add a test that writes known canaries (user content, an API key) through the app's normal paths and asserts none appear in the diagnostics output (project-standards § Diagnostics Logging)`,
      );
    }
  }

  // setWindowOpenHandler must test the origin, exactly as will-navigate does.
  // An unconditional openExternal reads as correct and is not: the app's own
  // pages are served over the local server, so a target="_blank" link to
  // something like /api/licenses gets handed to the user's browser as
  // http://127.0.0.1:<random port>/api/licenses — raw text on a localhost port
  // that dies when the app quits. App content belongs in the app; only URLs
  // outside the server origin belong in the browser.
  for (const f of sourceFilesMatching(dir, /setWindowOpenHandler/)) {
    const lines = readFile(path.join(dir, f)).split('\n');
    const i = lines.findIndex((l) => /setWindowOpenHandler/.test(l));
    // Bounded to the handler's own body, ending at its closing `});`. A fixed
    // line window let the will-navigate block that usually follows bleed in,
    // and its serverOrigin passed the test for a handler that has no origin
    // check at all — a false pass on exactly the apps this is meant to catch.
    let end = i + 1;
    while (end < lines.length && !/^\s*\}\)\s*;/.test(lines[end])) end++;
    const body = lines.slice(i, end + 1).join('\n');
    if (!/serverOrigin|startsWith\(|localhost|127\.0\.0\.1/.test(body)) {
      findings.push(
        `${f}: setWindowOpenHandler sends every URL to the browser, including the app's own — a target="_blank" link to a local route opens as http://127.0.0.1:<port>/... in the user's browser. Allow same-origin URLs and openExternal only the rest, as will-navigate already does (project-standards § Electron)`,
      );
    }
  }

  // Origin tests must compare origins, not prefixes, and openExternal must only
  // receive web/mail URLs. `url.startsWith('http://127.0.0.1:5000')` also
  // accepts http://127.0.0.1:5000.evil.com, which then loads inside an app
  // window; and openExternal hands any scheme (file:, smb:, custom handlers) to
  // the OS — including URLs the user typed into the app's own records.
  // project-standards § Network Exposure.
  for (const f of sourceFilesMatching(dir, /setWindowOpenHandler|will-navigate/)) {
    const src = readFile(path.join(dir, f))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    if (
      /\.startsWith\(\s*(serverOrigin|appOrigin|origin|[`'"]https?:\/\/(127\.0\.0\.1|localhost))/.test(
        src,
      )
    ) {
      findings.push(
        `${f}: the app-origin test is a string prefix (startsWith), which also accepts http://127.0.0.1:<port>.evil.com. Compare new URL(url).origin === serverOrigin (project-standards § Network Exposure)`,
      );
    }
    if (
      /shell\s*\.\s*openExternal\s*\(/.test(src) &&
      !/\.protocol\b|\{\s*protocol\s*\}/.test(src)
    ) {
      findings.push(
        `${f}: shell.openExternal receives any URL scheme — file:, smb: and custom handlers go straight to the OS. Allow only https:, http: and mailto: via new URL(url).protocol (project-standards § Network Exposure)`,
      );
    }
  }

  for (const f of sourceFilesMatching(dir, /will-navigate/)) {
    const src = readFile(path.join(dir, f));
    const loaded = (src.match(/loadURL\s*\(\s*[`'"]https?:\/\/([^:/`'"]+)/) || [])[1];
    const guarded = (src.match(/serverOrigin\s*=\s*[`'"]https?:\/\/([^:/`'"]+)/) || [])[1];
    if (loaded && guarded && loaded !== guarded) {
      findings.push(
        `${f} loads the window from ${loaded} but will-navigate guards ${guarded} — the origin test is a string compare, so every in-app navigation would be treated as external and opened in the browser (project-standards § Electron)`,
      );
    }
  }
  // Where the update banner points. A URL baked into a shipped DMG cannot be
  // changed for anyone who already installed it, so it must point at a page we
  // control and can re-target — the app's changelog page, which in turn carries
  // the download link. Pointing straight at a store means that if distribution
  // ever moves, every installed copy has a dead link and no route to the update.
  // The update banner must fire on a simple mismatch, not a semver "newer
  // than" comparison. This is not style: the mismatch check is what makes the
  // banner self-testing at every release. Install the new DMG while the site
  // still lists the old version and the banner MUST appear, which is the same
  // code path a customer's old copy hits; update the site and it MUST clear.
  // A "newer than" comparison shows nothing in that state, so the release
  // checklist's banner verification silently passes without testing anything.
  // Matched on the version comparison itself, not on "localeCompare appears in
  // a file mentioning version". That looser form was wrong in both directions
  // at once: it flagged an app whose localeCompare calls sort dates, and missed
  // two that build the version URL without the literal "version.json".
  // The banner must fire on drift, not on "newer than".
  //
  // Stated positively: the comparison has to be an equality test against the
  // running version. An earlier version of this denylisted `localeCompare` and
  // therefore enforced nothing — `semver.gt(...)` and `parseFloat(...) >` both
  // violate the rule and sailed past. Verified: of four comparison styles, the
  // denylist caught one.
  //
  // Drift rather than newer-than is what makes the banner self-testing at each
  // release. Install a build the site does not yet list and it must appear,
  // which is the same code path a customer's stale copy hits; update the site
  // and it must clear. A "newer than" test shows nothing in that state, so the
  // release checklist's banner step passes while exercising nothing.
  if (!brandMark) {
    findings.push(
      `the window never shows the app's icon and name — add the app icon (same artwork as build/icon.png) beside the product name in the header or sidebar, on every screen (project-standards § Electron)`,
    );
  }
  if (versionCheck) {
    if (/^electron\//.test(versionCheck)) {
      findings.push(
        `${versionCheck}: the version check runs only in the Electron main process; run it in the renderer so the result directly updates and clears the banner (project-standards § Electron)`,
      );
    }
    if (!manualUpdateControl) {
      findings.push(
        `no Settings Check for updates control with result feedback — users need a manual refresh that bypasses the hourly throttle (project-standards § Electron)`,
      );
    }
    // Searched in the file that does the update check, not project-wide, and
    // covering both ways an app names its running version. Getting this wrong
    // in each direction at once: a `typeof __APP_VERSION__ !== 'undefined'`
    // guard in an unrelated settings page satisfied a project-wide search for
    // an app whose real comparison is localeCompare, while an app that does
    // compare correctly was flagged because it reads `app.getVersion()` rather
    // than the build-time constant. typeof guards are excluded for that reason.
    const SELF = String.raw`(?:_*APP_VERSION_*|app\.getVersion\(\))`;
    const MISMATCH = new RegExp(String.raw`[!=]==\s*${SELF}|${SELF}\s*[!=]==`);
    // typeof guards are stripped before testing rather than excluded by a
    // lookaround. `typeof X !== 'undefined'` is an existence check, not a
    // version comparison, and every lookaround spelling of "not that one"
    // leaked: `\s*` backtracks over the space so the lookahead lands on the
    // wrong character and matches anyway. Deleting the construct first cannot
    // backtrack.
    const checkFile = readFile(path.join(dir, versionCheck)).replace(
      /typeof\s+[\w$.]+\s*[!=]==\s*['"`]undefined['"`]/g,
      '',
    );
    const checksDrift = MISMATCH.test(checkFile);
    if (!checksDrift) {
      findings.push(
        `${versionCheck}: the update check never compares for inequality against the running version, ` +
          `so it is testing "is the site newer" rather than "does the site differ". Installing a build the site ` +
          `does not yet list then shows no banner, and the release checklist's banner step passes without ` +
          `exercising anything (project-standards § Electron)`,
      );
    }
    // The check must re-run while the app is open. Every app surveyed on
    // 2026-09-25 fetched version.json once on mount, so a customer who keeps
    // the app in the dock learned about a release only after relaunching,
    // days or weeks later. The standard had said "recheck periodically" in
    // prose, and nothing checked it, so no app did. Both triggers are required:
    // an interval alone does nothing useful for an app the user keeps switching
    // away from, and focus alone misses a window left open in front. Searched in
    // the same file as the fetch, since that is where the triggers belong.
    const rawCheck = readFile(path.join(dir, versionCheck));
    const rechecks = /setInterval\s*\(/.test(rawCheck);
    const onFocus =
      /addEventListener\(\s*['"](?:focus|visibilitychange)['"]/.test(rawCheck) ||
      /['"]browser-window-focus['"]/.test(rawCheck);
    if (!rechecks || !onFocus) {
      const missing = [
        !rechecks && 'hourly setInterval',
        !onFocus && 'focus/visibilitychange listener',
      ]
        .filter(Boolean)
        .join(' and ');
      findings.push(
        `${versionCheck}: the update check runs only at launch (it has no ${missing}), so an app left open never ` +
          `learns a release exists until it is restarted. Re-run the same check on focus and hourly, throttled ` +
          `to once an hour (project-standards § External State Must Be Subscribed)`,
      );
    }
  }

  // An app that ships a DMG must HAVE an update check. Every other banner rule
  // is conditional on one existing, which is the trap that let DiagramSnap ship
  // several DMGs, with a version.json published for it on the site, and no
  // banner in the app at all: it passed every banner check by having no banner.
  // A rule that presupposes the feature can never require it.
  //
  // Required once the project distributes (a shipped DMG exists, or
  // distribution is declared gumroad before the first one is built, so the
  // gap is caught at check time rather than after the launch build). With
  // distribution none the DMGs are test builds and the banner is added when
  // the app is far enough along to test it against a version.json.
  const declaredGumroad =
    !!(proj.pkg && proj.pkg.policy && proj.pkg.policy.distribution === 'gumroad');
  if (!versionCheck && (shippedDmgVersions(dir, proj).size > 0 || declaredGumroad)) {
    findings.push(
      `no update check at all, yet this app ${declaredGumroad ? 'is declared for Gumroad distribution' : 'ships a DMG'} — ` +
        `customers have no way to learn a new version exists. Fetch the site's version.json on launch and show the banner ` +
        `(project-standards § Electron)`,
    );
  }
  // A server that reads the version from the environment needs the main process
  // to put it there.
  //
  // One app's diagnostics bundle reported "App version: development" from a
  // real DMG. It read `process.env.npm_package_version ?? process.env.APP_VERSION
  // ?? 'development'`, and its main process set neither. npm_package_version
  // exists only when npm launched the process, so it is present under `npm run`
  // and absent in a packaged app: the chain reads correctly in development and
  // wrongly in production, which is the inverse of a useful fallback. The
  // bundle's whole purpose is to say which version the user is running.
  // A server that reads the version from the environment needs the main process
  // to put it there.
  //
  // Presence only, deliberately. I tightened this to demand the assignment sit
  // inside `whenReady` and before the server import, on the theory that
  // `app.getVersion()` returns nothing at module load. Measured on Electron: it
  // returns the correct version both before and after `whenReady`, so placement
  // does not matter and the stricter rule flagged three correct apps. The real
  // incident was simply an older build installed over a newer fix.
  const readsEnvVersion = sourceFilesMatching(
    dir,
    /process\.env\.(?:APP_VERSION|npm_package_version)/,
  ).filter((f) => !/electron\//.test(f));
  if (
    readsEnvVersion.length > 0 &&
    sourceFilesMatching(dir, /process\.env\.APP_VERSION\s*=/).length === 0
  ) {
    findings.push(
      `${readsEnvVersion[0]} reads the version from the environment, but nothing sets process.env.APP_VERSION — ` +
        `in a packaged app npm_package_version is unset, so this reports "development" from a real build. ` +
        `Set it in the Electron main: process.env.APP_VERSION = app.getVersion() ` +
        `(project-standards § Diagnostics Logging)`,
    );
  }

  // If the app ships a CSP, connect-src must permit the update host.
  //
  // One app shipped DMGs whose banner could never fire: its index.html carried
  // `connect-src 'self'`, so the fetch to the marketing site was blocked inside
  // the app before any request left. Nothing to do with the server's CORS. It
  // hit only that app because it is the only one with a CSP at all — its best
  // security practice was what broke the feature, which is why nobody suspected
  // it, and why the other apps' banners kept working.
  //
  // Parsed out of the meta tag's content attribute, not by matching the bare
  // word: an earlier attempt matched "connect-src" inside the explanatory
  // comment above the tag and read the comment as the policy. The host is taken
  // from source, since the URL lives in a constant, not in the HTML.
  const updateHost = (() => {
    for (const f of sourceFilesMatching(dir, /VERSION_CHECK_URL|version\.json/)) {
      const m = readFile(path.join(dir, f)).match(/https:\/\/([a-z0-9.-]+)[^\s'"`]*version\.json/i);
      if (m) return m[1];
    }
    return null;
  })();
  if (updateHost) {
    for (const f of ['index.html', 'public/index.html', 'src/index.html']) {
      const full = path.join(dir, f);
      if (!exists(full)) continue;
      const html = readFile(full);
      // The content attribute is delimited by one quote character and its VALUE
      // contains the other (`'self'`), so the capture may exclude only the
      // delimiter. Excluding both truncated the policy at `'self'` and read the
      // directive as absent — the same mistake that made this check miss the
      // very bug it was written for.
      const meta =
        html.match(/http-equiv="Content-Security-Policy"[^>]*?content="([^"]*)"/is) ||
        html.match(/http-equiv='Content-Security-Policy'[^>]*?content='([^']*)'/is);
      if (!meta) continue;
      const connect = (meta[1].match(/connect-src([^;]*)/i) || [])[1];
      if (connect === undefined) continue; // no connect-src: default-src governs, checked below
      if (!connect.includes(updateHost)) {
        findings.push(
          `${f}: the CSP restricts connect-src to${connect.replace(/\s+/g, ' ').trimEnd()} but the app fetches ${updateHost} — ` +
            `the update check is blocked inside the app before any request leaves, so the banner silently never appears. ` +
            `Add https://${updateHost} to connect-src (project-standards § Electron)`,
        );
      }
    }
  }
  if (versionCheck && !changelogLink) {
    findings.push(
      `${versionCheck} checks for updates but no /changelog/ URL appears in the source — the update link must point at the app's changelog page, the one URL that can be re-targeted after the DMG ships (project-standards § Electron)`,
    );
  }
  if (callsAnthropic && !callsOpenAI) {
    findings.push(
      `only Anthropic is wired up (${callsAnthropic}) — BYOK apps must offer OpenAI as well, so a customer is not required to hold an account with one specific vendor (project-standards § AI Models)`,
    );
  } else if (callsOpenAI && !callsAnthropic) {
    findings.push(
      `only OpenAI is wired up (${callsOpenAI}) — BYOK apps must offer Anthropic as well (project-standards § AI Models)`,
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
 * Would `npm ci` accept this lockfile? Asked of npm itself, not a heuristic.
 *
 * CI's first step is `npm ci`, and the local gates never ran it: they worked
 * against a node_modules that `npm install` had built, and `npm install`
 * quietly repairs a lockfile that `npm ci` rejects. auditLockfileIntegrity
 * above matches one shape of breakage (platform-binary siblings), so each new
 * shape reached CI first — one app lost electron-winstaller's optional
 * @electron/windows-sign subtree three times in eleven days, each time a
 * dependency was added on this Mac, and each time the gates passed. The cause
 * is Socket's npm wrapper (CLI 1.1.102): it replaces npm's Arborist with a
 * vendored copy "based on npm/cli v11.0.0", which prunes optional subtrees
 * that npm 11.19 keeps. Reproduced in a scratch copy: `socket npm install
 * <pkg>` removed the five packages; a plain `npm install` restored them.
 *
 * This runs the check `npm ci` runs before it installs anything: build the
 * ideal tree from package.json and compare it with the lockfile
 * (lib/commands/ci.js → validate-lockfile.js), using the npm that ships with
 * the pinned Node. The ideal tree includes every platform's optional packages
 * — platform filtering happens later, at install — so the answer on this Mac
 * is the answer on CI's Linux runner. Verified both ways: that app's broken
 * commit reports the same five "Missing: … from lock file" lines CI failed
 * on, its fixed commit passes, and a lockfile with its linux-x64 binaries
 * removed is rejected. Installs nothing, so Socket is not involved; ~0.4s.
 */
const LOCKFILE_SYNC_SCRIPT = `
const [npmDir, dir] = process.argv.slice(1);
const Arborist = require(npmDir + '/node_modules/@npmcli/arborist');
const validateLockfile = require(npmDir + '/lib/utils/validate-lockfile.js');
(async () => {
  const virt = new Arborist({ path: dir });
  const inventory = new Map((await virt.loadVirtual()).inventory);
  const arb = new Arborist({ path: dir });
  await arb.buildIdealTree();
  process.stdout.write(JSON.stringify(validateLockfile(inventory, arb.idealTree.inventory)));
})().catch((e) => { process.stderr.write(String(e && e.message)); process.exit(2); });
`;

function npmInstallDir() {
  const bundled = path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm');
  if (exists(path.join(bundled, 'lib', 'utils', 'validate-lockfile.js'))) return bundled;
  const r = sh('npm root -g', process.cwd());
  const global = r.ok ? path.join(r.out.split('\n').pop(), 'npm') : null;
  return global && exists(path.join(global, 'lib', 'utils', 'validate-lockfile.js'))
    ? global
    : null;
}

function auditLockfileSync(dir) {
  if (!exists(path.join(dir, 'package-lock.json'))) return;
  const npmDir = npmInstallDir();
  if (!npmDir) {
    fail(
      `Cannot locate npm's lockfile validator (lib/utils/validate-lockfile.js) beside ${process.execPath} — ` +
        `the check that 'npm ci' runs in CI cannot be run here. Reinstall Node via nvm, then re-run gates`,
    );
    return;
  }
  const r = require('child_process').spawnSync(
    process.execPath,
    ['-e', LOCKFILE_SYNC_SCRIPT, npmDir, dir],
    {
      encoding: 'utf8',
      timeout: 60000,
    },
  );
  if (r.status !== 0) {
    fail(
      `Could not check package-lock.json against package.json the way 'npm ci' does: ` +
        `${(r.stderr || r.error?.message || 'unknown error').trim().split('\n')[0]}. ` +
        `If this is a network error, the registry was needed to resolve a dependency the lockfile lacks — re-run gates when online`,
    );
    return;
  }
  let errors = [];
  try {
    errors = JSON.parse(r.stdout || '[]');
  } catch {
    fail(`Lockfile sync check returned unreadable output: ${(r.stdout || '').slice(0, 200)}`);
    return;
  }
  if (errors.length > 0) {
    fail(
      `package-lock.json is out of sync with package.json — 'npm ci' in CI will refuse to install: ` +
        `${errors.slice(0, 6).join('; ')}${errors.length > 6 ? `; +${errors.length - 6} more` : ''}. ` +
        `Re-resolve with a plain install and no package name: npm install. Confirm with git diff package-lock.json that ` +
        `the entries return, then re-run gates. (The usual past cause was the retired Socket npm wrapper, whose older ` +
        `resolver pruned optional subtrees.) Never hand-edit the lockfile`,
    );
  } else ok("Lockfile in sync with package.json (the check 'npm ci' runs in CI)");
}

/**
 * Security infrastructure that must be present in Express apps. The SAST scans
 * (Semgrep, ESLint security) catch known anti-patterns — what you did wrong.
 * This audit catches what you forgot to do: helmet missing, input validation
 * absent, dangerouslySetInnerHTML without sanitization.
 *
 * Runs for every project with Express (Electron or standalone). Local apps have
 * a lighter threat model (single user, localhost) but the same patterns prevent
 * bugs regardless of who is making the request.
 */
/** Folders beside the root that hold their own package.json: a server's
 *  packages, electron-builder's two-package layout, or monorepo packages. */
function serverPackageDirs(dir) {
  const out = [];
  for (const d of ['server', 'backend', 'api', 'app', 'electron'])
    if (exists(path.join(dir, d, 'package.json'))) out.push(d);
  for (const parent of ['apps', 'packages']) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(dir, parent));
    } catch {
      /* no such folder */
    }
    for (const n of names)
      if (exists(path.join(dir, parent, n, 'package.json'))) out.push(path.join(parent, n));
  }
  return out;
}

/**
 * origin/HEAD records the remote's default branch. Git creates it only on
 * clone, so a repository made on this Mac and then pushed never has it, and
 * Claude Code's /security-review, which diffs against origin/HEAD, cannot run
 * there. Returns the branch to point it at when it is missing and the remote
 * branch is known locally, '' when missing with nothing to point at, and null
 * when it is set or there is no origin remote.
 */
function missingOriginHead(dir) {
  if (!sh('git remote', dir).out.split('\n').includes('origin')) return null;
  if (sh('git symbolic-ref -q refs/remotes/origin/HEAD', dir).ok) return null;
  const branch = sh('git rev-parse --abbrev-ref HEAD', dir).out.trim();
  for (const b of [branch, 'main', 'master'])
    if (
      b &&
      sh(`git rev-parse --verify --quiet refs/remotes/origin/${safeToken(b, 'branch')}`, dir).ok
    )
      return b;
  return '';
}

/**
 * Every dependency the project declares, in the root package.json and in any
 * nested one (serverPackageDirs). A rule about what an app depends on must read
 * all of them: helmet and puppeteer were each reported wrongly because a check
 * read only the root while the server kept its own package.json.
 */
function declaredDeps(dir, proj) {
  const deps = { ...(proj.pkg.dependencies || {}), ...(proj.pkg.devDependencies || {}) };
  for (const sub of serverPackageDirs(dir)) {
    const pkg = readJSON(path.join(dir, sub, 'package.json'));
    if (pkg) Object.assign(deps, pkg.dependencies || {}, pkg.devDependencies || {});
  }
  return deps;
}

/** Installed packages that declare preinstall, install or postinstall scripts. */
function installScriptPackages(dir) {
  const r = sh(
    `npm query ':attr(scripts, [preinstall]), :attr(scripts, [install]), :attr(scripts, [postinstall])'`,
    dir,
  );
  if (!r.ok) return null;
  try {
    return [...new Set(JSON.parse(r.out.slice(r.out.indexOf('['))).map((x) => x.name))].sort();
  } catch {
    return null;
  }
}

function auditInstallScripts(dir) {
  const allowPath = path.join(dir, 'allowed-packages.json');
  if (!exists(path.join(dir, 'node_modules')) || !exists(allowPath)) return;
  const found = installScriptPackages(dir);
  if (found === null) return warn('Could not list install-script packages (npm query failed)');
  const recorded = (readJSON(allowPath) || {})._installScripts;
  if (!recorded) {
    fail(
      `allowed-packages.json has no _installScripts record. These run code at install: ${found.join(', ') || '(none)'}. ` +
        `Run policy scaffold to record the current set as the baseline, then gates`,
    );
    return;
  }
  const unrecorded = found.filter((n) => !(n in recorded));
  if (unrecorded.length > 0)
    fail(
      `New package(s) that run code at install time: ${unrecorded.join(', ')}. Find which dependency brought each in ` +
        `(npm ls <name>), check what its script does, and if it is acceptable add it to allowed-packages.json ` +
        `_installScripts with the reason, e.g. "esbuild": "native binary for the Vite build" (project-standards § Supply Chain Security)`,
    );
  else ok(`Install-time scripts all recorded (${found.length}: ${found.join(', ') || 'none'})`);
}

/**
 * Advisory exceptions: a developer's dated decision to carry a known high or
 * critical advisory that has no fix, recorded in the project's committed
 * audit-exceptions.json (policy 2.58). First case: GHSA-ch52-4w7c-c8xp in
 * http-cache-semantics, reached through astro, no patched release; the flaw
 * needs a shared cache serving several users, which a static build lacks.
 *
 *   { "GHSA-xxxx": { "package": "...", "via": "...", "reason": "...",
 *                    "decided": "YYYY-MM-DD", "expires": "YYYY-MM-DD" } }
 *
 * An exception covers that advisory in that package only, expires at most 90
 * days after it was decided, and lapses when a fix ships (health asks GitHub).
 * Accepting a known high vulnerability is a security exclusion, so the AI may
 * draft an entry but not write the file.
 */
const AUDIT_EXCEPTIONS = 'audit-exceptions.json';
const AUDIT_APPROVALS = 'audit-approvals.json';
const AUDIT_EXCEPTION_MAX_DAYS = 90;

function loadAuditExceptions(dir) {
  return readJSON(path.join(dir, AUDIT_EXCEPTIONS)) || {};
}

/**
 * The AI drafts exceptions; only the developer approves them (policy 2.59).
 * `policy approve-exception <id>` records, in the committed audit-approvals.json,
 * a hash of the entry's fields. An entry counts only while that hash matches,
 * so an entry changed after approval needs approving again. The same hash is
 * computed by the CI template's audit step.
 */
function auditEntryHash(e) {
  const fields = {
    package: e.package,
    via: e.via || '',
    reason: e.reason,
    decided: e.decided,
    expires: e.expires,
  };
  return crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
function loadAuditApprovals(dir) {
  return readJSON(path.join(dir, AUDIT_APPROVALS)) || {};
}
function auditExceptionApproved(dir, id, e) {
  const a = loadAuditApprovals(dir)[id];
  return Boolean(a && e && a.hash === auditEntryHash(e));
}

/** Problems with the exception file itself: missing fields, too long, expired. */
function auditExceptionProblems(
  exceptions,
  today = new Date().toISOString().slice(0, 10),
  dir = null,
) {
  const problems = [];
  for (const [id, e] of Object.entries(exceptions)) {
    if (!/^GHSA-[\w-]+$/.test(id)) problems.push(`${id}: key must be a GHSA advisory id`);
    if (!e || !e.package || !e.reason || !e.decided || !e.expires) {
      problems.push(`${id}: needs package, reason, decided and expires`);
      continue;
    }
    const span = (new Date(e.expires) - new Date(e.decided)) / 86400000;
    if (!(span > 0) || span > AUDIT_EXCEPTION_MAX_DAYS)
      problems.push(
        `${id}: expires ${e.expires} is more than ${AUDIT_EXCEPTION_MAX_DAYS} days after ${e.decided}`,
      );
    if (e.expires < today) problems.push(`${id}: expired on ${e.expires} — re-decide or remove it`);
    if (dir && !auditExceptionApproved(dir, id, e))
      problems.push(
        `${id}: not approved${loadAuditApprovals(dir)[id] ? ' (changed since it was approved)' : ''} — the developer runs: ` +
          `node ${path.join(POLICY_ROOT, 'scripts', 'policy.js')} approve-exception ${id}`,
      );
  }
  return problems;
}

/**
 * The audit gate, honouring exceptions. Fails on every high or critical
 * advisory (the source behind a finding, not the parents that inherit it)
 * that no valid exception covers for that package.
 */
function auditWithExceptions(dir) {
  const exceptions = loadAuditExceptions(dir);
  const problems = auditExceptionProblems(exceptions, undefined, dir);
  if (problems.length) return { ok: false, out: `audit-exceptions.json: ${problems.join('; ')}` };
  const r = sh('npm audit --json --omit=dev', dir);
  let report;
  try {
    report = JSON.parse(r.out.slice(r.out.indexOf('{')));
  } catch {
    return { ok: false, out: `could not read npm audit output: ${r.out.slice(0, 300)}` };
  }
  const advisories = [];
  for (const [name, v] of Object.entries(report.vulnerabilities || {}))
    for (const via of v.via || [])
      if (via && typeof via === 'object' && /high|critical/.test(via.severity || ''))
        advisories.push({
          id: String(via.url || '')
            .split('/')
            .pop(),
          pkg: via.name || name,
          title: via.title,
        });
  const open = advisories.filter((a) => !(exceptions[a.id] && exceptions[a.id].package === a.pkg));
  const covered = advisories.length - open.length;
  if (open.length)
    return {
      ok: false,
      out: open.map((a) => `${a.id} in ${a.pkg}: ${a.title}`).join('\n'),
    };
  return {
    ok: true,
    out: covered
      ? `${covered} advisory finding(s) covered by audit-exceptions.json`
      : 'no high or critical advisories',
  };
}

function auditSecurityInfrastructure(dir, proj) {
  const deps = declaredDeps(dir, proj);
  const findings = [];

  // helmet — sets X-Content-Type-Options, X-Frame-Options, HSTS and other
  // security headers. Matched on the require/import and the call, because
  // having it in dependencies without calling it is the same as not having it.
  if (!('helmet' in deps)) {
    findings.push(
      `helmet not in dependencies — Express apps must use helmet() for security headers ` +
        `(X-Content-Type-Options, X-Frame-Options, HSTS). npm install helmet and add app.use(helmet()) ` +
        `(project-standards § Security Headers)`,
    );
  } else {
    const helmetCalls = sourceFilesMatching(dir, /helmet\s*\(/);
    if (helmetCalls.length === 0) {
      findings.push(
        `helmet is in dependencies but no helmet() call found — add app.use(helmet()) to the ` +
          `Express setup (project-standards § Security Headers)`,
      );
    }
  }

  // dangerouslySetInnerHTML without DOMPurify. React escapes by default; this
  // prop is the explicit bypass. Semgrep may flag it too, but only if the auto
  // config includes the React XSS rules, which varies. This check is specific.
  const dangerousFiles = sourceFilesMatching(dir, /dangerouslySetInnerHTML/);
  if (dangerousFiles.length > 0) {
    const hasDOMPurify =
      'dompurify' in deps ||
      'isomorphic-dompurify' in deps ||
      sourceFilesMatching(dir, /DOMPurify|dompurify|sanitize/i).length > 0;
    if (!hasDOMPurify) {
      findings.push(
        `dangerouslySetInnerHTML used in ${dangerousFiles.join(', ')} without DOMPurify — ` +
          `user-supplied HTML must be sanitized before rendering. Install dompurify and ` +
          `wrap content with DOMPurify.sanitize() (project-standards § Output Encoding)`,
      );
    }
  }

  // javascript: URLs in href attributes. A variable interpolated into href
  // without a scheme check executes arbitrary code on click.
  const jsHrefFiles = sourceFilesMatching(dir, /href\s*=\s*\{(?!['"`]https?:)/);
  // Only flag if there is no scheme validation nearby. A simple heuristic:
  // if the project has a URL validation helper or checks startsWith('http'),
  // it is likely handled. Full verification is the security review's job.

  // express.json() body size limit. The default is 100kb, which is fine for
  // most apps, but if a project overrides it with a large limit (>1MB) without
  // documenting why, that is a flag.

  // File serving without nosniff. Check for res.sendFile or express.static
  // without helmet (which sets nosniff). If helmet is present this is covered.

  for (const f of findings) fail(f);
  if (findings.length === 0) ok('Security infrastructure present (helmet, input sanitisation)');
}

/**
 * Network exposure of the local server. These apps have no authentication: the
 * API is meant for the app's own window, so anything that can connect can read
 * and change every record. `app.listen(port)` with no host listens on every
 * interface, which puts that API on the LAN — anyone on the same café or office
 * Wi-Fi could call it while the app runs (pm2 tools run all day, on fixed ports).
 * Found 2026-09-24: 12+ projects, including a shipped Gumroad app. The macOS
 * firewall does not cover it by default: it ships off, and when on it
 * auto-allows signed apps. project-standards § Network Exposure.
 *
 * Three independent layers, each FAILed on its own:
 *  1. listen() on loopback. Resolves `HOST`-style identifiers to their literal
 *     in the same file; an unresolvable identifier WARNs rather than guessing.
 *     Port-0 probes (findFreePort) are exempt: the socket closes immediately.
 *  2. A Host-header allowlist, which is what stops DNS rebinding — loopback
 *     binding alone does not, because the rebound request comes from the user's
 *     own browser on the same machine.
 *  3. CORS limited to exact origins: no wildcard, no bare cors(), no regex
 *     accepting any localhost port (any other local dev server's page).
 */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

function serverSourceFiles(dir) {
  const files = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (
        [
          'node_modules',
          'dist',
          'release',
          'build',
          'coverage',
          'tests',
          'test',
          '__tests__',
        ].includes(e.name)
      )
        continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|mjs|cjs|ts)$/.test(e.name) && !/\.(test|spec)\./.test(e.name))
        files.push(full);
    }
  };
  walk(dir);
  return files;
}

function auditNetworkExposure(dir) {
  const findings = [];
  const warnings = [];
  let listens = 0;
  let hostCheck = false;
  let originCheck = false;

  for (const full of serverSourceFiles(dir)) {
    const rel = path.relative(dir, full);
    const src = readFile(full);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    if (
      /req\.headers\.host\b|req\.headers\[['"]host['"]\]|req\.hostname\b|req\.get\(\s*['"]host['"]\s*\)/i.test(
        code,
      )
    )
      hostCheck = true;
    if (
      /req\.headers\.origin\b|req\.headers\[['"]origin['"]\]|req\.get\(\s*['"]origin['"]\s*\)/i.test(
        code,
      )
    )
      originCheck = true;

    // .listen(<port>[, <host>][, <callback>]) — capture the first two arguments.
    const re =
      /\.listen\(\s*([^,()]+?)\s*(?:,\s*([^,()]+?|\([^)]*\)\s*=>|async\s*\([^)]*\)\s*=>|function\b)\s*)?[,)]/g;
    let m;
    while ((m = re.exec(code))) {
      const port = m[1].trim();
      const second = (m[2] || '').trim();
      if (port === '0') continue; // findFreePort probe
      // Only Express/http servers: a port-like first argument.
      if (!/^(\d+|[A-Za-z_$][\w$.]*(\s*\|\|\s*\d+)?)$/.test(port)) continue;
      listens++;
      const isCallback =
        !second || /=>|^function\b|^async\b|^(cb|callback|done|onListen\w*)$/.test(second);
      if (isCallback) {
        findings.push(
          `${rel}: listen(${port}) has no host, so the server listens on every network interface — anyone on the same Wi-Fi can call its unauthenticated API. Use listen(port, '127.0.0.1', ...) (project-standards § Network Exposure)`,
        );
        continue;
      }
      const lit = second.match(/^['"`]([^'"`]+)['"`]$/);
      if (lit) {
        if (!LOOPBACK_HOSTS.includes(lit[1]))
          findings.push(
            `${rel}: listen(${port}, '${lit[1]}') exposes the server beyond this Mac — bind '127.0.0.1' (project-standards § Network Exposure)`,
          );
        continue;
      }
      // An identifier: find its declaration here or in another server file
      // (e.g. `export const HOST = process.env.HOST || '127.0.0.1'` in config.js).
      const declRe = new RegExp(
        `(?:export\\s+)?(?:const|let|var)\\s+${second.replace(/[$.]/g, '\\$&')}\\s*=\\s*([^;\\n]+)`,
      );
      let expr = (code.match(declRe) || [])[1];
      if (!expr)
        for (const other of serverSourceFiles(dir)) {
          expr = (readFile(other).match(declRe) || [])[1];
          if (expr) break;
        }
      const literals = expr ? [...expr.matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]) : [];
      // `IS_ELECTRON ? '127.0.0.1' : undefined` is loopback in the app and every
      // interface under pm2 — the same exposure, in the mode that runs all day.
      if (
        expr &&
        (/\bundefined\b|\bnull\b/.test(expr) || literals.some((l) => !LOOPBACK_HOSTS.includes(l)))
      ) {
        findings.push(
          `${rel}: listen(${port}, ${second}) where ${second} = ${expr.trim()} — not loopback in every mode (undefined or a non-loopback address means every interface). Bind '127.0.0.1' unconditionally (project-standards § Network Exposure)`,
        );
      } else if (!expr || literals.length === 0) {
        warnings.push(
          `${rel}: listen(${port}, ${second}) — cannot resolve '${second}' to a literal; confirm it is always '127.0.0.1' (project-standards § Network Exposure)`,
        );
      }
    }

    // CORS: wildcard, reflect-anything, bare cors(), or any-port localhost regex.
    if (/\bcors\s*\(\s*\)/.test(code))
      findings.push(
        `${rel}: cors() with no options allows every origin — pass the app's exact origin(s) (project-standards § Network Exposure)`,
      );
    if (/\borigin\s*:\s*(?:['"]\*['"]|true\b)/.test(code))
      findings.push(
        `${rel}: CORS origin is a wildcard — any website can read the API. Pass the app's exact origin(s) (project-standards § Network Exposure)`,
      );
    // Reads past escaped slashes: the usual form, /^https?:\/\/localhost(:\d+)?$/,
    // has "\/\/" before localhost, which a plain [^/] stopped at.
    if (
      /\borigin\s*:\s*\[?\s*\/(?:\\\/|[^/\n])*localhost(?:\\\/|[^/\n])*\(\s*:\\d\+\s*\)\??/.test(
        code,
      )
    )
      findings.push(
        `${rel}: CORS accepts localhost on any port — a page from any other local dev server can read this API. Use the exact origin, e.g. \`http://127.0.0.1:\${port}\` (project-standards § Network Exposure)`,
      );
  }

  if (listens > 0 && !hostCheck) {
    findings.push(
      `no Host-header check — binding to 127.0.0.1 does not stop DNS rebinding, where a website re-resolves its domain to 127.0.0.1 and reads the API through the user's own browser. Reject requests whose Host is not 127.0.0.1:<port> or localhost:<port> with a 403 (project-standards § Network Exposure)`,
    );
  }

  if (listens > 0 && !originCheck) {
    findings.push(
      `no Origin check on state-changing requests — CORS only stops a website reading responses, not sending them: a page the user visits can POST a form (or a no-body request) to this server and it runs. Refuse POST/PUT/PATCH/DELETE whose Origin header is present and not the app's own origin with a 403 (project-standards § Network Exposure)`,
    );
  }

  for (const f of findings) fail(f);
  for (const w of warnings) warn(w);
  if (findings.length === 0 && warnings.length === 0 && listens > 0)
    ok(
      'Local server bound to loopback, Host header checked, CORS exact-origin, cross-site writes refused',
    );
}

/**
 * AI model IDs drift from the registry.
 *
 * The registry's verified date only proves the registry was reviewed; nothing
 * checked that the apps followed. A hand-kept list of "files to update" in
 * project-standards went stale as apps were added, and two apps it did not
 * name were left on GPT-5.4 while the registry moved on. Each project now
 * reports its own drift when `check` runs there, so a new app is covered the
 * first time it is opened.
 *
 * Any quoted Anthropic or OpenAI model ID that is not a current registry value
 * is flagged. A dated snapshot of a registry alias (claude-haiku-4-5-20251001
 * for claude-haiku-4-5) counts as current. Migration code that must name old
 * IDs so saved selections keep working opts out with a
 * `policy:legacy-model-ids` comment: the exemption runs from the marker to the
 * first closing `}` or `]` at the marker's indentation or less.
 *
 * WARN, not FAIL: the check landed while several apps were mid-migration, and
 * a picker may deliberately offer a model outside the two tiers.
 */
const MODEL_ID_RE =
  /['"`](claude-(?:opus|sonnet|haiku|instant|\d)[a-z0-9.-]*|gpt-\d[a-z0-9.-]*|o\d(?:-(?:mini|pro|preview))?(?:-\d{4}-\d{2}-\d{2})?)['"`]/g;
const MODEL_SNAPSHOT_SUFFIX = /^-(\d{8}|\d{4}-\d{2}-\d{2})$/;

function currentModelIds() {
  const entries = loadRegistry().entries || {};
  return Object.keys(entries)
    .filter((k) => /^(anthropic|openai)-model-/.test(k))
    .map((k) => entries[k].value);
}

function isCurrentModelId(id, current) {
  return current.some(
    (v) =>
      id === v ||
      (id.startsWith(v) && MODEL_SNAPSHOT_SUFFIX.test(id.slice(v.length))) ||
      (v.startsWith(id) && MODEL_SNAPSHOT_SUFFIX.test(v.slice(id.length))),
  );
}

/**
 * A project's recorded model exception (registry.json `modelExceptions`, keyed by the
 * package.json name): IDs the developer chose on purpose for that app, with the reason and date.
 */
function modelExceptionFor(dir) {
  const exceptions = loadRegistry().modelExceptions || {};
  let name = '';
  try {
    name = JSON.parse(readFile(path.join(dir, 'package.json'))).name || '';
  } catch {
    return null;
  }
  const entry = exceptions[name];
  return entry && Array.isArray(entry.ids) ? { name, ...entry } : null;
}

function auditModelIds(dir) {
  const exception = modelExceptionFor(dir);
  const current = [...currentModelIds(), ...(exception ? exception.ids : [])];
  if (current.length === 0) return;
  if (exception) {
    const age = (Date.now() - new Date(exception.decided).getTime()) / 86_400_000;
    const window = exception.reviewEveryDays || 60;
    if (!Number.isFinite(age) || age > window) {
      warn(
        `registry.json modelExceptions.${exception.name} (decided ${exception.decided}) is past its ${window}-day review: ` +
          `confirm ${exception.ids.join(', ')} are still the right models for this app, then update the date`,
      );
    }
  }
  const stale = [];
  let seen = 0;

  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (
        [
          'node_modules',
          'dist',
          'release',
          'build',
          'coverage',
          'tests',
          'test',
          '__tests__',
        ].includes(e.name)
      )
        continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(e.name) || /\.(test|spec)\./.test(e.name)) continue;

      const lines = readFile(full).split('\n');
      let exemptIndent = -1;
      lines.forEach((line, i) => {
        const indent = line.length - line.trimStart().length;
        if (exemptIndent >= 0) {
          if (/^\s*[}\]]/.test(line) && indent <= exemptIndent) exemptIndent = -1;
          return;
        }
        if (/policy:legacy-model-ids/.test(line)) {
          exemptIndent = indent;
          return;
        }
        if (/^\s*(\/\/|\*)/.test(line)) return;
        for (const m of line.matchAll(MODEL_ID_RE)) {
          seen++;
          if (!isCurrentModelId(m[1], current))
            stale.push(`${path.relative(dir, full)}:${i + 1} ${m[1]}`);
        }
      });
    }
  };
  walk(dir);

  if (stale.length > 0) {
    const shown = stale.slice(0, 8).join('; ');
    const more = stale.length > 8 ? `; +${stale.length - 8} more` : '';
    warn(
      `${stale.length} AI model ID(s) not in registry.json (current: ${current.join(', ')}): ${shown}${more}. ` +
        `Update routing and pickers to the registry values; check request parameters and saved selections, ` +
        `and mark migration maps with a policy:legacy-model-ids comment (project-standards § AI Integration)`,
    );
  } else if (seen > 0) {
    ok(
      exception
        ? `AI model IDs match registry.json (with this app's recorded exception: ${exception.ids.join(', ')})`
        : 'AI model IDs match registry.json',
    );
  }
}

/**
 * Claude response parsing must not assume the first content block is text.
 *
 * Sonnet 5, Opus 5/5.5, Fable and Mythos run adaptive thinking when the request
 * omits `thinking` (Sonnet 4.6 and Opus 4.8 did not), so the response opens with
 * a `thinking` block and `content[0].text` is undefined. One app threw
 * "Invalid Claude API response format" on every Smart-tier call and another
 * shipped returning undefined, both on the registry move to claude-sonnet-5. The model-ID check above passed both: the ID was current, the
 * parser was the part that broke.
 *
 * FAIL when a project names a thinking-by-default model and reads the first
 * block. WARN on a first-block read alone: it works today and breaks the day the
 * app moves to the registry's smart tier. Fix: join every `type === 'text'` block
 * (and send `thinking: {type: 'disabled'}` where a quick text task should not
 * think) — project-standards § AI Integration.
 */
const FIRST_BLOCK_TEXT_RE = /\bcontent\s*(?:\?\.)?\[\s*0\s*\]\s*(?:\?\.|\.)\s*text\b/;
const THINKING_DEFAULT_MODEL_RE = /['"`](claude-(?:sonnet-5|opus-5|fable|mythos)[a-z0-9.-]*)['"`]/;
// Models that reject `thinking: {type: 'disabled'}` with a 400: Sonnet 5.5
// (use `between_tools`), Opus 5.5 (lower the effort), Fable and Mythos (omit
// the parameter). Sonnet 5 and Opus 5 still accept it.
const NO_DISABLE_MODEL_RE = /['"`](claude-(?:sonnet-5-5|opus-5-5|fable|mythos)[a-z0-9.-]*)['"`]/;
const THINKING_DISABLED_RE = /\btype\s*:\s*['"]disabled['"]/;

function auditClaudeResponseParsing(dir) {
  const reads = [];
  const disabled = [];
  let thinkingModel = null;
  let noDisableModel = null;

  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (
        [
          'node_modules',
          'dist',
          'dist-electron',
          'release',
          'build',
          'coverage',
          'tests',
          'test',
          '__tests__',
          'venv',
        ].includes(e.name)
      )
        continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(js|jsx|ts|tsx|mjs|cjs|py)$/.test(e.name) || /\.(test|spec)\./.test(e.name)) continue;

      readFile(full)
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|#)/.test(line)) return;
          const rel = `${path.relative(dir, full)}:${i + 1}`;
          if (FIRST_BLOCK_TEXT_RE.test(line)) reads.push(rel);
          if (THINKING_DISABLED_RE.test(line)) disabled.push(rel);
          const m = !thinkingModel && line.match(THINKING_DEFAULT_MODEL_RE);
          if (m) thinkingModel = `${m[1]} (${rel})`;
          const n = !noDisableModel && line.match(NO_DISABLE_MODEL_RE);
          if (n) noDisableModel = `${n[1]} (${rel})`;
        });
    }
  };
  walk(dir);

  const list = (a) => a.slice(0, 5).join(', ') + (a.length > 5 ? `, +${a.length - 5} more` : '');
  if (reads.length > 0) {
    const fix =
      `Join every block with type === 'text' instead of reading content[0].text, and turn thinking off for quick ` +
      `text tasks the way the model allows (project-standards § AI Integration)`;
    if (thinkingModel) {
      fail(
        `Claude response read from the first content block (${list(reads)}) while ${thinkingModel} thinks by default — ` +
          `the first block is a thinking block, so the text is undefined. ${fix}`,
      );
    } else {
      warn(
        `Claude response read from the first content block (${list(reads)}) — this breaks when the app moves to ` +
          `claude-sonnet-5 (the registry smart tier), which returns a thinking block first. ${fix}`,
      );
    }
  }

  // The standard used to say "send thinking: {type: 'disabled'} for quick
  // tasks". On Sonnet 5.5 and Opus 5.5 that request is a 400, so the advice
  // itself would have broken the next smart-tier migration, the shape of the
  // content[0].text failure above.
  if (disabled.length > 0) {
    const fix =
      `Sonnet 5.5 turns thinking off with thinking: {type: 'between_tools'}; Opus 5.5 cannot turn it off (use output_config.effort 'low'); ` +
      `Fable and Mythos reject any explicit setting (omit it). {type: 'disabled'} works only on Sonnet 5, Opus 5 and Haiku 4.5 ` +
      `(project-standards § AI Integration)`;
    if (noDisableModel)
      fail(
        `thinking: {type: 'disabled'} sent (${list(disabled)}) while the app names ${noDisableModel}, which rejects it with a 400. ${fix}`,
      );
    else
      warn(
        `thinking: {type: 'disabled'} sent (${list(disabled)}) — accepted by the current smart tier, rejected by Sonnet 5.5 and Opus 5.5, ` +
          `so the next model move breaks it. ${fix}`,
      );
  }
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

function cmdCheck(dir, flags = []) {
  guardLocalPath(dir);
  const proj = detectProject(dir);
  const reg = loadRegistry();

  section(`Compliance check: ${path.resolve(dir)}`);

  if (path.resolve(dir) === POLICY_ROOT) {
    auditPolicyRepo(POLICY_ROOT);
    checkStaleness(dir, reg);
    return finish();
  }

  // The marketing site is the other half of the update path: shipped apps point
  // their update banner at a changelog page here, so a missing page is a dead
  // link in software already on customers' machines and unfixable there.
  if (path.basename(path.resolve(dir)) === 'tiongcreative-site') auditSite(dir);

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
        `sast script has unsanctioned global exclusion(s): ${rogue.map((r) => r.split('.').pop()).join(', ')} — only the five documented exclusions may be global; triage each finding and use per-line // nosemgrep instead (project-standards § Semgrep rule exclusions)`,
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
    // `mac.notarize` covers the .app only; the DMG wrapping it is a separate
    // artifact that Apple never sees. Both halves are required for a
    // distributable build, and the config check is what makes the gap visible
    // before a release rather than at the release check on a finished DMG.
    const afterAll = proj.pkg.build && proj.pkg.build.afterAllArtifactBuild;
    if (afterAll && exists(path.join(dir, afterAll))) {
      ok('DMG container signing wired (afterAllArtifactBuild)');
    } else {
      fail(
        afterAll
          ? `build.afterAllArtifactBuild points at ${afterAll}, which does not exist — the DMG would ship unsigned`
          : `No build.afterAllArtifactBuild — mac.notarize signs the .app but leaves the DMG container unsigned, ` +
              `which Gatekeeper rejects on download. Run 'policy scaffold', then set ` +
              `"afterAllArtifactBuild": "build/notarize-dmg.cjs" in package.json build config`,
      );
    }
    auditElectronStandards(dir, proj);
  } else if (proj.hasServer) {
    if (exists(path.join(dir, 'public/manifest.json'))) ok('PWA manifest present');
    else warn('No public/manifest.json — web apps should ship PWA icons');
  }

  // Security infrastructure audit — runs for all Express apps (Electron or standalone).
  if (proj.hasServer) {
    auditSecurityInfrastructure(dir, proj);
  }
  // Unconditional: servers also live outside server/ (monorepo apps/server,
  // src/server). Silent when no listen() exists.
  auditNetworkExposure(dir);
  // Unconditional: model IDs appear in client-only apps as well as servers.
  // Silent when a project names no model.
  auditModelIds(dir);
  auditClaudeResponseParsing(dir);

  // The lockfile must be committed. Without it `npm ci` cannot run at all, CI
  // resolves versions live on every push, and a peer-dependency conflict that a
  // lockfile would have pinned past surfaces as a broken install instead. It
  // also makes the integrity check meaningless: there is nothing in git to
  // verify. Two projects had drifted to ignoring it; the template never did.
  const giRaw = readFile(path.join(dir, '.gitignore'));
  if (/^\/?package-lock\.json\s*$/m.test(giRaw)) {
    fail(
      `.gitignore excludes package-lock.json — npm ci cannot run without it, so installs are ` +
        `resolved live and are not reproducible. Remove that line and commit the lockfile ` +
        `(project-standards § Supply Chain Security)`,
    );
  } else if (proj.hasPkg && !exists(path.join(dir, 'package-lock.json'))) {
    warn(`No package-lock.json — run npm install and commit it so npm ci is reproducible`);
  }

  // A node_modules above the project root shadows missing local dependencies.
  // Node resolution walks upward, so a project can run locally on packages it
  // never declared and then fail in CI, where only its own tree exists. The
  // failure looks like a CI-only bug and is really a local false positive.
  for (let up = path.dirname(path.resolve(dir)), hops = 0; hops < 3; hops++) {
    if (exists(path.join(up, 'node_modules'))) {
      // A FAIL rather than a warning, now that the portfolio root is clear.
      // While one existed above every project this could only have been noise,
      // since no project could fix it. From a clean state its reappearance
      // means `npm install` was run in the wrong directory — the mistake that
      // created the original 496 MB tree — and that is worth stopping on.
      fail(
        `A node_modules exists above this project (${up}/node_modules) — Node resolves upward, so ` +
          `missing local dependencies can be satisfied from it and the gap only appears in CI. ` +
          `This usually means npm install was run in the wrong directory; remove it`,
      );
      break;
    }
    const parent = path.dirname(up);
    if (parent === up) break;
    up = parent;
  }

  // SQL schema: idempotent where the engine allows it.
  //
  // Not a blanket "all SQL must be idempotent" rule, because SQLite (and so D1)
  // has no idempotent ADD COLUMN: `ALTER TABLE t ADD COLUMN IF NOT EXISTS` is a
  // syntax error, and repeating a plain ADD COLUMN fails with "duplicate column
  // name". Verified against sqlite 3.51. Running each migration exactly once is
  // the migration runner's job; what the schema author controls is the DDL that
  // *does* have a guarded form, and leaving that unguarded turns a re-run into
  // a hard failure for no reason.
  const sqlFiles = [];
  const walkSql = (d, depth) => {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (['node_modules', 'dist', 'release', 'coverage', '.git'].includes(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walkSql(full, depth + 1);
      else if (e.name.endsWith('.sql')) sqlFiles.push(full);
    }
  };
  walkSql(dir, 0);
  const unguarded = [];
  const destructive = [];
  for (const f of sqlFiles) {
    const src = readFile(f);
    // A file that drops its tables is a reset script, not a baseline schema.
    // Demanding IF NOT EXISTS there is noise: the tables were dropped moments
    // earlier, so the guard decorates a statement that cannot collide, and it
    // disguises what the file does. What matters for these is that nothing can
    // point them at production, which is checked separately below.
    if (/\bDROP\s+TABLE\b/i.test(src)) {
      destructive.push(path.relative(dir, f));
      continue;
    }
    for (const kind of ['TABLE', 'INDEX']) {
      const all = (src.match(new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?${kind}\\s`, 'gi')) || []).length;
      const safe = (
        src.match(new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?${kind}\\s+IF\\s+NOT\\s+EXISTS`, 'gi')) || []
      ).length;
      if (all > safe) unguarded.push(`${path.relative(dir, f)} (CREATE ${kind})`);
    }
  }
  // A reset script reachable against the remote database is a data-loss
  // command sitting behind a routine-sounding npm script. The docs saying "do
  // not run this on production" are not a control: anything that can be typed
  // in one command eventually is, and this one is named like a migration.
  if (destructive.length > 0 && proj.pkg && proj.pkg.scripts) {
    for (const [name, cmd] of Object.entries(proj.pkg.scripts)) {
      const hitsReset = destructive.some((d) => String(cmd).includes(path.basename(d)));
      if (hitsReset && /--remote|--env\s+production|\bprod\b/.test(String(cmd))) {
        fail(
          `npm script "${name}" runs a DROP TABLE script against the remote database: ${cmd}. ` +
            `Use the migration runner for remote schema changes and keep reset scripts local-only, ` +
            `or gate this behind an explicit confirmation flag (project-standards § SQL schema changes)`,
        );
      }
    }
  }

  if (sqlFiles.length > 0) {
    if (unguarded.length === 0) ok(`SQL schema uses IF NOT EXISTS where the engine supports it`);
    else
      fail(
        `SQL without IF NOT EXISTS, so re-running the schema fails instead of no-opping: ${unguarded.join(', ')}. ` +
          `CREATE TABLE/INDEX have a guarded form and should use it; ADD COLUMN has none in SQLite, so that belongs ` +
          `in its own tracked migration (project-standards § Data Migration)`,
      );
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
  if (proj.pkg && proj.pkg.version && shippedDmgVersions(dir, proj).has(proj.pkg.version)) {
    if (changedFiles(dir).filter(isSourceFile).length > 0) {
      fail(
        `Source changed but version ${proj.pkg.version} already has a built DMG (shipped = frozen) — bump the version and start a new CHANGELOG section`,
      );
    } else {
      ok(`Version ${proj.pkg.version} shipped (DMG built), no new source changes`);
    }

    // An unfinished release blocks the next one. The steps that actually ship —
    // uploading to Gumroad, updating the site — happen in a browser, where no
    // hook can see them, so the sign-off cannot be enforced at the moment it is
    // skipped. It can be noticed afterwards: a DMG exists for this version and
    // nothing marks the commit it was cut from. Surfaced at session start,
    // which is the next time the project is opened.
    //
    // Keyed on the git tag rather than the recorded ack because `.policy/` is
    // gitignored, so the ack is per-machine and a fresh clone would report a
    // finished release as unfinished. A tag is pushed and shared. Scoped to the
    // current version so older DMGs left in release/ are not re-litigated.
    if (proj.isGit) {
      const relTag = `v${proj.pkg.version}`;
      const tagged =
        sh(`git tag --list ${safeToken(relTag, 'git tag')}`, dir).out.trim() === relTag;
      if (tagged) ok(`Release ${relTag} tagged`);
      else
        fail(
          `A DMG exists for ${proj.pkg.version} but ${relTag} is not tagged — the release was started and never signed off. ` +
            `Finish it (dogfood, upload, site update), then: git tag ${relTag} && git push origin ${relTag}, ` +
            `and the developer runs verify-ready --release --ack-manual`,
        );
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
  // Every third-party package in the lockfile must carry an integrity hash.
  // Without one npm cannot checksum what it downloaded, so the lockfile pins a
  // version but not its contents — the supply-chain guarantee the lockfile
  // exists to provide. Observed 2026-09-01: a regenerated lockfile kept
  // `integrity` on only the 50 packages it newly added and dropped it from the
  // other 674, which no test catches because `npm ci` installs happily without
  // it. The loss is invisible in a diff that also moves thousands of lines.
  //
  // Two exclusions, both structural rather than thresholds: bundled
  // dependencies (`inBundle`) ship inside their parent's tarball and have none
  // of their own, and workspace packages (paths outside node_modules/) are
  // local source with nothing to verify against.
  const lock = readJSON(path.join(dir, 'package-lock.json'));
  if (lock && lock.packages) {
    const unverified = Object.entries(lock.packages).filter(
      ([name, meta]) =>
        name.startsWith('node_modules/') && !meta.link && !meta.inBundle && !meta.integrity,
    );
    if (unverified.length === 0)
      ok('Lockfile: every third-party package carries an integrity hash');
    else
      fail(
        `${unverified.length} package(s) in package-lock.json have no integrity hash, so npm cannot verify what it downloads ` +
          `(e.g. ${unverified
            .slice(0, 3)
            .map(([n]) => n.replace('node_modules/', ''))
            .join(', ')}). ` +
          `Regenerate the lockfile from a clean tree: rm -rf node_modules package-lock.json && npm install`,
      );
  }

  // .nvmrc is what CI resolves its Node from (node-version-file), so a project
  // whose file disagrees with the registry builds on a different Node than the
  // one the policy pins — and the lockfile it writes is the one CI must read.
  const nvmrcPin = (loadRegistry().entries || {})['node-lts'];
  if (nvmrcPin && nvmrcPin.value && exists(path.join(dir, '.github/workflows/ci.yml'))) {
    const have = readFile(path.join(dir, '.nvmrc')).trim();
    if (!have)
      fail(
        `Missing .nvmrc — CI resolves its Node from it, and without it local and CI drift apart (run: policy scaffold)`,
      );
    else if (have !== nvmrcPin.value)
      fail(
        `.nvmrc says Node ${have} but the policy pins ${nvmrcPin.value} — CI and this project would build on different Node versions, and npm ci needs the npm that wrote the lockfile`,
      );
    else ok(`.nvmrc matches the pinned Node (${have})`);
  }

  // WARN, not FAIL: only /security-review needs it, and the Stop hook repeats
  // the fix at the moment a security review is required. scaffold sets it.
  const originHead = proj.isGit ? missingOriginHead(dir) : null;
  if (originHead !== null)
    warn(
      `git has no origin/HEAD (created only by a clone), so /security-review cannot run here. Fix: ` +
        (originHead
          ? `policy scaffold, or git remote set-head origin ${originHead}`
          : `git fetch origin, then policy scaffold`),
    );

  if (exists(path.join(dir, AUDIT_EXCEPTIONS))) {
    const problems = auditExceptionProblems(loadAuditExceptions(dir), undefined, dir);
    if (problems.length) fail(`audit-exceptions.json: ${problems.join('; ')}`);
    else
      ok(
        `audit-exceptions.json valid (${Object.keys(loadAuditExceptions(dir)).length} exception(s))`,
      );
  }

  const ciPath = path.join(dir, '.github/workflows/ci.yml');
  if (exists(ciPath)) {
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    if (
      norm(canonicalPolicyPath(readFile(ciPath), dir)) !==
      norm(readFile(path.join(TEMPLATES, 'ci.yml')))
    ) {
      fail(
        `ci.yml differs from the shared template — sync it: cp ${policyRel(dir)}/templates/ci.yml .github/workflows/ci.yml (deviations belong in the template, not the project)`,
      );
    } else ok('CI workflow matches shared template');
  }

  // Pre-commit hook template drift
  const pcPath = path.join(dir, '.husky/pre-commit');
  if (exists(pcPath)) {
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    if (
      norm(canonicalPolicyPath(readFile(pcPath), dir)) !==
      norm(readFile(path.join(TEMPLATES, 'pre-commit')))
    ) {
      fail(
        `.husky/pre-commit differs from the shared template — THIS PROJECT IS UNENFORCED (no verify-marker). Sync: delete .husky/pre-commit, then policy scaffold (writes this project's path to build-policy, ${policyRel(dir)})`,
      );
    } else ok('Pre-commit hook matches shared template');
  }

  // Dependabot config template drift (quote-style-insensitive) — presence-only
  // checking let projects fork on cooldown settings
  const dbPath = path.join(dir, '.github/dependabot.yml');
  if (exists(dbPath)) {
    const norm = (s) => s.replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
    if (
      norm(canonicalPolicyPath(readFile(dbPath), dir)) !==
      norm(readFile(path.join(TEMPLATES, 'dependabot.yml')))
    ) {
      fail(
        `dependabot.yml differs from the shared template — sync: cp ${policyRel(dir)}/templates/dependabot.yml .github/dependabot.yml (deviations belong in the template)`,
      );
    } else ok('Dependabot config matches shared template');
  }

  // AGENTS.md template drift (non-Claude agents rely on this being current)
  const agPath = path.join(dir, 'AGENTS.md');
  if (exists(agPath)) {
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    if (
      norm(canonicalPolicyPath(readFile(agPath), dir)) !==
      norm(readFile(path.join(TEMPLATES, 'AGENTS.md')))
    ) {
      fail(
        `AGENTS.md differs from the shared template — sync: delete AGENTS.md, then policy scaffold (writes this project's path to build-policy, ${policyRel(dir)})`,
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
  // Enforce the verdict health recorded, at no cost here. This is the half that
  // makes staleness bite: health does the network work and writes what it
  // found, check blocks on it every time gates run. Without this the rule was
  // only as strong as remembering to run a maintenance command.
  const recordedStale = (loadState(dir).staleDeps || []).filter(Boolean);
  if (recordedStale.length > 0) {
    fail(
      `${recordedStale.length} dependency update(s) overdue as of the last health run: ` +
        `${recordedStale.slice(0, 4).join('; ')}${recordedStale.length > 4 ? ', …' : ''} — run: policy deps-update`,
    );
  }

  const healthDays = (reg.staleness && reg.staleness.healthRunDays) || 30;
  if (state.lastHealthRun) {
    const d = daysSince(state.lastHealthRun);
    if (d > healthDays)
      // A FAIL, not a warning. health is the only place dependency staleness is
      // measured, and nothing forced it to run, so an unrun health check meant
      // staleness was simply unenforced. Now that compliance blocks gates, an
      // overdue health run stops work until it is done.
      fail(`Maintenance overdue: last 'policy health' run ${d} days ago (run: policy health)`);
    else ok(`Maintenance current (last health run ${d} days ago)`);
  } else {
    // Never run is the weakest state, not the mildest: dependency staleness has
    // never been measured here at all. Treating it more leniently than an
    // overdue run would exempt exactly the projects that need it most.
    fail(
      `No maintenance record — dependency staleness has never been measured here. Run: policy health`,
    );
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
  // Embedded in another command: the caller inspects results and prints its
  // own summary, so this must neither report nor exit.
  if (embedded) return;
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
  // Quota-bounded, same argument as the Socket scan above: the CLI allowance is
  // a few reviews per rolling window, and a diff with no source in it gives a
  // code reviewer nothing to read. Spending a review on a packaging-config or
  // docs-only change buys nothing and leaves the allowance empty for the next
  // real change — which is how a two-line config edit ends up blocking for half
  // an hour. Skipped only when there ARE changes and none of them are source: a
  // clean tree still runs the gate, so the review_skipped FAIL below keeps
  // catching already-committed work that was never reviewed. Force it back on
  // with `gates --with-review`.
  { name: 'CodeRabbit review', script: 'review', whenSourceChanges: true },
  { name: 'Build', script: 'build' },
  { name: 'Unit tests', script: 'test:unit' },
  { name: 'Smoke tests', script: 'test:smoke' },
  { name: 'Integration tests', script: 'test:integration' },
  // End-to-end flows through the built app (Playwright). Help-centre pages and
  // screenshots are captured from these flows, so a change that breaks a
  // documented screen fails the app's own gates instead of surfacing later as
  // a stale help page. Full gates only: a browser run is too slow for the
  // pre-commit subset. The script rebuilds before running, which repeats the
  // Build gate's work; accepted, it costs seconds.
  { name: 'Flow tests', script: 'test:flows' },
];

/**
 * Run the compliance audit in-process and return its FAIL lines.
 *
 * Compliance was advisory: `check` reported at session start and nothing bound
 * on it, so a project could fail every structural rule and still gate, commit
 * and ship. The only thing standing in the gap was a line of prose telling a
 * human to fix FAIL items first, which is the exact failure mode this policy
 * exists to remove, sitting at its centre.
 *
 * It belongs in `gates` rather than at release. Gates run before work is
 * presented, so a gap is found while the fix is cheap. Binding it at release
 * instead would surface structural problems after testing and force a retest.
 */
function complianceSummary(dir) {
  const saved = { ...results, lines: [...results.lines] };
  const savedHook = hookMode;
  results.pass = 0;
  results.warn = 0;
  results.fail = 0;
  results.lines = [];
  hookMode = true; // suppress the per-line output; we only want the verdict
  embedded = true; // finish() must return here, not exit the gates run
  try {
    cmdCheck(dir);
  } catch {
    /* a crashing audit must not take the gates down */
  }
  const summary = {
    pass: results.pass,
    warn: results.warn,
    fail: results.fail,
    lines: [...results.lines],
  };
  Object.assign(results, saved);
  hookMode = savedHook;
  embedded = false;
  return summary;
}

function complianceFailures(dir) {
  return complianceSummary(dir)
    .lines.filter((l) => l.startsWith('FAIL: '))
    .map((l) => l.slice(6));
}

/**
 * `check --all`: every project beside build-policy, one table. Compliance is
 * a gate with no known-debt mechanism, so the number of projects whose gates
 * cannot run is the portfolio's backlog, and it was only visible by surveying
 * each project by hand.
 */
function cmdCheckAll() {
  const parent = path.dirname(POLICY_ROOT);
  const isProject = (d) =>
    ['package.json', 'AGENTS.md', '.github/workflows/ci.yml', 'CLAUDE.md'].some((f) =>
      exists(path.join(d, f)),
    );
  const dirs = fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'build-policy-public')
    .map((e) => path.join(parent, e.name))
    .filter((d) => d === POLICY_ROOT || isProject(d))
    .sort();
  section(`Compliance across ${dirs.length} projects in ${parent}`);
  const rows = dirs.map((d) => ({ name: path.basename(d), ...complianceSummary(d) }));
  const w = Math.max(...rows.map((r) => r.name.length), 7);
  console.log(`  ${'project'.padEnd(w)}   ok  warn  fail`);
  for (const r of rows)
    console.log(
      `  ${r.fail ? RED : GREEN}${r.name.padEnd(w)}${RESET}  ${String(r.pass).padStart(3)}  ${String(r.warn).padStart(4)}  ${String(r.fail).padStart(4)}`,
    );
  const failing = rows.filter((r) => r.fail > 0);
  for (const r of failing) {
    console.log(`\n${BOLD}${r.name}${RESET}`);
    for (const l of r.lines.filter((l) => l.startsWith('FAIL: ')))
      console.log(`  ${RED}✗${RESET} ${l.slice(6)}`);
  }
  const totalFail = rows.reduce((n, r) => n + r.fail, 0);
  console.log(
    `\n${BOLD}${failing.length ? RED + 'FAIL' : GREEN + 'PASS'}${RESET} — ${rows.length - failing.length} of ${rows.length} projects pass, ${totalFail} failures\n`,
  );
  process.exit(failing.length ? 1 : 0);
}

/**
 * Review a repository's first commit. CodeRabbit reviews a diff against a
 * base, and a root commit has none, so a new repository's first gates run on
 * a clean tree could never pass the review gate. Copy the committed files
 * into a scratch repository that starts with an empty commit, and review the
 * snapshot against it: the method the review gate's own failure message
 * described, first done by hand for a repository created from a template.
 */
function reviewRootCommit(dir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-root-review-'));
  try {
    const steps = [
      ['git', ['init', '-q', '-b', 'main'], tmp],
      [
        'git',
        [
          '-c',
          'user.name=policy',
          '-c',
          'user.email=policy@localhost',
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'empty base',
        ],
        tmp,
      ],
    ];
    for (const [c, a, w] of steps) {
      const r = require('child_process').spawnSync(c, a, { cwd: w, encoding: 'utf8' });
      if (r.status !== 0)
        return { ok: false, out: `could not prepare the first-commit review: ${r.stderr}` };
    }
    const base = sh('git rev-parse HEAD', tmp).out.trim();
    // No shell: the archive goes from git to tar as bytes, so no path is ever
    // interpolated into a command line.
    const archive = require('child_process').spawnSync('git', ['archive', 'HEAD'], {
      cwd: dir,
      maxBuffer: 1 << 30,
    });
    if (archive.status !== 0)
      return { ok: false, out: `could not archive the first commit: ${archive.stderr}` };
    const untar = require('child_process').spawnSync('tar', ['-x', '-C', tmp], {
      input: archive.stdout,
    });
    if (untar.status !== 0)
      return { ok: false, out: `could not copy the first commit: ${untar.stderr}` };
    sh('git add -A', tmp);
    sh(
      "git -c user.name=policy -c user.email=policy@localhost commit -q -m 'first commit snapshot'",
      tmp,
    );
    const r = sh(`coderabbit review --agent --base-commit ${safeToken(base, 'commit')}`, tmp);
    return { ok: r.ok, out: r.out };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function cmdGates(dir, flags) {
  guardLocalPath(dir);
  const proj = detectProject(dir);
  if (!proj.hasPkg) {
    const failures = complianceFailures(dir);
    if (failures.length > 0) {
      console.log(`\n${RED}${BOLD}Gate failed: compliance check.${RESET}`);
      for (const f of failures) console.log(`  ${RED}✗${RESET} ${f}`);
      console.log(`\nFix, then re-run: policy gates\n`);
      process.exit(1);
    }
    const files = changedFiles(dir)
      .filter((f) => !f.startsWith('.policy/'))
      .sort();
    const marker = {
      timestamp: new Date().toISOString(),
      diffHash: diffHash(dir),
      files,
      contentHash: contentHash(dir, files),
      gates: [{ name: 'Compliance check', status: 'pass' }],
    };
    fs.mkdirSync(path.join(dir, '.policy'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.policy', 'gates.json'),
      JSON.stringify(marker, null, 2) + '\n',
    );
    console.log(
      `\n${GREEN}${BOLD}Documentation-only repo: check passed. Marker written.${RESET}\n`,
    );
    return;
  }
  const fast = flags.includes('--fast');
  const withReview = flags.includes('--with-review');
  const scripts = proj.pkg.scripts || {};
  const gates = GATE_ORDER.filter((g) => (fast ? g.fast : true)).filter((g) => scripts[g.script]);

  // A diff that touches no source has nothing for a code reviewer to read. An
  // empty diff is NOT that case — it means the work is already committed, and
  // the review gate must still run so a never-reviewed tree cannot slip past.
  const changedNow = changedFiles(dir);
  // Hash of the source alone. The marker's diffHash covers the whole tree, so
  // adding the CHANGELOG entry the Stop hook requires invalidates it and the
  // next gates run re-reviews source the reviewer has already read — the same
  // code plus one prose line, at full cost against a small rolling allowance.
  // Keyed on source instead, an unchanged codebase is not re-reviewed however
  // many times the changelog, docs or config move.
  const sourceOnlyHash = () => {
    const files = workFiles.filter(isSourceFile).sort();
    if (files.length === 0) return null;
    const h = crypto.createHash('sha256');
    h.update(files.join('\n'));
    for (const f of files) h.update('\0' + readFile(path.join(dir, f)));
    return h.digest('hex');
  };
  const prevMarker = readJSON(path.join(dir, '.policy', 'gates.json'));

  // A clean tree means the work is committed, not that there is nothing to
  // gate. Gates used to judge only the uncommitted diff, so once anything the
  // last pass had not seen was committed — a lockfile fix, say — no route to a
  // pass remained: the review saw an empty diff and failed by design. Instead,
  // gate what was committed since the last pass (the HEAD its marker records),
  // or, for a marker from before HEAD was recorded, since the last release tag.
  let workFiles = changedNow;
  let reviewBase = null;
  let nothingSincePass = false;
  // A clean tree on a repository's first commit, with nothing earlier to
  // compare against: review the whole commit from an empty base.
  let rootReview = false;
  if (changedNow.length === 0 && proj.isGit) {
    const head = currentHead(dir);
    let base = null;
    if (prevMarker && prevMarker.head && head) {
      if (prevMarker.head === head) nothingSincePass = true;
      else if (
        sh(`git merge-base --is-ancestor ${safeToken(prevMarker.head, 'commit')} HEAD`, dir).ok
      )
        base = prevMarker.head;
    } else if (head) {
      const tag = sh('git describe --tags --abbrev=0 HEAD', dir);
      if (tag.ok && sh(`git rev-list -n 1 ${safeToken(tag.out, 'tag')}`, dir).out !== head)
        base = tag.out;
    }
    const since = base ? filesBetween(dir, base) : null;
    if (since) {
      reviewBase = base;
      workFiles = since.filter((f) => !f.startsWith('.policy/'));
    } else if (!nothingSincePass && head && !sh('git rev-parse --verify --quiet HEAD^', dir).ok) {
      rootReview = true;
      workFiles = sh('git ls-tree -r --name-only HEAD', dir).out.split('\n').filter(Boolean);
    }
  }
  const srcHash = sourceOnlyHash();
  // Only carries forward a review that actually happened: the previous marker
  // must record the gate AND the source must be byte-identical. Anything else
  // re-runs it, so this can shorten the path but never skip a first review.
  const alreadyReviewed =
    !withReview &&
    srcHash !== null &&
    prevMarker &&
    prevMarker.reviewedSourceHash === srcHash &&
    Array.isArray(prevMarker.gates) &&
    prevMarker.gates.includes('CodeRabbit review');
  // Committed since a reviewed pass with no source among it (a lockfile fix):
  // the review still describes every line of source, so it carries forward.
  // Without this the new marker would record no review and verify-ready
  // --release would refuse the tree the review had already read.
  const reviewCarried =
    alreadyReviewed ||
    (!withReview &&
      prevMarker &&
      Array.isArray(prevMarker.gates) &&
      prevMarker.gates.includes('CodeRabbit review') &&
      (nothingSincePass ||
        (reviewBase !== null &&
          reviewBase === prevMarker.head &&
          workFiles.filter(isSourceFile).length === 0)));
  const skipReview =
    !withReview &&
    ((workFiles.length > 0 && workFiles.filter(isSourceFile).length === 0) ||
      reviewCarried ||
      nothingSincePass);
  const willRunReview = !fast && !skipReview && gates.some((g) => g.script === 'review');

  section(`Quality gates (${fast ? 'fast/pre-commit' : 'full'}): ${path.resolve(dir)}`);

  // Compliance first: the cheapest gate, and it describes structure, so a gap
  // found here is fixed before any time goes into tests, a build or a DMG.
  //
  // No mechanism exists to accept a failure as known debt. A gate that lets you
  // record failures as acceptable is a report with extra steps, and an escape
  // hatch reachable by whoever just got stopped is the thing this policy exists
  // to remove. Compliance is either met or the gates do not run.
  if (!fast) {
    const failures = complianceFailures(dir);
    if (failures.length > 0) {
      console.log(`  ${RED}✗${RESET} Compliance (${failures.length})`);
      for (const f of failures) console.log(`      ${RED}•${RESET} ${f}`);
      console.log(
        `\n${RED}${BOLD}Gates stopped at Compliance.${RESET} No other gate ran.\n` +
          `Most of these are mechanical: ${DIM}policy scaffold${RESET} fixes the missing files and scripts, ` +
          `and template drift is a copy from build-policy/templates/.\n`,
      );
      process.exit(1);
    }
    console.log(`  ${GREEN}✓${RESET} Compliance`);
  }

  // CI's first step. Runs in the fast pre-commit subset too: a lockfile
  // `npm ci` rejects must not be committable at all.
  {
    const before = results.fail;
    auditLockfileSync(dir);
    if (results.fail > before) return finish();
  }

  // Packages that run code at install time (preinstall, install, postinstall)
  // are the most concrete risk in a dependency tree: their code runs on this
  // Mac the moment npm installs them. Read locally with `npm query`, no lookup.
  // Each must be recorded with a reason in allowed-packages.json
  // `_installScripts`; a new one stops the gates until someone looks at it.
  if (!fast) {
    const before = results.fail;
    auditInstallScripts(dir);
    if (results.fail > before) return finish();
  }

  // Registry signatures and provenance for every installed package, from
  // npm itself: no account, no quota (policy 2.58). Full gates only, since it
  // asks the registry about each package.
  if (
    !fast &&
    exists(path.join(dir, 'package-lock.json')) &&
    exists(path.join(dir, 'node_modules'))
  ) {
    const sig = sh('npm audit signatures', dir);
    if (sig.ok) ok('Registry signatures verified (npm audit signatures)');
    else {
      fail(
        `npm audit signatures failed — a package's registry signature or provenance does not verify, which is how a ` +
          `tampered or substituted package shows up. Investigate before anything else:\n${sig.out.split('\n').slice(-12).join('\n')}`,
      );
      return finish();
    }
  }

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
  if (willRunReview && proj.isGit) {
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
  const depsChanged = workFiles.some((f) => DEPENDENCY_FILE.test(f));

  const report = [];
  for (const g of gates) {
    if (g.whenDepsChange && !depsChanged) {
      console.log(
        `  ${DIM}skipped${RESET} ${g.name} ${DIM}(no dependency change — CI scans every push)${RESET}`,
      );
      continue;
    }
    if (g.whenSourceChanges && skipReview) {
      console.log(
        reviewCarried
          ? `  ${DIM}skipped${RESET} ${g.name} ${DIM}(source unchanged since the last review — carried forward; force: gates --with-review)${RESET}`
          : `  ${DIM}skipped${RESET} ${g.name} ${DIM}(no source in this diff — review allowance saved for code changes; force: gates --with-review)${RESET}`,
      );
      continue;
    }
    const t0 = Date.now();
    process.stdout.write(`  ${DIM}running${RESET} ${g.name} (npm run ${g.script}) ... `);
    // Committed work is reviewed against the commit the last pass saw.
    const extra =
      g.script === 'review' && reviewBase
        ? ` -- --base-commit ${safeToken(reviewBase, 'commit')}`
        : '';
    if (extra) process.stdout.write(`${DIM}(committed since ${reviewBase.slice(0, 12)})${RESET} `);
    if (g.script === 'review' && rootReview)
      process.stdout.write(`${DIM}(first commit, reviewed from an empty base)${RESET} `);
    const r =
      g.script === 'security' && exists(path.join(dir, AUDIT_EXCEPTIONS))
        ? auditWithExceptions(dir)
        : g.script === 'review' && rootReview
          ? reviewRootCommit(dir)
          : sh(`npm run ${safeToken(g.script, 'script name')}${extra}`, dir);
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
    // On a clean tree the verified files are the ones committed since the
    // base, so markerMatches can tell them from anything committed later.
    const verifiedFiles = (reviewBase ? workFiles : changedFiles(dir))
      .filter((f) => !f.startsWith('.policy/'))
      .sort();
    const marker = {
      diffHash: diffHash(dir),
      // The commit this pass describes. Lets markerMatches reject later
      // commits it never saw, and gives a clean-tree run its review base.
      head: currentHead(dir),
      // Recorded so the marker survives the commit, which empties the
      // changed-file list without altering any verified content.
      files: verifiedFiles,
      contentHash: contentHash(dir, verifiedFiles),
      timestamp: new Date().toISOString(),
      // A carried-forward review is recorded as a pass, because the code was
      // reviewed — verify-ready --release refuses to ship without this, and it
      // must not be tricked by the carry-forward or defeated by it.
      gates: reviewCarried
        ? [...new Set([...report.map((r) => r.gate), 'CodeRabbit review'])]
        : report.map((r) => r.gate),
      // The source the review actually examined. Absent when the diff has no
      // source, so a later source change cannot inherit an unrelated pass.
      reviewedSourceHash:
        srcHash !== null && (alreadyReviewed || report.some((r) => r.gate === 'CodeRabbit review'))
          ? srcHash
          : reviewCarried && srcHash === null
            ? prevMarker.reviewedSourceHash || null
            : null,
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

// ---------------------------------------------------------- security-ack

/**
 * Record that `/security-review` was run over the security-sensitive files in
 * the current tree. Bound to a content hash of exactly those files, so the ack
 * cannot carry forward: edit one of them and it stops matching, which is the
 * whole point — a review of last week's auth code says nothing about today's.
 */
function cmdSecurityAck(dir) {
  guardLocalPath(dir);
  section(`Security review ack: ${path.resolve(dir)}`);
  const sensitive = securitySensitiveFiles(dir, changedFiles(dir)).sort();
  if (sensitive.length === 0) {
    console.log(
      `No security-sensitive files in the current diff — nothing to acknowledge.\n` +
        `${DIM}The ack is only required when auth, secrets, crypto, CORS, payment or data-deletion code changes.${RESET}\n`,
    );
    return;
  }
  const state = loadState(dir);
  state.securityReview = {
    hash: contentHash(dir, sensitive),
    files: sensitive,
    time: new Date().toISOString(),
  };
  saveState(dir, state);
  console.log(
    `${GREEN}✓${RESET} Security review recorded for ${sensitive.length} file(s):\n` +
      sensitive.map((f) => `    ${DIM}${f}${RESET}`).join('\n') +
      `\n\n${DIM}Re-run /security-review and this command if any of them change again.${RESET}\n`,
  );
}

// ----------------------------------------------------------- verify-marker

/**
 * Pre-commit enforcement: source or dependency files changed => full gates
 * must have passed on this exact tree (.policy/gates.json). Doc-only commits
 * pass without a marker; a lockfile-only commit does not, because it changes
 * what CI installs. Exits 1 to block the commit otherwise.
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

  const sourceChanged = changedFiles(dir).filter(isGatedFile);
  if (sourceChanged.length === 0) return;
  const marker = readJSON(path.join(dir, '.policy', 'gates.json'));
  if (markerMatches(dir, marker)) {
    console.log(`${GREEN}✓${RESET} Full gates passed on this exact tree (${marker.timestamp})`);
    return;
  }
  console.log(
    `\n${RED}${BOLD}BUILD-POLICY: commit blocked.${RESET} ` +
      (marker
        ? `Source or dependencies changed since full gates last passed (${marker.timestamp}).`
        : 'Source or dependencies changed but full quality gates have never passed on this tree.') +
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
    shippedDmgVersions(dir, proj).has(proj.pkg.version)
  ) {
    fail(
      `Version ${proj.pkg.version} already shipped as a DMG — bump the version and start a new CHANGELOG section before declaring ready`,
    );
  }
  // 2b. Security review for auth/data/payment/CORS/secret changes. Phase 5 has
  // always required this; until now nothing checked that it happened.
  const sensitive = securitySensitiveFiles(dir, changed).sort();
  if (sensitive.length > 0) {
    const rec = loadState(dir).securityReview;
    if (rec && rec.hash === contentHash(dir, sensitive))
      ok(`Security review recorded for the ${sensitive.length} sensitive file(s) (${rec.time})`);
    else
      fail(
        `${sensitive.length} security-sensitive file(s) changed without a recorded review: ${sensitive.join(', ')}.\n` +
          `      Run /security-review over these changes, address what it finds, then record it:\n` +
          `      node ../build-policy/scripts/policy.js security-ack` +
          (rec
            ? `\n      ${DIM}(a review is recorded, but for different content — it no longer applies)${RESET}`
            : ''),
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

  // Record a clean pass so later steps can require it. Until now verify-ready
  // reported and forgot, which is why nothing downstream could depend on it:
  // the DMG build guard had to re-derive a couple of its checks ad hoc, and the
  // rest went unenforced. Bound to the gates marker's content hash, so the
  // record describes an exact tree and cannot survive an edit.
  const vrMarker = readJSON(path.join(dir, '.policy', 'gates.json'));
  if (results.fail === 0 && vrMarker && markerMatches(dir, vrMarker)) {
    const state = loadState(dir);
    state.verifyReady = {
      contentHash: vrMarker.contentHash,
      release,
      time: new Date().toISOString(),
    };
    saveState(dir, state);
  }
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
    'Settings Check for updates refreshes immediately after the site update, reports up to date and clears the banner',
    'Relaunched after the site update: the automatic check on launch also shows no banner (versions match)',
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

  // `gates` skips the review on a source-free diff to protect a small CLI
  // allowance. That trade is only safe if the review is unconditional at the
  // one point where unreviewed code would actually ship, so a release is
  // refused unless the marker records a CodeRabbit pass. The recovery is the
  // force flag, not a re-run — a plain re-run would skip it again.
  const relMarker = readJSON(path.join(dir, '.policy', 'gates.json'));
  if (relMarker && Array.isArray(relMarker.gates)) {
    if (relMarker.gates.includes('CodeRabbit review'))
      ok('CodeRabbit review passed on the tree being released');
    else
      fail(
        `The gates marker records no CodeRabbit review — a release must not ship code the reviewer never opened. ` +
          `Re-run with the review forced on: policy gates --with-review`,
      );
  }

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

  // Gatekeeper acceptance of the DMG container. `mac.notarize: true` staples
  // the .app and then wraps it, leaving the container unsigned — every DMG
  // shipped before 2026-09-02 was rejected by this exact check while the app
  // inside passed, so nothing in the old flow could have caught it. Verified on
  // the artifact rather than trusted from config, because the config being
  // right is not evidence the credentials resolved or that notarization
  // actually succeeded: a signed-but-unstapled DMG is the failure that only
  // shows up on a machine other than the one that built it.
  // Gates the sign-off below: a release whose container Gatekeeper rejects must
  // not be recordable as acknowledged. The check already ran, it simply did not
  // bind, so the FAIL was advisory and depended on someone reading it.
  let dmgRejected = false;
  if (proj.isElectron && proj.pkg) {
    const dmgPath = releaseDmgPath(dir, proj.pkg.version);
    if (!dmgPath) {
      // No artifact yet: the pre-build stage below reports this correctly, and
      // a FAIL here would demand a check on a file the build order says should
      // not exist yet.
    } else {
      const assessed = assessDmg(
        // 2>&1 is required, not defensive. spctl writes its verdict to stderr
        // and exits 0 on success, and sh() returns stdout only on success (it
        // merges both streams only on failure). Without the redirect this reads
        // an empty string, /accepted/ never matches, and a correctly signed DMG
        // is reported as having no usable signature — refusing to ship the one
        // artifact that is actually fine. The bug hid because the obvious test
        // is an unsigned DMG, which exits non-zero and takes the merged path.
        dmgPath,
        dir,
      );
      const stapled = shArgs('xcrun', ['stapler', 'validate', dmgPath], dir);
      if (/accepted/.test(assessed.out) && stapled.ok) {
        ok(`DMG container signed, notarized and stapled (${path.basename(dmgPath)})`);
      } else {
        dmgRejected = true;
        fail(
          `DMG container is not distributable: ${/accepted/.test(assessed.out) ? 'stapled ticket missing' : 'Gatekeeper rejects it (' + (assessed.out.split('\n')[1] || 'no usable signature').trim() + ')'}. ` +
            `The app inside may still be notarized — the container is a separate artifact and needs its own signature. ` +
            `Wire build/notarize-dmg.cjs in as afterAllArtifactBuild (policy scaffold installs it) and rebuild.`,
        );
      }
    }
  }

  // The update endpoint must actually be fetchable from inside the app.
  //
  // Music Discovery shipped DMGs whose banner could never fire: the app is
  // served from localhost, so reading version.json is a cross-origin request,
  // and without an Access-Control-Allow-Origin header the browser blocks it
  // before any app code runs. Nothing caught it because every check reads the
  // repo, and the header is served by a Cloudflare dashboard rule that no file
  // here describes. A correct banner and a working banner are different claims,
  // and only one of them can be verified by reading code.
  //
  // At release rather than in `check`: it is a network call, and the
  // session-start hook has a 10 second budget.
  const verUrl = sourceFilesMatching(dir, /version\.json/)
    .map((f) => (readFile(path.join(dir, f)).match(/https:\/\/[^\s'"`]+version\.json/) || [])[0])
    .find(Boolean);
  if (verUrl) {
    // argv, not a shell string. The URL is scraped from project source, and the
    // pattern that finds it excludes quotes and backticks but not `$`, `(` or
    // `)` — and `$(...)` still expands inside double quotes, so a crafted URL
    // in any scanned file would have executed. Verified before fixing.
    // `--` stops curl reading a hostile URL as an option.
    let headOut = '';
    try {
      const r = require('child_process').spawnSync(
        'curl',
        ['-sI', '--max-time', '10', '--', verUrl],
        { cwd: dir, encoding: 'utf8', shell: false },
      );
      headOut = `${r.stdout || ''}${r.stderr || ''}`;
    } catch {
      headOut = '';
    }
    const status = (headOut.match(/HTTP\/[\d.]+ (\d{3})/) || [])[1];
    const cors = /access-control-allow-origin/i.test(headOut);
    if (status !== '200') {
      fail(
        `Update endpoint ${verUrl} returned ${status || 'no response'} — the banner can never fire`,
      );
    } else if (!cors) {
      fail(
        `Update endpoint ${verUrl} sends no Access-Control-Allow-Origin header. The app reads it cross-origin ` +
          `from localhost, so the browser blocks the request before any app code runs and the banner silently never appears`,
      );
    } else {
      ok(`Update endpoint reachable and CORS-enabled (${verUrl})`);
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
  // Apps with help-centre pages capture their screenshots from the flow tests
  // (docs:capture). A release is when a documented screen can change, so the
  // capture and the help centre's drift check are part of signing it off.
  const checklist = [
    ...RELEASE_CHECKLISTS[profile],
    ...(proj.pkg && proj.pkg.scripts && proj.pkg.scripts['docs:capture']
      ? [
          "Ran npm run docs:capture, then rechecked the help pages the help centre's drift check flags (npm run drift in help-centre)",
        ]
      : []),
  ];
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
  if (flags.includes('--ack-manual') && dmgRejected) {
    // Same refusal as the untagged case, for the same reason: the ack is a
    // durable record, and one saying "signed off" over an artifact Gatekeeper
    // rejects is worse than none. The container check above already reported
    // this, but reporting is not enforcing — every later run would otherwise
    // read "previously acknowledged" with no memory of the failure.
    fail(
      `Gatekeeper rejects the ${proj.pkg.version} DMG (see above) — the ack was not recorded. ` +
        `Fix the container signing and rebuild, then re-run the sign-off.`,
    );
  } else if (flags.includes('--ack-manual') && !tagExists) {
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
 * and its decision record. The lockfile changing makes `gates` verify registry
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
        `    node ${path.join(POLICY_ROOT, 'scripts', 'policy.js')} gates   ${DIM}(registry signatures are verified because dependencies moved)${RESET}\n` +
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

  // The recorded verdict is checked after it is recomputed below, not before:
  // checking first printed the previous run's list, so the first health run
  // after deps-update still reported the updates it had just applied.
  const state = loadState(dir);
  // Record WHICH updates have been available too long, not just that health
  // ran. The network work belongs here — release dates need `npm view <pkg>
  // time`, one call per package, which cannot sit in a session-start check on a
  // 10 second budget. `check` then enforces the recorded verdict for free.
  //
  // Minor and patch only. Majors keep going through `policy upgrade` and its
  // decision record; being behind a major is a decision, being behind a patch
  // for months is neglect, and security fixes ride in patches.
  const graceDays = (loadRegistry().staleness || {}).depsStaleDays || 30;
  const stale = [];
  try {
    const list = JSON.parse(sh('npm outdated --json', dir).out || '{}');
    for (const [name, info] of Object.entries(list)) {
      const cur = String(info.current || '').split('.');
      const wanted = String(info.wanted || '').split('.');
      if (!cur[0] || cur[0] !== wanted[0]) continue; // major: not this rule
      if (info.current === info.wanted) continue;
      const times = sh(`npm view ${safeToken(name, 'package name')} time --json`, dir);
      let released = null;
      try {
        released = JSON.parse(times.out || '{}')[info.wanted];
      } catch {
        /* unreadable: skip rather than guess */
      }
      if (!released) continue;
      const age = Math.floor((Date.now() - new Date(released)) / 86400000);
      if (age > graceDays) stale.push(`${name} ${info.current} -> ${info.wanted} (${age}d old)`);
    }
  } catch {
    /* npm unavailable: leave the previous verdict rather than clearing it */
  }
  if (stale.length > 0) {
    fail(
      `${stale.length} minor/patch update(s) available for more than ${graceDays} days: ${stale.slice(0, 5).join('; ')}${stale.length > 5 ? ', …' : ''} — run: policy deps-update`,
    );
  } else ok(`No minor/patch update older than ${graceDays} days`);
  // An advisory exception lapses the moment a fixed version exists: carrying
  // it past that point is choosing not to update. Asked of GitHub's advisory
  // database through gh, one call per exception.
  for (const [id, e] of Object.entries(loadAuditExceptions(dir))) {
    const r = sh(
      `gh api /advisories/${safeToken(id, 'advisory id')} -q '[.vulnerabilities[] | select(.package.name == "${safeToken(e.package || '', 'package')}") | .first_patched_version] | map(select(. != null)) | .[0] // ""'`,
      dir,
    );
    if (!r.ok)
      warn(
        `Could not check ${id} on GitHub (gh unavailable?) — confirm by hand that it still has no fix`,
      );
    else if (r.out.trim())
      fail(
        `${id} now has a fixed release of ${e.package} (${r.out.trim()}) — update to it and remove the exception from audit-exceptions.json`,
      );
    else ok(`${id}: still no fixed release of ${e.package}; exception stands until ${e.expires}`);
  }

  // Existing packages that carry a risk signal get a Socket score too, not
  // only new ones (policy 2.58): read from the allowlist entry, no network.
  const allow = readJSON(path.join(dir, 'allowed-packages.json')) || {};
  const risky = Object.entries(allow).filter(([name, e]) => {
    if (name.startsWith('_') || !e || typeof e !== 'object') return false;
    const flagged =
      ['dormant', 'deprecated', 'superseded'].includes(e.maintenance) ||
      e.repoArchived === true ||
      // 0 means the count was never fetched (some July entries), not unpopular.
      (typeof e.weeklyDownloads === 'number' && e.weeklyDownloads > 0 && e.weeklyDownloads < 1000);
    const scoredAt = e.socket && e.socket.status === 'scored' && e.socket.checked;
    const fresh = scoredAt && (Date.now() - new Date(scoredAt)) / 86400000 < 180;
    return flagged && !fresh;
  });
  if (risky.length > 0)
    warn(
      `${risky.length} allowlisted package(s) with a risk signal (dormant, deprecated, archived or under 1,000 weekly downloads) ` +
        `and no Socket score in 180 days: ${risky
          .slice(0, 6)
          .map(([n]) => n)
          .join(', ')}${risky.length > 6 ? ', …' : ''} — ` +
        `score each: node ${path.join(POLICY_ROOT, 'scripts', 'verify-package.js')} <package>`,
    );

  state.staleDeps = stale;
  state.lastHealthRun = new Date().toISOString();
  saveState(dir, state);
  checkStaleness(dir, reg);
  console.log(`\n${DIM}Recorded health run in .policy/state.json${RESET}`);
  return finish();
}

// ---------------------------------------------------------------- scaffold

/**
 * The path from a project to build-policy. Templates and standard scripts say
 * "../build-policy", which is right for a project beside it; one kept deeper
 * (ADMIN_OTHER/dev-work/<app>) needs "../../CLAUDE/build-policy", and with the
 * template's path its pre-commit hook failed every commit. scaffold writes the
 * project's real path, and the drift checks read it back as the template's.
 */
function policyRel(dir) {
  return path.relative(path.resolve(dir), POLICY_ROOT) || '.';
}
function localizePolicyPath(text, dir) {
  const rel = policyRel(dir);
  return rel === '../build-policy' ? text : text.split('../build-policy/').join(`${rel}/`);
}
function canonicalPolicyPath(text, dir) {
  const rel = policyRel(dir);
  return rel === '../build-policy' ? text : text.split(`${rel}/`).join('../build-policy/');
}

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
  prepare: 'husky',
};

function cmdScaffold(dir) {
  guardLocalPath(dir);
  const proj = detectProject(dir);
  section(`Scaffold: ${path.resolve(dir)}`);
  const created = [];
  const skipped = [];

  // Install-script baseline: record what already runs code at install, so
  // the gate stops only on packages that arrive after tracking began.
  {
    const allowPath = path.join(dir, 'allowed-packages.json');
    const allow = readJSON(allowPath);
    if (allow && !allow._installScripts && exists(path.join(dir, 'node_modules'))) {
      const found = installScriptPackages(dir);
      if (found) {
        allow._installScripts = Object.fromEntries(
          found.map((n) => [
            n,
            `present when install-script tracking began (${new Date().toISOString().split('T')[0]})`,
          ]),
        );
        fs.writeFileSync(allowPath, JSON.stringify(allow, null, 2) + '\n');
        created.push(`allowed-packages.json _installScripts (${found.length})`);
      }
    }
  }

  // origin/HEAD: a local ref, so setting it touches nothing on GitHub.
  if (proj.isGit) {
    const branch = missingOriginHead(dir);
    if (branch) {
      const r = sh(`git remote set-head origin ${safeToken(branch, 'branch')}`, dir);
      if (r.ok) created.push(`origin/HEAD -> origin/${branch}`);
    }
  }

  /**
   * Copy a reference implementation only when the project does not already
   * have the capability, wherever it lives.
   *
   * copy() below tests the destination path, which is right for config files:
   * one canonical location, present or absent. It is wrong for the two
   * templates that are working code, because an existing app may implement the
   * same thing in a file of its own. One app here encrypts with
   * AES-256-CBC inline in its ai module, so the path server/secret-storage.js
   * was free and scaffold wrote a second, unimported copy of the scheme — dead
   * duplicate code, and duplicated crypto is the worst kind to leave lying
   * around, since the two copies can later disagree about the format on disk.
   *
   * No check requires these files. They exist so a NEW app does not get
   * assembled by copying whichever project is nearest, which is a reason to
   * write them once and never a reason to add a second copy to a project that
   * already works.
   */
  const copyUnlessImplemented = (tpl, dest, pattern, what) => {
    if (exists(path.join(dir, dest))) {
      skipped.push(dest);
      return;
    }
    const found = sourceFilesMatching(dir, pattern).filter((f) => f !== dest);
    if (found.length > 0) {
      skipped.push(`${dest} (${what} already implemented in ${found[0]})`);
      return;
    }
    copy(tpl, dest);
  };

  const copy = (tpl, dest) => {
    const destPath = path.join(dir, dest);
    if (exists(destPath)) {
      skipped.push(dest);
      return;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, localizePolicyPath(readFile(path.join(TEMPLATES, tpl)), dir));
    try {
      fs.chmodSync(destPath, fs.statSync(path.join(TEMPLATES, tpl)).mode);
    } catch {
      /* mode is cosmetic for non-executables */
    }
    created.push(dest);
  };

  // .nvmrc is generated from the registry rather than copied from a template,
  // so the file and the version of record cannot disagree: there is one place
  // to bump, and every project's file is derived from it.
  const nodePin = (loadRegistry().entries || {})['node-lts'];
  if (nodePin && nodePin.value && !exists(path.join(dir, '.nvmrc'))) {
    fs.writeFileSync(path.join(dir, '.nvmrc'), `${nodePin.value}\n`);
    created.push('.nvmrc');
  } else if (nodePin && nodePin.value) skipped.push('.nvmrc');

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
    copyUnlessImplemented(
      'electron-main.js',
      'electron/main.js',
      /new BrowserWindow\s*\(/,
      'the Electron main process',
    );
    copyUnlessImplemented(
      'secret-storage.js',
      'server/secret-storage.js',
      /createCipheriv\s*\(\s*['"]aes-256-cbc['"]/,
      'AES-256-CBC secret storage',
    );
    // Copied into build/ rather than generated, because it is real signing code
    // that must stay identical across apps: a per-project copy that drifts is
    // how one app quietly stops stapling. build/ is committed (it holds source
    // assets, not output), so the hook ships with the repo.
    copy('notarize-dmg.cjs', 'build/notarize-dmg.cjs');
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
    const add = Object.fromEntries(
      Object.entries(STANDARD_SCRIPTS).map(([k, v]) => [k, localizePolicyPath(v, dir)]),
    );
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

/**
 * `sync-templates`: overwrite the drift-checked files from the templates.
 * `scaffold` never overwrites, so the fix for template drift was a `cp` per
 * file per project, and the pre-commit hook and AGENTS.md carry a localized
 * path that a plain copy gets wrong. One project per run: the change is
 * gated like any other (changelog, gates, the developer's commit).
 */
function cmdSyncTemplates(dir) {
  guardLocalPath(dir);
  if (path.resolve(dir) === POLICY_ROOT) {
    console.log(`${RED}sync-templates runs in a project, not in build-policy.${RESET}`);
    process.exit(1);
  }
  section(`Template sync: ${path.resolve(dir)}`);
  const files = [
    ['ci.yml', '.github/workflows/ci.yml'],
    ['dependabot.yml', '.github/dependabot.yml'],
    ['pre-commit', '.husky/pre-commit'],
    ['AGENTS.md', 'AGENTS.md'],
  ];
  const changed = [];
  for (const [tpl, dest] of files) {
    const next = localizePolicyPath(readFile(path.join(TEMPLATES, tpl)), dir);
    const destPath = path.join(dir, dest);
    if (readFile(destPath) === next) {
      console.log(`  ${DIM}current ${dest}${RESET}`);
      continue;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, next);
    try {
      fs.chmodSync(destPath, fs.statSync(path.join(TEMPLATES, tpl)).mode);
    } catch {
      /* mode is cosmetic for non-executables */
    }
    changed.push(dest);
    console.log(`  ${GREEN}written${RESET} ${dest}`);
  }
  const nodePin = (loadRegistry().entries || {})['node-lts'];
  if (nodePin && nodePin.value && readFile(path.join(dir, '.nvmrc')).trim() !== nodePin.value) {
    fs.writeFileSync(path.join(dir, '.nvmrc'), `${nodePin.value}\n`);
    changed.push('.nvmrc');
    console.log(`  ${GREEN}written${RESET} .nvmrc (${nodePin.value})`);
  }
  console.log(
    changed.length
      ? `\nSynced ${changed.length} file(s). Gated like any change: CHANGELOG entry, policy gates, developer commit.\n`
      : '\nAlready in sync.\n',
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
  for (const sub of ['scripts', 'templates', 'tests']) {
    const privDir = path.join(POLICY_ROOT, sub);
    const pubDir = path.join(PUBLIC_ROOT, sub);
    const list = (d) => (exists(d) ? fs.readdirSync(d).filter((f) => !f.startsWith('.')) : []);
    const names = [...new Set([...list(privDir), ...list(pubDir)])].sort();
    const stale = names.filter(
      (f) => readFile(path.join(privDir, f)) !== readFile(path.join(pubDir, f)),
    );
    if (stale.length > 0) {
      fail(
        `${sub}/ drift vs public mirror: ${stale.join(', ')} — sync from a build-policy session: policy mirror-sync`,
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

  // Incident detail. Names are blocklisted, so a sync that swaps a project's
  // name for "a finance app" passes the term scan while still publishing a working
  // attack (the endpoint, what repeating it destroyed) and an unreleased
  // product plan. Checked on text added since the public repo's last commit,
  // so rule text already published (generic examples such as /api/licenses)
  // is not re-litigated; API paths only in history rows, where they describe
  // a real app rather than illustrate a rule.
  // Text moved between the public docs (the history table into HISTORY.md)
  // is not new text: a line already published verbatim in any of them at
  // HEAD is not re-litigated.
  const publicDocs = ['BUILD-POLICY.md', 'project-standards.md', 'HISTORY.md'];
  const published = new Set(
    publicDocs.flatMap((d) => sh(`git show HEAD:${d}`, PUBLIC_ROOT).out.split('\n')),
  );
  const added = sh(`git diff HEAD --unified=0 -- ${publicDocs.join(' ')}`, PUBLIC_ROOT)
    .out.split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .filter((l) => !published.has(l));
  const incident = [
    [/\b(found|raised|discovered|reported)\s+(in|while|by)\b/i, 'where it was found'],
    [
      /\bwhile preparing\b|\bfor sale\b|\bplanned\s+(DMG|release|launch|build)\b/i,
      'a product plan',
    ],
    [
      /\b(a|one|another)\s+(finance|budget|journal|photo|music|crypto|stock|mail|email|notes?|task|tracker)\w*\s+app\b/i,
      'an app identified by what it does',
    ],
    [/\b(unrestorable|lost (their|all|user) data|pruned real)\b/i, 'a data-loss incident'],
  ];
  for (const line of added) {
    for (const [re, what] of incident) {
      const m = line.match(re);
      if (m)
        fail(
          `Incident detail in the public mirror ("${m[0]}": ${what}) — public text states the rule and how it is enforced; ` +
            `the story of what went wrong stays in the private copy`,
        );
    }
    const api =
      /^\|\s*\d+\.\d+\s*\|/.test(line) &&
      line.match(/(GET|POST|PUT|PATCH|DELETE)?\s*`?\/api\/[\w/-]+/);
    if (api)
      fail(
        `API path in a public history row ("${api[0].trim()}") — a real app's endpoint is attack detail; describe the rule instead`,
      );
  }
  for (const doc of publicDocs) {
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

  // Commit messages are published too. Each change is committed in two repos
  // with two messages, and twice the private one (with per-app counts) landed
  // in the public repo. Checked for commits not yet pushed, so the pre-push
  // guard stops them while `git commit --amend` can still reword them.
  const upstream = sh('git rev-parse --abbrev-ref @{u}', PUBLIC_ROOT).ok;
  const log = sh(
    `git log --format=%h%x00%B%x1e ${upstream ? '@{u}..HEAD' : '-1 HEAD'}`,
    PUBLIC_ROOT,
  );
  const messageRules = [
    ...terms.map(({ term }) => [
      new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `names "${term}"`,
    ]),
    [/\b\d+\s+(of\s+\d+\s+)?(projects?|apps?)\b|\b\d+\s+of\s+\d+\b/i, 'a portfolio count'],
    [/\bAction:/, 'a remediation action'],
    [
      /\b(found|raised|discovered|reported)\s+(in|while|by)\b|\bwhile preparing\b|\bfor sale\b/i,
      'incident or plan detail',
    ],
  ];
  let badMessages = 0;
  for (const entry of (log.ok ? log.out : '').split('\x1e').filter((e) => e.trim())) {
    const [sha, body] = entry.trim().split('\0');
    for (const [re, what] of messageRules) {
      const m = (body || '').match(re);
      if (m) {
        fail(
          `Public commit ${sha} message contains ${what} ("${m[0]}") — this is the private repo's message. ` +
            `Reword before pushing: git -C ../build-policy-public commit --amend (latest commit) or an interactive rebase in a terminal`,
        );
        badMessages++;
      }
    }
  }
  if (badMessages === 0)
    ok(
      `Public commit messages ${upstream ? 'not yet pushed' : '(latest)'} carry no private detail`,
    );
  return finish();
}

/**
 * `policy handoff`: the owning session declares its build-policy change
 * complete. Refused unless `check` passes on build-policy. After it, only
 * sessions opened in build-policy may edit, for review, the public mirror and
 * the commit; the developer's commit releases the claim.
 */
function cmdHandoff() {
  section('Build-policy handoff');
  const owner = readJSON(POLICY_OWNER);
  if (!policyTreeDirty()) {
    ok('build-policy has no uncommitted changes — nothing to hand off');
    return finish();
  }
  if (!owner || owner.status !== 'editing') {
    fail(
      owner
        ? `Already handed off at ${owner.handedOffAt} — review, sync the mirror and commit from a build-policy session`
        : 'No session holds the build-policy claim — nothing to hand off',
    );
    return finish();
  }
  const failures = complianceFailures(POLICY_ROOT);
  if (failures.length > 0) {
    for (const f of failures) fail(f);
    console.log(
      `\nFinish the change first: 'policy check' must pass on build-policy before handoff.`,
    );
    return finish();
  }
  fs.writeFileSync(
    POLICY_OWNER,
    JSON.stringify(
      { ...owner, status: 'handed-off', handedOffAt: new Date().toISOString() },
      null,
      2,
    ) + '\n',
  );
  ok(`Handed off. The change is waiting for review in a build-policy session.`);
  console.log(
    `\nNext, in a Claude session opened in build-policy: review the diff, run 'policy mirror-sync', write the public ` +
      `history rows (rule and enforcement only), pass 'policy mirror', then commit both repos.`,
  );
  return finish();
}

/**
 * `policy mirror-sync`: the mechanical half of a public-mirror sync. Copies
 * scripts/ and templates/ verbatim and moves the public doc headers to the
 * private version. It writes no prose: the public history rows and standards
 * text are written by hand in the build-policy session, and `policy mirror`
 * then checks them.
 */
function cmdMirrorSync() {
  section('Public mirror sync (mechanical part)');
  if (!exists(PUBLIC_ROOT)) {
    fail(`Public mirror not found at ${PUBLIC_ROOT}`);
    return finish();
  }
  for (const sub of ['scripts', 'templates', 'tests']) {
    const src = path.join(POLICY_ROOT, sub);
    const dest = path.join(PUBLIC_ROOT, sub);
    fs.mkdirSync(dest, { recursive: true });
    const names = fs
      .readdirSync(src)
      .filter((f) => !f.startsWith('.') && fs.statSync(path.join(src, f)).isFile());
    const copied = names.filter(
      (f) => readFile(path.join(src, f)) !== readFile(path.join(dest, f)),
    );
    for (const f of copied) fs.copyFileSync(path.join(src, f), path.join(dest, f));
    ok(`${sub}/: ${copied.length ? `copied ${copied.join(', ')}` : 'already in sync'}`);
  }
  const verOf = (s) => (s.match(/\*\*Version:\*\*\s*([\d.]+)/) || [])[1];
  const privVer = verOf(readFile(path.join(POLICY_ROOT, 'BUILD-POLICY.md')));
  const today = new Date().toISOString().slice(0, 10);
  for (const doc of ['BUILD-POLICY.md', 'project-standards.md']) {
    const file = path.join(PUBLIC_ROOT, doc);
    const text = readFile(file);
    const next = text
      .replace(/\*\*Version:\*\*\s*[\d.]+/, `**Version:** ${privVer}`)
      .replace(/\*\*Last updated:\*\*\s*[\d-]+/, `**Last updated:** ${today}`);
    if (next !== text) fs.writeFileSync(file, next);
  }
  ok(`Public doc headers at ${privVer}`);
  const pubRows = new Set(historyRows(readFile(path.join(PUBLIC_ROOT, historyFile(PUBLIC_ROOT)))));
  const missing = historyRows(readFile(path.join(POLICY_ROOT, historyFile(POLICY_ROOT)))).filter(
    (v) => !pubRows.has(v),
  );
  if (missing.length)
    warn(
      `Write public history rows for ${missing.join(', ')} by hand: the rule and how it is enforced, no incident, ` +
        `product, endpoint or plan. Port new project-standards text the same way. Then run: policy mirror`,
    );
  else ok('Public history has a row for every private version');
  return finish();
}

/**
 * Homebrew install safety, the counterpart of Socket + min-release-age for npm.
 *
 * Settings live in brew.env, which Homebrew reads on every run, including the
 * non-interactive shells a Claude session uses. A line in .zshrc would reach
 * interactive shells only, the same gap the `socket npm` alias has. Verified
 * on Homebrew 7.0.6: with HOMEBREW_VERIFY_ATTESTATIONS set, a fresh bottle
 * download runs `gh attestation verify` and prints nothing when it passes.
 * The variable is presence-based, so "=false" also turns it on; only
 * HOMEBREW_NO_VERIFY_ATTESTATIONS turns it off. Attestations cover bottles
 * from homebrew/core and supported taps, not source builds, casks or bottles
 * already in the download cache, so casks get --require-sha.
 */
const BREW_REQUIRED = [
  ['HOMEBREW_VERIFY_ATTESTATIONS', '1', "verifies each bottle's build provenance with gh"],
  ['HOMEBREW_NO_INSECURE_REDIRECT', '1', 'refuses HTTPS-to-HTTP download redirects'],
  ['HOMEBREW_CASK_OPTS', '--require-sha', 'refuses casks without a checksum'],
];

function brewEnvFiles() {
  const prefix =
    process.env.HOMEBREW_PREFIX || (exists('/opt/homebrew') ? '/opt/homebrew' : '/usr/local');
  const user = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'homebrew', 'brew.env')
    : path.join(os.homedir(), '.homebrew', 'brew.env');
  return {
    system: '/etc/homebrew/brew.env',
    prefix: path.join(prefix, 'etc', 'homebrew', 'brew.env'),
    user,
  };
}

/** Effective Homebrew settings from brew.env files (user over prefix over system) and the environment. */
function brewSettings(extraEnv = {}) {
  const f = brewEnvFiles();
  const out = {};
  for (const file of [f.system, f.prefix, f.user]) {
    for (const line of readFile(file).split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?(HOMEBREW_[A-Z_]+)\s*=\s*["']?(.*?)["']?\s*$/);
      if (m) out[m[1]] = m[2];
    }
  }
  for (const [k, v] of Object.entries({ ...process.env, ...extraEnv }))
    if (k.startsWith('HOMEBREW_') && v !== undefined) out[k] = v;
  return out;
}

function brewAttestationsOn(settings) {
  return (
    Boolean(settings.HOMEBREW_VERIFY_ATTESTATIONS) && !settings.HOMEBREW_NO_VERIFY_ATTESTATIONS
  );
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

  // Local Node must equal the version CI pins. `npm ci` demands byte-level
  // agreement with the lockfile, so a local npm older than CI's writes a
  // lockfile CI then rejects — and the developer sees it as a CI-only failure
  // in a project they may not have touched. Checked here rather than in
  // `check`, since it is a property of the machine, not of any one project.
  const wantNode = (loadRegistry().entries || {})['node-lts'];
  if (wantNode && wantNode.value) {
    const haveNode = sh('node -v').out.trim().replace(/^v/, '');
    // A mismatch has two very different causes and one wrong remedy. If nvm's
    // default already IS the pinned version, the machine is correct and this
    // shell simply predates the switch: nvm activates the default only for
    // shells started after it, and a process launched earlier passes its old
    // PATH to every child. Reporting that as "upgrade Node" sends people to
    // re-run an install that changes nothing, and leaves them believing the
    // machine is wrong. Observed 2026-09-01, twice, in two sessions.
    const nvmDefault = readFile(path.join(os.homedir(), '.nvm/alias/default')).trim();
    if (haveNode === wantNode.value) ok(`Node ${haveNode} matches the version CI pins`);
    else if (nvmDefault === wantNode.value)
      fail(
        `This shell is on Node ${haveNode}, but the machine default is already ${nvmDefault} — nothing to install. ` +
          `The session was started before the switch and inherited the old PATH; nvm applies the default only to shells started after it. ` +
          `Open a NEW terminal (a new session in the same terminal inherits the same PATH), or run: nvm use default`,
      );
    else
      fail(
        `Node ${haveNode} locally but CI pins ${wantNode.value} — the npm that writes the lockfile ` +
          `must be the one that reads it, or 'npm ci' fails in CI only. Upgrade: nvm install ${wantNode.value} --reinstall-packages-from=${haveNode} && nvm alias default ${wantNode.value}`,
      );
  }

  const npmrc = readFile(path.join(os.homedir(), '.npmrc'));
  const releaseAge = Number((npmrc.match(/^min-release-age\s*=\s*(\d+)/m) || [])[1] || 0);
  if (releaseAge >= 2)
    ok(
      `~/.npmrc min-release-age=${releaseAge} (packages under ${releaseAge} days old are refused)`,
    );
  else
    fail(
      `~/.npmrc min-release-age is ${releaseAge || 'unset'} — policy 2.58 needs 2 or more. Run: policy setup-machine`,
    );

  // The Socket npm wrapper is retired (policy 2.58): an `npm` alias to it
  // would keep routing installs through its quota and its older resolver.
  const shellRc = ['.zshrc', '.bashrc', '.zprofile', '.bash_profile']
    .map((f) => readFile(path.join(os.homedir(), f)))
    .join('\n');
  if (/^\s*alias\s+npm=["']?socket\b/m.test(shellRc) || /socket wrapper/.test(shellRc))
    fail(
      'The Socket npm wrapper is still on in your shell profile — run: socket wrapper off (then open a new terminal)',
    );
  else ok('Socket npm wrapper is off (installs use npm directly)');

  if (sh('command -v brew', process.cwd()).ok) {
    const bs = brewSettings();
    const missing = BREW_REQUIRED.filter(([k, v]) =>
      k === 'HOMEBREW_CASK_OPTS' ? !String(bs[k] || '').includes(v) : !bs[k],
    ).map(([k]) => k);
    if (bs.HOMEBREW_NO_VERIFY_ATTESTATIONS)
      fail(
        'HOMEBREW_NO_VERIFY_ATTESTATIONS is set, which turns off bottle attestation checks — remove it',
      );
    else if (missing.length)
      fail(
        `Homebrew install safety missing from ${brewEnvFiles().user}: ${missing.join(', ')} — run: policy setup-machine`,
      );
    else
      ok(
        'Homebrew verifies bottle attestations, refuses insecure redirects and requires cask checksums (brew.env)',
      );
    if (!sh('gh auth status', process.cwd()).ok)
      fail(
        'gh is not signed in — Homebrew uses it to verify bottle attestations, so brew installs will fail: gh auth login',
      );
  }

  const settings = readJSON(path.join(os.homedir(), '.claude', 'settings.json')) || {};
  const settingsStr = JSON.stringify(settings);
  const canonicalHooks = readJSON(path.join(POLICY_ROOT, 'machine', 'hooks.json')) || {};
  const unwired = Object.entries(canonicalHooks)
    .filter(([event]) => !event.startsWith('_'))
    .flatMap(([event, entries]) =>
      entries
        .filter((entry) => !hookEntryWired(settings, event, entry))
        .map((entry) => `${event}${entry.matcher ? ` (${entry.matcher})` : ''}`),
    );
  if (!settingsStr.includes('policy.js') && !settingsStr.includes('session-start'))
    warn('Claude Code hooks not wired — run: policy setup-machine');
  else if (unwired.length > 0)
    fail(
      `Claude Code hooks missing from ~/.claude/settings.json: ${unwired.join(', ')} — run: policy setup-machine`,
    );
  else
    ok(
      'Claude Code hooks configured in ~/.claude/settings.json (every canonical event and matcher)',
    );

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
      // A Claude Code session shell intermittently cannot reach the profile
      // even though it is valid (a fresh session or the developer's Terminal
      // can). Re-creating credentials on this warning alone is the wrong fix,
      // so the message routes to the Terminal check first.
      warn(
        `Notarization keychain profile "${profile}" not verifiable from this shell (missing, offline, or ` +
          `unreachable from a Claude session). Confirm in Terminal.app first: ` +
          `xcrun notarytool history --keychain-profile ${profile} — if that lists history, the profile is fine; ` +
          `do not re-create it. Only if Terminal also says "No Keychain password item": ` +
          `xcrun notarytool store-credentials ${profile} --apple-id <id> --team-id <team> --password <app-specific>`,
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
/** Is this canonical hook entry (same event, same matcher) already wired to the policy? */
function hookEntryWired(settings, event, entry) {
  return ((settings.hooks && settings.hooks[event]) || []).some(
    (e) =>
      (e.matcher || '') === (entry.matcher || '') &&
      /policy\.js|session-start/.test(JSON.stringify(e.hooks || [])),
  );
}

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

  // 3. build-policy pre-commit guard. This repo has no package.json/Husky gate,
  // so the native hook runs the policy repo checks that matter before commit.
  const policyHooks = path.join(POLICY_ROOT, '.git', 'hooks');
  if (exists(policyHooks)) {
    const dest = path.join(policyHooks, 'pre-commit');
    fs.copyFileSync(path.join(MACHINE, 'build-policy-pre-commit.sh'), dest);
    fs.chmodSync(dest, 0o755);
    ok(`Installed build-policy pre-commit guard at ${dest}`);
  } else {
    warn(`Policy repo git hooks not found at ${policyHooks} — pre-commit guard not installed`);
  }

  // 4. Public-mirror pre-push guard. Lives in .git/hooks (not versioned), so
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

  // 4b. Homebrew install safety — merge the required keys into the user
  // brew.env, keeping anything already there.
  if (sh('command -v brew', process.cwd()).ok) {
    const file = brewEnvFiles().user;
    const current = readFile(file);
    const add = BREW_REQUIRED.filter(
      ([k]) => !new RegExp(`^\\s*(export\\s+)?${k}\\s*=`, 'm').test(current),
    ).map(([k, v, why]) => `# ${why}\n${k}=${v}`);
    if (add.length) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        (current && !current.endsWith('\n') ? current + '\n' : current) + add.join('\n') + '\n',
      );
      ok(`Homebrew install safety written to ${file}`);
    } else ok(`Homebrew install safety already in ${file}`);
  }

  // 4c. npm release-age quarantine: at least 2 days (policy 2.58).
  {
    const file = path.join(os.homedir(), '.npmrc');
    const cur = readFile(file);
    const m = cur.match(/^min-release-age\s*=\s*(\d+)\s*$/m);
    if (!m || Number(m[1]) < 2) {
      const next = m
        ? cur.replace(m[0], 'min-release-age=2')
        : `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}min-release-age=2\n`;
      fs.writeFileSync(file, next);
      ok(`~/.npmrc min-release-age set to 2`);
    } else ok(`~/.npmrc min-release-age already ${m[1]}`);
  }

  // 5. Hooks — merge into settings.json, never clobber existing config
  const settingsPath = path.join(claudeDir, 'settings.json');
  const settings = readJSON(settingsPath) || {};
  const canonical = readJSON(path.join(MACHINE, 'hooks.json')) || {};
  settings.hooks = settings.hooks || {};
  let merged = 0;
  // Per matcher, not per event: an event already wired for Bash must still
  // gain a new matcher (Edit|Write for the build-policy claim) added later.
  for (const [event, entries] of Object.entries(canonical)) {
    if (event.startsWith('_')) continue;
    for (const entry of entries) {
      if (hookEntryWired(settings, event, entry)) {
        ok(`Hook ${event}${entry.matcher ? ` (${entry.matcher})` : ''}: already wired, left as-is`);
        continue;
      }
      settings.hooks[event] = [...(settings.hooks[event] || []), entry];
      merged++;
    }
  }
  if (merged > 0) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    ok(`Merged ${merged} hook event(s) into ${settingsPath}`);
  }

  console.log(
    `\nRemaining manual steps (doctor checks all of these):\n` +
      `  brew install semgrep betterleaks\n` +
      `  npm install -g pm2 @socketsecurity/cli && socket login   (Socket scores new packages; keep its npm wrapper off)\n` +
      `  xcrun notarytool store-credentials <profile> --apple-id <id> --team-id <team> --password <app-specific>\n` +
      `\nNow run: node ${path.join(POLICY_ROOT, 'scripts', 'policy.js')} doctor\n`,
  );
  return finish();
}

// ------------------------------------------------------------- hook modes

// A DMG build invocation, shared by the pre- and post-build hooks. Matched as a
// command word, not anywhere in the string. The bare-substring form denied
// `grep electron-builder package.json` and any heredoc mentioning the DMG flow,
// which is a different trade from the --ack-manual guard: there, the false
// positives cost a doc edit and the pattern protects a signature that must
// never be forged. Here the guard protects an ordering (gates -> commit ->
// build), a real invocation always appears as a command word, and blocking
// inspection of a build config makes diagnosing a broken build harder than the
// guard is worth.
const BUILD_INVOCATION =
  /(?:^|[;&|(]|&&|\|\||\bnpm\s+run\s+|\bnpx\s+|\byarn\s+|\bpnpm\s+(?:run\s+)?)\s*(?:electron:build\b|electron-builder\b)/;

function readStdinJSON() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

/** PostToolUse / PostToolUseFailure hook: after a DMG build whose notarization
 *  could not reach the keychain profile, hand the build to the developer.
 *
 *  A Claude Code session shell intermittently cannot read the notarytool
 *  profile even though it is valid: one app's 2026-09-18 build failed with "No
 *  Keychain password item found", then the identical command in a fresh session
 *  notarized twenty minutes later, and 2026-09-24's failed build notarized
 *  first time from the developer's Terminal. Every session that met the error
 *  diagnosed it anew and proposed re-creating credentials or unlocking the
 *  keychain. The fix that works is to run the build outside the session, so
 *  the hook says exactly that. Exit 2 + stderr reaches Claude on both events
 *  (a failing build fires PostToolUseFailure; a piped `| tail` build exits 0
 *  and fires PostToolUse). */
function cmdHookPosttool() {
  const input = readStdinJSON();
  const cmd = (input.tool_input && input.tool_input.command) || '';
  if (input.tool_name !== 'Bash' || !BUILD_INVOCATION.test(cmd)) process.exit(0);
  const output = JSON.stringify(input.tool_response || '') + JSON.stringify(input.error || '');
  if (!/No Keychain password item found/.test(output)) process.exit(0);
  const dir = input.cwd || process.cwd();
  process.stderr.write(
    'BUILD-POLICY: notarization could not reach the keychain profile from this Claude session. ' +
      'This is session-scoped, not a credentials problem: the same build notarizes from the ' +
      "developer's Terminal (or a fresh session). Do NOT re-create the profile, unlock the keychain, " +
      'edit .env, retry here, or look for another cause. Hand the build to the developer:\n' +
      `  In Terminal.app: cd "${dir}" && npm run electron:build\n` +
      'Ask them to report back when it prints "signed, notarized, stapled", then resume the release ' +
      'flow at the codesign verification step (codesign --verify --deep --strict on the .app).\n',
  );
  process.exit(2);
}

/** Stop hook: block turn-end when source changed without a CHANGELOG update
 *  or without a full-gates pass on the current tree. One combined block per
 *  turn (stop_hook_active guard), so all reasons are reported together. */
/**
 * Did this turn state content that is not in the project's data files?
 *
 * The failure this exists for: a session presented a table of in-app tips for
 * the developer to review, reconstructed from memory after a context
 * summarisation rather than read from the file. Thirteen of the fourteen
 * entries did not exist. Had they been approved, content that is not in the
 * product would have been signed off, and nothing in the transcript would have
 * looked unusual.
 *
 * An earlier version of this checked process — "was the file read since it was
 * last written" — and would have missed the real incident. The file HAD been
 * read, correctly, and quoted accurately at the time; a summarisation two
 * hundred messages later destroyed the knowledge while leaving the read in the
 * transcript. Process is the wrong thing to check, because the transcript keeps
 * evidence of a read that the model no longer benefits from.
 *
 * So this verifies the claim instead. Identifiers in the closing message are
 * compared against the identifiers that actually exist in the project's data
 * files. Anchored by requiring at least one real match, so the message is
 * demonstrably about that dataset rather than coincidentally containing
 * kebab-case, and it only fires on two or more absentees, since fabrication
 * comes in lists and a single miss is more likely a rename.
 *
 * Measured against the real transcript: the accurate table scored 14 real / 0
 * absent, the fabricated one 1 real / 13 absent.
 */
function fabricatedContentIds(transcriptPath, dir) {
  let finalText = '';
  try {
    for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type !== 'assistant') continue;
      const c = (o.message || {}).content;
      if (!Array.isArray(c)) continue;
      for (const b of c) if (b.type === 'text' && b.text) finalText = b.text;
    }
  } catch {
    return null;
  }
  if (!finalText) return null;

  // Vocabulary: every `id` in every JSON data file the project ships.
  const vocab = new Set();
  const collect = (node) => {
    if (Array.isArray(node)) node.forEach(collect);
    else if (node && typeof node === 'object') {
      if (typeof node.id === 'string') vocab.add(node.id);
      Object.values(node).forEach(collect);
    }
  };
  const walkData = (d, depth) => {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (['node_modules', 'dist', 'release', 'coverage', '.git', 'local_data'].includes(e.name))
        continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walkData(full, depth + 1);
      else if (e.name.endsWith('.json') && !/package(-lock)?\.json$/.test(e.name)) {
        const j = readJSON(full);
        if (j) collect(j);
      }
    }
  };
  walkData(dir, 0);
  if (vocab.size === 0) return null;

  const cited = new Set();
  for (const m of finalText.matchAll(/`([a-z]+(?:-[a-z]+)+)`|\|\s*([a-z]+(?:-[a-z]+)+)\s*\|/g))
    cited.add(m[1] || m[2]);

  const present = [...cited].filter((t) => vocab.has(t));
  const absent = [...cited].filter((t) => !vocab.has(t));
  if (present.length >= 1 && absent.length >= 2) return { present, absent };
  return null;
}

function cmdHookStop() {
  const input = readStdinJSON();
  if (input.stop_hook_active) process.exit(0); // never loop

  // Whichever project this session was opened in: if it holds build-policy,
  // the policy change must be complete before the turn ends. A later session
  // has none of this one's context, so work left half-done here stays so.
  const owner = readJSON(POLICY_OWNER);
  if (
    owner &&
    owner.session === input.session_id &&
    owner.status !== 'handed-off' &&
    policyTreeDirty()
  ) {
    const failures = complianceFailures(POLICY_ROOT);
    const policyCli = path.join(POLICY_ROOT, 'scripts', 'policy.js');
    if (failures.length > 0) {
      console.log(
        JSON.stringify({
          decision: 'block',
          reason:
            `BUILD-POLICY: this session changed build-policy and the change is incomplete:\n` +
            failures.map((f, i) => `${i + 1}. ${f}`).join('\n') +
            `\nFinish it now. Once this session ends, no later session has the context to finish it.`,
        }),
      );
      process.exit(0);
    }
    // An app session's part ends at a complete private change. Review, the
    // public mirror and the commit belong to a build-policy session.
    if (!isUnderPolicyRoot(input.cwd || process.cwd())) {
      console.log(
        JSON.stringify({
          decision: 'block',
          reason:
            `BUILD-POLICY: this session's build-policy change passes check. Hand it off now: node ${policyCli} handoff — ` +
            `then tell the developer it is ready for review in a build-policy session, which syncs the public mirror and ` +
            `prepares the commit. Do not edit build-policy-public from this session. If you are mid-change and not finished, ` +
            `say so and continue.`,
        }),
      );
      process.exit(0);
    }
  }

  const dir = process.cwd();
  const proj = detectProject(dir);
  if (!proj.hasPkg || !proj.isGit) process.exit(0);

  // Checked before the source-changed gate below, because describing a file's
  // contents changes nothing on disk. The turn that fabricated a tip list
  // touched no source at all, so anything behind that gate could not have seen
  // it.
  if (input.transcript_path) {
    const bogus = fabricatedContentIds(input.transcript_path, dir);
    if (bogus) {
      console.log(
        JSON.stringify({
          decision: 'block',
          reason:
            `BUILD-POLICY: this turn cites ${bogus.absent.length} identifiers that do not exist in the project's data files: ` +
            `${bogus.absent.slice(0, 8).join(', ')}${bogus.absent.length > 8 ? ', …' : ''}. ` +
            `It also cites ${bogus.present.length} that do, so the message is about that data and part of it is invented. ` +
            `Re-read the data file and correct the list before ending the turn. If the developer was asked to review or approve this content, ` +
            `say plainly that the earlier list was wrong — approving content that is not in the product is the failure this check exists to prevent.`,
        }),
      );
      process.exit(0);
    }
  }

  const changed = changedFiles(dir);
  const sourceChanged = changed.filter(isGatedFile);
  if (sourceChanged.length === 0) process.exit(0);

  const reasons = [];
  if (!changed.includes('CHANGELOG.md') && exists(path.join(dir, 'CHANGELOG.md'))) {
    reasons.push(
      `CHANGELOG.md was not updated — every code change gets a changelog entry before the turn ends. ` +
        `Update it now (or state why no entry is needed).`,
    );
  }
  if (proj.pkg && proj.pkg.version && shippedDmgVersions(dir, proj).has(proj.pkg.version)) {
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
  // Duplicated from verify-ready on purpose, the same way the gates marker is
  // checked in both the Stop hook and pre-commit: verify-ready is the one
  // policy command no hook or CI workflow invokes, so on its own the security
  // requirement rests on an agent choosing to run it — which is the enforcement
  // gap this policy exists to close. Turn end is the moment unreviewed auth
  // code would otherwise reach the developer, so it is checked here too.
  const sensitive = securitySensitiveFiles(dir, changed).sort();
  if (sensitive.length > 0) {
    const rec = loadState(dir).securityReview;
    if (!rec || rec.hash !== contentHash(dir, sensitive)) {
      reasons.push(
        `Security-sensitive files changed without a recorded review: ${sensitive.join(', ')}. ` +
          `These touch auth, secrets, crypto, CORS, payment or data deletion, where a missed bug is not a bug report — it is an incident. ` +
          (proj.isGit && missingOriginHead(dir) !== null
            ? `First make /security-review runnable (this repo has no origin/HEAD, which git creates only on clone): ` +
              `${missingOriginHead(dir) ? `git remote set-head origin ${missingOriginHead(dir)}` : 'git fetch origin, then policy scaffold'}. `
            : '') +
          `Run /security-review over these changes, fix what it finds, then record it: ` +
          `node ${path.join(POLICY_ROOT, 'scripts', 'policy.js')} security-ack` +
          (rec
            ? ` (a review is recorded, but for different content — it no longer applies).`
            : '.') +
          ` If a review genuinely does not apply here, say so explicitly rather than skipping it silently.`,
      );
    }
  }
  const marker = readJSON(path.join(dir, '.policy', 'gates.json'));
  if (!markerMatches(dir, marker)) {
    reasons.push(
      `Full quality gates have NOT passed on the current tree` +
        (marker
          ? ` (last pass: ${marker.timestamp}, tree has changed since)`
          : ' (no gates marker)') +
        `. Never present work for commit before this passes — a commit made without it strands the tree, and every build and release step after it is blocked. ` +
        `Run them now: node ${path.join(POLICY_ROOT, 'scripts', 'policy.js')} gates — the pre-commit hook will reject the commit without this. ` +
        `If you are mid-iteration and not presenting yet, state that explicitly and continue.`,
    );
  }
  if (reasons.length > 0) {
    console.log(
      JSON.stringify({
        decision: 'block',
        reason:
          `Source or dependency files changed (${sourceChanged.slice(0, 5).join(', ')}${sourceChanged.length > 5 ? ', ...' : ''}). BUILD-POLICY:\n` +
          reasons.map((r, i) => `${i + 1}. ${r}`).join('\n'),
      }),
    );
  }
  process.exit(0);
}

/** PreToolUse hook: block electron DMG builds while the working tree is dirty;
 *  redirect raw semgrep invocations to the policy-defined script. */
/**
 * One session at a time may hold uncommitted work in build-policy, and the
 * public mirror is maintained only from a session opened in build-policy.
 *
 * App sessions are told to fix gaps in the shared standard, so sessions opened
 * in app projects edit ../build-policy. Every completion check (Stop hook,
 * gates, verify-marker) looks at the session's own project, so those edits had
 * none, and nothing stopped two sessions editing the same files: 2.39, 2.40
 * and 2.41 were written by three sessions into one uncommitted tree, and
 * 2.41's session ended with the change half-done. Then an app session synced
 * the public mirror and published an exploitable endpoint and an unreleased
 * product plan under a neutral name the blocklist could not see.
 *
 * The lifecycle, in .policy/owner.json:
 *   editing     the first session to write to build-policy claims it; only
 *               that session may write until it hands off. Its Stop hook
 *               blocks while `check` fails and, for an app session, until it
 *               runs `policy handoff`.
 *   handed-off  the change is complete and waiting for review. Only sessions
 *               opened in build-policy may write: they review, sync the
 *               public mirror and prepare the commit.
 *   (released)  the developer commits; a clean tree frees the next claim.
 * App sessions are refused throughout and told to describe their gap instead.
 */
const POLICY_OWNER = path.join(POLICY_ROOT, '.policy', 'owner.json');
const POLICY_WRITE_OP =
  /(^|[\s;&|(])(sed\s+-i|perl\s+-[a-z]*i|tee|cp|mv|rm|touch|patch|truncate)\s|(?<![0-9&])>>?\s*["']?(?!\/dev\/|\/tmp\/|\/private\/tmp\/)[^\s&|"']|open\([^)]*,\s*["'][wa]|writeFileSync|appendFileSync|\bgit\b[^|;&]*\s(checkout|restore|reset|stash|apply|revert|clean)\b/;

function policyTreeDirty() {
  return changedFiles(POLICY_ROOT).some((f) => !f.startsWith('.policy/'));
}

function isUnderRoot(p, cwd, root) {
  if (!p) return false;
  const abs = path.resolve(cwd || process.cwd(), String(p).replace(/^~(?=\/)/, os.homedir()));
  return abs === root || abs.startsWith(root + path.sep);
}
function isUnderPolicyRoot(p, cwd) {
  return isUnderRoot(p, cwd, POLICY_ROOT);
}

// A command names a repo by its real path, a relative ../<name>, or a ~ path,
// not by the substring: other directories (a session scratchpad named after
// the project) contain "build-policy/" too, and build-policy-public contains
// "build-policy".
function commandNamesRoot(cmd, root, cwd = process.cwd()) {
  const esc = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const name = path.basename(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(esc + '(?![\\w-])').test(cmd)) return true;
  // Relative and ~ forms count only if they resolve to the repo from where the
  // command runs: from ADMIN_OTHER/dev-work/<app>, "../build-policy" is some
  // other folder, and the text alone refused a session that never touched it.
  const forms = [
    ...cmd.matchAll(
      new RegExp(`(?:^|[\\s'"=:(])((?:\\.\\.\\/)+(?:[\\w.-]+\\/)*${name})(?![\\w-])`, 'g'),
    ),
    ...cmd.matchAll(new RegExp(`(~\\/[^\\s'"]*\\/${name})(?![\\w-])`, 'g')),
  ].map((m) => m[1]);
  return forms.some((f) => isUnderRoot(f, cwd, root));
}

const INTERPRETER = /^(python3?|node|ruby|perl|bash|sh|zsh|deno|bun|npx|osascript)$/;

/**
 * Where does a shell command write? Returns the target paths it can name, and
 * `unknown` when a segment hands control to an interpreter or a heredoc, whose
 * writes cannot be read from the command line. Follows `cd` between segments,
 * so `cd elsewhere && echo x >> file` is judged by where it writes rather than
 * the directory the session started in.
 */
function bashWriteTargets(cmd, startCwd) {
  let cwd = startCwd;
  const targets = [];
  // Heredoc bodies are taken out of the command line first, so the body of
  // `cat > notes.md <<EOF` is data written to the redirect target, and the
  // body of `python3 - <<EOF` is code judged with the segment that runs it.
  // Before this, any heredoc made the whole command judged by shape, so an
  // app session editing its own files was refused whenever "build-policy"
  // appeared anywhere in the command (five times in one day).
  const bodies = [];
  cmd = cmd.replace(
    /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n([\s\S]*?)\n\s*\2\s*(?=\n|$)/g,
    (m, q, tag, rest, body) => {
      bodies.push(body);
      return `<<HEREDOC${bodies.length - 1}${rest}`;
    },
  );
  let unknown = false;
  const unknownSegments = [];
  const abs = (t) =>
    path.resolve(cwd, t.replace(/^['"]|['"]$/g, '').replace(/^~(?=\/)/, os.homedir()));
  for (const seg of cmd.split(/&&|\|\||;|\n|\|/)) {
    for (const m of seg.matchAll(/(?<![0-9&<])>>?\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g)) {
      if (!/^['"]?\/dev\//.test(m[1])) targets.push(abs(m[1]));
    }
    const words = (
      seg
        .replace(/(?<![0-9&<])>>?\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g, '')
        .match(/"[^"]*"|'[^']*'|\S+/g) || []
    ).map((w) => w.replace(/^['"]|['"]$/g, ''));
    while (words.length && /^\w+=/.test(words[0])) words.shift();
    if (words[0] === 'sudo' || words[0] === 'command' || words[0] === 'exec') words.shift();
    const cmd0 = words[0];
    if (!cmd0) continue;
    const args = words.slice(1).filter((w) => !w.startsWith('-'));
    if (cmd0 === 'cd') {
      if (args[0]) cwd = abs(args[0]);
    } else if (['cp', 'mv', 'install', 'rsync', 'ln'].includes(cmd0)) {
      if (args.length) targets.push(abs(args[args.length - 1]));
    } else if (
      ['rm', 'rmdir', 'touch', 'truncate', 'mkdir', 'tee', 'chmod', 'unlink'].includes(cmd0)
    ) {
      for (const a of args) targets.push(abs(a));
    } else if ((cmd0 === 'sed' || cmd0 === 'perl') && words.some((w) => /^-[a-z]*i/.test(w))) {
      for (const a of args.slice(1)) targets.push(abs(a));
    } else if (
      cmd0 === 'git' &&
      /\s(checkout|restore|reset|stash|apply|revert|clean|am|merge|pull|rebase)\b/.test(seg)
    ) {
      const c = seg.match(/\s-C\s+(\S+)/);
      targets.push(c ? abs(c[1]) : cwd);
    } else if (cmd0 === 'patch') {
      targets.push(cwd);
    } else if (INTERPRETER.test(path.basename(cmd0))) {
      // Our own CLI: mirror-sync writes the public mirror and nothing else;
      // every other policy.js command leaves the policy repo's files alone.
      if (/policy\.js["']?\s+mirror-sync\b/.test(seg)) targets.push(PUBLIC_ROOT);
      else if (!/policy\.js\b/.test(seg)) {
        unknown = true;
        const body = (seg.match(/<<HEREDOC(\d+)/) || [])[1];
        unknownSegments.push({
          text: body !== undefined ? `${seg}\n${bodies[Number(body)]}` : seg,
          cwd,
        });
      }
    }
  }
  return { targets, unknown, unknownSegments, cwd };
}

/** Does this tool call write inside `root`? */
function writesUnder(input, root) {
  const ti = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(input.tool_name))
    return isUnderRoot(ti.file_path || ti.notebook_path, cwd, root);
  if (input.tool_name !== 'Bash') return false;
  const cmd = ti.command || '';
  const w = bashWriteTargets(cmd, cwd);
  if (w.targets.some((t) => isUnderRoot(t, '/', root))) return true;
  // An interpreter may write anywhere: judge its segment (with any heredoc
  // script it reads) by shape, a write operation in it plus a quoted path
  // literal that resolves into the repo, or the segment running inside the
  // repo. Prose that mentions the repo inside a longer string is not a path.
  return w.unknownSegments.some(
    (u) =>
      POLICY_WRITE_OP.test(u.text) &&
      (literalPathsUnder(u.text, root, u.cwd) || isUnderRoot(u.cwd, '/', root)),
  );
}

/** Split code into its string literals and the code around them. Handles
 *  ', ", ` and Python's triple quotes, with backslash escapes. */
function splitStringLiterals(text) {
  const literals = [];
  let code = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const triple = text.slice(i, i + 3) === ch.repeat(3) ? ch.repeat(3) : null;
      const close = triple || ch;
      let j = i + close.length;
      let lit = '';
      while (j < text.length && text.slice(j, j + close.length) !== close) {
        if (text[j] === '\\') {
          lit += text.slice(j, j + 2);
          j += 2;
        } else lit += text[j++];
      }
      literals.push(lit);
      code += ' ';
      i = j + close.length;
    } else code += text[i++];
  }
  return { literals, code };
}

/** Does this code name a path inside root: a whole, space-free string literal
 *  that resolves there, or a path written in the code itself? A sentence that
 *  mentions the repo inside a longer string is prose, not a path. */
function literalPathsUnder(text, root, cwd, depth = 0) {
  const { literals, code } = splitStringLiterals(text);
  for (const lit of literals) {
    if (lit.length > 1 && !/\s/.test(lit) && /[/~.]/.test(lit) && isUnderRoot(lit, cwd, root))
      return true;
    // A string holding code (a shell-quoted `node -e "..."` script) has its
    // own literals: look inside it too.
    if (
      /\w\(/.test(lit) &&
      /['"`]/.test(lit) &&
      depth < 3 &&
      literalPathsUnder(lit, root, cwd, depth + 1)
    )
      return true;
  }
  return commandNamesRoot(code, root, cwd);
}

function refuse(reason) {
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
}

const APP_SESSION_REFUSAL =
  `Do not edit build-policy from this session. If the gap you found should be fixed there, describe it in your final ` +
  `message; the developer takes it to a build-policy session once the current change is committed.`;

/** May this session write to build-policy? Claims it when free. Returns a refusal or null. */
function claimPolicyRepo(input) {
  const owner = readJSON(POLICY_OWNER);
  const session = input.session_id || 'unknown';
  const inPolicySession = isUnderPolicyRoot(input.cwd || process.cwd());
  if (!owner || !policyTreeDirty()) {
    fs.mkdirSync(path.dirname(POLICY_OWNER), { recursive: true });
    fs.writeFileSync(
      POLICY_OWNER,
      JSON.stringify(
        {
          session,
          project: input.cwd || process.cwd(),
          since: new Date().toISOString(),
          status: 'editing',
        },
        null,
        2,
      ) + '\n',
    );
    return null;
  }
  if (owner.status === 'handed-off') {
    if (inPolicySession) return null;
    return (
      `BUILD-POLICY: build-policy holds a finished change waiting for review and commit (written by the session opened in ` +
      `${owner.project}, handed off ${owner.handedOffAt}). Only a session opened in build-policy may edit it now. ` +
      APP_SESSION_REFUSAL
    );
  }
  if (owner.session === session) return null;
  return (
    `BUILD-POLICY: build-policy holds uncommitted work claimed by another session (${owner.session}, opened in ` +
    `${owner.project}, since ${owner.since}). Editing it now would mix two sessions' changes in one tree, where either ` +
    `can overwrite or mis-cite the other. ` +
    (inPolicySession
      ? `Wait for that session to finish and run 'policy handoff'; the change can be reviewed and synced here after that.`
      : APP_SESSION_REFUSAL) +
    ` Reads are never refused: if this command does not write to build-policy, it was judged by shape because an ` +
    `interpreter or heredoc in it names build-policy beside a write. Split that part into its own command.`
  );
}

function cmdHookPretool() {
  const input = readStdinJSON();
  const cmd = (input.tool_input && input.tool_input.command) || '';
  // The claim file is the developer's to clear (by committing), never the AI's.
  const ti = input.tool_input || {};
  const claimFileWrite =
    input.tool_name === 'Bash'
      ? // The operation must act on the file; prose that mentions it is fine.
        /(\b(rm|mv|cp|tee|truncate|touch|unlink)\b|>>?|\b(open|writeFileSync|appendFileSync|unlinkSync|rmSync|renameSync)\s*\()[^|;&\n]*\.policy\/owner\.json/.test(
          cmd,
        ) &&
        (commandNamesRoot(cmd, POLICY_ROOT) || isUnderPolicyRoot(input.cwd || process.cwd()))
      : /owner\.json$/.test(ti.file_path || '') && isUnderPolicyRoot(ti.file_path, input.cwd);
  if (claimFileWrite)
    refuse(
      'BUILD-POLICY: .policy/owner.json records which session holds uncommitted build-policy work. The AI must not edit or remove it; ' +
        "the claim moves on through 'policy handoff' and is released when the developer commits build-policy.",
    );
  // Handing off is the owning session's act: another session cannot declare
  // someone else's change finished.
  if (input.tool_name === 'Bash' && /policy\.js["']?\s+handoff\b/.test(cmd)) {
    const owner = readJSON(POLICY_OWNER);
    if (owner && owner.status === 'editing' && owner.session !== input.session_id)
      refuse(
        `BUILD-POLICY: only the session that holds the build-policy claim can hand it off (${owner.session}, opened in ${owner.project}).`,
      );
  }
  // The public mirror is published. Only a build-policy session maintains it,
  // because an app session sanitises by swapping names and keeps the incident.
  if (writesUnder(input, PUBLIC_ROOT) && !isUnderPolicyRoot(input.cwd || process.cwd()))
    refuse(
      `BUILD-POLICY: the public mirror (build-policy-public) is maintained only from a session opened in build-policy, ` +
        `which reviews what is about to be published. Do not edit it from this session.`,
    );
  if (writesUnder(input, POLICY_ROOT)) {
    const refusal = claimPolicyRepo(input);
    if (refusal) refuse(refusal);
  }
  // The AI drafts advisory exceptions in audit-exceptions.json; approving one
  // is the developer's decision (policy 2.59), so the AI may neither run
  // approve-exception nor write audit-approvals.json. A release-age override
  // installs a version younger than the quarantine: also the developer's call.
  {
    const ti3 = input.tool_input || {};
    const writesApprovals =
      (['Edit', 'Write', 'MultiEdit'].includes(input.tool_name) &&
        /audit-approvals\.json$/.test(ti3.file_path || '')) ||
      (input.tool_name === 'Bash' &&
        (bashWriteTargets(cmd, input.cwd || process.cwd()).targets.some((t) =>
          /audit-approvals\.json$/.test(t),
        ) ||
          /(\b(tee|cp|mv|truncate)\b|>>?|\b(open|writeFileSync|appendFileSync|renameSync)\s*\()[^|;&\n]*audit-approvals\.json/.test(
            cmd,
          )));
    if (
      writesApprovals ||
      (input.tool_name === 'Bash' && /policy\.js["']?\s+approve-exception\b/.test(cmd))
    )
      refuse(
        "BUILD-POLICY: approving an advisory exception is the developer's decision. Write or update the entry in " +
          'audit-exceptions.json, show the developer the full entry and what you checked in this project, then give them ' +
          'the command to run themselves: ! node <build-policy>/scripts/policy.js approve-exception <GHSA-id>',
      );
    if (input.tool_name === 'Bash' && /--min-release-age(=|\s+)\d/.test(cmd))
      refuse(
        'BUILD-POLICY: overriding min-release-age installs a version younger than the quarantine. For an urgent security fix ' +
          "that is the developer's call: score the exact version first (verify-package.js), then give the developer the command " +
          'to run themselves, e.g. ! npm install <pkg>@<version> --min-release-age=0',
      );
  }

  // A Socket waiver in allowed-packages.json approves a package that has no
  // score (policy 2.58). It is the developer's decision, like --ack-manual, so
  // the AI may not write one. Installs themselves are plain npm: the Socket
  // wrapper is no longer required (quota 429s, and its vendored resolver
  // pruned optional dependencies from lockfiles).
  {
    const ti2 = input.tool_input || {};
    const text = `${cmd} ${ti2.new_string || ''} ${ti2.content || ''} ${(ti2.edits || []).map((e) => e.new_string).join(' ')}`;
    const target = `${ti2.file_path || ''} ${cmd}`;
    if (/allowed-packages\.json/.test(target) && /["']?waived["']?\s*:/.test(text))
      refuse(
        "BUILD-POLICY: a Socket waiver in allowed-packages.json approves a package nobody scored. That is the developer's " +
          'decision: ask them to add "socket": { "waived": "<reason>" } to the entry by hand, or retry verify-package.js ' +
          'when Socket answers.',
      );
  }

  if (input.tool_name !== 'Bash') process.exit(0);
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
  // Homebrew installs must verify bottle attestations. Read from brew.env and
  // any HOMEBREW_* assignments on the command line itself.
  if (
    input.tool_name === 'Bash' &&
    /(?:^|[;&|(]|&&|\|\|)\s*(?:[A-Z_]+=\S*\s+)*brew\s+(?:install|upgrade|reinstall|bundle)\b/.test(
      cmd,
    )
  ) {
    const inline = Object.fromEntries(
      [...cmd.matchAll(/\b(HOMEBREW_[A-Z_]+)=(\S*)/g)].map((m) => [m[1], m[2] || '1']),
    );
    if (!brewAttestationsOn(brewSettings(inline)))
      refuse(
        `BUILD-POLICY: this brew command would install without verifying bottle attestations. Set it up once with ` +
          `policy setup-machine (writes ${brewEnvFiles().user}), or for this command only: HOMEBREW_VERIFY_ATTESTATIONS=1 ${cmd.trim()}. ` +
          `Never set HOMEBREW_NO_VERIFY_ATTESTATIONS (project-standards § Supply Chain Security).`,
      );
  }
  // `npm audit fix --force` proposes major version changes that bypass the
  // upgrade decision record. Unforced `npm audit fix` stays within declared
  // ranges and is permitted.
  if (input.tool_name === 'Bash' && /\bnpm\s+audit\s+fix\b/.test(cmd) && /--force\b/.test(cmd)) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            'BUILD-POLICY: `npm audit fix --force` proposes major version changes outside the declared semver range. ' +
            'Each major it would install must go through `policy upgrade <pkg>` with a decision record before the change lands. ' +
            'Run `npm audit` (no fix) to see which packages are affected, then handle each one through the upgrade flow ' +
            '(project-standards § Dependency Maintenance Lifecycle). ' +
            'Unforced `npm audit fix` is fine — it stays within declared ranges.',
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
  if (input.tool_name === 'Bash' && BUILD_INVOCATION.test(cmd)) {
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
    // verify-ready is a prerequisite for the artifact, not a report filed
    // afterwards. Its checks (gates marker, CHANGELOG, smoke coverage, security
    // review, major-upgrade records) all describe things that must hold before
    // a DMG exists, and nothing forced it to run — so a build could skip every
    // one. The tree is clean at this point, so the marker's content hash is the
    // tree's identity and a stale record cannot pass for the current one.
    const buildMarker = readJSON(path.join(dir, '.policy', 'gates.json'));
    const vr = loadState(dir).verifyReady;
    if (!buildMarker || !markerMatches(dir, buildMarker)) {
      deny(
        'BUILD-POLICY: no gates marker for this tree — a DMG must not be built from code the gates never passed. ' +
          `Run: node ${path.join(POLICY_ROOT, 'scripts', 'policy.js')} gates`,
      );
    }
    if (!vr || vr.contentHash !== buildMarker.contentHash) {
      deny(
        'BUILD-POLICY: verify-ready has not passed on this tree, and it is a prerequisite for the build, not a report filed afterwards. ' +
          (vr
            ? 'A pass is recorded, but for different content — it no longer applies. '
            : 'No pass is recorded. ') +
          `Run: node ${path.join(POLICY_ROOT, 'scripts', 'policy.js')} verify-ready --release`,
      );
    }
  }
  // Context protection: nudge search/survey Bash calls toward delegation.
  // Tool output persists in context and is resent every turn, so exploratory
  // commands (grep, find, git log) compound fast in long sessions. This is
  // advisory — additionalContext, not deny — because inline use is sometimes
  // correct. The nudge fires once per pattern match, not per call.
  if (input.tool_name === 'Bash') {
    const SEARCH_PATTERNS = [
      { re: /\b(?:grep|rg|ag|ack)\b.*(?:-r\b|--recursive\b|-R\b)/, label: 'recursive grep' },
      { re: /\bfind\s+\S+.*-(?:name|type|regex)\b/, label: 'find with filters' },
      { re: /\bgit\s+log\b(?!.*--oneline\s+-\d)/, label: 'git log (verbose)' },
      { re: /\bgit\s+diff\b(?!.*--stat\b)(?!.*--name)/, label: 'git diff (full)' },
    ];
    const matched = SEARCH_PATTERNS.find((p) => p.re.test(cmd));
    if (matched) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext:
              `BUILD-POLICY context protection: this ${matched.label} will add its full output to the session context and it will be resent on every subsequent turn. ` +
              'If this is exploratory/survey work, delegate it to a haiku agent or fork instead — their tool output stays out of the main context. ' +
              'Inline is fine when you need a specific, targeted result (a few lines) that you will act on immediately.',
          },
        }),
      );
      process.exit(0);
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

/**
 * `policy approve-exception <GHSA-id> [...]`: the developer's approval of an
 * advisory exception drafted in audit-exceptions.json. Shows each entry in
 * full, refuses an invalid one, and records the approval (bound to the entry's
 * content) in audit-approvals.json. Run by the developer, never the AI: the
 * PreToolUse hook refuses it, as it refuses --ack-manual.
 */
function cmdApproveException(ids) {
  const dir = process.cwd();
  section('Approve advisory exception');
  const exceptions = loadAuditExceptions(dir);
  const targets = ids.length
    ? ids
    : Object.keys(exceptions).filter((id) => !auditExceptionApproved(dir, id, exceptions[id]));
  if (targets.length === 0) {
    ok('Nothing to approve: every entry in audit-exceptions.json is already approved');
    return finish();
  }
  const approvals = loadAuditApprovals(dir);
  for (const id of targets) {
    const e = exceptions[id];
    if (!e) {
      fail(`${id} is not in ${path.join(dir, AUDIT_EXCEPTIONS)}`);
      continue;
    }
    console.log(`\n${BOLD}${id}${RESET}`);
    for (const k of ['package', 'via', 'reason', 'decided', 'expires'])
      console.log(`  ${k.padEnd(8)} ${e[k] || ''}`);
    const problems = auditExceptionProblems({ [id]: e });
    if (problems.length) {
      fail(`${id} cannot be approved: ${problems.join('; ')}`);
      continue;
    }
    approvals[id] = { hash: auditEntryHash(e), approvedAt: new Date().toISOString() };
    ok(`${id} approved (until ${e.expires}; changing the entry needs approval again)`);
  }
  fs.writeFileSync(path.join(dir, AUDIT_APPROVALS), JSON.stringify(approvals, null, 2) + '\n');
  console.log(`\nCommit ${AUDIT_EXCEPTIONS} and ${AUDIT_APPROVALS} together.`);
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
      return flags.includes('--all') ? cmdCheckAll() : cmdCheck(dir, flags);
    case 'sync-templates':
      return cmdSyncTemplates(dir);
    case 'gates':
      return cmdGates(dir, flags);
    case 'verify-marker':
      return cmdVerifyMarker(dir);
    case 'verify-ready':
      return cmdVerifyReady(dir, flags);
    case 'security-ack':
      return cmdSecurityAck(dir);
    case 'health':
      return cmdHealth(dir, flags);
    case 'deps-update':
      return cmdDepsUpdate(dir);
    case 'upgrade':
      return cmdUpgrade(dir, rest);
    case 'approve-exception':
      return cmdApproveException(rest.filter((a) => !a.startsWith('--')));
    case 'scaffold':
      return cmdScaffold(dir);
    case 'handoff':
      return cmdHandoff();
    case 'mirror-sync':
      return cmdMirrorSync();
    case 'mirror':
      return cmdMirror();
    case 'leak-scan':
      return cmdLeakScan(dir);
    case 'hook-stop':
      return cmdHookStop();
    case 'hook-pretool':
      return cmdHookPretool();
    case 'hook-posttool':
      return cmdHookPosttool();
    default:
      console.log(readFile(__filename).match(/\/\*\*[\s\S]*?\*\//)[0]);
      process.exit(command ? 1 : 0);
  }
}

if (require.main === module) main();

// For tests/ only: the pure predicates the hooks and gates decide on.
module.exports = {
  bashWriteTargets,
  writesUnder,
  literalPathsUnder,
  commandNamesRoot,
  splitStringLiterals,
  cmpSemver,
  historyRows,
  brewAttestationsOn,
  isSourceFile,
  isGatedFile,
  releaseProfile,
  shippedDmgVersions,
  THINKING_DISABLED_RE,
  NO_DISABLE_MODEL_RE,
  FIRST_BLOCK_TEXT_RE,
};
