#!/usr/bin/env node
'use strict';

// Sample from the guidebook (MIT licence). It shows how I scan a repo for personal details,
// local paths and credential shapes before they reach a commit; read it and adapt it to your
// project rather than copying it as is. See guide 5.1.

// Fails when a file in this repo holds something a public repo must never
// carry: an email address, a home-directory path, a credential shape, or a
// file that is a secret by name. Run it in the pre-commit hook and in CI over
// every tracked and untracked (not ignored) file.
//
// The patterns are assembled from pieces so this file does not match itself,
// which means no file is exempt from the scan.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const j = (...parts) => parts.join('');

const BANNED = [
  // Personal details
  { name: 'email address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/ },
  // Local paths
  { name: 'home-directory path', re: new RegExp(j('/', 'Users/[^/\\s]+|/', 'home/[^/\\s]+|~/[A-Z]|[A-Z]:\\\\', 'Users\\\\'), 'i') },
  // Credential shapes
  { name: 'Anthropic key', re: new RegExp(j('sk-', 'ant-[A-Za-z0-9_-]{10,}')) },
  { name: 'OpenAI-style key', re: new RegExp(j('\\bsk-', '(proj-)?[A-Za-z0-9_-]{20,}')) },
  { name: 'AWS access key', re: new RegExp(j('AKI', 'A[0-9A-Z]{16}')) },
  { name: 'GitHub token', re: new RegExp(j('\\bgh', '[pousr]_[A-Za-z0-9]{30,}|github', '_pat_')) },
  { name: 'npm token', re: new RegExp(j('\\bnpm', '_[A-Za-z0-9]{36}')) },
  { name: 'Slack token', re: new RegExp(j('xox', '[abpr]-[A-Za-z0-9-]{10,}')) },
  { name: 'Google API key', re: new RegExp(j('AI', 'za[0-9A-Za-z_-]{35}')) },
  { name: 'private key block', re: new RegExp(j('-----BEGIN [A-Z ]*PRIV', 'ATE KEY-----')) },
];

// File names that are secrets whatever they contain.
const BANNED_FILES = [
  { name: 'env file', re: /(^|\/)\.env(\.|$)/ },
  { name: 'key or certificate file', re: /\.(pem|key|p12|pfx|p8|keychain)$/i },
];

/** Findings for one file: [{ file, line, name }] (pure). */
function scanText(file, text) {
  const out = [];
  for (const b of BANNED_FILES) if (b.re.test(file)) out.push({ file, line: 0, name: b.name });
  const lines = String(text).split('\n');
  lines.forEach((l, i) => {
    for (const b of BANNED) if (b.re.test(l)) out.push({ file, line: i + 1, name: b.name });
  });
  return out;
}

/** Tracked plus untracked-but-not-ignored files; the whole tree outside git. */
function repoFiles(root) {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  if (r.status === 0) return r.stdout.split('\0').filter(Boolean);
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      if (['.git', 'node_modules'].includes(e.name)) continue;
      const rel = d ? `${d}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk('');
  return out;
}

function main(root = path.resolve(process.argv[2] || '.')) {
  const findings = [];
  for (const f of repoFiles(root)) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(root, f), 'utf8');
    } catch {
      continue; // deleted in the working tree
    }
    findings.push(...scanText(f, text));
  }
  if (findings.length) {
    console.error(`Banned content (${findings.length}):`);
    // The line number and rule only: printing the match would copy a secret
    // into the terminal and the CI log.
    for (const x of findings) console.error(`  ${x.file}${x.line ? `:${x.line}` : ''}  ${x.name}`);
    console.error('Remove it before committing. A real secret that reached a commit is compromised: rotate it.');
    process.exit(1);
  }
  console.log('No banned content.');
}

module.exports = { scanText, BANNED, BANNED_FILES };
if (require.main === module) main();
