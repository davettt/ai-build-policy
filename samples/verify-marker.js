// Sample from the guidebook (MIT licence). It shows how I do the commit-time marker check;
// read it and adapt it to your project rather than copying it as is.
// See guide 3.2 and 9.3. Called from the pre-commit hook.
//
// Hashes the STAGED source (blobs from the index, so unstaged edits do not count) and compares
// it with .gates/marker.json written by gates.js.
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { SOURCES, hashFiles } = require('./gates.js');

const git = (args, enc = 'utf8') => execFileSync('git', args, { encoding: enc, maxBuffer: 1 << 28 });

const changed = git(['diff', '--cached', '--name-only', '--', ...SOURCES]).split('\n').filter(Boolean);
if (changed.length === 0) process.exit(0); // no source staged, nothing to prove

// "<mode> <blob> <stage>\t<path>" for every file in the index under the source set.
const staged = git(['ls-files', '-s', '--', ...SOURCES]).split('\n').filter(Boolean)
  .map((l) => l.split('\t')[1]);
const hash = hashFiles(staged.map((p) => [p, git(['show', ':' + p], null)]));

let marker = null;
try { marker = JSON.parse(fs.readFileSync('.gates/marker.json', 'utf8')); } catch { /* missing */ }
if (!marker || marker.hash !== hash) {
  console.error('Source changed since the gates last passed: run node scripts/gates.js');
  console.error('(then stage everything you gated with git add, and commit)');
  process.exit(1);
}
