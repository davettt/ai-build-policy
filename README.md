# Build Policy

A complete build and development workflow for shipping software with AI coding assistants — **enforced by machinery, not memory**.

This is the actual process used to build and maintain [Tiong Creative](https://tiongcreative.com.au) apps — desktop apps (Electron/macOS), local-first tools (Node.js/PM2), and cloud SaaS (Cloudflare). It's published here so users and teams can see exactly how we build, and so other teams can adapt it.

## What's in here

| File | What it covers |
|---|---|
| [BUILD-POLICY.md](BUILD-POLICY.md) | The workflow — 8 phases, every step annotated with **what mechanically enforces it** |
| [project-standards.md](project-standards.md) | Stack preferences, code quality rules, security standards, data safety, file structures |
| [scripts/policy.js](scripts/policy.js) | The enforcement engine — compliance checks, quality gates, release verification, hooks |
| [scripts/](scripts) | Dependency allowlist tooling (verify, check, bootstrap) |
| [templates/](templates) | Canonical gitignore, CI workflow, Dependabot config, pre-commit hook, lint configs |
| [machine/](machine) | Per-machine wiring: session-start script, Claude Code hooks, pinned-model agent definitions — installed by `policy.js setup-machine` |
| [registry.json](registry.json) | Verified-dates registry — tooling decisions that expire and get re-checked on schedule |

## The core idea

**LLMs follow instructions probabilistically; programs execute the same way every time.** A policy document alone cannot make an AI assistant follow a process consistently — no amount of prose, context files, or reminders will. So every step here is either enforced by a program or evidenced by an artifact a program checks:

- A **session-start hook** runs the compliance check and injects computed results — the AI responds to facts, it doesn't re-derive them
- A **pre-commit hook** runs the fast quality gates — a non-compliant commit is impossible, not discouraged
- A **stop hook** blocks the AI from ending its turn with code changes but no changelog entry
- A **pre-tool hook** denies release builds on a dirty tree — the build order is physically enforced
- **`verify-ready`** proves the gates passed against the *current* diff, not an earlier one
- **CI re-runs the gates on every push** — a timestamped, independent record of how every release was built
- **Staleness tracking** turns "review this periodically" into a fact injected at session start

The AI's cooperation becomes helpful, not load-bearing. The judgment steps that remain human (plan approval, code review, the commit itself) are human *by design*.

## Who this is for

- **App buyers** — see exactly what quality gates, security scans, and testing your app goes through before release
- **Teams** — adopt or adapt the workflow; the enforcement pattern transfers even if the tools differ
- **Solo developers** — a structured approach to building with AI assistants without cutting corners
- **AI-assisted teams** — working patterns for Claude Code, Codex, and other AI coding tools

## Other key ideas

**AI tools follow the same process as humans.** Quality gates, review steps, and security checks apply equally. The AI is a team member, not a shortcut.

**The developer is the gate.** AI prepares changes, runs gates, presents the diff. The human reviews and commits. Every change has a human decision point.

**The improvement loop.** When anything escapes — a bug reaches a user, a regression, the developer catches themselves re-prompting — the retro question is *"which check should have caught this?"* and the answer becomes a new check. This repo's history is the record of the control system learning.

**Test isolation is non-negotiable.** Integration tests run against isolated server instances with temporary data directories. Production data is never at risk during testing.

**User data outlives app versions.** Schema versioning, migration-on-load, automatic pre-migration backups, and a downgrade guard are mandatory for shipped apps. Data loss on upgrade is the worst possible outcome for a paid app.

## Using this for your team

Fork and adapt:

1. Put this repo as a sibling of your projects (scripts assume `../build-policy/`)
2. Run `node scripts/policy.js setup-machine` to install the Claude Code wiring (edit the paths in `machine/` first), then `doctor` to verify, `scaffold` in a project to set it up, `check` to see gaps
3. For other AI tools, the hook modes speak plain JSON on stdin/stdout — wire them however your tool supports
4. Replace registry values and stack preferences with your own; adjust the security standards for your threat model

## Version

A living system, updated as the process evolves. See the version history in each file.

## License

MIT — use it however you like.

## About

Built and maintained by [David Tiong](https://tiongcreative.com.au) using Claude Code and other AI development tools.
