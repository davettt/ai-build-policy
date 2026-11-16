// Sample from the guidebook (MIT licence). It shows how I do the changelog check at the end of a turn;
// read it and adapt it to your project rather than copying it as is.
// See guide 1.1 and 9.4. Claude Code Stop hook: reads hook JSON on stdin.
'use strict';
const { execFileSync } = require('node:child_process');

const SOURCE = /^(src|server|electron)\/|^package(-lock)?\.json$/;
const CHANGELOG = 'CHANGELOG.md';

let input = {};
try { input = JSON.parse(require('node:fs').readFileSync(0, 'utf8')); } catch { /* no input */ }
if (input.stop_hook_active) process.exit(0); // already blocked once this turn: avoid a loop

let out;
try {
  out = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch {
  process.exit(0); // not a git repo
}

// Porcelain lines are "XY path" (renames: "XY old -> new"); take the final path.
const files = out.split('\n').filter(Boolean).map((l) => l.slice(3).split(' -> ').pop().replace(/^"|"$/g, ''));
const source = files.filter((f) => SOURCE.test(f) && !f.endsWith('.md'));
if (source.length > 0 && !files.includes(CHANGELOG)) {
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: 'Source files changed but CHANGELOG.md has no entry. Add one before finishing.',
  }));
}
process.exit(0);
