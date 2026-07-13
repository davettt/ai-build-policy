#!/bin/bash
# Session start hook — RUNS the build policy compliance check and injects the
# computed results into the session context. The model responds to facts;
# it is never asked to remember the policy. (BUILD-POLICY v2.0 enforcement.)
#
# Uses $HOME so the same script works on every machine regardless of username.

POLICY="$HOME/path/to/build-policy/scripts/policy.js"

# Outside this workspace or policy missing: stay silent.
[ -f "$POLICY" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

RESULT=$(node "$POLICY" check --hook 2>&1)

CONTEXT="BUILD POLICY — session start. Compliance check already executed by policy.js (computed results, do not re-derive):

${RESULT}

Policy commands (POLICY = ${POLICY}):
- node \$POLICY check          — re-check compliance after fixing gaps
- node \$POLICY scaffold       — create missing standard files/scripts (never overwrites)
- node \$POLICY gates          — full quality gates; REQUIRED before presenting work for review (also: /gates)
- node \$POLICY verify-ready   — REQUIRED before declaring changes ready; --release for releases
- node \$POLICY health         — maintenance run, when flagged overdue

Rules that remain judgment (not computed): fix FAIL items before feature work; major work needs a written plan approved by the developer first; new projects need a CLAUDE.md and a spec in .claude/specs/ before building; the developer commits, never the AI. Full workflow: build-policy/BUILD-POLICY.md (read when planning, not as session ritual)."

printf '%s' "$CONTEXT" | node -e 'const c=require("fs").readFileSync(0,"utf8");process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:c}}))'
