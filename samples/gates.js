// Sample from the guidebook (MIT licence). It shows how I do one gates command with a marker;
// read it and adapt it to your project rather than copying it as is.
// See guide 3.2 and 9.3.
//
// Runs npm scripts in order, stops at the first failure, then writes .gates/marker.json with a
// hash of the source files. verify-marker.js recomputes the hash from the STAGED files at commit.
// The rule: the marker matches when the staged source equals the working-tree source that was
// gated, so stage everything you gated (git add) before committing.
// The marker shows the checks ran on this source. It is a plain file, so it is a
// guard against slips, not proof against someone who can write to the repo.
// Guide 1.3: make each check fail on empty input (a test script that finds 0 tests should
// exit non-zero), because a gate that passes on nothing proves nothing.
'use strict';
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');

const GATES = ['typecheck', 'lint', 'format:check', 'test', 'build'];
// A gate in REQUIRED fails when the script is missing, instead of being skipped (guide 1.3).
const REQUIRED = new Set(['lint', 'test']);
const SOURCES = ['src/', 'server/', 'electron/', 'package.json', 'package-lock.json'];

// entries: [[path, Buffer], ...]. Sorted by path; hashes path and contents.
function hashFiles(entries) {
  const h = crypto.createHash('sha256');
  for (const [p, buf] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    h.update(p).update('\0').update(buf).update('\0');
  }
  return h.digest('hex');
}

// Tracked + untracked-not-ignored files, read from the working tree.
function workingTreeHash() {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', ...SOURCES], {
    encoding: 'utf8', maxBuffer: 1 << 28,
  });
  const files = [...new Set(out.split('\n').filter(Boolean))].filter((f) => fs.existsSync(f));
  return hashFiles(files.map((f) => [f, fs.readFileSync(f)]));
}

function run() {
  const scripts = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts || {};
  let skipped = 0;
  for (const name of GATES) {
    if (!scripts[name]) {
      if (REQUIRED.has(name)) { console.error(`FAILED ${name}: required, but package.json has no such script`); process.exit(1); }
      console.log(`SKIPPED ${name} (no such script)`); skipped++; continue;
    }
    console.log(`==> npm run ${name}`);
    const r = spawnSync('npm', ['run', '--silent', name], { stdio: 'inherit' });
    if (r.status !== 0) { console.error(`FAILED ${name}`); process.exit(1); }
  }
  fs.mkdirSync('.gates', { recursive: true });
  const hash = workingTreeHash();
  fs.writeFileSync('.gates/marker.json', JSON.stringify({ hash, at: new Date().toISOString() }, null, 2) + '\n');
  console.log(`Gates passed (${skipped} skipped). Marker written: ${hash.slice(0, 12)}`);
}

module.exports = { SOURCES, hashFiles, workingTreeHash };
if (require.main === module) run();
