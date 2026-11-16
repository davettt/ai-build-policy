// Sample from the guidebook (MIT licence). It shows how I refuse a release build on a dirty tree;
// read it and adapt it to your project rather than copying it as is.
// See guide 6.1 and 9.4. Claude Code PreToolUse hook on Bash: block = stderr reason + exit 2.
//
// It matches the command text, so treat it as a guard against slips, not a
// security boundary.
// Fail closed: input that cannot be read as JSON is blocked, because the command is unknown and
// could be a build. Git errors block too when the command looks like a build.
'use strict';
const { spawnSync } = require('node:child_process');

const BUILD = [/electron:build|electron-builder/]; // add your own release commands

function block(reason) { console.error(reason); process.exit(2); }

let command;
try {
  command = JSON.parse(require('node:fs').readFileSync(0, 'utf8')).tool_input.command;
  if (typeof command !== 'string') throw new Error('no command');
} catch {
  block('Blocked: could not read the hook input, so I cannot tell whether this is a release build.');
}

if (!BUILD.some((re) => re.test(command))) process.exit(0);

const r = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
if (r.status !== 0) block('Blocked: git status failed, so I cannot confirm the tree is clean.');
if (r.stdout.trim() !== '') block('Blocked: release build on a dirty tree. Commit first, then build.');
process.exit(0);
