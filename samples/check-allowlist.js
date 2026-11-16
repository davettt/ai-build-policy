#!/usr/bin/env node

// Sample from the guidebook (MIT licence). It shows how I check dependencies
// against an allowlist; read it and adapt it to your project rather than copying it as is.
// See guide 4.1.

/**
 * Validate that all dependencies in package.json are on the allowlist.
 * Exits non-zero if any unapproved package is found, if an entry is past its
 * re-verification date, or if an entry has no Socket score.
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

// Every entry carries a Socket score taken when the package was verified
// (verify-package.js). Where Socket cannot score a package, I record a
// reason by hand in place of the score.
const unscored = allDeps.filter((dep) => {
  const e = allowlist[dep];
  if (!e) return false;
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

// Re-verification cadence: an entry is re-verified every 180 days, or every
// `reviewEveryDays` the entry sets (I use 90 for parsers, converters,
// serializers, crypto and auth). Legitimate and safe to install are not the
// same as still maintained, and only a fresh look at the package answers the
// second.
const REVIEW_DAYS = 180;
const overdue = allDeps.filter((dep) => {
  const e = allowlist[dep];
  if (!e) return false;
  if (!e.verified) return true; // no date: treat as overdue
  const days = Number(e.reviewEveryDays) || REVIEW_DAYS;
  const t = Date.parse(e.verified);
  if (!Number.isFinite(t) || t > Date.now()) return true; // bad or future date: re-verify
  return (Date.now() - t) / 86400000 > days;
});
if (overdue.length > 0) {
  console.error(
    `${RED}${BOLD}${overdue.length} allowlist entr${overdue.length === 1 ? 'y is' : 'ies are'} past the re-verification window:${RESET}\n`,
  );
  for (const dep of overdue) {
    const e = allowlist[dep];
    console.error(
      `  ${RED}✗${RESET} ${dep} (verified ${e.verified || 'never'}, window ${Number(e.reviewEveryDays) || REVIEW_DAYS} days)`,
    );
  }
  console.error(
    `\nRe-verify each: node verify-package.js <package>, then replace the entry (new verified date, ` +
      `maintenance status, Socket score). A package no longer maintained needs a replacement instead.\n`,
  );
  process.exit(1);
}
if (undecided.length > 0) {
  console.error(
    `${RED}${BOLD}${undecided.length} package(s) with a Socket flag and no recorded decision:${RESET}\n`,
  );
  for (const dep of undecided) console.error(`  ${RED}✗${RESET} ${dep}`);
  console.error(
    `\nRecord why each was accepted: "socket": { ..., "decision": { "verdict": "accepted", "reason": "<why>", "date": "YYYY-MM-DD" } }, ` +
      `or remove the package.\n`,
  );
  process.exit(1);
}
if (unscored.length > 0) {
  console.error(
    `${RED}${BOLD}${unscored.length} package(s) approved without a Socket score:${RESET}\n`,
  );
  for (const dep of unscored) console.error(`  ${RED}✗${RESET} ${dep}`);
  console.error(
    `\nRe-run node verify-package.js <package> once Socket answers, and copy its "socket" field into ` +
      `allowed-packages.json.\n`,
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
  console.error(`\nTo approve a package, first verify it:\n  node verify-package.js <package-name>\n`);
  console.error('Then add the entry it prints (with its Socket score) to allowed-packages.json.\n');
  process.exit(1);
}
