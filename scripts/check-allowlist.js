#!/usr/bin/env node

/**
 * Validate that all dependencies in package.json are on the allowlist.
 * Exits non-zero if any unapproved package is found.
 *
 * Usage: node check-allowlist.js [path-to-project]
 *        Defaults to current directory.
 */

const fs = require('fs');
const path = require('path');

const projectDir = process.argv[2] || '.';
const pkgPath = path.join(projectDir, 'package.json');
const allowlistPath = path.join(projectDir, 'allowed-packages.json');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

if (!fs.existsSync(pkgPath)) {
  console.error(`${RED}No package.json found at ${pkgPath}${RESET}`);
  process.exit(1);
}

if (!fs.existsSync(allowlistPath)) {
  console.error(`${RED}No allowed-packages.json found at ${allowlistPath}${RESET}`);
  console.error('Run the bootstrap script to create one from your current dependencies.');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));

const allDeps = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})];

const allowedNames = new Set(Object.keys(allowlist));
const unapproved = allDeps.filter((dep) => !allowedNames.has(dep));

// Entries approved from policy 2.58 on carry a Socket score taken when the
// package was verified (verify-package.js), or a waiver the developer wrote.
// Earlier entries were approved under the install-time wrapper and keep that.
const SCORE_REQUIRED_FROM = '2026-10-03';
const unscored = allDeps.filter((dep) => {
  const e = allowlist[dep];
  if (!e || !e.verified || e.verified < SCORE_REQUIRED_FROM) return false;
  const sc = e.socket || {};
  return !(sc.status === 'scored' && sc.checked) && !sc.waived;
});
// A score that raised a flag needs the decision recorded with it, so the next
// session reads why the package was accepted instead of re-arguing it.
const undecided = allDeps.filter((dep) => {
  const sc = (allowlist[dep] && allowlist[dep].socket) || {};
  if (!sc.flagged) return false;
  const d = sc.decision || {};
  return !(d.verdict === 'accepted' && d.reason && String(d.reason).trim() && d.date);
});
if (undecided.length > 0) {
  console.error(`${RED}${BOLD}${undecided.length} package(s) with a Socket flag and no recorded decision:${RESET}\n`);
  for (const dep of undecided) console.error(`  ${RED}✗${RESET} ${dep}`);
  console.error(
    `\nRecord why each was accepted: "socket": { ..., "decision": { "verdict": "accepted", "reason": "<why>", "date": "YYYY-MM-DD" } }, ` +
      `or remove the package.\n`,
  );
  process.exit(1);
}
if (unscored.length > 0) {
  console.error(`${RED}${BOLD}${unscored.length} package(s) approved without a Socket score:${RESET}\n`);
  for (const dep of unscored) console.error(`  ${RED}✗${RESET} ${dep}`);
  console.error(
    `\nRe-run node build-policy/scripts/verify-package.js <package> once Socket answers, and copy its "socket" field into ` +
      `allowed-packages.json. If Socket cannot score it, the developer may record "socket": { "waived": "<reason>" } by hand.\n`,
  );
  process.exit(1);
}

if (unapproved.length === 0) {
  console.log(`${GREEN}${BOLD}All ${allDeps.length} dependencies are on the allowlist.${RESET}`);
  process.exit(0);
} else {
  console.error(`${RED}${BOLD}${unapproved.length} unapproved package(s) found:${RESET}\n`);
  for (const dep of unapproved) {
    console.error(`  ${RED}✗${RESET} ${dep}`);
  }
  console.error(
    `\nTo approve a package, first verify it:\n  node build-policy/scripts/verify-package.js <package-name>\n`,
  );
  console.error('Then add it to allowed-packages.json after security agent review.\n');
  process.exit(1);
}
