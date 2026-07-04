# Build Policy

A complete build and development workflow for shipping software with AI coding assistants.

This is the actual process used to build and maintain [Tiong Creative](https://tiongcreative.com.au) apps — desktop apps (Electron/macOS), local-first tools (Node.js/PM2), and cloud SaaS (Cloudflare). It's published here so users and teams can see exactly how we build, and so other teams can adapt it.

## What's in here

| File | What it covers |
|---|---|
| [BUILD-POLICY.md](BUILD-POLICY.md) | The full workflow — 43 steps across 8 phases, from context loading to maintenance |
| [project-standards.md](project-standards.md) | Stack preferences, code quality rules, security standards, file structures |

## Who this is for

- **App buyers** — see exactly what quality gates, security scans, and testing your app goes through before release
- **Teams** — adopt or adapt the workflow for your own projects; identify gaps in your current process
- **Solo developers** — a structured approach to building with AI assistants without cutting corners
- **AI-assisted teams** — patterns for working with Claude Code, Codex, and other AI coding tools effectively

## Key ideas

**AI tools follow the same process as humans.** The workflow doesn't distinguish between "AI writes code" and "human writes code" — the quality gates, review steps, and security checks apply equally. The AI is a team member, not a shortcut.

**Tooling over checklists.** Validation is baked into the workflow via CLI tools (ESLint, html-validate, Stylelint, Semgrep, Socket CLI) rather than manual review checklists. Humans forget checklists; `npm run quality` doesn't.

**Test isolation is non-negotiable.** Integration tests run against isolated server instances with temporary data directories. Production data is never at risk during testing. This was learned the hard way.

**Cross-project learning.** When a gap or improvement is found in one project, the shared standards are updated so all projects benefit. One project's fix is every project's fix.

**The developer is the gate.** AI prepares changes, runs quality gates, and presents the diff. The human reviews and commits. Every change has a human decision point.

## Using this for your team

Fork this repo and adapt:

1. Replace tool-specific references (Claude Code, Codex) with your team's tools
2. Adjust the stack preferences to match your projects
3. Add or remove quality gate steps as needed
4. Update the security standards for your threat model

The workflow structure (8 phases, numbered steps) is designed to be referenced in code reviews and process discussions — "did we run step 14?" is clearer than "did we validate?"

## Version

This is a living document, updated as our process evolves. See the version history at the bottom of each file.

## License

MIT — use it however you like.

## About

Built and maintained by [David Tiong](https://tiongcreative.com.au) using Claude Code and other AI development tools.
