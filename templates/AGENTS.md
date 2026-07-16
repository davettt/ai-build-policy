# Agent Instructions (all AI coding agents)

This project is governed by a shared build policy. The machinery is agent-agnostic —
run it from this project's root. Claude Code gets this via hooks; **if you are any
other agent (Codex, Gemini, etc.), follow this file.**

## The single entrypoint

```bash
node ../build-policy/scripts/policy.js <command>
```

| Command        | When                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `check`        | Session start. Fix any FAIL items before feature work.                                                                                                                               |
| `scaffold`     | Create missing standard files/scripts (never overwrites).                                                                                                                            |
| `gates`        | **Before presenting any work as ready.** Runs the full quality-gate sequence and writes the marker that pre-commit requires — a commit with source changes is impossible without it. |
| `verify-ready` | Before declaring changes ready; `--release` before shipping.                                                                                                                         |
| `health`       | Maintenance run when flagged overdue.                                                                                                                                                |

## Non-negotiable rules

1. **The developer commits, never the agent.** Present work; do not run `git commit`/`git push`.
2. **`gates` before saying "ready to commit".** `gates --fast` (pre-commit subset) does NOT count — it writes no marker.
3. **CHANGELOG.md entry for every code change** before ending your turn.
4. **Fix shared problems in `../build-policy/`** (templates, standards), not per-project — every project self-reports drift from the shared templates.
5. **Never suppress a failing security check to get green** (e.g. semgrep rule exclusions, `nosemgrep`). Triage findings with the developer; agreed exclusions belong in the shared template with written justification.
6. **Security-sensitive code follows the written standards** — do not redesign crypto, key storage, auth, or signing config, even to something "better", without the developer agreeing to a standards change first. Source of truth: `../build-policy/project-standards.md`.
7. Secrets live in `.env` (gitignored); user data in `local_data/` (gitignored); never commit either.

## Read before substantial work

- `CLAUDE.md` in this project root (project specifics — applies to all agents despite the name)
- `../build-policy/BUILD-POLICY.md` (the workflow, phase by phase)
- `../build-policy/project-standards.md` (stack, security, and template reference)
