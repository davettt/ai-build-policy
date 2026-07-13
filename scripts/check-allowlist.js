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

const allDeps = [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
];

const allowedNames = new Set(Object.keys(allowlist));
const unapproved = allDeps.filter((dep) => !allowedNames.has(dep));

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
